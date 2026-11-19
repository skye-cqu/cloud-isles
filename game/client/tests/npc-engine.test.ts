import { describe, it, expect } from "vitest";
import { localDecide } from "shared";
import { NpcSituation } from "shared";

const randAlways = (v: number) => () => v;

function base(over: Partial<NpcSituation> = {}): NpcSituation {
  return {
    npcId: "yan",
    npcName: "岩",
    persona: "工匠",
    goal: "守护家园",
    timeOfDay: "白天",
    weather: "晴",
    homeLevel: 0,
    hp: 100,
    hunger: 80,
    inventory: [],
    farm: [],
    playerNearby: false,
    playerDoing: "无所事事",
    others: [],
    facilities: [],
    recentMemory: [],
    buildAuthorization: null,
    ...over,
  };
}

describe("localDecide 决策规则", () => {
  it("有授权且预算足够时优先建设：工匠造栏杆、位置落在授权圆盘内", () => {
    const d = localDecide(base({ buildAuthorization: { zone: "中央广场", budget: { wheat: 4 } } }), randAlways(0.99));
    expect(d.action.type).toBe("build_part");
    expect(d.action.partId).toBe("railing");
    expect(d.source).toBe("fallback");
    const [x, , z] = d.action.target!;
    // 采样半径 ≤4，必须落在授权圆盘内（半径 5.5）
    expect(Math.hypot(x, z)).toBeLessThanOrEqual(4.05);
  });

  it("园丁在有预算时种盆栽", () => {
    const d = localDecide(base({ npcId: "ling", persona: "园艺师", buildAuthorization: { zone: "中央广场", budget: { wheat: 2 } } }), randAlways(0.99));
    expect(d.action.partId).toBe("planter");
  });

  it("预算耗尽（wheat=0）后不再建设", () => {
    const d = localDecide(base({ buildAuthorization: { zone: "中央广场", budget: { wheat: 0 } } }), randAlways(0.99));
    expect(d.action.type).not.toBe("build_part");
  });

  it("无授权时绝不建设", () => {
    for (let i = 0; i < 30; i++) {
      const d = localDecide(base(), randAlways(i / 30));
      expect(d.action.type).not.toBe("build_part");
    }
  });

  it("玩家在附近且随机命中时主动打招呼", () => {
    const d = localDecide(base({ playerNearby: true }), randAlways(0.1));
    expect(d.action.type).toBe("talk_to_player");
    expect(d.action.say).toBeTruthy();
  });

  it("玩家在附近但随机未命中时不打扰", () => {
    const d = localDecide(base({ playerNearby: true }), randAlways(0.9));
    expect(d.action.type).not.toBe("talk_to_player");
  });

  it("作物成熟时园丁优先收割", () => {
    const d = localDecide(
      base({ npcId: "ling", persona: "园艺师", farm: [{ plot: "p1", stage: "成熟", crop: "wheat" }] }),
      randAlways(0.9),
    );
    expect(d.action.type).toBe("harvest_farm");
  });

  it("有生长中作物时园丁照料", () => {
    const d = localDecide(
      base({ npcId: "ling", persona: "园艺师", farm: [{ plot: "p1", stage: "生长中", crop: "wheat" }] }),
      randAlways(0.9),
    );
    expect(d.action.type).toBe("tend_farm");
  });

  it("有灶台和食材且饥饿时做饭", () => {
    const d = localDecide(
      base({
        hunger: 40,
        inventory: [{ id: "cloudmushroom", count: 2 }],
        facilities: [{ id: "s1", name: "石砌灶台", usable: true }],
      }),
      randAlways(0.9),
    );
    expect(d.action.type).toBe("cook");
  });

  it("无事可做时走动或休息", () => {
    const wander = localDecide(base(), randAlways(0.2));
    expect(wander.action.type).toBe("wander");
    const idle = localDecide(base(), randAlways(0.9));
    expect(idle.action.type).toBe("idle");
  });

  it("同一处境下随机源相同则决策确定（可复现）", () => {
    const s = base({ playerNearby: true });
    const a = localDecide(s, randAlways(0.42));
    const b = localDecide(s, randAlways(0.42));
    expect(a.action).toEqual(b.action);
  });
});
