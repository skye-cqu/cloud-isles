// 四分支持续项目与家园五阶段（M4 已批准规则）。
// 生命周期：提议（扣提议成本）→ 玩家批准 → 执行（每步执行时核验+原子扣款）／暂停／受阻 → 完成或取消。
// 取消保留已完成建设；未执行步骤不扣款（执行时扣款语义下天然成立）。
import type { ItemId } from "./catalog.js";

// ---------- 分支定义 ----------

export type BranchId = "explore" | "life" | "craft" | "society";

export interface BranchDef {
  id: BranchId;
  name: string;
  /** 完成后解锁的设施部件（build-parts.json） */
  facilityPartId: string;
  /** 提议成本（批准前扣除；取消不退——提议消耗的是勘察/方案） */
  proposeCost: Partial<Record<ItemId, number>>;
  /** 提议台词（NPC 说的） */
  pitch: string;
}

export const BRANCHES: Record<BranchId, BranchDef> = {
  explore: {
    id: "explore", name: "云路观测台", facilityPartId: "obs_tower",
    proposeCost: { windcrystal: 2, wisp_essence: 1 },
    pitch: "造一座云路观测台吧，能望见还没去过的岛。要风晶和雾灵精华。",
  },
  life: {
    id: "life", name: "共生庭院", facilityPartId: "garden_bed",
    proposeCost: { wheat: 4, cloudmushroom: 2 },
    pitch: "我想打理一座共生庭院，作物会熟得更快，宠物也有地方待。",
  },
  craft: {
    id: "craft", name: "风锻台", facilityPartId: "forge_anvil",
    proposeCost: { floatstone: 3, windcrystal: 1, wisp_essence: 1 },
    pitch: "搭起风锻台，你的风刃长剑就能蓄力风斩。浮石、风晶和精华我都要一点。",
  },
  society: {
    id: "society", name: "公共协作工坊", facilityPartId: "work_board",
    proposeCost: { floatstone: 2, wheat: 3 },
    pitch: "建个协作工坊立一块项目板，家园的事就能一件件排着来。",
  },
};

export const BRANCH_IDS: BranchId[] = ["explore", "life", "craft", "society"];

// ---------- 项目记录与状态机 ----------

export type ProjectState = "proposed" | "approved" | "executing" | "paused" | "blocked" | "completed" | "cancelled";

export interface ProjectRecord {
  /** 稳定 ID：proj-<branch>（每分支一个完整项目） */
  id: string;
  branch: BranchId;
  state: ProjectState;
  /** 设施是否已建成（拆除后里程碑保留、功能离线） */
  built: boolean;
  /** 提议与步骤的全部操作 ID（刷新核对、幂等去重） */
  opIds: string[];
  blockedReason?: string;
  createdAt: number;
  completedAt?: number;
}

export interface InvLike {
  count(id: ItemId): number;
  remove(id: ItemId, n: number): boolean;
  add(id: ItemId, n: number): void;
}

export type Cost = Partial<Record<ItemId, number>>;

export function canAfford(inv: InvLike, cost: Cost): boolean {
  return Object.entries(cost).every(([id, n]) => !n || inv.count(id) >= n);
}

export type Reasoned = { ok: boolean; reason?: string };

/** 每分支一个项目：未取消/未完成的既有项目阻止重复提议。 */
export function canPropose(projects: ProjectRecord[], branch: BranchId, inv: InvLike): Reasoned {
  const existing = projects.find((p) => p.branch === branch);
  if (existing && existing.state !== "cancelled") return { ok: false, reason: `${BRANCHES[branch].name}已有进行中的项目` };
  if (!canAfford(inv, BRANCHES[branch].proposeCost)) return { ok: false, reason: "提议材料不足" };
  return { ok: true };
}

/** 提议：自带原子性校验——材料不足不产生记录不扣款；已取消的项目可重新提议（新 ID）。
 *  opId 幂等：同分支既有记录直接返回（不重复扣）。 */
export function proposeProject(projects: ProjectRecord[], branch: BranchId, inv: InvLike, opId: string, now = Date.now()): { record: ProjectRecord | null; charged: boolean } {
  const existing = projects.find((p) => p.branch === branch && p.state !== "cancelled");
  if (existing) return { record: existing, charged: false };
  if (!canAfford(inv, BRANCHES[branch].proposeCost)) return { record: null, charged: false };
  for (const [id, n] of Object.entries(BRANCHES[branch].proposeCost)) {
    if (n && !inv.remove(id, n)) return { record: null, charged: false };
  }
  const ordinal = projects.filter((p) => p.branch === branch).length + 1;
  const id = ordinal === 1 ? `proj-${branch}` : `proj-${branch}-${ordinal}`;
  const record: ProjectRecord = { id, branch, state: "proposed", built: false, opIds: [opId], createdAt: now };
  projects.push(record);
  return { record, charged: true };
}

export function approveProject(record: ProjectRecord): void {
  if (record.state === "proposed") record.state = "executing";
}

export function pauseProject(record: ProjectRecord): void {
  if (record.state === "executing") record.state = "paused";
}

export function resumeProject(record: ProjectRecord): void {
  if (record.state === "paused") record.state = "executing";
}

/** 受阻（路线冲突/设施被拆等）：如实记录原因，不扣款。 */
export function markBlocked(record: ProjectRecord, reason: string): void {
  if (record.state === "executing") {
    record.state = "blocked";
    record.blockedReason = reason.slice(0, 120);
  }
}

export function resumeBlocked(record: ProjectRecord): void {
  if (record.state === "blocked") {
    record.state = "executing";
    record.blockedReason = undefined;
  }
}

/** 取消：保留已完成建设（built 不动），未执行步骤不扣款。 */
export function cancelProject(record: ProjectRecord): void {
  if (record.state !== "completed") record.state = "cancelled";
}

export function isProjectActive(record: ProjectRecord): boolean {
  return record.state === "proposed" || record.state === "approved" || record.state === "executing" || record.state === "paused" || record.state === "blocked";
}

/** 执行一步：核验（库存≥设施成本）→ 交给执行器原子扣款+放置；执行失败视为未扣款。
 *  executor 返回 false（材料竞争/位置失效等）时调用方负责如实受阻，这里不吞错。 */
export function canExecuteStep(record: ProjectRecord, inv: InvLike, facilityCost: Cost, authorized: boolean): Reasoned {
  if (record.state !== "executing") return { ok: false, reason: `项目处于 ${record.state}，不开始新步骤` };
  if (record.built) return { ok: false, reason: "设施已建成" };
  if (!authorized) return { ok: false, reason: "没有建设授权" };
  if (!canAfford(inv, facilityCost)) return { ok: false, reason: "步骤材料不足" };
  return { ok: true };
}

/** 步骤完成：built=true → completed。幂等（同 opId 重复上报不重复计）。 */
export function completeStep(record: ProjectRecord, opId: string, now = Date.now()): void {
  if (record.opIds.includes(opId)) return;
  record.opIds.push(opId);
  record.built = true;
  record.state = "completed";
  record.completedAt = now;
}

/** 项目板（基础管理入口）：第一次提议后即可用，不要求先完成聚落分支。 */
export function projectBoardUnlocked(projects: ProjectRecord[]): boolean {
  return projects.length > 0;
}

// ---------- 分支设施在线状态 ----------

/** 设施拆除后功能离线：里程碑（completed）保留，效果按"建筑里仍有该部件"判定。 */
export function facilityOnline(buildings: { partId: string; space: string }[], facilityPartId: string, homeSpace: string): boolean {
  return buildings.some((b) => b.partId === facilityPartId && b.space === homeSpace);
}

// ---------- 家园五阶段 ----------

export interface HomeFacts {
  upgradedBerth: boolean;
  branchCompleted: Partial<Record<BranchId, boolean>>;
  /** 有效远征次数（与搭档完成的新岛往返） */
  companionExpeditions: number;
  /** 宠物共同抵达的不同岛屿数 */
  petBondVisits: number;
  hasPet: boolean;
  /** 已访问的生成岛类型（跨类型） */
  generatedTypesVisited: string[];
  /** 航路信标联合项目完成 */
  beaconCompleted: boolean;
}

const countCompleted = (facts: HomeFacts): number => BRANCH_IDS.filter((b) => facts.branchCompleted[b]).length;

/** 五阶段取可达的最高阶段（门槛全部满足才算）。 */
export function homeStage(facts: HomeFacts): 1 | 2 | 3 | 4 | 5 {
  if (!facts.upgradedBerth) return 1;
  const otherDone = BRANCH_IDS.filter((b) => b !== "society" && facts.branchCompleted[b]).length;
  const societyDone = !!facts.branchCompleted.society;
  if (!societyDone || otherDone < 1) return 2;
  if (countCompleted(facts) < 4 || facts.companionExpeditions < 1 || !facts.hasPet || facts.petBondVisits < 1) return 3;
  if (facts.generatedTypesVisited.length < 3 || !facts.beaconCompleted) return 4;
  return 5;
}

export const HOME_STAGE_NAMES: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "落脚之地", 2: "稳定家园", 3: "协作聚落", 4: "远征基地", 5: "云海枢纽",
};

/** 共生庭院效果：农田成熟 75s → 55s（设施在线才生效）。 */
export function farmGrowSec(gardenOnline: boolean): number {
  return gardenOnline ? 55 : 75;
}

// ---------- 有效远征 ----------

export interface ExpeditionRecord {
  /** 每次出航一个操作 ID；反复离泊不新增 */
  opId: string;
  islandId: string;
  completedAt: number;
}

/** 归来结算：有非家园停靠记录才算有效远征；按 opId 幂等。 */
export function recordExpedition(expeditions: ExpeditionRecord[], opId: string, dockedIslandIds: string[], homeIslandId: string, now = Date.now()): ExpeditionRecord | null {
  if (expeditions.some((e) => e.opId === opId)) return null;
  const landed = dockedIslandIds.find((id) => id !== homeIslandId);
  if (!landed) return null;
  const record: ExpeditionRecord = { opId, islandId: landed, completedAt: now };
  expeditions.push(record);
  return record;
}

// ---------- 携行口粮 ----------

/** 出航整备：每份口粮按远征操作 ID 只扣一次；出航前取消不扣（未调用即不扣）。 */
export function provisionExpedition(inv: InvLike, opId: string, provisionedOpIds: string[]): Reasoned {
  if (provisionedOpIds.includes(opId)) return { ok: true };
  if (inv.count("steamed_bun") < 1) return { ok: false, reason: "需要云麦蒸饼×1 作携行口粮" };
  if (!inv.remove("steamed_bun", 1)) return { ok: false, reason: "口粮扣除失败" };
  provisionedOpIds.push(opId);
  return { ok: true };
}

// ---------- 宠物 ----------

/** 羁绊=共同抵达的不同岛屿数；1/2/3 次解锁 15m 云菇/25m 任意/35m 类型提示。 */
export function petHintRadius(bondVisits: number): { radius: number; mode: "mushroom" | "any" | "type" } | null {
  if (bondVisits >= 3) return { radius: 35, mode: "type" };
  if (bondVisits === 2) return { radius: 25, mode: "any" };
  if (bondVisits === 1) return { radius: 15, mode: "mushroom" };
  return null;
}

// ---------- 搭档信任（一次性事实成长） ----------

export interface CompanionTrust {
  /** 完成过一次真实协作项目 → 可邀请同行 */
  canAccompany: boolean;
  /** 新岛远征归来 → 战斗支援（1.4s 一跳 12 伤害） */
  combatSupport: boolean;
  /** 真实共同击败雾灵 → 每次远征一次低血量救援 */
  rescue: boolean;
}

export function companionTrust(jointProjectCompleted: boolean, expeditionReturned: boolean, jointWispDefeated: boolean): CompanionTrust {
  return {
    canAccompany: jointProjectCompleted,
    combatSupport: jointProjectCompleted && expeditionReturned,
    rescue: jointProjectCompleted && expeditionReturned && jointWispDefeated,
  };
}

/** 风锻台成长：蓄力风斩解锁成本（解锁动作本身在锻台处执行）。 */
export const FORGE_UNLOCK_COST: Cost = { windcrystal: 2, wisp_essence: 1 };
