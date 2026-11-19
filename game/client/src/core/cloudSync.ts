import type { SaveData } from "shared";

interface CloudMeta { sessionId: string; token: string; version: number; worldId: string }
interface Pending { meta: CloudMeta; parentVersion: number; operationId: string; save: SaveData }
export interface CloudVersion { version: number; parentVersion: number; conflict: boolean; createdAt: number }
const META = "cloud-isles-cloud-meta-v2";
const PENDING = "cloud-isles-cloud-pending-v2";
const LEGACY_CLAIMED = "cloud-isles-cloud-meta-v1-claimed";
let serial = Promise.resolve<"synced" | "offline" | "conflict">("synced");
let currentWorld: SaveData | null = null;
const sessions = new Map<string, Promise<CloudMeta | null>>();

function worldId(save: SaveData) { return save.world.worldId ?? `legacy-${save.world.worldSeed ?? "default"}-${save.savedAt}`; }
function readMap(): Record<string, CloudMeta> { try { const data = JSON.parse(localStorage.getItem(META) ?? "{}"); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; } catch { return {}; } }
function usableMeta(value: CloudMeta | undefined): value is CloudMeta { return !!value && typeof value.sessionId === "string" && typeof value.token === "string" && Number.isInteger(value.version); }
function readMeta(id: string) {
  const value = readMap()[id];
  if (usableMeta(value)) return value;
  // v1 had one global session and no journey ID. Only attach it when restoring a legacy-seed save.
  if (id.startsWith("legacy-") && (!localStorage.getItem(LEGACY_CLAIMED) || localStorage.getItem(LEGACY_CLAIMED) === id)) try {
    const old = JSON.parse(localStorage.getItem("cloud-isles-cloud-meta-v1") ?? "null") as Omit<CloudMeta, "worldId"> | null;
    if (old && typeof old.sessionId === "string" && typeof old.token === "string" && Number.isInteger(old.version)) { const migrated = { ...old, worldId: id }; writeMeta(migrated); localStorage.setItem(LEGACY_CLAIMED, id); return migrated; }
  } catch { /* no usable old metadata */ }
  return null;
}
function writeMeta(meta: CloudMeta) { const all = readMap(); all[meta.worldId] = meta; localStorage.setItem(META, JSON.stringify(all)); }
function readPending(): Pending | null { try { return JSON.parse(localStorage.getItem(PENDING) ?? "null"); } catch { return null; } }

export function npcRequestMeta(save?: SaveData): { sessionId?: string; token?: string; operationId: string } {
  const meta = (save ?? currentWorld) ? readMeta(worldId(save ?? currentWorld!)) : null;
  return { sessionId: meta?.sessionId, token: meta?.token, operationId: crypto.randomUUID() };
}
export function setNpcWorldContext(save: SaveData) { currentWorld = save; void ensureCloudSession(save); }

/** Session creation is shared by new journeys, restored journeys and save uploads. */
export async function ensureCloudSession(save: SaveData): Promise<CloudMeta | null> {
  const id = worldId(save);
  const existing = readMeta(id);
  if (existing) return existing;
  if (!navigator.onLine) return null;
  const pending = sessions.get(id);
  if (pending) return pending;
  const creation = (async () => {
    try {
      const res = await fetch("/api/save/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ worldId: id }), signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const value = { ...await res.json(), worldId: id } as CloudMeta;
      if (!usableMeta(value)) return null;
      writeMeta(value);
      return value;
    } catch { return null; }
  })();
  sessions.set(id, creation);
  try { return await creation; } finally { sessions.delete(id); }
}

export async function readyNpcRequestMeta() {
  const world = currentWorld;
  if (world) await ensureCloudSession(world);
  // A request prepared for the old world must never borrow the newly selected world's capability.
  return npcRequestMeta(world ?? undefined);
}

export function knownCloudWorlds(): { worldId: string; version: number }[] {
  return Object.entries(readMap()).filter(([, value]) => usableMeta(value)).map(([id, value]) => ({ worldId: id, version: value.version }));
}

async function syncOne(save: SaveData): Promise<"synced" | "offline" | "conflict"> {
  const id = worldId(save);
  if (!navigator.onLine) return "offline";
  try {
    let queued = readPending();
    if (queued?.meta.worldId !== id) queued = null;
    const meta = queued?.meta ?? await ensureCloudSession(save);
    if (!meta) return "offline";
    // Write exact replay data before network I/O; a lost response uses the same operation ID and parent.
    queued ??= { meta, parentVersion: meta.version, operationId: crypto.randomUUID(), save };
    localStorage.setItem(PENDING, JSON.stringify(queued));
    const result = await fetch(`/api/save/${encodeURIComponent(queued.meta.sessionId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: queued.meta.token, parentVersion: queued.parentVersion, operationId: queued.operationId, save: queued.save }) });
    if (result.status === 409) return "conflict";
    if (!result.ok) throw new Error("backup unavailable");
    const value = await result.json() as { version: number };
    writeMeta({ ...queued.meta, version: value.version });
    const current = readPending(); if (current?.operationId === queued.operationId) localStorage.removeItem(PENDING);
    // A lost response can leave A pending while a newer B arrives. Acknowledge A first, then upload B.
    return JSON.stringify(queued.save) === JSON.stringify(save) ? "synced" : syncOne(save);
  } catch { return "offline"; }
}

export function syncBackup(save: SaveData): Promise<"synced" | "offline" | "conflict"> {
  currentWorld = save;
  serial = serial.then(() => syncOne(save), () => syncOne(save));
  return serial;
}

export async function listCloudBackups(save?: SaveData | string): Promise<CloudVersion[]> {
  const meta = save ? readMeta(typeof save === "string" ? save : worldId(save)) : null;
  if (!meta) return [];
  const res = await fetch(`/api/save/${encodeURIComponent(meta.sessionId)}/versions?token=${encodeURIComponent(meta.token)}`);
  if (!res.ok) throw new Error("云端版本列表读取失败。");
  const value = await res.json() as { versions?: CloudVersion[] };
  return Array.isArray(value.versions) ? value.versions : [];
}

export async function restoreCloudBackup(version: number, save?: SaveData | string): Promise<SaveData | null> {
  const meta = save ? readMeta(typeof save === "string" ? save : worldId(save)) : null;
  if (!meta) return null;
  const res = await fetch(`/api/save/${encodeURIComponent(meta.sessionId)}/versions/${version}?token=${encodeURIComponent(meta.token)}`);
  if (!res.ok) return null;
  const value = await res.json() as { payload?: SaveData };
  if (value.payload) {
    // Conflict copies are deliberately not normal heads. Rebase subsequent writes on the latest normal head.
    const head = await fetch(`/api/save/${encodeURIComponent(meta.sessionId)}?token=${encodeURIComponent(meta.token)}`);
    if (!head.ok) return null;
    const normalHead = (await head.json() as { version?: number }).version;
    if (!Number.isInteger(normalHead)) return null;
    writeMeta({ ...meta, version: normalHead as number });
    if (readPending()?.meta.worldId === meta.worldId) localStorage.removeItem(PENDING);
  }
  return value.payload ?? null;
}
