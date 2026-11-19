// 云屿之歌 — 客户端与服务端共用的数据约定。
// 世界空间单位为米；岛屿、云舟及其附属内容保存所属空间与局部位置。
// 物品/建造/食谱/任务等可编辑内容在 catalog.ts（数据外置于 game/content/*.json）。
import type { IslandMutation } from "./world-contract.js";
import type { ItemStack, ItemId } from "./catalog.js";
import type { SavedPersonalPart } from "./create-plan.js";
import type { ProjectRecord, ExpeditionRecord } from "./projects.js";

export * from "./catalog.js";
export * from "./create-plan.js";
export * from "./projects.js";

// ---------- NPC 契约 ----------

export type NpcActionType =
  | "idle"
  | "move_to"
  | "use_facility"
  | "talk_to_player"
  | "cook"
  | "tend_farm"
  | "harvest_farm"
  | "build_part"
  | "sit"
  | "wander";

export interface NpcAction {
  type: NpcActionType;
  /** move_to / build_part 目标点（岛屿局部坐标，米） */
  target?: [number, number, number];
  /** build_part: 部件 id */
  partId?: string;
  /** build_part: 旋转（弧度） */
  rotY?: number;
  /** 动作同时说出的话（可选） */
  say?: string;
  /** 预计执行时长（秒），由决策给出 */
  duration?: number;
}

export interface NpcSituation {
  npcId: string;
  npcName: string;
  persona: string;
  goal: string;
  timeOfDay: string;
  weather: string;
  homeLevel: number;
  hp: number;
  hunger: number;
  /** 岛屿资源库存（家园共享） */
  inventory: ItemStack[];
  /** 农田状态 */
  farm: { plot: string; stage: string; crop: string }[];
  /** 玩家状态：是否在附近、当前任务 */
  playerNearby: boolean;
  playerDoing: string;
  /** 其他 NPC 简况 */
  others: { name: string; doing: string }[];
  /** 设施概况 */
  facilities: { id: string; name: string; usable: boolean }[];
  /** 最近记忆（按时间倒序的简述） */
  recentMemory: string[];
  /** 授权建设区域与预算 */
  buildAuthorization?: { zone: string; budget: Partial<Record<ItemId, number>> } | null;
  /** 最近的对话 */
  recentChat?: { from: string; text: string }[];
}

export interface NpcDecision {
  action: NpcAction;
  /** 决策理由（一句话，写入记忆） */
  reason: string;
  source: "llm" | "fallback";
}

// ---------- 存档 ----------

export interface SavedBuilding {
  uid: string;
  partId: string;
  /** 所属空间：island:<id> 或 ship */
  space: string;
  pos: [number, number, number];
  rotY: number;
}

export interface SavedFarmPlot {
  id: string;
  crop: string | null;
  stage: number;
  plantedAt: number;
}

export interface SavedNpc {
  id: string;
  pos: [number, number, number];
  state: string;
  memory: { t: number; text: string; kind: string }[];
  affinity: number;
  lastPlan?: NpcAction | null;
}

export interface SaveData {
  version: 1 | 2;
  savedAt: number;
  playSeconds: number;
  player: {
    pos: [number, number, number];
    hp: number; hunger: number; stamina: number; xp: number; level: number;
    inventory: ItemStack[];
    equippedWeapon: ItemId | null;
    mode: "walk" | "sail" | "glide";
    foodBuff?: { stamina: number; remainingMs: number } | null;
  };
  ship: { pos: [number, number, number]; rotY: number; docked: boolean; sailUpgraded: boolean; energy?: number };
  buildings: SavedBuilding[];
  farm: SavedFarmPlot[];
  world: {
    collected: string[];
    chests: Record<string, boolean>;
    visited: string[];
    /** 运行时生成岛的卸载保存（可选：旧存档无此字段）。 */
    islandMutations?: Record<string, IslandMutation>;
    worldSeed?: number;
    /** Stable local journey identity; distinct from deterministic seed for cloud session isolation. */
    worldId?: string;
    /** 已到访的生成岛类型（去重，五阶段门槛用）。 */
    generatedTypesVisited?: string[];
    /** 进行中远征的出航标识与已停靠记录（刷新后接续结算）。 */
    journeyOpId?: string;
    journeyDocks?: string[];
  };
  home: {
    level: number; upgradedBerth: boolean; buildZone: [number, number, number] | null;
    buildBudget: Partial<Record<ItemId, number>> | null; authorized: boolean;
    buildAllowedParts?: string[];
    buildZoneRadius?: number;
    authorizationPaused?: boolean;
    /** 运行时个人目录（Lux3D 生成物品）；buildings.partId 允许引用这里的 id */
    personalParts?: SavedPersonalPart[];
    /** 四分支持续项目（M4）。 */
    projects?: ProjectRecord[];
    /** 有效远征记录（按出航 opId 幂等）。 */
    expeditions?: ExpeditionRecord[];
    /** 已扣口粮的远征 opId。 */
    provisionedOpIds?: string[];
    /** 风锻台蓄力风斩已解锁。 */
    forgeUnlocked?: boolean;
    /** 宠物状态（结识后存在）。 */
    pet?: SavedPet;
    /** 搭档（岩）信任事实与同行状态。 */
    companion?: SavedCompanionState;
    /** 航路信标联合项目完成（五阶段门槛）。 */
    beaconCompleted?: boolean;
  };
  npcs: SavedNpc[];
  quests: Record<string, { step: number; done: string[] }>;
  /** v2: events may happen before their quest is current. */
  questFacts?: string[];
  flags: Record<string, boolean>;
}

export { localDecide } from "./npc-engine.js";
export * from "./world-contract.js";
export { isValidSavePayload } from "./save-validation.js";

// ---------- 宠物与搭档存档 ----------

export interface SavedPet {
  /** 模型来源标识（当前固定 "fox"） */
  species: "fox";
  name: string;
  /** island:<id> | ship */
  space: string;
  pos: [number, number, number];
  /** 共同抵达的不同岛屿数=羁绊 */
  bondVisits: number;
  /** 已到访岛屿（去重计羁绊） */
  bondIslands: string[];
  mode: "follow" | "stay";
}

export interface SavedCompanionState {
  /** 已在泊位邀请同行 */
  invited: boolean;
  /** 与岩完成过一次真实协作项目 */
  jointProject: boolean;
  /** 与岩新岛远征归来 */
  expeditionReturned: boolean;
  /** 与岩共同击败雾灵 */
  jointWispKill: boolean;
  /** 本次远征的救援是否已用 */
  rescueUsedThisExpedition: boolean;
}
