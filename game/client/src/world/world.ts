// 世界装配：岛群布局、停泊点、上升气流、拾取物、地标、云间遗迹探索点。
// 植被/建筑/道具用 Quaternius CC0 GLB；纹理用 Poly Haven CC0（docs/licenses/cc0-assets-20261101.txt）。
import {
  Scene, Vector3, Color3, Mesh, MeshBuilder, StandardMaterial, TransformNode,
  PhysicsAggregate, PhysicsShapeType, PhysicsMotionType, DynamicTexture, PointLight,
} from "@babylonjs/core";
import { createIsland, decorateIsland, createLandingPad, Island, IslandDef } from "./island";
import { createLsicHome } from "./lsicHome";
import { CloudShip, DockTarget } from "./ship";
import { ItemId } from "shared";
import { makeRng } from "../core/rng";
import { loadEnvModel, placeClone, scatterThin, texMaterial, planarUVs, baseOffset, getLoadedEnvModel } from "../assets/envModels";

export const SEA_LEVEL = -160;

export interface PickupDef {
  uid: string;
  item: ItemId;
  count: number;
  pos: Vector3;
  mesh: Mesh;
  taken: boolean;
  respawnSec?: number;
}

export interface ChestDef {
  uid: string;
  pos: Vector3;
  opened: boolean;
  label: string;
  grants: { item: ItemId; count: number }[];
  node: TransformNode;
}

export interface Landmark {
  id: string;
  name: string;
  pos: Vector3;
  height: number;
}

export interface World {
  islands: Island[];
  ship: CloudShip;
  docks: DockTarget[];
  pickups: PickupDef[];
  chests: ChestDef[];
  updrafts: { center: Vector3; radius: number; height: number; power: number }[];
  landmarks: Landmark[];
  /** 岛屿 ID -> 简介（发现记录） */
  visited: Set<string>;
  update(dt: number): void;
}

export async function buildWorld(scene: Scene, shadowAdd: (m: Mesh) => void): Promise<World> {
  const defs: IslandDef[] = [
    { id: "canyonW", name: "风峡岛·西峰", center: [-560, -180], radius: 34, height: 15, depth: 42, seed: 771, kind: "canyon", intro: "两座尖峰之间有强劲的上升气流，风晶在风眼里凝结。" },
    { id: "canyonE", name: "风峡岛·东峰", center: [-514, -158], radius: 28, height: 17, depth: 46, seed: 772, kind: "canyon", intro: "东峰更高，峰顶能望见云海尽头。" },
    { id: "ruins", name: "云间遗迹", center: [520, 260], radius: 50, height: 9, depth: 40, seed: 993, kind: "ruins", intro: "石拱与浮石之间埋着旧时代的稳定装置。" },
    { id: "islet1", name: "苔背小屿", center: [-190, 210], radius: 14, height: 4, depth: 14, seed: 551, kind: "islet", intro: "苔藓覆盖的小岛，云菇喜欢这里。" },
    { id: "islet2", name: "雾环小屿", center: [210, -260], radius: 12, height: 3.5, depth: 12, seed: 552, kind: "islet", intro: "被雾气环绕的小岛。" },
  ];

  const home = await createLsicHome(scene, shadowAdd);
  const islands = [home, ...defs.map((d) => createIsland(scene, d))];
  const canyonW = islands[1], canyonE = islands[2], ruins = islands[3];

  // GLB 植被装饰（异步，各岛独立薄实例）
  await Promise.all(islands.filter((isle) => isle.def.id !== "home").map((isle) =>
    decorateIsland(scene, isle, {
      density: isle.def.kind === "home" ? 0.62 : isle.def.kind === "islet" ? 0.55 : 1.0,
      clearCenter: isle.def.kind === "home" ? isle.def.radius * 0.52 : isle.def.kind === "ruins" ? isle.def.radius * 0.4 : isle.def.radius * 0.32,
    })
  ));

  // ---- 停泊点 ----
  const docks: DockTarget[] = [];
  docks.push({ islandId: "home", name: "家园泊位", pos: home.dock.pos, rotY: home.dock.rotY });
  const padCanyon = createLandingPad(scene, canyonW, [0, 0, 12], 0.8, new Color3(0.4, 0.6, 0.8));
  docks.push({ islandId: "canyonW", name: "风峡泊位", pos: padCanyon.worldPos().add(new Vector3(0, 1.35, 0)), rotY: 0.8 });
  const padRuins = createLandingPad(scene, ruins, [-16, 0, 14], 2.3, new Color3(0.6, 0.5, 0.75));
  docks.push({ islandId: "ruins", name: "遗迹泊位", pos: padRuins.worldPos().add(new Vector3(0, 1.35, 0)), rotY: 2.3 });

  // ---- 云舟 ----
  const ship = new CloudShip(scene, { pos: docks[0].pos.clone(), rotY: docks[0].rotY }, docks);
  createHomeGangway(scene, home, ship, docks[0].pos);
  void ship.decorateAsync(scene);

  // ---- 上升气流（双峰之间 + 东峰顶）。柱宽要容住滑翔漂移，太窄会反复坠海罚回程 ----
  const updrafts = [
    { center: new Vector3(-537, -40, -169), radius: 18, height: 120, power: 9 },
    { center: new Vector3(-514, 0, -158), radius: 11, height: 60, power: 6 },
  ];

  // ---- 拾取物（GLB） ----
  const pickups: PickupDef[] = [];
  const [crystalModel, mushModel, mineralModel] = await Promise.all([
    loadEnvModel(scene, "items/Crystal1"),
    loadEnvModel(scene, "crops/Mushroom_4"),
    loadEnvModel(scene, "items/Mineral"),
  ]);
  const crystalProto = crystalModel.mesh.clone("crystalProto");
  crystalProto.isVisible = false;
  const mushProto = mushModel.mesh.clone("mushProto");
  mushProto.isVisible = false;
  const stoneProto = mineralModel.mesh.clone("stoneProto");
  stoneProto.isVisible = false;

  const addPickup = (uid: string, item: ItemId, count: number, world: Vector3, proto: Mesh, scale = 1) => {
    const m = proto.clone(`pickup_${uid}`);
    m.isVisible = true;
    m.position.copyFrom(world);
    m.scaling.setAll(scale);
    m.isPickable = false;
    shadowAdd(m);
    pickups.push({ uid, item, count, pos: world.clone(), mesh: m, taken: false });
  };

  // 风晶：西峰风眼旁 2 枚 + 东峰 3 枚
  const crystalSpots: [Island, number, number][] = [
    [canyonW, -6, -6], [canyonW, 8, -10],
    [canyonE, 3, 4], [canyonE, -5, 2], [canyonE, 6, -7],
  ];
  crystalSpots.forEach(([isle, lx, lz], i) => {
    const y = isle.heightAt(isle.root.position.x + lx, isle.root.position.z + lz);
    addPickup(`crystal_${i}`, "windcrystal", 1, new Vector3(isle.root.position.x + lx, (y ?? 0) + 0.55, isle.root.position.z + lz), crystalProto, 0.9);
  });

  // 云菇：家园 + 小屿
  const mushSpots: [Island, number, number][] = [
    [home, -30, 18], [home, -38, 10], [home, 12, 30],
    [islands[4], 2, -2], [islands[4], -3, 3],
    [canyonW, -10, 14],
  ];
  mushSpots.forEach(([isle, lx, lz], i) => {
    const y = isle.heightAt(isle.root.position.x + lx, isle.root.position.z + lz);
    addPickup(`mush_${i}`, "cloudmushroom", 1, new Vector3(isle.root.position.x + lx, (y ?? 0) + 0.12, isle.root.position.z + lz), mushProto, 0.9);
  });

  // 浮石：遗迹岛
  const stoneSpots: [Island, number, number][] = [
    [ruins, 6, -8], [ruins, -10, -4], [ruins, 12, 8], [ruins, -4, 14],
  ];
  stoneSpots.forEach(([isle, lx, lz], i) => {
    const y = isle.heightAt(isle.root.position.x + lx, isle.root.position.z + lz);
    addPickup(`stone_${i}`, "floatstone", 1, new Vector3(isle.root.position.x + lx, (y ?? 0) + 0.5, isle.root.position.z + lz), stoneProto, 0.8);
  });

  // ---- 云间遗迹探索点：石板广场 + 柱环 + 拱门 + 中央尖塔与风晶 ----
  const chests: ChestDef[] = [];
  const ruinCx = ruins.root.position.x, ruinCz = ruins.root.position.z;
  const ruinCy = ruins.heightAt(ruinCx, ruinCz) ?? 0;
  const ruinsRoot = new TransformNode("ruinsSite", scene);
  ruinsRoot.position.set(ruinCx, ruinCy, ruinCz);

  // 石板广场（两层错缝）
  const plazaMat = texMaterial(scene, "old_stone_wall_02", { u: 0.32, v: 0.32, specular: 0.03 });
  const plaza = MeshBuilder.CreateDisc("ruinsPlaza", { radius: 15, tessellation: 40 }, scene);
  plaza.rotation.x = Math.PI / 2;
  plaza.position.y = 0.05;
  plaza.parent = ruinsRoot;
  planarUVs(plaza, 0.32);
  plaza.material = plazaMat;
  plaza.isPickable = false;
  const plaza2 = MeshBuilder.CreateDisc("ruinsPlaza2", { radius: 10.5, tessellation: 36 }, scene);
  plaza2.rotation.x = Math.PI / 2;
  plaza2.position.y = 0.16;
  plaza2.parent = ruinsRoot;
  planarUVs(plaza2, 0.32);
  plaza2.material = plazaMat;
  plaza2.isPickable = false;

  // 柱环（8 根，2 根残柱）
  const [colModel, colBrokenModel, archModel, colTopModel] = await Promise.all([
    loadEnvModel(scene, "ruins/Column"),
    loadEnvModel(scene, "ruins/Column_Broken"),
    loadEnvModel(scene, "ruins/Entrance"),
    loadEnvModel(scene, "ruins/ModularColumn_top"),
  ]);
  const colProto = colModel.mesh.clone("colProto");
  colProto.isVisible = false;
  const colSize = colModel.size;
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 + 0.3;
    const r = 13.2;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    const gy = (ruins.heightAt(ruinCx + x, ruinCz + z) ?? ruinCy) - ruinCy;
    const broken = i === 2 || i === 6;
    const c = (broken ? colBrokenModel : colModel).mesh.clone(`ruinsCol${i}`);
    c.isVisible = true;
    c.position.set(x, gy + 0.12 - (broken ? colBrokenModel.size.y : 0), z);
    c.rotation.y = ang;
    c.isPickable = false;
    c.parent = ruinsRoot;
    // 柱体碰撞（不可见圆柱，静态）
    if (!broken) {
      const colHit = MeshBuilder.CreateCylinder(`ruinsColHit${i}`, { height: colSize.y, diameter: Math.max(colSize.x, colSize.z) * 0.8 }, scene);
      colHit.isVisible = false;
      colHit.position.set(x, gy + 0.12 + colSize.y / 2, z);
      colHit.parent = ruinsRoot;
      const agg = new PhysicsAggregate(colHit, PhysicsShapeType.CYLINDER, { mass: 0, friction: 0.8 }, scene);
      agg.body.setMotionType(PhysicsMotionType.STATIC);
    } else {
      const cap = colTopModel.mesh.clone(`ruinsColCap${i}`);
      cap.isVisible = true;
      cap.position.set(x + 0.9, gy + 0.12 + colBrokenModel.size.y, z);
      cap.rotation.y = ang + 0.6;
      cap.isPickable = false;
      cap.parent = ruinsRoot;
    }
  }

  // 入口拱门（对角两座）
  for (const [ax, az, ry] of [[-11.5, 11.5, -0.75], [11.5, -11.5, Math.PI - 0.75]] as [number, number, number][]) {
    const gy = (ruins.heightAt(ruinCx + ax, ruinCz + az) ?? ruinCy) - ruinCy;
    const arch = archModel.mesh.clone("ruinsArch");
    arch.isVisible = true;
    arch.position.set(ax, gy + 0.1 - baseOffset(archModel), az);
    arch.rotation.y = ry;
    arch.isPickable = false;
    arch.parent = ruinsRoot;
  }

  // 中央尖塔：叠柱 + 悬浮风晶 + 照明
  const spireBaseY = 0.14;
  const spireCol = colModel.mesh.clone("ruinsSpireCol");
  spireCol.isVisible = true;
  spireCol.position.set(0, spireBaseY - colModel.size.y, 0);
  spireCol.scaling.setAll(1.35);
  spireCol.isPickable = false;
  spireCol.parent = ruinsRoot;
  const spireHit = MeshBuilder.CreateCylinder("ruinsSpireHit", { height: 9, diameter: 2.2 }, scene);
  spireHit.isVisible = false;
  spireHit.position.set(0, spireBaseY + 3.4, 0);
  spireHit.parent = ruinsRoot;
  const spireAgg = new PhysicsAggregate(spireHit, PhysicsShapeType.CYLINDER, { mass: 0, friction: 0.8 }, scene);
  spireAgg.body.setMotionType(PhysicsMotionType.STATIC);
  const spireGem = MeshBuilder.CreatePolyhedron("ruinsSpireGem", { type: 1, size: 0.9 }, scene);
  const gemMat = new StandardMaterial("ruinsGemMat", scene);
  gemMat.diffuseColor = new Color3(0.45, 0.85, 0.9);
  gemMat.emissiveColor = new Color3(0.2, 0.65, 0.75);
  gemMat.alpha = 0.92;
  gemMat.specularColor = new Color3(0.5, 0.6, 0.65);
  spireGem.material = gemMat;
  spireGem.position.set(0, spireBaseY + 8.2, 0);
  spireGem.isPickable = false;
  spireGem.parent = ruinsRoot;
  const gemLight = new PointLight("ruinsGemLight", new Vector3(0, spireBaseY + 7.6, 0), scene);
  gemLight.diffuse = new Color3(0.35, 0.8, 0.85);
  gemLight.intensity = 0.55;
  gemLight.range = 22;

  // 宝箱（关闭/开启两态 GLB）
  const [chestClosedModel, chestOpenModel] = await Promise.all([
    loadEnvModel(scene, "items/Chest_Closed"),
    loadEnvModel(scene, "items/Chest_Open"),
  ]);
  const chestRoot = new TransformNode("chest_blueprint", scene);
  chestRoot.position.set(0, 0.14, -2.6);
  chestRoot.parent = ruinsRoot;
  const chestClosed = chestClosedModel.mesh.clone("chestClosed");
  chestClosed.isVisible = true;
  chestClosed.parent = chestRoot;
  chestClosed.position.set(0, 0.02 - baseOffset(chestClosedModel), 0);
  chestClosed.rotation.y = 0.35;
  chestClosed.isPickable = false;
  const chestOpenProto = chestOpenModel.mesh.clone("chestOpenProto");
  chestOpenProto.isVisible = false;

  const glowMat = new StandardMaterial("chestGlowMat", scene);
  glowMat.emissiveColor = new Color3(0.9, 0.75, 0.3);
  glowMat.opacityTexture = makeSparkleTexture(scene);
  glowMat.diffuseTexture = glowMat.opacityTexture;
  glowMat.disableLighting = true;
  const chestGlow = MeshBuilder.CreatePlane("chestGlow", { width: 1.6, height: 1.6 }, scene);
  chestGlow.position.set(0, 1.7, 0);
  chestGlow.billboardMode = Mesh.BILLBOARDMODE_ALL;
  chestGlow.material = glowMat;
  chestGlow.isPickable = false;
  chestGlow.parent = chestRoot;
  const chestHit = MeshBuilder.CreateBox("chestHit", { width: 1.5, height: 1.0, depth: 1.0 }, scene);
  chestHit.isVisible = false;
  chestHit.position.set(0, 0.5, 0);
  chestHit.parent = chestRoot;
  const chestAgg = new PhysicsAggregate(chestHit, PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, scene);
  chestAgg.body.setMotionType(PhysicsMotionType.STATIC);

  chests.push({
    uid: "blueprint", pos: chestRoot.position.add(ruinsRoot.position).add(new Vector3(0, 1, 0)), opened: false,
    label: "旧时代储物箱",
    grants: [{ item: "blueprint_berth", count: 1 }, { item: "floatstone", count: 2 }],
    node: chestRoot,
  });

  // 柱环火盆光（两盏，琥珀色）
  const torchModel = await loadEnvModel(scene, "ruins/Torch");
  for (const ang of [0.3 + Math.PI * 0.75, 0.3 + Math.PI * 1.75]) {
    const x = Math.cos(ang) * 13.2, z = Math.sin(ang) * 13.2;
    const gy = (ruins.heightAt(ruinCx + x, ruinCz + z) ?? ruinCy) - ruinCy;
    const torch = placeClone(scene, torchModel, new Vector3(ruinCx + x, ruinCy + gy + 0.1, ruinCz + z), ang, 1.5, `ruinsTorch${ang.toFixed(1)}`);
    torch.parent = ruinsRoot;
    torch.position.set(x, gy + 0.1 - baseOffset(torchModel), z);
    const tl = new PointLight(`ruinsTorchLight${ang.toFixed(1)}`, new Vector3(x, gy + 2.4, z), scene);
    tl.diffuse = new Color3(1.0, 0.72, 0.4);
    tl.intensity = 0.5;
    tl.range = 14;
  }

  // ---- 地标：云海尽头的远航灯塔（纯视觉） + 峰顶石柱 ----
  const landmarks: Landmark[] = [];
  const lhMat = texMaterial(scene, "old_stone_wall_02", { u: 2, v: 6, specular: 0.05 });
  const lighthouse = MeshBuilder.CreateCylinder("lighthouse", { height: 90, diameterTop: 6, diameterBottom: 14, tessellation: 10 }, scene);
  lighthouse.position.set(1500, 20, -900);
  lighthouse.material = lhMat;
  lighthouse.isPickable = false;
  const lhBeacon = MeshBuilder.CreateSphere("lhBeacon", { diameter: 9 }, scene);
  lhBeacon.position.set(1500, 72, -900);
  const beaconMat = new StandardMaterial("beaconMat", scene);
  beaconMat.emissiveColor = new Color3(1.0, 0.85, 0.45);
  beaconMat.diffuseColor = new Color3(1, 0.9, 0.6);
  lhBeacon.material = beaconMat;
  lhBeacon.isPickable = false;
  landmarks.push({ id: "lighthouse", name: "远航灯塔", pos: new Vector3(1500, 60, -900), height: 90 });

  const spireStone = MeshBuilder.CreateCylinder("spire", { height: 26, diameterTop: 0.8, diameterBottom: 3.2, tessellation: 8 }, scene);
  const spireY = canyonE.heightAt(canyonE.root.position.x + 2, canyonE.root.position.z - 2) ?? 0;
  spireStone.position.set(canyonE.root.position.x + 2, spireY + 13, canyonE.root.position.z - 2);
  spireStone.material = lhMat;
  spireStone.isPickable = false;
  const spireGem2 = MeshBuilder.CreatePolyhedron("spireGem", { type: 1, size: 1.4 }, scene);
  spireGem2.position.set(canyonE.root.position.x + 2, spireY + 27.5, canyonE.root.position.z - 2);
  spireGem2.material = gemMat;
  spireGem2.isPickable = false;
  landmarks.push({ id: "spire", name: "风眼石柱", pos: spireStone.position.clone(), height: 26 });

  const visited = new Set<string>(["home"]);

  return {
    islands, ship, docks, pickups, chests, updrafts, landmarks, visited,
    update(dt: number) {
      const t = performance.now() * 0.001;
      for (const p of pickups) {
        if (!p.taken) p.mesh.rotation.y = t * 1.2 + p.pos.x;
      }
      spireGem.rotation.y = t * 0.7;
      spireGem.position.y = spireBaseY + 8.2 + Math.sin(t * 1.4) * 0.3;
      spireGem2.rotation.y = -t * 0.5;
      chestGlow.position.y = 1.7 + Math.sin(t * 2.4) * 0.12;
      chestGlow.rotation.z = t * 0.8;
      beaconMat.emissiveColor = new Color3(0.9 + Math.sin(t * 2) * 0.1, 0.8, 0.4);
      gemLight.intensity = 0.5 + Math.sin(t * 1.8) * 0.12;
      void dt;
    },
  };
}

/** 宝箱开启后切换为开盖模型（模型已随场景加载，直接同步切换） */
export function swapChestOpen(chest: ChestDef): void {
  const openModel = getLoadedEnvModel("items/Chest_Open");
  if (!openModel) { console.warn("[chest] open model not ready"); return; }
  for (const c of chest.node.getChildMeshes()) if (c.name === "chestClosed") c.setEnabled(false);
  const open = openModel.mesh.clone("chestOpen");
  open.isVisible = true;
  open.parent = chest.node;
  open.position.set(0, 0.02 - baseOffset(openModel), 0);
  open.rotation.y = 0.35;
  open.isPickable = false;
}

/** 岸端台地与已停泊云舟甲板之间的可走栈道；云舟离泊后保留为岸端设施。 */
function createHomeGangway(scene: Scene, home: Island, ship: CloudShip, dockPos: Vector3): void {
  // 岸端取泊位锚点向岛心内收 2.6m 处的实测地表(旧版硬编码岸点在 world-v2 新岛上无地形)
  const toCenter = new Vector3(-dockPos.x, 0, -dockPos.z);
  const inland = toCenter.lengthSquared() > 0.001 ? toCenter.normalize().scale(2.6) : new Vector3(2.6, 0, 0);
  const shore = new Vector3(dockPos.x + inland.x, home.heightAt(dockPos.x + inland.x, dockPos.z + inland.z) ?? dockPos.y, dockPos.z + inland.z);
  const deck = ship.deckBoardPos();
  deck.y = ship.pos.y + 0.38;
  const dx = deck.x - shore.x, dz = deck.z - shore.z;
  const length = Math.hypot(dx, dz);
  const pitch = Math.atan2(deck.y - shore.y, length);
  const ramp = MeshBuilder.CreateBox("islandTop_homeGangway", { width: 2.6, height: 0.24, depth: length }, scene);
  ramp.position.set((shore.x + deck.x) / 2, (shore.y + deck.y) / 2 - Math.cos(pitch) * 0.12, (shore.z + deck.z) / 2);
  ramp.rotation.y = Math.atan2(dx, dz);
  ramp.rotation.x = -pitch;
  ramp.isVisible = false;
  ramp.isPickable = true;
  const body = new PhysicsAggregate(ramp, PhysicsShapeType.BOX, { mass: 0, friction: 0.9 }, scene);
  body.body.setMotionType(PhysicsMotionType.STATIC);
}

function makeSparkleTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture("sparkle", { width: 128, height: 128 }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 128, 128);
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 60);
  g.addColorStop(0, "rgba(255,230,150,0.9)");
  g.addColorStop(0.4, "rgba(255,210,120,0.35)");
  g.addColorStop(1, "rgba(255,200,100,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  // 星形光芒
  ctx.strokeStyle = "rgba(255,240,180,0.85)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(64, 10); ctx.lineTo(64, 118);
  ctx.moveTo(10, 64); ctx.lineTo(118, 64);
  ctx.stroke();
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

void scatterThin;
