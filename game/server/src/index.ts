// 云屿之歌 服务端：NPC 决策（LLM 优先，本地角色引擎兜底）、语言创造方案、Lux3D 生成、运行时岛屿生成、静态托管。
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NpcSituation, NpcAction, localDecide,
  isStarterRegion, regionIslandKeys, recipeForIsland, isValidSavePayload,
  BUILD_CATALOG, sanitizeCreatePlan, localCreatePlan } from "shared";
import { IslandGenerationService, focusFromQuery, parseIslandQuery } from "./world-gen";
import { LuxGenerationService } from "./lux3d-gen";
import { SaveStore, type LlmAttempt } from "./save-store";
import { NpcOperationCoordinator, NpcResultCache, validNpcSituation } from "./npc-guard";

const PORT = Number(process.env.PORT ?? 8787);
// 仓库根:game/server/src → 上三级。供 Lux 产物目录、LSIC 运行时缓存与静态挂载使用。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// LLM 配置：任意 OpenAI 兼容端点（智谱 https://open.bigmodel.cn/api/paas/v4）
const LLM_BASE = process.env.NPC_LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
const LLM_KEY = process.env.NPC_LLM_API_KEY ?? "";
const LLM_MODEL = process.env.NPC_LLM_MODEL ?? "glm-4-flash";
// 本地小模型 JSON 可靠性受益于低温；云端 key 用默认 0.7
const LLM_TEMP = Number(process.env.NPC_LLM_TEMP ?? 0.7);

const app = Fastify({ logger: false, bodyLimit: 512 * 1024 });
const saveStore = new SaveStore(process.env.SAVE_DB_PATH ?? "cloud-isles.sqlite");
const llmWindows = new Map<string, { startedAt: number; count: number }>();
const npcResultCache = new NpcResultCache();
const npcOperationCoordinator = new NpcOperationCoordinator();
function configuredLimit(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : fallback;
}
const LLM_REQUESTS_PER_MINUTE = configuredLimit("NPC_LLM_REQUESTS_PER_MINUTE", 12, 10_000);
const LLM_MAX_CONCURRENT = configuredLimit("NPC_LLM_MAX_CONCURRENT", 2, 100);
const LLM_MAX_TOTAL_CALLS = configuredLimit("NPC_LLM_MAX_TOTAL_CALLS", 1000, 1_000_000);
let activeLlmRequests = 0;

function allowLlm(ip: string) {
  const now = Date.now();
  const state = llmWindows.get(ip);
  if (!state || now - state.startedAt >= 60_000) { llmWindows.set(ip, { startedAt: now, count: 1 }); return true; }
  if (state.count >= LLM_REQUESTS_PER_MINUTE) return false;
  state.count += 1;
  return true;
}

function npcOperation(kind: "chat" | "decide" | "create", req: { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }) {
  const operationId = typeof req.body.operationId === "string" && /^[a-zA-Z0-9:_-]{8,128}$/.test(req.body.operationId) ? req.body.operationId : null;
  const sessionId = typeof req.headers["x-save-session"] === "string" ? req.headers["x-save-session"] : "";
  const token = typeof req.headers["x-save-token"] === "string" ? req.headers["x-save-token"] : "";
  if ((sessionId || token) && (!sessionId || !token || !saveStore.isAuthorized(sessionId, token))) return { error: "invalid session capability" as const, status: 401 as const };
  if (req.body.operationId !== undefined && !operationId) return { error: "invalid operationId" as const, status: 400 as const };
  if (sessionId && !operationId) return { error: "operationId is required for an authenticated model request" as const, status: 400 as const };
  const key = operationId && sessionId ? `${sessionId}:${operationId}` : null;
  const body = { ...req.body }; delete body.operationId;
  const fingerprint = npcResultCache.fingerprint(kind, body);
  const cached = key ? npcResultCache.read(key, fingerprint) : { state: "miss" as const };
  return { operationId, sessionId, token, key, fingerprint, cached };
}

type NpcOperation = Exclude<ReturnType<typeof npcOperation>, { error: string }>;
function rememberNpcResult(op: NpcOperation, kind: "chat" | "decide" | "create", status: "success" | "fallback", result: unknown, attempts: LlmAttempt[] = []) {
  if (op.operationId && op.sessionId && op.token) saveStore.completeLlm(op.sessionId, op.token, op.operationId, kind, op.fingerprint, result, status, attempts);
  if (op.key) npcResultCache.write(op.key, op.fingerprint, result);
}

function persistedNpcResult(op: Exclude<ReturnType<typeof npcOperation>, { error: string }>, kind: "chat" | "decide" | "create") {
  if (!op.operationId || !op.sessionId || !op.token) return null;
  return saveStore.beginLlm(op.sessionId, op.token, op.operationId, kind, op.fingerprint);
}

interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

async function callLlm(messages: ChatMessage[], op: NpcOperation, attempts: LlmAttempt[], timeoutMs = 25000): Promise<string | null> {
  if (!LLM_KEY || !op.operationId || activeLlmRequests >= LLM_MAX_CONCURRENT) return null;
  const id = saveStore.reserveLlmAttempt(op.sessionId, op.token, op.operationId, op.fingerprint, LLM_MAX_TOTAL_CALLS);
  if (id === null) return null;
  // A response counts as successful only after the route parses a usable game result.
  attempts.push({ id, status: "failed" });
  activeLlmRequests += 1;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({ model: LLM_MODEL, messages, temperature: LLM_TEMP, max_tokens: 400 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[llm] http ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : null;
  } catch (e) {
    console.error(`[llm] error: ${e}`);
    return null;
  } finally {
    clearTimeout(t);
    activeLlmRequests -= 1;
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const ACTIONS = new Set([
  "idle", "move_to", "use_facility", "talk_to_player", "cook", "tend_farm",
  "harvest_farm", "build_part", "sit", "wander",
]);

function sanitizeAction(raw: unknown): NpcAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== "string" || !ACTIONS.has(type)) return null;
  const a: NpcAction = { type: type as NpcAction["type"] };
  if (Array.isArray(r.target) && r.target.length === 3 && r.target.every((n) => typeof n === "number" && isFinite(n))) {
    a.target = r.target as [number, number, number];
  }
  if (typeof r.partId === "string") a.partId = r.partId;
  if (typeof r.rotY === "number" && isFinite(r.rotY)) a.rotY = r.rotY;
  if (typeof r.say === "string" && r.say.length < 300) a.say = r.say;
  if (typeof r.duration === "number" && isFinite(r.duration)) a.duration = Math.min(60, Math.max(1, r.duration));
  return a;
}

function situationPrompt(s: NpcSituation): string {
  return [
    `你是云海空岛游戏《云屿之歌》中的居民 ${s.npcName}。`,
    `性格与身份：${s.persona}`,
    `你的目标：${s.goal}`,
    `当前处境：时间 ${s.timeOfDay}，天气 ${s.weather}，家园等级 ${s.homeLevel}（0=落脚之地,1=稳定家园）。`,
    `玩家状态：${s.playerNearby ? "就在附近" : "不在附近"}，正在${s.playerDoing}；玩家生命 ${s.hp}/100，饱食 ${s.hunger}/100。`,
    `其他居民：${s.others.map((o) => `${o.name}（${o.doing}）`).join("、") || "无"}`,
    `家园库存：${s.inventory.map((i) => `${i.id}×${i.count}`).join("、") || "空"}`,
    `农田：${s.farm.map((f) => `${f.plot}=${f.stage}`).join("、") || "无"}`,
    `设施：${s.facilities.map((f) => f.name).join("、") || "暂无"}`,
    `你的近期记忆：${s.recentMemory.slice(-8).map((m) => `「${m}」`).join("；") || "（无）"}`,
    s.buildAuthorization ? `玩家已授权你在「${s.buildAuthorization.zone}」用预算 ${JSON.stringify(s.buildAuthorization.budget)} 进行小型建设（部件：railing 木栏杆/planter 盆栽/lantern 云灯/floor 木地板/table 矮桌，坐标为岛屿局部 [x,z]，须落在以授权中心为圆心、半径约 4 米的圆盘内）。若预算还有剩余，优先继续授权内的建设。` : `目前没有建设授权，不要自行建设。`,
    s.recentChat?.length ? `最近对话：${s.recentChat.map((c) => `${c.from}:${c.text}`).join("；")}` : "",
    ``,
    `请根据处境、性格、目标和记忆，选择接下来最有道理的一个行动。只输出 JSON：`,
    `{"action":{"type":"idle|move_to|use_facility|talk_to_player|cook|tend_farm|harvest_farm|build_part|sit|wander","target":[x,z],"partId":"...","say":"可选的话","duration":秒},"reason":"一句话理由"}`,
  ].filter(Boolean).join("\n");
}

// ---------- 本地角色引擎（无 LLM key 或调用失败时） ----------

// localDecide 已上移到 shared/src/npc-engine.ts，客户端与服务端共用。

// ---------- 路由 ----------

app.get("/api/npc/health", async () => ({ llm: !!LLM_KEY, available: !!LLM_KEY && saveStore.llmBudgetAvailable(LLM_MAX_TOTAL_CALLS), model: LLM_KEY ? LLM_MODEL : null, requestsPerMinute: LLM_REQUESTS_PER_MINUTE, maxConcurrent: LLM_MAX_CONCURRENT, maxTotalCalls: LLM_MAX_TOTAL_CALLS }));

app.post<{ Body: { worldId: string } }>("/api/save/session", {
  schema: { body: { type: "object", required: ["worldId"], additionalProperties: false, properties: { worldId: { type: "string", minLength: 1, maxLength: 120 } } } },
}, async (req, reply) => {
  if (typeof req.body.worldId !== "string") return reply.code(400).send({ error: "invalid worldId" });
  const id = randomUUID(), token = randomUUID();
  saveStore.createSession(id, token, req.body.worldId);
  return { sessionId: id, token, version: 0 };
});

app.get<{ Params: { sessionId: string }; Querystring: { token?: string } }>("/api/save/:sessionId", async (req, reply) => {
  const found = saveStore.read(req.params.sessionId, req.query.token ?? "");
  if (found === "unauthorized") return reply.code(401).send({ error: "invalid session capability" });
  if (!found) return reply.code(404).send({ error: "no backup yet" });
  return found;
});

app.get<{ Params: { sessionId: string }; Querystring: { token?: string } }>("/api/save/:sessionId/versions", async (req, reply) => {
  const versions = saveStore.listVersions(req.params.sessionId, req.query.token ?? "");
  return versions === "unauthorized" ? reply.code(401).send({ error: "invalid session capability" }) : { versions };
});

app.get<{ Params: { sessionId: string; version: string }; Querystring: { token?: string } }>("/api/save/:sessionId/versions/:version", async (req, reply) => {
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version < 1) return reply.code(400).send({ error: "invalid version" });
  const found = saveStore.readVersion(req.params.sessionId, req.query.token ?? "", version);
  if (found === "unauthorized") return reply.code(401).send({ error: "invalid session capability" });
  return found ? found : reply.code(404).send({ error: "backup version not found" });
});

app.post<{ Params: { sessionId: string }; Body: { token: string; parentVersion: number; operationId: string; save: unknown } }>("/api/save/:sessionId", {
  schema: { body: { type: "object", required: ["token", "parentVersion", "operationId", "save"], additionalProperties: false, properties: {
    token: { type: "string", minLength: 16, maxLength: 128 }, parentVersion: { type: "integer", minimum: 0 }, operationId: { type: "string", minLength: 8, maxLength: 128 }, save: { type: "object" },
  } } },
}, async (req, reply) => {
  try {
    if (!isValidSavePayload(req.body.save)) return reply.code(400).send({ error: "invalid save payload" });
    const sessionWorld = saveStore.sessionWorldId(req.params.sessionId, req.body.token);
    if (sessionWorld === null) return reply.code(401).send({ error: "invalid session capability" });
    const payloadWorld = req.body.save.world.worldId ?? `legacy-${req.body.save.world.worldSeed ?? "default"}-${req.body.save.savedAt}`;
    const oldSeedIdentity = String(req.body.save.world.worldSeed ?? "default");
    if (sessionWorld !== payloadWorld && !(sessionWorld === oldSeedIdentity && payloadWorld.startsWith(`legacy-${oldSeedIdentity}-`) && saveStore.migrateLegacySessionWorld(req.params.sessionId, req.body.token, sessionWorld, payloadWorld))) return reply.code(409).send({ error: "save belongs to a different world" });
    const result = saveStore.write(req.params.sessionId, req.body.token, req.body.parentVersion, req.body.operationId, req.body.save);
    if (!result.ok) return reply.code(result.status).send(result);
    return result;
  } catch (e) {
    app.log.error("[save] write failed: " + (e instanceof Error ? e.stack : String(e)));
    return reply.code(500).send({ error: "save write failed" });
  }
});

async function executeDecision(op: Exclude<ReturnType<typeof npcOperation>, { error: string }>, s: NpcSituation, ip: string) {
  const persisted = persistedNpcResult(op, "decide");
  if (persisted === "mismatch") return { error: "operationId was already used for a different request", status: 409 };
  if (persisted && typeof persisted === "object") return persisted.result;
  // Only a persisted attempt from an earlier process has no in-flight promise here.
  if (persisted === "pending") { const result = localDecide(s); rememberNpcResult(op, "decide", "fallback", result); return result; }
  if (!allowLlm(ip)) { const result = localDecide(s); rememberNpcResult(op, "decide", "fallback", result); return result; }
  const attempts: LlmAttempt[] = [];
  const raw = await callLlm([
    { role: "system", content: "你是游戏 NPC 决策引擎，只输出一个 JSON 对象，不要输出其他内容。" },
    { role: "user", content: situationPrompt(s) },
  ], op, attempts);
  if (raw) {
    const json = extractJson(raw); const action = sanitizeAction(json?.action);
    if (action) { attempts.at(-1)!.status = "success"; const result = { action, reason: typeof json?.reason === "string" ? json.reason.slice(0, 200) : "", source: "llm" as const }; rememberNpcResult(op, "decide", "success", result, attempts); return result; }
    app.log.warn("llm json invalid: " + raw.slice(0, 200));
  }
  const result = localDecide(s); rememberNpcResult(op, "decide", "fallback", result, attempts); return result;
}

app.post<{ Body: { situation: NpcSituation; operationId?: string } }>("/api/npc/decide", async (req, reply) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return reply.code(400).send({ error: "invalid request body" });
  const s = req.body.situation;
  if (!validNpcSituation(s)) return reply.code(400).send({ error: "invalid situation" });
  const op = npcOperation("decide", req);
  if ("error" in op) return reply.code(op.status ?? 400).send({ error: op.error });
  if (op.cached.state === "mismatch") return reply.code(409).send({ error: "operationId was already used for a different request" });
  if (op.cached.state === "hit") return op.cached.result;
  if (!op.sessionId) return localDecide(s);
  const result = await npcOperationCoordinator.run(op.key ? `${op.key}:${op.fingerprint}` : null, () => executeDecision(op, s, req.ip));
  if (result && typeof result === "object" && "status" in result && (result as { status?: number }).status === 409) return reply.code(409).send(result);
  return result;
});

app.post<{ Body: { situation: NpcSituation; history: { role: string; text: string }[]; text: string; operationId?: string } }>("/api/npc/chat", async (req, reply) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return reply.code(400).send({ error: "invalid request body" });
  const { situation: s, history = [], text } = req.body;
  if (!validNpcSituation(s) || typeof text !== "string" || text.length < 1 || text.length > 600 || !Array.isArray(history) || history.length > 8 || !history.every((h) => h && (h.role === "player" || h.role === "npc") && typeof h.text === "string" && h.text.length <= 600)) return reply.code(400).send({ error: "invalid chat" });
  const op = npcOperation("chat", req);
  if ("error" in op) return reply.code(op.status ?? 400).send({ error: op.error });
  if (op.cached.state === "mismatch") return reply.code(409).send({ error: "operationId was already used for a different request" });
  if (op.cached.state === "hit") return op.cached.result;
  if (!op.sessionId) return { reply: "现在先按眼前的事做，等会儿再细说。", source: "fallback" as const };
  return npcOperationCoordinator.run(op.key ? `${op.key}:${op.fingerprint}` : null, async () => {
  const persisted = persistedNpcResult(op, "chat");
  if (persisted === "mismatch") return reply.code(409).send({ error: "operationId was already used for a different request" });
  if (persisted && typeof persisted === "object") return persisted.result;
  if (persisted === "pending") { const result = { reply: "刚才的想法还在整理，先按眼前的事做。", source: "fallback" as const }; rememberNpcResult(op, "chat", "fallback", result); return result; }
  if (!allowLlm(req.ip)) { const result = { reply: "现在先按眼前的事做，等会儿再细说。", source: "fallback" as const }; rememberNpcResult(op, "chat", "fallback", result); return result; }
  const msgs: ChatMessage[] = [
    {
      role: "system",
      content: situationPrompt(s) +
        `\n现在玩家对你说了一句话。请以 ${s.npcName} 的身份用中文回复（不超过 60 字），保持性格。同时可以附带一个可选动作。只输出 JSON：{"reply":"...","action":{...可选}}`,
    },
    ...history.slice(-8).map((h) => ({ role: h.role === "player" ? ("user" as const) : ("assistant" as const), content: h.text })),
    { role: "user", content: text },
  ];
  const parseSpoken = (raw: string | null) => {
    const json = raw ? extractJson(raw) : null;
    // 小模型常把聊天输出成决策形状（action/reason）；reply > say > reason 依次取用
    const spoken =
      json && typeof json.reply === "string" && json.reply.length ? json.reply
      : json && typeof json.say === "string" && json.say ? json.say
      : json && typeof json.reason === "string" && json.reason ? json.reason
      : null;
    return json && spoken ? { json, spoken } : null;
  };
  const attempts: LlmAttempt[] = [];
  let raw = await callLlm(msgs, op, attempts);
  let parsed = parseSpoken(raw);
  if (!parsed && history.length) {
    // 小模型在多轮历史下可能只输出 </think> 即停止——去掉历史单轮重试一次
    raw = await callLlm([msgs[0], msgs[msgs.length - 1]], op, attempts);
    parsed = parseSpoken(raw);
  }
  if (!parsed && raw) console.error(`[chat] 解析失败 raw: ${raw.slice(0, 220)}`);
  if (parsed) {
    attempts.at(-1)!.status = "success";
    const action = sanitizeAction(parsed.json.action);
    const result = { reply: parsed.spoken.slice(0, 300), action: action ?? undefined, source: "llm" as const }; rememberNpcResult(op, "chat", "success", result, attempts); return result;
  }
  // 兜底回复
  const isYan = s.npcId === "yan" || s.persona.includes("工匠");
  const fallbackReply = text.includes("泊位") || text.includes("升级")
    ? (isYan ? "泊位整备需要稳定装置，你从遗迹把图纸带回来就能开工。" : "泊位的事岩师傅在管，你去问他准没错。")
    : isYan ? `收到。“${text.slice(0, 30)}”——需要我动手就说一声。`
    : `嗯呢，“${text.slice(0, 30)}”——都记下了，田里和灶台交给我。`;
  const result = { reply: fallbackReply, source: "fallback" as const }; rememberNpcResult(op, "chat", "fallback", result, attempts); return result;
  });
});

// ---------- 语言创造：方案规划 + Lux3D 运行时生成 ----------

function catalogPrompt(): string {
  const lines = BUILD_CATALOG.map((p) => {
    const cost = Object.entries(p.cost).filter(([, n]) => n).map(([id, n]) => `${id}×${n}`).join("+") || "免费";
    return `${p.id}（${p.name}，${p.size[0]}×${p.size[1]}×${p.size[2]}米，成本 ${cost}${p.use && p.use !== "none" ? `，可${p.use === "sit" ? "坐" : p.use === "cook" ? "烹饪" : p.use}` : ""}）`;
  });
  return [
    "你是空岛游戏的建造方案引擎。把玩家的自然语言愿望转成可执行建造方案。",
    "可用部件（partId）:",
    ...lines,
    "",
    "规则：",
    "- parts 数组每件含 partId、offset [x,z]（相对玩家瞄准点的米制偏移，范围 ±14）、rotY（弧度）。",
    "- 部件间距必须 ≥ 0.7×(两件最大边尺寸和)/2，避免重叠；椅子朝向桌子或景观（rotY）。",
    "- 台面用 floor（3×3 米）拼接；平台边缘可加 railing；不要用 wall/pillar 除非玩家要墙或柱。",
    "- 总件数 ≤ 16。玩家要目录里没有的东西（特定造型物品）时用 kind=novel 并填 novelItem{name,prompt,fallbackPartId}，同时给 1 件 fallback 部件占位。",
    "- 意图不清（要什么/多大/放哪完全不明）时输出 clarification: [问题1, 问题2]，parts 留空。",
    '只输出 JSON：{"summary":"一句话方案名","kind":"layout|novel","parts":[{"partId":"...","offset":[0,0],"rotY":0}],"novelItem":{"name":"...","prompt":"生成用提示词","fallbackPartId":"lantern"},"clarification":[]}',
  ].join("\n");
}

app.post<{ Body: { text: string; operationId?: string } }>("/api/create/plan", async (req, reply) => {
  if (!req.body || typeof req.body !== "object" || typeof req.body.text !== "string" || !req.body.text.trim() || req.body.text.length > 600) {
    return reply.code(400).send({ error: "invalid create text" });
  }
  const op = npcOperation("create", req);
  if ("error" in op) return reply.code(op.status ?? 400).send({ error: op.error });
  if (op.cached.state === "mismatch") return reply.code(409).send({ error: "operationId was already used for a different request" });
  if (op.cached.state === "hit") return op.cached.result;
  const fallback = () => {
    try {
      const plan = localCreatePlan(req.body.text);
      rememberNpcResult(op, "create", "fallback", plan);
      return plan;
    } catch (e) {
      app.log.error("[create] fallback failed: " + (e instanceof Error ? e.stack : String(e)));
      return { summary: req.body.text.slice(0, 20), kind: "layout", parts: [] };
    }
  };
  if (!LLM_KEY || !op.sessionId) return fallback();
  if (!allowLlm(req.ip)) return fallback();
  return npcOperationCoordinator.run(op.key ? `${op.key}:${op.fingerprint}` : null, async () => {
    const persisted = persistedNpcResult(op, "create");
    if (persisted === "mismatch") return reply.code(409).send({ error: "operationId was already used for a different request" });
    if (persisted && typeof persisted === "object") return persisted.result;
    if (persisted === "pending") return fallback();
    const attempts: LlmAttempt[] = [];
    const raw = await callLlm([
      { role: "system", content: "你是建造方案引擎，只输出一个 JSON 对象，不要输出其他内容。" },
      { role: "user", content: `${catalogPrompt()}\n\n玩家想要：${req.body.text}` },
    ], op, attempts, 15000);
    if (raw) {
      const json = extractJson(raw);
      const plan = sanitizeCreatePlan(json);
      if (plan && (plan.parts.length || plan.clarification?.length)) {
        attempts.at(-1)!.status = "success";
        rememberNpcResult(op, "create", "success", plan, attempts);
        return plan;
      }
      app.log.warn("[create] llm plan invalid: " + raw.slice(0, 200));
    }
    return fallback();
  });
});

// Lux3D 运行时生成：密钥在服务端环境变量，交付包不含密钥（未配置时走目录回退）。
const luxService = new LuxGenerationService({
  python: join(repoRoot, ".venv", "Scripts", "python.exe"),
  clientScript: join(repoRoot, ".agents", "skills", "lux3d-cn", "lux3d_client.py"),
  outDir: join(repoRoot, "game", "client", "public", "assets", "generated"),
  apiKey: process.env.LUX3D_API_KEY ?? "",
  jobTimeoutMs: 600_000,
});

app.post<{ Body: { prompt: string; operationId?: string } }>("/api/create/generate", async (req, reply) => {
  if (!req.body || typeof req.body !== "object" || typeof req.body.prompt !== "string" || !req.body.prompt.trim() || req.body.prompt.length > 300) {
    return reply.code(400).send({ error: "invalid generate prompt" });
  }
  const op = npcOperation("create", req);
  if ("error" in op) return reply.code(op.status ?? 400).send({ error: op.error });
  const opId = op.operationId ?? `gen-${randomUUID()}`;
  if (!luxService.ready) {
    return { status: "unconfigured", opId, message: "未配置 LUX3D_API_KEY，使用目录替代件。" };
  }
  const result = luxService.request(opId, req.body.prompt);
  if (result.job && result.job.prompt !== req.body.prompt) return reply.code(409).send({ error: "operationId was already used for a different prompt" });
  if (result.status === "busy") return reply.code(429).send({ error: "生成队列已满，稍后再试。" });
  return { status: result.status, opId, taskId: result.job?.taskId, file: result.job?.file };
});

app.get("/api/create/generate", async (req) => {
  const q = req.query as Record<string, unknown>;
  const opId = typeof q.opId === "string" ? q.opId : "";
  if (!opId) return { status: "unknown" };
  const job = luxService.status(opId);
  if (!job) return { status: "unknown" };
  return { status: job.status, opId, taskId: job.taskId, file: job.file, error: job.error };
});

app.get("/api/create/health", async () => ({ lux: luxService.ready, queue: luxService.queueDepth }));

// ---------- 运行时岛屿生成服务 ----------

// 缓存根 <repo>/assets/lsic/runtime-cache。
const genService = new IslandGenerationService({
  repoRoot,
  python: join(repoRoot, ".venv", "Scripts", "python.exe"),
  toolkitPath: process.env.LSIC_TOOLKIT_PATH ?? "D:\\Projects\\rea-LostSkiesIslandCreator\\lsic-toolkit",
  jobTimeoutMs: 300_000,
});

// 区域布局查询:确定性,无需生成即可回答(客户端据此预取/绘制罗盘)。
app.get("/api/world/region", async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const parsed = parseIslandQuery(q);
  if (typeof parsed === "string") return reply.code(400).send({ error: parsed });
  const { worldSeed, region } = parsed;
  if (isStarterRegion(region)) {
    return { region, starter: true, islands: [] };
  }
  const islands = regionIslandKeys(worldSeed, region).map((key) => ({
    key,
    recipe: recipeForIsland(worldSeed, key),
    ready: genService.isReady(worldSeed, key.region, key.index),
  }));
  return { region, starter: false, islands };
});

app.get("/api/world/island", async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const parsed = parseIslandQuery(q);
  if (typeof parsed === "string") return reply.code(400).send({ error: parsed });
  const { worldSeed, region, idx } = parsed;
  if (isStarterRegion(region)) {
    return reply.code(400).send({ error: "starter region is not generated here" });
  }
  if (genService.isReady(worldSeed, region, idx)) {
    const descriptor = genService.readDescriptor(worldSeed, region, idx);
    if (descriptor) return { status: "ready", descriptor };
  }
  const job = genService.request(worldSeed, region, idx, worldSeed, focusFromQuery(q));
  return { status: job.status, error: job.error, queueAhead: job.queueAhead };
});

app.get("/api/world/health", async () => ({ genQueue: genService.queueDepth }));

// 生产模式托管客户端构建产物
import { existsSync } from "node:fs";
const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "../../client/dist");
if (existsSync(distDir)) {
  await app.register((await import("@fastify/static")).default, { root: distDir });
}
// 运行时缓存静态托管(第二次挂 static 必须 decorateReply:false)
await app.register((await import("@fastify/static")).default, {
  root: join(repoRoot, "assets", "lsic", "runtime-cache"),
  prefix: "/world-assets/",
  decorateReply: false,
  setHeaders: (res) => res.setHeader("cache-control", "no-cache"),
});
// Lux3D 生成产物托管（目录由 LuxGenerationService 构造时创建）
await app.register((await import("@fastify/static")).default, {
  root: join(repoRoot, "game", "client", "public", "assets", "generated"),
  prefix: "/generated-assets/",
  decorateReply: false,
  setHeaders: (res) => res.setHeader("cache-control", "no-cache"),
});

app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  console.log(`[server] listening http://127.0.0.1:${PORT} (llm=${LLM_KEY ? LLM_MODEL : "fallback-only"})`);
});
