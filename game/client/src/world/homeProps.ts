// v3 家园生活场景：体块建筑承担可读空间，CC0 模型以薄实例补足植被与小物。
import { Color3, Mesh, MeshBuilder, MultiMaterial, PBRMaterial, PhysicsAggregate, PhysicsMotionType, PhysicsShapeType, Scene, StandardMaterial, TransformNode, Vector3, VertexData } from "@babylonjs/core";
import { baseOffset, loadEnvModel, scatterThin, texMaterial, type Spot } from "../assets/envModels";
import type { LsicHomeIsland } from "./lsicHome";

type AnchorName = "spawn" | "playerHouse" | "yanHouse" | "lingHouse" | "workshop" | "plaza" | "farm" | "ruin" | "viewpoint" | "dock";
const fallbackAnchors: Record<AnchorName, [number, number, number]> = {
  spawn: [-53, 34, 48], playerHouse: [-55, 35, 61], yanHouse: [-5, 34, 51],
  lingHouse: [43, 30, 21], workshop: [-8, 26, 10], plaza: [-17, 28, 26],
  farm: [48, 26, -3], ruin: [-103, 28, 73], viewpoint: [-102, 33, 106], dock: [88, 13, -60],
};

/** 从导出布局读取锚点；旧家园仍保留确定性回退，避免加载失败时崩溃。 */
export function homeAnchor(home: LsicHomeIsland, name: AnchorName): Vector3 {
  const candidate = home.anchors[name];
  if (Array.isArray(candidate) && candidate.length === 3 && candidate.every((n) => typeof n === "number")) {
    return new Vector3(candidate[0] as number, candidate[1] as number, candidate[2] as number);
  }
  return new Vector3(...fallbackAnchors[name]);
}

function makeFlatMaterial(scene: Scene, name: string, color: Color3) {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.specularColor = new Color3(0.025, 0.025, 0.025);
  return mat;
}

function box(root: TransformNode, name: string, size: [number, number, number], pos: [number, number, number], mat: StandardMaterial, rotY = 0, solid = false) {
  const mesh = MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, root.getScene());
  mesh.parent = root;
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.y = rotY;
  mesh.material = mat;
  // 相机遮挡统一走 pickable 网格；没有用整屋碰撞盒，正面入口保持开口。
  mesh.isPickable = true;
  if (solid) {
    const body = new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 0, friction: 0.82, restitution: 0 }, root.getScene());
    body.body.setMotionType(PhysicsMotionType.STATIC);
  }
  return mesh;
}

function lamp(root: TransformNode, name: string, pos: [number, number, number], bronze: StandardMaterial) {
  const glow = MeshBuilder.CreateSphere(`night_lamp_${name}`, { diameter: 0.34, segments: 8 }, root.getScene());
  glow.parent = root;
  glow.position.set(pos[0], pos[1], pos[2]);
  glow.material = bronze;
  glow.metadata = { nightEmitter: true };
  const post = MeshBuilder.CreateCylinder(`${name}_post`, { height: pos[1], diameter: 0.10, tessellation: 8 }, root.getScene());
  post.parent = root;
  post.position.set(pos[0], pos[1] / 2, pos[2]);
  post.material = bronze;
}

function placeInterior(root: TransformNode, asset: string, name: string, pos: [number, number, number], rotY = 0, scale = 1) {
  void (async () => {
    try {
      const model = await loadEnvModel(root.getScene(), asset);
      const mesh = model.mesh.clone(name)!;
      mesh.parent = root;
      mesh.position.set(pos[0], pos[1] - baseOffset(model) * scale, pos[2]);
      mesh.rotation.y = rotY;
      mesh.scaling.setAll(scale);
      mesh.isVisible = true;
      mesh.isPickable = true;
    } catch (error) { console.warn("[homeVisual] interior unavailable", asset, error); }
  })();
}

function gable(root: TransformNode, name: string, wide: number, z: number, mat: StandardMaterial) {
  const mesh = new Mesh(name, root.getScene());
  const positions = [-wide / 2, 4.55, z, wide / 2, 4.55, z, 0, 6.92, z];
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = [0, 1, 2];
  VertexData.ComputeNormals(positions, vertexData.indices, vertexData.normals = []);
  vertexData.applyToMesh(mesh);
  mesh.parent = root; mesh.material = mat; mesh.isPickable = true;
  mat.backFaceCulling = false;
}

function house(scene: Scene, parent: TransformNode, name: string, anchor: Vector3, role: "home" | "maker" | "garden", wood: StandardMaterial, stone: StandardMaterial, canvas: StandardMaterial, bronze: StandardMaterial) {
  const root = new TransformNode(`homeVisual_${name}`, scene);
  root.parent = parent;
  root.position.copyFrom(anchor);
  const wide = role === "maker" ? 12 : 10;
  const plaster = makeFlatMaterial(scene, `${name}_plaster`, new Color3(0.74, 0.69, 0.59));
  const glass = makeFlatMaterial(scene, `${name}_glass`, new Color3(0.12, 0.20, 0.25));
  glass.specularColor = new Color3(0.25, 0.30, 0.32);
  // 三面围合、朝公共区开口：玩家能从门廊步入并始终看见床桌等生活物。
  box(root, `${name}_foundation`, [wide + 1.1, 0.55, 8.8], [0, 0.25, 0], stone, 0, true);
  box(root, `${name}_back`, [wide, 4.6, 0.35], [0, 2.55, 3.85], plaster, 0, true);
  box(root, `${name}_left`, [0.35, 4.2, 7.5], [-wide / 2 + 0.15, 2.35, 0.1], plaster, 0, true);
  box(root, `${name}_right`, [0.35, 4.2, 7.5], [wide / 2 - 0.15, 2.35, 0.1], plaster, 0, true);
  const doorWidth = 1.7, sideWidth = (wide - doorWidth) / 2;
  // 正立面分为左右墙段、门洞上楣和门楣；入口是物理留空的1.7m×2.4m开口。
  for (const side of [-1, 1]) box(root, `${name}_frontWall_${side}`, [sideWidth, 4.2, 0.35], [side * (doorWidth + sideWidth) / 2, 2.35, -3.85], plaster, 0, true);
  box(root, `${name}_frontTransom`, [doorWidth, 1.8, 0.35], [0, 3.7, -3.85], plaster, 0, true);
  box(root, `${name}_doorLintel`, [doorWidth + 0.35, 0.30, 0.44], [0, 4.58, -3.87], wood, 0, true);
  for (const x of [-wide / 2 + 0.45, wide / 2 - 0.45]) box(root, `${name}_post_${x}`, [0.34, 4.8, 0.34], [x, 2.4, -3.7], wood);
  box(root, `${name}_lintel`, [wide + 0.35, 0.30, 0.42], [0, 4.55, -3.7], wood);
  // 门廊的两级低台连接地表与石台基，正立面中部留出完整门洞。
  box(root, `${name}_step_low`, [2.2, 0.18, 1.0], [0, 0.09, -4.65], stone, 0, true);
  box(root, `${name}_step_high`, [1.85, 0.38, 0.9], [0, 0.19, -4.1], stone, 0, true);
  const roofL = box(root, `${name}_roofL`, [wide / 2 + 0.9, 0.34, 9.6], [-wide / 4, 5.7, 0.0], canvas);
  roofL.rotation.z = 0.45;
  const roofR = box(root, `${name}_roofR`, [wide / 2 + 0.9, 0.34, 9.6], [wide / 4, 5.7, 0.0], canvas);
  roofR.rotation.z = -0.45;
  // 深色檐口与端部山墙，令三户远看有清楚的风帆式双坡轮廓。
  box(root, `${name}_eaveL`, [0.28, 0.32, 9.8], [-wide / 2 - 0.18, 4.65, 0], wood);
  box(root, `${name}_eaveR`, [0.28, 0.32, 9.8], [wide / 2 + 0.18, 4.65, 0], wood);
  box(root, `${name}_ridge`, [0.32, 0.32, 9.6], [0, 6.92, 0], wood);
  gable(root, `${name}_gable_front`, wide, -3.86, plaster);
  gable(root, `${name}_gable_back`, wide, 3.86, plaster);
  const window = MeshBuilder.CreatePlane(`night_window_${name}`, { width: 1.30, height: 1.05 }, scene);
  window.parent = root;
  window.position.set(role === "garden" ? -2.6 : 2.6, 2.85, -4.04);
  window.material = glass;
  window.material.backFaceCulling = false;
  window.metadata = { nightEmitter: true };
  const windowX = role === "garden" ? -2.6 : 2.6;
  for (const [i, x, y, sx, sy] of [["top", windowX, 3.40, 1.55, 0.10], ["bottom", windowX, 2.30, 1.55, 0.10], ["left", windowX - 0.73, 2.85, 0.10, 1.20], ["right", windowX + 0.73, 2.85, 0.10, 1.20], ["midV", windowX, 2.85, 0.08, 1.10], ["midH", windowX, 2.85, 1.40, 0.08]] as const) {
    box(root, `${name}_windowFrame_${i}`, [sx, sy, 0.12], [x, y, -4.11], wood);
  }
  // 门廊小雨棚、立柱与可读入口。门板为视觉件，碰撞仍留洞。
  box(root, `${name}_porchAwning`, [3.8, 0.24, 1.45], [0, 4.18, -4.62], canvas);
  for (const x of [-1.55, 1.55]) box(root, `${name}_porchPost_${x}`, [0.22, 3.5, 0.22], [x, 1.75, -4.88], wood);
  const door = MeshBuilder.CreatePlane(`${name}_door`, { width: 1.38, height: 2.28 }, scene);
  door.parent = root; door.position.set(0, 1.29, -4.06); door.material = wood; door.isPickable = true;
  // 可见且可走入的室内陈设；职业区分只在物件，不破坏共同建筑语汇。
  box(root, `${name}_table`, [2.4, 0.7, 1.25], [-1.8, 0.9, 1.1], wood);
  box(root, `${name}_seat`, [1.0, 0.42, 0.9], [-1.8, 0.55, -0.7], wood);
  if (role === "home") {
    box(root, `${name}_bed`, [2.3, 0.8, 3.0], [2.6, 0.9, 1.7], canvas);
    box(root, `${name}_chest`, [1.4, 1.0, 0.9], [3.3, 0.85, -1.4], wood);
    placeInterior(root, "interior/Bed_Single", `${name}_cc0Bed`, [2.6, 0.56, 1.7], Math.PI / 2, 1.2);
    placeInterior(root, "interior/Table_RoundSmall", `${name}_cc0Table`, [-1.8, 0.52, 1.1], 0.2, 1.05);
    placeInterior(root, "interior/Chair_1", `${name}_cc0Chair`, [-1.8, 0.40, -0.7], Math.PI, 1.0);
  } else if (role === "maker") {
    box(root, `${name}_bench`, [4.0, 1.2, 1.3], [1.5, 1.0, 1.4], wood);
    box(root, `${name}_toolRack`, [3.4, 1.4, 0.30], [1.4, 2.2, 3.56], bronze);
    placeInterior(root, "village/Crate", `${name}_cc0Crate`, [3.8, 0.42, -0.7], 0.6, 0.9);
    placeInterior(root, "village/Barrel", `${name}_cc0Barrel`, [-3.5, 0.35, 1.9], 0, 0.9);
  } else {
    box(root, `${name}_pottingTable`, [3.4, 1.0, 1.4], [1.6, 0.95, 1.3], wood);
    box(root, `${name}_planter`, [2.5, 0.7, 1.1], [-2.5, 0.75, 1.9], stone);
    placeInterior(root, "interior/Houseplant_2", `${name}_cc0Plant`, [-2.5, 0.55, 1.9], 0, 1.25);
    placeInterior(root, "interior/Table_RoundSmall", `${name}_cc0Potting`, [1.6, 0.48, 1.3], 0, 1.05);
  }
  lamp(root, `${name}_porch`, [wide / 2 - 0.7, 3.8, -3.75], bronze);
  return root;
}

function createWorkshop(scene: Scene, parent: TransformNode, anchor: Vector3, wood: StandardMaterial, stone: StandardMaterial, canvas: StandardMaterial, bronze: StandardMaterial) {
  const root = new TransformNode("homeVisual_workshop", scene);
  root.parent = parent; root.position.copyFrom(anchor);
  box(root, "workshop_base", [15, 0.6, 11], [0, 0.3, 0], stone, 0, true);
  for (const x of [-6.5, 6.5]) for (const z of [-4.4, 4.4]) box(root, `workshop_post_${x}_${z}`, [0.42, 5.2, 0.42], [x, 2.6, z], wood);
  box(root, "workshop_back", [13.5, 4.8, 0.38], [0, 2.5, 4.5], wood, 0, true);
  const canopy = box(root, "workshop_canopy", [15.5, 0.38, 11.8], [0, 5.0, 0], canvas); canopy.rotation.z = 0.06;
  box(root, "workshop_workbench", [5.6, 1.15, 1.6], [-2.4, 1.0, 1.6], wood);
  box(root, "workshop_forge", [2.4, 1.5, 2.3], [4.0, 1.05, 1.6], stone);
  const forgeGlow = MeshBuilder.CreateDisc("buildGlow_workshop_forge", { radius: 0.72, tessellation: 12 }, scene);
  forgeGlow.parent = root; forgeGlow.position.set(4.0, 1.82, 1.6); forgeGlow.rotation.x = Math.PI / 2;
  forgeGlow.material = bronze; forgeGlow.metadata = { nightEmitter: true };
  lamp(root, "workshop", [-5.2, 3.7, -4.3], bronze);
}

function paveRoute(parent: TransformNode, home: LsicHomeIsland, name: string, from: Vector3, to: Vector3, stone: StandardMaterial) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(distance / 4.5));
  const rotY = Math.atan2(dx, dz);
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps, mid = (t0 + t1) / 2;
    const x0 = from.x + dx * t0, z0 = from.z + dz * t0;
    const x1 = from.x + dx * t1, z1 = from.z + dz * t1;
    const h0 = home.heightAt(x0, z0), h1 = home.heightAt(x1, z1);
    if (h0 === null || h1 === null) continue;
    const length = distance / steps + 0.12;
    const slab = box(parent, `path_${name}_${i}`, [2.35, 0.16, length], [from.x + dx * mid, (h0 + h1) / 2 + 0.07, from.z + dz * mid], stone, rotY);
    slab.rotation.x = Math.atan2(h0 - h1, distance / steps);
  }
}

function createSettlementPaths(parent: TransformNode, home: LsicHomeIsland, stone: StandardMaterial, wood: StandardMaterial) {
  const player = homeAnchor(home, "playerHouse"), yan = homeAnchor(home, "yanHouse"), ling = homeAnchor(home, "lingHouse");
  const plaza = homeAnchor(home, "plaza"), workshop = homeAnchor(home, "workshop"), farm = homeAnchor(home, "farm"), dock = homeAnchor(home, "dock");
  paveRoute(parent, home, "player_plaza", player.add(new Vector3(0, 0, -5)), plaza, stone);
  paveRoute(parent, home, "yan_plaza", yan.add(new Vector3(0, 0, -5)), plaza, stone);
  paveRoute(parent, home, "ling_workshop", ling.add(new Vector3(0, 0, -5)), workshop, stone);
  paveRoute(parent, home, "plaza_workshop", plaza, workshop, stone);
  paveRoute(parent, home, "workshop_farm", workshop, farm, stone);
  paveRoute(parent, home, "workshop_dock", workshop, dock, stone);
  // 两段短挡墙把生活核心从林缘和坡面中“收”出来，院界也作为近景节奏。
  for (const [name, a, b] of [["player", player, plaza], ["yan", yan, plaza], ["ling", ling, workshop]] as const) {
    const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2, h = home.heightAt(x, z);
    if (h === null) continue;
    const wall = box(parent, `retaining_${name}`, [6.5, 0.75, 0.42], [x, h + 0.36, z + 3.0], stone, Math.atan2(b.x - a.x, b.z - a.z));
    wall.isPickable = true;
    for (const dx of [-2.6, 2.6]) box(parent, `yard_post_${name}_${dx}`, [0.18, 1.35, 0.18], [x + dx, h + 0.68, z + 3.0], wood);
  }
}

function createPublicAndDock(scene: Scene, parent: TransformNode, home: LsicHomeIsland, wood: StandardMaterial, stone: StandardMaterial, canvas: StandardMaterial, bronze: StandardMaterial) {
  const plaza = homeAnchor(home, "plaza");
  const plazaRoot = new TransformNode("homeVisual_plaza", scene); plazaRoot.parent = parent; plazaRoot.position.copyFrom(plaza);
  const ring = MeshBuilder.CreateDisc("homeVisual_plaza_stone", { radius: 8.2, tessellation: 24 }, scene);
  ring.parent = plazaRoot; ring.position.y = 0.08; ring.rotation.x = Math.PI / 2; ring.material = stone;
  box(plazaRoot, "plaza_table", [4.2, 0.8, 2.0], [0, 0.75, 0.5], wood);
  for (const x of [-2.9, 2.9]) box(plazaRoot, `plaza_bench_${x}`, [1.3, 0.55, 3.2], [x, 0.5, 0.5], wood);
  lamp(plazaRoot, "plaza", [-5.7, 3.3, -4.8], bronze);
  const dock = homeAnchor(home, "dock");
  const dockRoot = new TransformNode("homeVisual_harbour", scene); dockRoot.parent = parent; dockRoot.position.copyFrom(dock);
  box(dockRoot, "harbour_pier", [26, 0.65, 5.2], [0, 0.28, 0], wood, 0.84);
  for (const x of [-10, -4, 3, 10]) box(dockRoot, `harbour_piling_${x}`, [0.38, 5.5, 0.38], [x, -2.3, 0], wood, 0.84);
  box(dockRoot, "harbour_sailRack", [4.8, 2.6, 0.45], [-6, 1.6, 2.2], canvas, 0.84);
  lamp(dockRoot, "harbour", [8, 3.4, -1.8], bronze);
}

function createFarmAndRuin(scene: Scene, parent: TransformNode, home: LsicHomeIsland, wood: StandardMaterial, stone: StandardMaterial, leaf: StandardMaterial, bronze: StandardMaterial) {
  const farm = homeAnchor(home, "farm");
  const root = new TransformNode("homeVisual_farm", scene); root.parent = parent; root.position.copyFrom(farm);
  for (let row = -3; row <= 3; row++) {
    box(root, `farm_bed_${row}`, [12, 0.32, 1.05], [0, 0.16, row * 1.55], wood);
    for (let x = -5; x <= 5; x += 2) box(root, `farm_crop_${row}_${x}`, [0.36, 0.85 + ((x + row + 8) % 3) * 0.18, 0.45], [x, 0.65, row * 1.55], leaf);
  }
  box(root, "farm_gate", [0.30, 2.0, 4.0], [-7.2, 1.0, 0], wood);
  const ruin = homeAnchor(home, "ruin");
  const ruinRoot = new TransformNode("homeVisual_ruin", scene); ruinRoot.parent = parent; ruinRoot.position.copyFrom(ruin);
  for (const [x, z, h] of [[-4, -3, 5], [4, -3, 3.2], [-4, 3, 2.5], [4, 3, 4.3]] as const) box(ruinRoot, `ruin_column_${x}_${z}`, [1.25, h, 1.25], [x, h / 2, z], stone);
  const beacon = MeshBuilder.CreateSphere("night_lamp_ruin_beacon", { diameter: 0.85, segments: 10 }, scene);
  beacon.parent = ruinRoot; beacon.position.set(0, 2.4, 0); beacon.material = bronze; beacon.metadata = { nightEmitter: true };
}

function createRidgeOutcrops(scene: Scene, parent: TransformNode, home: LsicHomeIsland, stone: StandardMaterial) {
  // 高脊以不规则裸岩群打断草毯，大小从近处前景石到远处断崖有层级。
  const sites: [number, number, number, number, number][] = [
    [-105, 101, 8.5, 3.8, 6.2], [-94, 108, 6.0, 5.0, 4.4], [-116, 88, 5.8, 3.2, 5.1],
    [-84, 96, 4.4, 2.6, 3.6], [-125, 74, 6.8, 3.0, 4.2], [-109, 118, 3.6, 2.0, 3.0],
    [-74, 105, 3.0, 1.8, 2.6], [-132, 96, 4.0, 2.2, 3.8],
  ];
  for (const [x, z, sx, sy, sz] of sites) {
    const h = home.heightAt(x, z);
    if (h === null) continue;
    const rock = MeshBuilder.CreateIcoSphere(`ridgeRock_${x}_${z}`, { radius: 1.0, subdivisions: 2 }, scene);
    rock.parent = parent; rock.position.set(x, h + sy * 0.46, z);
    rock.scaling.set(sx, sy, sz); rock.rotation.set((x % 7) * 0.08, (z % 11) * 0.16, (x % 5) * 0.06);
    rock.material = stone; rock.isPickable = true;
  }
}

function makeVegetation(scene: Scene, parent: TransformNode, home: LsicHomeIsland) {
  const byAsset = new Map<string, Spot[]>();
  const reserve = ["playerHouse", "yanHouse", "lingHouse", "workshop", "plaza", "farm", "dock"].map((name) => homeAnchor(home, name as AnchorName));
  const add = (asset: string, x: number, z: number, scale: number, rotY: number) => {
    if (reserve.some((a) => Math.hypot(a.x - x, a.z - z) < (asset.includes("Grass") ? 9 : 19))) return;
    const y = home.heightAt(x, z);
    if (y === null || home.canWalkAt?.(x, z) === false) return;
    const list = byAsset.get(asset) ?? [];
    list.push({ x, y, z, scale, rotY }); byAsset.set(asset, list);
  };
  // 固定种子式分布：外围较密、核心留白、远眺北缘有竖向轮廓。
  for (let i = 0; i < 88; i++) {
    const angle = i * 2.39996;
    const radius = 72 + (i % 7) * 9 + (i % 3) * 4;
    add(i % 4 === 0 ? "nature/PineTree_2" : "nature/CommonTree_2", Math.cos(angle) * radius - 7, Math.sin(angle) * radius + 8, 8.5 + (i % 4) * 1.4, angle);
  }
  for (let i = 0; i < 150; i++) {
    const angle = i * 1.618;
    const radius = 34 + (i % 9) * 8;
    add(i % 3 === 0 ? "nature/BushBerries_1" : "nature/Bush_2", Math.cos(angle) * radius + 12, Math.sin(angle) * radius + 4, 1.05 + (i % 4) * 0.12, angle * 0.5);
  }
  for (let i = 0; i < 240; i++) {
    const angle = i * 0.77;
    const radius = 25 + (i % 14) * 7;
    add(i % 5 === 0 ? "nature/Flowers" : "nature/Grass_2", Math.cos(angle) * radius - 15, Math.sin(angle) * radius + 10, 1.05 + (i % 3) * 0.15, angle);
  }
  for (const [asset, spots] of byAsset) void (async () => {
    try {
      const model = await loadEnvModel(scene, asset);
      const clone = model.mesh.clone(`${model.mesh.name}_home_v3`)!;
      clone.isPickable = false;
      // 环境母版也服务于远岛，不能改缓存材质。只给本家园的实例母版复制并校准 PBR：
      // 原资源的 metallic 反射会把深绿叶片压成青灰色。
      const copied = clone.material instanceof MultiMaterial
        ? clone.material.clone(`${clone.name}_material`, true)
        : clone.material?.clone(`${clone.name}_material`);
      if (copied) {
        clone.material = copied;
        const materials = copied instanceof MultiMaterial ? copied.subMaterials : [copied];
        for (const mat of materials) if (mat instanceof PBRMaterial) {
          mat.metallic = 0;
          mat.roughness = 0.9;
          mat.environmentIntensity = 0.32;
          if (/green|leaf|foliage/i.test(mat.name)) mat.albedoColor = Color3.Lerp(mat.albedoColor, new Color3(0.30, 0.68, 0.22), 0.42);
        }
      }
      const treeHeight = asset.includes("Tree") ? Math.max(model.size.y, 0.1) : 1;
      const fitted = spots.map((spot) => {
        const scale = asset.includes("Tree") ? spot.scale / treeHeight : spot.scale;
        return { ...spot, scale, y: spot.y - baseOffset(model) * scale };
      });
      scatterThin(clone, fitted, parent);
    } catch (error) { console.warn("[homeVisual] vegetation unavailable", asset, error); }
  })();
}

/** 岛上视觉只装一次；纯装饰不占用建造/物理，建筑入口保持可步入。 */
export function decorateHome(scene: Scene, home: LsicHomeIsland, _dockPos: Vector3): void {
  if (scene.getTransformNodeByName("homePropsRoot")) return;
  const root = new TransformNode("homePropsRoot", scene); root.parent = home.root;
  const wood = texMaterial(scene, "medieval_wood", { u: 0.28, v: 0.28, specular: 0.035 });
  const stone = texMaterial(scene, "old_stone_wall_02", { u: 0.35, v: 0.35, specular: 0.025 });
  const canvas = makeFlatMaterial(scene, "homeVisual_canvas", new Color3(0.75, 0.66, 0.49));
  const bronze = makeFlatMaterial(scene, "homeVisual_bronze", new Color3(0.55, 0.34, 0.15));
  const leaf = makeFlatMaterial(scene, "homeVisual_leaf", new Color3(0.18, 0.44, 0.28));
  house(scene, root, "playerHouse", homeAnchor(home, "playerHouse"), "home", wood, stone, canvas, bronze);
  house(scene, root, "yanHouse", homeAnchor(home, "yanHouse"), "maker", wood, stone, canvas, bronze);
  house(scene, root, "lingHouse", homeAnchor(home, "lingHouse"), "garden", wood, stone, canvas, bronze);
  createWorkshop(scene, root, homeAnchor(home, "workshop"), wood, stone, canvas, bronze);
  createSettlementPaths(root, home, stone, wood);
  createPublicAndDock(scene, root, home, wood, stone, canvas, bronze);
  createFarmAndRuin(scene, root, home, wood, stone, leaf, bronze);
  createRidgeOutcrops(scene, root, home, stone);
  makeVegetation(scene, root, home);
}

/** 泊位旗标保留旧互动入口的可见指示。 */
export function addBerthFlag(scene: Scene, dockPos: Vector3, heightAt: (x: number, z: number) => number | null): Mesh {
  const h = heightAt(dockPos.x + 4.2, dockPos.z + 3.4) ?? dockPos.y;
  const root = new TransformNode("berthFlag", scene);
  root.position.set(dockPos.x + 4.2, h, dockPos.z + 3.4);
  const pole = MeshBuilder.CreateCylinder("berthFlagPole", { height: 4.2, diameter: 0.09 }, scene);
  pole.parent = root; pole.position.y = 2.1; pole.material = makeFlatMaterial(scene, "berthFlagPoleMat", new Color3(0.31, 0.22, 0.13));
  const flag = MeshBuilder.CreatePlane("berthFlag", { width: 1.25, height: 0.82 }, scene);
  flag.parent = root; flag.position.set(0.66, 3.55, 0); flag.material = makeFlatMaterial(scene, "berthFlagMat", new Color3(0.18, 0.56, 0.72));
  return pole;
}
