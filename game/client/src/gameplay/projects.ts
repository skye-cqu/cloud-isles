// 持续项目系统（M4）：四分支项目生命周期 + 家园五阶段 + 有效远征 + 项目板 UI。
// 规则全部在 shared/projects.ts；本系统负责执行（NPC 走位→就位→原子扣款放置）、保存与界面。
import { Vector3 } from "@babylonjs/core";
import {
  BRANCHES, BRANCH_IDS, BUILD_CATALOG, HOME_STAGE_NAMES, ITEMS,
  approveProject, canPropose, canExecuteStep, completeStep, facilityOnline, farmGrowSec,
  homeStage, markBlocked, pauseProject, proposeProject, provisionExpedition, resumeBlocked,
  resumeProject, cancelProject, recordExpedition,
  type BranchId, type ExpeditionRecord, type HomeFacts, type ProjectRecord,
} from "shared";
import type { Hud } from "../core/ui";
import type { Inventory } from "./items";
import type { BuildSystem } from "./build";
import type { NpcActor } from "./npc/npc";

const HOME_SPACE = "island:home";
/** NPC 建造就位后的表演时长（秒），期间播放 Interact 动作 */
const BUILD_ACT_SECONDS = 5;
/** 同一项目受阻记忆的限频（毫秒） */
const BLOCKED_COOLDOWN_MS = 30_000;

export class ProjectsSystem {
  projects: ProjectRecord[] = [];
  expeditions: ExpeditionRecord[] = [];
  provisionedOpIds: string[] = [];
  forgeUnlocked = false;
  companion = { invited: false, jointProject: false, expeditionReturned: false, jointWispKill: false, rescueUsedThisExpedition: false };
  beaconCompleted = false;
  /** 已到访的生成岛类型（世界探索事实，main 在装载/停靠时注入） */
  generatedTypesVisited: string[] = [];
  /** 泊位整备完成（稳定家园门槛，main 从任务事实注入） */
  homeUpgraded = false;
  /** 宠物事实（宠物系统每帧/事件注入） */
  petBondVisits = 0;
  hasPet = false;
  onEvent?: (kind: string, data?: unknown) => void;

  /** 执行中的建造任务（一次一个） */
  private task: { projectId: string; npcId: string; stage: "walk" | "act"; opId: string; actUntil: number; target: Vector3 } | null = null;
  private boardOpen = false;
  private blockedAt: Record<string, number> = {};
  private farmPlots: { growSec: number }[] | null = null;

  constructor(
    private hud: Hud,
    private inv: Inventory,
    private build: BuildSystem,
    private npcs: () => NpcActor[],
  ) {}

  // ---------- 查询 ----------

  facilityCost(branch: BranchId): Partial<Record<string, number>> {
    return BUILD_CATALOG.find((p) => p.id === BRANCHES[branch].facilityPartId)?.cost ?? {};
  }

  facilityOnline(branch: BranchId): boolean {
    return facilityOnline(this.build.export(), BRANCHES[branch].facilityPartId, HOME_SPACE);
  }

  homeFacts(): HomeFacts {
    return {
      upgradedBerth: this.homeUpgraded,
      branchCompleted: Object.fromEntries(BRANCH_IDS.map((b) => [b, this.projects.some((p) => p.branch === b && p.state === "completed")])) as HomeFacts["branchCompleted"],
      companionExpeditions: this.companion.expeditionReturned ? 1 : 0,
      petBondVisits: this.petBondVisits,
      hasPet: this.hasPet,
      generatedTypesVisited: this.generatedTypesVisited,
      beaconCompleted: this.beaconCompleted,
    };
  }

  stage(): 1 | 2 | 3 | 4 | 5 {
    return homeStage(this.homeFacts());
  }

  gardenOnline(): boolean {
    return this.facilityOnline("life");
  }

  /** 农田成熟秒数（共生庭院在线 55s，否则 75s） */
  farmGrowSec(): number {
    return farmGrowSec(this.gardenOnline());
  }

  branchCompleted(branch: BranchId): boolean {
    return this.projects.some((p) => p.branch === branch && p.state === "completed");
  }

  // ---------- 生命周期 ----------

  /** NPC 对话中的提议：校验→扣提议成本→批准即执行。批准同时把设施部件加入建设授权。 */
  propose(branch: BranchId, npc: NpcActor): boolean {
    const check = canPropose(this.projects, branch, this.inv);
    if (!check.ok) { this.onEvent?.("toast", check.reason ?? "暂时无法提议"); return false; }
    const opId = `proj-${branch}-${Date.now()}`;
    const { record } = proposeProject(this.projects, branch, this.inv, opId);
    if (!record) { this.onEvent?.("toast", "提议失败"); return false; }
    approveProject(record);
    // 设施部件进入授权白名单，预算按设施成本补足上限（玩家刚批准了该项目）
    this.ensureAuthorized(branch);
    npc.remember(`向船长提议了「${BRANCHES[branch].name}」，船长同意了。`, "propose");
    npc.remember(`向船长提议了「${BRANCHES[branch].name}」，船长同意了。`, "propose");
    npc.say(BRANCHES[branch].pitch);
    const costText = Object.entries(BRANCHES[branch].proposeCost).map(([id, n]) => `${ITEMS[id as keyof typeof ITEMS].name}×${n}`).join(" ");
    this.onEvent?.("toast", `项目立项：${BRANCHES[branch].name}（提议消耗 ${costText}）`);
    this.onEvent?.("project_proposed", { branch, id: record.id });
    return true;
  }

  pause(id: string) {
    const record = this.projects.find((p) => p.id === id);
    if (!record) return;
    pauseProject(record);
    this.onEvent?.("project_updated", { id, state: record.state });
    if (this.boardOpen) this.showBoard();
  }

  resume(id: string) {
    const record = this.projects.find((p) => p.id === id);
    if (!record) return;
    if (record.state === "paused") resumeProject(record);
    if (record.state === "blocked") resumeBlocked(record);
    this.ensureAuthorized(record.branch);
    this.onEvent?.("project_updated", { id, state: record.state });
    if (this.boardOpen) this.showBoard();
  }

  cancel(id: string) {
    const record = this.projects.find((p) => p.id === id);
    if (!record) return;
    cancelProject(record);
    this.onEvent?.("project_updated", { id, state: record.state });
    if (this.boardOpen) this.showBoard();
  }

  // ---------- 执行循环 ----------

  update() {
    if (this.task) { this.tickTask(); return; }
    if (!this.build.buildZone || !this.build.buildBudget) return;
    const pending = this.projects.find((p) => p.state === "executing" && !p.built);
    if (!pending) return;
    const npc = this.pickBuilder(pending.branch);
    if (!npc || npc.state !== "idle" || npc.action) return;
    const part = BUILD_CATALOG.find((p) => p.id === BRANCHES[pending.branch].facilityPartId);
    if (!part) return;
    const check = canExecuteStep(pending, this.inv, part.cost, true);
    if (!check.ok) {
      const last = this.blockedAt[pending.id] ?? 0;
      if (Date.now() - last > BLOCKED_COOLDOWN_MS) {
        this.blockedAt[pending.id] = Date.now();
        markBlocked(pending, check.reason ?? "暂无法执行");
        npc.remember(`项目「${BRANCHES[pending.branch].name}」受阻：${check.reason}`, "blocked");
        this.onEvent?.("toast", `项目受阻：${check.reason}`);
      }
      return;
    }
    // 目标点：授权区内偏移一点，避开 zone 中心的其他建筑
    const zone = this.build.buildZone;
    const target = zone.center.add(new Vector3(1.6, 0, 1.6));
    const opId = `${pending.id}:step-${pending.opIds.length + 1}:${Date.now()}`;
    // move_to 用世界坐标（npc.walkTo 直接吃世界点）
    npc.applyAction({ type: "move_to", target: [target.x, 0, target.z], duration: 3 }, `去建设「${part.name}」。`);
    this.task = { projectId: pending.id, npcId: npc.persona.id, stage: "walk", opId, actUntil: 0, target };
  }

  private tickTask() {
    const task = this.task!;
    const record = this.projects.find((p) => p.id === task.projectId);
    const npc = this.npcs().find((n) => n.persona.id === task.npcId) ?? null;
    if (!record || record.state !== "executing" || !npc) { this.task = null; return; }
    if (npc.state === "idle" && !npc.action && task.stage === "walk") {
      // 已就位（或 move_to 被决策循环打断）：进入表演+放置
      task.stage = "act";
      task.actUntil = performance.now() + BUILD_ACT_SECONDS * 1000;
      npc.applyAction({ type: "idle", duration: BUILD_ACT_SECONDS }, `动手建设「${BRANCHES[record.branch].name}」。`);
      return;
    }
    if (task.stage === "act" && performance.now() > task.actUntil) {
      if (npc.state !== "idle" && npc.action) return; // 表演还在进行
      const part = BUILD_CATALOG.find((p) => p.id === BRANCHES[record.branch].facilityPartId);
      const zone = this.build.buildZone;
      if (!part || !zone) { markBlocked(record, "建设授权被收回"); this.task = null; return; }
      const pos = this.findBuildSpot(part, zone.center);
      const placed = pos ? this.build.npcTryBuild(part.id, pos, 0, task.opId) : null;
      if (placed) {
        completeStep(record, task.opId);
        npc.remember(`建成了「${part.name}」。`, "project_build");
        npc.say(`${part.name}建好了！`);
        this.onEvent?.("toast", `项目完成：${part.name}`);
        this.onEvent?.("project_completed", { id: record.id, branch: record.branch, uid: placed.uid });
        this.onProjectCompleted(record.branch);
      } else {
        markBlocked(record, "放置失败（位置被占用或材料不足）");
        npc.remember(`没能建成「${part.name}」。`, "project_fail");
        this.onEvent?.("toast", `项目受阻：${BRANCHES[record.branch].name} 放置失败`);
      }
      this.task = null;
    }
  }

  /** 在授权区内螺旋找可建点（与 homeProps 兜底同思路）：中心被占时向外扩圈。 */
  private findBuildSpot(part: { id: string }, center: Vector3): Vector3 | null {
    const def = BUILD_CATALOG.find((p) => p.id === part.id);
    if (!def) return null;
    const probe = this.build.canPlace(def, center, 0, true);
    if (probe.ok) return center.add(new Vector3(0, 0.05, 0));
    for (const r of [1.2, 2.0, 2.8, 3.6]) {
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const cand = center.add(new Vector3(Math.cos(ang) * r, 0.05, Math.sin(ang) * r));
        if (this.build.canPlace(def, cand, 0, true).ok) return cand;
      }
    }
    return null;
  }

  /** 设施部件进授权白名单 + 预算按设施成本补足上限（幂等；项目批准/恢复时调用） */
  private ensureAuthorized(branch: BranchId) {
    if (!this.build.buildZone) return;
    const part = BUILD_CATALOG.find((p) => p.id === BRANCHES[branch].facilityPartId);
    if (!part) return;
    const budget = { ...(this.build.buildBudget ?? {}) };
    for (const [id, n] of Object.entries(part.cost)) {
      budget[id] = Math.max(budget[id] ?? 0, (n ?? 0) + 1);
    }
    this.build.authorizeBudget(budget, [...new Set([...this.build.buildAllowedParts, part.id])]);
  }

  private pickBuilder(branch: BranchId): NpcActor | null {
    const prefer = branch === "life" ? "ling" : "yan";
    return this.npcs().find((n) => n.persona.id === prefer) ?? this.npcs()[0] ?? null;
  }

  /** 分支完成的效果钩子 */
  private onProjectCompleted(branch: BranchId) {
    if (branch === "life" && this.farmPlots) {
      const grow = this.farmGrowSec();
      for (const plot of this.farmPlots) plot.growSec = grow;
      this.onEvent?.("garden_online", { growSec: grow });
    }
    if (branch === "society") this.companion.jointProject = true;
  }

  /** main 把农田列表交给项目系统（garden 完成时统一改 growSec；启动时按在线状态初始化） */
  attachFarmPlots(plots: { growSec: number }[]) {
    this.farmPlots = plots;
    if (this.gardenOnline()) {
      const grow = this.farmGrowSec();
      for (const plot of plots) plot.growSec = grow;
    }
  }

  /** 探索事实：到访生成岛类型（去重） */
  noteIslandType(type: string) {
    if (type && !this.generatedTypesVisited.includes(type)) this.generatedTypesVisited.push(type);
  }

  // ---------- 远征 ----------

  /** 出航整备（带搭档时）：口粮按本次出航 opId 只扣一次。 */
  provision(opId: string): boolean {
    if (!this.companion.invited) return true;
    const result = provisionExpedition(this.inv, opId, this.provisionedOpIds);
    if (!result.ok) this.onEvent?.("toast", result.reason ?? "整备失败");
    return result.ok;
  }

  /** 归航结算：有非家园停靠记录时记一次有效远征。 */
  settleExpedition(opId: string, dockedIslandIds: string[], homeIslandId: string) {
    if (!this.companion.invited) return;
    const record = recordExpedition(this.expeditions, opId, dockedIslandIds, homeIslandId);
    if (record) {
      this.companion.expeditionReturned = true;
      this.companion.rescueUsedThisExpedition = false;
      this.onEvent?.("toast", "远征归来：搭档对你的信任更深了。");
      this.onEvent?.("expedition_returned", { islandId: record.islandId });
    }
  }

  /** 与岩共同击败雾灵（main 的 wisp_defeated 里调用） */
  noteJointWispKill() {
    if (this.companion.invited) this.companion.jointWispKill = true;
  }

  // ---------- 项目板 UI ----------

  showBoard() {
    this.boardOpen = true;
    const stage = this.stage();
    const rows = this.projects.length
      ? this.projects.map((p) => {
          const stateText: Record<string, string> = { proposed: "待批准", approved: "已批准", executing: "执行中", paused: "已暂停", blocked: `受阻：${p.blockedReason ?? ""}`, completed: "已完成", cancelled: "已取消" };
          const actions = p.state === "executing" ? `<button class="projAct" data-act="pause" data-id="${p.id}">暂停</button><button class="projAct" data-act="cancel" data-id="${p.id}">取消</button>`
            : p.state === "paused" || p.state === "blocked" ? `<button class="projAct" data-act="resume" data-id="${p.id}">继续</button><button class="projAct" data-act="cancel" data-id="${p.id}">取消</button>` : "";
          return `<div style="border:1px solid rgba(255,255,255,.15); border-radius:8px; padding:8px 10px; margin-bottom:6px;">
            <div style="font-size:14px; color:#fff;">${BRANCHES[p.branch].name} <span style="font-size:12px; color:#9fb6c9;">${stateText[p.state] ?? p.state}</span></div>
            <div style="font-size:12px; opacity:.75; margin-top:2px;">${p.built ? "设施已建成" : "设施未建成"}${p.completedAt ? " · " + new Date(p.completedAt).toLocaleString() : ""}</div>
            <div style="margin-top:4px;">${actions}</div></div>`;
        }).join("")
      : '<div style="opacity:.6; font-size:13px;">还没有项目。和居民聊聊，听听他们的提议。</div>';
    this.hud.showPanel("项目板 · 家园规划", [
      `<div style="font-size:13px; color:#f0c878; margin-bottom:8px;">家园阶段：${HOME_STAGE_NAMES[stage]}（${stage}/5）</div>`,
      rows,
      `<div style="font-size:12px; opacity:.7; margin-top:8px;">Esc 关闭</div>`,
    ].join(""), () => { this.boardOpen = false; });
    this.hud.panelBody.querySelectorAll<HTMLButtonElement>(".projAct").forEach((el) => {
      el.addEventListener("click", () => {
        const act = el.dataset.act, id = el.dataset.id!;
        if (act === "pause") this.pause(id);
        else if (act === "resume") this.resume(id);
        else if (act === "cancel") this.cancel(id);
      });
    });
  }

  closeBoard() {
    if (this.boardOpen) this.hud.hidePanel();
    this.boardOpen = false;
  }

  get isBoardOpen(): boolean { return this.boardOpen; }

  // ---------- 保存 ----------

  hydrate(home: {
    projects?: ProjectRecord[]; expeditions?: ExpeditionRecord[]; provisionedOpIds?: string[];
    forgeUnlocked?: boolean; companion?: ProjectsSystem["companion"]; beaconCompleted?: boolean;
    generatedTypesVisited?: string[];
  }) {
    this.projects = home.projects ?? [];
    this.expeditions = home.expeditions ?? [];
    this.provisionedOpIds = home.provisionedOpIds ?? [];
    this.forgeUnlocked = home.forgeUnlocked ?? false;
    if (home.companion) this.companion = { ...home.companion };
    this.beaconCompleted = home.beaconCompleted ?? false;
    this.generatedTypesVisited = home.generatedTypesVisited ?? [];
  }

  exportHome() {
    return {
      projects: this.projects,
      expeditions: this.expeditions,
      provisionedOpIds: this.provisionedOpIds,
      forgeUnlocked: this.forgeUnlocked,
      companion: this.companion,
      beaconCompleted: this.beaconCompleted,
    };
  }
}
