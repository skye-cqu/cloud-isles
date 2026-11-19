// 宠物系统（M4）：狐伙伴——结识、跟随/留守/呼回、抚摸喂食、羁绊提示（15/25/35m）。
// 模型：Khronos glTF Sample Fox（CC0 模型 / CC-BY 4.0 绑骨动画，见 docs/licenses/fox-model.md）。
// 宠物不自动造资源：只在羁绊范围内提示最近未采集物，玩家自己拾取。
import { Scene, Vector3, TransformNode, AnimationGroup, MeshBuilder, StandardMaterial, Color3 } from "@babylonjs/core";
import { SceneLoader } from "@babylonjs/core";
import { petHintRadius } from "shared";
import type { SavedPet } from "shared";
import type { Player } from "../world/player";
import type { World, PickupDef } from "../world/world";
import type { InteractSystem } from "./interact";
import type { Inventory } from "./items";
import type { Hud } from "../core/ui";

const FOX_URL = "/assets/animals/fox/Fox.glb";
const FOX_TARGET_WIDTH = 0.9;
/** 跟随距离：近于此值Idle，远于此值Run */
const FOLLOW_NEAR = 2.2;
const FOLLOW_FAR = 7;
const FOLLOW_SPEED_WALK = 3.0;
const FOLLOW_SPEED_RUN = 7.5;
/** 提示去重：同一目标只提示一次 */
const HINT_COOLDOWN_MS = 8_000;

export class PetSystem {
  pet: SavedPet | null = null;
  onEvent?: (kind: string, data?: unknown) => void;
  private root: TransformNode | null = null;
  private anims = new Map<string, AnimationGroup>();
  private currentAnim = "";
  private lastHintAt = 0;
  private lastHintUid = "";
  /** 视觉朝向（狐模型默认面向 -Z？实机核对后校正） */
  private static FACE_YAW = 0;

  constructor(
    private scene: Scene,
    private player: Player,
    private world: World,
    private interact: InteractSystem,
    private inv: Inventory,
    private hud: Hud,
  ) {}

  /** 苓处结识：条件（稳定家园+首次远征归来）由 main 校验，消耗烤云菇×1。 */
  adopt(name = "阿狸"): boolean {
    if (this.pet) return false;
    this.pet = { species: "fox", name, space: "island:home", pos: [this.player.node.position.x, this.player.node.position.y, this.player.node.position.z], bondVisits: 0, bondIslands: [], mode: "follow" };
    void this.spawnVisual();
    this.onEvent?.("toast", `${name} 加入你的旅程！它会在附近提示未采集的资源。`);
    this.onEvent?.("pet_adopted", { name });
    return true;
  }

  private async spawnVisual() {
    if (!this.pet || this.root) return;
    try {
      const container = await SceneLoader.LoadAssetContainerAsync(FOX_URL, "", this.scene);
      const entries = container.instantiateModelsToScene(undefined, false, { doNotInstantiate: true });
      const root = new TransformNode("pet_fox", this.scene);
      for (const n of entries.rootNodes) n.parent = root;
      // 归一尺度：最大水平尺寸对齐目标宽
      let min = new Vector3(1e9, 1e9, 1e9), max = new Vector3(-1e9, -1e9, -1e9);
      for (const m of root.getChildMeshes()) {
        if (!m.getTotalVertices()) continue;
        m.computeWorldMatrix(true);
        const bb = m.getBoundingInfo().boundingBox;
        for (const c of [bb.minimumWorld, bb.maximumWorld]) {
          min = Vector3.Minimize(min, c);
          max = Vector3.Maximize(max, c);
        }
      }
      const size = max.subtract(min);
      const scale = FOX_TARGET_WIDTH / (Math.max(size.x, size.z) || 1);
      root.scaling.setAll(scale);
      for (const g of entries.animationGroups) {
        this.anims.set(g.name.replace(/^Clone of /, ""), g);
        g.stop();
      }
      this.root = root;
      this.root.position.set(this.pet.pos[0], this.pet.pos[1], this.pet.pos[2]);
      // 交互点：抚摸/喂食
      this.interact.register({
        kind: "npc_workbench", label: `${this.pet.name}（抚摸/喂食）`,
        pos: root.position.add(new Vector3(0, 0.5, 0)),
        getPos: () => (this.root ? this.root.position.add(new Vector3(0, 0.5, 0)) : root.position),
        valid: () => !!this.pet && !!this.root,
        act: () => this.touch(),
      });
      // 脚下圈（辨识度）
      const disc = MeshBuilder.CreateDisc("petDisc", { radius: 0.5, tessellation: 20 }, this.scene);
      disc.rotation.x = Math.PI / 2;
      const dm = new StandardMaterial("petDiscMat", this.scene);
      dm.diffuseColor = new Color3(0.95, 0.75, 0.35);
      dm.emissiveColor = new Color3(0.25, 0.18, 0.05);
      dm.alpha = 0.5;
      disc.material = dm;
      disc.isPickable = false;
      disc.parent = root;
      disc.position.y = 0.03;
    } catch (e) {
      console.warn("[pet] fox load failed", e);
      this.onEvent?.("toast", "宠物模型加载失败，本次旅程它先留在梦里。");
      this.pet = null;
    }
  }

  private play(name: string, speed = 1) {
    if (this.currentAnim === name) return;
    const g = this.anims.get(name) ?? this.anims.get("Survey");
    if (!g) return;
    for (const other of this.anims.values()) if (other !== g) other.stop();
    g.reset();
    g.play(true);
    g.speedRatio = speed;
    this.currentAnim = name;
  }

  get node(): TransformNode | null { return this.root; }

  /** 呼回：宠物回到玩家身边（失败/掉海恢复用） */
  recall() {
    if (!this.pet || !this.root) return;
    this.pet.mode = "follow";
    const p = this.player.node.position;
    this.root.position.set(p.x + 1.2, p.y + 0.3, p.z);
    this.onEvent?.("toast", `${this.pet.name} 回到了你身边。`);
  }

  toggleStay() {
    if (!this.pet) return;
    this.pet.mode = this.pet.mode === "follow" ? "stay" : "follow";
    this.onEvent?.("toast", this.pet.mode === "stay" ? `${this.pet.name} 会在这里等你。` : `${this.pet.name} 继续跟上你了。`);
  }

  private touch() {
    if (!this.pet || !this.root) return;
    if (this.inv.count("roast_mushroom") > 0) {
      // 喂食优先：有烤云菇就喂
      if (!this.inv.remove("roast_mushroom", 1)) return;
      this.onEvent?.("toast", `${this.pet.name} 开心地吃掉了烤云菇！`);
      this.onEvent?.("pet_fed", { name: this.pet.name });
      this.play("Survey");
      return;
    }
    this.onEvent?.("toast", `${this.pet.name} 蹭了蹭你的手。`);
    this.onEvent?.("pet_petted", { name: this.pet.name });
  }

  /** 每帧：移动、动画、羁绊提示。space==="ship" 时钉在甲板随行位。 */
  update(dt: number, shipDeckPos: Vector3 | null, sailing: boolean) {
    const pet = this.pet;
    if (!pet || !this.root) return;
    if (sailing && shipDeckPos) {
      pet.space = "ship";
      this.root.position.copyFrom(shipDeckPos);
      this.play("Survey");
      return;
    }
    if (pet.space === "ship") {
      // 刚下船：落到玩家附近
      pet.space = "island:home";
      const p = this.player.node.position;
      this.root.position.set(p.x + 1.2, p.y + 0.3, p.z);
    }
    const pos = this.root.position;
    if (pet.mode === "follow") {
      const p = this.player.node.position;
      const dx = p.x - pos.x, dz = p.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > FOLLOW_FAR) {
        const speed = FOLLOW_SPEED_RUN;
        pos.x += (dx / dist) * speed * dt;
        pos.z += (dz / dist) * speed * dt;
        this.play("Run", 1);
      } else if (dist > FOLLOW_NEAR) {
        const speed = FOLLOW_SPEED_WALK;
        pos.x += (dx / dist) * speed * dt;
        pos.z += (dz / dist) * speed * dt;
        this.play("Walk", 1);
      } else {
        this.play("Survey");
      }
      // 朝向
      if (dist > 0.4) {
        const yaw = Math.atan2(dx, dz) + PetSystem.FACE_YAW;
        let diff = yaw - this.root.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.root.rotation.y += diff * Math.min(1, 10 * dt);
      }
    } else {
      this.play("Survey");
    }
    // 地形贴合：落在任一岛屿地表上
    for (const isle of this.world.islands) {
      const h = isle.heightAt(pos.x, pos.z);
      if (h !== null) { pos.y += (h - pos.y) * Math.min(1, 12 * dt); break; }
    }
    pet.pos = [pos.x, pos.y, pos.z];
    this.hintPing();
  }

  /** 羁绊提示：范围内最近未采集物，气泡+提示（去重冷却） */
  private hintPing() {
    const pet = this.pet;
    if (!pet || !this.root || pet.mode !== "follow") return;
    const hint = petHintRadius(pet.bondVisits);
    if (!hint) return;
    const now = performance.now();
    if (now - this.lastHintAt < HINT_COOLDOWN_MS) return;
    const pos = this.root.position;
    let best: PickupDef | null = null;
    let bd = hint.radius;
    for (const pk of this.world.pickups) {
      if (pk.taken) continue;
      if (hint.mode === "mushroom" && pk.item !== "cloudmushroom") continue;
      const d = Vector3.Distance(pos, pk.mesh.position);
      if (d < bd) { bd = d; best = pk; }
    }
    if (best && best.uid !== this.lastHintUid) {
      this.lastHintUid = best.uid;
      this.lastHintAt = now;
      this.hud.toast(`${pet.name} 朝${hint.mode === "mushroom" ? "一朵云菇" : "什么东西"}嗅了嗅……（${Math.round(bd)}m 内）`, 3);
      this.onEvent?.("pet_hint", { uid: best.uid, item: best.item });
      this.play("Survey");
    }
  }

  /** 停靠岛屿时调用：与宠物同到访新岛 → 羁绊+1（同岛不重复；家园不计） */
  noteDock(islandId: string) {
    const pet = this.pet;
    if (!pet || pet.mode !== "follow") return;
    if (islandId === "home") return;
    if (!pet.bondIslands.includes(islandId)) {
      pet.bondIslands.push(islandId);
      pet.bondVisits = pet.bondIslands.length;
      this.onEvent?.("toast", `${pet.name} 第一次来到这里！羁绊 ${pet.bondVisits} 级。`);
      this.onEvent?.("pet_bond", { visits: pet.bondVisits });
    }
  }

  // ---------- 保存 ----------

  hydrate(pet: SavedPet | null | undefined) {
    this.pet = pet ?? null;
    if (this.pet) {
      // 清洗修复前存档误记的家园羁绊（home 不计羁绊岛）
      this.pet.bondIslands = this.pet.bondIslands.filter((id) => id !== "home");
      this.pet.bondVisits = this.pet.bondIslands.length;
      void this.spawnVisual();
    }
  }

  /** 镜头距离检查用：宠物世界坐标 */
  headWorldPos(): Vector3 | null {
    return this.root ? this.root.position.add(new Vector3(0, 0.6, 0)) : null;
  }
}
