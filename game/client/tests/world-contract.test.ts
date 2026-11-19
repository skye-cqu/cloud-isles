import { describe, expect, it } from "vitest";
import {
  RECIPE_VERSION, REGION_SIZE_M, HOME_REGION, HOME_ISLAND_INDEX,
  stableHash, islandSeed, regionOf, regionCenter, regionKeyToString,
  islandKeyToString, islandCacheDir, islandAddresses,
  DEFAULT_WORLD_SEED, isStarterRegion, regionIslandKeys, islandCenterWorld,
  islandAltitude, recipeForIsland, islandUrlPaths, rngFromSeed,
} from "../../shared/src/world-contract";

describe("世界契约:种子派生与区域定位", () => {
  it("同输入跨调用得到相同种子(确定性)", () => {
    const key = { region: { x: 3, z: -7 }, index: 2 };
    expect(islandSeed(12345, key, "shape")).toBe(islandSeed(12345, key, "shape"));
    expect(islandSeed(12345, key, "shape")).toBe(islandSeed(12345, { region: { x: 3, z: -7 }, index: 2 }, "shape"));
  });

  it("不同 seed / 区域 / 岛序 / 派生流得到不同种子", () => {
    const a = islandSeed(1, { region: { x: 0, z: 0 }, index: 0 }, "shape");
    expect(a).not.toBe(islandSeed(2, { region: { x: 0, z: 0 }, index: 0 }, "shape"));
    expect(a).not.toBe(islandSeed(1, { region: { x: 1, z: 0 }, index: 0 }, "shape"));
    expect(a).not.toBe(islandSeed(1, { region: { x: 0, z: 0 }, index: 1 }, "shape"));
    expect(a).not.toBe(islandSeed(1, { region: { x: 0, z: 0 }, index: 0 }, "flora"));
  });

  it("负坐标使用向负无穷取整的区域划分", () => {
    expect(regionOf(-1, -1)).toEqual({ x: -1, z: -1 });
    expect(regionOf(0, 0)).toEqual({ x: 0, z: 0 });
    expect(regionOf(REGION_SIZE_M - 0.5, -REGION_SIZE_M)).toEqual({ x: 0, z: -1 });
    expect(regionOf(-REGION_SIZE_M, REGION_SIZE_M)).toEqual({ x: -1, z: 1 });
  });

  it("区域中心落在区域内且键字符串稳定", () => {
    const [cx, cz] = regionCenter({ x: -2, z: 3 });
    expect(regionOf(cx, cz)).toEqual({ x: -2, z: 3 });
    expect(regionKeyToString({ x: -2, z: 3 })).toBe("r-2_3");
    expect(islandKeyToString({ region: { x: 0, z: 0 }, index: 4 })).toBe("r0_0/i4");
  });

  it("缓存地址包含配方版本、世界种子与岛屿键(可复现寻址)", () => {
    const key = { region: { x: 1, z: -1 }, index: 0 };
    const dir = islandCacheDir(999, key);
    expect(dir).toBe(`assets/lsic/runtime-cache/${RECIPE_VERSION}/999/r1_-1/0`);
    const addr = islandAddresses(999, key);
    expect(addr.model.endsWith("island.glb")).toBe(true);
    expect(addr.surface.endsWith("surface.json")).toBe(true);
    expect(addr.anchors.endsWith("anchors.json")).toBe(true);
  });

  it("家园固定在原点区域首岛", () => {
    expect(HOME_REGION).toEqual({ x: 0, z: 0 });
    expect(HOME_ISLAND_INDEX).toBe(0);
  });

  it("stableHash 区分相邻部件拼接", () => {
    expect(stableHash(["a", "bc"])).not.toBe(stableHash(["ab", "c"]));
    expect(stableHash([1])).not.toBe(stableHash(["1", ""]));
  });
});

describe("世界契约:区域布局与运行时生成", () => {
  it("起始区域保护:家园与首程目标区域不被运行时生成覆盖", () => {
    for (const key of ["r0_0", "r-1_0", "r0_-1", "r-1_-1"]) {
      const m = key.slice(1).split("_");
      expect(isStarterRegion({ x: Number(m[0]), z: Number(m[1]) })).toBe(true);
    }
    expect(isStarterRegion({ x: 1, z: 0 })).toBe(false);
    expect(isStarterRegion({ x: -2, z: 1 })).toBe(false);
  });

  it("每区域一座主岛,布局键确定", () => {
    const region = { x: 3, z: -2 };
    expect(regionIslandKeys(777, region)).toEqual([{ region, index: 0 }]);
    expect(regionIslandKeys(778, region)).toEqual([{ region, index: 0 }]);
  });

  it("岛屿中心落在所属区域内且确定;不同 seed 有差异", () => {
    const region = { x: 2, z: 1 };
    const [cx, , cz] = islandCenterWorld(20261105, { region, index: 0 });
    // 中心 + 抖动(≤120m) 不越过区域边界(区域半宽 320m)
    expect(Math.abs(cx - (region.x + 0.5) * REGION_SIZE_M)).toBeLessThanOrEqual(121);
    expect(Math.abs(cz - (region.z + 0.5) * REGION_SIZE_M)).toBeLessThanOrEqual(121);
    expect(islandCenterWorld(20261105, { region, index: 0 })).toEqual([cx, islandAltitude(20261105, { region, index: 0 }), cz]);
    // 不同 seed 至少在中心或高度上产生差异(抽查多组避免碰撞巧合)
    const seeds = [1, 2, 3, 4, 5].map((s) => islandCenterWorld(s, { region, index: 0 }).join(","));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("相邻区域岛屿中心间距不小于半径和(无跨区域重叠)", () => {
    const radii = 70; // 生成岛最大半径(米,含余量)
    const gap = REGION_SIZE_M - 2 * (120 + radii);
    expect(gap).toBeGreaterThan(0);
    const a = islandCenterWorld(20261105, { region: { x: 1, z: 0 }, index: 0 });
    const b = islandCenterWorld(20261105, { region: { x: 2, z: 0 }, index: 0 });
    expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThanOrEqual(REGION_SIZE_M - 2 * 121);
  });

  it("配方分配稳定且属于已实现集合", () => {
    const key = { region: { x: -3, z: 4 }, index: 0 };
    expect(recipeForIsland(20261105, key)).toBe(recipeForIsland(20261105, key));
    expect(["forest", "canyon", "ruins"]).toContain(recipeForIsland(9, key));
  });

  it("三配方在大范围区域中都出现且森林占多数(权重表生效)", () => {
    const seen: Record<string, number> = { forest: 0, canyon: 0, ruins: 0 };
    for (let rx = -12; rx <= 12; rx++) {
      for (let rz = -12; rz <= 12; rz++) {
        seen[recipeForIsland(20261105, { region: { x: rx, z: rz }, index: 0 })]++;
      }
    }
    expect(seen.forest).toBeGreaterThan(0);
    expect(seen.canyon).toBeGreaterThan(0);
    expect(seen.ruins).toBeGreaterThan(0);
    // 权重 forest 0.58 / canyon 0.25 / ruins 0.17:大样本下森林最多,遗迹最少
    expect(seen.forest).toBeGreaterThan(seen.canyon);
    expect(seen.canyon).toBeGreaterThan(seen.ruins);
  });

  it("运行时缓存 URL 与缓存目录键一致", () => {
    const key = { region: { x: 1, z: 1 }, index: 0 };
    const urls = islandUrlPaths(20261105, key);
    expect(urls.model).toBe(`world-assets/${RECIPE_VERSION}/20261105/r1_1/0/island.glb`);
    expect(urls.surface.endsWith("surface.json")).toBe(true);
    expect(urls.anchors.endsWith("anchors.json")).toBe(true);
  });

  it("rngFromSeed 与 makeRng 同算法(确定性)", () => {
    const a = rngFromSeed(42);
    const b = rngFromSeed(42);
    for (let i = 0; i < 8; i++) expect(a()).toBe(b());
    const v = rngFromSeed(0)();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it("默认世界种子已定义", () => {
    expect(DEFAULT_WORLD_SEED).toBe(20261105);
  });
});
