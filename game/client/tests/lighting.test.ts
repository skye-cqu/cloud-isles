import { describe, expect, it } from "vitest";
import { shadowTargetForMesh, shouldUpdateShadowAnchor, shouldConfigureShadowForMesh } from "../src/world/lighting";
import { Vector3 } from "@babylonjs/core";

describe("场景阴影网格筛选", () => {
  it("保留可见地形和模型，并排除天空与透明云效", () => {
    const renderable = (name: string, materialName = "ground") => ({
      name,
      isVisible: true,
      isEnabled: () => true,
      getTotalVertices: () => 12,
      material: { name: materialName, alpha: 1 },
    });

    expect(shouldConfigureShadowForMesh(renderable("islandTop_home"))).toBe(true);
    expect(shouldConfigureShadowForMesh(renderable("house_roof"))).toBe(true);
    expect(shouldConfigureShadowForMesh(renderable("skybox"))).toBe(false);
    expect(shouldConfigureShadowForMesh(renderable("cloudFloor0", "cloudFloorMat0"))).toBe(false);
    expect(shouldConfigureShadowForMesh(renderable("chestGlow", "chestGlowMat"))).toBe(false);
  });

  it("将实例的阴影状态写回源网格", () => {
    const source = { name: "treeSource" };
    const instance = { name: "treeInstance", sourceMesh: source };
    expect(shadowTargetForMesh(instance)).toBe(source);
    expect(shadowTargetForMesh(source)).toBe(source);
  });

  it("首次和超出八米网格的移动都会重设阴影投影锚点", () => {
    const anchor = new Vector3(0, 8, 0);
    expect(shouldUpdateShadowAnchor(null, anchor)).toBe(true);
    expect(shouldUpdateShadowAnchor(anchor, new Vector3(4, 8, 4))).toBe(false);
    expect(shouldUpdateShadowAnchor(anchor, new Vector3(9, 8, 0))).toBe(true);
  });
});
