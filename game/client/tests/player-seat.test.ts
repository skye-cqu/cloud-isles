import { Vector3 } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { seatedAnchor, seatedExitPosition } from "../src/world/player";

describe("玩家座椅姿态", () => {
  it("坐下时角色脚部原点固定在座椅根部并采用座椅朝向", () => {
    const anchor = seatedAnchor(new Vector3(1.72, 7.55, -0.03), Math.PI / 2);

    expect(anchor.pos.asArray()).toEqual([1.72, 7.55, -0.03]);
    expect(anchor.rotY).toBe(Math.PI / 2);
  });

  it("起身时沿座椅朝向离开碰撞盒", () => {
    const exit = seatedExitPosition(new Vector3(1, 7.5, 2), Math.PI / 2);

    expect(exit.x).toBeCloseTo(1.8, 6);
    expect(exit.y).toBeCloseTo(7.55, 6);
    expect(exit.z).toBeCloseTo(2, 6);
  });
});
