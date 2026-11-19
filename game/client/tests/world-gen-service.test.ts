import { describe, expect, it, vi } from "vitest";
import { IslandGenerationService, focusFromQuery, parseIslandQuery } from "../../server/src/world-gen";

function makeService(overrides: Partial<ConstructorParameters<typeof IslandGenerationService>[0]> = {}) {
  const runGen = vi.fn(async () => ({ code: 0, output: '{"ok": true}' }));
  const files = new Set<string>();
  const svc = new IslandGenerationService({
    repoRoot: "R",
    python: "py",
    toolkitPath: "tk",
    runGen: runGen as unknown as (args: string[]) => Promise<{ code: number; output: string }>,
    fileExists: (p) => files.has(p.replaceAll("\\", "/")) || files.has(p),
    maxConcurrent: 1,
    jobTimeoutMs: 5000,
    ...overrides,
  });
  const markReady = (rx: number, rz: number, idx: number) => {
    const dir = svc.cacheDir(20261105, { x: rx, z: rz }, idx).replaceAll("\\", "/");
    for (const f of ["descriptor.json", "surface.json", "island.glb"]) files.add(`${dir}/${f}`);
  };
  return { svc, runGen, markReady };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("运行时生成服务", () => {
  it("缓存齐全时 isReady/readDescriptor 直读,不走生成", async () => {
    const { svc, runGen, markReady } = makeService();
    markReady(1, 0, 0);
    expect(svc.isReady(20261105, { x: 1, z: 0 }, 0)).toBe(true);
    expect(svc.readDescriptor(20261105, { x: 1, z: 0 }, 0)).toBe(null); // 文件存在但内容未写(注入环境)
    expect(runGen).not.toHaveBeenCalled();
  });

  it("未命中时进入队列;同键请求合并;参数含受限 --out 与坐标", async () => {
    const { svc, runGen } = makeService();
    // runGen 挂起:模拟生成中
    let release!: () => void;
    runGen.mockImplementationOnce(() => new Promise<{ code: number; output: string }>((r) => { release = () => r({ code: 0, output: "" }); }));
    const a = svc.request(20261105, { x: 1, z: 0 }, 0, 20261105);
    expect(a.status).toBe("generating"); // 并发1立即开跑
    const b = svc.request(20261105, { x: 1, z: 0 }, 0, 20261105);
    expect(b.status).toBe("generating");
    expect(runGen).toHaveBeenCalledTimes(1);
    const args = runGen.mock.calls[0][0] as string[];
    expect(args.some((s) => String(s).endsWith("lsic_world_gen.py"))).toBe(true);
    expect(args).toContain("--world-seed");
    expect(args).toContain("--recipe");
    const outIdx = args.indexOf("--out");
    expect(args[outIdx + 1]).toContain("runtime-cache");
    release();
    await flush();
  });

  it("生成完成后作业落地;再次请求同键重新入队", async () => {
    const { svc, runGen, markReady } = makeService();
    let release!: () => void;
    runGen.mockImplementationOnce(() => new Promise<{ code: number; output: string }>((r) => { release = () => r({ code: 0, output: "" }); }));
    const a = svc.request(20261105, { x: 2, z: 0 }, 0, 20261105);
    expect(a.status).toBe("generating");
    markReady(2, 0, 0); // 生成器写完缓存后再结束进程
    release();
    await flush();
    await flush();
    expect(svc.peek("r2_0/0")).toBe(null); // done 后移除
    const again = svc.request(20261105, { x: 2, z: 0 }, 0, 20261105);
    expect(["queued", "generating"]).toContain(again.status);
  });

  it("生成失败:作业保留,子进程落地前不允许重发(防并发写缓存)", async () => {
    const { svc, runGen } = makeService();
    let release!: () => void;
    runGen.mockImplementationOnce(() => new Promise<{ code: number; output: string }>((r) => { release = () => r({ code: 1, output: "boom" }); }));
    const a = svc.request(20261105, { x: 3, z: 0 }, 0, 20261105);
    expect(a.status).toBe("generating");
    release();
    await flush();
    await flush();
    const failed = svc.peek("r3_0/0");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("exit 1");
    const retry = svc.request(20261105, { x: 3, z: 0 }, 0, 20261105);
    expect(["queued", "generating"]).toContain(retry.status);
  });

  it("并发上限=1 时第二个请求排队(queueAhead 递增)", async () => {
    const { svc, runGen } = makeService();
    let release!: () => void;
    runGen.mockImplementation(() => new Promise<{ code: number; output: string }>((r) => { release = () => r({ code: 0, output: "" }); }));
    svc.request(20261105, { x: 4, z: 0 }, 0, 20261105);
    const second = svc.request(20261105, { x: 4, z: 1 }, 0, 20261105);
    expect(second.status).toBe("queued");
    expect(second.queueAhead).toBe(0);
    release();
    await flush();
    await flush();
  });

  it("队列满时拒绝并报错", async () => {
    const { svc, runGen } = makeService({ maxQueue: 1 });
    let release!: () => void;
    runGen.mockImplementation(() => new Promise<{ code: number; output: string }>((r) => { release = () => r({ code: 0, output: "" }); }));
    svc.request(20261105, { x: 5, z: 0 }, 0, 20261105); // running
    const rejected = svc.request(20261105, { x: 5, z: 2 }, 0, 20261105);
    expect(rejected.status).toBe("failed");
    expect(rejected.error).toContain("queue full");
    release();
    await flush();
  });

  it("距离优先调度:玩家焦点附近的排队岛先于更远的岛(验收 D4)", async () => {
    const { svc, runGen } = makeService();
    let release!: () => void;
    runGen.mockImplementation(() => new Promise<{ code: number; output: string }>((r) => { release = () => r({ code: 0, output: "" }); }));
    // 岛中心由契约推导: r2_0 ≈ (1920,640), r4_0 ≈ (3840,1280)
    svc.request(20261105, { x: 3, z: 0 }, 0, 20261105); // 无 focus,先占住并发槽
    const near = svc.request(20261105, { x: 2, z: 0 }, 0, 20261105, { x: 1900, z: 600 });
    const far = svc.request(20261105, { x: 4, z: 0 }, 0, 20261105, { x: 1900, z: 600 });
    expect(near.status).toBe("queued");
    expect(far.status).toBe("queued");
    expect(far.queueAhead).toBe(1); // 近岛排在远岛前面
    expect(near.queueAhead).toBe(0);
    release();
    await flush();
    await flush();
    // 第一个任务结束后,调度近岛而非更早入队的远岛
    const secondArgs = runGen.mock.calls[1]?.[0] as string[] | undefined;
    expect(secondArgs).toBeDefined();
    const rxIdx = secondArgs!.indexOf("--rx");
    expect(secondArgs![rxIdx + 1]).toBe("2");
    release();
    await flush();
    await flush();
  });

  it("轮询重复请求刷新排队作业的距离优先级", async () => {
    const { svc, runGen } = makeService();
    let release!: () => void;
    runGen.mockImplementation(() => new Promise<{ code: number; output: string }>((r) => { release = () => r({ code: 0, output: "" }); }));
    svc.request(20261105, { x: 1, z: 0 }, 0, 20261105); // running
    svc.request(20261105, { x: 2, z: 0 }, 0, 20261105); // 无 focus 先入队
    svc.request(20261105, { x: 4, z: 0 }, 0, 20261105);
    // 玩家向 r4_0 移动后轮询:r4_0 距离刷新为最近,应先于 r2_0 调度
    svc.request(20261105, { x: 4, z: 0 }, 0, 20261105, { x: 3800, z: 1200 });
    release();
    await flush();
    await flush();
    const secondArgs = runGen.mock.calls[1]?.[0] as string[] | undefined;
    const rxIdx = secondArgs!.indexOf("--rx");
    expect(secondArgs![rxIdx + 1]).toBe("4");
    release();
    await flush();
  });
});

describe("生成服务参数校验", () => {
  it("只接受受限整数;非法输入返回错误串", () => {
    expect(parseIslandQuery({ rx: 1, rz: 0, idx: 0 })).toEqual({ worldSeed: 20261105, region: { x: 1, z: 0 }, idx: 0 });
    expect(typeof parseIslandQuery({ rx: 1.5, rz: 0, idx: 0 })).toBe("string");
    expect(typeof parseIslandQuery({ rx: 1, rz: 0, idx: -1 })).toBe("string");
    expect(typeof parseIslandQuery({ rx: 1, rz: 0, idx: 99 })).toBe("string");
    expect(typeof parseIslandQuery({ rx: 99999, rz: 0, idx: 0 })).toBe("string");
    expect(typeof parseIslandQuery({ seed: "x", rx: 1, rz: 0, idx: 0 })).toBe("string");
    expect(parseIslandQuery({ seed: 7, rx: -2, rz: -3, idx: 0 })).toEqual({ worldSeed: 7, region: { x: -2, z: -3 }, idx: 0 });
  });

  it("focus 查询参数:合法坐标解析,缺省或非法忽略", () => {
    expect(focusFromQuery({ fx: 100, fz: -200 })).toEqual({ x: 100, z: -200 });
    expect(focusFromQuery({})).toBeUndefined();
    expect(focusFromQuery({ fx: "x", fz: 1 })).toBeUndefined();
  });
});
