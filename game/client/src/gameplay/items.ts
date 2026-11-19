// 背包与资源。
import { ITEMS, ItemId, ItemStack } from "shared";

export class Inventory {
  stacks: ItemStack[] = [];
  onChange?: () => void;

  count(id: ItemId): number {
    return this.stacks.find((s) => s.id === id)?.count ?? 0;
  }

  add(id: ItemId, n: number): void {
    if (n <= 0) return;
    const s = this.stacks.find((x) => x.id === id);
    if (s) s.count += n;
    else this.stacks.push({ id, count: n });
    this.onChange?.();
  }

  remove(id: ItemId, n: number): boolean {
    const s = this.stacks.find((x) => x.id === id);
    if (!s || s.count < n) return false;
    s.count -= n;
    if (s.count === 0) this.stacks = this.stacks.filter((x) => x !== s);
    this.onChange?.();
    return true;
  }

  canAfford(cost: Partial<Record<ItemId, number>>): boolean {
    return Object.entries(cost).every(([id, n]) => !n || this.count(id as ItemId) >= n);
  }

  pay(cost: Partial<Record<ItemId, number>>): boolean {
    if (!this.canAfford(cost)) return false;
    for (const [id, n] of Object.entries(cost)) {
      if (n) this.remove(id as ItemId, n);
    }
    return true;
  }

  load(stacks: ItemStack[]) {
    this.stacks = stacks.map((s) => ({ ...s }));
    this.onChange?.();
  }

  export(): ItemStack[] {
    return this.stacks.filter((s) => s.count > 0).map((s) => ({ ...s }));
  }

  nameOf(id: ItemId): string { return ITEMS[id]?.name ?? id; }
}
