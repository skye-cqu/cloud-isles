import { describe, expect, it, vi } from "vitest";
import { Color3, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { NpcActor, type NpcPersona } from "../src/gameplay/npc/npc";
import { findWalkPath } from "../src/gameplay/npc/npcPath";

const persona: NpcPersona = {
  id: "test", name: "测试居民", role: "测试", persona: "", goal: "",
  color: Color3.White(), accent: Color3.White(), home: Vector3.Zero(),
};

describe("NPC 行走失败", () => {
  it("目标在岛外时不会记为已经到达", () => {
    const visual = vi.spyOn(NpcActor.prototype as unknown as { initVisual: () => Promise<void> }, "initVisual").mockResolvedValue();
    const scene = new Scene(new NullEngine());
    const root = new TransformNode("home", scene);
    const npc = new NpcActor(persona, Vector3.Zero(), scene, {
      world: {
        islands: [{ root, heightAt: (x: number) => x <= 0 ? 0 : null, canWalkAt: (x: number) => x <= 0 }],
      } as never,
      build: { buildings: [] } as never,
      interact: {} as never,
      player: {} as never,
      inv: {} as never,
      getSituation: () => ({} as never),
    });

    npc.applyAction({ type: "move_to", target: [4, 0, 0] }, "去岛外看看");
    npc.update(1);

    expect(npc.memory.some((entry) => entry.text === "到达目的地。")).toBe(false);
    expect(npc.memory.some((entry) => entry.kind === "path_blocked")).toBe(true);
    visual.mockRestore();
  });
});

describe("NPC 网格路线", () => {
  it("绕过横在台地上的房屋矩形", () => {
    const path = findWalkPath({ x: -6, z: 0 }, { x: 6, z: 0 }, {
      canStand: (x, z) => Math.abs(x) <= 8 && Math.abs(z) <= 8 && !(Math.abs(x) < 1 && Math.abs(z) < 3),
    });

    expect(path.reachable).toBe(true);
    expect(path.points.some((point) => Math.abs(point.z) >= 3)).toBe(true);
    expect(path.points.every((point) => !(Math.abs(point.x) < 1 && Math.abs(point.z) < 3))).toBe(true);
  });

  it("岛外目标没有路线", () => {
    const path = findWalkPath({ x: -2, z: 0 }, { x: 3, z: 0 }, {
      canStand: (x) => x <= 0,
    });

    expect(path).toEqual({ reachable: false, points: [] });
  });

  it("设施中心被占用时停在可交互的相邻地面", () => {
    const target = { x: 0, z: 0 };
    const canStand = (x: number, z: number) => Math.abs(x) <= 6 && Math.abs(z) <= 6 && !(Math.abs(x) < 1 && Math.abs(z) < 1);
    const path = findWalkPath({ x: -4, z: 0 }, target, { canStand, arrivalDistance: 1.4 });
    const end = path.points.at(-1)!;

    expect(path.reachable).toBe(true);
    expect(canStand(end.x, end.z)).toBe(true);
    expect(Math.hypot(end.x - target.x, end.z - target.z)).toBeLessThanOrEqual(1.4);
  });
});
