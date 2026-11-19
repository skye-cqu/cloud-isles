// 程序化浮空岛：解析高度函数（玩法采样）+ 顶面网格（物理碰撞）+ 岛底 + GLB 植被装饰。
// 地表/崖壁用 Poly Haven CC0 纹理，植被用 Quaternius CC0 GLB 薄实例（docs/licenses/cc0-assets-20261101.txt）。
import {
  Scene, Vector3, Color3, Mesh, MeshBuilder, StandardMaterial,
  VertexData, TransformNode, PhysicsAggregate, PhysicsShapeType, PhysicsMotionType,
  Mesh as BMesh,
} from "@babylonjs/core";
import { makeNoise2D, makeRng } from "../core/rng";
import { loadEnvModel, scatterThin, texMaterial, planarUVs, cylindricalUVs, Spot } from "../assets/envModels";

export interface IslandDef {
  id: string;
  name: string;
  center: [number, number];
  radius: number;
  height: number;
  depth: number;
  seed: number;
  kind: "home" | "canyon" | "ruins" | "islet" | "forest";
  /** 岛屿简介（发现记录用） */
  intro: string;
}

export interface Island {
  def: IslandDef;
  root: TransformNode;
  top: BMesh;
  /** 世界坐标高度采样；岛外返回 null */
  heightAt(x: number, z: number): number | null;
  /** 需要遵循导出坡度和建筑占用的家园可行走范围。 */
  canWalkAt?(x: number, z: number): boolean;
  /** 玩家和 NPC 共用的家园建造面限制。 */
  canBuildAt?(x: number, z: number): boolean;
  dispose(): void;
}

export function createIsland(scene: Scene, def: IslandDef): Island {
  const root = new TransformNode(`island_${def.id}`, scene);
  root.position.set(def.center[0], 0, def.center[1]);
  const noise = makeNoise2D(def.seed);
  const noise2 = makeNoise2D(def.seed * 7 + 13);
  const R = def.radius;

  // ---- 高度函数（局部坐标） ----
  const heightLocal = (x: number, z: number): number => {
    const d = Math.hypot(x, z);
    // 边缘环浮点溢出（d≈R+7e-15）曾产生 NaN 顶点，令 Havok 凸包静默退化为薄盘——岛缘必须钳制
    if (d > R + 0.5) return NaN;
    const dc = Math.min(d, R);
    const rp = R * 0.55;
    let h: number;
    if (dc <= rp) {
      h = def.height * (0.92 + 0.08 * (1 - dc / rp));
    } else {
      const t = 1 - (dc - rp) / (R - rp);
      h = def.height * 0.92 * Math.pow(Math.max(t, 0), 1.35);
    }
    // 起伏
    const n = noise(x * 0.045, z * 0.045) * 0.6 + noise2(x * 0.11, z * 0.11) * 0.4;
    h += n * def.height * 0.10 * Math.min(1, dc / (R * 0.35));
    return h;
  };

  // ---- 顶面网格：极坐标网格 ----
  const segRad = 64;
  const segRing = 16;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number, z: number, c: Color3) => {
    positions.push(x, y, z);
    colors.push(c.r, c.g, c.b, 1);
  };
  // 顶面色只承担明暗与边缘过渡，草色由纹理提供
  const colorAt = (h: number, d: number): Color3 => {
    const t = Math.min(1, Math.max(0, h / def.height));
    const lum = 0.93 + t * 0.17;
    const c = new Color3(lum, lum * 0.99, lum * 0.94);
    if (d > R * 0.8) {
      const k = Math.min(1, (d - R * 0.8) / (R * 0.2)) * 0.45;
      return Color3.Lerp(c, new Color3(0.78, 0.72, 0.66), k);
    }
    return c;
  };
  push(0, heightLocal(0, 0), 0, colorAt(heightLocal(0, 0), 0));
  for (let ri = 1; ri <= segRing; ri++) {
    const rr = (ri / segRing) * R;
    for (let ai = 0; ai < segRad; ai++) {
      const ang = (ai / segRad) * Math.PI * 2;
      const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
      const h = heightLocal(x, z);
      push(x, h, z, colorAt(h, rr));
    }
  }
  const idxOf = (ri: number, ai: number) => 1 + (ri - 1) * segRad + (ai % segRad);
  for (let ai = 0; ai < segRad; ai++) indices.push(0, idxOf(1, ai + 1), idxOf(1, ai));
  for (let ri = 1; ri < segRing; ri++) {
    for (let ai = 0; ai < segRad; ai++) {
      const a = idxOf(ri, ai), b = idxOf(ri, ai + 1), c = idxOf(ri + 1, ai), d2 = idxOf(ri + 1, ai + 1);
      indices.push(a, d2, c, a, b, d2);
    }
  }

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  // 顶面中心顶点法线应朝上；否则整体翻转绕序后重算
  if (normals[1] < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t;
    }
    VertexData.ComputeNormals(positions, indices, normals);
  }
  const top = new Mesh(`islandTop_${def.id}`, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.colors = colors;
  vd.applyToMesh(top);
  top.parent = root;
  top.isPickable = false;
  const grassMat = texMaterial(scene, "aerial_grass_rock", { specular: 0.03, u: 0.12, v: 0.12 });
  top.material = grassMat;
  top.useVertexColors = true;
  planarUVs(top, 1);

  // 物理顶面：穹顶用凸包更稳健（Havok 对该网格建 MESH 形状会内存越界）
  const phys = new PhysicsAggregate(top, PhysicsShapeType.CONVEX_HULL, { mass: 0, friction: 0.7, restitution: 0 }, scene);
  phys.body.setMotionType(PhysicsMotionType.STATIC);

  // ---- 岛底：边缘往下收拢的倒锥（噪声扰动），独立网格 + 崖壁纹理 ----
  const basePos: number[] = [];
  const baseIdx: number[] = [];
  const pushB = (x: number, y: number, z: number) => basePos.push(x, y, z);
  const topEdgeStart = basePos.length / 3;
  for (let ai = 0; ai < segRad; ai++) {
    const ang = (ai / segRad) * Math.PI * 2;
    const x = Math.cos(ang) * R, z = Math.sin(ang) * R;
    pushB(x, heightLocal(Math.min(x, x), Math.min(z, z)) , z);
  }
  // 顶面外缘顶点直接取顶面网格边缘（同高），保证拼接
  const rings: number[][] = [];
  const depthRings = 5;
  for (let i = 1; i <= depthRings; i++) {
    const t = i / depthRings;
    const rr = R * (1 - 0.78 * t);
    const yy = -def.depth * Math.pow(t, 1.25) - noise2(t * 3.1, 0.7) * def.depth * 0.06;
    const ringIdx: number[] = [];
    for (let ai = 0; ai < segRad; ai++) {
      const ang = (ai / segRad) * Math.PI * 2;
      const wob = 1 + noise2(Math.cos(ang) * 2.4 + t * 4, Math.sin(ang) * 2.4) * 0.16 * t;
      const x = Math.cos(ang) * rr * wob, z = Math.sin(ang) * rr * wob;
      ringIdx.push(basePos.length / 3);
      pushB(x, yy, z);
    }
    rings.push(ringIdx);
  }
  for (let ai = 0; ai < segRad; ai++) {
    const tA = topEdgeStart + ai, tB = topEdgeStart + ((ai + 1) % segRad);
    const bA = rings[0][ai], bB = rings[0][(ai + 1) % segRad];
    baseIdx.push(...islandSideQuad(tA, tB, bA, bB));
  }
  for (let ri = 0; ri < depthRings - 1; ri++) {
    for (let ai = 0; ai < segRad; ai++) {
      const aA = rings[ri][ai], aB = rings[ri][(ai + 1) % segRad];
      const bA = rings[ri + 1][ai], bB = rings[ri + 1][(ai + 1) % segRad];
      baseIdx.push(...islandSideQuad(aA, aB, bA, bB));
    }
  }
  const tipIdx = basePos.length / 3;
  pushB(0, -def.depth * 1.06, 0);
  for (let ai = 0; ai < segRad; ai++) {
    baseIdx.push(rings[depthRings - 1][ai], tipIdx, rings[depthRings - 1][(ai + 1) % segRad]);
  }
  const baseNormals: number[] = [];
  VertexData.ComputeNormals(basePos, baseIdx, baseNormals);
  const base = new Mesh(`islandBase_${def.id}`, scene);
  const bvd = new VertexData();
  bvd.positions = basePos;
  bvd.indices = baseIdx;
  bvd.normals = baseNormals;
  bvd.applyToMesh(base);
  base.parent = root;
  base.isPickable = false;
  cylindricalUVs(base, 0.13);
  const cliffMat = texMaterial(scene, "cliff_side", { specular: 0.02, u: 1, v: 1 });
  base.material = cliffMat;

  const heightAt = (wx: number, wz: number): number | null => {
    const lx = wx - root.position.x, lz = wz - root.position.z;
    const h = heightLocal(lx, lz);
    return Number.isNaN(h) ? null : h;
  };

  return {
    def, root, top, heightAt,
    dispose() { phys.dispose(); top.dispose(); base.dispose(); root.dispose(); },
  };
}

// ---------- 植被与岩石装饰（GLB 薄实例） ----------
export function islandSideQuad(aA: number, aB: number, bA: number, bB: number): number[] {
  return [aA, bA, aB, aB, bA, bB];
}

export interface IslandDecor {
  group: TransformNode;
}

type ModelPair = [string, number, number]; // 模型名、权重、基础缩放

const DECOR_SETS: Record<IslandDef["kind"], ModelPair[]> = {
  home: [
    ["nature/CommonTree_1", 3, 1.5], ["nature/CommonTree_2", 3, 1.5], ["nature/CommonTree_3", 2, 1.5],
    ["nature/PineTree_1", 2, 1.6], ["nature/PineTree_2", 2, 1.6],
    ["nature/Bush_1", 3, 1.2], ["nature/Bush_2", 3, 1.2], ["nature/BushBerries_1", 2, 1.2],
    ["nature/Grass", 6, 1.4], ["nature/Grass_2", 5, 1.4], ["nature/Flowers", 3, 1.2],
    ["nature/Rock_1", 2, 1.0], ["nature/Rock_2", 2, 1.0], ["nature/Rock_Moss_1", 1.5, 1.1],
  ],
  canyon: [
    ["nature/PineTree_1", 3, 1.7], ["nature/PineTree_2", 3, 1.7], ["nature/PineTree_3", 2, 1.7],
    ["nature/Bush_1", 2, 1.1], ["nature/Grass", 4, 1.2],
    ["nature/Rock_2", 3, 1.4], ["nature/Rock_3", 3, 1.4], ["nature/Rock_Moss_2", 2, 1.3],
  ],
  ruins: [
    ["nature/Rock_Moss_1", 3, 1.5], ["nature/Rock_Moss_2", 3, 1.5], ["nature/Rock_Moss_3", 2, 1.5],
    ["nature/Rock_3", 2, 1.3], ["nature/Bush_2", 2, 1.1], ["nature/Grass_2", 3, 1.1],
  ],
  islet: [
    ["nature/Bush_1", 3, 1.2], ["nature/BushBerries_1", 2, 1.2], ["nature/Grass", 4, 1.3], ["nature/Rock_1", 2, 0.9],
  ],
  // 运行时生成的林地岛:植被已烘焙进 GLB,不走 decorateIsland
  forest: [],
};

/** 用薄实例布置 GLB 植被与岩石（确定性随机） */
export async function decorateIsland(scene: Scene, island: Island, opts: { density?: number; clearCenter?: number } = {}) {
  const rng = makeRng(island.def.seed + 999);
  const group = new TransformNode(`decor_${island.def.id}`, scene);
  group.parent = island.root;
  const R = island.def.radius;
  const clear = opts.clearCenter ?? R * 0.42;
  const density = opts.density ?? 1.0;
  const count = Math.max(8, Math.floor(density * R * 0.85));

  // 每个岛独立克隆母版（共享几何体），避免薄实例缓冲相互覆盖
  const byModel = new Map<string, Spot[]>();
  for (let i = 0; i < count; i++) {
    const d = clear + rng() * (R * 0.94 - clear);
    const ang = rng() * Math.PI * 2;
    const x = Math.cos(ang) * d, z = Math.sin(ang) * d;
    const y = island.heightAt(island.root.position.x + x, island.root.position.z + z);
    if (y === null) continue;
    // 按权重选模型
    const set = DECOR_SETS[island.def.kind];
    const totalW = set.reduce((s, m) => s + m[1], 0);
    let pick = rng() * totalW;
    let model = set[0];
    for (const m of set) { pick -= m[1]; if (pick <= 0) { model = m; break; } }
    const list = byModel.get(model[0]) ?? [];
    list.push({ x, z, y: y - 0.06, rotY: rng() * Math.PI * 2, scale: model[2] * (0.8 + rng() * 0.5) });
    byModel.set(model[0], list);
  }
  for (const [name, spots] of byModel) {
    try {
      const model = await loadEnvModel(scene, name);
      const clone = model.mesh.clone(`${model.mesh.name}_${island.def.id}`);
      clone.isPickable = false;
      clone.position.set(0, 0, 0);
      scatterThin(clone, spots, group);
    } catch (e) {
      console.warn("[decor] load failed", name, e);
    }
  }
  return { group };
}

/** 石板降落区：视觉标记 + 停泊参考（世界.ts 停泊点依赖 worldPos()） */
export function createLandingPad(scene: Scene, island: Island, localPos: [number, number, number], rotY: number, bannerColor: Color3) {
  const root = new TransformNode(`pad_${island.def.id}`, scene);
  root.parent = island.root;
  root.position.set(localPos[0], localPos[1], localPos[2]);
  root.rotation.y = rotY;
  const y = island.heightAt(island.root.position.x + localPos[0], island.root.position.z + localPos[2]);
  const baseY = (y ?? localPos[1]) + 0.05;

  const stoneMat = texMaterial(scene, "mossy_rock", { u: 0.5, v: 0.5, specular: 0.04 });
  const ring = MeshBuilder.CreateTorus(`padRing_${island.def.id}`, { diameter: 9, thickness: 0.42, tessellation: 28 }, scene);
  ring.position.y = baseY + 0.1;
  ring.parent = root;
  ring.material = stoneMat;

  const disc = MeshBuilder.CreateDisc(`padDisc_${island.def.id}`, { radius: 4.3, tessellation: 28 }, scene);
  disc.rotation.x = Math.PI / 2;
  disc.position.y = baseY + 0.04;
  disc.parent = root;
  planarUVs(disc, 0.5);
  disc.material = stoneMat.clone(`padDiscMat_${island.def.id}`);
  (disc.material as StandardMaterial).specularColor = new Color3(0.03, 0.03, 0.03);

  const pole = MeshBuilder.CreateCylinder(`padPole_${island.def.id}`, { height: 4.4, diameter: 0.16 }, scene);
  pole.position.set(4.6, baseY + 2.2, 0);
  pole.parent = root;
  const woodMat = new StandardMaterial(`padPoleMat_${island.def.id}`, scene);
  woodMat.diffuseColor = new Color3(0.45, 0.33, 0.23);
  woodMat.specularColor = new Color3(0.04, 0.04, 0.04);
  pole.material = woodMat;
  const flag = MeshBuilder.CreatePlane(`padFlag_${island.def.id}`, { width: 1.6, height: 1.0 }, scene);
  flag.position.set(5.45, baseY + 3.9, 0);
  flag.parent = root;
  const fmat = new StandardMaterial(`flagMat_${island.def.id}`, scene);
  fmat.diffuseColor = bannerColor;
  fmat.emissiveColor = bannerColor.scale(0.3);
  fmat.backFaceCulling = false;
  fmat.specularColor = new Color3(0, 0, 0);
  flag.material = fmat;

  return { root, worldPos(): Vector3 { return new Vector3(island.root.position.x + localPos[0], baseY + 0.4, island.root.position.z + localPos[2]); }, y: baseY };
}
