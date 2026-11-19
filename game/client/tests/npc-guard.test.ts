import { describe, expect, it } from "vitest";
import { NpcOperationCoordinator, NpcResultCache, validNpcSituation } from "../../server/src/npc-guard";

const situation = () => ({
  npcId: "ling", npcName: "苓", persona: "园艺师", goal: "照料农田", timeOfDay: "白天", weather: "晴朗", homeLevel: 0, hp: 100, hunger: 50,
  inventory: [{ id: "wheat", count: 1 }], farm: [{ plot: "farm-1", stage: "生长1", crop: "wheat" }], playerNearby: true, playerDoing: "在岛上活动",
  others: [{ name: "岩", doing: "idle" }], facilities: [{ id: "b1", name: "灶台", usable: true }], recentMemory: ["刚收过麦子"],
  buildAuthorization: { zone: "家园", budget: { wheat: 1 } }, recentChat: [{ from: "玩家", text: "你好" }],
});

describe("NPC request guard", () => {
  it("rejects missing prompt fields and malformed nested records before prompt construction", () => {
    expect(validNpcSituation(situation())).toBe(true);
    const missingOthers = situation() as Record<string, unknown>;
    delete missingOthers.others;
    expect(validNpcSituation(missingOthers)).toBe(false);
    const malformedFacility = situation();
    malformedFacility.facilities = [{ id: "b1", name: "灶台", usable: "yes" as unknown as boolean }];
    expect(validNpcSituation(malformedFacility)).toBe(false);
  });

  it("returns a result only for the exact same operation semantic fingerprint", () => {
    const cache = new NpcResultCache();
    const key = "session-1:operation-1";
    const decide = cache.fingerprint("decide", { situation: situation() });
    cache.write(key, decide, { action: { type: "idle" } });
    expect(cache.read(key, decide)).toMatchObject({ state: "hit" });
    expect(cache.read(key, cache.fingerprint("chat", { situation: situation(), text: "你好" }))).toEqual({ state: "mismatch" });
  });

  it("coalesces concurrent execution to one provider call and clears it after completion", async () => {
    const coordinator = new NpcOperationCoordinator();
    let calls = 0;
    let release!: () => void;
    const provider = () => new Promise<string>((resolve) => { calls += 1; release = () => resolve("one-result"); });
    const first = coordinator.run("session:operation", provider);
    const second = coordinator.run("session:operation", provider);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["one-result", "one-result"]);
    await expect(coordinator.run("session:operation", async () => { calls += 1; return "next"; })).resolves.toBe("next");
    expect(calls).toBe(2);
  });
});
