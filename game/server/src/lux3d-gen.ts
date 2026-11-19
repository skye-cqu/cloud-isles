// Lux3D 运行时物品生成：单并发队列 + 官方 CLI 子进程（创建/轮询/下载一体）。
// 产物落 public/assets/generated，经 /generated-assets/ 静态托管（dev 与生产同路径）。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LuxJob {
  opId: string;
  prompt: string;
  status: "queued" | "running" | "done" | "failed";
  taskId?: string;
  /** 模型 URL 路径（/generated-assets/gen-<opId>.glb） */
  file?: string;
  error?: string;
  startedAt: number;
}

interface IndexEntry { file: string; taskId?: string; prompt: string; createdAt: number }

export class LuxGenerationService {
  private jobs = new Map<string, LuxJob>();
  private pending: string[] = [];
  private active: string | null = null;
  private index: Record<string, IndexEntry> = {};

  constructor(private opts: {
    python: string;
    clientScript: string;
    outDir: string;
    apiKey: string;
    jobTimeoutMs?: number;
  }) {
    mkdirSync(opts.outDir, { recursive: true });
    const indexPath = join(opts.outDir, "index.json");
    if (existsSync(indexPath)) {
      try { this.index = JSON.parse(readFileSync(indexPath, "utf-8")); } catch { this.index = {}; }
    }
  }

  get ready(): boolean { return !!this.opts.apiKey; }
  get queueDepth(): number { return this.pending.length; }

  /** 相同 opId 幂等返回；服务重启后同 opId 命中历史产物。 */
  request(opId: string, prompt: string): { status: LuxJob["status"] | "busy"; job?: LuxJob } {
    const existing = this.jobs.get(opId);
    if (existing) return { status: existing.status, job: existing };
    // 查找键与 run() 存储键同用净化名（opId 含 ":" 时原始名与文件名不一致，会导致重启后缓存永不命中）
    const cached = this.index[`gen-${opId.replace(/[^a-zA-Z0-9_-]/g, "_")}.glb`];
    if (cached && existsSync(join(this.opts.outDir, cached.file))) {
      const job: LuxJob = { opId, prompt, status: "done", taskId: cached.taskId, file: `/generated-assets/${cached.file}`, startedAt: cached.createdAt };
      this.jobs.set(opId, job);
      return { status: "done", job };
    }
    if (this.active && this.pending.length >= 4) return { status: "busy" };
    const job: LuxJob = { opId, prompt, status: this.active ? "queued" : "running", startedAt: Date.now() };
    this.jobs.set(opId, job);
    if (this.active) {
      this.pending.push(opId);
      return { status: "queued", job };
    }
    this.active = opId;
    this.run(job);
    return { status: "running", job };
  }

  status(opId: string): LuxJob | null { return this.jobs.get(opId) ?? null; }

  private run(job: LuxJob) {
    // opId 可能带 ":"（如 base:gen）——Windows 文件名禁止冒号，净化为下划线
    const outName = `gen-${job.opId.replace(/[^a-zA-Z0-9_-]/g, "_")}.glb`;
    const outPath = join(this.opts.outDir, outName);
    const timeout = this.opts.jobTimeoutMs ?? 600_000;
    const args = [
      this.opts.clientScript, "text",
      "--style", "hand_painted", "--version", "G1", "--face-count", "15000", "--format", "glb",
      "--max-attempts", "64", "--interval", "8",
      job.prompt.slice(0, 300), outPath,
    ];
    const child = spawn(this.opts.python, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      job.status = "failed";
      job.error = "生成超时";
      try { child.kill(); } catch { /* already exited */ }
    }, timeout);
    child.stdout?.on("data", (c) => { output += c; });
    child.stderr?.on("data", (c) => { output += c; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const taskId = /taskId["=:\s]+(\d+)/.exec(output)?.[1];
      // CLI 会在 output_path 基名后追加格式后缀（如 <base>_glb.glb）——归一到 gen-<opId>.glb
      let produced = existsSync(outPath) ? outPath : null;
      if (!produced && code === 0) {
        const stem = outName.replace(/\.glb$/, "");
        const variants = readdirSync(this.opts.outDir)
          .filter((f) => f.startsWith(stem) && f.endsWith(".glb") && f !== outName)
          .map((f) => join(this.opts.outDir, f));
        if (variants.length) {
          produced = variants[0];
          try { renameSync(produced, outPath); produced = outPath; } catch { /* keep variant path */ }
        }
      }
      // 清理同任务的附属 zip，避免产物目录膨胀
      try {
        const stem = outName.replace(/\.glb$/, "");
        for (const f of readdirSync(this.opts.outDir)) {
          if (f.startsWith(stem) && f.endsWith(".zip")) rmSync(join(this.opts.outDir, f));
        }
      } catch { /* best-effort */ }
      if (code === 0 && produced) {
        job.status = "done";
        job.taskId = taskId;
        job.file = `/generated-assets/${outName}`;
        this.index[outName] = { file: outName, taskId, prompt: job.prompt, createdAt: Date.now() };
        try { writeFileSync(join(this.opts.outDir, "index.json"), JSON.stringify(this.index, null, 2)); } catch { /* best-effort */ }
      } else if (job.status !== "failed") {
        job.status = "failed";
        job.error = `lux3d client exit ${code}: ${output.slice(-200)}`;
      }
      this.active = null;
      const nextId = this.pending.shift();
      if (nextId) {
        const nextJob = this.jobs.get(nextId)!;
        nextJob.status = "running";
        this.active = nextId;
        this.run(nextJob);
      }
    });
  }
}
