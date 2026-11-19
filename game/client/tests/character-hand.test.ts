import { afterEach, describe, expect, it } from "vitest";
import { Bone, NullEngine, Scene, Skeleton } from "@babylonjs/core";
import { findRightHandBone } from "../src/world/characters";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function skeletonWith(names: string[]) {
  const engine = new NullEngine();
  engines.push(engine);
  const skeleton = new Skeleton("character", "character", new Scene(engine));
  for (const name of names) new Bone(name, skeleton);
  return skeleton;
}

describe("角色右手挂剑骨骼", () => {
  it("选择 Ruike 手掌骨而非右手手指或左手", () => {
    const skeleton = skeletonWith(["Hand_L", "Hand_R_Index1", "Hand_R"]);
    expect(findRightHandBone(skeleton)?.name).toBe("Hand_R");
  });
  it("保留 KayKit 手掌支持，不选辅助挂点或 IK 骨", () => {
    const skeleton = skeletonWith(["handslot.r", "handIK.r", "hand.r"]);
    expect(findRightHandBone(skeleton)?.name).toBe("hand.r");
  });
  it("缺少右手时不把剑误挂左手", () => {
    expect(findRightHandBone(skeletonWith(["Hand_L", "Hand_R_Index1"]))).toBeNull();
  });
});
