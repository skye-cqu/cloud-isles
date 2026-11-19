import { describe, expect, it } from "vitest";
import { HavokPlugin, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BuildSystem } from "../src/gameplay/build";
import { Inventory } from "../src/gameplay/items";
import { BUILD_CATALOG } from "shared";

describe("BuildSystem state transaction", () => {
  it("disposes the replaced Havok collider on every move while preserving the building and visual meshes", async () => {
    const havok = await HavokPhysics({ wasmBinary: readFileSync(resolve("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm")) });
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havok));
    try {
      const root = new TransformNode("home", scene);
      const world = { islands: [{ root, def: { radius: 40 }, heightAt: () => 0, canBuildAt: () => true }], docks: [{ pos: new Vector3(100, 0, 100) }] } as any;
      const build = new BuildSystem(scene, world, new Inventory(), { node: new TransformNode("player", scene) } as any, false);
      const placed = build.place("floor", new Vector3(2, 0, 0), 0)!;
      const visuals = placed.node.getChildMeshes().filter(mesh => !mesh.name.startsWith("buildCollider_"));
      expect(visuals.length).toBeGreaterThan(0);
      expect(build.enterMoveMode(placed.uid)).toBe(true);
      for (let x = 3; x <= 7; x++) {
        const oldCollider = placed.phys!.transformNode;
        build.ghostPos.set(x, 0, 0);
        expect(build.confirmPlace()).toBe(placed);
        expect(oldCollider.isDisposed()).toBe(true);
        expect(scene.meshes.filter(mesh => mesh.name.startsWith("buildCollider_"))).toHaveLength(1);
        expect(placed.node.isDisposed()).toBe(false);
        expect(visuals.every(mesh => !mesh.isDisposed() && mesh.parent === placed.node)).toBe(true);
      }
    } finally { scene.dispose(); engine.dispose(); }
  });
  it("rejects zero-stock NPC construction and repeats without spending", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const root = new TransformNode("home", scene);
    const inv = new Inventory();
    const world = { islands: [{ root, def: { radius: 40 }, heightAt: () => 0, canBuildAt: () => true }], docks: [{ pos: new Vector3(100, 0, 100) }] } as any;
    const build = new BuildSystem(scene, world, inv, { node: new TransformNode("player", scene) } as any, false);
    build.setBuildZone(Vector3.Zero(), 8);
    build.authorizeBudget({ wheat: 2 }, ["planter"]);
    expect(build.npcTryBuild("planter", new Vector3(2, 0, 0), 0, "op-build-1")).toBeNull();
    expect(build.buildBudget?.wheat).toBe(2);
    inv.add("wheat", 2);
    const placed = build.npcTryBuild("planter", new Vector3(2, 0, 0), 0, "op-build-1");
    expect(placed?.uid).toBe("b1");
    expect(inv.count("wheat")).toBe(1);
    expect(build.buildBudget?.wheat).toBe(1);
    expect(build.npcTryBuild("planter", new Vector3(5, 0, 0), 0, "op-build-1")).toBeNull();
    expect(build.buildings).toHaveLength(1);
    engine.dispose();
  });

  it("keeps the original building and UID through cancelled, failed, and successful moves", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const root = new TransformNode("home", scene);
    const inv = new Inventory();
    const world = { islands: [{ root, def: { radius: 40 }, heightAt: () => 0, canBuildAt: () => true }], docks: [{ pos: new Vector3(100, 0, 100) }] } as any;
    const build = new BuildSystem(scene, world, inv, { node: new TransformNode("player", scene) } as any, false);
    inv.add("wheat", 1);
    const placed = build.place("planter", new Vector3(2, 0, 0), 0)!;
    expect(build.enterMoveMode(placed.uid)).toBe(true);
    expect(build.ghost?.getChildren().length).toBeGreaterThan(0);
    build.exit();
    expect(build.export()[0].uid).toBe(placed.uid);
    expect(build.enterMoveMode(placed.uid)).toBe(true);
    build.ghostPos.set(100, 0, 0);
    expect(build.confirmPlace()).toBeNull();
    expect(build.export()[0].pos).toEqual([2, 0, 0]);
    build.ghostPos.set(5, 0, 0);
    expect(build.confirmPlace()?.uid).toBe(placed.uid);
    expect(build.export()[0].pos).toEqual([5, 0, 0]);
    engine.dispose();
  });

  it("blocks paused and revoked authorization even for free parts", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const root = new TransformNode("home", scene);
    const inv = new Inventory();
    const world = { islands: [{ root, def: { radius: 40 }, heightAt: () => 0, canBuildAt: () => true }], docks: [{ pos: new Vector3(100, 0, 100) }] } as any;
    const build = new BuildSystem(scene, world, inv, { node: new TransformNode("player", scene) } as any, false);
    build.setBuildZone(Vector3.Zero(), 8);
    build.authorizeBudget({}, ["railing"]);
    const railing = BUILD_CATALOG.find((part) => part.id === "railing")!;
    build.pauseAuthorization();
    expect(build.canPlace(railing, new Vector3(2, 0, 0), 0, true).ok).toBe(false);
    build.pauseAuthorization(false);
    expect(build.canPlace(railing, new Vector3(2, 0, 0), 0, true).ok).toBe(true);
    build.revokeAuthorization();
    expect(build.canPlace(railing, new Vector3(5, 0, 0), 0, true).ok).toBe(false);
    engine.dispose();
  });
});
