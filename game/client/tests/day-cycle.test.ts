import { describe, expect, it } from "vitest";
import { NullEngine, Scene, MeshBuilder, StandardMaterial, Color3 } from "@babylonjs/core";
import { sampleDayCycle, isolateNightMaterial } from "../src/world/dayCycle";

describe("家园昼夜", () => {
  it("08时开局，每60秒一小时，24分钟循环；调试不改变基础时间", () => {
    expect(sampleDayCycle(0, null).hour).toBe(8);
    expect(sampleDayCycle(60, null).hour).toBe(9);
    expect(sampleDayCycle(1440, null)).toEqual(sampleDayCycle(0, null));
    expect(sampleDayCycle(60, 22).hour).toBe(22);
    expect(sampleDayCycle(60, null).hour).toBe(9);
  });
  it("午夜连续，夜晚灯火增强、日间光照增强，所有量有限", () => {
    const night = sampleDayCycle(0, 22), noon = sampleDayCycle(0, 12);
    expect(night.nightWeight).toBeGreaterThan(noon.nightWeight);
    expect(noon.sunIntensity).toBeGreaterThan(night.sunIntensity);
    const a = sampleDayCycle(0, 23.999), b = sampleDayCycle(0, 0.001);
    expect(Math.abs(a.hemiIntensity - b.hemiIntensity)).toBeLessThan(0.001);
    for (let hour = 0; hour < 24; hour += 0.25) {
      const s = sampleDayCycle(0, hour);
      expect(s.nightWeight).toBeGreaterThanOrEqual(0);
      expect(s.nightWeight).toBeLessThanOrEqual(1);
      expect(s.skyTop.every(Number.isFinite)).toBe(true);
    }
  });
  it("窗光克隆材质，不能让共用墙材质发光", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const shared = new StandardMaterial("plaster", scene);
    const wall = MeshBuilder.CreateBox("wall", {}, scene), window = MeshBuilder.CreateBox("window", {}, scene);
    wall.material = window.material = shared;
    const material = isolateNightMaterial(window)!;
    material.emissiveColor = Color3.Red();
    expect(wall.material).toBe(shared);
    expect(shared.emissiveColor.asArray()).toEqual([0, 0, 0]);
    expect(isolateNightMaterial(window)).toBe(material);
    scene.dispose(); engine.dispose();
  });
});
