import { expect, it } from "vitest";
import { BUILD_CATALOG, ITEMS, QUESTS, RECIPES, cookRecipe, validateCatalog } from "shared";

it("外置内容目录引用完整，无悬空 ID", () => {
  expect(validateCatalog()).toEqual([]);
  expect(Object.keys(ITEMS).length).toBeGreaterThanOrEqual(10);
  expect(BUILD_CATALOG.length).toBeGreaterThanOrEqual(10);
  expect(QUESTS.map((q) => q.id)).toContain("first_expedition");
});

it("模型文件在 public 资产目录真实存在（目录→磁盘对应）", async () => {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const publicRoot = resolve(__dirname, "../../client/public/assets");
  for (const part of BUILD_CATALOG) {
    if (!part.model) continue;
    expect(existsSync(resolve(publicRoot, `${part.model.file}.glb`)), part.model.file).toBe(true);
  }
});

it("cookRecipe 是唯一烹饪规则：校验、扣料、产出一致", () => {
  const makeInv = (stacks: { id: string; count: number }[]) => {
    const inv = {
      stacks: [...stacks],
      count(id: string) { return inv.stacks.find((s) => s.id === id)?.count ?? 0; },
      remove(id: string, n: number) {
        const s = inv.stacks.find((x) => x.id === id);
        if (!s || s.count < n) return false;
        s.count -= n;
        inv.stacks = inv.stacks.filter((x) => x.count > 0);
        return true;
      },
      add(id: string, n: number) {
        const s = inv.stacks.find((x) => x.id === id);
        if (s) s.count += n; else inv.stacks.push({ id, count: n });
      },
    };
    return inv;
  };
  const soup = RECIPES.find((r) => r.id === "mushroom_soup")!;
  const bun = RECIPES.find((r) => r.id === "steamed_bun")!;
  // 材料不足拒绝且不扣料
  const poor = makeInv([{ id: "cloudmushroom", count: 1 }]);
  expect(cookRecipe(poor, soup)).toBe(false);
  expect(poor.count("cloudmushroom")).toBe(1);
  // 成功：扣料并产出（蒸饼=NPC 补齐的配方，玩家/NPC 共用）
  const rich = makeInv([{ id: "wheat", count: 4 }]);
  expect(cookRecipe(rich, bun)).toBe(true);
  expect(rich.count("wheat")).toBe(2);
  expect(rich.count("steamed_bun")).toBe(1);
  // 烤云菇按菜谱名产出 ×2（资源守恒与 NPC 行为一致）
  const roast = RECIPES.find((r) => r.id === "roast_mushroom")!;
  const cooker = makeInv([{ id: "cloudmushroom", count: 2 }]);
  expect(cookRecipe(cooker, roast)).toBe(true);
  expect(cooker.count("roast_mushroom")).toBe(2);
});
