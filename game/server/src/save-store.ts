import { DatabaseSync } from "node:sqlite";

export interface StoredSave { version: number; payload: unknown; updatedAt: number }
export type WriteResult = { ok: true; version: number } | { ok: false; status: 401 | 409; error: string; version?: number };
export interface LlmAttempt { id: number; status: "success" | "failed" }

/** 单机服务的版本化云备份；会话 capability 不是账号系统。 */
export class SaveStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try { this.migrate(); } catch (error) { this.db.close(); throw error; }
  }

  /** Reversible, transactional v0→v1 migration. Existing conflict outcomes remain conflicts after restart. */
  private migrate() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (current > 2) throw new Error(`unsupported save database version ${current}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS save_sessions (id TEXT PRIMARY KEY, token TEXT NOT NULL, world_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS save_versions (session_id TEXT NOT NULL, version INTEGER NOT NULL, parent_version INTEGER NOT NULL, payload TEXT NOT NULL, conflict INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(session_id, version));
        CREATE TABLE IF NOT EXISTS save_operations (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, version INTEGER NOT NULL, conflict INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, operation_id));
        CREATE TABLE IF NOT EXISTS llm_records (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id, operation_id));
        CREATE TABLE IF NOT EXISTS llm_operations (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, operation_id));
        CREATE TABLE IF NOT EXISTS llm_attempts (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      `);
      const hasColumn = (table: string, column: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);
      if (!hasColumn("save_versions", "conflict")) this.db.exec("ALTER TABLE save_versions ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn("save_operations", "conflict")) this.db.exec("ALTER TABLE save_operations ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0");
      const orphan = (this.db.prepare("SELECT COUNT(*) AS count FROM save_operations o LEFT JOIN save_versions v ON v.session_id = o.session_id AND v.version = o.version WHERE v.version IS NULL").get() as { count: number }).count;
      if (orphan) throw new Error(`invalid save operation history (orphan=${orphan}, inconsistent=0)`);
      // v0 operations did not record conflict. The immutable saved version is the source of truth.
      this.db.exec("UPDATE save_operations SET conflict = (SELECT conflict FROM save_versions WHERE save_versions.session_id = save_operations.session_id AND save_versions.version = save_operations.version)");
      const inconsistent = (this.db.prepare("SELECT COUNT(*) AS count FROM save_operations o JOIN save_versions v ON v.session_id = o.session_id AND v.version = o.version WHERE o.conflict != v.conflict").get() as { count: number }).count;
      if (inconsistent) throw new Error(`invalid save operation history (orphan=0, inconsistent=${inconsistent})`);
      this.db.exec("PRAGMA user_version = 2");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createSession(id: string, token: string, worldId: string) {
    const now = Date.now();
    this.db.prepare("INSERT INTO save_sessions(id, token, world_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, token, worldId, now, now);
  }

  sessionWorldId(sessionId: string, token: string): string | null {
    const row = this.db.prepare("SELECT world_id FROM save_sessions WHERE id = ? AND token = ?").get(sessionId, token) as { world_id: string } | undefined;
    return row?.world_id ?? null;
  }

  migrateLegacySessionWorld(sessionId: string, token: string, from: string, to: string) {
    return this.db.prepare("UPDATE save_sessions SET world_id = ? WHERE id = ? AND token = ? AND world_id = ?").run(to, sessionId, token, from).changes === 1;
  }

  read(sessionId: string, token: string): StoredSave | null | "unauthorized" {
    if (!this.authorized(sessionId, token)) return "unauthorized";
    const row = this.db.prepare("SELECT version, payload, created_at FROM save_versions WHERE session_id = ? AND conflict = 0 ORDER BY version DESC LIMIT 1").get(sessionId) as { version: number; payload: string; created_at: number } | undefined;
    return row ? { version: row.version, payload: JSON.parse(row.payload), updatedAt: row.created_at } : null;
  }

  write(sessionId: string, token: string, parentVersion: number, operationId: string, payload: unknown): WriteResult {
    if (!this.authorized(sessionId, token)) return { ok: false, status: 401, error: "invalid session capability" };
    const prior = this.db.prepare("SELECT version, conflict FROM save_operations WHERE session_id = ? AND operation_id = ?").get(sessionId, operationId) as { version: number; conflict: number } | undefined;
    if (prior) return prior.conflict ? { ok: false, status: 409, error: "parent version conflict; uploaded copy was preserved", version: prior.version } : { ok: true, version: prior.version };
    const latest = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM save_versions WHERE session_id = ? AND conflict = 0").get(sessionId) as { version: number };
    const next = (this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM save_versions WHERE session_id = ?").get(sessionId) as { version: number }).version + 1;
    const conflict = latest.version !== parentVersion;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO save_versions(session_id, version, parent_version, payload, conflict, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(sessionId, next, parentVersion, JSON.stringify(payload), conflict ? 1 : 0, now);
      this.db.prepare("INSERT INTO save_operations(session_id, operation_id, version, conflict) VALUES (?, ?, ?, ?)").run(sessionId, operationId, next, conflict ? 1 : 0);
      this.db.prepare("UPDATE save_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return conflict ? { ok: false, status: 409, error: "parent version conflict; uploaded copy was preserved", version: next } : { ok: true, version: next };
  }

  /** Atomically reserve one billable model operation. Restarted unknown work is never sent again. */
  beginLlm(sessionId: string, token: string, operationId: string, kind: "chat" | "decide" | "create", fingerprint: string): "started" | "pending" | "mismatch" | { result: unknown } | "unauthorized" {
    if (!this.authorized(sessionId, token)) return "unauthorized";
    const found = this.db.prepare("SELECT kind, fingerprint, status, result FROM llm_operations WHERE session_id = ? AND operation_id = ?").get(sessionId, operationId) as { kind: string; fingerprint: string; status: string; result: string | null } | undefined;
    if (found) {
      if (found.kind !== kind || found.fingerprint !== fingerprint) return "mismatch";
      if (found.result) return { result: JSON.parse(found.result) };
      return "pending";
    }
    this.db.prepare("INSERT INTO llm_operations(session_id, operation_id, kind, fingerprint, status, result, updated_at) VALUES (?, ?, ?, ?, 'started', NULL, ?)").run(sessionId, operationId, kind, fingerprint, Date.now());
    return "started";
  }

  /** Reserve each actual provider HTTP attempt, including retries. The total survives restarts. */
  reserveLlmAttempt(sessionId: string, token: string, operationId: string, fingerprint: string, limit: number): number | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const operation = this.db.prepare("SELECT fingerprint, result FROM llm_operations WHERE session_id = ? AND operation_id = ?").get(sessionId, operationId) as { fingerprint: string; result: string | null } | undefined;
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM llm_attempts").get() as { count: number }).count;
      if (!this.authorized(sessionId, token) || !operation || operation.fingerprint !== fingerprint || operation.result !== null || count >= limit) {
        this.db.exec("COMMIT"); return null;
      }
      const reserved = this.db.prepare("INSERT INTO llm_attempts(session_id, operation_id, status, created_at) VALUES (?, ?, 'started', ?)").run(sessionId, operationId, Date.now());
      this.db.exec("COMMIT");
      return Number(reserved.lastInsertRowid);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  llmBudgetAvailable(limit: number) {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM llm_attempts").get() as { count: number }).count < limit;
  }

  /** Final result and attempt audit commit together; callers may cache only after this returns. */
  completeLlm(sessionId: string, token: string, operationId: string, kind: "chat" | "decide" | "create", fingerprint: string, result: unknown, status: "success" | "fallback", attempts: LlmAttempt[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const operation = this.db.prepare("SELECT kind, fingerprint, result FROM llm_operations WHERE session_id = ? AND operation_id = ?").get(sessionId, operationId) as { kind: string; fingerprint: string; result: string | null } | undefined;
      if (!this.authorized(sessionId, token) || !operation || operation.kind !== kind || operation.fingerprint !== fingerprint || operation.result !== null) throw new Error("invalid model completion");
      this.db.prepare("UPDATE llm_operations SET status = ?, result = ?, updated_at = ? WHERE session_id = ? AND operation_id = ?").run(status, JSON.stringify(result), Date.now(), sessionId, operationId);
      for (const attempt of attempts) {
        const changed = this.db.prepare("UPDATE llm_attempts SET status = ? WHERE id = ? AND session_id = ? AND operation_id = ? AND status = 'started'").run(attempt.status, attempt.id, sessionId, operationId).changes;
        if (changed !== 1) throw new Error("invalid model attempt");
      }
      // An interrupted previous process may have reserved work whose outcome is unknown.
      this.db.prepare("UPDATE llm_attempts SET status = 'failed' WHERE session_id = ? AND operation_id = ? AND status = 'started'").run(sessionId, operationId);
      const failed = this.db.prepare("SELECT 1 FROM llm_attempts WHERE session_id = ? AND operation_id = ? AND status = 'failed' LIMIT 1").get(sessionId, operationId);
      this.db.prepare("INSERT INTO llm_records(session_id, operation_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, operationId, kind, failed && status !== "success" ? "failed" : status, Date.now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listVersions(sessionId: string, token: string): { version: number; parentVersion: number; conflict: boolean; createdAt: number }[] | "unauthorized" {
    if (!this.authorized(sessionId, token)) return "unauthorized";
    return (this.db.prepare("SELECT version, parent_version, conflict, created_at FROM save_versions WHERE session_id = ? ORDER BY version DESC LIMIT 20").all(sessionId) as { version: number; parent_version: number; conflict: number; created_at: number }[])
      .map((row) => ({ version: row.version, parentVersion: row.parent_version, conflict: !!row.conflict, createdAt: row.created_at }));
  }

  readVersion(sessionId: string, token: string, version: number): StoredSave | null | "unauthorized" {
    if (!this.authorized(sessionId, token)) return "unauthorized";
    const row = this.db.prepare("SELECT version, payload, created_at FROM save_versions WHERE session_id = ? AND version = ?").get(sessionId, version) as { version: number; payload: string; created_at: number } | undefined;
    return row ? { version: row.version, payload: JSON.parse(row.payload), updatedAt: row.created_at } : null;
  }

  /** Capability verification for routes which attach NPC work/audit to a save session. */
  isAuthorized(sessionId: string, token: string) {
    return !!this.db.prepare("SELECT 1 FROM save_sessions WHERE id = ? AND token = ?").get(sessionId, token);
  }

  private authorized(sessionId: string, token: string) { return this.isAuthorized(sessionId, token); }

  close() { this.db.close(); }
}
