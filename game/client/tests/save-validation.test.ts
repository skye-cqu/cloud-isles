import { describe, expect, it } from "vitest";
import { normalizeSaveData } from "../src/core/save";
import { isValidSavePayload } from "shared";

const valid = {
  version: 1,
  savedAt: 1,
  playSeconds: 0,
  player: { pos: [0, 1, 0], hp: 100, hunger: 100, stamina: 100, xp: 0, level: 1, inventory: [], equippedWeapon: null, mode: "walk" },
  ship: { pos: [0, 0, 0], rotY: 0, docked: true, sailUpgraded: false },
  buildings: [], farm: [],
  world: { collected: [], chests: {}, visited: [] },
  home: { level: 0, upgradedBerth: false, buildZone: null, buildBudget: null, authorized: false },
  npcs: [], quests: {}, flags: {},
};

describe("save validation and migration", () => {
  it("preserves extensions and isolates all nested data after validation", () => {
    const raw = structuredClone({ ...valid, extension: { nested: [1] }, player: { ...valid.player, inventory: [{ id: "wheat", count: 1, origin: { island: "home" } }] } });
    const normalized = normalizeSaveData(raw) as any;
    expect(normalized.player.inventory[0].origin).toEqual({ island: "home" });
    normalized.extension.nested.push(2);
    normalized.world.chests.open = true;
    expect(raw.extension.nested).toEqual([1]);
    expect(raw.world.chests).toEqual({});
  });
  it("migrates a valid v1 save without inventing quest facts", () => {
    const save = normalizeSaveData(valid);
    expect(save?.version).toBe(2);
    expect(save?.ship.energy).toBe(100);
    expect(save?.questFacts).toEqual([]);
  });

  it("rejects unsupported future versions and invalid resource counts", () => {
    expect(isValidSavePayload({ broken: true })).toBe(false);
    expect(normalizeSaveData({ ...valid, version: 99 })).toBeNull();
    expect(normalizeSaveData({ ...valid, player: { ...valid.player, inventory: [{ id: "wheat", count: -1 }] } })).toBeNull();
    const building = { uid: "b1", partId: "chair", space: "island:home", pos: [0, 0, 0], rotY: 0 };
    expect(normalizeSaveData({ ...valid, buildings: [building, building] })).toBeNull();
    expect(normalizeSaveData({ ...valid, world: { ...valid.world, chests: { chest: "opened" } } })).toBeNull();
    expect(normalizeSaveData({ ...valid, home: { ...valid.home, buildBudget: { wheat: -1 } } })).toBeNull();
    expect(normalizeSaveData({ ...valid, npcs: [{ id: "n", pos: [0, 0, 0], state: "idle", affinity: 0, memory: [{ t: 0, text: 3, kind: "bad" }] }] })).toBeNull();
  });

  it("retains only a bounded positive food-buff duration", () => {
    expect(normalizeSaveData({ ...valid, version: 2, player: { ...valid.player, foodBuff: { stamina: 20, remainingMs: 1200 } } })?.player.foodBuff).toEqual({ stamina: 20, remainingMs: 1200 });
    expect(normalizeSaveData({ ...valid, version: 2, player: { ...valid.player, foodBuff: { stamina: 20, remainingMs: -1 } } })).toBeNull();
  });
});
