import { describe, it, expect } from "vitest";
import { Inventory } from "../src/gameplay/items";

describe("Inventory", () => {
  it("add 累加同 id 物品", () => {
    const inv = new Inventory();
    inv.add("wheat", 2);
    inv.add("wheat", 3);
    expect(inv.count("wheat")).toBe(5);
    expect(inv.stacks).toHaveLength(1);
  });

  it("add 非正数无效", () => {
    const inv = new Inventory();
    inv.add("wheat", 0);
    inv.add("wheat", -1);
    expect(inv.count("wheat")).toBe(0);
  });

  it("remove 不足时失败且不扣减", () => {
    const inv = new Inventory();
    inv.add("wheat", 2);
    expect(inv.remove("wheat", 3)).toBe(false);
    expect(inv.count("wheat")).toBe(2);
    expect(inv.remove("windcrystal", 1)).toBe(false);
  });

  it("remove 成功后归零栈被清除", () => {
    const inv = new Inventory();
    inv.add("wheat", 2);
    expect(inv.remove("wheat", 2)).toBe(true);
    expect(inv.stacks).toHaveLength(0);
  });

  it("canAfford/pay 按成本表判定并原子扣减", () => {
    const inv = new Inventory();
    inv.add("floatstone", 2);
    inv.add("windcrystal", 1);
    const cost = { floatstone: 3, windcrystal: 2 };
    expect(inv.canAfford(cost)).toBe(false);
    expect(inv.pay(cost)).toBe(false);
    expect(inv.count("floatstone")).toBe(2);
    inv.add("floatstone", 1);
    inv.add("windcrystal", 1);
    expect(inv.pay(cost)).toBe(true);
    expect(inv.count("floatstone")).toBe(0);
    expect(inv.count("windcrystal")).toBe(0);
  });

  it("load/export 往返保留数量且剔除空栈", () => {
    const inv = new Inventory();
    inv.add("wheat", 4);
    inv.add("windcrystal", 1);
    const exported = inv.export();
    const other = new Inventory();
    other.load(exported);
    expect(other.count("wheat")).toBe(4);
    expect(other.count("windcrystal")).toBe(1);
    inv.remove("windcrystal", 1);
    expect(inv.export().find((s) => s.id === "windcrystal")).toBeUndefined();
  });

  it("onChange 在变更时触发", () => {
    const inv = new Inventory();
    let calls = 0;
    inv.onChange = () => calls++;
    inv.add("wheat", 1);
    inv.remove("wheat", 1);
    inv.remove("wheat", 1);
    inv.pay({ wheat: 1 });
    expect(calls).toBe(2);
  });
});
