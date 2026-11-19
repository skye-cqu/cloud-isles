import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SaveStore } from "../../server/src/save-store";

describe("SaveStore", () => {
  it("rolls back completion if audit insert fails, authenticates fingerprint, and persists the total provider budget", () => {
    const path = join(mkdtempSync(join(tmpdir(), "m1-atomic-")), "audit.sqlite");
    const store = new SaveStore(path);
    store.createSession("session", "token", "world");
    store.beginLlm("session", "token", "operation", "chat", "fingerprint");
    const attempt = store.reserveLlmAttempt("session", "token", "operation", "fingerprint", 1)!;
    expect(attempt).not.toBeNull();
    expect(store.reserveLlmAttempt("session", "bad-token", "operation", "fingerprint", 2)).toBeNull();
    expect(store.reserveLlmAttempt("session", "token", "operation", "fingerprint", 1)).toBeNull();
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON llm_records BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    const finish = () => store.completeLlm("session", "token", "operation", "chat", "fingerprint", { reply: "local" }, "fallback", [{ id: attempt, status: "failed" }]);
    expect(finish).toThrow(/audit unavailable/);
    expect(store.beginLlm("session", "token", "operation", "chat", "fingerprint")).toBe("pending");
    expect(db.prepare("SELECT status FROM llm_attempts").get()).toMatchObject({ status: "started" });
    db.exec("DROP TRIGGER fail_audit");
    expect(() => store.completeLlm("session", "token", "operation", "chat", "wrong", {}, "success", [])).toThrow();
    finish();
    expect(db.prepare("SELECT status FROM llm_records").get()).toMatchObject({ status: "failed" });
    expect(db.prepare("SELECT status FROM llm_operations").get()).toMatchObject({ status: "fallback" });
    store.close();
    const reopened = new SaveStore(path);
    reopened.beginLlm("session", "token", "another", "chat", "second");
    expect(reopened.reserveLlmAttempt("session", "token", "another", "second", 1)).toBeNull();
    reopened.close(); db.close();
  });
  it("keeps a conflict response idempotent and exposes the preserved copy", () => {
    const store = new SaveStore(":memory:");
    store.createSession("session-0001", "token-000000000001", "world");
    expect(store.write("session-0001", "token-000000000001", 0, "operation-0001", { name: "main" })).toMatchObject({ ok: true, version: 1 });
    const conflict = store.write("session-0001", "token-000000000001", 0, "operation-0002", { name: "copy" });
    expect(conflict).toMatchObject({ ok: false, status: 409, version: 2 });
    expect(store.write("session-0001", "token-000000000001", 0, "operation-0002", { name: "changed" })).toEqual(conflict);
    expect(store.listVersions("session-0001", "token-000000000001")).toHaveLength(2);
    expect(store.readVersion("session-0001", "token-000000000001", 2)).toMatchObject({ payload: { name: "copy" } });
  });

  it("migrates an on-disk v0 conflict history without changing retry meaning or contents", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cloud-isles-save-store-")), "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE save_sessions (id TEXT PRIMARY KEY, token TEXT NOT NULL, world_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE save_versions (session_id TEXT NOT NULL, version INTEGER NOT NULL, parent_version INTEGER NOT NULL, payload TEXT NOT NULL, conflict INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(session_id, version));
      CREATE TABLE save_operations (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(session_id, operation_id));
      INSERT INTO save_sessions VALUES ('legacy-session', 'legacy-token-0001', 'world', 1, 1);
      INSERT INTO save_versions VALUES ('legacy-session', 1, 0, '{"name":"main"}', 0, 1);
      INSERT INTO save_versions VALUES ('legacy-session', 2, 0, '{"name":"conflict"}', 1, 2);
      INSERT INTO save_operations VALUES ('legacy-session', 'legacy-op-main', 1);
      INSERT INTO save_operations VALUES ('legacy-session', 'legacy-op-conflict', 2);
    `);
    legacy.close();

    const store = new SaveStore(path);
    expect(store.write("legacy-session", "legacy-token-0001", 0, "legacy-op-conflict", { changed: true })).toMatchObject({ ok: false, status: 409, version: 2 });
    expect(store.readVersion("legacy-session", "legacy-token-0001", 2)).toMatchObject({ payload: { name: "conflict" } });
    expect(store.listVersions("legacy-session", "legacy-token-0001")).toHaveLength(2);
    store.close();

    const reopened = new SaveStore(path);
    expect(reopened.write("legacy-session", "legacy-token-0001", 0, "legacy-op-conflict", { changedAgain: true })).toMatchObject({ ok: false, status: 409, version: 2 });
    expect(reopened.listVersions("legacy-session", "legacy-token-0001")).toHaveLength(2);
    reopened.close();
  });

  it("refuses an orphan legacy operation and leaves its database untouched", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cloud-isles-save-store-")), "orphan.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE save_operations (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(session_id, operation_id));
      INSERT INTO save_operations VALUES ('orphan-session', 'orphan-operation', 7);
    `);
    db.close();
    expect(() => new SaveStore(path)).toThrow(/orphan=1/);
    const after = new DatabaseSync(path);
    expect((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(0);
    expect((after.prepare("SELECT COUNT(*) AS count FROM save_operations").get() as { count: number }).count).toBe(1);
    after.close();
  });

  it("persists an in-flight model operation so restart returns a safe result instead of a second call", () => {
    const store = new SaveStore(":memory:");
    store.createSession("npc-session", "npc-token-0000001", "world");
    expect(store.beginLlm("npc-session", "npc-token-0000001", "npc-operation", "decide", "fingerprint")).toBe("started");
    expect(store.beginLlm("npc-session", "npc-token-0000001", "npc-operation", "decide", "fingerprint")).toBe("pending");
    store.completeLlm("npc-session", "npc-token-0000001", "npc-operation", "decide", "fingerprint", { action: "idle" }, "fallback", []);
    expect(store.beginLlm("npc-session", "npc-token-0000001", "npc-operation", "decide", "fingerprint")).toEqual({ result: { action: "idle" } });
    expect(store.beginLlm("npc-session", "npc-token-0000001", "npc-operation", "chat", "fingerprint")).toBe("mismatch");
    store.close();
  });
});
