// 交付包完整性校验：核对 README 声明与运行依赖的文件是否齐全、与仓库源一致。
// 背景：20261106 交付验收发现 D1/D2——组装时 tools/ 与 .agents/skills/lux3d-cn/ 漏文件
//（lux3d_client.py 启动即读同目录 animation_ids.json；lsic_world_gen.py 依赖同目录两个模块）。
// 用法：node scripts/verify-delivery.mjs <交付包根目录>
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const deliveryRoot = resolve(process.argv[2] ?? "");

if (!deliveryRoot || !existsSync(deliveryRoot)) {
  console.error("用法: node scripts/verify-delivery.mjs <交付包根目录>");
  process.exit(2);
}

// 相对路径 → 仓库内对应源文件（null 表示仅在交付包校验存在）。
const manifest = {
  "README.md": "README 交付说明",
  "tools/lsic_world_gen.py": "README:67/74 声明的生成脚本（world-gen.ts spawn）",
  "tools/lsic_world_home.py": "lsic_world_gen.py import 依赖",
  "tools/lsic_world_home_glbpkg.py": "lsic_world_gen.py import 依赖",
  ".agents/skills/lux3d-cn/lux3d_client.py": "README:75（server index.ts:377 调用）",
  ".agents/skills/lux3d-cn/animation_ids.json": "lux3d_client.py:58 模块级读取",
  ".agents/skills/lux3d-cn/_meta.json": "官方技能元数据",
  ".agents/skills/lux3d-cn/SKILL.md": "官方技能文档",
  "game/package.json": "workspaces 根",
  "game/client/dist/index.html": "生产构建入口",
  "licenses/fox-model.md": "Fox 模型署名",
};

const repoSide = {
  "tools/lsic_world_gen.py": "tools/lsic_world_gen.py",
  "tools/lsic_world_home.py": "tools/lsic_world_home.py",
  "tools/lsic_world_home_glbpkg.py": "tools/lsic_world_home_glbpkg.py",
  ".agents/skills/lux3d-cn/lux3d_client.py": ".agents/skills/lux3d-cn/lux3d_client.py",
  ".agents/skills/lux3d-cn/animation_ids.json": ".agents/skills/lux3d-cn/animation_ids.json",
  ".agents/skills/lux3d-cn/_meta.json": ".agents/skills/lux3d-cn/_meta.json",
  ".agents/skills/lux3d-cn/SKILL.md": ".agents/skills/lux3d-cn/SKILL.md",
};

const md5 = (p) => createHash("md5").update(readFileSync(p)).digest("hex");

let failed = 0;
for (const [rel, why] of Object.entries(manifest)) {
  const p = join(deliveryRoot, rel);
  if (!existsSync(p)) {
    console.error(`FAIL 缺失 ${rel} —— ${why}`);
    failed++;
    continue;
  }
  const src = repoSide[rel] && join(repoRoot, repoSide[rel]);
  if (src && existsSync(src) && md5(p) !== md5(src)) {
    console.error(`FAIL 内容与仓库不一致 ${rel}`);
    failed++;
    continue;
  }
  console.log(`ok ${rel}`);
}

// 运行时岛屿缓存：README:66 声明 86 区域 × 每岛 4 文件。
const cacheRoot = join(deliveryRoot, "assets", "lsic", "runtime-cache", "w2-2");
if (!existsSync(cacheRoot)) {
  console.error(`FAIL 缺失 runtime-cache w2-2`);
  failed++;
} else {
  const regions = new Set();
  let islands = 0;
  for (const batch of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!batch.isDirectory()) continue;
    for (const region of readdirSync(join(cacheRoot, batch.name), { withFileTypes: true })) {
      if (!region.isDirectory()) continue;
      regions.add(region.name);
      for (const idx of readdirSync(join(cacheRoot, batch.name, region.name), { withFileTypes: true })) {
        if (!idx.isDirectory()) continue;
        islands++;
        for (const f of ["island.glb", "surface.json", "anchors.json", "descriptor.json"]) {
          if (!existsSync(join(cacheRoot, batch.name, region.name, idx.name, f))) {
            console.error(`FAIL 岛屿文件缺失 ${batch.name}/${region.name}/${idx.name}/${f}`);
            failed++;
          }
        }
      }
    }
  }
  console.log(`ok runtime-cache w2-2: ${regions.size} 区域 / ${islands} 座岛（README 声明 86 区域）`);
  if (regions.size < 86) {
    console.error(`FAIL 区域数 ${regions.size} < 86`);
    failed++;
  }
}

console.log(failed ? `\n${failed} 项不通过` : "\n交付完整性校验通过");
process.exit(failed ? 1 : 0);
