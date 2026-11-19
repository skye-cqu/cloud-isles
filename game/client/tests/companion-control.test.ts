import { it, expect } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { CompanionSystem } from "../src/gameplay/companion";

it("同行与等待独占角色移动，跟随位置立即同步，解散恢复自主行为", () => {
  const yan: any = { pos: new Vector3(0, 2, 0), node: { position: new Vector3(0, 2, 0), rotation: Vector3.Zero(), parent: null }, suspended: false, action: {type:"wander"}, state:"walking", remember() {}, say() {} };
  const player: any = {node:{position:new Vector3(8,2,0)},hp:100};
  const world: any = {islands:[{heightAt:()=>2,canWalkAt:()=>true}]};
  const system = new CompanionSystem({companion:{}} as any,player,world,{} as any,()=>yan);
  system.active=true;
  expect(yan.suspended).toBe(true);
  expect(yan.action).toBeNull();
  system.update(.1,false,null);
  expect(yan.pos.x).toBeGreaterThan(0);
  expect(yan.node.position.asArray()).toEqual(yan.pos.asArray());
  system.following=false;
  const before=yan.pos.clone(); system.update(.1,false,null);
  expect(yan.pos.asArray()).toEqual(before.asArray());
  expect(yan.suspended).toBe(true);
  system.dismiss(); expect(yan.suspended).toBe(false);
});
