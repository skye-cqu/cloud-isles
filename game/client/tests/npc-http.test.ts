import { expect, it } from "vitest";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const situation = { npcId: "yan", npcName: "岩", persona: "工匠", goal: "照料家园", timeOfDay: "白天", weather: "晴朗", homeLevel: 0, hp: 100, hunger: 100, inventory: [], farm: [], playerNearby: true, playerDoing: "闲逛", others: [], facilities: [], recentMemory: [] };

it("audits real route failures atomically, keeps capacity fallback separate, and caps provider retries across restart", async () => {
  const folder = mkdtempSync(join(tmpdir(), "m1-http-r4-"));
  let calls = 0;
  const provider = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls++;
    const parsed = JSON.parse(body);
    if (body.includes("NETWORK_FAILURE")) { res.destroy(); return; }
    if (body.includes("SLOW_CALL")) await pause(200);
    res.setHeader("content-type", "application/json");
    if (body.includes("HTTP_FAILURE")) { res.writeHead(503).end("{}"); return; }
    const invalid = body.includes("INVALID_JSON") || (body.includes("RETRY_ONCE") && parsed.messages.length > 2);
    res.end(JSON.stringify({ choices: [{ message: { content: invalid ? "not json" : JSON.stringify({ action: { type: "idle" }, reply: "你好" }) } }] }));
  });
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  const providerPort = (provider.address() as { port: number }).port;
  let child: ChildProcess | undefined;
  let db: DatabaseSync | undefined;
  let base = "";
  async function stop() {
    if (child && child.exitCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    child = undefined;
  }
  async function start(file: string, config: Record<string, string> = {}) {
    const portHolder = createSocketServer();
    await new Promise<void>(r => portHolder.listen(0, "127.0.0.1", r));
    const port = (portHolder.address() as { port: number }).port;
    await new Promise<void>(r => portHolder.close(() => r()));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", pathToFileURL(resolve("../node_modules/tsx/dist/loader.mjs")).href, "src/index.ts"], {
      cwd: resolve("../server"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), SAVE_DB_PATH: file, NPC_LLM_API_KEY: "local-test-only", NPC_LLM_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, NPC_LLM_MODEL: "local-stub", NPC_LLM_REQUESTS_PER_MINUTE: "1000", NPC_LLM_MAX_CONCURRENT: "1", NPC_LLM_MAX_TOTAL_CALLS: "1000", ...config },
    });
    let output = "";
    child.stdout?.on("data", c => { output += c; }); child.stderr?.on("data", c => { output += c; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + "/api/npc/health")).ok) return; } catch { /* startup */ }
      await pause(25);
    }
    throw new Error("server startup timed out: " + output);
  }
  async function session() {
    return (await fetch(base + "/api/save/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ worldId: "world" }) })).json() as Promise<{ sessionId: string; token: string }>;
  }
  async function request(kind: "chat" | "decide", operationId: string, goal: string, meta?: { sessionId: string; token: string }, retry = false) {
    const res = await fetch(base + "/api/npc/" + kind, { method: "POST", headers: { "content-type": "application/json", ...(meta ? { "x-save-session": meta.sessionId, "x-save-token": meta.token } : {}) }, body: JSON.stringify({ operationId, situation: { ...situation, goal }, ...(kind === "chat" ? { text: "你好", history: retry ? [{ role: "player", text: "先前对话" }] : [] } : {}) }) });
    return { status: res.status, body: await res.json() };
  }
  const audit = (op: string) => db!.prepare("SELECT status FROM llm_records WHERE operation_id = ?").get(op);
  try {
    const file = join(folder, "audit.sqlite");
    await start(file); db = new DatabaseSync(file);
    const meta = await session();
    for (const kind of ["decide", "chat"] as const) {
      for (const failure of ["INVALID_JSON", "HTTP_FAILURE", "NETWORK_FAILURE"]) {
        const op = `${kind}-${failure}`;
        expect((await request(kind, op, failure, meta)).body.source).toBe("fallback");
        expect(audit(op)).toMatchObject({ status: "failed" });
      }
      const prior = calls;
      const slow = request(kind, `${kind}-slow`, "SLOW_CALL", meta);
      for (let i = 0; calls === prior && i < 100; i++) await pause(5);
      expect((await request(kind, `${kind}-capacity`, "normal", meta)).body.source).toBe("fallback");
      expect(audit(`${kind}-capacity`)).toMatchObject({ status: "fallback" });
      await slow;
      expect(calls).toBe(prior + 1);
      db.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON llm_records BEGIN SELECT RAISE(ABORT, 'audit write failed'); END");
      const failedOp = `${kind}-atomic-completion`;
      expect((await request(kind, failedOp, "normal", meta)).status).toBe(500);
      const afterCall = calls;
      expect(db.prepare("SELECT result FROM llm_operations WHERE operation_id = ?").get(failedOp)).toMatchObject({ result: null });
      // A premature cache would turn this repeat into 200 even though the DB still rejects audit writes.
      expect((await request(kind, failedOp, "normal", meta)).status).toBe(500);
      expect(calls).toBe(afterCall);
      db.exec("DROP TRIGGER deny_audit");
      expect((await request(kind, failedOp, "normal", meta)).body.source).toBe("fallback");
      expect(audit(failedOp)).toMatchObject({ status: "failed" });
    }
    await stop(); db.close(); db = undefined;
    const budgetFile = join(folder, "budget.sqlite");
    await start(budgetFile, { NPC_LLM_MAX_TOTAL_CALLS: "2" }); db = new DatabaseSync(budgetFile);
    const limited = await session();
    const beforeRetry = calls;
    expect((await request("chat", "anonymous-retry", "RETRY_ONCE", undefined, true)).body.source).toBe("fallback");
    expect(calls).toBe(beforeRetry);
    expect((await request("chat", "budget-retry", "RETRY_ONCE", limited, true)).body.source).toBe("llm");
    expect(calls).toBe(beforeRetry + 2);
    expect(db.prepare("SELECT status FROM llm_attempts ORDER BY id").all()).toEqual([{ status: "failed" }, { status: "success" }]);
    expect(audit("budget-retry")).toMatchObject({ status: "success" });
    for (const kind of ["chat", "decide"] as const) {
      expect((await request(kind, `${kind}-budget-denied`, "normal", limited)).body.source).toBe("fallback");
      expect(audit(`${kind}-budget-denied`)).toMatchObject({ status: "fallback" });
    }
    expect((await (await fetch(base + "/api/npc/health")).json()).available).toBe(false);
    await stop(); await start(budgetFile, { NPC_LLM_MAX_TOTAL_CALLS: "2" });
    expect((await request("decide", "restart-budget", "normal", limited)).body.source).toBe("fallback");
    expect(calls).toBe(beforeRetry + 2);
    await stop(); db.close(); db = undefined;
    const rateFile = join(folder, "rate.sqlite");
    await start(rateFile, { NPC_LLM_REQUESTS_PER_MINUTE: "1" }); db = new DatabaseSync(rateFile);
    const rate = await session();
    await request("decide", "rate-first-call", "normal", rate);
    for (const kind of ["chat", "decide"] as const) {
      const before = calls;
      expect((await request(kind, `${kind}-rate-denied`, "normal", rate)).body.source).toBe("fallback");
      expect(audit(`${kind}-rate-denied`)).toMatchObject({ status: "fallback" });
      expect(calls).toBe(before);
    }
    await stop(); db.close(); db = undefined;
    const noKeyFile = join(folder, "no-key.sqlite");
    await start(noKeyFile, { NPC_LLM_API_KEY: "" }); db = new DatabaseSync(noKeyFile);
    const noKey = await session();
    const beforeNoKey = calls;
    for (const kind of ["chat", "decide"] as const) {
      expect((await request(kind, `${kind}-no-key`, "normal", noKey)).body.source).toBe("fallback");
      expect(audit(`${kind}-no-key`)).toMatchObject({ status: "fallback" });
    }
    expect(calls).toBe(beforeNoKey);
    expect(db.prepare("SELECT COUNT(*) AS count FROM llm_attempts").get()).toMatchObject({ count: 0 });
  } finally {
    await stop(); db?.close();
    await new Promise<void>(r => provider.close(() => r()));
  }
}, 30_000);
