// 运行时生成的 LSIC 岛屿:按服务端描述符加载 GLB + 高度表面,装配碰撞与锚点。
// 与家园(lsicHome)同一导出契约:lsic_root 0.25 缩放、+z 同向、表面 v1 扁平网格。
import {
  Mesh, Quaternion, Scene, SceneLoader, TransformNode, Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { IslandDescriptor } from "shared";
import type { Island, IslandDef } from "./island";
import {
  createHomeSurface, makeObstacleColliders, makeSurfaceColliders,
  type HomeSurface, type HomeSurfaceData,
} from "./lsicHome";
import { applyLsicTerrainMaterials } from "./lsicMaterials";

export interface RuntimeLsicIsland extends Island {
  surface: HomeSurface;
  descriptor: IslandDescriptor;
  /** 世界坐标泊位(锚点 + 悬浮高度) */
  dock: { pos: Vector3; rotY: number };
  spawn: Vector3;
}

const RECIPE_LABELS: Record<string, { name: string; intro: string }> = {
  forest: { name: "青林屿", intro: "云海上生长的林地空岛,松林与灌木间常有云菇。" },
  canyon: { name: "风峡屿", intro: "岩峰夹峙的风道,风晶在峡口凝结。" },
  ruins: { name: "遗迹屿", intro: "旧时代的石造残留,浮石散落其间。" },
};

export function islandDisplayName(descriptor: IslandDescriptor): string {
  const label = RECIPE_LABELS[descriptor.recipe]?.name ?? "远屿";
  const { x, z } = descriptor.key.region;
  return `${label} (${x},${z})`;
}

export function islandIntro(descriptor: IslandDescriptor): string {
  return RECIPE_LABELS[descriptor.recipe]?.intro ?? "云海深处的一座空岛。";
}

/** 加载并装配一座运行时生成的 LSIC 岛屿。失败抛出,由流式器记录并重试。 */
export async function createLsicRuntimeIsland(
  scene: Scene, descriptor: IslandDescriptor, shadowAdd: (mesh: Mesh) => void,
): Promise<RuntimeLsicIsland> {
  const key = descriptor.key;
  const id = `gen_r${key.region.x}_${key.region.z}_${key.index}`;
  const surfaceRes = await fetch(`/${descriptor.addresses.surface}`);
  if (!surfaceRes.ok) throw new Error(`surface unavailable (${surfaceRes.status})`);
  const surface = createHomeSurface(await surfaceRes.json() as HomeSurfaceData);

  const root = new TransformNode(`island_${id}`, scene);
  const [cx, alt, cz] = descriptor.centerWorld;
  root.position.set(cx, alt, cz);

  const container = await SceneLoader.LoadAssetContainerAsync(`/${descriptor.addresses.model}`, "", scene);
  container.addAllToScene();
  const glbMeshes = container.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh);
  applyLsicTerrainMaterials(scene, glbMeshes);
  const glbRoot = [...container.rootNodes, ...container.transformNodes, ...container.meshes]
    .find((n) => n.name === "lsic_root");
  if (!glbRoot) throw new Error("runtime LSIC GLB is missing lsic_root");
  // 与家园一致:保留 glTF loader 的 __root__(右手→左手),去掉附加的 Y=π 旋转
  let importedRoot = glbRoot;
  while (importedRoot.parent) importedRoot = importedRoot.parent;
  (importedRoot as TransformNode).rotationQuaternion = Quaternion.Identity();
  importedRoot.parent = root;
  for (const mesh of glbMeshes) {
    mesh.isPickable = false;
    shadowAdd(mesh);
  }

  const colliders = [
    ...makeSurfaceColliders(scene, root, surface.data),
    ...makeObstacleColliders(scene, root, surface),
  ];

  // 表面数据是岛屿局部坐标(含自身高度);悬浮高度由 root.y 承担
  const heightAt = (wx: number, wz: number): number | null => {
    const h = surface.heightAt(wx - root.position.x, wz - root.position.z);
    return h === null ? null : h + root.position.y;
  };
  const canWalkAt = (wx: number, wz: number): boolean =>
    surface.canWalkAt(wx - root.position.x, wz - root.position.z);
  const canBuildAt = (wx: number, wz: number): boolean =>
    surface.canBuildAt(wx - root.position.x, wz - root.position.z);

  const dockAnchor = surface.data.dock.pos;
  const spawnAnchor = descriptor.anchors.spawn;
  const def: IslandDef = {
    id, name: islandDisplayName(descriptor),
    center: [cx, cz],
    radius: descriptor.radius,
    height: heightAt(cx, cz) ?? 20,
    depth: 30,
    seed: 0,
    kind: descriptor.recipe === "home" ? "home"
      : descriptor.recipe === "canyon" ? "canyon"
      : descriptor.recipe === "ruins" ? "ruins" : "forest",
    intro: islandIntro(descriptor),
  };

  return {
    def, root, top: colliders[0].mesh,
    surface, descriptor,
    dock: { pos: new Vector3(cx + dockAnchor[0], alt + dockAnchor[1], cz + dockAnchor[2]), rotY: surface.data.dock.rotY },
    spawn: new Vector3(cx + spawnAnchor[0], alt + spawnAnchor[1], cz + spawnAnchor[2]),
    heightAt, canWalkAt, canBuildAt,
    dispose() {
      for (const { mesh, body } of colliders) { body.dispose(); mesh.dispose(); }
      container.dispose();
      root.dispose();
    },
  };
}
