// 运行时岛屿生成服务：缓存命中直读,未命中进入有界生成队列(argv 子进程调用
// tools/lsic_world_gen.py)。客户端只传 seed/区域坐标/岛序,不得传路径、配方或
// 任意 LSIC 操作;输出路径由服务端按共享契约(world-contract.ts)推导并校验。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_WORLD_SEED, RECIPE_VERSION, islandCenterWorld, recipeForIsland, regionKeyToString,
  type IslandDescriptor, type IslandKey, type RegionKey,
} from "shared";

export type GenStatus = "queued" | "generating" | "ready" | "failed";

export interface GenJobView {
  key: string;
  status: GenStatus;
  error?: string;
  queueAhead: number;
}

export interface GenDeps {
  /** 项目根(缓存根 <repoRoot>/assets/lsic/runtime-cache) */
  repoRoot: string;
  /** 项目 .venv python 解释器 */
  python: string;
  /** LSIC 工具根(PYTHONPATH 第一项) */
  toolkitPath: string;
  /** 注入测试:执行生成命令(默认 spawn python 子进程) */
  runGen?: (args: string[]) => Promise<{ code: number; output: string }>;
  /** 注入测试:文件存在性 */
  fileExists?: (p: string) => boolean;
  maxConcurrent?: number;
  jobTimeoutMs?: number;
  maxQueue?: number;
}

interface Job {
  key: string;
  args: string[];
  status: "queued" | "generating" | "failed" | "done";
  error?: string;
  /** 子进程已结束(失败作业在其子进程落地前不允许重发,防并发写同一缓存目录) */
  settled: boolean;
  /** 距玩家焦点的近似距离(米);排队作业按此升序调度,无焦点时排队尾(验收 D4)。 */
  dist: number;
}

export class IslandGenerationService {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running = 0;
  private readonly maxConcurrent: number;
  private readonly jobTimeoutMs: number;
  private readonly maxQueue: number;
  private readonly runGen: (args: string[]) => Promise<{ code: number; output: string }>;
  private readonly fileExists: (p: string) => boolean;

  constructor(private deps: GenDeps) {
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 1);
    this.jobTimeoutMs = deps.jobTimeoutMs ?? 300_000;
    this.maxQueue = deps.maxQueue ?? 32;
    this.runGen = deps.runGen ?? ((args) => this.spawnPython(args));
    this.fileExists = deps.fileExists ?? ((p) => existsSync(p));
  }

  cacheDir(worldSeed: number, region: RegionKey, idx: number): string {
    return join(
      this.deps.repoRoot, "assets", "lsic", "runtime-cache",
      RECIPE_VERSION, String(worldSeed), regionKeyToString(region), String(idx),
    );
  }

  /** 缓存命中判定:descriptor + surface + glb 齐全才算就绪(半成品缓存按未命中处理)。 */
  isReady(worldSeed: number, region: RegionKey, idx: number): boolean {
    return this.dirReady(this.cacheDir(worldSeed, region, idx));
  }

  private dirReady(dir: string): boolean {
    return (
      this.fileExists(join(dir, "descriptor.json")) &&
      this.fileExists(join(dir, "surface.json")) &&
      this.fileExists(join(dir, "island.glb"))
    );
  }

  readDescriptor(worldSeed: number, region: RegionKey, idx: number): IslandDescriptor | null {
    try {
      return JSON.parse(
        readFileSync(join(this.cacheDir(worldSeed, region, idx), "descriptor.json"), "utf-8"),
      ) as IslandDescriptor;
    } catch {
      return null;
    }
  }

  /** 请求生成;返回当前作业视图。同键作业进行中合并;已落地的失败作业可重发。
   * focus 为客户端玩家坐标(可选):排队作业按距焦点远近调度,玩家当前要去的岛
   * 先于沿途更远的岛生成;轮询重复请求会持续刷新距离,队列随玩家移动收敛。 */
  request(worldSeed: number, region: RegionKey, idx: number, seedGiven: number, focus?: { x: number; z: number }): GenJobView {
    const key = `${regionKeyToString(region)}/${idx}`;
    const islandKey: IslandKey = { region, index: idx };
    const dist = focus ? (() => {
      const [cx, , cz] = islandCenterWorld(worldSeed, islandKey);
      return Math.hypot(focus.x - cx, focus.z - cz);
    })() : Infinity;
    const existing = this.jobs.get(key);
    if (existing && !(existing.status === "failed" && existing.settled)) {
      if (existing.status === "queued" && focus) existing.dist = dist;
      return this.view(existing);
    }
    if (this.queue.length + this.running >= this.maxQueue) {
      return { key, status: "failed", error: "generation queue full", queueAhead: 0 };
    }
    const dir = this.cacheDir(worldSeed, region, idx);
    // --out 由服务端从契约推导;子进程自身还会校验在缓存根内。不接收客户端路径。
    // 配方按共享契约由 seed/区域派生(forest/canyon/ruins),客户端不可指定。
    const args = [
      join(this.deps.repoRoot, "tools", "lsic_world_gen.py"),
      "--world-seed", String(seedGiven),
      "--rx", String(region.x), "--rz", String(region.z),
      "--idx", String(idx), "--recipe", recipeForIsland(worldSeed, islandKey), "--out", dir,
    ];
    const job: Job = { key, args, status: "queued", settled: false, dist };
    this.jobs.set(key, job);
    this.queue.push(key);
    this.pump();
    return this.view(job);
  }

  private view(job: Job): GenJobView {
    const status: GenStatus =
      job.status === "queued" ? "queued" : job.status === "generating" ? "generating" : "failed";
    // 距离优先调度下"排在前"=距离更近,或同距离且入队更早(queue 数组保持入队顺序)。
    let queueAhead = 0;
    for (const k of this.queue) {
      if (k === job.key) break;
      const other = this.jobs.get(k);
      if (other && other.dist <= job.dist) queueAhead++;
    }
    return {
      key: job.key,
      status,
      error: job.error,
      queueAhead,
    };
  }

  peek(key: string): GenJobView | null {
    const job = this.jobs.get(key);
    return job ? this.view(job) : null;
  }

  get queueDepth(): number {
    return this.queue.length + this.running;
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      // 距离优先:玩家焦点附近的岛先于沿途更远的岛(同距离按入队顺序)。
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.jobs.get(this.queue[i]!);
        const b = this.jobs.get(this.queue[best]!);
        if ((a?.dist ?? Infinity) < (b?.dist ?? Infinity)) best = i;
      }
      const key = this.queue.splice(best, 1)[0]!;
      const job = this.jobs.get(key);
      if (!job || job.status !== "queued") continue;
      job.status = "generating";
      this.running++;
      const startedAt = Date.now();
      this.runGen(job.args)
        .then(({ code, output }) => {
          if (Date.now() - startedAt > this.jobTimeoutMs) {
            this.fail(job, `generation timed out after ${this.jobTimeoutMs}ms`);
          } else if (code !== 0) {
            this.fail(job, `generator exit ${code}: ${output.slice(-300)}`);
          } else if (!this.dirReady(argsOutDir(job.args))) {
            this.fail(job, "generator reported ok but cache incomplete");
          } else {
            job.status = "done";
            this.jobs.delete(key);
          }
        })
        .catch((e: unknown) => this.fail(job, `generator error: ${String(e).slice(0, 300)}`))
        .finally(() => {
          job.settled = true;
          this.running--;
          this.pump();
        });
      // 软超时:到点标记失败(子进程由 spawnPython 的 kill 兜底);作业保留在表中防重发竞态
      const timer = setTimeout(() => {
        if (job.status === "generating") this.fail(job, `generation exceeded ${this.jobTimeoutMs}ms`);
      }, this.jobTimeoutMs);
      void timer;
    }
  }

  private fail(job: Job, message: string): void {
    job.status = "failed";
    job.error = message;
  }

  private spawnPython(args: string[]): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.deps.python, args, {
        cwd: this.deps.repoRoot,
        env: {
          ...process.env,
          PYTHONPATH: [this.deps.toolkitPath, join(this.deps.repoRoot, "tools"), process.env.PYTHONPATH ?? ""]
            .filter(Boolean)
            .join(";"),
        },
        windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { output += d.toString(); });
      const killer = setTimeout(() => child.kill("SIGKILL"), this.jobTimeoutMs + 5000);
      child.on("close", (code) => {
        clearTimeout(killer);
        resolve({ code: code ?? -1, output });
      });
      child.on("error", (e) => {
        clearTimeout(killer);
        resolve({ code: -1, output: `${output}\nspawn error: ${e.message}` });
      });
    });
  }
}

function argsOutDir(args: string[]): string {
  const i = args.indexOf("--out");
  return i >= 0 ? args[i + 1] : "";
}

/** 路由层参数校验:只接受受限整数;区域/岛序范围受限,起始区域不由此服务生成。 */
export function parseIslandQuery(q: Record<string, unknown>): {
  worldSeed: number; region: RegionKey; idx: number;
} | string {
  const seed = Number(q.seed ?? DEFAULT_WORLD_SEED);
  const rx = Number(q.rx), rz = Number(q.rz);
  const idx = q.idx === undefined ? 0 : Number(q.idx);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31) return "bad seed";
  if (!Number.isInteger(rx) || !Number.isInteger(rz)) return "bad region";
  if (!Number.isInteger(idx) || idx < 0 || idx > 7) return "bad idx";
  if (Math.abs(rx) > 4096 || Math.abs(rz) > 4096) return "region out of range";
  return { worldSeed: seed, region: { x: rx, z: rz }, idx };
}

/** 可选玩家焦点坐标(fx/fz):生成队列距离优先调度用;缺省或非法时忽略。 */
export function focusFromQuery(q: Record<string, unknown>): { x: number; z: number } | undefined {
  const fx = Number(q.fx), fz = Number(q.fz);
  return Number.isFinite(fx) && Number.isFinite(fz) ? { x: fx, z: fz } : undefined;
}
