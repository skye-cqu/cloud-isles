// 岛屿流式器:世界种子+区域驱动的按需生成请求、预取、加载、卸载与回访恢复。
// 纯决策函数(候选区域/滞回)与副作用类分离,便于离线测试。
import {
  Mesh, MeshBuilder, PhysicsAggregate, PhysicsMotionType, PhysicsShapeType, Scene, Vector3,
} from "@babylonjs/core";
import {
  DEFAULT_WORLD_SEED, islandCenterWorld, islandKeyToString, islandSeed, isStarterRegion,
  regionIslandKeys, rngFromSeed, type IslandKey, type IslandMutation, type RegionKey,
} from "shared";
import type { World, PickupDef } from "./world";
import { createLsicRuntimeIsland, type RuntimeLsicIsland } from "./lsicIsland";
import { loadEnvModel } from "../assets/envModels";
import type { CloudShip } from "./ship";

/** 请求生成半径(米):云舟最高航速 ~26m/s,预留约 90s 生成窗口 */
export const PREFETCH_RADIUS_M = 2300;
/** 实例化半径(米) */
export const LOAD_RADIUS_M = 950;
/** 卸载半径(米):滞回高于加载半径,避免边界抖动 */
export const UNLOAD_RADIUS_M = 3000;
/** 生成状态轮询间隔 */
export const POLL_INTERVAL_MS = 2500;
/** 失败重试间隔 */
export const RETRY_AFTER_MS = 30_000;
/** 在途生成请求上限:就近优先,避免一次扫描把服务器队列灌满 */
export const MAX_INFLIGHT_REQUESTS = 4;

export type StreamState = "idle" | "requested" | "ready" | "loaded" | "failed";

/** 焦点周围需要考虑的候选区域(含预取边缘,负坐标 floor 语义)。 */
export function candidateRegions(focus: { x: number; z: number }, prefetchR: number): RegionKey[] {
  const rx0 = Math.floor((focus.x - prefetchR) / 640);
  const rz0 = Math.floor((focus.z - prefetchR) / 640);
  const span = Math.ceil((prefetchR * 2) / 640);
  const out: RegionKey[] = [];
  for (let rx = rx0; rx <= rx0 + span; rx++) {
    for (let rz = rz0; rz <= rz0 + span; rz++) {
      out.push({ x: rx, z: rz });
    }
  }
  return out;
}

/** 滞回决策:idle→请求;ready 且进入加载圈→装载;loaded 且超出卸载圈→卸载。 */
export function streamDecision(
  state: StreamState, dist: number,
): "request" | "load" | "unload" | "none" {
  switch (state) {
    case "idle": return dist < PREFETCH_RADIUS_M ? "request" : "none";
    case "requested":
    case "failed": return "none";
    case "ready": return dist < LOAD_RADIUS_M ? "load" : "none";
    case "loaded": return dist > UNLOAD_RADIUS_M ? "unload" : "none";
  }
}

export interface StreamerOpts {
  scene: Scene;
  world: World;
  shadowAdd: (mesh: Mesh) => void;
  /** 新拾取物注册进交互系统 */
  registerPickup: (p: PickupDef) => void;
  onToast: (msg: string, dur?: number) => void;
  onEvent?: (kind: string, data?: unknown) => void;
}

interface StreamEntry {
  key: IslandKey;
  keyStr: string;
  state: StreamState;
  descriptor?: RuntimeLsicIsland["descriptor"];
  island?: RuntimeLsicIsland;
  pickups: PickupDef[];
  gangway?: { mesh: Mesh; dispose: () => void };
  error?: string;
  failedAt: number;
  pollAt: number;
  loading: boolean;
}

const PICKUP_MODEL: Record<string, string> = {
  windcrystal: "items/Crystal1",
  floatstone: "items/Mineral",
  cloudmushroom: "crops/Mushroom_4",
};

export class IslandStreamer {
  worldSeed = DEFAULT_WORLD_SEED;
  private entries = new Map<string, StreamEntry>();
  private mutations = new Map<string, IslandMutation>();
  private lastScanAt = 0;
  private lastPollAt = 0;
  private pickupProtos = new Map<string, Mesh>();
  /** 最近一次 focus(玩家/云舟位置):随生成请求上报,服务端据此距离优先调度队列。 */
  private lastFocus: Vector3 | null = null;

  constructor(private opts: StreamerOpts) {}

  setWorldSeed(seed: number): void {
    this.worldSeed = seed >>> 0 || DEFAULT_WORLD_SEED;
  }

  loadMutations(m: Record<string, IslandMutation> | undefined): void {
    this.mutations = new Map(Object.entries(m ?? {}));
  }

  exportMutations(): Record<string, IslandMutation> {
    // 先把在载岛屿的当前状态写进变更,再序列化
    for (const entry of this.entries.values()) {
      if (entry.state === "loaded") this.writeMutation(entry);
    }
    return Object.fromEntries(this.mutations);
  }

  stats(): { loaded: number; generating: number; failed: number } {
    let loaded = 0, generating = 0, failed = 0;
    for (const e of this.entries.values()) {
      if (e.state === "loaded") loaded++;
      else if (e.state === "requested") generating++;
      else if (e.state === "failed") failed++;
    }
    return { loaded, generating, failed };
  }

  /** 扫描 + 轮询(主循环调用;内部按节流执行)。focus 用玩家位置(航行时随船)。 */
  update(dt: number, focus: Vector3): void {
    void dt;
    this.lastFocus = focus;
    const now = performance.now();
    if (now - this.lastScanAt > 600) {
      this.lastScanAt = now;
      this.scan(focus);
    }
    if (now - this.lastPollAt > POLL_INTERVAL_MS) {
      this.lastPollAt = now;
      void this.pollPending();
    }
  }

  /** 存档恢复:确保焦点附近缓存命中的岛屿先于玩家物理加载完成。 */
  async ensureAround(focus: Vector3): Promise<void> {
    this.scan(focus);
    const pending: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state === "requested") pending.push(this.pollEntry(entry, true));
      if (entry.state === "ready" && this.distTo(entry, focus) < LOAD_RADIUS_M) {
        pending.push(this.instantiate(entry));
      }
    }
    await Promise.allSettled(pending);
  }

  private distTo(entry: StreamEntry, focus: Vector3): number {
    const d = entry.descriptor;
    if (!d) return Infinity;
    return Math.hypot(focus.x - d.centerWorld[0], focus.z - d.centerWorld[2]);
  }

  private scan(focus: Vector3): void {
    // 卸载巡查必须覆盖全部条目:扫描圈=预取半径 < 卸载半径,
    // 只遍历候选区域会漏掉已远离的岛屿,已装载资源永不释放。
    // 同理,远离扫描圈的在途请求回收为 idle,把并发名额让给就近区域;
    // 服务端按键合并作业,重新进入范围后重发不会重复生成。
    // 注意:requested 条目还没有描述符,distTo 会返回 Infinity,
    // 必须用契约中心近似距离,否则会误回收就近请求并陷入重发循环。
    for (const entry of this.entries.values()) {
      if (entry.state === "loaded") {
        if (this.distTo(entry, focus) > UNLOAD_RADIUS_M) this.unload(entry);
      } else if (entry.state === "requested") {
        const [cx, , cz] = islandCenterWorld(this.worldSeed, entry.key);
        if (Math.hypot(focus.x - cx, focus.z - cz) > PREFETCH_RADIUS_M) entry.state = "idle";
      }
    }
    const idleCandidates: { entry: StreamEntry; dist: number }[] = [];
    for (const region of candidateRegions(focus, PREFETCH_RADIUS_M)) {
      if (isStarterRegion(region)) continue;
      for (const key of regionIslandKeys(this.worldSeed, region)) {
        const keyStr = islandKeyToString(key);
        const existing = this.entries.get(keyStr);
        const entry: StreamEntry = existing ?? {
          key, keyStr, state: "idle", pickups: [], failedAt: 0, pollAt: 0, loading: false,
        };
        if (!existing) this.entries.set(keyStr, entry);
        if (entry.state !== "idle") {
          const dist = this.distTo(entry, focus);
          if (entry.state === "ready" && dist < LOAD_RADIUS_M) {
            void this.instantiate(entry);
          } else if (entry.state === "failed" && performance.now() - entry.failedAt > RETRY_AFTER_MS) {
            entry.state = "idle";
          }
          continue;
        }
        // idle:描述符未知,用契约中心近似距离收集候选(就近限流请求)
        const [cx, , cz] = islandCenterWorld(this.worldSeed, key);
        idleCandidates.push({ entry, dist: Math.hypot(focus.x - cx, focus.z - cz) });
      }
    }
    if (!idleCandidates.length) return;
    let inflight = 0;
    for (const e of this.entries.values()) if (e.state === "requested") inflight++;
    idleCandidates.sort((a, b) => a.dist - b.dist);
    for (const { entry, dist } of idleCandidates) {
      if (inflight >= MAX_INFLIGHT_REQUESTS) break;
      if (dist >= PREFETCH_RADIUS_M) continue;
      this.request(entry);
      inflight++;
    }
  }

  private request(entry: StreamEntry): void {
    const { key } = entry;
    entry.state = "requested";
    entry.pollAt = performance.now() + 1200;
    void this.fetchStatus(key)
      .then((d) => {
        // 首查即带排队信息;缓存已就绪的岛直接转 ready,省一轮轮询(验收 D4)。
        this.opts.onEvent?.("island_requested", { key: entry.keyStr, queueAhead: d.queueAhead ?? 0 });
        if (d.status === "ready" && d.descriptor) this.markReady(entry, d.descriptor);
        else if (d.status === "failed") this.fail(entry, d.error ?? "generation request failed");
      })
      .catch((e: unknown) => this.fail(entry, String(e)));
  }

  private async fetchStatus(key: IslandKey): Promise<{
    status: string; descriptor?: RuntimeLsicIsland["descriptor"]; error?: string; queueAhead?: number;
  }> {
    const focus = this.lastFocus ? `&fx=${Math.round(this.lastFocus.x)}&fz=${Math.round(this.lastFocus.z)}` : "";
    const q = `seed=${this.worldSeed}&rx=${key.region.x}&rz=${key.region.z}&idx=${key.index}${focus}`;
    const res = await fetch(`/api/world/island?${q}`);
    return res.json() as Promise<{ status: string; descriptor?: RuntimeLsicIsland["descriptor"]; error?: string; queueAhead?: number }>;
  }

  private async pollPending(): Promise<void> {
    const now = performance.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.state === "requested" && now >= entry.pollAt) {
        await this.pollEntry(entry);
      }
    }
  }

  private async pollEntry(entry: StreamEntry, immediate = false): Promise<void> {
    try {
      const d = await this.fetchStatus(entry.key);
      if (d.status === "ready" && d.descriptor) {
        this.markReady(entry, d.descriptor);
        return;
      }
      if (d.status === "failed") {
        this.fail(entry, d.error ?? "generation failed");
        return;
      }
      entry.pollAt = performance.now() + (immediate ? 1500 : POLL_INTERVAL_MS);
    } catch {
      entry.pollAt = performance.now() + POLL_INTERVAL_MS;
    }
  }

  private markReady(entry: StreamEntry, descriptor: RuntimeLsicIsland["descriptor"]): void {
    entry.state = "ready";
    entry.descriptor = descriptor;
    this.opts.onEvent?.("island_ready", { key: entry.keyStr });
  }

  private fail(entry: StreamEntry, message: string): void {
    entry.state = "failed";
    entry.error = message;
    entry.failedAt = performance.now();
    this.opts.onToast(`空岛生成失败(${entry.keyStr}):${message}`, 6);
  }

  private async instantiate(entry: StreamEntry): Promise<void> {
    if (entry.loading || !entry.descriptor) return;
    entry.loading = true;
    try {
      const island = await createLsicRuntimeIsland(this.opts.scene, entry.descriptor, this.opts.shadowAdd);
      entry.island = island;
      this.opts.world.islands.push(island);
      this.opts.world.docks.push({
        islandId: entry.keyStr, name: `${island.def.name} 泊位`,
        pos: island.dock.pos.clone(), rotY: island.dock.rotY,
      });
      await this.spawnPickups(entry, island);
      this.applyMutation(entry);
      entry.state = "loaded";
      this.opts.onEvent?.("island_loaded", { key: entry.keyStr, name: island.def.name });
    } catch (e) {
      this.fail(entry, `load failed: ${String(e).slice(0, 160)}`);
    } finally {
      entry.loading = false;
    }
  }

  /** 资源拾取物:位置与物品种类由 resources 流确定性派生;实体 ID 稳定可存档。 */
  private async spawnPickups(entry: StreamEntry, island: RuntimeLsicIsland): Promise<void> {
    const rng = rngFromSeed(islandSeed(this.worldSeed, entry.key, "resources"));
    const count = 3 + Math.floor(rng() * 3);
    const recipe = entry.descriptor?.recipe ?? "forest";
    const root = island.root.position;
    const collected = this.mutations.get(entry.keyStr)?.collected ?? [];
    for (let i = 0; i < count; i++) {
      const ang = rng() * Math.PI * 2;
      const rr = (0.25 + rng() * 0.5) * island.descriptor.radius;
      const lx = root.x + Math.cos(ang) * rr;
      const lz = root.z + Math.sin(ang) * rr;
      const roll = rng();
      // 森林:云菇为主少量风晶;峡谷:风晶为主;遗迹:浮石为主
      const item = recipe === "canyon" ? (roll < 0.75 ? "windcrystal" : "floatstone")
        : recipe === "ruins" ? (roll < 0.7 ? "floatstone" : "windcrystal")
        : (roll < 0.75 ? "cloudmushroom" : "windcrystal");
      if (!island.canWalkAt || !island.canWalkAt(lx, lz)) continue;
      const y = island.heightAt(lx, lz);
      if (y === null) continue;
      const uid = `pk:${entry.keyStr}:${i}`;
      const mesh = await this.makePickupMesh(item, uid);
      const pos = new Vector3(lx, y + (item === "cloudmushroom" ? 0.12 : 0.55), lz);
      mesh.position.copyFrom(pos);
      const def: PickupDef = {
        uid, item: item as PickupDef["item"], count: 1, pos, mesh,
        taken: collected.includes(uid),
      };
      if (def.taken) mesh.setEnabled(false);
      entry.pickups.push(def);
      this.opts.world.pickups.push(def);
      this.opts.registerPickup(def);
    }
  }

  private async makePickupMesh(item: string, uid: string): Promise<Mesh> {
    let proto = this.pickupProtos.get(item);
    if (!proto) {
      const model = await loadEnvModel(this.opts.scene, PICKUP_MODEL[item] ?? PICKUP_MODEL.cloudmushroom);
      proto = model.mesh.clone(`proto_${item}`);
      proto.isVisible = false;
      this.pickupProtos.set(item, proto);
    }
    const m = proto.clone(`pickup_${uid.replaceAll(":", "_").replaceAll("/", "_")}`);
    m.isVisible = true;
    m.isPickable = false;
    m.scaling.setAll(0.9);
    this.opts.shadowAdd(m);
    return m;
  }

  private applyMutation(entry: StreamEntry): void {
    const m = this.mutations.get(entry.keyStr);
    if (!m) return;
    for (const p of entry.pickups) {
      if (m.collected.includes(p.uid)) { p.taken = true; p.mesh.setEnabled(false); }
    }
    // 建筑/宝箱恢复随配方扩展(G3/V 系列)接入
  }

  private writeMutation(entry: StreamEntry): void {
    const m = this.mutations.get(entry.keyStr) ?? {
      island: entry.keyStr, collected: [], chests: {}, buildings: [],
    };
    m.collected = [...new Set([...m.collected, ...entry.pickups.filter((p) => p.taken).map((p) => p.uid)])];
    this.mutations.set(entry.keyStr, m);
  }

  private unload(entry: StreamEntry): void {
    this.writeMutation(entry);
    const world = this.opts.world;
    if (entry.island) {
      const island = entry.island;
      const idx = world.islands.indexOf(island);
      if (idx >= 0) world.islands.splice(idx, 1);
      const dockIdx = world.docks.findIndex((d) => d.islandId === entry.keyStr);
      if (dockIdx >= 0) world.docks.splice(dockIdx, 1);
      island.dispose();
      entry.island = undefined;
    }
    for (const p of entry.pickups) {
      const idx = world.pickups.indexOf(p);
      if (idx >= 0) world.pickups.splice(idx, 1);
      p.mesh.dispose();
    }
    entry.pickups = [];
    entry.gangway?.dispose();
    entry.gangway = undefined;
    entry.state = "ready";
    this.opts.onEvent?.("island_unloaded", { key: entry.keyStr });
  }

  /** 云舟停泊到该岛时搭建接岸栈道;离泊拆除。 */
  onShipDocked(islandId: string, ship: CloudShip): void {
    const entry = this.entries.get(islandId);
    if (!entry?.island) return;
    entry.gangway?.dispose();
    entry.gangway = createDockGangway(this.opts.scene, entry.island, ship);
  }

  onShipUndocked(islandId: string): void {
    const entry = this.entries.get(islandId);
    if (!entry) return;
    entry.gangway?.dispose();
    entry.gangway = undefined;
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.state === "loaded") this.unload(entry);
    }
    this.entries.clear();
  }
}

/** 岸端到已停泊云舟甲板的可走栈道(与家园同做法,供运行时岛复用)。 */
function createDockGangway(scene: Scene, island: RuntimeLsicIsland, ship: CloudShip): { mesh: Mesh; dispose: () => void } {
  const dockPos = island.dock.pos;
  const toCenter = new Vector3(island.root.position.x - dockPos.x, 0, island.root.position.z - dockPos.z);
  const inland = toCenter.lengthSquared() > 0.001 ? toCenter.normalize().scale(2.2) : new Vector3(2.2, 0, 0);
  const sx = dockPos.x + inland.x, sz = dockPos.z + inland.z;
  const shoreY = island.heightAt(sx, sz) ?? dockPos.y;
  const shore = new Vector3(sx, shoreY, sz);
  const deck = ship.deckBoardPos();
  deck.y = ship.pos.y + 0.38;
  const dx = deck.x - shore.x, dz = deck.z - shore.z;
  const length = Math.max(1, Math.hypot(dx, dz));
  const pitch = Math.atan2(deck.y - shore.y, length);
  const ramp = MeshBuilder.CreateBox("runtimeGangway", { width: 2.4, height: 0.24, depth: length }, scene);
  ramp.position.set((shore.x + deck.x) / 2, (shore.y + deck.y) / 2 - Math.cos(pitch) * 0.12, (shore.z + deck.z) / 2);
  ramp.rotation.y = Math.atan2(dx, dz);
  ramp.rotation.x = -pitch;
  ramp.isVisible = false;
  ramp.isPickable = true;
  const body = new PhysicsAggregate(ramp, PhysicsShapeType.BOX, { mass: 0, friction: 0.9 }, scene);
  body.body.setMotionType(PhysicsMotionType.STATIC);
  return { mesh: ramp, dispose: () => { body.dispose(); ramp.dispose(); } };
}
