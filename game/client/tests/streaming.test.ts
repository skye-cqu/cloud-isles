import { describe, expect, it, vi } from "vitest";
import {
  candidateRegions, streamDecision,
  PREFETCH_RADIUS_M, LOAD_RADIUS_M, UNLOAD_RADIUS_M,
} from "../src/world/streaming";
import {
  DEFAULT_WORLD_SEED, isStarterRegion, regionIslandKeys, islandCenterWorld,
  islandSeed, rngFromSeed, RECIPE_VERSION,
} from "../../shared/src/world-contract";
import { IslandStreamer } from "../src/world/streaming";
import type { IslandKey } from "../../shared/src/world-contract";

describe("流式决策:候选区域", () => {
  it("覆盖预取半径内的所有区域(含负坐标 floor 语义)", () => {
    const regions = candidateRegions({ x: 0, z: 0 }, PREFETCH_RADIUS_M);
    // 2300m 预取半径 → 每轴至少跨 4 个区域(640m/区域)
    expect(regions.length).toBeGreaterThanOrEqual(16);
    expect(regions).toContainEqual({ x: 0, z: 0 });
    expect(regions).toContainEqual({ x: -1, z: -1 });
    expect(regions).toContainEqual({ x: 3, z: -3 });
    // 负坐标:焦点在区域边界负侧
    const neg = candidateRegions({ x: -700, z: -700 }, PREFETCH_RADIUS_M);
    expect(neg).toContainEqual({ x: -2, z: -2 });
    expect(neg).toContainEqual({ x: -1, z: -1 });
  });

  it("起始区域被排除在生成之外", () => {
    for (const region of candidateRegions({ x: 0, z: 0 }, PREFETCH_RADIUS_M)) {
      if (["r0_0", "r-1_0", "r0_-1", "r-1_-1"].includes(`r${region.x}_${region.z}`)) {
        expect(isStarterRegion(region)).toBe(true);
      }
    }
    // 预取圈起始点只覆盖起始区与新区域;新区域不被保护
    const near = candidateRegions({ x: 1000, z: 1000 }, PREFETCH_RADIUS_M).filter((r) => !isStarterRegion(r));
    expect(near.length).toBeGreaterThan(0);
  });
});

describe("流式决策:滞回", () => {
  it("idle 在预取圈内请求,圈外不动", () => {
    expect(streamDecision("idle", PREFETCH_RADIUS_M - 1)).toBe("request");
    expect(streamDecision("idle", PREFETCH_RADIUS_M + 10)).toBe("none");
  });
  it("ready 进入加载圈装载", () => {
    expect(streamDecision("ready", LOAD_RADIUS_M - 1)).toBe("load");
    expect(streamDecision("ready", LOAD_RADIUS_M + 1)).toBe("none");
  });
  it("loaded 超出卸载圈卸载;滞回区间不抖动", () => {
    expect(streamDecision("loaded", UNLOAD_RADIUS_M + 1)).toBe("unload");
    // 加载/卸载之间的地带:已装载的不卸载,未装载的不装载
    const mid = (LOAD_RADIUS_M + UNLOAD_RADIUS_M) / 2;
    expect(streamDecision("loaded", mid)).toBe("none");
    expect(streamDecision("ready", mid)).toBe("none");
    expect(UNLOAD_RADIUS_M).toBeGreaterThan(LOAD_RADIUS_M);
  });
  it("requested/failed 不重复触发", () => {
    expect(streamDecision("requested", 0)).toBe("none");
    expect(streamDecision("failed", 0)).toBe("none");
  });
});

describe("流式扫描:卸载巡查覆盖全部条目", () => {
  // 回归:扫描圈=预取半径(2300m) < 卸载半径(3000m),只遍历候选区域时,
  // 已远离(>2300m)的已装载岛屿永远不会被卸载,常驻资源无界增长。
  function makeStreamer() {
    const world = { islands: [], docks: [], pickups: [] } as unknown as never;
    const events: string[] = [];
    const streamer = new IslandStreamer({
      scene: {} as never, world,
      shadowAdd: () => {}, registerPickup: () => {},
      onToast: () => {},
      onEvent: (kind) => { events.push(kind); },
    });
    return { streamer, world: world as unknown as { islands: unknown[]; docks: unknown[]; pickups: unknown[] }, events };
  }

  function loadedEntry(keyStr: string, cx: number, cz: number) {
    return {
      key: { region: { x: 9, z: 0 }, index: 0 } as IslandKey,
      keyStr, state: "loaded" as const, pickups: [], failedAt: 0, pollAt: 0, loading: false,
      descriptor: { centerWorld: [cx, 20, cz] },
      island: { dispose: vi.fn() },
    };
  }

  it("超出卸载半径的已装载岛在扫描圈外也会被卸载", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { streamer, world, events } = makeStreamer();
    const far = loadedEntry("r9_0/i0", 5000, 320);
    const disposeSpy = far.island.dispose;
    (streamer as unknown as { entries: Map<string, unknown> }).entries.set("r9_0/i0", far);
    // 焦点在原点:far 距离 5000m,远超卸载半径,且不在预取扫描圈内
    (streamer as unknown as { scan: (f: unknown) => void }).scan({ x: 0, y: 0, z: 0 });
    expect(far.state).toBe("ready");
    expect(disposeSpy).toHaveBeenCalled();
    expect(world.islands).toHaveLength(0);
    expect(events).toContain("island_unloaded");
    vi.unstubAllGlobals();
  });

  it("卸载半径内的已装载岛不受巡查影响", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { streamer } = makeStreamer();
    const near = loadedEntry("r1_0/i0", 960, 320);
    (streamer as unknown as { entries: Map<string, unknown> }).entries.set("r1_0/i0", near);
    (streamer as unknown as { scan: (f: unknown) => void }).scan({ x: 960, y: 0, z: 320 });
    expect(near.state).toBe("loaded");
    expect(near.island?.dispose).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("远离扫描圈的在途请求回收为 idle,并发名额让给就近区域", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { streamer } = makeStreamer();
    const stale = loadedEntry("r9_9/i0", 9000, -9000);
    stale.state = "requested";
    stale.island = undefined;
    stale.descriptor = undefined;
    (streamer as unknown as { entries: Map<string, unknown> }).entries.set("r9_9/i0", stale);
    (streamer as unknown as { scan: (f: unknown) => void }).scan({ x: 0, y: 0, z: 0 });
    expect(stale.state).toBe("idle");
    vi.unstubAllGlobals();
  });

  it("就近但尚无描述符的请求不被误回收(回归:distTo 无描述符返回 Infinity)", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { streamer } = makeStreamer();
    const near = loadedEntry("r1_0/i0", 960, 320);
    near.state = "requested";
    near.island = undefined;
    near.descriptor = undefined;
    (streamer as unknown as { entries: Map<string, unknown> }).entries.set("r1_0/i0", near);
    (streamer as unknown as { scan: (f: unknown) => void }).scan({ x: 960, y: 0, z: 320 });
    expect(near.state).toBe("requested");
    vi.unstubAllGlobals();
  });
});

describe("流式契约:客户端侧确定性布置基准", () => {
  it("资源流种子跨进程可重建(布置摘要一致性依据)", () => {
    const key = regionIslandKeys(20261105, { x: 1, z: 0 })[0];
    const seedA = islandSeed(20261105, key, "resources");
    const seedB = islandSeed(20261105, key, "resources");
    expect(seedA).toBe(seedB);
    const a = rngFromSeed(seedA);
    const b = rngFromSeed(seedB);
    for (let i = 0; i < 16; i++) expect(a()).toBe(b());
  });

  it("默认种子下新区域中心可确定", () => {
    const key = regionIslandKeys(DEFAULT_WORLD_SEED, { x: 2, z: -1 })[0];
    const [cx, alt, cz] = islandCenterWorld(DEFAULT_WORLD_SEED, key);
    expect(cx).toBeGreaterThan(0);
    expect(Math.abs(alt)).toBeLessThanOrEqual(4);
    expect(cz).toBeLessThan(0);
  });

  it("缓存键路径含配方版本与种子(回访寻址稳定)", () => {
    // streaming 的 fetch 走 descriptor.addresses(服务端产出);此处验证契约同源参数
    const key = regionIslandKeys(20261105, { x: 1, z: 0 })[0];
    const [cx, , cz] = islandCenterWorld(20261105, key);
    // 中心 = 区域中心 + ≤120m 抖动
    expect(Math.abs(cx - 960)).toBeLessThanOrEqual(121);
    expect(Math.abs(cz - 320)).toBeLessThanOrEqual(121);
    expect(RECIPE_VERSION).toMatch(/^w2-/);
  });
});
