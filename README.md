# 云海群岛 Cloud Isles

探索、创造与共建家园 —— 群核 Aholo 全球 3D AI 黑客松参赛作品源码。

一个桌面单人的三维空岛冒险：在云海之上的家园空岛里建造、种植、点亮提灯；带上风刃长剑，驾驶飞舟穿过云层去探索远岛、采集风晶、把收获带回家园。配套 150 秒参赛影片《我想要一个世界》。

## 核心玩法

- **家园建造**：放置 / 移动 / 拆除，设施交互（坐下、点亮），库存与资源真实消耗，保存 / 重载后世界完整保留
- **云海探索**：飞舟掌舵远航、滑翔登岛、近战战斗、采集风晶
- **生成物在役**：游戏内关键物品由 **Aholo Lux3D 文生 3D** 生成并直接进入玩法链
- **居民协作**：划定区域与材料预算，NPC 村民在授权范围内自主添置，结果入档

## 运行

环境要求：Node.js ≥ 20（npm workspaces），磁盘约 1 GB（含 node_modules）。**无需任何 API 密钥**。

```bash
cd game
npm install          # workspace 安装 shared / server / client 依赖
npm run start -w server   # 或 cd server && npm start
# 浏览器打开 http://localhost:8787（端口可用环境变量 PORT 覆盖）
```

开发模式：

```bash
npm run dev:client   # Vite 开发服务（5173）
npm run dev:server   # 服务端（8787）
npm test             # vitest
npm run check        # 三包 TypeScript 类型检查
npm run build        # 生产构建（client/dist）
```

- 存档：SQLite 本地落盘，`SAVE_DB_PATH` 可指定文件；未设置时使用 `server/cloud-isles.sqlite`
- 生产部署：`npm run build` 后由服务端静态托管 `client/dist`

## 群核技术栈使用

游戏内四件关键物品均由 **Aholo Lux3D 文生 3D** 管线从文字描述生成（GLB），任务记录完整保留，不经造型修改直接接入游戏：

| 资产 | 任务 ID | 玩法用途 |
| --- | --- | --- |
| 风刃长剑 | 4539057 | 武器：获得 → 装备 → 挥砍攻击 |
| 云木座椅 | 4539058 | 家具：建造目录 → 摆放 → 按 E 坐下 |
| 贝壳提灯 | 4724898 | 光源设施：摆放 → 点亮家园 |
| 青铜云灯 | 4539201 | 光源设施：消耗风晶放置、夜间发光 |

其他平台能力使用记录：游戏内运行时文生 3D 链路（任务 4722386：玩家请求 → 服务端调用 Lux3D → 产物自动注册建造目录 → 实机摆放）、Aholo 多模态概念图（4539322、4663264）、四视图＋图生 3D（4663492＋4664288）、Aholo 3DGS 世界生成（worldId `3FO4K4RIU9XB`）、Aholo Viewer（`@manycore/aholo-viewer`）渲染验证页（`client/aholo-viewer.html`）。岛屿地形来自群核生态 LSIC 岛屿资产（岛 3112695541）。

可选配置（均不影响默认体验）：

- `NPC_LLM_BASE_URL / NPC_LLM_API_KEY / NPC_LLM_MODEL`：接入任意 OpenAI 兼容模型驱动 NPC 决策与对话；未配置时使用本地行为引擎
- `LUX3D_API_KEY`：启用游戏内运行时文生 3D；未配置时自动使用目录替代件

## 目录结构

```
game/
├── client/    # Babylon.js 9.33 + Havok Physics 渲染与玩法（Vite + TypeScript）
│   ├── src/       # 世界、建造、NPC、航行、存档等模块
│   ├── tests/     # vitest 测试
│   └── public/    # 游戏资产（含 Lux3D 生成 GLB、LSIC 地形、角色与场景资产）
├── server/    # Fastify 5 服务端：存档、世界生成、NPC 接口、Lux3D 生成代理
├── shared/    # 三端共享契约与本地决策引擎（单一来源）
├── scripts/   # 交付校验、LLM 联调 mock
└── content/   # 游戏内容数据
```

## 素材来源与授权

- 玩家角色 VRM（Ruike）：CC BY 4.0（已改编），详见 `client/public/assets/chars/ATTRIBUTION.md`
- 场景部件：Babylon.js Assets，CC BY 4.0（改编）
- 岛屿地形：群核生态 LSIC 岛屿资产
- 核心物品模型：Aholo Lux3D 文生 3D 生成（任务 ID 见上表）
- 其余素材来源与授权见项目材料 SOURCES 登记

## 诚实边界

- NPC 默认为本地行为引擎（处境 → 意图 → 行动 → 记忆的规则系统）；LLM 流程为可选配置，不作默认功能主张
- 本仓库为参赛版本源码；历史验证中未进入当前版本的能力（运行时 LLM 决策实测、无限岛屿生成原型等）保留在项目验证记录中，不在本仓库主张范围内

## License

源码以 [MIT License](LICENSE) 发布。第三方资产遵循其各自授权（见上节），不随 MIT 许可一并授权。
