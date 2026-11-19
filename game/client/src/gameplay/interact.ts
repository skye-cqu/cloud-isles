// 交互系统：拾取、宝箱、交互点（座位/灶台/农田/NPC/云舟/泊位升级）。
import { Scene, Vector3, Mesh, TransformNode, MeshBuilder, StandardMaterial, Color3 } from "@babylonjs/core";
import { ITEMS, ItemId } from "shared";
import { Inventory } from "./items";
import type { World, PickupDef, ChestDef } from "../world/world";
import type { Player } from "../world/player";

export type InteractKind = "pickup" | "chest" | "sit" | "cook" | "farm" | "npc" | "ship_helm" | "ship_board" | "npc_workbench" | "stabilizer";

export interface InteractTarget {
  kind: InteractKind;
  label: string;
  pos: Vector3;
  /** 动态位置（如游走的 NPC）；缺省用 pos */
  getPos?: () => Vector3;
  /** 执行交互；actor 标明执行者（"player"，未来 NPC 共用同一交互入口） */
  act: (actor: string) => void;
  /** 是否仍可用 */
  valid: () => boolean;
  data?: unknown;
}

export interface FarmPlot {
  id: string;
  node: TransformNode;
  crop: "wheat" | null;
  stage: number; // 0 空 1..3 生长 3 成熟
  plantedAt: number;
  growSec: number;
  meshes: Mesh[];
}

export class InteractSystem {
  targets: InteractTarget[] = [];
  farm: FarmPlot[] = [];
  prompt: { text: string } | null = null;
  sitting = false;
  cookingUntil = 0;
  onEvent?: (kind: string, data?: unknown) => void;
  /** 灶台位置（NPC 烹饪用） */
  stovePos: Vector3 | null = null;
  chairSeats: { uid: string; pos: Vector3; rotY: number; occupant: string | null }[] = [];

  constructor(private scene: Scene, private world: World, private inv: Inventory, private player: Player) {}

  register(t: InteractTarget) {
    this.targets.push(t);
  }

  /** 每帧寻找最近可交互目标 */
  findTarget(maxDist: number): InteractTarget | null {
    const p = this.player.node.position;
    let best: InteractTarget | null = null;
    let bd = maxDist;
    for (const t of this.targets) {
      if (!t.valid()) continue;
      const tp = t.getPos ? t.getPos() : t.pos;
      const d = Vector3.Distance(p, tp);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  addFarmPlot(id: string, pos: Vector3) {
    const node = new TransformNode(`farm_${id}`, this.scene);
    node.position.copyFrom(pos);
    const soil = MeshBuilder.CreateBox(`farmSoil_${id}`, { width: 3.2, height: 0.24, depth: 2.4 }, this.scene);
    soil.position.y = 0.1;
    soil.parent = node;
    const soilMat = new StandardMaterial(`farmSoilMat_${id}`, this.scene);
    soilMat.diffuseColor = new Color3(0.42, 0.32, 0.24);
    soilMat.specularColor = new Color3(0.02, 0.02, 0.02);
    soil.material = soilMat;
    soil.isPickable = false;
    const cropRoot = new TransformNode(`farmCrop_${id}`, this.scene);
    cropRoot.parent = node;
    const plot: FarmPlot = { id, node, crop: null, stage: 0, plantedAt: 0, growSec: 75, meshes: [soil] };
    this.farm.push(plot);

    this.register({
      kind: "farm", label: "农田", pos: pos.add(new Vector3(0, 0.6, 0)), data: plot,
      valid: () => true,
      act: () => this.useFarm(plot),
    });
  }

  useFarm(plot: FarmPlot) {
    if (!plot.crop) {
      plot.crop = "wheat";
      plot.stage = 1;
      plot.plantedAt = Date.now();
      this.growMeshes(plot);
      this.onEvent?.("planted", plot.id);
    } else if (plot.stage >= 3) {
      plot.crop = null;
      plot.stage = 0;
      this.growMeshes(plot);
      this.inv.add("wheat", 3);
      this.onEvent?.("harvested", { plot: plot.id, item: "wheat", count: 3 });
    } else {
      this.onEvent?.("toast", "作物还在生长，等它成熟吧。");
    }
  }

  growMeshes(plot: FarmPlot) {
    for (const m of plot.meshes.slice(1)) m.dispose();
    plot.meshes = [plot.meshes[0]];
    if (!plot.crop || plot.stage === 0) return;
    const h = 0.25 + plot.stage * 0.3;
    for (const [dx, dz] of [[-1, -0.6], [0, -0.6], [1, -0.6], [-1, 0.6], [0, 0.6], [1, 0.6]]) {
      const stalk = MeshBuilder.CreateCylinder(`wheat_${plot.id}`, { height: h, diameter: 0.09, tessellation: 5 }, this.scene);
      stalk.position.set(dx, h / 2 + 0.2, dz);
      stalk.parent = plot.node;
      const mat = new StandardMaterial(`wheatMat_${plot.id}_${dx}_${dz}`, this.scene);
      if (plot.stage >= 3) {
        mat.diffuseColor = new Color3(0.85, 0.72, 0.35);
        mat.emissiveColor = new Color3(0.15, 0.1, 0.02);
      } else {
        mat.diffuseColor = new Color3(0.45, 0.65, 0.3);
      }
      mat.specularColor = new Color3(0.02, 0.02, 0.02);
      stalk.material = mat;
      stalk.isPickable = false;
      plot.meshes.push(stalk);
    }
  }

  updateFarmGrowth(dt: number, gardenerTending: boolean) {
    const now = Date.now();
    for (const plot of this.farm) {
      if (!plot.crop || plot.stage >= 3) continue;
      const rate = gardenerTending ? 1.6 : 1;
      if ((now - plot.plantedAt) / 1000 > (plot.growSec / 3) * plot.stage / rate) {
        plot.stage += 1;
        plot.plantedAt = now;
        this.growMeshes(plot);
      }
    }
  }

  update(dt: number) {
    this.updateFarmGrowth(dt, this.gardenerTending);
    if (this.sitting && this.player.mode === "walk") {
      // 坐下时仍允许 E 起身（在 main 处理）
    }
  }
  gardenerTending = false;

  addPickupInteractions() {
    for (const p of this.world.pickups) this.registerPickup(p);
    for (const c of this.world.chests) this.registerChest(c);
  }

  /** 单个拾取物注册(流式加载的岛屿在装载时调用)。 */
  registerPickup(p: PickupDef) {
    this.register({
      kind: "pickup",
      label: ITEMS[p.item].name,
      pos: p.pos,
      valid: () => !p.taken,
      act: () => {
        p.taken = true;
        p.mesh.setEnabled(false);
        this.inv.add(p.item, p.count);
        this.onEvent?.("picked", { item: p.item, count: p.count, uid: p.uid });
      },
    });
  }

  registerChest(c: ChestDef) {
    this.register({
      kind: "chest", label: c.label, pos: c.pos,
      valid: () => !c.opened,
      act: () => {
        c.opened = true;
        for (const g of c.grants) this.inv.add(g.item, g.count);
        this.onEvent?.("chest_opened", { uid: c.uid, grants: c.grants });
      },
    });
  }

  eat(id: ItemId): boolean {
    const def = ITEMS[id];
    if (!def?.food || !this.inv.remove(id, 1)) return false;
    this.player.hunger = Math.min(100, this.player.hunger + def.food.hunger);
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + def.food.hp);
    if (def.food.staminaBonus) this.player.giveFoodBuff(def.food.staminaBonus, def.food.duration ?? 120);
    this.onEvent?.("ate", id);
    return true;
  }
}
