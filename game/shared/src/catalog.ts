// 可编辑内容目录：物品、建造部件、食谱、任务。
// 数据外置于 game/content/*.json，稳定 ID 串联模型、获得、制作、使用与保存；
// validateCatalog 在启动与测试时校验引用完整性，杜绝悬空引用。
import itemsJson from "../../content/items.json";
import buildPartsJson from "../../content/build-parts.json";
import recipesJson from "../../content/recipes.json";
import questsJson from "../../content/quests.json";

export type ItemId = string;
export type BuildPartId = string;

export interface ItemStack {
  id: ItemId;
  count: number;
}

export interface ItemDef {
  id: ItemId;
  name: string;
  desc: string;
  kind: "material" | "food" | "key" | "weapon";
  /** 食用效果 */
  food?: { hunger: number; hp: number; staminaBonus?: number; duration?: number };
  /** 武器 */
  weapon?: { damage: number; range: number; cooldown: number };
}

export const ITEMS: Record<ItemId, ItemDef> = itemsJson as unknown as Record<ItemId, ItemDef>;

export type BuildCategory = "structure" | "furniture" | "deco" | "facility";

export interface BuildPartDef {
  id: BuildPartId;
  name: string;
  category: BuildCategory;
  cost: Partial<Record<ItemId, number>>;
  /** 占位尺寸（米）：x 宽、y 高、z 深 */
  size: [number, number, number];
  /** 需要解锁条件（任务/等级） */
  unlock?: { homeLevel?: number; quest?: string };
  /** 家具可用方式 */
  use?: "sit" | "cook" | "craft" | "none";
  /** 灯光 */
  light?: boolean;
  /** 视觉模型（相对 /assets/ 的 GLB 路径；换模型只改这里） */
  model?: { file: string; /** 覆盖归一化目标宽（米），缺省用 size[0] */ width?: number };
  desc: string;
}

export const BUILD_CATALOG: BuildPartDef[] = buildPartsJson as unknown as BuildPartDef[];

export interface RecipeDef {
  id: string;
  name: string;
  cost: Partial<Record<ItemId, number>>;
  out: { id: ItemId; count: number };
}

export const RECIPES: RecipeDef[] = recipesJson as unknown as RecipeDef[];

export interface QuestStep {
  id: string;
  title: string;
  desc: string;
  /** 完成所需的标记事件 */
  done: string;
}

export interface QuestDef {
  id: string;
  name: string;
  steps: QuestStep[];
}

export const QUESTS: QuestDef[] = questsJson as unknown as QuestDef[];

/** 执行一次配方：校验可支付、扣料、产出。玩家面板与 NPC 共用这一份规则。 */
export function cookRecipe(inv: { count(id: ItemId): number; remove(id: ItemId, n: number): boolean; add(id: ItemId, n: number): void }, recipe: RecipeDef): boolean {
  if (!Object.entries(recipe.cost).every(([id, n]) => !n || inv.count(id) >= n)) return false;
  for (const [id, n] of Object.entries(recipe.cost)) {
    if (n && !inv.remove(id, n)) return false;
  }
  inv.add(recipe.out.id, recipe.out.count);
  return true;
}

/** 目录引用完整性校验，返回问题列表（空数组=通过）。 */
export function validateCatalog(): string[] {
  const problems: string[] = [];
  const itemIds = new Set(Object.keys(ITEMS));
  for (const [id, def] of Object.entries(ITEMS)) {
    if (def.id !== id) problems.push(`items: ${id} 的 id 字段不一致`);
  }
  const partIds = new Set<string>();
  for (const part of BUILD_CATALOG) {
    if (partIds.has(part.id)) problems.push(`build-parts: 重复 id ${part.id}`);
    partIds.add(part.id);
    for (const [costId, n] of Object.entries(part.cost)) {
      if (!itemIds.has(costId)) problems.push(`build-parts: ${part.id} 成本引用了不存在的物品 ${costId}`);
      if (n !== undefined && n < 0) problems.push(`build-parts: ${part.id} 成本为负数`);
    }
    if (part.unlock?.quest && !QUESTS.some((q) => q.id === part.unlock!.quest)) {
      problems.push(`build-parts: ${part.id} 解锁引用了不存在的任务 ${part.unlock.quest}`);
    }
    if (!part.desc) problems.push(`build-parts: ${part.id} 缺少描述`);
  }
  for (const recipe of RECIPES) {
    for (const [costId, n] of Object.entries(recipe.cost)) {
      if (!itemIds.has(costId)) problems.push(`recipes: ${recipe.id} 成本引用了不存在的物品 ${costId}`);
      if (n !== undefined && n <= 0) problems.push(`recipes: ${recipe.id} 成本非正数`);
    }
    if (!itemIds.has(recipe.out.id)) problems.push(`recipes: ${recipe.id} 产出引用了不存在的物品 ${recipe.out.id}`);
    if (recipe.out.count <= 0) problems.push(`recipes: ${recipe.id} 产出数量非正数`);
  }
  const questIds = new Set<string>();
  for (const quest of QUESTS) {
    if (questIds.has(quest.id)) problems.push(`quests: 重复 id ${quest.id}`);
    questIds.add(quest.id);
    if (!quest.steps.length) problems.push(`quests: ${quest.id} 没有任何步骤`);
  }
  return problems;
}
