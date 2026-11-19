import { MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { createFoundationBehavior } from "../src/foundation/behavior";
import { createFoundationNavigation } from "../src/foundation/navigation";
import { createIslandSampler } from "../src/foundation/terrain";

describe("foundation terrain", () => {
  it("keeps global-coordinate samples deterministic across adjacent patch seams", () => {
    const sampler = createIslandSampler(20261105);

    expect(sampler.heightAt(32, -7)).toBe(sampler.heightAt(32, -7));
    expect(sampler.sampleEdge(0, 0, 32).at(-1)?.height).toBe(sampler.sampleEdge(32, 0, 32)[0]?.height);
    expect(createIslandSampler(7).heightAt(8, 9)).not.toBe(sampler.heightAt(8, 9));
  });
});

describe("foundation behavior", () => {
  it("advances a real Yuka vehicle and freezes its arrival loop while paused", () => {
    const behavior = createFoundationBehavior(new Vector3(6, 0, 0));
    behavior.tick(1);
    const movedX = behavior.vehicle.position.x;
    const ticks = behavior.ticks;
    behavior.setPaused(true);
    behavior.tick(1);

    expect(movedX).toBeGreaterThan(0);
    expect(behavior.vehicle.rotation.y).not.toBe(0);
    expect(behavior.vehicle.position.x).toBe(movedX);
    expect(behavior.ticks).toBe(ticks);
    behavior.dispose();
  });
});

describe("foundation navigation", () => {
  it("shares one cold-start Recast initialization across concurrent local islands", async () => {
    const scene = new Scene(new NullEngine());
    const first = MeshBuilder.CreateGround("first", { width: 8, height: 8 }, scene);
    const second = MeshBuilder.CreateGround("second", { width: 8, height: 8 }, scene);
    second.position.x = 16;
    const [firstNav, secondNav] = await Promise.all([
      createFoundationNavigation([first]),
      createFoundationNavigation([second]),
    ]);

    expect(firstNav.path(Vector3.Zero(), new Vector3(1, 0, 0)).length).toBeGreaterThan(0);
    expect(secondNav.path(new Vector3(16, 0, 0), new Vector3(17, 0, 0)).length).toBeGreaterThan(0);
    expect(secondNav.path(new Vector3(16, 0, 0), new Vector3(40, 0, 0))).toEqual([]);
    firstNav.dispose();
    secondNav.dispose();
    scene.dispose();
  });

  it("generates a local Recast navmesh, rejects a disconnected target, and releases it", async () => {
    const scene = new Scene(new NullEngine());
    const west = MeshBuilder.CreateGround("west", { width: 4, height: 4 }, scene);
    west.position.x = -4;
    const east = MeshBuilder.CreateGround("east", { width: 4, height: 4 }, scene);
    east.position.x = 4;
    const navigation = await createFoundationNavigation([west, east]);

    expect(navigation.path(new Vector3(-4, 0, 0), new Vector3(-3, 0, 0)).length).toBeGreaterThan(0);
    expect(navigation.path(new Vector3(-4, 0, 0), new Vector3(4, 0, 0))).toEqual([]);
    navigation.dispose();
    expect(() => navigation.path(Vector3.Zero(), Vector3.One())).toThrow("disposed");
    scene.dispose();
  });
});
