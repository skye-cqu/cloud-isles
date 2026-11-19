import { describe, it, expect } from "vitest";
import { BUILD_CATALOG, ITEMS, QUESTS, ItemId } from "shared";

describe("shared 数据目录完整性", () => {
  it("BUILD_CATALOG 引用的物品 id 都存在于 ITEMS", () => {
    for (const part of BUILD_CATALOG) {
      for (const [id, n] of Object.entries(part.cost)) {
        expect(ITEMS[id as ItemId], `${part.id} 成本物品 ${id}`).toBeDefined();
        expect(n, `${part.id} 成本 ${id} 不应为负`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("BUILD_CATALOG 解锁引用的任务都存在于 QUESTS", () => {
    for (const part of BUILD_CATALOG) {
      if (part.unlock) {
        expect(QUESTS.find((q) => q.id === part.unlock!.quest), `${part.id} 解锁任务 ${part.unlock.quest}`).toBeDefined();
      }
    }
  });

  it("部件尺寸与类别合法", () => {
    for (const part of BUILD_CATALOG) {
      expect(part.size.length).toBe(3);
      expect(part.size.every((n) => n > 0), `${part.id} 尺寸应为正`).toBe(true);
      expect(["structure", "furniture", "deco", "facility"]).toContain(part.category);
      expect(part.name.length).toBeGreaterThan(0);
    }
  });

  it("QUESTS 步骤非空且旗标唯一", () => {
    const flags = new Set<string>();
    for (const q of QUESTS) {
      expect(q.steps.length, `${q.id} 应有步骤`).toBeGreaterThan(0);
      for (const step of q.steps) {
        expect(flags.has(step.done), `旗标 ${step.done} 重复`).toBe(false);
        flags.add(step.done);
      }
    }
  });
});
