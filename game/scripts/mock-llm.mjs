// OpenAI 兼容 mock 端点：验证 NPC LLM 接入链路（无真实 key 时的联调工具）。
// 启动：node scripts/mock-llm.mjs
// 游戏服务端以 NPC_LLM_BASE_URL=http://127.0.0.1:8790/v4 NPC_LLM_API_KEY=mock-key 接入。
import http from "node:http";

let decideCalls = 0;
let chatCalls = 0;

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer mock-key")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad mock key" } }));
      return;
    }
    const payload = JSON.parse(body);
    // 处境内容可能分布在 system/user 两条消息里，必须拼接全部消息再解析
    const all = (payload.messages ?? []).map((m) => m.content ?? "").join("\n");
    const isChat = all.includes("现在玩家对你说了一句话");
    // 决策请求：从 prompt 里解析处境，返回一个符合处境的 JSON 行动
    const situation = {
      npc: /你是(.+?)（/.exec(all)?.[1] ?? "居民",
      authorized: all.includes("玩家已授权"),
      homeLevel: /家园等级 (\d+)/.exec(all)?.[1] ?? "0",
      weather: /天气 (.+?)，/.exec(all)?.[1] ?? "未知",
    };
    let content;
    if (isChat) {
      chatCalls++;
      const userText = payload.messages?.at(-1)?.content ?? "";
      content = JSON.stringify({
        reply: `（mock·LLM）收到：“${userText.slice(0, 20)}”。天气${situation.weather}，家园等级${situation.homeLevel}，我记下了。`,
      });
    } else {
      decideCalls++;
      const yan = all.includes("工匠");
      const action = situation.authorized
        ? { type: "build_part", partId: yan ? "railing" : "planter", target: [Math.round((Math.random() * 6 - 3) * 10) / 10, 0, Math.round((Math.random() * 6 - 3) * 10) / 10], duration: 8, say: `（mock·LLM）${situation.npc}按授权开工。` }
        : { type: "wander", duration: 6 };
      content = JSON.stringify({
        action,
        reason: `（mock·LLM）处境判断：授权=${situation.authorized}，家园等级${situation.homeLevel}。`,
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "mock", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
  });
});

server.listen(8790, () => console.log("mock LLM on :8790"));
process.on("SIGINT", () => { console.log(`decide=${decideCalls} chat=${chatCalls}`); process.exit(0); });
