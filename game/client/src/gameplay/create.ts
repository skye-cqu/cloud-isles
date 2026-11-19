// 语言创造：自然语言 → 建造方案 → 多件 ghost 预览 → 整单提交/回滚 → 个人目录（Lux3D 生成）。
// 三种撤销语义：提交前取消=无消耗；提交失败整单回滚=全额退款；建成后拆除=日常半价（build.remove）。
import { Scene, Vector3, Mesh, MeshBuilder, StandardMaterial, TransformNode } from "@babylonjs/core";
import { BUILD_CATALOG, BuildPartDef, CreatePlanSolution, SavedPersonalPart, localCreatePlan, sanitizeCreatePlan } from "shared";
import { BuildSystem, PlacedBuilding } from "./build";
import type { Inventory } from "./items";
import { readyNpcRequestMeta } from "../core/cloudSync";
import { loadItemModel } from "../assets/itemModels";
import type { Hud } from "../core/ui";
import type { World } from "../world/world";
import type { Player } from "../world/player";

const EXAMPLES = ["南坡观景台", "带灯的小花园", "一盏贝壳提灯"];
const PLAN_TIMEOUT_MS = 15_000;
const GEN_POLL_MS = 4_000;
const GEN_TIMEOUT_MS = 10 * 60_000;
/** 运行时生成物品的目标宽（米）：小件陈设尺度 */
const NOVEL_WIDTH = 1.2;

export type CreateState = "closed" | "input" | "thinking" | "preview";

interface GhostPart { def: BuildPartDef; node: TransformNode; box: Mesh; pos: Vector3; rotY: number; valid: boolean }

export class CreateSystem {
  state: CreateState = "closed";
  plan: CreatePlanSolution | null = null;
  personalParts: SavedPersonalPart[] = [];
  onEvent?: (kind: string, data?: unknown) => void;
  private anchor = new Vector3();
  private planRotY = 0;
  private ghosts: GhostPart[] = [];
  private disc: Mesh | null = null;
  private hint: HTMLDivElement | null = null;
  private thinkCtrl: AbortController | null = null;
  private genTimer: ReturnType<typeof setInterval> | null = null;
  private genDeadline = 0;
  private composing = false;
  private committedIds = new Set<string>();

  constructor(
    private scene: Scene,
    private world: World,
    private build: BuildSystem,
    private hud: Hud,
    private inv: Inventory,
    private player: Player,
  ) {}

  // ---------- 面板（意图输入） ----------

  open() {
    if (this.state !== "closed") return;
    this.state = "input";
    const cards = EXAMPLES.map((t) => `<button class="createExample" data-text="${t}" style="margin:2px 6px 2px 0; padding:4px 10px; border:1px solid #5a7a9a; background:#1c2a3a; color:#cfe2f5; border-radius:6px; cursor:pointer; font-size:12px;">${t}</button>`).join("");
    this.hud.showPanel("创造 — 说出你想要的样子", [
      `<div style="font-size:12px; color:#9fb6c9; margin-bottom:6px;">示例：</div><div>${cards}</div>`,
      `<textarea id="createText" rows="3" placeholder="例如：在南坡搭一个带灯的观景台，放两把椅子" style="width:96%; margin-top:10px; background:#101a24; color:#e8f0f8; border:1px solid #3a5468; border-radius:6px; padding:8px; font-size:14px; resize:vertical;"></textarea>`,
      `<div style="margin-top:8px; display:flex; align-items:center; gap:10px;">`,
      `<button id="createSubmit" style="padding:6px 18px; background:#2e6da4; border:none; color:#fff; border-radius:6px; cursor:pointer; font-size:13px;">规划方案</button>`,
      `<span id="createStatus" style="font-size:12px; color:#9fb6c9;"></span></div>`,
    ].join(""), () => this.onPanelClosed());
    const body = this.hud.panelBody;
    const ta = body.querySelector<HTMLTextAreaElement>("#createText")!;
    body.querySelectorAll<HTMLElement>(".createExample").forEach((el) =>
      el.addEventListener("click", () => { ta.value = el.dataset.text ?? ""; ta.focus(); }));
    // 中文输入法兼容：组词期间 Enter 不提交
    ta.addEventListener("compositionstart", () => { this.composing = true; });
    ta.addEventListener("compositionend", () => { this.composing = false; });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.composing) { e.preventDefault(); void this.submitText(ta.value); }
    });
    body.querySelector<HTMLButtonElement>("#createSubmit")!.addEventListener("click", () => void this.submitText(ta.value));
    ta.focus();
  }

  private status(text: string) {
    this.hud.panelBody.querySelector<HTMLElement>("#createStatus")!.textContent = text;
  }

  private onPanelClosed() {
    this.thinkCtrl?.abort();
    this.thinkCtrl = null;
    if (this.state === "input" || this.state === "thinking") this.state = "closed";
  }

  private async submitText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.state === "thinking") return;
    this.state = "thinking";
    this.status("构思中…");
    const meta = await readyNpcRequestMeta();
    this.thinkCtrl = new AbortController();
    let plan: CreatePlanSolution | null = null;
    try {
      const res = await fetch("/api/create/plan", {
        method: "POST",
        headers: { "content-type": "application/json", ...(meta.sessionId ? { "x-save-session": meta.sessionId, "x-save-token": meta.token! } : {}) },
        body: JSON.stringify({ text: trimmed, operationId: meta.operationId }),
        signal: this.thinkCtrl.signal,
      });
      if (res.ok) {
        const data = await res.json() as CreatePlanSolution;
        plan = sanitizeCreatePlan(data);
      }
    } catch { /* 超时/离线 → 本地兜底 */ }
    this.thinkCtrl = null;
    if (this.state !== "thinking") return; // 面板已被关闭/取消
    plan ??= localCreatePlan(trimmed);
    if (plan.clarification?.length) {
      this.state = "input";
      this.showClarification(trimmed, plan.clarification);
      return;
    }
    this.enterPreview(plan);
  }

  private showClarification(original: string, questions: string[]) {
    const buttons = questions.map((q, i) => `<button class="createClar" data-i="${i}" style="display:block; width:100%; margin:6px 0; padding:8px; background:#1c2a3a; border:1px solid #5a7a9a; color:#cfe2f5; border-radius:6px; cursor:pointer; text-align:left;">${q}</button>`).join("");
    this.hud.showPanel("还差一点信息", `<div style="font-size:13px; color:#cfe2f5;">选一个最接近的想法：</div>${buttons}`, () => { this.state = "closed"; });
    this.hud.panelBody.querySelectorAll<HTMLElement>(".createClar").forEach((el) =>
      el.addEventListener("click", () => {
        const answer = questions[Number(el.dataset.i)];
        this.hud.hidePanel();
        void this.submitText(`${original}（补充：${answer}）`);
      }));
  }

  // ---------- 预览（多件 ghost 组） ----------

  private enterPreview(plan: CreatePlanSolution) {
    // 逐件去重叠：方案内互相重叠的部件会被 canPlace 拒绝导致整单失败，预览前先丢弃后出现的冲突件
    // （方案部件全部落地贴地，y 同高，只比 x/z 间距）
    const kept: typeof plan.parts = [];
    for (const p of plan.parts) {
      const def = BUILD_CATALOG.find((d) => d.id === p.partId)!;
      const clash = kept.some((k) => {
        const kd = BUILD_CATALOG.find((d) => d.id === k.partId)!;
        return Math.abs(k.offset[0] - p.offset[0]) < (kd.size[0] + def.size[0]) / 2 * 0.7
          && Math.abs(k.offset[1] - p.offset[1]) < (kd.size[2] + def.size[2]) / 2 * 0.7;
      });
      if (!clash) kept.push(p);
    }
    plan = { ...plan, parts: kept };
    this.plan = plan;
    this.state = "preview";
    this.hud.hidePanel();
    this.planRotY = 0;
    const forward = new Vector3(Math.sin(this.player.node.rotation.y), 0, Math.cos(this.player.node.rotation.y));
    this.anchor.copyFrom(this.player.node.position.add(forward.scale(4.5)));
    this.buildGhostGroup();
    this.showHint(this.hintText());
    this.onEvent?.("create_preview", { summary: plan.summary, parts: plan.parts.length });
  }

  private buildGhostGroup() {
    this.disposeGhosts();
    const plan = this.plan!;
    for (const p of plan.parts) {
      const def = BUILD_CATALOG.find((d) => d.id === p.partId)!;
      const node = new TransformNode(`planGhost_${p.partId}`, this.scene);
      const box = MeshBuilder.CreateBox("planGhostBox", { width: def.size[0], height: def.size[1], depth: def.size[2] }, this.scene);
      box.parent = node;
      const m = new StandardMaterial("planGhostMat", this.scene);
      m.diffuseColor.set(0.3, 0.8, 0.5);
      m.emissiveColor.set(0.3, 0.8, 0.5);
      m.alpha = 0.4;
      box.material = m;
      box.isPickable = false;
      this.ghosts.push({ def, node, box, pos: new Vector3(), rotY: p.rotY, valid: false });
    }
    const extent = Math.max(3, ...plan.parts.map((p) => {
      const def = BUILD_CATALOG.find((d) => d.id === p.partId)!;
      return Math.hypot(p.offset[0], p.offset[1]) + Math.max(def.size[0], def.size[2]);
    }));
    const disc = MeshBuilder.CreateDisc("planFootprint", { radius: extent + 0.6, tessellation: 40 }, this.scene);
    disc.rotation.x = Math.PI / 2;
    const dm = new StandardMaterial("planFootprintMat", this.scene);
    dm.emissiveColor.set(0.25, 0.55, 0.85);
    dm.alpha = 0.12;
    disc.material = dm;
    disc.isPickable = false;
    this.disc = disc;
  }

  /** 每帧：ghost 组跟随玩家瞄准点，吸附地形并逐件校验 */
  update() {
    if (this.state !== "preview" || !this.plan) return;
    const home = this.world.islands[0];
    const forward = new Vector3(Math.sin(this.player.node.rotation.y), 0, Math.cos(this.player.node.rotation.y));
    this.anchor.copyFrom(this.player.node.position.add(forward.scale(4.5)));
    if (this.disc) {
      const g = home.heightAt(this.anchor.x, this.anchor.z);
      this.disc.position.set(this.anchor.x, (g ?? this.anchor.y) + 0.04, this.anchor.z);
    }
    const cos = Math.cos(this.planRotY), sin = Math.sin(this.planRotY);
    this.ghosts.forEach((g, i) => {
      const p = this.plan!.parts[i];
      const wx = this.anchor.x + p.offset[0] * cos - p.offset[1] * sin;
      const wz = this.anchor.z + p.offset[0] * sin + p.offset[1] * cos;
      const gy = home.heightAt(wx, wz);
      g.pos.set(wx, (gy ?? this.anchor.y) + 0.05, wz);
      g.rotY = p.rotY + this.planRotY;
      g.node.position.copyFrom(g.pos);
      g.node.rotation.y = g.rotY;
      const placeOk = gy !== null && this.build.canPlace(g.def, g.pos, g.rotY).ok;
      g.valid = placeOk && !this.clashesPlan(i, g.def);
      const m = g.box.material as StandardMaterial;
      m.emissiveColor.set(g.valid ? 0.3 : 0.9, g.valid ? 0.85 : 0.3, g.valid ? 0.5 : 0.25);
    });
    this.showHint(this.hintText());
  }

  /** 方案内两两重叠检查（与 canPlace 同一 AABB 规则） */
  private clashesPlan(self: number, def: BuildPartDef): boolean {
    return this.ghosts.some((other, j) => {
      if (j === self || !other.node.isEnabled()) return false;
      return Math.abs(other.pos.x - this.ghosts[self].pos.x) < (def.size[0] + other.def.size[0]) / 2 * 0.7
        && Math.abs(other.pos.z - this.ghosts[self].pos.z) < (def.size[2] + other.def.size[2]) / 2 * 0.7
        && Math.abs(other.pos.y - this.ghosts[self].pos.y) < (def.size[1] + other.def.size[1]) / 2;
    });
  }

  private costTotal(): Partial<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const p of this.plan?.parts ?? []) {
      const def = BUILD_CATALOG.find((d) => d.id === p.partId)!;
      for (const [id, n] of Object.entries(def.cost)) if (n) out[id] = (out[id] ?? 0) + n;
    }
    return out;
  }

  private hintText(): string {
    const plan = this.plan!;
    const cost = Object.entries(this.costTotal()).map(([id, n]) => `${id}×${n}`).join(" ") || "免费";
    const allValid = this.ghosts.length > 0 && this.ghosts.every((g) => g.valid);
    return `方案：${plan.summary}（${plan.parts.length} 件 · ${cost}）${allValid ? " · Enter 确认 / R 旋转 / Esc 取消" : " · 有部件无法放置，换个位置"}`;
  }

  rotate() {
    if (this.state !== "preview") return;
    this.planRotY += Math.PI / 4;
  }

  /** 提交：逐件走 place()（真实成本+全规则+幂等）；任一件失败 → 整单全额退款 */
  confirm() {
    if (this.state !== "preview" || !this.plan || !this.ghosts.every((g) => g.valid)) return;
    const total = this.costTotal();
    if (!this.inv.canAfford(total)) { this.onEvent?.("toast", "材料不足，无法执行该方案"); return; }
    const plan = this.plan;
    const base = `create-${crypto.randomUUID()}`;
    const placed: PlacedBuilding[] = [];
    this.ghosts.forEach((g, i) => {
      const b = this.build.place(g.def.id, g.pos, g.rotY, false, undefined, `${base}:${i}`);
      if (b) placed.push(b);
    });
    if (placed.length < plan.parts.length) {
      for (const b of placed) this.build.remove(b.uid, "full", false);
      this.onEvent?.("toast", `「${plan.summary}」提交失败，材料已全额退回（已放置 ${placed.length} 件被拆除）`);
      return; // 保持预览态，可调整后重试
    }
    this.disposeGhosts();
    this.hideHint();
    this.state = "closed";
    this.plan = null;
    this.onEvent?.("toast", `建成：${plan.summary}（${placed.length} 件）`);
    this.onEvent?.("created_plan", { summary: plan.summary, kind: plan.kind, uids: placed.map((b) => b.uid) });
    if (plan.novelItem) void this.startGeneration(plan.novelItem.name, plan.novelItem.prompt, base);
  }

  /** 提交前取消 / 面板 Esc —— 无消耗 */
  close() {
    this.thinkCtrl?.abort();
    this.thinkCtrl = null;
    this.stopGenPoll();
    this.disposeGhosts();
    this.hideHint();
    if (this.hud.panelVisible()) this.hud.hidePanel();
    this.state = "closed";
    this.plan = null;
  }

  private disposeGhosts() {
    for (const g of this.ghosts) g.node.dispose();
    this.ghosts = [];
    this.disc?.dispose();
    this.disc = null;
  }

  private showHint(text: string) {
    if (!this.hint) {
      this.hint = document.createElement("div");
      this.hint.style.cssText = "position:fixed; left:50%; bottom:16%; transform:translateX(-50%); padding:6px 14px; background:rgba(10,18,28,0.85); color:#e8f0f8; border:1px solid #3a5468; border-radius:8px; font-size:13px; z-index:40; pointer-events:none;";
      document.body.appendChild(this.hint);
    }
    this.hint.textContent = text;
  }

  private hideHint() {
    this.hint?.remove();
    this.hint = null;
  }

  // ---------- 新外形生成（Lux3D） ----------

  private async startGeneration(name: string, prompt: string, baseOpId: string) {
    const meta = await readyNpcRequestMeta();
    try {
      const res = await fetch("/api/create/generate", {
        method: "POST",
        headers: { "content-type": "application/json", ...(meta.sessionId ? { "x-save-session": meta.sessionId, "x-save-token": meta.token! } : {}) },
        body: JSON.stringify({ prompt, operationId: `${baseOpId}:gen` }),
      });
      if (!res.ok) throw new Error(`generate http ${res.status}`);
      const data = await res.json() as { status: string; opId?: string; message?: string };
      if (data.status === "unconfigured") {
        this.onEvent?.("toast", data.message ?? "生成服务未配置，已使用目录替代件。");
        this.onEvent?.("novel_item_done", { name, fallback: true });
        return;
      }
      if (!data.opId) throw new Error("missing opId");
      this.onEvent?.("toast", `开始生成「${name}」，约需几分钟，期间可以继续游玩。`);
      this.genDeadline = Date.now() + GEN_TIMEOUT_MS;
      this.stopGenPoll();
      this.genTimer = setInterval(() => void this.pollGeneration(data.opId!, name, prompt), GEN_POLL_MS);
    } catch {
      this.onEvent?.("toast", `「${name}」生成请求失败，已使用目录替代件。`);
      this.onEvent?.("novel_item_done", { name, fallback: true });
    }
  }

  private async pollGeneration(opId: string, name: string, prompt: string) {
    try {
      const res = await fetch(`/api/create/generate?opId=${encodeURIComponent(opId)}`);
      const data = await res.json() as { status: string; file?: string };
      if (data.status === "done" && data.file) {
        this.stopGenPoll();
        this.registerPersonalPart(name, data.file, prompt);
      } else if (data.status === "failed") {
        this.stopGenPoll();
        this.onEvent?.("toast", `「${name}」生成失败，已使用目录替代件。`);
        this.onEvent?.("novel_item_done", { name, fallback: true });
      }
    } catch { /* 网络抖动：下个周期重试 */ }
    if (this.genTimer && Date.now() > this.genDeadline) {
      this.stopGenPoll();
      this.onEvent?.("toast", `「${name}」生成超时，已使用目录替代件。`);
      this.onEvent?.("novel_item_done", { name, fallback: true });
    }
  }

  private stopGenPoll() {
    if (this.genTimer) { clearInterval(this.genTimer); this.genTimer = null; }
  }

  /** 生成完成：模型入个人目录（运行时注册 BuildPartDef），随时可摆放 */
  private async registerPersonalPart(name: string, file: string, prompt: string) {
    const id = `p_${crypto.randomUUID().slice(0, 8)}`;
    try {
      const probe = await loadItemModel(this.scene, file, NOVEL_WIDTH);
      const size: [number, number, number] = [
        Math.max(0.4, Math.round(probe.size.x * 10) / 10),
        Math.max(0.4, Math.round(probe.size.y * 10) / 10),
        Math.max(0.4, Math.round(probe.size.z * 10) / 10),
      ];
      // 目标宽与 def.model.width 一致（size[0]），保证摆放时缓存命中
      await loadItemModel(this.scene, file, size[0]);
      this.addPersonalDef({ id, name: name.slice(0, 40), file, size, prompt });
      this.build.modelReady.set(file, true);
      this.onEvent?.("toast", `「${name}」已加入个人目录，可从建造面板摆放。`);
      this.onEvent?.("novel_item_done", { id, name, file });
    } catch {
      this.onEvent?.("toast", `「${name}」模型加载失败，已使用目录替代件。`);
      this.onEvent?.("novel_item_done", { name, fallback: true });
    }
  }

  private addPersonalPart(part: SavedPersonalPart) {
    this.addPersonalDef(part);
    // 模型懒加载：注册后拉取，成功即标记可用
    void loadItemModel(this.scene, part.file, part.size[0] || NOVEL_WIDTH)
      .then(() => this.build.modelReady.set(part.file, true))
      .catch((e) => console.warn("[create] personal model load failed", part.file, e));
  }

  private addPersonalDef(part: SavedPersonalPart) {
    if (BUILD_CATALOG.some((d) => d.id === part.id)) return;
    const def: BuildPartDef = {
      id: part.id, name: part.name, category: "deco", cost: {}, size: part.size,
      use: "none", model: { file: part.file, width: part.size[0] || NOVEL_WIDTH },
      desc: "语言创造的私人物品。",
    };
    BUILD_CATALOG.push(def);
    if (!this.personalParts.some((p) => p.id === part.id)) this.personalParts.push(part);
  }

  // ---------- 存档 ----------

  /** 恢复：注册个人目录部件并懒加载模型（build.load 之前调用） */
  hydrate(parts: SavedPersonalPart[] | undefined) {
    this.personalParts = [];
    for (const p of parts ?? []) {
      if (BUILD_CATALOG.some((d) => d.id === p.id)) continue;
      this.addPersonalPart({ ...p });
    }
  }

  exportHome(): SavedPersonalPart[] | undefined {
    return this.personalParts.length ? this.personalParts.map((p) => ({ ...p })) : undefined;
  }
}
