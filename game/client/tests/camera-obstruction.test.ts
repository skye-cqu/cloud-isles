import { describe, expect, it } from "vitest";
import { NullEngine, Scene, MeshBuilder, Vector3 } from "@babylonjs/core";
import { resolveCameraPosition } from "../src/world/cameraObstruction";

it("镜头被墙阻挡时收臂，墙移走后可恢复期望位置", () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const wall = MeshBuilder.CreateBox("wall", { width: 5, height: 5, depth: 0.2 }, scene);
  wall.position.set(0, 1.5, -2); wall.computeWorldMatrix(true);
  const target = new Vector3(0, 1.5, 0), wanted = new Vector3(0, 1.5, -6);
  expect(resolveCameraPosition(scene, target, wanted).z).toBeGreaterThan(-1.9);
  wall.dispose();
  expect(resolveCameraPosition(scene, target, wanted).asArray()).toEqual(wanted.asArray());
  scene.dispose(); engine.dispose();
});
