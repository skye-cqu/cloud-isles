// NPC 本地角色引擎（无 LLM key 或调用失败时的兜底决策）。
// 服务端 /api/npc/decide 与客户端 brain.ts 共用这一份，避免两处规则漂移。
import { NpcDecision, NpcSituation } from "./index.js";

export function localDecide(s: NpcSituation, rand: () => number = Math.random): NpcDecision {
  const isYan = s.npcId === "yan" || s.persona.includes("工匠");
  const budget = s.buildAuthorization?.budget as Partial<Record<string, number>> | undefined;

  if (s.buildAuthorization) {
    const wheat = budget?.wheat ?? 0;
    if (wheat >= 1) {
      const part = isYan ? "railing" : "planter";
      // 授权区是半径 5.5 的圆（含约 0.6 米高度差判定），采样必须落在圆盘内，方形角落会超区
      const ang = rand() * Math.PI * 2;
      const r = Math.round(4 * Math.sqrt(rand()) * 10) / 10;
      const x = Math.round(Math.cos(ang) * r * 10) / 10;
      const z = Math.round(Math.sin(ang) * r * 10) / 10;
      return {
        action: { type: "build_part", partId: part, target: [x, 0, z], duration: 8, say: isYan ? "这活儿我来！" : "我种点花点缀一下吧。" },
        reason: s.buildAuthorization ? "获得授权，按预算在划定区域建设。" : "",
        source: "fallback",
      };
    }
  }
  if (s.playerNearby && rand() < 0.5) {
    const line = isYan
      ? ["在忙呢？工程上的事交给我。", "泊位整备之后，你的云舟能跑得更快。"][Math.floor(rand() * 2)]
      : ["今天的云很软，适合晾晒作物。", "要不要带点吃的再出发？"][Math.floor(rand() * 2)];
    return { action: { type: "talk_to_player", say: line, duration: 6 }, reason: "玩家在附近，主动打招呼。", source: "fallback" };
  }
  const mature = s.farm.find((f) => f.stage === "成熟");
  const planted = s.farm.some((f) => f.stage.startsWith("生长"));
  if (!isYan) {
    if (mature) return { action: { type: "harvest_farm", duration: 6 }, reason: "作物熟了，先收下来。", source: "fallback" };
    if (planted) return { action: { type: "tend_farm", duration: 8 }, reason: "去照料田里的作物。", source: "fallback" };
  }
  const hasMush = s.inventory.some((i) => i.id === "cloudmushroom" && i.count >= 1);
  const hasWheat = s.inventory.some((i) => i.id === "wheat" && i.count >= 1);
  const hasStove = s.facilities.some((f) => f.name.includes("灶台"));
  if (hasStove && (hasMush || hasWheat) && (s.hunger < 60 || (!isYan && rand() < 0.5))) {
    return { action: { type: "cook", duration: 9 }, reason: "库房有食材，做点吃的备着。", source: "fallback" };
  }
  if (rand() < 0.55) {
    return { action: { type: "wander", duration: 6 }, reason: "在岛上走走看看。", source: "fallback" };
  }
  return { action: { type: "idle", duration: 5 }, reason: "歇一会儿。", source: "fallback" };
}
