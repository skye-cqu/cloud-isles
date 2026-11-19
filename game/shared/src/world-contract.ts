// 世界生成契约：种子/区域/岛屿标识、派生随机流、缓存地址与锚点。
// 客户端、Node 生成服务与 Python 侧配方共享同一套规则；改动语义必须 bump RECIPE_VERSION。
// 世界空间单位为米；区域为二维带高度的云海分区，岛屿使用各自局部坐标。

/** 配方版本：岛屿几何/布置派生规则变化时递增；缓存键与旧世界固定版本依赖它。 */
export const RECIPE_VERSION = "w2-2";

/** 区域边长（米）。家园所在区域 (0,0) 固定；其余区域按需生成。 */
export const REGION_SIZE_M = 640;

/** 家园岛固定在世界原点区域，不受区域生成影响。 */
export const HOME_REGION: RegionKey = { x: 0, z: 0 };
export const HOME_ISLAND_INDEX = 0;

export type RecipeId = "forest" | "canyon" | "ruins";

export interface RegionKey { x: number; z: number }
export interface IslandKey { region: RegionKey; index: number }

/** 派生流：岛形/植被/资源各自独立，新增装饰流不得改变既有资源身份。 */
export type SeedStream = "shape" | "flora" | "resources" | "layout";

/** FNV-1a 32 位稳定哈希。跨进程/跨语言实现须逐字节一致（Python 侧同字符串编码 UTF-8）。 */
export function stableHash(parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = typeof part === "number" ? part.toString(10) : part;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f; // 部件分隔，避免 ("a","bc") 与 ("ab","c") 哈希相同
  }
  return h >>> 0;
}

/** 岛屿派生种子。禁止 Math.random、共享顺序随机流或语言内置 hash。 */
export function islandSeed(worldSeed: number, key: IslandKey, stream: SeedStream): number {
  return stableHash([worldSeed, RECIPE_VERSION, key.region.x, key.region.z, key.index, stream]);
}

/** 世界坐标 → 区域键。Math.floor 对负坐标向负无穷取整，是本契约要求的语义。 */
export function regionOf(worldX: number, worldZ: number): RegionKey {
  return {
    x: Math.floor(worldX / REGION_SIZE_M),
    z: Math.floor(worldZ / REGION_SIZE_M),
  };
}

export function regionCenter(region: RegionKey): [number, number] {
  return [(region.x + 0.5) * REGION_SIZE_M, (region.z + 0.5) * REGION_SIZE_M];
}

export function regionKeyToString(region: RegionKey): string {
  return `r${region.x}_${region.z}`;
}

export function islandKeyToString(key: IslandKey): string {
  return `${regionKeyToString(key.region)}/i${key.index}`;
}

/** 运行时缓存相对地址（POSIX 分隔，供 Node/Python 拼接项目缓存根）。 */
export function islandCacheDir(worldSeed: number, key: IslandKey): string {
  return `assets/lsic/runtime-cache/${RECIPE_VERSION}/${worldSeed}/${regionKeyToString(key.region)}/${key.index}`;
}

export interface IslandAddresses {
  /** 导出 GLB（地形+静态道具；碰撞由 surface 代理） */
  model: string;
  /** 表面数据：高度采样网格 + 通行/坡度标记 */
  surface: string;
  /** 锚点：出生/泊位/导航目标/建造面 */
  anchors: string;
}

export function islandAddresses(worldSeed: number, key: IslandKey): IslandAddresses {
  const dir = islandCacheDir(worldSeed, key);
  return { model: `${dir}/island.glb`, surface: `${dir}/surface.json`, anchors: `${dir}/anchors.json` };
}

/** 岛屿局部坐标（米）锚点。源坐标→游戏米的变换由生成侧统一应用后写入。 */
export interface IslandAnchors {
  /** 默认登岛点 */
  spawn: [number, number, number];
  /** 泊位接岸点（世界侧由船的停靠逻辑消费） */
  dock?: [number, number, number];
  /** NPC/任务可用导航目标 */
  nav: [number, number, number][];
  /** 允许玩家建造的面（局部圆盘或多边形顶点，米） */
  buildZone?: { center: [number, number]; radius: number };
}

/** 生成服务交付给客户端的岛屿描述（服务端权威，客户端不自行发明）。 */
export interface IslandDescriptor {
  key: IslandKey;
  recipe: RecipeId | "home";
  /** 世界坐标中心与包围半径（米），供加载/卸载与雾外剔除 */
  centerWorld: [number, number, number];
  radius: number;
  addresses: IslandAddresses;
  anchors: IslandAnchors;
  /** 生成该岛的工具与配方记录（可复现性审计） */
  provenance: { tool: string; recipeName: string; seed: number };
}

/** 岛屿增量状态：卸载保存、回访恢复；与基础世界（seed+版本）分离。 */
export interface IslandMutation {
  island: string;
  /** 已采集/已消耗实体 ID（不随卸载重置） */
  collected: string[];
  chests: Record<string, boolean>;
  buildings: { uid: string; partId: string; pos: [number, number, number]; rotY: number }[];
}

// ---------- 区域布局：客户端、Node 服务与 Python 生成器三方一致的确定性规则 ----------

/** 默认世界种子；存档可携带自己的 worldSeed 覆盖。 */
export const DEFAULT_WORLD_SEED = 20261105;

/** 起始区域：已有人工设计内容（家园、风峡双峰、遗迹、两座小屿），运行时生成不覆盖。 */
const STARTER_REGION_KEYS = ["r0_0", "r-1_0", "r0_-1", "r-1_-1"];

export function isStarterRegion(region: RegionKey): boolean {
  return STARTER_REGION_KEYS.includes(regionKeyToString(region));
}

/** xorshift32，与 client core/rng.ts makeRng 同算法；Python 侧镜像实现（32 位掩码）。 */
export function rngFromSeed(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= (s << 13) >>> 0;
    s >>>= 0;
    s ^= s >> 17;
    s ^= (s << 5) >>> 0;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** 每区域一座主岛；中心抖动保证相邻区域岛屿间距 ≥ 640-2*(120+70) 米。 */
export const ISLAND_CENTER_JITTER_M = 120;

/** 悬浮高度小幅变化（米）：整岛连同地表一起偏移，锚点为绝对高度不受影响。 */
export function islandAltitude(worldSeed: number, key: IslandKey): number {
  const rng = rngFromSeed(islandSeed(worldSeed, key, "layout"));
  return Math.round((rng() - 0.5) * 8 * 10) / 10;
}

/** 区域内岛屿布局。当前每区域固定 1 座主岛（index 0）；区域为空时返回 []。 */
export function regionIslandKeys(_worldSeed: number, region: RegionKey): IslandKey[] {
  return [{ region, index: 0 }];
}

/** 岛屿世界中心 [x, y, z]。y 为悬浮高度偏移；地形内容自身高度含在表面数据内。 */
export function islandCenterWorld(worldSeed: number, key: IslandKey): [number, number, number] {
  const rng = rngFromSeed(islandSeed(worldSeed, key, "layout"));
  const [cx, cz] = regionCenter(key.region);
  const a = rng() * Math.PI * 2;
  const r = rng() * ISLAND_CENTER_JITTER_M;
  return [Math.round(cx + Math.cos(a) * r), islandAltitude(worldSeed, key), Math.round(cz + Math.sin(a) * r)];
}

/**
 * 区域配方分配（稳定）：森林常见、峡谷次之、遗迹稀有。
 * 由 resources 流确定性派生；Python 生成器镜像同一权重表。
 * 新增配方实现后加入此表并 bump RECIPE_VERSION。
 */
const RECIPE_WEIGHTS: ReadonlyArray<readonly [number, RecipeId]> = [
  [0.58, "forest"],
  [0.83, "canyon"],
  [1, "ruins"],
];

export function recipeForIsland(worldSeed: number, key: IslandKey): RecipeId {
  const v = islandSeed(worldSeed, key, "resources") / 2 ** 32;
  for (const [threshold, recipe] of RECIPE_WEIGHTS) {
    if (v < threshold) return recipe;
  }
  return "forest";
}

/** 运行时缓存的 HTTP 地址（服务端把缓存根挂载在 /world-assets）。 */
export function islandUrlPaths(worldSeed: number, key: IslandKey): IslandAddresses {
  const dir = `${RECIPE_VERSION}/${worldSeed}/${regionKeyToString(key.region)}/${key.index}`;
  return {
    model: `world-assets/${dir}/island.glb`,
    surface: `world-assets/${dir}/surface.json`,
    anchors: `world-assets/${dir}/anchors.json`,
  };
}
