// NPC 角色：Ruike 服饰配色变体 + 行为执行 + 记忆 + LLM 决策循环。
import {
  Scene, Vector3, Color3, TransformNode,
} from "@babylonjs/core";
import { NpcAction, NpcSituation, ItemStack, BUILD_CATALOG, RECIPES, cookRecipe } from "shared";
import type { Player } from "../../world/player";
import type { World } from "../../world/world";
import type { InteractSystem } from "../interact";
import type { BuildSystem } from "../build";
import { Inventory } from "../items";
import { decideNpc, chatNpc, ChatTurn } from "./brain";
import { CHARACTER_FACE_YAW, loadCharacter, CharacterRig } from "../../world/characters";
import { findWalkPath, type WalkPoint } from "./npcPath";


export interface NpcPersona {
  id: string;
  name: string;
  role: string;
  persona: string;
  goal: string;
  color: Color3;
  accent: Color3;
  home: Vector3;
}

export interface NpcMemoryEntry { t: number; text: string; kind: string }

export class NpcActor {
  node: TransformNode;
  meshRoot: TransformNode;
  pos: Vector3;
  state: "idle" | "walking" | "acting" | "sitting" = "idle";
  action: NpcAction | null = null;
  private buildOperationId: string | null = null;
  private seatUid: string | null = null;
  actionUntil = 0;
  memory: NpcMemoryEntry[] = [];
  affinity = 0;
  lastPlan: NpcAction | null = null;
  lastReason = "";
  lastSource: "llm" | "fallback" = "fallback";
  sayText = "";
  sayUntil = 0;
  chatHistory: ChatTurn[] = [];
  onEvent?: (kind: string, data?: unknown) => void;
  private walkTarget: Vector3 | null = null;
  private route: WalkPoint[] = [];
  private routeKey = "";
  private decideTimer: number;
  private bubbleEl: HTMLDivElement | null = null;
  /** 同行/钉位期间挂起自主决策与移动（位置由 CompanionSystem 接管） */
  suspended = false;

  constructor(
    public persona: NpcPersona,
    spawn: Vector3,
    private scene: Scene,
    private deps: {
      world: World;
      player: Player;
      interact: InteractSystem;
      build: BuildSystem;
      inv: Inventory;
      getSituation: (npc: NpcActor) => NpcSituation;
    }
  ) {
    this.pos = spawn.clone();
    this.node = new TransformNode(`npc_${persona.id}`, scene);
    this.node.position.copyFrom(spawn);
    this.meshRoot = new TransformNode(`npcMesh_${persona.id}`, scene);
    this.meshRoot.parent = this.node;
    void this.initVisual(scene);
    this.decideTimer = performance.now() + 3000 + Math.random() * 4000;
  }

  rig: CharacterRig | null = null;
  private lastAnim = "";

  private async initVisual(scene: Scene) {
    try {
      const kind = this.persona.id === "yan" ? "yan" : "ling";
      const rig = await loadCharacter(scene, kind, kind === "yan" ? 1.74 : 1.62);
      this.rig = rig;
      rig.root.parent = this.meshRoot;
      this.meshRoot.rotation.y = CHARACTER_FACE_YAW;
      this.playAnim("Idle");
    } catch (e) {
      console.warn(`[npc] ${this.persona.id} character load failed`, e);
    }
  }

  private playAnim(name: string, loop = true, speed = 1) {
    if (this.lastAnim === name) return;
    this.lastAnim = name;
    this.rig?.play(name, loop, speed);
  }

  say(text: string, seconds = 6) {
    this.sayText = text;
    this.sayUntil = performance.now() + seconds * 1000;
    this.remember(text, "said", true);
  }

  remember(text: string, kind: string, quiet = false) {
    this.memory.push({ t: Date.now(), text: text.slice(0, 600), kind: kind.slice(0, 64) });
    if (this.memory.length > 60) this.memory.splice(0, this.memory.length - 60);
    if (!quiet) this.onEvent?.("npc_memory", { id: this.persona.id, text });
  }

  /** 沿缓存网格路线行走；blocked 与 arrived 必须由调用者区别处理。 */
  private walkTo(target: Vector3, dt: number, arrivalDistance = 0.6): "moving" | "arrived" | "blocked" {
    const planarDistance = Math.hypot(target.x - this.pos.x, target.z - this.pos.z);
    if (planarDistance < arrivalDistance) {
      this.route = [];
      this.routeKey = "";
      return "arrived";
    }
    const home = this.deps.world.islands[0];
    const canStand = (x: number, z: number) => {
      if (home.canWalkAt && !home.canWalkAt(x, z)) return false;
      return !this.deps.build.buildings.some((b) => {
        const part = BUILD_CATALOG.find((p) => p.id === b.partId);
        return !!part && Math.abs(b.pos.x - x) < part.size[0] / 2 + 0.45 && Math.abs(b.pos.z - z) < part.size[2] / 2 + 0.45;
      });
    };
    const key = `${target.x.toFixed(2)},${target.z.toFixed(2)},${arrivalDistance.toFixed(2)}`;
    if (key !== this.routeKey) {
      const path = findWalkPath(this.pos, target, { canStand, arrivalDistance });
      this.routeKey = key;
      this.route = path.points;
      if (!path.reachable) return "blocked";
    }
    while (this.route.length && Math.hypot(this.route[0].x - this.pos.x, this.route[0].z - this.pos.z) < 0.08) this.route.shift();
    const waypoint = this.route[0];
    if (!waypoint || !canStand(waypoint.x, waypoint.z)) return "blocked";
    const dx = waypoint.x - this.pos.x, dz = waypoint.z - this.pos.z;
    const distanceToWaypoint = Math.hypot(dx, dz);
    const step = Math.min(distanceToWaypoint, 2.3 * dt);
    const nx = this.pos.x + dx / distanceToWaypoint * step;
    const nz = this.pos.z + dz / distanceToWaypoint * step;
    const h = home.heightAt(nx, nz);
    if (h === null || !canStand(nx, nz)) return "blocked";
    this.pos.x = nx; this.pos.z = nz; this.pos.y = h;
    const targetRot = Math.atan2(dx, dz);
    let diff = targetRot - this.node.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.node.rotation.y += diff * Math.min(1, 8 * dt);
    this.state = "walking";
    if (Math.hypot(target.x - this.pos.x, target.z - this.pos.z) < arrivalDistance) {
      this.route = [];
      this.routeKey = "";
      return "arrived";
    }
    return "moving";
  }

  private pathBlocked(message = "路线不通，未执行原定动作。") {
    this.walkTarget = null;
    this.route = [];
    this.routeKey = "";
    this.deps.interact.gardenerTending = false;
    this.finishAction(message, "path_blocked");
  }

  update(dt: number) {
    if (this.suspended) return;
    const now = performance.now();

    // 决策循环
    if (this.state === "idle" && !this.action && now > this.decideTimer) {
      this.decideTimer = now + 16000 + Math.random() * 12000;
      void this.decide();
    }

    // 执行当前动作
    if (this.action) {
      const a = this.action;
      if (a.type === "move_to" && a.target) {
        const t = new Vector3(a.target[0], this.pos.y, a.target[2]);
        const result = this.walkTo(t, dt);
        if (result === "arrived") this.finishAction("到达目的地。");
        else if (result === "blocked") this.pathBlocked("没能抵达目的地。");
      } else if (a.type === "wander") {
        if (!this.walkTarget) {
          const home = this.deps.world.islands[0];
          const ang = Math.random() * Math.PI * 2;
          const r = 6 + Math.random() * 12;
          const tx = this.persona.home.x + Math.cos(ang) * r;
          const tz = this.persona.home.z + Math.sin(ang) * r;
          const h = home.heightAt(tx, tz);
          if (h !== null) this.walkTarget = new Vector3(tx, h, tz);
        }
        if (!this.walkTarget) this.pathBlocked("没有找到可散步的地点，留在原地。");
        else {
          const result = this.walkTo(this.walkTarget, dt);
          if (result === "blocked") this.pathBlocked("散步路线不通，留在原地。");
          else if (result === "arrived") {
            this.walkTarget = null;
            this.finishAction("散了散步。");
          }
        }
      } else if (a.type === "use_facility" && a.target) {
        const result = this.walkTo(new Vector3(a.target[0], this.pos.y, a.target[2]), dt, 1.4);
        if (result === "blocked") this.pathBlocked("没能走到设施旁，未使用设施。");
        else if (result === "arrived") {
          this.state = "acting";
          if (now > this.actionUntil) this.finishAction(a.say ?? "使用设施。");
        }
      } else if (a.type === "tend_farm") {
        this.deps.interact.gardenerTending = true;
        if (!this.walkTarget) {
          const plot = this.deps.interact.farm.find((f) => f.crop);
          if (plot) {
            this.walkTarget = plot.node.position.add(new Vector3(1.4, 0, 1.4));
          } else { this.finishAction("田里暂时不需要照料。"); return; }
        }
        const result = this.walkTo(this.walkTarget, dt);
        if (result === "blocked") this.pathBlocked("没能抵达农田，未照料作物。");
        else if (result === "arrived") {
          this.state = "acting";
          if (now > this.actionUntil) {
            this.deps.interact.gardenerTending = false;
            this.walkTarget = null;
            this.finishAction("照料过田里的作物，它们会长得更快。", "tend_farm");
          }
        }
      } else if (a.type === "harvest_farm") {
        if (!this.walkTarget) {
          const plot = this.deps.interact.farm.find((f) => f.stage >= 3);
          if (plot) this.walkTarget = plot.node.position.add(new Vector3(1.2, 0, 1.2));
          else { this.finishAction("没有可收获的作物。"); return; }
        }
        const result = this.walkTo(this.walkTarget, dt);
        if (result === "blocked") this.pathBlocked("没能抵达农田，未收获作物。");
        else if (result === "arrived") {
          const plot = this.deps.interact.farm.find((f) => f.stage >= 3);
          if (plot) this.deps.interact.useFarm(plot);
          this.walkTarget = null;
          this.finishAction("把成熟的作物收进了库房。", "harvest_farm");
        }
      } else if (a.type === "cook") {
        const stove = this.deps.interact.stovePos;
        if (!stove) { this.finishAction("还没有灶台。"); return; }
        // 站位在灶台 AABB（含 0.45 行走缓冲）之外，否则 canStand 恒 false 永远"走不到"
        const stovePart = BUILD_CATALOG.find((p) => p.use === "cook");
        const standOff = stovePart ? { x: stovePart.size[0] / 2 + 0.9, z: stovePart.size[2] / 2 + 0.9 } : { x: 1.8, z: 1.2 };
        const result = this.walkTo(stove.add(new Vector3(standOff.x, 0, standOff.z)), dt);
        if (result === "blocked") this.pathBlocked("没能抵达灶台，未开始烹饪。");
        else if (result === "arrived") {
          this.state = "acting";
          if (now > this.actionUntil) {
            // 与玩家灶台共用同一份目录与 cookRecipe 规则
            const inv = this.deps.inv;
            const recipe = RECIPES.find((r) => Object.entries(r.cost).every(([id, n]) => !n || inv.count(id) >= n));
            if (recipe && cookRecipe(inv, recipe)) {
              this.finishAction(`按菜谱做了${recipe.name}，放在灶台上了。`, "cook_ok");
            } else {
              this.finishAction("食材不够，下次再来做饭。");
            }
          }
        }
      } else if (a.type === "build_part" && a.partId) {
        this.execBuild(a, dt);
      } else if (a.type === "sit") {
        const seat = this.seatUid ? this.deps.interact.chairSeats.find((entry) => entry.uid === this.seatUid) : this.deps.interact.chairSeats
          .filter((entry) => !entry.occupant).sort((x, y) => Vector3.DistanceSquared(x.pos, this.pos) - Vector3.DistanceSquared(y.pos, this.pos))[0];
        if (!seat || seat.occupant && seat.occupant !== this.persona.id) { this.finishAction(); return; }
        this.seatUid = seat.uid; seat.occupant = this.persona.id;
        const result = this.walkTo(seat.pos, dt, 1.1);
        if (result === "blocked") this.pathBlocked("没能走到座椅旁，未坐下休息。");
        else if (result === "arrived") {
          this.state = "sitting";
          if (now > this.actionUntil) {
            this.state = "idle";
            this.finishAction(a.say ?? "休息了一会儿。", "sit");
          }
        }
      } else if (a.type === "talk_to_player") {
        this.state = "acting";
        const p = this.deps.player.node.position;
        const rot = Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
        this.node.rotation.y = rot;
        if (now > this.actionUntil) this.finishAction("和玩家聊了几句。", "talk");
      } else if (a.type === "idle") {
        this.state = "acting";
        if (now > this.actionUntil) this.finishAction();
      }
    } else if (this.state === "walking") {
      this.state = "idle";
    }

    // 骨骼动画状态
    if (this.state === "walking") this.playAnim("Walking_A");
    else if (this.state === "sitting") this.playAnim("Sit_Chair_Idle");
    else if (this.state === "acting") this.playAnim("Interact");
    else this.playAnim("Idle");

    this.node.position.copyFrom(this.pos);
  }

  private execBuild(a: NpcAction, dt: number) {
    const zone = this.deps.build.buildZone;
    const part = BUILD_CATALOG.find((p) => p.id === a.partId);
    if (!zone || !part) { this.finishAction("没有建设授权或部件不可用。"); return; }
    // 目标位置：动作给定点，否则授权区内随机点
    let pos: Vector3;
    if (a.target) {
      const home = this.deps.world.islands[0];
      const h = home.heightAt(home.root.position.x + a.target[0], home.root.position.z + a.target[2]);
      pos = new Vector3(home.root.position.x + a.target[0], (h ?? 0) + 0.05, home.root.position.z + a.target[2]);
    } else {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * zone.radius * 0.7;
      pos = zone.center.add(new Vector3(Math.cos(ang) * r, 0.05, Math.sin(ang) * r));
    }
    const rotY = a.rotY ?? Math.random() * Math.PI * 2;
    // 先走到位置再放
    if (!this.walkTarget) this.walkTarget = pos.add(new Vector3(1.6, 0, 1.6));
    const result = this.walkTo(this.walkTarget, dt);
    if (result === "blocked") {
      this.pathBlocked(`没能抵达「${part.name}」的建设位置，未放置。`);
    } else if (result === "arrived") {
      this.walkTarget = null;
      const placed = this.deps.build.npcTryBuild(part.id, pos, rotY, this.buildOperationId ?? undefined);
      if (placed) {
        this.finishAction(`在授权区放下了「${part.name}」。`, "build_ok");
        this.onEvent?.("npc_built", { npc: this.persona.id, partId: a.partId, uid: placed.uid });
      } else {
        this.finishAction(`试着放置「${part.name}」但没有成功，换个主意。`, "build_fail");
      }
    }
  }

  private finishAction(memory: string = "", kind = "act") {
    if (this.seatUid) { const seat = this.deps.interact.chairSeats.find((entry) => entry.uid === this.seatUid); if (seat?.occupant === this.persona.id) seat.occupant = null; this.seatUid = null; }
    if (memory) this.remember(memory, kind);
    this.action = null;
    this.buildOperationId = null;
    this.state = "idle";
    this.decideTimer = performance.now() + 4000 + Math.random() * 6000;
  }

  async decide() {
    const s = this.deps.getSituation(this);
    const d = await decideNpc(s);
    this.lastPlan = d.action;
    this.lastReason = d.reason;
    this.lastSource = d.source;
    this.applyAction(d.action, d.reason);
  }

  applyAction(a: NpcAction, reason: string) {
    if (this.action) this.finishAction();
    const dur = (a.duration ?? 6) * 1000;
    this.action = a;
    this.buildOperationId = a.type === "build_part" ? `${this.persona.id}:${Date.now()}:${Math.random().toString(36).slice(2)}` : null;
    this.actionUntil = performance.now() + dur;
    this.state = a.type === "move_to" || a.type === "wander" ? "walking" : "acting";
    if (reason) this.remember(reason, "plan");
    // 动作伴随的台词在动作开始时说一次即可；执行循环里不再重复
    if (a.type === "talk_to_player" && a.say) this.say(a.say);
    this.onEvent?.("npc_action", { id: this.persona.id, action: a, reason, source: this.lastSource });
  }

  async chat(text: string): Promise<string> {
    text = text.slice(0, 600);
    const s = this.deps.getSituation(this);
    this.chatHistory.push({ role: "player", text });
    const r = await chatNpc(s, this.chatHistory.slice(-8), text);
    this.chatHistory.push({ role: "npc", text: r.reply });
    this.remember(`玩家说：“${text}”，我回应了。`, "chat");
    if (r.action) this.applyAction(r.action, "对话中答应的安排");
    this.say(r.reply, 8);
    return r.reply;
  }

  /** DOM 气泡定位点 */
  headWorldPos(): Vector3 {
    return this.node.position.add(new Vector3(0, 2.1, 0));
  }

  loadMemory(list: NpcMemoryEntry[]) {
    this.memory = list.map((m) => ({ ...m }));
  }
}

// Bubble 渲染由 HUD 负责；此处仅记录文本。
