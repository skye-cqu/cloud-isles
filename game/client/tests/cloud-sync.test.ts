import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveData } from "shared";

const memory = new Map<string, string>();
const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value), removeItem: (key: string) => void memory.delete(key), clear: () => memory.clear() };
const save = (savedAt: number, worldId = "journey-a") => ({ savedAt, world: { worldId, worldSeed: 7 } } as SaveData);
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  vi.resetModules(); memory.clear();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("crypto", { randomUUID: (() => { let n = 0; return () => `operation-${++n}-000000`; })() });
});

describe("cloud sync replay", () => {
  it("offers known worlds and restores by identity without a readable local save", async () => {
    storage.setItem("cloud-isles-cloud-meta-v2", JSON.stringify({ "journey-a": { sessionId: "s", token: "secret", version: 3, worldId: "journey-a" } }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/versions/3") ? response({ payload: save(3) }) : url.includes("/versions?") ? response({ versions: [{ version: 3 }] }) : response({ version: 3 })));
    const cloud = await import("../src/core/cloudSync");
    expect(cloud.knownCloudWorlds()).toEqual([{ worldId: "journey-a", version: 3 }]);
    expect(await cloud.listCloudBackups("journey-a")).toEqual([{ version: 3 }]);
    expect(await cloud.restoreCloudBackup(3, "journey-a")).toEqual(save(3));
  });

  it("coalesces a new world's session before real NPC headers, then switches worlds", async () => {
    const calls: { url: string; body: any; headers: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); calls.push({ url, body, headers: init?.headers });
      return response(url === "/api/save/session" ? { sessionId: body.worldId, token: "capability", version: 0 } : { action: { type: "idle" }, reply: "你好", source: "llm" });
    }));
    const cloud = await import("../src/core/cloudSync");
    const brain = await import("../src/gameplay/npc/brain");
    cloud.setNpcWorldContext(save(1));
    await Promise.all([brain.decideNpc({} as any), brain.chatNpc({} as any, [], "你好")]);
    expect(calls.filter(c => c.url === "/api/save/session")).toHaveLength(1);
    expect(calls.filter(c => c.url.startsWith("/api/npc/")).map(c => c.headers["x-save-session"])).toEqual(["journey-a", "journey-a"]);
    cloud.setNpcWorldContext(save(2, "journey-b"));
    await brain.decideNpc({} as any);
    expect(calls.at(-1)?.headers["x-save-session"]).toBe("journey-b");
  });
  it("replays lost A before uploading newer B", async () => {
    const writes: any[] = [];
    let lost = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/save/session") return response({ sessionId: "s", token: "t", version: 0 });
      const body = JSON.parse(String(init?.body)); writes.push(body);
      if (lost) { lost = false; throw new Error("response lost"); }
      return response({ version: writes.length });
    }));
    const { syncBackup } = await import("../src/core/cloudSync");
    expect(await syncBackup(save(1))).toBe("offline");
    expect(await syncBackup(save(2))).toBe("synced");
    expect(writes).toHaveLength(3);
    expect(writes[0].operationId).toBe(writes[1].operationId);
    expect(writes[2].save.savedAt).toBe(2);
    expect(writes[2].parentVersion).toBe(2);
  });

  it("claims old v1 metadata for only one legacy save with a shared seed", async () => {
    storage.setItem("cloud-isles-cloud-meta-v1", JSON.stringify({ sessionId: "old", token: "old-token", version: 3 }));
    const { npcRequestMeta } = await import("../src/core/cloudSync");
    const legacy = (savedAt: number) => ({ savedAt, world: { worldSeed: 7 } } as SaveData);
    expect(npcRequestMeta(legacy(1)).sessionId).toBe("old");
    expect(npcRequestMeta(legacy(2)).sessionId).toBeUndefined();
  });

  it("rebases a selected conflict copy onto the normal head before the next upload", async () => {
    storage.setItem("cloud-isles-cloud-meta-v2", JSON.stringify({ "journey-a": { sessionId: "s", token: "t", version: 1, worldId: "journey-a" } }));
    const writes: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/versions/2")) return response({ payload: save(2) });
      if (url.includes("/versions?")) return response({ versions: Array.from({ length: 21 }, (_, i) => ({ version: i + 2, conflict: true })) });
      if (url.includes("/api/save/s?")) return response({ version: 1 });
      writes.push(JSON.parse(String(init?.body))); return response({ version: 2 });
    }));
    const { restoreCloudBackup, syncBackup } = await import("../src/core/cloudSync");
    expect(await restoreCloudBackup(2, save(1))).not.toBeNull();
    expect(await syncBackup(save(3))).toBe("synced");
    expect(writes[0].parentVersion).toBe(1);
  });

  it("leaves metadata and the durable replay intact when normal-head lookup fails", async () => {
    const meta = { sessionId: "s", token: "t", version: 1, worldId: "journey-a" };
    const pending = { meta, parentVersion: 1, operationId: "pending-operation", save: save(1) };
    storage.setItem("cloud-isles-cloud-meta-v2", JSON.stringify({ "journey-a": meta }));
    storage.setItem("cloud-isles-cloud-pending-v2", JSON.stringify(pending));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/versions/2") ? response({ payload: save(2) }) : response({}, 503)));
    const { restoreCloudBackup } = await import("../src/core/cloudSync");
    expect(await restoreCloudBackup(2, "journey-a")).toBeNull();
    expect(JSON.parse(storage.getItem("cloud-isles-cloud-meta-v2")!)).toEqual({ "journey-a": meta });
    expect(JSON.parse(storage.getItem("cloud-isles-cloud-pending-v2")!)).toEqual(pending);
  });
});
