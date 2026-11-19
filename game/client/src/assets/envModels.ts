// 开放授权环境资产（Quaternius GLB + Poly Haven 纹理）：容器缓存、合并、薄实例与材质工具。
// 授权记录：docs/licenses/cc0-assets-20261101.txt
import {
  Scene, AssetContainer, SceneLoader, Vector3, Mesh, TransformNode, Matrix, Quaternion,
  StandardMaterial, Texture, Color3,
} from "@babylonjs/core";

export interface EnvModel {
  /** 合并后的母版网格（isVisible=false，仅用于薄实例/克隆） */
  mesh: Mesh;
  /** 原始包围盒尺寸（米） */
  size: Vector3;
}

const cache = new Map<string, EnvModel>();

async function loadGlb(scene: Scene, url: string): Promise<AssetContainer> {
  const res = await fetch(url, { method: "HEAD" });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok || ct.includes("text/html")) throw new Error(`asset unavailable: ${url} (${res.status})`);
  return SceneLoader.LoadAssetContainerAsync(url, "", scene);
}

/**
 * 加载静态环境模型：实例化进场景后合并为单网格（保留多材质子网格），
 * 母版隐藏，供薄实例散布或克隆摆放。
 */
export async function loadEnvModel(scene: Scene, name: string): Promise<EnvModel> {
  const hit = cache.get(name);
  if (hit) return hit;
  const container = await loadGlb(scene, `/assets/env/${name}.glb`);
  const entries = container.instantiateModelsToScene(undefined, true, { doNotInstantiate: true });
  const parts: Mesh[] = [];
  for (const rn of entries.rootNodes) {
    if (rn instanceof Mesh && rn.getTotalVertices() > 0 && rn.getTotalIndices() > 0) parts.push(rn);
    for (const c of rn.getChildMeshes()) {
      if (c instanceof Mesh && c.getTotalVertices() > 0 && c.getTotalIndices() > 0 && !parts.includes(c)) parts.push(c);
    }
  }
  if (!parts.length) throw new Error(`no meshes in ${name}`);
  // MergeMeshes 多材质模式要求各网格属性集一致：缺失的对齐补零（color 补白），
  // 否则空属性差异会抛 "same set of attributes"，空几何网格会让合并循环读 length 崩溃。
  const attrKinds: [string, number, number][] = [["normal", 3, 0], ["tangent", 4, 0], ["uv", 2, 0], ["color", 4, 1]];
  for (const [kind, stride, fill] of attrKinds) {
    if (!parts.some((p) => !!p.getVerticesData(kind))) continue;
    for (const p of parts) {
      if (p.getVerticesData(kind)) continue;
      p.makeGeometryUnique();
      const arr = new Float32Array(p.getTotalVertices() * stride);
      if (fill) arr.fill(fill);
      p.setVerticesData(kind, arr);
    }
  }
  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
  merged.name = `env_${name.replace("/", "_")}`;
  // 清理容器残留的空节点
  for (const rn of entries.rootNodes) if (rn !== (merged as unknown as typeof rn) && !rn.getChildMeshes().length) rn.dispose();
  merged.isVisible = false;
  merged.isPickable = false;
  merged.setEnabled(true);
  // 尺寸标定（合并后网格原点在模型原点，底部对齐需要 yMin）
  const bb = merged.getBoundingInfo().boundingBox;
  const size = bb.maximumWorld.subtract(bb.minimumWorld);
  const model: EnvModel = { mesh: merged, size };
  cache.set(name, model);
  return model;
}

/** 母版网格的底部偏移（实例/克隆摆放到地面时需要补偿） */
export function baseOffset(model: EnvModel): number {
  return model.mesh.getBoundingInfo().boundingBox.minimumWorld.y;
}

/** 同步取已加载的环境模型（未加载返回 null） */
export function getLoadedEnvModel(name: string): EnvModel | null {
  return cache.get(name) ?? null;
}

export interface Spot { x: number; z: number; y: number; rotY: number; scale: number }

/** 薄实例散布：一次 draw call 布置同类模型（mesh 为母版或其克隆） */
export function scatterThin(mesh: Mesh, spots: Spot[], parent?: TransformNode): Mesh {
  const data = new Float32Array(spots.length * 16);
  spots.forEach((s, i) => {
    const c = Math.cos(s.rotY), sn = Math.sin(s.rotY);
    data[i * 16 + 0] = c * s.scale; data[i * 16 + 2] = -sn * s.scale;
    data[i * 16 + 5] = s.scale;
    data[i * 16 + 8] = sn * s.scale; data[i * 16 + 10] = c * s.scale;
    data[i * 16 + 12] = s.x; data[i * 16 + 13] = s.y; data[i * 16 + 14] = s.z;
    data[i * 16 + 15] = 1;
  });
  mesh.thinInstanceSetBuffer("matrix", data, 16, true);
  if (parent) mesh.parent = parent;
  mesh.isVisible = true;
  return mesh;
}

/** 克隆单件摆放（非实例化，用于少量手工布置） */
export function placeClone(scene: Scene, model: EnvModel, pos: Vector3, rotY = 0, scale = 1, name?: string, tiltX = 0): Mesh {
  const m = model.mesh.clone(name ?? `${model.mesh.name}_c`);
  m.isVisible = true;
  m.position.set(pos.x, pos.y - baseOffset(model) * scale, pos.z);
  m.rotation.y = rotY;
  m.rotation.x = tiltX;
  m.scaling.setAll(scale);
  m.isPickable = false;
  void scene;
  return m;
}

// ---------- Poly Haven 纹理材质 ----------

const texCache = new Map<string, Texture>();
function tex(scene: Scene, path: string, noMipmap = false): Texture {
  const hit = texCache.get(path);
  if (hit) return hit;
  const t = new Texture(path, scene, noMipmap, false, Texture.TRILINEAR_SAMPLINGMODE);
  texCache.set(path, t);
  return t;
}

export interface TexMatOpts {
  /** 每米重复数（uv 以米为单位生成时使用） */
  scale?: number;
  u?: number; v?: number;
  specular?: number;
  emissive?: Color3;
  alpha?: number;
}

/** 用 Poly Haven 纹理组（diff/nor/rough）建 StandardMaterial；name 形如 "aerial_grass_rock" */
export function texMaterial(scene: Scene, name: string, opts: TexMatOpts = {}): StandardMaterial {
  const mat = new StandardMaterial(`tex_${name}_${Math.random().toString(36).slice(2, 6)}`, scene);
  const base = `/assets/tex/${name}`;
  const d = tex(scene, `${base}_diff.jpg`);
  const scale = opts.scale ?? 0.25;
  d.uScale = opts.u ?? scale;
  d.vScale = opts.v ?? scale;
  mat.diffuseTexture = d;
  try {
    const bump = tex(scene, `${base}_nor.jpg`) as Texture;
    bump.uScale = d.uScale; bump.vScale = d.vScale;
    mat.bumpTexture = bump;
  } catch { /* 无法线时省略 */ }
  mat.specularColor = new Color3(opts.specular ?? 0.06, opts.specular ?? 0.06, opts.specular ?? 0.06);
  mat.specularPower = 24;
  if (opts.emissive) mat.emissiveColor = opts.emissive;
  if (opts.alpha !== undefined) { mat.alpha = opts.alpha; }
  return mat;
}

/** 平面 UV（按米）：地形顶面用，uv=(x,z)；配合 texMaterial 的 u/v（每米重复数） */
export function planarUVs(mesh: Mesh, uvScale = 1): void {
  const pos = mesh.getVerticesData("position");
  if (!pos) return;
  const uvs = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length; i += 3) {
    uvs[(i / 3) * 2 + 0] = pos[i] * uvScale;
    uvs[(i / 3) * 2 + 1] = pos[i + 2] * uvScale;
  }
  mesh.setVerticesData("uv", uvs);
}

/** 圆柱 UV：环向 u（2 周重复）、纵向 v（按米）；崖壁/船体侧板用 */
export function cylindricalUVs(mesh: Mesh, vScale = 0.15): void {
  const pos = mesh.getVerticesData("position");
  if (!pos) return;
  const uvs = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length; i += 3) {
    const ang = Math.atan2(pos[i], pos[i + 2]);
    uvs[(i / 3) * 2 + 0] = ang / Math.PI;
    uvs[(i / 3) * 2 + 1] = pos[i + 1] * vScale;
  }
  mesh.setVerticesData("uv", uvs);
}

export { Matrix, Quaternion };
