// 语言创造方案：玩家自然语言 → 结构化建造方案。
// 服务端 LLM 解析失败/离线时由 localCreatePlan 兜底；两端共用类型与校验。
import { BUILD_CATALOG, BuildPartDef } from "./catalog.js";

export interface CreatePlanPart {
  partId: string;
  /** 相对锚点（瞄准点）的偏移（米）：[x, z]，y 由地形吸附决定 */
  offset: [number, number];
  rotY: number;
}

export interface CreatePlanSolution {
  summary: string;
  kind: "layout" | "novel";
  parts: CreatePlanPart[];
  /** 目录外新外形（Lux3D 生成）；fallbackPartId 是生成失败时的替代件 */
  novelItem?: { name: string; prompt: string; fallbackPartId: string };
  /** 需要玩家点选澄清的问题（有此项时方案未定，不应提交） */
  clarification?: string[];
}

export const CREATE_PLAN_MAX_PARTS = 24;
/** 部件相对锚点的最大偏移（米）——家园岛缘内 */
export const CREATE_PLAN_MAX_OFFSET = 14;

/** 运行时个人目录：Lux3D 生成物品注册为可摆放部件，随存档持久化。 */
export interface SavedPersonalPart {
  id: string;
  name: string;
  /** 模型 URL（/ 开头的完整路径，如 /generated-assets/gen-xxx.glb） */
  file: string;
  size: [number, number, number];
  prompt?: string;
}

const partById = (id: string): BuildPartDef | undefined => BUILD_CATALOG.find((p) => p.id === id);

/** 校验并夹紧一个方案；返回 null 表示完全不可用。 */
export function sanitizeCreatePlan(raw: unknown): CreatePlanSolution | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.summary !== "string" || !r.summary.trim()) return null;
  const kind = r.kind === "novel" ? "novel" : "layout";
  if (!Array.isArray(r.parts)) return null;
  const parts: CreatePlanPart[] = [];
  for (const p of r.parts.slice(0, CREATE_PLAN_MAX_PARTS)) {
    if (!p || typeof p !== "object") continue;
    const pr = p as Record<string, unknown>;
    if (typeof pr.partId !== "string" || !partById(pr.partId)) continue;
    if (!Array.isArray(pr.offset) || pr.offset.length !== 2 || pr.offset.some((n) => typeof n !== "number" || !Number.isFinite(n))) continue;
    const [ox, oz] = pr.offset as number[];
    if (Math.abs(ox) > CREATE_PLAN_MAX_OFFSET || Math.abs(oz) > CREATE_PLAN_MAX_OFFSET) continue;
    parts.push({
      partId: pr.partId,
      offset: [Math.round(ox * 10) / 10, Math.round(oz * 10) / 10],
      rotY: typeof pr.rotY === "number" && Number.isFinite(pr.rotY) ? pr.rotY : 0,
    });
  }
  if (!parts.length) return null;
  const out: CreatePlanSolution = { summary: r.summary.slice(0, 120), kind, parts };
  if (r.novelItem && typeof r.novelItem === "object") {
    const n = r.novelItem as Record<string, unknown>;
    if (typeof n.name === "string" && n.name.trim() && typeof n.prompt === "string" && n.prompt.trim()) {
      const fallback = typeof n.fallbackPartId === "string" && partById(n.fallbackPartId) ? n.fallbackPartId : "lantern";
      out.novelItem = { name: n.name.slice(0, 40), prompt: n.prompt.slice(0, 600), fallbackPartId: fallback };
    }
  }
  if (Array.isArray(r.clarification)) {
    const qs = r.clarification.filter((q) => typeof q === "string" && q.trim()).slice(0, 3) as string[];
    if (qs.length) {
      // 有澄清问题时方案未定：返回问题本身，部件清空
      return { ...out, parts: [], clarification: qs };
    }
  }
  return out;
}

function round10(n: number): number { return Math.round(n * 10) / 10; }

/** 网格布局生成：以锚点为中心按行/列摆放，自动满足 0.7×尺寸间距。 */
function gridLayout(anchorOffsets: { partId: string; dx: number; dz: number; rotY?: number }[]): CreatePlanPart[] {
  return anchorOffsets.map(({ partId, dx, dz, rotY }) => ({ partId, offset: [round10(dx), round10(dz)] as [number, number], rotY: rotY ?? 0 }));
}

function platform(parts: { partId: string; dx: number; dz: number; rotY?: number }[], w: number, d: number, y = 0): { partId: string; dx: number; dz: number; rotY?: number }[] {
  // 木地板 3×3，按 w×d 块拼台
  const out = [...parts];
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
    out.push({ partId: "floor", dx: (i - (w - 1) / 2) * 2.8, dz: (j - (d - 1) / 2) * 2.8 });
  }
  return out;
}

/**
 * 本地规则解析兜底：关键词模板 + 确定性布局。覆盖观景台/花园/桌椅/桥/灯等常见意图。
 * 离线也能给出可玩方案；LLM 在线时产出更贴合的表达。
 */
export function localCreatePlan(text: string): CreatePlanSolution {
  const t = text.toLowerCase();
  const has = (...kws: string[]) => kws.some((k) => t.includes(k));
  const summary = text.trim().slice(0, 60) || "小型布置";

  // 目录外物品：明确要"一个/一盏/一把"单件且未命中模板 → novel
  if (has("一盏", "一个", "一把", "一件") && !has("台", "园", "桥", "桌", "座位区", "生活区")) {
    const name = text.trim().replace(/^(帮我|给我|造|做|生成|建|来)/, "").slice(0, 20) || "新物件";
    return {
      summary: `生成「${name}」`,
      kind: "novel",
      parts: [{ partId: "lantern", offset: [0, 0], rotY: 0 }],
      novelItem: { name, prompt: text.trim().slice(0, 300), fallbackPartId: "lantern" },
    };
  }

  if (has("观景", "阳台", "平台", "台地")) {
    // 座椅放在台缘外（canPlace 禁止部件互叠，椅子上台会整单失败）
    const furniture: { partId: string; dx: number; dz: number; rotY?: number }[] = [];
    if (!has("不要椅", "无椅")) { furniture.push({ partId: "chair", dx: -0.9, dz: 3.5, rotY: Math.PI }); furniture.push({ partId: "chair", dx: 0.9, dz: 3.5, rotY: Math.PI }); }
    if (has("灯") || !has("不要灯")) furniture.push({ partId: "lantern", dx: -2.2, dz: 3.5 });
    return {
      summary: `观景台（${summary}）`,
      kind: "layout",
      parts: gridLayout(platform(furniture, 2, 2)),
    };
  }
  if (has("花园", "花境", "种花")) {
    const parts = gridLayout([
      { partId: "planter", dx: -1.4, dz: -1.4 }, { partId: "planter", dx: 1.4, dz: -1.4 },
      { partId: "planter", dx: -1.4, dz: 1.4 }, { partId: "planter", dx: 1.4, dz: 1.4 },
      { partId: "chair", dx: 0, dz: 0, rotY: Math.PI }, { partId: "lantern", dx: 0, dz: 2.4 },
    ]);
    return { summary: `小花园（${summary}）`, kind: "layout", parts };
  }
  if (has("桌", "用餐", "野餐")) {
    return {
      summary: `桌椅角（${summary}）`,
      kind: "layout",
      parts: gridLayout([
        { partId: "table", dx: 0, dz: 0 },
        { partId: "chair", dx: -1.2, dz: 0, rotY: Math.PI / 2 }, { partId: "chair", dx: 1.2, dz: 0, rotY: -Math.PI / 2 },
        { partId: "lantern", dx: 0, dz: -1.8 },
      ]),
    };
  }
  if (has("桥", "栈道", "小路")) {
    const n = 3;
    return {
      summary: `木桥（${summary}）`,
      kind: "layout",
      parts: gridLayout(Array.from({ length: n }, (_, i) => ({ partId: "floor", dx: 0, dz: (i - (n - 1) / 2) * 2.8 }))),
    };
  }
  if (has("灯")) {
    return { summary: "一盏云灯", kind: "layout", parts: [{ partId: "lantern", offset: [0, 0], rotY: 0 }] };
  }
  // 默认：小歇脚处（椅在台缘外，避免互叠）
  return {
    summary: `歇脚处（${summary}）`,
    kind: "layout",
    parts: gridLayout([
      { partId: "floor", dx: 0, dz: 0 }, { partId: "chair", dx: 0, dz: 2.1, rotY: Math.PI }, { partId: "planter", dx: 1.6, dz: -1.2 },
    ]),
  };
}
