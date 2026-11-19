// IndexedDB 本地主档。
import { isValidSavePayload, SaveData } from "shared";

/** 视觉制作版与既有试玩档物理隔离，避免布局迁移覆盖用户原进度。 */
export const LOCAL_SAVE_DB_NAME = "cloud-isles-home-visual-v3";
const DB_NAME = LOCAL_SAVE_DB_NAME;
const STORE = "saves";
const KEY = "main";
const LAST_VALID = "last-valid";
const RECOVERY_STORE = "recovery";
export const SAVE_VERSION = 2;
let lastLoadIssue: string | null = null;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      if (!req.result.objectStoreNames.contains(RECOVERY_STORE)) req.result.createObjectStore(RECOVERY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { lastLoadIssue = "本地存档数据库无法打开。"; reject(req.error); };
  });
}

export async function saveGame(data: SaveData): Promise<void> {
  const normalized = normalizeSaveData(data);
  if (!normalized) throw new Error("存档数据未通过校验，未覆盖已有进度");
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, RECOVERY_STORE], "readwrite");
    tx.objectStore(STORE).put(normalized, KEY);
    tx.objectStore(STORE).put(normalized, LAST_VALID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("存档事务被中止"));
  });
}

export async function loadGame(): Promise<SaveData | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, RECOVERY_STORE], "readwrite");
    let outcome: SaveData | null = null;
    let issue: string | null = null;
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => {
      const current = normalizeSaveData(req.result);
      if (current) { outcome = current; return; }
      if (req.result !== undefined) {
        tx.objectStore(RECOVERY_STORE).put(req.result, `invalid-${Date.now()}`);
        issue = "主存档无法读取，已保留原始副本并尝试恢复最近有效版本。";
      }
      const fallback = tx.objectStore(STORE).get(LAST_VALID);
      fallback.onsuccess = () => { outcome = normalizeSaveData(fallback.result); if (!outcome && req.result !== undefined) issue = "主存档无法读取，且没有有效恢复副本。"; };
      fallback.onerror = () => reject(fallback.error);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => { lastLoadIssue = issue; resolve(outcome); };
    tx.onerror = () => { lastLoadIssue = "存档恢复副本写入失败。"; reject(tx.error ?? new Error("读取存档失败")); };
    tx.onabort = () => { lastLoadIssue = "存档恢复事务被中止。"; reject(tx.error ?? new Error("读取事务被中止")); };
  });
}

export function getLastSaveIssue(): string | null { return lastLoadIssue; }

export function exportSaveJson(data: SaveData): string { return JSON.stringify(normalizeSaveData(data) ?? data, null, 2); }

export async function importSaveJson(text: string): Promise<boolean> {
  try {
    const value = normalizeSaveData(JSON.parse(text));
    if (!value) return false;
    await saveGame(value);
    return true;
  } catch { return false; }
}

/** 只接受可由本版本安全恢复的快照；旧 v1 保留已发生的事实，不补造事件。 */
export function normalizeSaveData(raw: unknown): SaveData | null {
  if (!isValidSavePayload(raw)) return null;
  // Shared validation is the only schema gate. Clone extensions as well as known fields.
  const save = structuredClone(raw);
  save.version = SAVE_VERSION;
  save.ship.energy ??= 100;
  save.questFacts = [...new Set(save.questFacts ?? [])];
  return save;
}
export async function hasSave(): Promise<boolean> {
  try {
    return !!(await loadGame());
  } catch {
    lastLoadIssue = "本地存档无法读取。";
    return false;
  }
}
