// 官方三维资产加载：GLB 容器 + 尺度标定（按目录尺寸归一，规避外部资产单位差异）。
import {
  Scene, TransformNode, AssetContainer, SceneLoader, Vector3, Mesh, Logger,
} from "@babylonjs/core";

export interface LoadedModel {
  container: AssetContainer;
  /** 归一化缩放（应用后 bbox 最大水平尺寸 = 目标宽） */
  scale: number;
  /** 加载后的 y 偏移，使底部贴地 */
  yOffset: number;
  size: Vector3;
}

const cache = new Map<string, LoadedModel>();

/** 取已加载的归一化模型 */
export function getLoadedModel(name: string, targetWidth: number): LoadedModel | null {
  return cache.get(`${name}@${targetWidth}`) ?? null;
}

async function loadGlb(scene: Scene, url: string): Promise<AssetContainer> {
  const res = await fetch(url, { method: "HEAD" });
  const ct = res.headers.get("content-type") || "";
  // 历史坑：404 时 Vite 返回 index.html，GLB 会静默挂死 —— 先校验 content-type。
  if (!res.ok || (ct.includes("text/html"))) {
    throw new Error(`asset unavailable: ${url} (${res.status} ${ct})`);
  }
  return SceneLoader.LoadAssetContainerAsync(url, "", scene);
}

/** 加载并归一化：最大水平尺寸对齐 targetWidth（米），底部对齐 y=0。file 相对 /assets/（如 lux3d/chair-cloudwood）；以 / 开头视为完整 URL（运行时生成的 /generated-assets/...）。 */
export async function loadItemModel(scene: Scene, file: string, targetWidth: number): Promise<LoadedModel> {
  const key = `${file}@${targetWidth}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const container = await loadGlb(scene, file.startsWith("/") ? file : `/assets/${file}.glb`);
  let min = new Vector3(1e9, 1e9, 1e9), max = new Vector3(-1e9, -1e9, -1e9);
  for (const m of container.meshes) {
    if (!m.getTotalVertices()) continue;
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    for (const c of [bb.minimumWorld, bb.maximumWorld]) {
      min = Vector3.Minimize(min, c);
      max = Vector3.Maximize(max, c);
    }
  }
  const size = max.subtract(min);
  const horiz = Math.max(size.x, size.z) || 1;
  const scale = targetWidth / horiz;
  const model: LoadedModel = { container, scale, yOffset: -min.y * scale, size: size.scale(scale) };
  cache.set(key, model);
  Logger.Log(`[assets] ${file} size=${size} scale=${scale.toFixed(4)}`);
  return model;
}

/** 实例化一个模型（调用方负责 dispose 返回节点） */
export function instantiateModel(scene: Scene, model: LoadedModel): TransformNode {
  const root = new TransformNode("modelInst", scene);
  const entries = model.container.instantiateModelsToScene(undefined, false, { doNotInstantiate: true });
  for (const child of entries.rootNodes) {
    child.parent = root;
  }
  root.scaling.setAll(model.scale);
  root.position.y = model.yOffset;
  return root;
}
