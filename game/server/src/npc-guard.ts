import { createHash } from "node:crypto";
import type { NpcSituation } from "shared";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const boundedString = (value: unknown, max: number, min = 0) => typeof value === "string" && value.length >= min && value.length <= max;
const boundedNumber = (value: unknown, min: number, max: number, integer = false) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));

/** Validate every field consumed by the prompt/local fallback before accepting it. */
export function validNpcSituation(value: unknown): value is NpcSituation {
  if (!isRecord(value)) return false;
  const r = value;
  if (!boundedString(r.npcId, 64, 1) || !boundedString(r.npcName, 100, 1) || !boundedString(r.persona, 1000, 1)
    || !boundedString(r.goal, 500, 1) || !boundedString(r.timeOfDay, 80, 1) || !boundedString(r.weather, 80, 1)
    || !boundedNumber(r.homeLevel, 0, 99, true) || !boundedNumber(r.hp, 0, 100) || !boundedNumber(r.hunger, 0, 100)
    || typeof r.playerNearby !== "boolean" || !boundedString(r.playerDoing, 160, 1)) return false;
  if (!Array.isArray(r.inventory) || r.inventory.length > 100 || !r.inventory.every((item) => isRecord(item) && boundedString(item.id, 64, 1) && boundedNumber(item.count, 0, 1_000_000, true))) return false;
  if (!Array.isArray(r.farm) || r.farm.length > 100 || !r.farm.every((farm) => isRecord(farm) && boundedString(farm.plot, 100, 1) && boundedString(farm.stage, 100, 1) && boundedString(farm.crop, 100, 1))) return false;
  if (!Array.isArray(r.others) || r.others.length > 40 || !r.others.every((other) => isRecord(other) && boundedString(other.name, 100, 1) && boundedString(other.doing, 160, 1))) return false;
  if (!Array.isArray(r.facilities) || r.facilities.length > 100 || !r.facilities.every((facility) => isRecord(facility) && boundedString(facility.id, 100, 1) && boundedString(facility.name, 100, 1) && typeof facility.usable === "boolean")) return false;
  if (!Array.isArray(r.recentMemory) || r.recentMemory.length > 40 || !r.recentMemory.every((memory) => boundedString(memory, 1000))) return false;
  if (r.recentChat !== undefined && (!Array.isArray(r.recentChat) || r.recentChat.length > 8 || !r.recentChat.every((chat) => isRecord(chat) && boundedString(chat.from, 100, 1) && boundedString(chat.text, 600, 1)))) return false;
  if (r.buildAuthorization !== undefined && r.buildAuthorization !== null) {
    if (!isRecord(r.buildAuthorization) || !boundedString(r.buildAuthorization.zone, 100, 1) || !isRecord(r.buildAuthorization.budget)
      || Object.keys(r.buildAuthorization.budget).length > 32 || !Object.values(r.buildAuthorization.budget).every((amount) => boundedNumber(amount, 0, 1_000_000, true))) return false;
  }
  return true;
}

export type CachedNpcResult = { expiresAt: number; fingerprint: string; result: unknown };

/** In-memory response cache. A reused operation ID must mean the exact same authenticated request. */
export class NpcResultCache {
  private entries = new Map<string, CachedNpcResult>();

  fingerprint(kind: "chat" | "decide" | "create", body: unknown) {
    return createHash("sha256").update(kind).update("\0").update(JSON.stringify(body)).digest("hex");
  }

  read(key: string, fingerprint: string): { state: "miss" } | { state: "hit"; result: unknown } | { state: "mismatch" } {
    const found = this.entries.get(key);
    if (!found || found.expiresAt <= Date.now()) { this.entries.delete(key); return { state: "miss" }; }
    return found.fingerprint === fingerprint ? { state: "hit", result: found.result } : { state: "mismatch" };
  }

  write(key: string, fingerprint: string, result: unknown) {
    const now = Date.now();
    for (const [oldKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(oldKey);
    if (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expiresAt: Date.now() + 10 * 60_000, fingerprint, result });
  }
}

/** Coalesces same authenticated operation while it is executing; never retains failed/completed promises. */
export class NpcOperationCoordinator {
  private inflight = new Map<string, Promise<unknown>>();

  async run<T>(key: string | null, work: () => Promise<T>): Promise<T> {
    if (!key) return work();
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve().then(work);
    this.inflight.set(key, promise);
    try { return await promise; } finally { if (this.inflight.get(key) === promise) this.inflight.delete(key); }
  }
  has(key: string | null) { return !!key && this.inflight.has(key); }
}
