# Foundation 组件入口

开发页为 `/foundation.html`。它与未来业务共用本目录导出，且不读取 IndexedDB、云端 API 或主游戏状态。

- `terrain.ts`：`createIslandSampler(seed)` 以全局 `x/z` 采样；`sampleEdge()` 仅用于验证相邻分区的同坐标边界。后续可由 `world/island.ts` 的新配方调用，不改既有配方。
- `navigation.ts`：`await createFoundationNavigation(meshes)` 构造一个岛的 Recast 网格；调用 `path(start, end)`，断开目标得到 `[]`；完成后必须 `dispose()`。仅面向局部岛，未处理建造动态障碍。
- `behavior.ts`：`createFoundationBehavior(target)` 使用 Yuka `Vehicle`、`EntityManager` 和 `ArriveBehavior`；每帧 `tick(seconds)`，暂停用 `setPaused(true)`，离开时 `dispose()`。它不是 NPC 决策策略或完整动物群集。
- `physics.ts`：调用方先在独立 Scene 启用 Havok，再调用 `createFoundationPhysics(scene)`；结果含 `PhysicsCharacterController`、运动学平台、`FlyCamera`、吸附步长 0.5m 的独立建造预览体和原生 `GizmoManager`。它仅是角色/平台/编辑预览基础，不是云舟飞行。

Recast 由已安装的 `@recast-navigation/*` 模块在 Vite 构建时带入本地资源；入口没有运行时 CDN。所有由本目录创建的导航与场景辅助组件都由各自返回值的 `dispose()` 释放。
