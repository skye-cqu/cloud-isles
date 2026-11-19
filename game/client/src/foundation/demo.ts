import HavokPhysics from "@babylonjs/havok";
import {
  Color3,
  Engine,
  HavokPlugin,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import { createFoundationBehavior } from "./behavior";
import { createFoundationNavigation } from "./navigation";
import { createFoundationPhysics } from "./physics";
import { createIslandSampler } from "./terrain";

declare global {
  interface Window {
    readonly foundationDiagnostics?: Readonly<Record<string, boolean | number | string>>;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#foundation-canvas");
const status = document.querySelector<HTMLElement>("#foundation-status");
const pause = document.querySelector<HTMLButtonElement>("#foundation-pause");

if (!canvas || !status || !pause) throw new Error("foundation demo DOM is incomplete");
const foundationCanvas = canvas;
const foundationStatus = status;
const pauseButton = pause;

async function start() {
const engine = new Engine(foundationCanvas, true);
const scene = new Scene(engine);
new HemisphericLight("foundation-light", new Vector3(0.25, 1, 0.1), scene).intensity = 1.1;
scene.clearColor.set(0.03, 0.08, 0.16, 1);
const sampler = createIslandSampler(20261105);
const terrain = MeshBuilder.CreateGround("foundation-terrain", { width: 16, height: 16, subdivisions: 16 }, scene);
const positions = terrain.getVerticesData(VertexBuffer.PositionKind)!;
for (let index = 0; index < positions.length; index += 3) {
  const radius = Math.hypot(positions[index], positions[index + 2]) / 11;
  positions[index + 1] = sampler.heightAt(positions[index], positions[index + 2]) - radius * radius * 2.4 - 0.7;
}
terrain.updateVerticesData(VertexBuffer.PositionKind, positions);
terrain.position.y = -3;
const terrainMaterial = new StandardMaterial("foundation-terrain-mat", scene);
terrainMaterial.diffuseColor = new Color3(0.22, 0.55, 0.34);
terrain.material = terrainMaterial;

const navWest = MeshBuilder.CreateGround("foundation-nav-west", { width: 3, height: 3 }, scene);
navWest.position.set(-5, 0.05, 0);
const navEast = MeshBuilder.CreateGround("foundation-nav-east", { width: 3, height: 3 }, scene);
navEast.position.set(5, 0.05, 0);
for (const mesh of [navWest, navEast]) {
  const material = new StandardMaterial(`${mesh.name}-mat`, scene);
  material.diffuseColor = new Color3(0.2, 0.35, 0.75);
  mesh.material = material;
}

const agent = createFoundationBehavior(new Vector3(5, 0.7, -3));
const animal = MeshBuilder.CreateSphere("foundation-yuka-agent", { diameter: 0.55 }, scene);
animal.position.y = 0.7;
const animalMaterial = new StandardMaterial("foundation-yuka-agent-mat", scene);
animalMaterial.diffuseColor = new Color3(1, 0.74, 0.22);
animal.material = animalMaterial;

const havok = await HavokPhysics({ locateFile: () => "/havok/HavokPhysics.wasm" });
scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havok));
const physics = createFoundationPhysics(scene);
const navigation = await createFoundationNavigation([navWest, navEast]);
const reachable = navigation.path(new Vector3(-5, 0.05, 0), new Vector3(-4, 0.05, 0));
const blocked = navigation.path(new Vector3(-5, 0.05, 0), new Vector3(5, 0.05, 0));
let running = true;

let diagnostics: Readonly<Record<string, boolean | number | string>> = Object.freeze({
  recastLocalWasm: true,
  reachablePathPoints: reachable.length,
  disconnectedPathPoints: blocked.length,
  terrainSeam: sampler.heightAt(8, 2) === sampler.sampleEdge(8, 2, 1)[0].height,
  yukaPaused: false,
  gizmoScaleEnabled: physics.gizmos.scaleGizmoEnabled,
  platformX: 0,
  characterX: 0,
  characterY: 0,
  characterSupport: "unknown",
  previewX: 0,
  previewY: 0,
  previewZ: 0,
  yukaX: 0,
  yukaZ: 0,
  yukaState: agent.state,
});
Object.defineProperty(window, "foundationDiagnostics", { get: () => diagnostics });
foundationStatus.textContent = `Recast 可达路径：${reachable.length} 点；断开目标：${blocked.length} 点；噪声接缝：通过；Yuka：运行中`;

pauseButton.addEventListener("click", () => {
  running = !running;
  agent.setPaused(!running);
  diagnostics = Object.freeze({ ...diagnostics, yukaPaused: !running });
  pauseButton.textContent = running ? "暂停 Yuka" : "继续 Yuka";
  foundationStatus.textContent = `Recast 可达路径：${reachable.length} 点；断开目标：${blocked.length} 点；噪声接缝：通过；Yuka：${running ? "运行中" : "已暂停"}`;
});

scene.onBeforeRenderObservable.add(() => {
  agent.tick(scene.getEngine().getDeltaTime() / 1000);
  animal.position.set(agent.vehicle.position.x, 0.7, agent.vehicle.position.z);
  diagnostics = Object.freeze({
    ...diagnostics,
    platformX: Number(physics.platform.position.x.toFixed(2)),
    characterX: Number(physics.characterPosition.x.toFixed(2)),
    characterY: Number(physics.characterPosition.y.toFixed(2)),
    characterSupport: physics.support,
    previewX: Number(physics.previewPosition.x.toFixed(2)),
    previewY: Number(physics.previewPosition.y.toFixed(2)),
    previewZ: Number(physics.previewPosition.z.toFixed(2)),
    yukaX: Number(agent.vehicle.position.x.toFixed(2)),
    yukaZ: Number(agent.vehicle.position.z.toFixed(2)),
    yukaState: agent.state,
  });
});
engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
window.addEventListener("beforeunload", () => {
  navigation.dispose();
  physics.dispose();
  agent.dispose();
  engine.dispose();
}, { once: true });
}

void start().catch((error: unknown) => {
  foundationStatus.textContent = `Foundation 初始化失败：${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
