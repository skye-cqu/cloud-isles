// NPC 决策客户端：优先请求服务端 LLM，失败或未配置时使用本地角色引擎兜底。
import { NpcDecision, NpcSituation, NpcAction, localDecide } from "shared";
import { readyNpcRequestMeta } from "../../core/cloudSync";

export { localDecide };

export async function decideNpc(s: NpcSituation, timeoutMs = 30000): Promise<NpcDecision> {
  try {
    const meta = await readyNpcRequestMeta();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch("/api/npc/decide", {
      method: "POST",
      headers: { "content-type": "application/json", ...(meta.sessionId ? { "x-save-session": meta.sessionId, "x-save-token": meta.token! } : {}) },
      body: JSON.stringify({ situation: s, operationId: meta.operationId }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const d = await res.json();
      if (d && d.action && typeof d.action.type === "string") {
        return { action: d.action as NpcAction, reason: d.reason ?? "", source: d.source === "fallback" ? "fallback" : "llm" };
      }
    }
  } catch {
    // fallthrough to local
  }
  return localDecide(s);
}

export interface ChatTurn { role: "player" | "npc"; text: string }

export async function chatNpc(s: NpcSituation, history: ChatTurn[], text: string, timeoutMs = 30000): Promise<{ reply: string; source: "llm" | "fallback"; action?: NpcAction }> {
  try {
    const meta = await readyNpcRequestMeta();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch("/api/npc/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(meta.sessionId ? { "x-save-session": meta.sessionId, "x-save-token": meta.token! } : {}) },
      body: JSON.stringify({ situation: s, history, text, operationId: meta.operationId }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const d = await res.json();
      if (d && typeof d.reply === "string" && d.reply.length) {
        return { reply: d.reply, source: d.source === "fallback" ? "fallback" : "llm", action: d.action };
      }
    }
  } catch {
    // fallthrough
  }
  return { reply: fallbackChat(s, text), source: "fallback" };
}

function fallbackChat(s: NpcSituation, text: string): string {
  const isYan = s.persona.includes("工匠");
  if (text.includes("泊位") || text.includes("升级") || text.includes("整备")) {
    return isYan
      ? "泊位整备需要稳定装置。你带图纸回来了吗？装好之后，云舟在这里补给会快得多。"
      : "岩师傅一直在念叨泊位的事，你去遗迹找找旧图纸吧。";
  }
  if (text.includes("吃") || text.includes("食物") || text.includes("饿")) {
    return isYan
      ? "灶台归苓管，不过库里要是有云菇，烤一把也挺顶饿。"
      : "把食材交给我吧，灶台做出来的热汤最能赶走云海的寒气。";
  }
  if (text.includes("风峡") || text.includes("风晶") || text.includes("哪里")) {
    return "西边双峰之间有上升气流，风眼处常能捡到风晶。遗迹岛在东北方向，旧装置的图纸应该就在那儿。";
  }
  if (text.includes("你好") || text.includes("嗨") || text.includes("你是")) {
    return isYan ? "我是岩，负责岛上的工程和修缮。有要修要建的说一声。" : "我是苓，管这片田和家里的灶台。想吃点什么随时找我。";
  }
  return isYan
    ? `嗯，“${text}”……工程上说得通。需要我做什么就说。`
    : `听着呢。“${text}”——交给我吧，田里和灶台都跑不脱。`;
}
