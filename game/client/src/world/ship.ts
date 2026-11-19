// 云舟：曲面船体 + 平坦甲板 + 舷侧翼帆（舵位视野无遮挡）。运动学物理体；玩家站立随动。
// 造型方向见 docs/planning-artifacts/visual-targets/20261101-v01/05-skyship-views.png。
import {
  Scene, Vector3, Color3, Mesh, MeshBuilder, StandardMaterial, TransformNode,
  PhysicsAggregate, PhysicsShapeType, PhysicsMotionType, Quaternion, VertexData, PointLight,
} from "@babylonjs/core";
import { Input } from "../core/input";
import type { Island } from "./island";
import type { Player } from "./player";
import { loadEnvModel, placeClone, texMaterial, cylindricalUVs, planarUVs } from "../assets/envModels";

export type ShipState = "docked" | "sailing";

export interface DockTarget {
  islandId: string;
  name: string;
  pos: Vector3;
  rotY: number;
}

/** 船体放样参数（局部坐标，船首 -z、船尾 +z，总长 16.8m） */
const HULL_LEN = 16.8;
const DECK_Y = 0.38;          // 平坦甲板高度（碰撞盒顶面与之对齐）
// 半宽剖面：船首收尖、舯部最宽、船尾保持横梁宽度（transom）
const HW_KEYS: [number, number][] = [[0, 0.12], [0.08, 1.25], [0.25, 2.35], [0.5, 2.7], [0.75, 2.58], [0.92, 2.2], [1, 2.0]];
const smooth = (k: number) => k * k * (3 - 2 * k);
const halfWidth = (t: number): number => {
  for (let i = 1; i < HW_KEYS.length; i++) {
    if (t <= HW_KEYS[i][0]) {
      const [t0, w0] = HW_KEYS[i - 1], [t1, w1] = HW_KEYS[i];
      return w0 + (w1 - w0) * smooth((t - t0) / (t1 - t0));
    }
  }
  return HW_KEYS[HW_KEYS.length - 1][1];
};
const keelY = (t: number): number => -0.08 - 1.68 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.7);
const bulwarkTop = (t: number): number => DECK_Y + 0.34 + 0.5 * Math.pow(Math.abs(t - 0.45) / 0.55, 1.7);

export class CloudShip {
  root: TransformNode;
  hullBody: PhysicsAggregate;
  state: ShipState = "docked";
  speed = 0;
  heading = 0;
  energy = 100;
  sailUpgraded = false;
  wheelRot = 0;
  private sails: Mesh[] = [];
  private pennant!: Mesh;
  private wheelMesh!: Mesh;
  private windCore!: Mesh;
  private prevPos = new Vector3(0, 0, 0);
  private prevRotY = 0;
  private dockT = 0;
  private dockingTo: DockTarget | null = null;
  onEvent?: (kind: string, data?: unknown) => void;
  maxSpeed = 17;

  constructor(scene: Scene, spawn: { pos: Vector3; rotY: number }, private docks: DockTarget[]) {
    this.root = new TransformNode("ship", scene);
    this.root.position.copyFrom(spawn.pos);
    this.root.rotation.y = spawn.rotY;
    this.heading = spawn.rotY;
    this.prevPos.copyFrom(spawn.pos);
    this.prevRotY = spawn.rotY;
    this.buildMesh(scene);

    // 物理甲板（运动学）：盒子顶面与甲板平齐，玩家脚踏实地站立
    this.hullBody = new PhysicsAggregate(this.hullMesh, PhysicsShapeType.BOX, { mass: 0, friction: 0.9, restitution: 0 }, scene);
    this.hullBody.body.setMotionType(PhysicsMotionType.ANIMATED);
    this.hullBody.body.disablePreStep = false;
  }

  /** 异步布置甲板上的成品道具（木桶、木箱；贴舷边与船首角，避免通行区穿模） */
  async decorateAsync(scene: Scene) {
    try {
      const barrel = await loadEnvModel(scene, "village/Barrel");
      const crate = await loadEnvModel(scene, "village/Crate");
      placeClone(scene, barrel, new Vector3(1.85, DECK_Y, -5.6), 0.4, 0.85);
      placeClone(scene, crate, new Vector3(-1.9, DECK_Y, -5.8), 0.3, 0.9);
      placeClone(scene, crate, new Vector3(-1.85, DECK_Y + 0.72, -5.85), 0.9, 0.72);
      placeClone(scene, barrel, new Vector3(1.9, DECK_Y, 5.4), 1.9, 0.8);
    } catch (e) {
      console.warn("[ship] deck props failed", e);
    }
  }

  private buildMesh(scene: Scene) {
    const woodHull = texMaterial(scene, "medieval_wood", { u: 1, v: 1, specular: 0.05 });
    const woodDeck = texMaterial(scene, "brown_planks_04", { u: 0.28, v: 0.5, specular: 0.04 });
    const woodDark = new StandardMaterial("shipWoodTrim", scene);
    woodDark.diffuseColor = new Color3(0.34, 0.24, 0.16);
    woodDark.specularColor = new Color3(0.04, 0.04, 0.04);
    const bronze = new StandardMaterial("shipBronze", scene);
    bronze.diffuseColor = new Color3(0.72, 0.58, 0.34);
    bronze.specularColor = new Color3(0.5, 0.45, 0.3);
    bronze.specularPower = 48;
    const canvas = new StandardMaterial("shipCanvas", scene);
    canvas.diffuseColor = new Color3(0.96, 0.92, 0.82);
    canvas.specularColor = new Color3(0.05, 0.05, 0.05);
    canvas.backFaceCulling = false;
    const trim = new StandardMaterial("shipTrim", scene);
    trim.diffuseColor = new Color3(0.88, 0.48, 0.3);
    trim.specularColor = new Color3(0.05, 0.05, 0.05);
    trim.backFaceCulling = false;

    // ---- 船体放样（侧板 + 船首尾收口） ----
    const stations = 15;
    const ringSeg = 8;
    const pos: number[] = [];
    const idx: number[] = [];
    const ringCount = stations + 1;
    const ptIndexOf = (st: number, a: number) => st * (ringSeg + 1) + a;
    for (let st = 0; st <= stations; st++) {
      const t = st / stations;
      const z = -HULL_LEN / 2 + HULL_LEN * t;
      const hw = halfWidth(t);
      const ky = keelY(t);
      const bt = bulwarkTop(t);
      for (let a = 0; a <= ringSeg; a++) {
        const ang = (a / ringSeg) * Math.PI; // 0 右舷 -> π/2 龙骨 -> π 左舷
        const x = hw * Math.cos(ang);
        const y = bt - (bt - ky) * Math.sin(ang);
        pos.push(x, y, z);
      }
    }
    for (let st = 0; st < stations; st++) {
      for (let a = 0; a < ringSeg; a++) {
        const p0 = ptIndexOf(st, a), p1 = ptIndexOf(st, a + 1);
        const q0 = ptIndexOf(st + 1, a), q1 = ptIndexOf(st + 1, a + 1);
        idx.push(p0, q0, q1, p0, q1, p1);
      }
    }
    // 船尾封板（transom）
    const sternBase = pos.length / 3;
    for (let a = 0; a <= ringSeg; a++) {
      const i = ptIndexOf(stations, a);
      pos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
    for (let a = 1; a < ringSeg - 1; a++) idx.push(sternBase, sternBase + a, sternBase + a + 1);
    // 船首收点
    const bowIdx = pos.length / 3;
    pos.push(0, keelY(0) + 0.4, -HULL_LEN / 2 - 0.5);
    for (let a = 0; a < ringSeg; a++) {
      const p0 = ptIndexOf(0, a), p1 = ptIndexOf(0, a + 1);
      idx.push(p0, p1, bowIdx);
    }
    const hull = new Mesh("shipHullSide", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    VertexData.ComputeNormals(pos, idx, (vd.normals = []));
    vd.applyToMesh(hull);
    cylindricalUVs(hull, 0.22);
    hull.material = woodHull;
    hull.parent = this.root;
    hull.isPickable = false;

    // ---- 碰撞盒（顶面=甲板高度，名字保持 shipHull 供射线拾取过滤） ----
    const collider = MeshBuilder.CreateBox("shipHull", { width: 5.3, height: 2.2, depth: HULL_LEN - 0.4 }, scene);
    collider.position.y = DECK_Y - 1.1 + 0.02;
    collider.isVisible = false;
    collider.parent = this.root;
    this.hullMesh = collider;

    // ---- 甲板（随船体型线收窄的厚板：顶面=甲板高度，边缘藏在舷墙内侧） ----
    {
      const dst: number[] = [];
      const didx: number[] = [];
      const dStations = 24;
      const dThick = 0.22;
      const rowAt = (st: number, top: boolean, side: number) => {
        const t = st / dStations;
        const z = -HULL_LEN / 2 + 0.55 + (HULL_LEN - 1.1) * t;
        const x = side * (halfWidth(t) - 0.14);
        dst.push(x, top ? DECK_Y : DECK_Y - dThick, z);
      };
      const dIdxOf = (st: number, top: boolean, side: number) =>
        st * 4 + (top ? 0 : 2) + (side > 0 ? 0 : 1);
      for (let st = 0; st <= dStations; st++) {
        rowAt(st, true, 1); rowAt(st, true, -1);
        rowAt(st, false, 1); rowAt(st, false, -1);
      }
      for (let st = 0; st < dStations; st++) {
        for (const top of [true, false]) {
          const l0 = dIdxOf(st, top, -1), r0 = dIdxOf(st, top, 1);
          const l1 = dIdxOf(st + 1, top, -1), r1 = dIdxOf(st + 1, top, 1);
          if (top) didx.push(l0, r0, r1, l0, r1, l1);
          else didx.push(l0, r1, r0, l0, l1, r1);
        }
        // 侧裙
        for (const side of [1, -1]) {
          const t0 = dIdxOf(st, true, side), b0 = dIdxOf(st, false, side);
          const t1 = dIdxOf(st + 1, true, side), b1 = dIdxOf(st + 1, false, side);
          didx.push(t0, b0, b1, t0, b1, t1);
        }
      }
      // 首尾端面
      for (const st of [0, dStations]) {
        const lt = dIdxOf(st, true, -1), rt = dIdxOf(st, true, 1);
        const lb = dIdxOf(st, false, -1), rb = dIdxOf(st, false, 1);
        if (st === 0) didx.push(lt, rb, rt, lt, lb, rb);
        else didx.push(lt, rt, rb, lt, rb, lb);
      }
      const deckMesh = new Mesh("shipDeck", scene);
      const dvd = new VertexData();
      dvd.positions = dst;
      dvd.indices = didx;
      VertexData.ComputeNormals(dst, didx, (dvd.normals = []));
      dvd.applyToMesh(deckMesh);
      planarUVs(deckMesh, 0.4);
      deckMesh.material = woodDeck;
      deckMesh.parent = this.root;
      deckMesh.isPickable = false;
    }

    // 舷缘压条（沿舷墙顶）
    for (const side of [-1, 1]) {
      const pts: Vector3[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const z = -HULL_LEN / 2 + 0.8 + (HULL_LEN - 1.6) * t;
        pts.push(new Vector3(side * (halfWidth(t) - 0.1), bulwarkTop(t) + 0.05, z));
      }
      const rail = MeshBuilder.CreateTube(`shipRailTop${side}`, { path: pts, radius: 0.07, tessellation: 6 }, scene);
      rail.material = woodDark;
      rail.parent = this.root;
      rail.isPickable = false;
    }

    // ---- 船尾舵台（贴地防穿模） + 舵轮 ----
    const helmPodium = MeshBuilder.CreateBox("helmPodium", { width: 2.2, height: 0.12, depth: 1.5 }, scene);
    helmPodium.position.set(0, DECK_Y + 0.06, 6.1);
    helmPodium.material = woodHull;
    helmPodium.parent = this.root;
    helmPodium.isPickable = false;
    const wheel = MeshBuilder.CreateTorus("shipWheel", { diameter: 1.35, thickness: 0.12, tessellation: 16 }, scene);
    wheel.position.set(0, DECK_Y + 1.35, 6.55);
    wheel.rotation.x = 0.28;
    wheel.material = bronze;
    wheel.parent = this.root;
    wheel.isPickable = false;
    for (let i = 0; i < 6; i++) {
      const spoke = MeshBuilder.CreateCylinder(`wheelSpoke${i}`, { height: 1.3, diameter: 0.06, tessellation: 6 }, scene);
      spoke.parent = wheel;
      spoke.rotation.z = (i / 6) * Math.PI;
      spoke.position.y = 0;
      spoke.material = bronze;
      spoke.isPickable = false;
    }
    this.wheelMesh = wheel;
    const wheelPost = MeshBuilder.CreateCylinder("wheelPost", { height: 0.9, diameter: 0.16, tessellation: 8 }, scene);
    wheelPost.position.set(0, DECK_Y + 0.85, 6.55);
    wheelPost.material = woodDark;
    wheelPost.parent = this.root;
    wheelPost.isPickable = false;

    // ---- 船尾舱（生活区；缩尺避免压住舵位，顶不过舷墙太多） ----
    const cabin = MeshBuilder.CreateBox("shipCabin", { width: 2.6, height: 1.55, depth: 2.1 }, scene);
    cabin.position.set(0, DECK_Y + 0.78, 8.05);
    cabin.material = woodHull;
    cabin.parent = this.root;
    cabin.isPickable = false;
    const cabinRoof = MeshBuilder.CreateBox("shipCabinRoof", { width: 3.0, height: 0.14, depth: 2.5 }, scene);
    cabinRoof.position.set(0, DECK_Y + 1.62, 8.05);
    cabinRoof.material = woodDark;
    cabinRoof.parent = this.root;
    cabinRoof.isPickable = false;
    const cabinDoor = MeshBuilder.CreatePlane("shipCabinDoor", { width: 0.8, height: 1.5 }, scene);
    cabinDoor.position.set(0, DECK_Y + 0.78, 6.62);
    cabinDoor.material = woodDark;
    cabinDoor.parent = this.root;
    cabinDoor.isPickable = false;
    const cabinWindow = MeshBuilder.CreatePlane("shipCabinWin", { width: 0.55, height: 0.45 }, scene);
    cabinWindow.position.set(0, DECK_Y + 1.45, 6.615);
    const winMat = new StandardMaterial("shipCabinWinMat", scene);
    winMat.emissiveColor = new Color3(1.0, 0.82, 0.5);
    winMat.diffuseColor = new Color3(0.9, 0.75, 0.5);
    winMat.disableLighting = true;
    cabinWindow.material = winMat;
    cabinWindow.parent = this.root;
    cabinWindow.isPickable = false;

    // ---- 风能核心（甲板中央镶嵌，青色风纹；半嵌避免通行踩踏穿模） ----
    const coreRing = MeshBuilder.CreateTorus("shipCoreRing", { diameter: 2.3, thickness: 0.16, tessellation: 24 }, scene);
    coreRing.position.set(0, DECK_Y - 0.03, 0.4);
    coreRing.rotation.x = Math.PI / 2;
    coreRing.material = bronze;
    coreRing.parent = this.root;
    coreRing.isPickable = false;
    const core = MeshBuilder.CreateDisc("shipWindCore", { radius: 1.05, tessellation: 24 }, scene);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, DECK_Y + 0.01, 0.4);
    const coreMat = new StandardMaterial("shipWindCoreMat", scene);
    coreMat.emissiveColor = new Color3(0.25, 0.85, 0.9);
    coreMat.diffuseColor = new Color3(0.3, 0.8, 0.85);
    coreMat.alpha = 0.85;
    coreMat.disableLighting = true;
    core.material = coreMat;
    core.parent = this.root;
    core.isPickable = false;
    this.windCore = core;
    const coreLight = new PointLight("shipCoreLight", new Vector3(0, DECK_Y + 1.2, 0.4), scene);
    coreLight.diffuse = new Color3(0.35, 0.85, 0.9);
    coreLight.intensity = 0.35;
    coreLight.range = 9;
    coreLight.parent = this.root;

    // ---- 舷侧翼帆（低位外倾，不挡舵位视线） ----
    for (const side of [-1, 1]) {
      const mast = MeshBuilder.CreateCylinder(`wingMast${side}`, { height: 4.6, diameterTop: 0.14, diameterBottom: 0.24, tessellation: 8 }, scene);
      mast.position.set(side * 2.3, DECK_Y + 1.9, 1.6);
      mast.rotation.z = -side * 0.62;
      mast.material = woodDark;
      mast.parent = this.root;
      mast.isPickable = false;
      const spar = MeshBuilder.CreateCylinder(`wingSpar${side}`, { height: 3.4, diameter: 0.1, tessellation: 6 }, scene);
      spar.rotation.x = Math.PI / 2;
      spar.parent = mast;
      spar.position.y = 0.6;
      spar.material = woodDark;
      spar.isPickable = false;
      const sail = MeshBuilder.CreatePlane(`wingSail${side}`, { width: 3.1, height: 2.7 }, scene);
      sail.parent = mast;
      sail.position.set(side * 0.25, 0.45, 0.1);
      sail.material = canvas;
      sail.isPickable = false;
      this.sails.push(sail);
      const stripe = MeshBuilder.CreatePlane(`wingSailTrim${side}`, { width: 3.1, height: 0.3 }, scene);
      stripe.parent = mast;
      stripe.position.set(side * 0.26, -0.7, 0.12);
      stripe.material = trim;
      stripe.isPickable = false;
    }
    // 前桅支索帆（低三角帆，视线高度以下）
    const jibPts = [new Vector3(0, DECK_Y + 0.4, -6.2), new Vector3(0, DECK_Y + 2.4, -7.6), new Vector3(0, DECK_Y + 0.4, -7.5)];
    const jib = MeshBuilder.CreateRibbon("shipJib", { pathArray: [jibPts, jibPts.map((p) => p.add(new Vector3(0, 0.02, 0)))] }, scene);
    jib.material = canvas;
    jib.parent = this.root;
    jib.isPickable = false;
    this.sails.push(jib);
    const bowsprit = MeshBuilder.CreateCylinder("bowsprit", { height: 3.4, diameterTop: 0.1, diameterBottom: 0.18, tessellation: 8 }, scene);
    bowsprit.rotation.x = Math.PI / 2 - 0.28;
    bowsprit.position.set(0, DECK_Y + 1.1, -8.6);
    bowsprit.material = woodDark;
    bowsprit.parent = this.root;
    bowsprit.isPickable = false;

    // ---- 船尾灯（琥珀） ----
    for (const side of [-1, 1]) {
      const lamp = MeshBuilder.CreateSphere(`shipLamp${side}`, { diameter: 0.34, segments: 8 }, scene);
      lamp.position.set(side * 1.95, DECK_Y + 1.5, 6.0);
      const lampMat = new StandardMaterial(`shipLampMat${side}`, scene);
      lampMat.emissiveColor = new Color3(1.0, 0.75, 0.38);
      lampMat.diffuseColor = new Color3(0.9, 0.7, 0.35);
      lampMat.disableLighting = true;
      lamp.material = lampMat;
      lamp.parent = this.root;
      lamp.isPickable = false;
      // 全场景光源总数有 GL_MAX_VERTEX_UNIFORM_BUFFERS 上限（12 盏时薄实例着色器编译失败），
      // 船灯保持纯自发光，不再占 PointLight 名额。
    }
    const lampPost = MeshBuilder.CreateCylinder("lampPost", { height: 1.1, diameter: 0.07, tessellation: 6 }, scene);
    lampPost.position.set(1.95, DECK_Y + 0.9, 6.0);
    lampPost.material = bronze;
    lampPost.parent = this.root;
    lampPost.isPickable = false;

    // ---- 旗 ----
    const pole = MeshBuilder.CreateCylinder("shipFlagPole", { height: 2.4, diameter: 0.06, tessellation: 6 }, scene);
    pole.position.set(0, DECK_Y + 3.3, 7.9);
    pole.material = bronze;
    pole.parent = this.root;
    pole.isPickable = false;
    const pennant = MeshBuilder.CreatePlane("shipPennant", { width: 1.4, height: 0.4 }, scene);
    pennant.position.set(0.72, DECK_Y + 4.2, 7.9);
    const pMat = new StandardMaterial("shipPennantMat", scene);
    pMat.diffuseColor = new Color3(0.85, 0.45, 0.3);
    pMat.backFaceCulling = false;
    pennant.material = pMat;
    pennant.parent = this.root;
    pennant.isPickable = false;
    this.pennant = pennant;
  }

  private hullMesh!: Mesh;

  get pos(): Vector3 { return this.root.position; }
  get helmWorldPos(): Vector3 {
    this.root.computeWorldMatrix(true);
    const off = new Vector3(0, DECK_Y + 1.6, 6.1);
    return Vector3.TransformCoordinates(off, this.root.getWorldMatrix());
  }
  /** 玩家上下船的甲板站位 */
  deckBoardPos(): Vector3 {
    this.root.computeWorldMatrix(true);
    return Vector3.TransformCoordinates(new Vector3(0, DECK_Y + 0.25, 4.4), this.root.getWorldMatrix());
  }

  /** 驾驶时角色的舵位站位（舵轮侧后方，面朝船首） */
  helmStandPos(): Vector3 {
    return Vector3.TransformCoordinates(new Vector3(0, DECK_Y + 0.02, 6.95), this.root.getWorldMatrix());
  }

  beginDock(target: DockTarget) {
    if (this.state !== "sailing") return;
    this.dockingTo = target;
    this.dockT = 0;
    this.speed = 0;
  }

  undock() {
    if (this.state === "sailing") return;
    this.state = "sailing";
    this.dockingTo = null;
    this.speed = 1.5;
    this.onEvent?.("ship_undock");
  }

  /** 存档恢复用：直接设置停泊状态 */
  setState(docked: boolean) {
    this.state = docked ? "docked" : "sailing";
    this.dockingTo = null;
  }

  nearestDock(maxDist: number): DockTarget | null {
    let best: DockTarget | null = null;
    let bd = maxDist;
    for (const d of this.docks) {
      const dist = Vector3.Distance(this.pos, d.pos);
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }

  update(dt: number, input: Input, player: Player, islands: Island[]) {
    // 停泊吸附
    if (this.dockingTo) {
      this.dockT += dt / 1.4;
      const t = Math.min(1, this.dockT);
      const e = 1 - Math.pow(1 - t, 3);
      this.root.position = Vector3.Lerp(this.prevPos, this.dockingTo.pos, e);
      let dr = this.dockingTo.rotY - this.prevRotY;
      while (dr > Math.PI) dr -= Math.PI * 2;
      while (dr < -Math.PI) dr += Math.PI * 2;
      this.root.rotation.y = this.prevRotY + dr * e;
      this.heading = this.root.rotation.y;
      if (t >= 1) {
        this.state = "docked";
        this.onEvent?.("ship_dock", this.dockingTo);
        this.dockingTo = null;
        this.energy = Math.min(100, this.energy + 30);
      }
      this.syncBody();
      return;
    }

    if (player.mode === "sail") {
      let throttle = 0;
      if (!input.uiCapture) {
        if (input.isDown("KeyW")) throttle = 1;
        else if (input.isDown("KeyS")) throttle = -0.5;
        if (input.isDown("Space")) this.root.position.y += 7 * dt;
        if (input.isDown("ShiftLeft")) this.root.position.y -= 7 * dt;
        if (input.isDown("KeyA")) this.heading += dt * (0.32 + 0.5 * Math.min(1, this.speed / 8));
        if (input.isDown("KeyD")) this.heading -= dt * (0.32 + 0.5 * Math.min(1, this.speed / 8));
      }
      const cap = (this.energy > 1 ? this.maxSpeed : 5.5) * (this.sailUpgraded ? 1.28 : 1);
      this.speed += (throttle * cap - this.speed) * Math.min(1, 0.55 * dt);
      this.speed = Math.max(0, this.speed);
      if (this.speed > 1) {
        this.energy = Math.max(0, this.energy - dt * 0.5);
      } else {
        this.energy = Math.min(100, this.energy + dt * 0.8);
      }
      this.root.rotation.y = this.heading;
      // 船首朝行进方向：船首在局部 -z，速度沿 (−sin, −cos)(heading)
      this.root.position.x -= Math.sin(this.heading) * this.speed * dt;
      this.root.position.z -= Math.cos(this.heading) * this.speed * dt;
      this.root.position.y += Math.sin(this.speed * 0.8 + performance.now() * 0.001) * dt * 0.4;

      // 岛屿防穿：检查船中心下方岛屿高度
      for (const isle of islands) {
        const d = Math.hypot(this.pos.x - isle.root.position.x, this.pos.z - isle.root.position.z);
        if (d < isle.def.radius + 10) {
          const h = isle.heightAt(this.pos.x, this.pos.z);
          if (h !== null && this.pos.y < h + 3.2) {
            // 平滑抬升：瞬移会把船体挤进乘员胶囊，物理解算冲量累积会把人抛出甲板
            this.pos.y += (h + 3.2 - this.pos.y) * Math.min(1, 8 * dt);
            this.speed *= 0.9;
          }
        }
      }
      this.wheelRot += dt * (input.isDown("KeyA") ? 1.6 : input.isDown("KeyD") ? -1.6 : 0);
    }

    // 帆与旗动画（翼帆随速度鼓起，仍保持低位）
    const billow = 1 + Math.min(0.3, this.speed * 0.018);
    for (let i = 0; i < this.sails.length; i++) {
      const s = this.sails[i];
      if (s.name.startsWith("wingSail") && !s.name.includes("Trim")) s.scaling.x = billow;
    }
    this.pennant.rotation.y = Math.sin(performance.now() * 0.004) * 0.3;
    (this.wheelMesh).rotation.z = this.wheelRot;
    this.windCore.rotation.y += dt * 0.6;

    this.syncBody();
  }

  private syncBody() {
    // 计算平台位移
    const deltaPos = this.root.position.subtract(this.prevPos);
    const deltaRotY = this.root.rotation.y - this.prevRotY;
    this.hullBody.body.setTargetTransform(this.root.position, Quaternion.FromEulerAngles(0, this.root.rotation.y, 0));
    this.prevPos.copyFrom(this.root.position);
    this.prevRotY = this.root.rotation.y;
    this.lastDelta = { deltaPos, deltaRotY };
  }

  lastDelta = { deltaPos: Vector3.ZeroReadOnly.clone(), deltaRotY: 0 };
}
