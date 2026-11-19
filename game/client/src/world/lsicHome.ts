import {
  Mesh, MeshBuilder, PhysicsAggregate, PhysicsMotionType, PhysicsShapeType, Scene,
  TransformNode, Vector3, VertexData,
} from "@babylonjs/core";
import { makeNoise2D } from "../core/rng";
import type { Island, IslandDef } from "./island";
import { homeTerrainMaterial } from "./lsicMaterials";

export interface HomeSurfaceData {
  version: 1;
  origin: [number, number];
  step: number;
  width: number;
  depth: number;
  heights: (number | null)[];
  /** 家园布局唯一事实源；均为游戏米制世界坐标。 */
  spawn?: [number, number, number];
  anchors?: Record<string, unknown>;
  dock: { pos: [number, number, number]; rotY: number };
  obstacles: { x: number; z: number; width: number; depth: number; height: number }[];
  buildZones: { x: number; z: number; radius: number }[];
}

export interface HomeSurface {
  data: HomeSurfaceData;
  heightAt(x: number, z: number): number | null;
  canWalkAt(x: number, z: number): boolean;
  canBuildAt(x: number, z: number): boolean;
}

export interface ObstacleColliderSpec {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

/** 将导出障碍直接映射为以地表为底的 Havok 盒体。 */
export function obstacleColliderSpec(
  obstacle: HomeSurfaceData["obstacles"][number], groundY: number,
): ObstacleColliderSpec {
  return {
    x: obstacle.x,
    y: groundY + obstacle.height / 2,
    z: obstacle.z,
    width: obstacle.width,
    height: obstacle.height,
    depth: obstacle.depth,
  };
}

export interface HomeRecoveryPoint {
  x: number;
  y: number;
  z: number;
  moved: boolean;
}

export function needsHomeLsicV1Migration(flags: Record<string, boolean> | undefined): boolean {
  return !flags?.homeLsicV1;
}

/** 首版家园泊位中心在 (26, -20)；半径只覆盖该泊位，不会重定位远征岛云舟。 */
export function isLegacyHomeDockedShip(pos: readonly [number, number, number], docked: boolean): boolean {
  return docked && Math.hypot(pos[0] - 26, pos[2] + 20) <= 14;
}

const LEGACY_HOME_RADIUS = 58;
const legacyNoise = makeNoise2D(20261101);
const legacyNoise2 = makeNoise2D(20261101 * 7 + 13);

/** 首版程序化家园的高度公式，只供将既有存档贴合 LSIC 地表。 */
export function legacyHomeHeightAt(x: number, z: number): number | null {
  const d = Math.hypot(x, z);
  if (d > LEGACY_HOME_RADIUS + 0.5) return null;
  const dc = Math.min(d, LEGACY_HOME_RADIUS);
  const rp = LEGACY_HOME_RADIUS * 0.55;
  let h = dc <= rp
    ? 7.5 * (0.92 + 0.08 * (1 - dc / rp))
    : 7.5 * 0.92 * Math.pow(Math.max(1 - (dc - rp) / (LEGACY_HOME_RADIUS - rp), 0), 1.35);
  const n = legacyNoise(x * 0.045, z * 0.045) * 0.6 + legacyNoise2(x * 0.11, z * 0.11) * 0.4;
  h += n * 7.5 * 0.10 * Math.min(1, dc / (LEGACY_HOME_RADIUS * 0.35));
  return h;
}

function nearestHomePoint(surface: HomeSurface, x: number, z: number, usable: (x: number, z: number) => boolean): { x: number; z: number } | null {
  if (usable(x, z)) return { x, z };
  let best: { x: number; z: number; distanceSq: number } | null = null;
  for (let iz = 0; iz < surface.data.depth; iz++) for (let ix = 0; ix < surface.data.width; ix++) {
    const candidateX = surface.data.origin[0] + ix * surface.data.step;
    const candidateZ = surface.data.origin[1] + iz * surface.data.step;
    if (!usable(candidateX, candidateZ)) continue;
    const distanceSq = (candidateX - x) ** 2 + (candidateZ - z) ** 2;
    if (!best || distanceSq < best.distanceSq) best = { x: candidateX, z: candidateZ, distanceSq };
  }
  return best && { x: best.x, z: best.z };
}

/** 无地表或占用位置的旧角色存档，恢复到最近可走网格点。 */
export function recoverHomeWalkPosition(surface: HomeSurface, x: number, z: number): HomeRecoveryPoint | null {
  const target = nearestHomePoint(surface, x, z, surface.canWalkAt);
  if (!target) return null;
  const groundY = surface.heightAt(target.x, target.z);
  if (groundY === null) return null;
  return { x: target.x, y: groundY + 0.6, z: target.z, moved: target.x !== x || target.z !== z };
}

/** 旧建造物按旧地表的离地偏移迁移；碰到新建筑或岛外时寻找最近可建面。 */
export function recoverHomeBuildPosition(surface: HomeSurface, x: number, y: number, z: number): HomeRecoveryPoint | null {
  const target = nearestHomePoint(surface, x, z, surface.canBuildAt);
  if (!target) return null;
  const groundY = surface.heightAt(target.x, target.z);
  if (groundY === null) return null;
  const legacyGroundY = legacyHomeHeightAt(x, z);
  return {
    x: target.x,
    y: groundY + (legacyGroundY === null ? 0.05 : y - legacyGroundY),
    z: target.z,
    moved: target.x !== x || target.z !== z,
  };
}

/** 正常回生优先使用家园出生点；导出异常时退回最近可走格。 */
export function homeRespawnState(surface: HomeSurface): HomeRecoveryPoint & { hunger: number } {
  const [x, , z] = surface.data.spawn ?? [8, 0, 10];
  const groundY = surface.heightAt(x, z);
  if (groundY !== null && surface.canWalkAt(x, z)) return { x, y: groundY + 0.6, z, moved: false, hunger: 40 };
  const fallback = recoverHomeWalkPosition(surface, x, z);
  if (!fallback) throw new Error("LSIC home has no valid respawn point");
  return { ...fallback, hunger: 40 };
}

export function createHomeSurface(data: HomeSurfaceData): HomeSurface {
  if (data.version !== 1 || data.step <= 0 || data.width < 2 || data.depth < 2 || data.heights.length !== data.width * data.depth) {
    throw new Error("invalid LSIC home surface");
  }
  const at = (x: number, z: number) => data.heights[z * data.width + x];
  const heightAt = (x: number, z: number): number | null => {
    const gx = (x - data.origin[0]) / data.step;
    const gz = (z - data.origin[1]) / data.step;
    if (gx < 0 || gz < 0 || gx > data.width - 1 || gz > data.depth - 1) return null;
    const x0 = Math.min(data.width - 2, Math.floor(gx));
    const z0 = Math.min(data.depth - 2, Math.floor(gz));
    const fx = Math.min(1, gx - x0), fz = Math.min(1, gz - z0);
    const h00 = at(x0, z0), h10 = at(x0 + 1, z0), h01 = at(x0, z0 + 1), h11 = at(x0 + 1, z0 + 1);
    if (h00 === null || h10 === null || h01 === null || h11 === null) return null;
    return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
  };
  const obstacleAt = (x: number, z: number) => data.obstacles.some((o) => Math.abs(x - o.x) <= o.width / 2 && Math.abs(z - o.z) <= o.depth / 2);
  const buildZoneAt = (x: number, z: number) => data.buildZones.some((zone) => Math.hypot(x - zone.x, z - zone.z) <= zone.radius);
  const slopeAt = (x: number, z: number) => {
    const d = Math.min(data.step * 0.45, 0.45);
    const a = heightAt(x - d, z), b = heightAt(x + d, z), c = heightAt(x, z - d), e = heightAt(x, z + d);
    if (a === null || b === null || c === null || e === null) return Infinity;
    return Math.hypot((b - a) / (2 * d), (e - c) / (2 * d));
  };
  return {
    data,
    heightAt,
    canWalkAt: (x, z) => heightAt(x, z) !== null && !obstacleAt(x, z) && slopeAt(x, z) <= 0.8,
    canBuildAt: (x, z) => heightAt(x, z) !== null && buildZoneAt(x, z) && !obstacleAt(x, z) && slopeAt(x, z) <= 0.55,
  };
}

/** 加载已预转换到游戏坐标的 LSIC 家园，并以高度表生成静态 Havok 地表块。 */
export interface LsicHomeIsland extends Island {
  surface: HomeSurface;
  dock: { pos: Vector3; rotY: number };
  anchors: Record<string, unknown>;
}

export async function createLsicHome(scene: Scene, shadowAdd: (mesh: Mesh) => void): Promise<LsicHomeIsland> {
  // v3 独立资源目录让原 LSIC 岛和既有存档保持可回退；surface 是碰撞、
  // 可走性、建筑锚点与可视地形的共同米制事实源。
  const response = await fetch("/assets/lsic/home-visual-v3/surface.json");
  if (!response.ok) throw new Error(`LSIC height surface unavailable (${response.status})`);
  const surface = createHomeSurface(await response.json() as HomeSurfaceData);
  const root = new TransformNode("island_home", scene);
  const visuals = makeVisualHomeMeshes(scene, root, surface.data);
  for (const mesh of visuals) shadowAdd(mesh);

  const colliders = [
    ...makeSurfaceColliders(scene, root, surface.data),
    ...makeObstacleColliders(scene, root, surface),
  ];
  const maxRadius = surface.data.heights.reduce<number>((r, h, i) => {
    if (h === null) return r;
    const x = surface.data.origin[0] + (i % surface.data.width) * surface.data.step;
    const z = surface.data.origin[1] + Math.floor(i / surface.data.width) * surface.data.step;
    return Math.max(r, Math.hypot(x, z));
  }, 0);
  const def: IslandDef = {
    id: "home", name: "栖云屿", center: [0, 0], radius: maxRadius, height: surface.heightAt(0, 0) ?? 7.5,
    depth: 34, seed: 20261101, kind: "home", intro: "你的家园空岛。小屋、农田与泊位从这里开始。",
  };
  return {
    def, root, top: visuals[0],
    surface,
    dock: { pos: new Vector3(...surface.data.dock.pos), rotY: surface.data.dock.rotY },
    anchors: surface.data.anchors ?? {},
    heightAt: surface.heightAt,
    canWalkAt: surface.canWalkAt,
    canBuildAt: surface.canBuildAt,
    dispose() {
      for (const { mesh, body } of colliders) { body.dispose(); mesh.dispose(); }
      for (const mesh of visuals) mesh.dispose();
      root.dispose();
    },
  };
}

/**
 * 与一米采样表共用顶点的可视岛体。物理仍由分块网格负责，避免把 300m 岛
 * 变成一个昂贵的 Havok 三角形形状；岛侧向内收束，保留浮空岛轮廓。
 */
export function makeVisualHomeMeshes(scene: Scene, root: TransformNode, data: HomeSurfaceData): Mesh[] {
  const at = (x: number, z: number) => data.heights[z * data.width + x];
  const topPositions: number[] = [];
  const topIndices: number[] = [];
  const vertexAt = new Map<number, number>();
  const addTopVertex = (x: number, z: number, y: number) => {
    const key = z * data.width + x;
    const hit = vertexAt.get(key);
    if (hit !== undefined) return hit;
    const index = topPositions.length / 3;
    topPositions.push(data.origin[0] + x * data.step, y, data.origin[1] + z * data.step);
    vertexAt.set(key, index);
    return index;
  };
  const sidePositions: number[] = [];
  const sideIndices: number[] = [];
  const bottomPositions: number[] = [];
  const bottomIndices: number[] = [];
  const addQuad = (positions: number[], indices: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) => {
    const i = positions.length / 3;
    positions.push(...a, ...b, ...c, ...d);
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    const nx = aby * acz - abz * acy;
    const nz = abx * acy - aby * acx;
    const mx = (a[0] + b[0] + c[0] + d[0]) / 4, mz = (a[2] + b[2] + c[2] + d[2]) / 4;
    if (nx * mx + nz * mz >= 0) indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    else indices.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
  };
  const addSide = (a: [number, number, number], b: [number, number, number]) => {
    const middleA: [number, number, number] = [a[0] * 0.66, -27, a[2] * 0.66];
    const middleB: [number, number, number] = [b[0] * 0.66, -27, b[2] * 0.66];
    const lowA: [number, number, number] = [a[0] * 0.32, -66, a[2] * 0.32];
    const lowB: [number, number, number] = [b[0] * 0.32, -66, b[2] * 0.32];
    addQuad(sidePositions, sideIndices, a, b, middleA, middleB);
    addQuad(sidePositions, sideIndices, middleA, middleB, lowA, lowB);
    const i = bottomPositions.length / 3;
    bottomPositions.push(...lowA, ...lowB, 0, -72, 0);
    bottomIndices.push(i, i + 2, i + 1);
  };
  const p = (x: number, z: number, y: number): [number, number, number] => [
    data.origin[0] + x * data.step, y, data.origin[1] + z * data.step,
  ];

  for (let z = 0; z < data.depth - 1; z++) for (let x = 0; x < data.width - 1; x++) {
    const a = at(x, z), b = at(x + 1, z), c = at(x, z + 1), d = at(x + 1, z + 1);
    if (a === null || b === null || c === null || d === null) continue;
    const ia = addTopVertex(x, z, a), ib = addTopVertex(x + 1, z, b);
    const ic = addTopVertex(x, z + 1, c), id = addTopVertex(x + 1, z + 1, d);
    topIndices.push(ia, ib, ic, ib, id, ic);
    if (z === 0 || at(x, z - 1) === null || at(x + 1, z - 1) === null) addSide(p(x, z, a), p(x + 1, z, b));
    if (x === data.width - 2 || at(x + 2, z) === null || at(x + 2, z + 1) === null) addSide(p(x + 1, z, b), p(x + 1, z + 1, d));
    if (z === data.depth - 2 || at(x, z + 2) === null || at(x + 1, z + 2) === null) addSide(p(x + 1, z + 1, d), p(x, z + 1, c));
    if (x === 0 || at(x - 1, z) === null || at(x - 1, z + 1) === null) addSide(p(x, z + 1, c), p(x, z, a));
  }
  const make = (name: string, positions: number[], indices: number[], style: "grass" | "cliff") => {
    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    VertexData.ComputeNormals(positions, indices, vertexData.normals = []);
    vertexData.applyToMesh(mesh);
    mesh.parent = root;
    mesh.isPickable = false;
    mesh.material = homeTerrainMaterial(scene, style);
    return mesh;
  };
  const top = make("homeVisualV3_top", topPositions, topIndices, "grass");
  const side = make("homeVisualV3_skirt", sidePositions, sideIndices, "cliff");
  const bottom = make("homeVisualV3_bottom", bottomPositions, bottomIndices, "cliff");
  side.material!.backFaceCulling = false;
  bottom.material!.backFaceCulling = false;
  return [top, side, bottom];
}

export function makeSurfaceColliders(scene: Scene, root: TransformNode, data: HomeSurfaceData): { mesh: Mesh; body: PhysicsAggregate }[] {
  const tile = 32;
  const out: { mesh: Mesh; body: PhysicsAggregate }[] = [];
  const h = (x: number, z: number) => data.heights[z * data.width + x];
  for (let z0 = 0; z0 < data.depth - 1; z0 += tile) for (let x0 = 0; x0 < data.width - 1; x0 += tile) {
    const positions: number[] = [], indices: number[] = [];
    const vert = (x: number, z: number, y: number) => {
      positions.push(data.origin[0] + x * data.step, y, data.origin[1] + z * data.step);
      return positions.length / 3 - 1;
    };
    for (let z = z0; z < Math.min(z0 + tile, data.depth - 1); z++) for (let x = x0; x < Math.min(x0 + tile, data.width - 1); x++) {
      const a = h(x, z), b = h(x + 1, z), c = h(x, z + 1), d = h(x + 1, z + 1);
      if (a === null || b === null || c === null || d === null) continue;
      const ia = vert(x, z, a), ib = vert(x + 1, z, b), ic = vert(x, z + 1, c), id = vert(x + 1, z + 1, d);
      indices.push(ia, ib, ic, ib, id, ic);
    }
    if (!indices.length) continue;
    const mesh = new Mesh(`islandTop_home_tile_${x0}_${z0}`, scene);
    const dataMesh = new VertexData();
    dataMesh.positions = positions;
    dataMesh.indices = indices;
    VertexData.ComputeNormals(positions, indices, dataMesh.normals = []);
    dataMesh.applyToMesh(mesh);
    mesh.parent = root;
    mesh.isVisible = false;
    mesh.isPickable = true;
    const body = new PhysicsAggregate(mesh, PhysicsShapeType.MESH, { mass: 0, friction: 0.8, restitution: 0 }, scene);
    body.body.setMotionType(PhysicsMotionType.STATIC);
    out.push({ mesh, body });
  }
  if (!out.length) throw new Error("LSIC height surface contains no collision triangles");
  return out;
}

export function makeObstacleColliders(scene: Scene, root: TransformNode, surface: HomeSurface): { mesh: Mesh; body: PhysicsAggregate }[] {
  return surface.data.obstacles.map((obstacle, index) => {
    const groundY = surface.heightAt(obstacle.x, obstacle.z);
    if (groundY === null) throw new Error(`LSIC obstacle ${index} is outside its height surface`);
    const spec = obstacleColliderSpec(obstacle, groundY);
    const mesh = MeshBuilder.CreateBox(`lsicObstacle_${index}`, {
      width: spec.width, height: spec.height, depth: spec.depth,
    }, scene);
    mesh.position.set(spec.x, spec.y, spec.z);
    mesh.parent = root;
    mesh.isVisible = false;
    mesh.isPickable = false;
    const body = new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 0, friction: 0.8, restitution: 0 }, scene);
    body.body.setMotionType(PhysicsMotionType.STATIC);
    return { mesh, body };
  });
}
