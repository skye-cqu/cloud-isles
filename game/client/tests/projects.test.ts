import { describe, it, expect } from "vitest";
import {
  BRANCHES, canPropose, proposeProject, approveProject, pauseProject, resumeProject,
  cancelProject, canExecuteStep, completeStep, projectBoardUnlocked, facilityOnline,
  homeStage, farmGrowSec, recordExpedition, provisionExpedition, petHintRadius,
  companionTrust, markBlocked, resumeBlocked,
  type InvLike, type ProjectRecord,
} from "shared";

/** 可失败库存：remove 在 removeAfter 次后拒绝，模拟步骤间库存竞争。 */
function inv(stack: Record<string, number>, failRemoveFrom = Infinity): InvLike {
  let removals = 0;
  return {
    count: (id) => stack[id] ?? 0,
    remove: (id, n) => {
      removals += 1;
      if (removals > failRemoveFrom || (stack[id] ?? 0) < n) return false;
      stack[id] -= n;
      return true;
    },
    add: (id, n) => { stack[id] = (stack[id] ?? 0) + n; },
  };
}

const emptyProjects = (): ProjectRecord[] => [];

describe("四分支项目生命周期", () => {
  it("提议不足材料被拒绝，不产生记录", () => {
    const projects = emptyProjects();
    const inv1 = inv({ windcrystal: 1, wisp_essence: 1 });
    expect(canPropose(projects, "explore", inv1).ok).toBe(false);
    const result = proposeProject(projects, "explore", inv1, "op-1");
    expect(result.charged).toBe(false);
    expect(result.record).toBeNull();
    expect(projects.length).toBe(0);
    expect(inv1.count("windcrystal")).toBe(1); // 未扣款
  });

  it("提议原子扣款；同 opId 幂等不重复扣", () => {
    const projects = emptyProjects();
    const inv1 = inv({ windcrystal: 2, wisp_essence: 1 });
    const first = proposeProject(projects, "explore", inv1, "op-1");
    expect(first.charged).toBe(true);
    expect(inv1.count("windcrystal")).toBe(0);
    expect(first.record!.state).toBe("proposed");
    // 幂等：同分支重复提议返回既有记录
    inv1.add("windcrystal", 5);
    const second = proposeProject(projects, "explore", inv1, "op-2");
    expect(second.charged).toBe(false);
    expect(second.record!.opIds).toEqual(["op-1"]);
  });

  it("取消保留里程碑；取消后可重新提议（新 ID）", () => {
    const projects = emptyProjects();
    const inv1 = inv({ windcrystal: 4, wisp_essence: 2 });
    const first = proposeProject(projects, "explore", inv1, "op-1");
    cancelProject(first.record!);
    expect(first.record!.state).toBe("cancelled");
    expect(first.record!.built).toBe(false);
    // 已建成里程碑保留：completed 项目不可取消
    const inv2 = inv({ windcrystal: 4, wisp_essence: 2 });
    const second = proposeProject(projects, "explore", inv2, "op-2");
    expect(second.record!.id).not.toBe(first.record!.id);
    completeStep(second.record!, "step-2");
    cancelProject(second.record!);
    expect(second.record!.state).toBe("completed");
  });

  it("暂停时不开始新步骤，恢复后继续", () => {
    const projects = emptyProjects();
    const inv1 = inv({ floatstone: 5, windcrystal: 2, wisp_essence: 1 });
    const { record } = proposeProject(projects, "craft", inv1, "op-1");
    approveProject(record!);
    pauseProject(record!);
    const cost = { floatstone: 2, windcrystal: 1 };
    expect(canExecuteStep(record!, inv1, cost, true)).toEqual({ ok: false, reason: "项目处于 paused，不开始新步骤" });
    resumeProject(record!);
    expect(canExecuteStep(record!, inv1, cost, true).ok).toBe(true);
  });

  it("步骤材料竞争：核验通过但执行失败 → 如实受阻，不重复计步骤", () => {
    const projects = emptyProjects();
    const inv1 = inv({ floatstone: 5, windcrystal: 2, wisp_essence: 1 });
    const { record } = proposeProject(projects, "craft", inv1, "op-1");
    approveProject(record!);
    const cost = { floatstone: 2, windcrystal: 1 };
    expect(canExecuteStep(record!, inv1, cost, true).ok).toBe(true);
    // 执行器（build.place）失败：不调 completeStep，标记受阻
    markBlocked(record!, "位置被新建筑占据");
    expect(record!.state).toBe("blocked");
    expect(record!.blockedReason).toContain("占据");
    expect(canExecuteStep(record!, inv1, cost, true).ok).toBe(false);
    resumeBlocked(record!);
    expect(canExecuteStep(record!, inv1, cost, true).ok).toBe(true);
  });

  it("完成步骤幂等：同 opId 重复上报不重复计", () => {
    const projects = emptyProjects();
    const inv1 = inv({ floatstone: 2, wheat: 3 });
    const { record } = proposeProject(projects, "society", inv1, "op-1");
    approveProject(record!);
    completeStep(record!, "step-1");
    completeStep(record!, "step-1");
    expect(record!.built).toBe(true);
    expect(record!.state).toBe("completed");
    expect(record!.opIds).toEqual(["op-1", "step-1"]);
  });

  it("项目板在首次提议后即解锁，不要求聚落分支先行", () => {
    const projects = emptyProjects();
    expect(projectBoardUnlocked(projects)).toBe(false);
    const inv1 = inv({ floatstone: 2, wheat: 3 });
    proposeProject(projects, "society", inv1, "op-1");
    expect(projectBoardUnlocked(projects)).toBe(true);
  });

  it("设施拆除后功能离线、里程碑保留", () => {
    const buildings = [{ partId: "forge_anvil", space: "island:home" }];
    expect(facilityOnline(buildings, "forge_anvil", "island:home")).toBe(true);
    buildings[0].partId = "lantern";
    expect(facilityOnline(buildings, "forge_anvil", "island:home")).toBe(false);
  });
});

describe("家园五阶段门槛", () => {
  const base = () => ({
    upgradedBerth: false,
    branchCompleted: {},
    companionExpeditions: 0,
    petBondVisits: 0,
    hasPet: false,
    generatedTypesVisited: [] as string[],
    beaconCompleted: false,
  });

  it("新档=落脚之地；泊位整备后=稳定家园", () => {
    expect(homeStage(base())).toBe(1);
    const f2 = base(); f2.upgradedBerth = true;
    expect(homeStage(f2)).toBe(2);
  });

  it("阶段3需聚落项目+任一其他分支", () => {
    const f = base();
    f.upgradedBerth = true;
    f.branchCompleted = { society: true };
    expect(homeStage(f)).toBe(2);
    f.branchCompleted = { society: true, craft: true };
    expect(homeStage(f)).toBe(3);
  });

  it("阶段4需四分支+搭档远征+宠物羁绊1", () => {
    const f = base();
    f.upgradedBerth = true;
    f.branchCompleted = { society: true, craft: true, explore: true, life: true };
    expect(homeStage(f)).toBe(3);
    f.companionExpeditions = 1; f.hasPet = true; f.petBondVisits = 1;
    expect(homeStage(f)).toBe(4);
  });

  it("阶段5需三类生成岛+信标项目", () => {
    const f = base();
    f.upgradedBerth = true;
    f.branchCompleted = { society: true, craft: true, explore: true, life: true };
    f.companionExpeditions = 1; f.hasPet = true; f.petBondVisits = 1;
    f.generatedTypesVisited = ["meadow", "canyon"];
    f.beaconCompleted = true;
    expect(homeStage(f)).toBe(4);
    f.generatedTypesVisited.push("ruins");
    expect(homeStage(f)).toBe(5);
  });

  it("共生庭院在线才缩短成熟时间", () => {
    expect(farmGrowSec(false)).toBe(75);
    expect(farmGrowSec(true)).toBe(55);
  });
});

describe("有效远征与口粮", () => {
  it("未停靠非家园岛不算有效远征", () => {
    const records = [] as ReturnType<typeof recordExpedition>[];
    const out1 = recordExpedition(records as never, "exp-1", ["island:home"], "island:home");
    expect(out1).toBeNull();
    const out2 = recordExpedition(records as never, "exp-2", ["island:home", "island:canyonW"], "island:home");
    expect(out2?.islandId).toBe("island:canyonW");
  });

  it("同 opId 反复结算不重复记录（反复离泊不刷奖励）", () => {
    const records: NonNullable<ReturnType<typeof recordExpedition>>[] = [];
    const first = recordExpedition(records, "exp-9", ["island:ruins"], "island:home");
    expect(first).not.toBeNull();
    const again = recordExpedition(records, "exp-9", ["island:ruins"], "island:home");
    expect(again).toBeNull();
    expect(records.length).toBe(1);
  });

  it("口粮按远征 opId 只扣一次；不足时拒绝且不扣", () => {
    const inv1 = inv({ steamed_bun: 1 });
    const provisioned: string[] = [];
    expect(provisionExpedition(inv1, "exp-1", provisioned).ok).toBe(true);
    expect(inv1.count("steamed_bun")).toBe(0);
    expect(provisionExpedition(inv1, "exp-1", provisioned).ok).toBe(true); // 幂等
    const inv2 = inv({});
    expect(provisionExpedition(inv2, "exp-2", []).ok).toBe(false);
    expect(provisioned).toEqual(["exp-1"]);
  });
});

describe("宠物与搭档", () => {
  it("羁绊 1/2/3 解锁 15/25/35m 提示，0 次无提示", () => {
    expect(petHintRadius(0)).toBeNull();
    expect(petHintRadius(1)).toEqual({ radius: 15, mode: "mushroom" });
    expect(petHintRadius(2)).toEqual({ radius: 25, mode: "any" });
    expect(petHintRadius(5)).toEqual({ radius: 35, mode: "type" });
  });

  it("信任按一次性事实逐级解锁", () => {
    expect(companionTrust(false, false, false)).toEqual({ canAccompany: false, combatSupport: false, rescue: false });
    expect(companionTrust(true, false, false).canAccompany).toBe(true);
    expect(companionTrust(true, true, false).combatSupport).toBe(true);
    expect(companionTrust(true, true, true)).toEqual({ canAccompany: true, combatSupport: true, rescue: true });
  });
});
