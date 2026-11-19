// 建造系统：选择—预览—放置—调整—使用—改造。玩家与 NPC 共用同一套放置规则。
import {
  Scene, Vector3, Color3, Mesh, MeshBuilder, StandardMaterial, TransformNode,
  PhysicsAggregate, PhysicsShapeType, PhysicsMotionType, PointLight,
} from "@babylonjs/core";
import { BUILD_CATALOG, BuildPartDef, ItemId, SavedBuilding } from "shared";
import { Inventory } from "./items";
import type { World } from "../world/world";
import type { Player } from "../world/player";
import { recoverHomeBuildPosition, type HomeSurface } from "../world/lsicHome";
import { loadItemModel, instantiateModel, getLoadedModel } from "../assets/itemModels";

export interface PlacedBuilding {
  uid: string;
  partId: string;
  space: string;
  pos: Vector3;      // 世界坐标
  rotY: number;
  node: TransformNode;
  light?: PointLight;
  phys?: PhysicsAggregate;
}

export type BuildMode = "off" | "place" | "pickup";

const ux = (n: number) => Math.round(n * 100) / 100;

export class BuildSystem {
  buildings: PlacedBuilding[] = [];
  mode: BuildMode = "off";
  selectedPart: BuildPartDef | null = null;
  ghost: TransformNode | null = null;
  ghostRotY = 0;
  ghostValid = false;
  ghostPos = new Vector3(0, 0, 0);
  private movingUid: string | null = null;
  /** NPC 授权建设区 */
  buildZone: { center: Vector3; radius: number } | null = null;
  buildBudget: Partial<Record<ItemId, number>> | null = null;
  buildAllowedParts = new Set<string>();
  authorizationPaused = false;
  onEvent?: (kind: string, data?: unknown) => void;
  unlockedQuests: Set<string> = new Set();
  private uidCounter = 1;
  private appliedOperationIds = new Set<string>();
  private zoneMarker: Mesh | null = null;
  modelReady = new Map<string, boolean>();
  private woodMat: StandardMaterial | null = null;

  constructor(private scene: Scene, private world: World, private inv: Inventory, private player: Player, preloadAssets = true) {
    if (preloadAssets) void this.preloadModels();
  }

  private async preloadModels() {
    for (const part of BUILD_CATALOG) {
      if (!part.model) continue;
      try {
        await loadItemModel(this.scene, part.model.file, part.model.width ?? part.size[0]);
        this.modelReady.set(part.model.file, true);
        this.refreshModels();
      } catch (e) {
        console.warn("[build] model load failed", part.model.file, e);
      }
    }
  }

  private refreshModels() {
    for (const b of this.buildings) {
      const def = BUILD_CATALOG.find((p) => p.id === b.partId)!;
      if (def.model && this.modelReady.get(def.model.file) && !b.node.getChildren().some((c) => c.name === "modelInst")) {
        this.attachModel(b, def);
      }
    }
  }

  private attachModel(b: PlacedBuilding, def: BuildPartDef) {
    const model = getLoadedModel(def.model!.file, def.model!.width ?? def.size[0]);
    if (!model) return;
    const inst = instantiateModel(this.scene, model);
    inst.parent = b.node;
    // 程序化占位件（procedural/proceduralBack/proceduralLeg…）整体隐藏，只留官方模型
    for (const c of b.node.getChildren()) {
      if (c.name.startsWith("procedural")) c.setEnabled(false);
    }
  }

  private mat(): StandardMaterial {
    if (!this.woodMat) {
      this.woodMat = new StandardMaterial("buildWood", this.scene);
      this.woodMat.diffuseColor = new Color3(0.62, 0.47, 0.32);
      this.woodMat.specularColor = new Color3(0.04, 0.04, 0.04);
    }
    return this.woodMat;
  }

  // ---------- 放置规则（玩家/NPC 共用） ----------

  canPlace(part: BuildPartDef, pos: Vector3, _rotY: number, byNpc = false, ignoreUid?: string): { ok: boolean; reason?: string } {
    const home = this.world.islands[0];
    const ground = home.heightAt(pos.x, pos.z);
    if (ground === null) return { ok: false, reason: "只能建在家园空岛上" };
    if (home.canBuildAt && !home.canBuildAt(pos.x, pos.z)) return { ok: false, reason: "这里坡度过陡或已有生活设施" };
    if (pos.y - ground > 6 || pos.y < ground - 2) return { ok: false, reason: "离地面太远" };
    const d = Math.hypot(pos.x - home.root.position.x, pos.z - home.root.position.z);
    if (d > home.def.radius - 3) return { ok: false, reason: "超出家园边缘" };
    if (byNpc) {
      if (this.authorizationPaused) return { ok: false, reason: "建设授权已暂停" };
      // NPC 只能在授权区内建设
      if (!this.buildZone || Vector3.Distance(pos, this.buildZone.center) > this.buildZone.radius) {
        return { ok: false, reason: "超出授权建设区域" };
      }
      if (!this.buildAllowedParts.has(part.id)) return { ok: false, reason: "该部件未获授权" };
      if (this.buildBudget) {
        for (const [id, n] of Object.entries(part.cost)) {
          if (n && (this.buildBudget[id as ItemId] ?? 0) < n) return { ok: false, reason: "超出授权预算" };
        }
      }
      if (!this.inv.canAfford(part.cost)) return { ok: false, reason: "共享库存材料不足" };
    } else if (!ignoreUid && !this.inv.canAfford(part.cost)) {
      return { ok: false, reason: "材料不足" };
    }
    // 重叠检查（AABB 简化）
    for (const b of this.buildings) {
      if (b.uid === ignoreUid) continue;
      const other = BUILD_CATALOG.find((p) => p.id === b.partId)!;
      const dx = Math.abs(b.pos.x - pos.x), dz = Math.abs(b.pos.z - pos.z), dy = Math.abs(b.pos.y - pos.y);
      const minSepX = (part.size[0] + other.size[0]) / 2 * 0.7;
      const minSepZ = (part.size[2] + other.size[2]) / 2 * 0.7;
      if (dx < minSepX && dz < minSepZ && dy < (part.size[1] + other.size[1]) / 2) {
        return { ok: false, reason: "与已有建设重叠" };
      }
    }
    const dock = this.world.docks[0];
    if (Vector3.Distance(pos, dock.pos) < 6.5) return { ok: false, reason: "泊位区域需要保持畅通" };
    return { ok: true };
  }

  /** 放置一个部件。byNpc=true 时消耗授权预算；"free" 供存档重建。 */
  place(partId: string, pos: Vector3, rotY: number, byNpc = false, budgetOwner?: "player" | "npc" | "free", operationId?: string, savedUid?: string, savedSpace = "island:home"): PlacedBuilding | null {
    const part = BUILD_CATALOG.find((p) => p.id === partId);
    if (!part) return null;
    if (operationId && this.appliedOperationIds.has(operationId)) return null;
    if (budgetOwner !== "free") {
      const check = this.canPlace(part, pos, rotY, byNpc);
      if (!check.ok) {
        if (!byNpc) this.onEvent?.("toast", check.reason ?? "无法放置");
        return null;
      }
      if (byNpc && this.buildBudget) {
        // 同步入口中先扣真实共享库存，再扣非托管授权上限；任一检查失败不改变状态。
        if (!this.inv.pay(part.cost)) return null;
        for (const [id, n] of Object.entries(part.cost)) {
          if (n) this.buildBudget[id as ItemId] = Math.max(0, (this.buildBudget[id as ItemId] ?? 0) - n);
        }
      } else if (!byNpc) {
        if (!this.inv.pay(part.cost)) return null;
      }
    }

    const uid = savedUid ?? `b${this.uidCounter++}`;
    if (this.buildings.some((b) => b.uid === uid)) return null;
    const node = new TransformNode(`build_${uid}`, this.scene);
    node.position.copyFrom(pos);
    node.rotation.y = rotY;

    const body = this.buildProcedural(node, part);
    const placed: PlacedBuilding = { uid, partId, space: savedSpace, pos: pos.clone(), rotY, node, phys: body };
    if (part.light) {
      const glow = MeshBuilder.CreateSphere(`buildGlow_${uid}`, { diameter: 0.34 }, this.scene);
      glow.parent = node;
      glow.position.y = part.size[1] - 0.15;
      const gm = new StandardMaterial(`buildGlowMat_${uid}`, this.scene);
      gm.emissiveColor = new Color3(1.0, 0.8, 0.45);
      gm.diffuseColor = new Color3(0.9, 0.7, 0.4);
      glow.material = gm;
      glow.isPickable = false;
      // 光源总数上限保护：GL_MAX_VERTEX_UNIFORM_BUFFERS=12，超过会编译失败；留 3 盏给核心光
      if (this.scene.lights.length < 9) {
        const light = new PointLight(`buildLight_${uid}`, new Vector3(0, part.size[1], 0), this.scene);
        light.parent = node;
        light.diffuse = new Color3(1.0, 0.8, 0.5);
        light.intensity = 0.35;
        light.range = 12;
      }
      placed.light = this.scene.getLightByName(`buildLight_${uid}`) as PointLight | undefined;
    }
    if (part.model && this.modelReady.get(part.model.file)) this.attachModel(placed, part);
    this.buildings.push(placed);
    if (operationId) this.appliedOperationIds.add(operationId);
    // "free" 是存档重建与开机基线：不发 built 事件，否则每次加载都会触发存档并误标任务
    if (budgetOwner !== "free") this.onEvent?.("built", { uid, partId, byNpc });
    return placed;
  }

  private buildProcedural(node: TransformNode, part: BuildPartDef): PhysicsAggregate | undefined {
    const [sx, sy, sz] = part.size;
    let mesh: Mesh | null = null;
    switch (part.id) {
      case "floor":
        mesh = MeshBuilder.CreateBox("procedural", { width: sx, height: 0.16, depth: sz }, this.scene);
        mesh.position.y = 0.08;
        break;
      case "step":
        mesh = MeshBuilder.CreateBox("procedural", { width: sx, height: sy, depth: sz }, this.scene);
        mesh.position.y = sy / 2;
        break;
      case "pillar":
        mesh = MeshBuilder.CreateCylinder("procedural", { height: sy, diameter: 0.36, tessellation: 8 }, this.scene);
        mesh.position.y = sy / 2;
        break;
      case "railing": {
        mesh = MeshBuilder.CreateBox("procedural", { width: sx, height: 0.1, depth: 0.12 }, this.scene);
        mesh.position.y = sy - 0.05;
        // 两端立柱：横杆不悬空
        for (const px of [-sx / 2 + 0.06, sx / 2 - 0.06]) {
          const post = MeshBuilder.CreateBox("proceduralPost", { width: 0.12, height: sy, depth: 0.12 }, this.scene);
          post.position.set(px, sy / 2, 0);
          post.material = this.mat();
          post.parent = node;
          post.isPickable = false;
        }
        break;
      }
      case "wall":
        mesh = MeshBuilder.CreateBox("procedural", { width: sx, height: sy, depth: 0.18 }, this.scene);
        mesh.position.y = sy / 2;
        break;
      case "table": {
        const top = MeshBuilder.CreateBox("procedural", { width: sx, height: 0.1, depth: sz }, this.scene);
        top.position.y = sy - 0.05;
        top.material = this.mat();
        top.parent = node;
        top.isPickable = false;
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const leg = MeshBuilder.CreateBox("proceduralLeg", { width: 0.12, height: sy - 0.1, depth: 0.12 }, this.scene);
          leg.position.set(dx * (sx / 2 - 0.12), (sy - 0.1) / 2, dz * (sz / 2 - 0.12));
          leg.material = this.mat();
          leg.parent = node;
          leg.isPickable = false;
        }
        return undefined;
      }
      case "planter": {
        const pot = MeshBuilder.CreateCylinder("procedural", { height: 0.45, diameterTop: 0.62, diameterBottom: 0.44, tessellation: 9 }, this.scene);
        pot.position.y = 0.22;
        const bush = MeshBuilder.CreateSphere("procedural", { diameter: 0.62, segments: 6 }, this.scene);
        bush.position.y = 0.68;
        const flowerMat = new StandardMaterial("proceduralFlower", this.scene);
        flowerMat.diffuseColor = new Color3(0.9, 0.5, 0.62);
        flowerMat.specularColor = new Color3(0.02, 0.02, 0.02);
        bush.material = flowerMat;
        const potMat = new StandardMaterial("proceduralPot", this.scene);
        potMat.diffuseColor = new Color3(0.6, 0.42, 0.3);
        potMat.specularColor = new Color3(0.02, 0.02, 0.02);
        pot.material = potMat;
        [pot, bush].forEach((m) => { m.parent = node; m.isPickable = false; });
        return undefined;
      }
      default: {
        mesh = MeshBuilder.CreateBox("procedural", { width: sx, height: sy, depth: sz }, this.scene);
        mesh.position.y = sy / 2;
        if (part.use === "sit") {
          mesh.scaling.y = 0.5;
          mesh.position.y = 0.24;
          const back = MeshBuilder.CreateBox("proceduralBack", { width: sx * 0.9, height: sy * 0.5, depth: 0.12 }, this.scene);
          back.position.set(0, sy * 0.55, -sz * 0.38);
          back.material = this.mat();
          back.parent = node;
          back.isPickable = false;
        }
        if (part.use === "cook") {
          mesh.scaling.y = 0.85;
          mesh.position.y = 0.5;
        }
      }
    }
    if (mesh) {
      if (!mesh.material) mesh.material = this.mat();
      mesh.parent = node;
      mesh.isPickable = false;
    }

    return this.createPhysics(node, part);
  }

  private createPhysics(node: TransformNode, part: BuildPartDef): PhysicsAggregate | undefined {
    const needPhys = part.category === "structure" || part.use === "sit" || part.use === "cook";
    if (needPhys) {
      const h = Math.max(0.4, part.size[1]);
      const collider = MeshBuilder.CreateBox(`buildCollider_${node.name}`, { width: part.size[0], height: h, depth: part.size[2] }, this.scene);
      collider.isVisible = false;
      collider.parent = node;
      collider.position.y = h / 2;
      const phys = new PhysicsAggregate(collider, PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, this.scene);
      phys.body.setMotionType(PhysicsMotionType.STATIC);
      return phys;
    }
    return undefined;
  }

  /** refund: true=日常拆除半价；"full"=方案提交失败整单回滚的全额退款。 */
  remove(uid: string, refund: boolean | "full" = true, notify = true): boolean {
    const i = this.buildings.findIndex((b) => b.uid === uid);
    if (i < 0) return false;
    const b = this.buildings[i];
    const part = BUILD_CATALOG.find((p) => p.id === b.partId)!;
    if (refund) {
      for (const [id, n] of Object.entries(part.cost)) {
        if (n) this.inv.add(id as ItemId, refund === "full" ? n : Math.floor(n / 2));
      }
    }
    b.light?.dispose();
    b.phys?.dispose();
    b.node.dispose();
    this.buildings.splice(i, 1);
    if (notify) this.onEvent?.("removed", { uid, partId: b.partId });
    return true;
  }

  nearestBuilding(maxDist: number): PlacedBuilding | null {
    const p = this.player.node.position;
    let best: PlacedBuilding | null = null, bd = maxDist;
    for (const b of this.buildings) {
      const d = Vector3.Distance(p, b.pos);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  enterPlaceMode(partId: string) {
    const part = BUILD_CATALOG.find((p) => p.id === partId);
    if (!part) return;
    if (part.unlock?.quest && !this.unlockedQuests.has(part.unlock.quest)) {
      this.onEvent?.("toast", "该图纸尚未解锁");
      return;
    }
    this.selectedPart = part;
    this.movingUid = null;
    this.mode = "place";
    this.exitGhost();
    this.ghost = new TransformNode(`ghost_${part.id}`, this.scene);
    const box = MeshBuilder.CreateBox("ghostBox", { width: part.size[0], height: part.size[1], depth: part.size[2] }, this.scene);
    box.parent = this.ghost;
    const gm = new StandardMaterial("ghostMat", this.scene);
    gm.emissiveColor = new Color3(0.3, 0.8, 0.5);
    gm.diffuseColor = new Color3(0.3, 0.8, 0.5);
    gm.alpha = 0.45;
    box.material = gm;
    box.isPickable = false;
    if (part.model && this.modelReady.get(part.model.file)) {
      const model = getLoadedModel(part.model.file, part.model.width ?? part.size[0]);
      if (model) {
        const inst = instantiateModel(this.scene, model);
        inst.parent = this.ghost;
        box.setEnabled(false);
      }
    }
    this.onEvent?.("build_mode", "place");
  }

  exitGhost() {
    if (this.ghost) { this.ghost.dispose(); this.ghost = null; }
  }

  exit() {
    this.exitGhost();
    this.mode = "off";
    this.selectedPart = null;
    this.movingUid = null;
    this.onEvent?.("build_mode", "off");
  }

  updateGhost() {
    if (this.mode !== "place" || !this.ghost || !this.selectedPart) return;
    const forward = new Vector3(Math.sin(this.player.node.rotation.y), 0, Math.cos(this.player.node.rotation.y));
    const aim = this.player.node.position.add(forward.scale(3.2));
    const home = this.world.islands[0];
    const g = home.heightAt(aim.x, aim.z);
    if (g === null) { this.ghostValid = false; this.ghost.position.set(aim.x, aim.y, aim.z); return; }
    this.ghostPos.set(aim.x, g + 0.05, aim.z);
    this.ghost.position.copyFrom(this.ghostPos);
    this.ghost.rotation.y = this.ghostRotY;
    this.ghostValid = this.canPlace(this.selectedPart, this.ghostPos, this.ghostRotY, false, this.movingUid ?? undefined).ok;
    const box = this.ghost.getChildren().find((c) => c.name === "ghostBox") as Mesh | null;
    if (box && box.isEnabled()) {
      const m = box.material as StandardMaterial;
      m.emissiveColor = this.ghostValid ? new Color3(0.3, 0.85, 0.5) : new Color3(0.9, 0.3, 0.25);
    }
  }

  confirmPlace(byNpc = false): PlacedBuilding | null {
    if (this.mode !== "place" || !this.selectedPart) return null;
    if (this.movingUid && !byNpc) {
      const current = this.buildings.find((b) => b.uid === this.movingUid);
      const check = this.canPlace(this.selectedPart, this.ghostPos, this.ghostRotY, false, current?.uid);
      if (!current || !check.ok) return null;
      current.pos.copyFrom(this.ghostPos);
      current.rotY = this.ghostRotY;
      current.node.position.copyFrom(this.ghostPos);
      current.node.rotation.y = this.ghostRotY;
      // Static Havok bodies do not follow a moved parent. Recreate this piece's collider in the same commit.
      const oldCollider = current.phys?.transformNode;
      current.phys?.dispose();
      if (oldCollider && oldCollider !== current.node) oldCollider.dispose();
      current.phys = this.createPhysics(current.node, this.selectedPart);
      this.onEvent?.("moved", { uid: current.uid, partId: current.partId });
      return current;
    }
    return this.place(this.selectedPart.id, this.ghostPos, this.ghostRotY, byNpc);
  }

  /** 移动保持原件和 UID，取消或失败不会移除、退款或重新收费。 */
  enterMoveMode(uid: string): boolean {
    const building = this.buildings.find((b) => b.uid === uid);
    const part = building && BUILD_CATALOG.find((p) => p.id === building.partId);
    if (!building || !part) return false;
    this.selectedPart = part;
    this.movingUid = uid;
    this.mode = "place";
    this.exitGhost();
    this.ghost = new TransformNode(`ghost_move_${uid}`, this.scene);
    const box = MeshBuilder.CreateBox("ghostBox", { width: part.size[0], height: part.size[1], depth: part.size[2] }, this.scene);
    box.parent = this.ghost;
    const material = new StandardMaterial("ghostMat", this.scene);
    material.emissiveColor = new Color3(0.3, 0.8, 0.5);
    material.diffuseColor = new Color3(0.3, 0.8, 0.5);
    material.alpha = 0.45;
    box.material = material;
    box.isPickable = false;
    this.ghostPos.copyFrom(building.pos);
    this.ghostRotY = building.rotY;
    this.ghost.position.copyFrom(this.ghostPos);
    this.ghost.rotation.y = this.ghostRotY;
    this.onEvent?.("build_mode", "move");
    return true;
  }

  rotateGhost(step: number) {
    this.ghostRotY += step;
  }

  // ---------- NPC 授权 ----------

  setBuildZone(center: Vector3, radius = 5.5) {
    this.buildZone = { center, radius };
    if (this.zoneMarker) this.zoneMarker.dispose();
    const disc = MeshBuilder.CreateDisc("buildZone", { radius, tessellation: 32 }, this.scene);
    disc.rotation.x = Math.PI / 2;
    disc.position.copyFrom(center);
    const m = new StandardMaterial("buildZoneMat", this.scene);
    m.diffuseColor = new Color3(0.4, 0.7, 0.9);
    m.emissiveColor = new Color3(0.15, 0.35, 0.45);
    m.alpha = 0.4;
    disc.material = m;
    disc.isPickable = false;
    this.zoneMarker = disc;
  }

  authorizeBudget(budget: Partial<Record<ItemId, number>>, allowedParts = BUILD_CATALOG.map((part) => part.id)) {
    this.buildBudget = { ...budget };
    this.buildAllowedParts = new Set(allowedParts.filter((id) => BUILD_CATALOG.some((part) => part.id === id)));
  }

  revokeAuthorization() {
    this.buildZone = null;
    this.buildBudget = null;
    this.buildAllowedParts.clear();
    this.authorizationPaused = false;
    this.zoneMarker?.dispose();
    this.zoneMarker = null;
  }

  pauseAuthorization(paused = true) { this.authorizationPaused = paused; }

  npcTryBuild(partId: string, pos: Vector3, rotY: number, operationId?: string): PlacedBuilding | null {
    return this.place(partId, pos, rotY, true, undefined, operationId);
  }

  export(): SavedBuilding[] {
    return this.buildings.map((b) => ({
      uid: b.uid, partId: b.partId, space: b.space,
      pos: [ux(b.pos.x), ux(b.pos.y), ux(b.pos.z)], rotY: ux(b.rotY),
    }));
  }

  load(list: SavedBuilding[], homeSurface?: HomeSurface) {
    for (const b of this.buildings.slice()) this.remove(b.uid, false, false);
    for (const s of list) {
      const recovered = s.space === "island:home" && homeSurface
        ? recoverHomeBuildPosition(homeSurface, s.pos[0], s.pos[1], s.pos[2])
        : null;
      const pos = recovered ? new Vector3(recovered.x, recovered.y, recovered.z) : new Vector3(s.pos[0], s.pos[1], s.pos[2]);
      this.place(s.partId, pos, s.rotY, false, "free", undefined, s.uid, s.space);
    }
    this.uidCounter = Math.max(this.uidCounter, ...list.map((s) => Number(/^b(\d+)$/.exec(s.uid)?.[1] ?? 0) + 1));
  }
}
