import { describe, expect, it } from "vitest";
import { Mesh, NullEngine, Scene, ShaderStore, StandardMaterial } from "@babylonjs/core";
import "@babylonjs/materials/triPlanar/triplanar.fragment";
import {
  applyLsicTerrainMaterials, applyTriPlanarNormalCompatibilityPatch, getLsicTerrainStyle,
} from "../src/world/lsicMaterials";

describe("LSIC 地形材质分类", () => {
  it("按 LSIC 导出材质层，而不是 Babylon 重命名后的 primitive 网格分类", () => {
    expect(getLsicTerrainStyle("terrain_baseLayer")).toBe("grass");
    expect(getLsicTerrainStyle("terrain_topR")).toBe("path");
    expect(getLsicTerrainStyle("terrain_topB")).toBe("cliff");
    expect(getLsicTerrainStyle("terrain_sideG")).toBe("cliff");
    expect(getLsicTerrainStyle("tree_oak_01")).toBeNull();
  });

  it("修正已注册的 Babylon 9.33.1 三向投影法线 TBN 乘法方向", () => {
    const source = ShaderStore.ShadersStore.triplanarPixelShader;
    expect(source).toContain("normalW=normalize((2.0*baseNormal.xyz-1.0)*tangentSpace);");

    applyTriPlanarNormalCompatibilityPatch();

    expect(ShaderStore.ShadersStore.triplanarPixelShader)
      .toContain("normalW=normalize(tangentSpace*(2.0*baseNormal.xyz-1.0));");
    // 水平面 TBN 的列为 tangent=(1,0,0), binormal=(0,0,-1), normal=(0,1,0)。
    // 平法线 (0,0,1) 左乘矩阵应仍指向世界上方。
    // GLSL mat3 以列构造：三个列向量转成下列行矩阵。
    const tbn = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
    const normal = [0, 0, 1];
    expect(tbn.map((row) => row.reduce((sum, value, i) => sum + value * normal[i], 0))).toEqual([0, 1, 0]);
  });

  it("将真实 Babylon 网格按其材质名替换为对应三向投影材质", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const makeLayer = (primitive: string, layer: string) => {
      const mesh = new Mesh(primitive, scene);
      mesh.material = new StandardMaterial(layer, scene);
      return mesh;
    };
    const grass = makeLayer("terrain_primitive0", "terrain_baseLayer");
    const path = makeLayer("terrain_primitive1", "terrain_topR");
    const cliff = makeLayer("terrain_primitive2", "terrain_topB");

    applyLsicTerrainMaterials(scene, [grass, path, cliff]);

    expect(grass.material?.name).toBe("lsicTerrainGrass");
    expect(path.material?.name).toBe("lsicTerrainPath");
    expect(cliff.material?.name).toBe("lsicTerrainCliff");
    scene.dispose();
    engine.dispose();
  });
});
