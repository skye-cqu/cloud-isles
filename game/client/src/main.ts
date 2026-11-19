// 云屿之歌 — 主装配与游戏循环。
import {
  Engine, Scene, Vector3, Color3, Color4, HavokPlugin, UniversalCamera,
  ShadowGenerator, DirectionalLight, GaussianSplattingMesh, TransformNode, StandardMaterial, MeshBuilder, PointLight, Mesh,
  ImageProcessingConfiguration,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import "@babylonjs/loaders/SPLAT";
import HavokPhysics from "@babylonjs/havok";
import { Input } from "./core/input";
import { FreeFlyCamera } from "./core/freeFly";
import { Hud, setEngineSize } from "./core/ui";
import { createSky, createCloudSea } from "./world/sky";
import { configureSceneShadows, setupLighting } from "./world/lighting";
import { createDayEnvironment } from "./world/dayCycle";
import { homeRespawnState, isLegacyHomeDockedShip, needsHomeLsicV1Migration, recoverHomeWalkPosition, type LsicHomeIsland } from "./world/lsicHome";
import { buildWorld, swapChestOpen, SEA_LEVEL, World } from "./world/world";
import { Player } from "./world/player";
import { CloudShip } from "./world/ship";
import { Inventory } from "./gameplay/items";
import { InteractSystem, FarmPlot } from "./gameplay/interact";
import { BuildSystem } from "./gameplay/build";
import { CreateSystem } from "./gameplay/create";
import { ProjectsSystem } from "./gameplay/projects";
import { PetSystem } from "./gameplay/pet";
import { CompanionSystem } from "./gameplay/companion";
import { AudioSystem } from "./gameplay/audio";
import { CombatSystem } from "./gameplay/combat";
import { QuestSystem } from "./gameplay/quests";
import { NpcActor, NpcPersona } from "./gameplay/npc/npc";
import { NpcSituation, ItemId, SaveData, BUILD_CATALOG, ITEMS, RECIPES, cookRecipe, DEFAULT_WORLD_SEED, validateCatalog, BRANCHES, FORGE_UNLOCK_COST, canPropose, type BranchId } from "shared";
import { exportSaveJson, getLastSaveIssue, hasSave, importSaveJson, loadGame, saveGame } from "./core/save";
import { knownCloudWorlds, listCloudBackups, npcRequestMeta, restoreCloudBackup, setNpcWorldContext, syncBackup } from "./core/cloudSync";
import { loadItemModel } from "./assets/itemModels";
import { IslandStreamer } from "./world/streaming";
import { decorateHome, addBerthFlag, homeAnchor } from "./world/homeProps";

declare global {
  interface Window { game?: Game }
}

class Game {
  dayEnvironment!: ReturnType<typeof createDayEnvironment>;
  engine!: Engine;
  scene!: Scene;
  input!: Input;
  hud!: Hud;
  camera!: UniversalCamera;
  freeFly!: FreeFlyCamera;
  world!: World;
  player!: Player;
  inv = new Inventory();
  interact!: InteractSystem;
  build!: BuildSystem;
  create!: CreateSystem;
  audio = new AudioSystem();
  combat!: CombatSystem;
  quests!: QuestSystem;
  projects!: ProjectsSystem;
  pet!: PetSystem;
  companion!: CompanionSystem;
  /** 本次出航的远征操作 ID 与停靠记录（归航结算用） */
  journeyOpId: string | null = null;
  journeyDocks: string[] = [];
  private chargeCd = 0;
  private obsArrow: Mesh | null = null;
  npcs: NpcActor[] = [];
  shadows!: ShadowGenerator;
  cloudSea!: ReturnType<typeof createCloudSea>;
  streamer!: IslandStreamer;
  berthFlag: Mesh | null = null;
  worldSeed = DEFAULT_WORLD_SEED;
  worldId: string = crypto.randomUUID();
  playSeconds = 0;
  saveTimer = 0;
  llmAvailable = false;
  lastSituation: NpcSituation | null = null;
  private started = false;
  heartbeatFailed = false;
  frameDeltaMs = 16.6;
  private lastFrameAt = 0;
  private prevFrameTs2 = 0;
  private farmGardenerTick = 0;
  private hungervt = 0;
  private fpsSamples: number[] = [];
  private spzNode: GaussianSplattingMesh | null = null;

  async boot() {
    // 内容目录引用完整性：悬空引用直接阻断启动（数据错误不该等到运行时才暴露）
    const catalogProblems = validateCatalog();
    if (catalogProblems.length) {
      throw new Error(`内容目录校验失败:\n${catalogProblems.join("\n")}`);
    }
    const canvas = document.createElement("canvas");
    document.getElementById("app")!.appendChild(canvas);
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: false, antialias: true });
    setEngineSize(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.55, 0.72, 0.85, 1);
    this.scene.fogMode = 1; // EXP
    this.scene.fogDensity = 0.0011;
    this.scene.fogColor = new Color3(0.82, 0.86, 0.9);
    // 暖晨光画感：ACES 色调映射 + 轻提曝光对比
    this.scene.imageProcessingConfiguration.toneMappingEnabled = true;
    this.scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    this.scene.imageProcessingConfiguration.exposure = 1.25;
    this.scene.imageProcessingConfiguration.contrast = 1.08;

    this.camera = new UniversalCamera("cam", new Vector3(0, 12, 18), this.scene);
    this.camera.minZ = 0.3;
    this.camera.maxZ = 6000;
    this.camera.fov = 0.95;
    this.scene.activeCamera = this.camera;

    this.input = new Input(canvas);
    this.freeFly = new FreeFlyCamera(this.camera, this.input);
    // 点击画面进入指针锁定（对话/面板打开时不锁，见 updateKeys 释放）
    canvas.addEventListener("pointerdown", () => {
      this.audio.resume();
      if (this.started && !this.hud.dialogVisible() && !this.hud.panelVisible() && !document.pointerLockElement) {
        this.input.requestPointerLock();
      }
    });
    window.addEventListener("keydown", () => this.audio.resume(), { once: true });
    this.hud = new Hud(document.body);
    this.hud.onBuildSelect = (partId) => {
      this.hud.hidePanel();
      this.build.enterPlaceMode(partId);
    };

    createSky(this.scene, { add: () => {} });
    this.cloudSea = createCloudSea(this.scene);
    this.scene.fogColor = this.scene.fogColor;

    // Havok
    const havok = await HavokPhysics({ locateFile: () => "/havok/HavokPhysics.wasm" });
    const plugin = new HavokPlugin(true, havok);
    this.scene.enablePhysics(new Vector3(0, -17, 0), plugin);

    const sun = this.scene.getLightByName("sun") as DirectionalLight;
    setupLighting(this.scene, sun);
    this.shadows = new ShadowGenerator(2048, sun);
    this.dayEnvironment = createDayEnvironment(this.scene);
    this.dayEnvironment.update(0);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.darkness = 0.32;
    const shadowAdd = () => {};

    this.world = await buildWorld(this.scene, shadowAdd);
    // 云舟停泊/离泊事件此前未接线(ship_dock 死分支);现接入全局事件与流式器栈道
    this.world.ship.onEvent = (kind, data) => this.onGameEvent(kind, data);
    const home0 = this.world.islands[0];
    const homeIsland = home0 as LsicHomeIsland;
    // 家园视觉点缀（LSIC 低模道具散布 + 泊位旗标）
    decorateHome(this.scene, homeIsland, this.world.docks[0].pos);
    this.berthFlag = addBerthFlag(this.scene, this.world.docks[0].pos, (x, z) => home0.heightAt(x, z));
    const spawn = homeAnchor(homeIsland, "spawn");
    const spawnY = (home0.heightAt(spawn.x, spawn.z) ?? spawn.y) + 0.6;
    this.player = new Player({ scene: this.scene, input: this.input, camera: this.camera },
      new Vector3(spawn.x, spawnY, spawn.z));
    this.player.onEvent = (kind, data) => this.onGameEvent(kind, data);
    // 开局从出生点朝生活聚落与泊位方向取景；后续仅由玩家输入改变。
    this.player.camYaw = Math.PI;
    this.player.camPitch = 0.26;
    this.player.camDist = 8.5;
    configureSceneShadows(this.scene, this.shadows);

    this.interact = new InteractSystem(this.scene, this.world, this.inv, this.player);
    // 岛屿流式器:种子+区域驱动的生成请求/预取/卸载/回访(框架装配后逐帧 update)
    this.streamer = new IslandStreamer({
      scene: this.scene,
      world: this.world,
      shadowAdd: () => {},
      registerPickup: (p) => this.interact.registerPickup(p),
      onToast: (msg, dur) => this.hud.toast(msg, dur),
      onEvent: (kind, data) => this.onGameEvent(kind, data),
    });
    this.build = new BuildSystem(this.scene, this.world, this.inv, this.player);
    this.create = new CreateSystem(this.scene, this.world, this.build, this.hud, this.inv, this.player);
    this.create.onEvent = (kind, data) => {
      if (kind === "toast") { this.hud.toast(typeof data === "string" ? data : String(data)); return; }
      this.onGameEvent(kind, data);
    };
    // 交互/建造事件统一进 onGameEvent（拾取、开箱、收割、建造、提示）
    this.interact.onEvent = (kind, data) => {
      if (kind === "toast") { this.hud.toast(typeof data === "string" ? data : String(data)); return; }
      this.onGameEvent(kind, data);
    };
    this.build.onEvent = (kind, data) => {
      if (kind === "toast") { this.hud.toast(typeof data === "string" ? data : String(data)); return; }
      this.onGameEvent(kind, data);
    };
    this.combat = new CombatSystem(this.scene, this.player, this.inv);
    // 挥击 → 战斗判定（数值取当前武器）
    this.player.onAttack = (origin, dir) => {
      const w = ITEMS[(this.player.equipped ?? "windblade_sword") as ItemId]?.weapon;
      return this.combat.meleeAttack("player", origin, dir, w?.range ?? 2.6, w?.damage ?? 12);
    };
    this.quests = new QuestSystem(this.scene);

    // M4：持续项目 + 宠物 + 同行搭档
    this.projects = new ProjectsSystem(this.hud, this.inv, this.build, () => this.npcs);
    this.projects.onEvent = (kind, data) => { if (kind === "toast") { this.hud.toast(typeof data === "string" ? data : String(data)); return; } this.onGameEvent(kind, data); };
    this.pet = new PetSystem(this.scene, this.player, this.world, this.interact, this.inv, this.hud);
    this.pet.onEvent = (kind, data) => { if (kind === "toast") { this.hud.toast(typeof data === "string" ? data : String(data)); return; } this.onGameEvent(kind, data); };
    this.companion = new CompanionSystem(this.projects, this.player, this.world, this.combat, () => this.npcs.find((n) => n.persona.id === "yan") ?? null);
    this.companion.onEvent = (kind, data) => { if (kind === "toast") { this.hud.toast(typeof data === "string" ? data : String(data)); return; } this.onGameEvent(kind, data); };

    this.spawnNpcs();
    this.projects.attachFarmPlots(this.interact.farm);
    this.spawnWisps();
    void this.buildHomeBase();
    this.addFarmPlots();
    this.interact.addPickupInteractions();
    this.equipSwordVisual(null);

    void this.checkLlm();
    void this.loadLuxModels();
    void this.loadRuinsSplat();

    // 标题屏
    const save = await hasSave();
    // 已有存档时新开局会覆盖进度，先确认
    this.hud.showTitle(save, () => {
      if (!save || window.confirm("重新开始将覆盖当前存档，确定吗？")) this.startNew();
    }, () => this.startContinue(), async () => {
      try {
      const data = await loadGame();
      if (!data) return this.hud.titleStatus("没有可导出的有效本地存档。可选择云端副本恢复。");
      const blob = new Blob([exportSaveJson(data)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `cloud-isles-save-${data.savedAt}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      } catch { this.hud.titleStatus("本地存档读取失败，无法导出。可选择云端副本恢复。"); }
    }, (file) => {
      const reader = new FileReader();
      reader.onload = async () => {
        if (typeof reader.result !== "string" || !(await importSaveJson(reader.result))) return this.hud.titleStatus("导入失败：文件不兼容或本地写入失败，现有存档未改动。");
        window.location.reload();
      };
      reader.readAsText(file);
    }, async () => {
      try {
      // Local storage may be corrupt/unavailable. Its failure cannot hide known cloud worlds.
      try { const local = await loadGame(); if (local) npcRequestMeta(local); } catch { /* metadata remains usable */ }
      const worlds = knownCloudWorlds();
      if (!worlds.length) return this.hud.titleStatus("此浏览器没有已知的云端世界记录。");
      const choice = window.prompt(`选择云端世界，输入序号：\n${worlds.map((w, i) => `${i + 1}. ${w.worldId}（已知版本 ${w.version}）`).join("\n")}`, "1");
      if (choice === null) return;
      const cloudContext = worlds[Number(choice) - 1]?.worldId;
      if (!cloudContext) return this.hud.titleStatus("世界序号无效。");
      this.hud.titleStatus("正在读取云端版本……");
      const versions = await listCloudBackups(cloudContext);
      if (!versions.length) return this.hud.titleStatus("所选世界尚无云端副本。");
      const summary = versions.map((v) => `${v.version}${v.conflict ? "（冲突副本）" : ""} ${new Date(v.createdAt).toLocaleString()}`).join("\n");
      const input = window.prompt(`输入要恢复的云端版本。恢复会先覆盖本地存档：\n${summary}`, String(versions[0].version));
      const version = Number(input);
      if (input === null) return;
      if (!versions.some(v => v.version === version)) return this.hud.titleStatus("请选择列表中的版本。");
      if (!window.confirm(`确认以世界 ${cloudContext} 的版本 ${version} 覆盖本地存档？`)) return;
      const data = await restoreCloudBackup(version, cloudContext);
      if (!data) return this.hud.titleStatus("云端副本读取失败，本地存档未改动。");
      try { await saveGame(data); } catch {
        this.hud.titleStatus("恢复未成功：本地存档写入失败。可导出本次云端候选副本。");
        if (window.confirm("本地存档写入失败，是否下载云端候选副本？")) {
          const link = document.createElement("a");
          link.href = URL.createObjectURL(new Blob([exportSaveJson(data)], { type: "application/json" }));
          link.download = `cloud-isles-cloud-candidate-${data.savedAt}.json`; link.click(); URL.revokeObjectURL(link.href);
        }
        return;
      }
      window.location.reload();
      } catch (error) { console.warn("cloud restore failed", error); this.hud.titleStatus("云端副本读取失败，请检查网络后重试。本地存档未改动。"); }
    });
    if (getLastSaveIssue()) this.hud.titleStatus(getLastSaveIssue()!);
    window.game = this;
    // 前台：rAF 主循环。后台/遮挡窗口：rAF 被浏览器暂停，用 MessageChannel 宏任务自循环兜底
    // （历史坑：隐藏窗口 rAF 停摆、worker setInterval 也被节流）。lastFrameAt 由 frame() 自己刷新，
    // 否则后台时闸门永远为真、帧率跑到数百 fps。
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        if (performance.now() - this.lastFrameAt >= 40) this.frame();
        ch.port2.postMessage(0);
      };
      ch.port2.postMessage(0);
    } catch { this.heartbeatFailed = true; }
    // 引擎 getDeltaTime 依赖性能监视器，rAF 停摆时返回 0（会连带冻结物理步进）——用帧间实测覆盖。
    let prevFrameTs = 0;
    void prevFrameTs;
    this.engine.getDeltaTime = () => this.frameDeltaMs;
    this.engine.runRenderLoop(() => {
      this.frame();
    });
    window.addEventListener("resize", () => {
      this.engine.resize();
      setEngineSize(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    });
  }

  private async checkLlm() {
    try {
      const res = await fetch("/api/npc/health");
      if (res.ok) {
        const d = await res.json();
        this.llmAvailable = !!d.llm;
        this.hud.setWs(this.llmAvailable ? "NPC·LLM" : "NPC·本地引擎", this.llmAvailable);
      }
    } catch {
      this.hud.setWs("NPC·本地引擎", false);
    }
  }

  private async loadLuxModels() {
    try {
      const sword = await loadItemModel(this.scene, "lux3d/sword-windblade", 1.15);
      this.luxSwordReady = sword;
      await loadItemModel(this.scene, "lux3d/chair-cloudwood", 0.7);
      await loadItemModel(this.scene, "lux3d/lantern-cloud", 0.5);
      await loadItemModel(this.scene, "lux3d/stabilizer-berth", 2.4);
      this.build.modelReady.set("lux3d/chair-cloudwood", true);
      this.build.modelReady.set("lux3d/lantern-cloud", true);
      this.build.modelReady.set("lux3d/stabilizer-berth", true);
      this.hud.toast("家园工坊与泊位已准备好", 4);
    } catch (e) {
      console.warn("lux model load failed", e);
    }
  }
  luxSwordReady: Awaited<ReturnType<typeof loadItemModel>> | null = null;

  private async loadRuinsSplat() {
    // Aholo 3DGS 遗迹空间：当前遗迹已实体化为可探索场景（碰撞/路线/宝箱齐全），
    // SPZ 泛白问题未解决前默认关闭；资产保留，待室内重建方案验证后按 flag 启用。
    const ENABLE_SPZ = false;
    if (!ENABLE_SPZ) return;
    try {
      const res = await fetch("/assets/aholo/ruins.spz", { method: "HEAD" });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || ct.includes("text/html")) {
        console.warn("[splat] ruins.spz 未就绪，跳过加载");
        return;
      }
      const splat = new GaussianSplattingMesh("ruinsSplat", "/assets/aholo/ruins.spz", this.scene);
      const ruins = this.world.islands[3];
      const cx = ruins.root.position.x, cz = ruins.root.position.z;
      const cy = ruins.heightAt(cx, cz) ?? 0;
      splat.position.set(cx, cy + 1, cz);
      splat.isPickable = false;
      // 等待加载完成后按岛面尺度归一
      const waitReady = () => {
        if (splat.isReady()) {
          const bb = splat.getBoundingInfo().boundingBox;
          const size = bb.maximumWorld.subtract(bb.minimumWorld);
          // 重建原始场景可达千米级；按岛屿尺度归一，留少量出界余量
          const target = ruins.def.radius * 1.15;
          const sc = target / (Math.max(size.x, size.z) || 1);
          splat.scaling.setAll(sc);
          splat.position.y = cy + 0.5 - bb.minimumWorld.y * sc;
          this.hud.toast("云间遗迹的三维重建已加载（Aholo）", 5);
        } else setTimeout(waitReady, 500);
      };
      setTimeout(waitReady, 1200);
      this.spzNode = splat;
    } catch (e) {
      console.warn("[splat] load error", e);
    }
  }

  // ---------- 初始布置 ----------

  private buildHomeBase() {
    const home = this.world.islands[0] as LsicHomeIsland;
    const base = home.root.position;
    const H = (lx: number, lz: number) => home.heightAt(base.x + lx, base.z + lz) ?? 7.5;
    const playerHome = homeAnchor(home, "playerHouse");
    const plaza = homeAnchor(home, "plaza");

    // 家园建筑、道路、围栏与地表均由 LSIC GLB 提供；这里只保留玩法设施。

    // ---- 功能设施（建造系统放置，保留可拆改语义） ----
    // 灶台（初始就有，紧邻民居门前）
    this.build.place("stove", new Vector3(playerHome.x - 4.2, H(playerHome.x - 4.2, playerHome.z - 4.8) + 0.05, playerHome.z - 4.8), -0.5, false, "free");
    // 初始座椅与桌子（民居前的生活感；可被 G 挪动/拆除）
    this.build.place("chair", new Vector3(playerHome.x - 1.7, H(playerHome.x - 1.7, playerHome.z - 5.6) + 0.05, playerHome.z - 5.6), 2.4, false, "free");
    this.build.place("table", new Vector3(playerHome.x + 0.4, H(playerHome.x + 0.4, playerHome.z - 5.2) + 0.05, playerHome.z - 5.2), 0.3, false, "free");
    this.build.place("lantern", new Vector3(playerHome.x + 4.1, H(playerHome.x + 4.1, playerHome.z - 4.8) + 0.05, playerHome.z - 4.8), 0, false, "free");
    this.build.place("lantern", new Vector3(plaza.x - 5.7, H(plaza.x - 5.7, plaza.z - 4.8) + 0.05, plaza.z - 4.8), 0, false, "free");
    // 泊位区不再放木台：船体本身与石板降落区已构成泊位视觉（旧木台与船体错位悬空）

    // 座位注册（供 NPC sit 与玩家坐下）
    this.refreshFacilities();
  }

  refreshSeats() {
    const oldPlayerSeat = this.player.seatBuildingUid;
    this.interact.chairSeats = this.build.buildings
      .filter((b) => b.partId === "chair")
      .map((b) => ({ uid: b.uid, pos: b.pos.clone(), rotY: b.rotY, occupant: this.player.isSittingOn(b.uid) ? "player" : this.interact.chairSeats.find((old) => old.uid === b.uid)?.occupant ?? null }));
    if (oldPlayerSeat && !this.interact.chairSeats.some((seat) => seat.uid === oldPlayerSeat)) {
      this.player.standUp(); this.interact.sitting = false;
    }
    // 清掉已拆除座椅的旧座位
    this.interact.targets = this.interact.targets.filter((t) => t.kind !== "sit");
    for (const seat of this.interact.chairSeats) {
      const seatPos = seat.pos.add(new Vector3(0, 0.6, 0));
      this.interact.register({
        kind: "sit", label: "坐下", pos: seatPos.clone(),
        valid: () => this.build.buildings.some((b) => b.uid === seat.uid) && !seat.occupant,
        act: () => {
          this.player.sitAt(seat.pos, seat.rotY, seat.uid);
          seat.occupant = "player";
          this.interact.sitting = true;
          this.hud.toast("按 E 起身", 2);
        },
      });
    }
  }

  /** 真实建筑是设施交互的唯一来源；删除、移动和读档均重建这些短生命周期索引。 */
  refreshFacilities() {
    this.interact.targets = this.interact.targets.filter((t) => !["cook", "stabilizer", "sit"].includes(t.kind));
    const stoves = this.build.buildings.filter((b) => b.partId === "stove");
    this.interact.stovePos = stoves[0]?.pos.clone() ?? null;
    for (const stove of stoves) {
      this.interact.register({
        kind: "cook", label: "石砌灶台", pos: stove.pos.clone().add(new Vector3(0, 0.8, 0)),
        valid: () => this.build.buildings.some((b) => b.uid === stove.uid), act: () => this.openCooking(),
      });
    }
    if (this.homeLevel > 0) {
      for (const stabilizer of this.build.buildings.filter((b) => b.partId === "berth_stabilizer")) {
        this.interact.register({
          kind: "stabilizer", label: "云舟整备（稳定装置）", pos: stabilizer.pos.clone(),
          valid: () => this.build.buildings.some((b) => b.uid === stabilizer.uid),
          act: () => {
            this.world.ship.energy = 100;
            this.player.hp = this.player.maxHp;
            this.player.hunger = Math.min(100, this.player.hunger + 40);
            this.hud.toast("云舟整备完成：风能回满，状态恢复。");
          },
        });
      }
    }
    // M4 设施交互：风锻台（武器成长）/ 协作项目板
    for (const forge of this.build.buildings.filter((b) => b.partId === "forge_anvil")) {
      this.interact.register({
        kind: "npc_workbench", label: "风锻台（武器整备）", pos: forge.pos.clone().add(new Vector3(0, 0.8, 0)),
        valid: () => this.build.buildings.some((b) => b.uid === forge.uid),
        act: () => this.useForge(),
      });
    }
    for (const board of this.build.buildings.filter((b) => b.partId === "work_board")) {
      this.interact.register({
        kind: "npc_workbench", label: "项目板（查看持续项目）", pos: board.pos.clone().add(new Vector3(0, 0.8, 0)),
        valid: () => this.build.buildings.some((b) => b.uid === board.uid),
        act: () => this.projects.showBoard(),
      });
    }
    this.refreshSeats();
  }

  /** 风锻台：一次性解锁蓄力风斩（真实消耗 FORGE_UNLOCK_COST） */
  private useForge() {
    if (this.projects.forgeUnlocked) {
      this.hud.toast("风刃长剑已整备完毕：按 Q 释放蓄力风斩（20 体力 · 1.5s 冷却）。", 5);
      return;
    }
    if (!this.inv.canAfford(FORGE_UNLOCK_COST)) {
      this.hud.toast(`整备需要 ${Object.entries(FORGE_UNLOCK_COST).map(([id, n]) => `${this.inv.nameOf(id)}×${n}`).join(" ")}。`, 5);
      return;
    }
    for (const [id, n] of Object.entries(FORGE_UNLOCK_COST)) {
      if (n && !this.inv.remove(id as ItemId, n)) return;
    }
    this.projects.forgeUnlocked = true;
    this.hud.toast("风刃长剑饮饱了风：解锁蓄力风斩！按 Q 释放。", 6);
    this.onGameEvent("forge_unlocked", {});
    void this.persist();
  }

  private addFarmPlots() {
    const home = this.world.islands[0] as LsicHomeIsland;
    const base = home.root.position;
    const H = (lx: number, lz: number) => home.heightAt(base.x + lx, base.z + lz) ?? 0;
    const farm = homeAnchor(home, "farm");
    this.interact.addFarmPlot("p1", new Vector3(farm.x - 4, H(farm.x - 4, farm.z) + 0.02, farm.z));
    this.interact.addFarmPlot("p2", new Vector3(farm.x, H(farm.x, farm.z) + 0.02, farm.z));
    this.interact.addFarmPlot("p3", new Vector3(farm.x + 4, H(farm.x + 4, farm.z) + 0.02, farm.z));
  }

  private spawnWisps() {
    const cw = this.world.islands[1], ce = this.world.islands[2];
    const spots = [
      [cw, -8, 4], [cw, 10, -6],
      [ce, 0, -8], [ce, -8, 8],
    ] as [typeof cw, number, number][];
    for (const [isle, lx, lz] of spots) {
      const y = isle.heightAt(isle.root.position.x + lx, isle.root.position.z + lz) ?? 0;
      this.combat.spawnWisp(new Vector3(isle.root.position.x + lx, y + 1.5, isle.root.position.z + lz));
    }
  }

  private spawnNpcs() {
    const home = this.world.islands[0] as LsicHomeIsland;
    const base = home.root.position;
    const H = (lx: number, lz: number) => home.heightAt(base.x + lx, base.z + lz) ?? 0;
    const lingHome = homeAnchor(home, "lingHouse");
    const yanHome = homeAnchor(home, "yanHouse");
    const ling: NpcPersona = {
      id: "ling", name: "苓", role: "园艺师",
      persona: "温柔细致的园艺师，说话轻声，喜爱花草与烹饪，担心作物和大家的伙食。",
      goal: "让家园绿意生长，让大家吃上热饭。",
      color: new Color3(0.55, 0.72, 0.55), accent: new Color3(0.85, 0.75, 0.6),
      home: new Vector3(lingHome.x, H(lingHome.x, lingHome.z), lingHome.z),
    };
    const yan: NpcPersona = {
      id: "yan", name: "岩", role: "工匠",
      persona: "直率务实的工匠，嗓门大，关心泊位、工具和一切能修的东西，讲效率。",
      goal: "把家园的设施修得结实好用，完成泊位整备。",
      color: new Color3(0.6, 0.45, 0.35), accent: new Color3(0.75, 0.55, 0.3),
      home: new Vector3(yanHome.x, H(yanHome.x, yanHome.z), yanHome.z),
    };
    this.npcs.push(
      new NpcActor(ling, ling.home, this.scene, {
        world: this.world, player: this.player, interact: this.interact, build: this.build, inv: this.inv,
        getSituation: (npc) => this.situationFor(npc),
      }),
      new NpcActor(yan, yan.home, this.scene, {
        world: this.world, player: this.player, interact: this.interact, build: this.build, inv: this.inv,
        getSituation: (npc) => this.situationFor(npc),
      }),
    );
    for (const npc of this.npcs) {
      npc.onEvent = (kind, data) => this.onGameEvent(kind, data);
      this.interact.register({
        kind: "npc", label: `${npc.persona.name}（${npc.persona.role}）`,
        pos: npc.node.position.add(new Vector3(0, 1, 0)),
        getPos: () => npc.node.position.add(new Vector3(0, 1, 0)),
        valid: () => true,
        act: () => this.talkTo(npc),
        data: npc,
      });
    }
  }

  situationFor(npc: NpcActor): NpcSituation {
    const t = this.playSeconds;
    const tod = t % 600 < 300 ? "白天" : "傍晚";
    return {
      npcId: npc.persona.id, npcName: npc.persona.name, persona: npc.persona.persona, goal: npc.persona.goal,
      timeOfDay: tod, weather: "晴朗微风", homeLevel: this.homeLevel,
      hp: Math.round(this.player.hp), hunger: Math.round(this.player.hunger),
      inventory: this.inv.export(),
      farm: this.interact.farm.map((f) => ({ plot: f.id, stage: f.stage >= 3 ? "成熟" : f.crop ? `生长${f.stage}` : "空", crop: f.crop ?? "-" })),
      playerNearby: Vector3.Distance(this.player.node.position, npc.pos) < 8,
      playerDoing: this.player.mode === "sail" ? "驾驶云舟" : this.player.mode === "glide" ? "滑翔飞行" : this.build.mode === "place" ? "在建造" : "在岛上活动",
      others: this.npcs.filter((n) => n !== npc).map((n) => ({ name: n.persona.name, doing: n.state })),
      facilities: this.build.buildings.filter((b) => ["stove", "berth_stabilizer"].includes(b.partId))
        .map((b) => ({ id: b.uid, name: BUILD_CATALOG.find((p) => p.id === b.partId)?.name ?? b.partId, usable: true })),
      recentMemory: npc.memory.slice(-12).map((m) => m.text),
      buildAuthorization: this.build.buildZone && this.build.buildBudget
        ? { zone: "家园空岛中央广场", budget: this.build.buildBudget } : null,
      recentChat: npc.chatHistory.slice(-4).map((c) => ({ from: c.role === "player" ? "玩家" : npc.persona.name, text: c.text })),
    };
  }

  // ---------- 交互与对话 ----------

  private talkTo(npc: NpcActor) {
    this.talkingNpc = npc;
    // 问候语先于事实落账计算：本对话展示当前阶段的文案，下一阶段文案留给下次对话
    const greeting = this.npcGreeting(npc);
    // 泊位升级：装置建好后与工匠确认整备即完成家园升级
    if (npc.persona.id === "yan" && this.quests.has("built_berth_stabilizer") && !this.quests.has("home_upgraded")) {
      this.quests.mark("home_upgraded");
      this.onGameEvent("home_upgraded");
    }
    // 筑语石赠予：升级后的首次对话由岩交出（只发生一次）
    if (npc.persona.id === "yan" && this.quests.has("home_upgraded") && !this.quests.has("creation_unlocked")) {
      this.quests.mark("creation_unlocked");
      npc.remember("我把旧观测站挖出的筑语石交给了船长——对它说出愿望，就能在岛上实现。", "gift");
      this.hud.toast("获得『筑语石』——按 C 打开创造面板，说出你想要的样子。", 7);
    }
    // M4：项目提议 / 同行邀请 / 宠物结识选项
    const options: string[] = ["你想做什么？", "（看看岛上现状）"];
    const projectBranch = this.availableProposal(npc);
    if (projectBranch) options.push("（听听项目提议）");
    if (npc.persona.id === "yan" && this.projects.companion.jointProject && !this.companion.active && !this.projects.companion.invited) options.push("（邀请岩同行远征）");
    if (npc.persona.id === "ling" && !this.pet.pet && this.quests.has("home_upgraded") && this.world.visited.size > 1) {
      options.push(this.inv.count("roast_mushroom") > 0 ? "（用烤云菇结识小狐狸）" : "（问问宠物的事）");
    }
    options.push("（结束对话）");
    this.hud.showDialog(`${npc.persona.name} · ${npc.persona.role}`, greeting, options);
    this.hud.onOption = (i) => {
      const text = options[i];
      if (text === "你想做什么？") {
        void npc.chat("你接下来想做什么？").then((r) => this.hud.updateDialogText(r));
      } else if (text === "（看看岛上现状）") {
        const s = this.situationFor(npc);
        const mem = npc.memory.slice(-3).map((m) => `· ${m.text}`).join("\n") || "· （还没有共同经历）";
        const stageName = ["落脚之地", "稳定家园", "协作聚落", "远征基地", "云海枢纽"][this.projects.stage() - 1];
        this.hud.updateDialogText(`【岛上现状】时间：${s.timeOfDay}｜家园阶段：${stageName}\n【${npc.persona.name}的近况】\n${mem}\n当前打算：${npc.lastReason || "刚醒过来，正在想。"}`);
      } else if (text === "（听听项目提议）" && projectBranch) {
        const def = BRANCHES[projectBranch];
        const cost = Object.entries(def.proposeCost).map(([id, n]) => `${ITEMS[id as ItemId].name}×${n}`).join(" ");
        this.hud.showDialog(`${npc.persona.name} · 提议`, `${def.pitch}（提议消耗：${cost}）`, ["同意立项", "再想想"]);
        this.hud.onOption = (j) => {
          if (j === 0) { this.projects.propose(projectBranch, npc); this.hud.hideDialog(); }
          else this.hud.hideDialog();
        };
      } else if (text === "（邀请岩同行远征）") {
        this.companion.invite();
        this.hud.hideDialog();
      } else if (text === "（用烤云菇结识小狐狸）") {
        if (this.inv.remove("roast_mushroom", 1)) this.pet.adopt();
        this.hud.hideDialog();
      } else if (text === "（问问宠物的事）") {
        this.hud.updateDialogText("苓：“听说远征归来的旅人会遇见云狐……带一块烤云菇来，我帮你引见。”");
      } else {
        this.hud.hideDialog();
      }
    };
    this.hud.onChatSubmit = (text) => {
      void npc.chat(text).then((r) => this.hud.updateDialogText(r));
    };
    npc.remember("玩家过来和我聊了聊。", "chat");
    this.quests.mark("talked_npc_first");
  }
  talkingNpc: NpcActor | null = null;
  lastDockedIsland: string | null = null;

  /** 该 NPC 当前可提议的分支（材料够 + 无进行中/已完成项目） */
  private availableProposal(npc: NpcActor): BranchId | null {
    const branches: BranchId[] = npc.persona.id === "ling" ? ["life"] : ["craft", "explore", "society"];
    for (const b of branches) {
      if (canPropose(this.projects.projects, b, this.inv).ok) return b;
    }
    return null;
  }

  private npcGreeting(npc: NpcActor): string {
    if (npc.persona.id === "ling") {
      // 开场逐字稿：首次对话交代出发动机与去向（只出现一次）
      if (!this.quests.has("talked_npc_first")) {
        return "船长醒啦？咱们的云帆核心越来越没力气了——再不想法子，云舟都要趴窝在泊位上。西边的风峡岛有风晶，听说旧时代的遗迹里还留着整备装置的图纸。先跟我到田里拿点干粮吧。";
      }
      return "回来啦！田里的作物我看着呢。对了，灶台要是能多备些吃的，下次远征就不用担心饿肚子。";
    }
    if (this.quests.has("built_berth_stabilizer") && !this.quests.has("home_upgraded")) {
      return "装置都装好了？好！我来做最后确认——泊位整备，启动！家园从今天起就是「稳定家园」了。";
    }
    if (this.quests.has("home_upgraded")) {
      if (!this.quests.has("creation_unlocked")) {
        return "对了，这个给你——旧观测站挖出来的『筑语石』。把想要的东西对它说，它就能在岛上摆出来。材料还是用咱们的，别浪费。";
      }
      return "泊位整备系统运行良好，随时可以给你的云舟做整备。要修什么就说。";
    }
    return "哟，船长。泊位还是老样子——想整备云舟的话，得先去外岛找旧时代的稳定装置图纸。";
  }

  private openCooking() {
    const recipes = RECIPES;
    const rows = recipes.map((r, i) => {
      const cost = Object.entries(r.cost).map(([id, n]) => `${this.inv.nameOf(id)}×${n}`).join(" + ");
      const ok = this.inv.canAfford(r.cost);
      return `<div class="recipeRow" data-i="${i}" style="display:flex; justify-content:space-between; align-items:center;
        border:1px solid rgba(255,255,255,.15); border-radius:8px; padding:8px 12px; margin-bottom:6px;
        cursor:${ok ? "pointer" : "not-allowed"}; opacity:${ok ? 1 : 0.5};">
        <span>${r.name}</span><span style="font-size:12px; color:#f0c878;">${cost}</span></div>`;
    }).join("");
    this.hud.showPanel("灶台烹饪", `${rows}<div style="font-size:12px; opacity:.65;">食物能恢复饱食与生命，远征前多备一些。</div>`);
    this.hud.panelBody.querySelectorAll<HTMLElement>(".recipeRow").forEach((el) => {
      el.addEventListener("click", () => {
        const r = recipes[parseInt(el.dataset.i!)];
        // 与 NPC 共用同一条 cookRecipe 规则（校验、扣料、产出）
        if (!cookRecipe(this.inv, r)) return;
        this.hud.toast(`做好了 ${this.inv.nameOf(r.out.id)}！`);
        this.hud.hidePanel();
        this.onGameEvent("cooked", r.out.id);
      });
    });
  }

  // ---------- 事件 ----------

  homeLevel = 0;
  onGameEvent(kind: string, data?: unknown) {
    // 声音反馈统一分发（M 静音在 AudioSystem 内部生效）
    const audioFor: Record<string, () => void> = {
      picked: () => this.audio.pickup(),
      built: () => this.audio.place(),
      chest_opened: () => this.audio.quest(),
      quest_step: () => this.audio.quest(),
      quest_done: () => this.audio.quest(),
      level_up: () => this.audio.levelUp(),
      created_plan: () => this.audio.quest(),
      novel_item_done: () => this.audio.quest(),
      npc_built: () => this.audio.quest(),
      ship_dock: () => this.audio.docked(),
      ship_undock: () => this.audio.undocked(),
      cooked: () => this.audio.cook(),
    };
    audioFor[kind]?.();
    switch (kind) {
      case "picked": {
        const d = data as { item: ItemId; count: number };
        this.hud.toast(`获得 ${this.inv.nameOf(d.item)} ×${d.count}`);
        if (d.item === "windcrystal" && this.inv.count("windcrystal") >= 3) this.quests.mark("windcrystal_3");
        break;
      }
      case "chest_opened": {
        this.hud.toast("打开储物箱：获得了泊位稳定装置图纸！");
        this.quests.mark("blueprint_found");
        this.build.unlockedQuests.add("berth_upgrade");
        const chest = this.world.chests.find((c) => c.uid === (data as { uid: string })?.uid) ?? this.world.chests[0];
        if (chest) swapChestOpen(chest);
        void this.persist();
        break;
      }
      case "built": {
        const d = data as { partId: string; byNpc: boolean };
        if (d.byNpc) break;
        if (!this.started) break; // 开机基线放置不计任务、不触发存档
        if (d.partId === "stove") this.quests.mark("built_stove");
        if (d.partId === "berth_stabilizer") this.quests.mark("built_berth_stabilizer");
        if (["chair", "table", "lantern", "planter"].includes(d.partId)) {
          const count = this.build.buildings.filter((b) => ["chair", "table", "lantern", "planter"].includes(b.partId)).length;
          if (count >= 3) this.quests.mark("built_furniture_2");
        }
        this.refreshFacilities();
        void this.persist();
        break;
      }
      case "removed": {
        const d = data as { uid: string };
        if (this.player.isSittingOn(d.uid)) { this.player.standUp(); this.interact.sitting = false; }
        this.refreshFacilities();
        if (this.started) void this.persist();
        break;
      }
      case "moved": {
        const d = data as { uid: string };
        if (this.player.isSittingOn(d.uid)) { this.player.standUp(); this.interact.sitting = false; }
        this.refreshFacilities();
        if (this.started) void this.persist();
        break;
      }
      case "created_plan": {
        // 语言创造链：首个方案建成（回滚不计）
        this.quests.mark("created_plan");
        const d = data as { summary?: string };
        if (this.npcs[0] && d?.summary) this.npcs[0].remember(`玩家用语言创造建成了「${d.summary}」。`, "create");
        // 协作提议：建成约 30s 后、尚无授权时，岩主动开口（玩家可拒绝）
        if (this.npcs[0] && !this.build.buildZone) {
          const yan = this.npcs.find((n) => n.persona.id === "yan") ?? this.npcs[0];
          window.setTimeout(() => {
            if (!this.started || this.build.buildZone) return;
            yan.say("台子漂亮！不过边上光秃秃的，晚上怕有人踩空。我来加一圈护栏、再点几盆花？按 K 授权就行。", 9);
            yan.remember("我主动提议帮玩家完善新建成的空间，等玩家授权。", "propose");
            this.hud.toast("岩想帮忙完善新空间——按 K 划定区域与预算。", 6);
          }, 30_000);
        }
        if (this.started) void this.persist();
        break;
      }
      case "npc_built": {
        // 协作完工：语言创造建成后的 NPC 授权建设
        if (this.quests.has("created_plan")) this.quests.mark("npc_built_after_creation");
        const d = data as { npc: string; partId: string };
        const npc = this.npcs.find((n) => n.persona.id === d.npc);
        this.hud.toast(`${npc?.persona.name ?? "居民"} 完成了一次授权建设`);
        this.player.addXp(15);
        break;
      }
      case "novel_item_done": {
        this.quests.mark("novel_item_done");
        const d = data as { name?: string; fallback?: boolean };
        if (this.npcs[0] && d?.name) {
          this.npcs[0].remember(
            d.fallback
              ? `玩家创造了新东西「${d.name}」，生成服务不可用，使用了替代件。`
              : `玩家凭空造出了新的东西：「${d.name}」，已收入个人目录。`,
            "create",
          );
        }
        if (this.started) void this.persist();
        break;
      }
      case "boarded_ship": this.quests.mark("boarded_ship"); break;
      case "ship_dock": {
        const target = data as { islandId: string };
        this.lastDockedIsland = target.islandId;
        this.streamer.onShipDocked(target.islandId, this.world.ship);
        // M4：宠物羁绊 / 远征停靠记录
        this.pet.noteDock(target.islandId);
        this.journeyDocks.push(target.islandId);
        if (target.islandId === "home" && this.journeyOpId) {
          this.projects.settleExpedition(this.journeyOpId, this.journeyDocks, "home");
          this.journeyOpId = null;
          this.journeyDocks = [];
        }
        if (target.islandId === "home" && this.world.visited.has("canyonW") && this.world.visited.has("ruins")) {
          this.quests.mark("docked_home_after_explore");
        }
        if (target.islandId !== "home" && !this.world.visited.has(target.islandId)) {
          this.world.visited.add(target.islandId);
          // 泊位键 "r-2_0/i0" 与生成岛 def.id "gen_r-2_0_0" 的序号写法不同（i0 vs _0），统一归一后比对
          const shortKey = target.islandId.replace(/\//g, "_").replace(/i(\d+)$/, "$1");
          const isle = this.world.islands.find((i) => i.def.id === target.islandId || `${i.def.id}`.endsWith(shortKey));
          if (isle) {
            this.hud.toast(`抵达 ${isle.def.name} — ${isle.def.intro}`, 5);
            if (isle.def.kind !== "islet") this.projects.noteIslandType(isle.def.kind);
          }
          else this.hud.toast(`抵达新的空岛(${target.islandId})`, 5);
          this.player.addXp(20);
        }
        break;
      }
      case "ship_undock": {
        // ship_undock 不携带数据:用最近一次停泊的岛 ID 拆栈道
        this.streamer.onShipUndocked(this.lastDockedIsland ?? "");
        this.lastDockedIsland = null;
        break;
      }
      case "island_requested": {
        const d = data as { queueAhead?: number };
        const ahead = typeof d?.queueAhead === "number" ? d.queueAhead : 0;
        this.hud.toast(
          ahead > 0
            ? `云海深处探测到新的空岛,前方还有 ${ahead} 座在生成,约需数分钟……`
            : "云海深处探测到新的空岛,正在生成……",
          3,
        );
        break;
      }
      case "island_loaded":
        this.hud.toast(`${(data as { name: string }).name} 出现在前方`, 4);
        break;
      case "wisp_defeated": {
        const d = data as { by?: string };
        if (d?.by === "companion") { this.hud.toast("岩的重击击散了云雾灵！"); this.projects.noteJointWispKill(); break; }
        this.hud.toast("云雾灵消散了！获得雾灵精华");
        this.player.addXp(10);
        if (this.companion.active) this.projects.noteJointWispKill(); // 与搭档共同击败
        break;
      }
      case "project_completed": {
        const d = data as { branch: BranchId };
        this.player.addXp(25);
        if (d.branch === "explore") this.spawnObsArrow();
        if (d.branch === "society") this.hud.toast("协作工坊已建成：按 J 打开项目板管理持续项目。", 6);
        void this.persist();
        break;
      }
      case "player_hit": this.hud.flashDamage(); break;
      case "level_up": this.hud.toast(`等级提升到 Lv.${data}！体力上限增加`); break;
      case "quest_step": {
        const d = data as { quest: string; step: number; title: string };
        this.hud.toast(`任务推进：${d.title}`);
        break;
      }
      case "npc_action": {
        const d = data as { id: string; action: { type: string }; source: string };
        const npc = this.npcs.find((n) => n.persona.id === d.id);
        if (npc && d.source === "llm") this.hud.toast(`${npc.persona.name}（LLM）：${npc.lastReason}`);
        break;
      }
      case "home_upgraded": {
        this.homeLevel = 1;
        this.hud.toast("🎉 家园升级为「稳定家园」！泊位整备已开启", 6);
        this.doHomeUpgrade();
        void this.persist();
        break;
      }
      case "respawn": this.hud.toast(String(data), 4); break;
      case "respawn_done": {
        const home = this.world.islands.find((island) => island.def.id === "home") as LsicHomeIsland | undefined;
        if (!home?.surface) break;
        const state = homeRespawnState(home.surface);
        this.player.teleport(new Vector3(state.x, state.y, state.z));
        this.player.hunger = Math.max(this.player.hunger, state.hunger);
        // 死亡后船若遗留在外岛，归位到家园泊位，玩家不必再跨海找回
        const homeDock = this.world.docks.find((dock) => dock.islandId === "home");
        if (homeDock && Vector3.Distance(this.world.ship.pos, homeDock.pos) > 30) {
          this.world.ship.root.position.copyFrom(homeDock.pos);
          this.world.ship.root.rotation.y = homeDock.rotY;
          this.world.ship.heading = homeDock.rotY;
          this.world.ship.setState(true);
          this.hud.toast("云流也把你的云舟送回了泊位。", 4);
        }
        this.hud.toast("云流将你送回了栖云屿。", 3);
        break;
      }
      case "toast": this.hud.toast(String(data)); break;
    }
  }

  private doHomeUpgrade() {
    // 外观变化：泊位灯光 + 旗帜 + 云舟帆强化
    // 灯柱只用发光材质（WebGL 顶点 uniform buffer 上限 12 盏灯，点光只留泊位中央 1 盏且受全局预算闸）
    const home = this.world.islands[0];
    const padPos = this.world.docks[0].pos;
    // 恢复存档会重复调用：灯柱与点光只建一次
    for (let i = 0; i < 4 && !this.scene.getMeshByName(`dockLamp${i}`); i++) {
      const ang = i * Math.PI / 2;
      const p = padPos.add(new Vector3(Math.cos(ang) * 5, 0, Math.sin(ang) * 5));
      const lamp = MeshBuilder.CreateCylinder(`dockLamp${i}`, { height: 2.2, diameter: 0.14 }, this.scene);
      const h = home.heightAt(p.x, p.z) ?? 0;
      lamp.position.set(p.x, h + 1.1, p.z);
      const m = new StandardMaterial(`dockLampMat${i}`, this.scene);
      m.emissiveColor = new Color3(1.0, 0.8, 0.45);
      m.diffuseColor = new Color3(0.8, 0.65, 0.4);
      lamp.material = m;
      lamp.isPickable = false;
    }
    if (this.scene.lights.length < 8 && !this.scene.getLightByName("dockLightCenter")) {
      const light = new PointLight("dockLightCenter", padPos.add(new Vector3(0, 2.6, 0)), this.scene);
      light.diffuse = new Color3(1.0, 0.8, 0.5);
      light.intensity = 0.45;
      light.range = 16;
    }
    this.world.ship.sailUpgraded = true;
    this.world.ship.maxSpeed = 20;
    // 旗标换暖色：升级可感知的外观反馈
    if (this.berthFlag) {
      const fm = this.berthFlag.material as StandardMaterial;
      fm.diffuseColor.set(0.95, 0.72, 0.3);
      fm.emissiveColor.set(0.32, 0.22, 0.06);
    }
    // 功能变化：泊位整备（靠近稳定装置 E 整备：回满风能+生命）
    this.refreshFacilities();
  }

  // ---------- 存档 ----------

  collectSave(): SaveData {
    // 驾驶时玩家视觉节点停在旧登船点——保存取舵位实际位置；滑翔视为步行状态
    const sailing = this.player.mode === "sail";
    const playerPos = sailing
      ? this.world.ship.helmWorldPos.asArray().map((n) => Math.round(n * 100) / 100)
      : this.player.node.position.asArray().map((n) => Math.round(n * 100) / 100);
    return {
      version: 2,
      savedAt: Date.now(),
      playSeconds: this.playSeconds,
      player: {
        pos: playerPos as [number, number, number],
        hp: this.player.hp, hunger: this.player.hunger, stamina: this.player.stamina,
        xp: this.player.xp, level: this.player.level,
        inventory: this.inv.export(), equippedWeapon: this.player.equipped as ItemId | null,
        mode: sailing ? "sail" : "walk",
        foodBuff: this.player.staminaPool > 0 && this.player.staminaPoolUntil > performance.now()
          ? { stamina: this.player.staminaPool, remainingMs: Math.ceil(this.player.staminaPoolUntil - performance.now()) } : null,
      },
      ship: {
        pos: this.world.ship.pos.asArray().map((n) => Math.round(n * 100) / 100) as [number, number, number],
        rotY: this.world.ship.root.rotation.y, docked: this.world.ship.state === "docked",
        sailUpgraded: this.world.ship.sailUpgraded, energy: this.world.ship.energy,
      },
      buildings: this.build.export(),
      farm: this.interact.farm.map((f) => ({ id: f.id, crop: f.crop, stage: f.stage, plantedAt: f.plantedAt })),
      world: {
        collected: this.world.pickups.filter((p) => p.taken).map((p) => p.uid),
        chests: Object.fromEntries(this.world.chests.map((c) => [c.uid, c.opened])),
        visited: [...this.world.visited],
        islandMutations: structuredClone(this.streamer.exportMutations()),
        worldSeed: this.worldSeed,
        worldId: this.worldId,
        generatedTypesVisited: [...this.projects.generatedTypesVisited],
        journeyOpId: this.journeyOpId ?? undefined,
        journeyDocks: [...this.journeyDocks],
      },
      home: {
        level: this.homeLevel,
        upgradedBerth: this.quests.has("home_upgraded"),
        buildZone: this.build.buildZone ? [this.build.buildZone.center.x, this.build.buildZone.center.y, this.build.buildZone.center.z] : null,
        buildBudget: this.build.buildBudget ? { ...this.build.buildBudget } : null,
        authorized: !!this.build.buildZone,
        buildAllowedParts: [...this.build.buildAllowedParts],
        buildZoneRadius: this.build.buildZone?.radius,
        authorizationPaused: this.build.authorizationPaused,
        personalParts: this.create.exportHome(),
        ...this.projects.exportHome(),
        ...(this.pet.pet ? { pet: this.pet.pet } : {}),
      },
      npcs: this.npcs.map((n) => ({
        id: n.persona.id,
        pos: [Math.round(n.pos.x * 100) / 100, Math.round(n.pos.y * 100) / 100, Math.round(n.pos.z * 100) / 100],
        state: n.state,
        // 运行时记忆窗口 60（npc.remember 封顶），保存全量导出；
        // 此前 slice(-40) 导致恢复后丢最近 16 条（验收 D5）。
        memory: n.memory.map((m) => ({ ...m })),
        affinity: n.affinity,
        lastPlan: n.lastPlan,
      })),
      quests: Object.fromEntries(Object.entries(this.quests.states).map(([k, v]) => [k, { step: v.step, done: [...v.done] }])),
      questFacts: [...this.quests.facts],
      flags: { homeLsicV1: true },
    };
  }

  async persist() {
    const save = this.collectSave();
    setNpcWorldContext(save);
    try {
      await saveGame(save);
      this.hud.toast("已保存", 1.5);
      void syncBackup(save).then((status) => {
        if (status === "conflict") this.hud.toast("云端版本冲突：本地档未被覆盖，已保留上传副本。", 5);
      });
    } catch (e) {
      console.warn("save failed", e);
      const blob = new Blob([exportSaveJson(save)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob); link.download = `cloud-isles-recovery-${save.savedAt}.json`; link.click(); URL.revokeObjectURL(link.href);
      this.hud.toast("保存失败，已下载本次进度副本。", 5);
    }
  }

  async applySave(s: SaveData) {
    this.playSeconds = s.playSeconds ?? 0;
    const p = s.player;
    const sailing = p.mode === "sail";
    const home = this.world.islands.find((island) => island.def.id === "home");
    const homeSurface = (home as LsicHomeIsland | undefined)?.surface;
    const migrateLegacyHome = needsHomeLsicV1Migration(s.flags);
    // 世界种子与岛屿变更先于玩家落位恢复;焦点附近已生成岛同步装载,防止落进空云海
    this.worldSeed = s.world.worldSeed ?? DEFAULT_WORLD_SEED;
    this.worldId = s.world.worldId ?? `legacy-${this.worldSeed}-${s.savedAt}`;
    this.streamer.setWorldSeed(this.worldSeed);
    this.streamer.loadMutations(s.world.islandMutations);
    this.player.hp = p.hp; this.player.hunger = p.hunger; this.player.stamina = p.stamina;
    this.player.xp = p.xp; this.player.level = p.level;
    if (p.foodBuff && p.foodBuff.remainingMs > 0) {
      this.player.staminaPool = p.foodBuff.stamina;
      this.player.staminaPoolUntil = performance.now() + p.foodBuff.remainingMs;
    } else { this.player.staminaPool = 0; this.player.staminaPoolUntil = 0; }
    this.player.maxStamina = 100 + (p.level - 1) * 10;
    this.inv.load(p.inventory);
    if (p.equippedWeapon) this.equipSwordVisual(p.equippedWeapon);
    this.world.ship.root.position.set(s.ship.pos[0], s.ship.pos[1], s.ship.pos[2]);
    this.world.ship.root.rotation.y = s.ship.rotY;
    this.world.ship.heading = s.ship.rotY;
    this.world.ship.sailUpgraded = s.ship.sailUpgraded;
    // 航行中保存：玩家回舵位并保持驾驶；停泊保存：恢复停泊状态
    this.world.ship.setState(!sailing && s.ship.docked);
    if (migrateLegacyHome && isLegacyHomeDockedShip(s.ship.pos, s.ship.docked)) {
      const homeDock = this.world.docks.find((dock) => dock.islandId === "home");
      if (homeDock) {
        this.world.ship.root.position.copyFrom(homeDock.pos);
        this.world.ship.root.rotation.y = homeDock.rotY;
        this.world.ship.heading = homeDock.rotY;
      }
    }
    // 恢复位置附近的生成岛同步装载(缓存命中,百毫秒级),玩家不落入空云海
    await this.streamer.ensureAround(new Vector3(
      sailing ? s.ship.pos[0] : p.pos[0], 0, sailing ? s.ship.pos[2] : p.pos[2],
    ));
    if (sailing) {
      this.player.teleport(this.world.ship.helmWorldPos);
      this.player.mode = "sail";
      this.player.setSailing(true);
      this.player.camYaw = s.ship.rotY + Math.PI;
    } else {
      const recovered = migrateLegacyHome && homeSurface
        ? recoverHomeWalkPosition(homeSurface, p.pos[0], p.pos[2])
        : null;
      const groundY = migrateLegacyHome ? homeSurface?.heightAt(p.pos[0], p.pos[2]) : undefined;
      // 旧家园地形改版后才贴回新地表；正常存档仍按原有高度恢复。
      const savedY = p.pos[1];
      const restoredY = recovered?.moved
        ? recovered.y
        : groundY !== null && groundY !== undefined && Math.abs(savedY - groundY) > 1.5
        ? groundY + 0.6
        : savedY + 0.5;
      this.player.teleport(new Vector3(recovered?.x ?? p.pos[0], restoredY, recovered?.z ?? p.pos[2]));
      this.player.mode = "walk";
    }
    this.create.hydrate(s.home.personalParts);
    this.build.load(s.buildings, migrateLegacyHome ? homeSurface : undefined);
    this.refreshFacilities();
    for (const f of s.farm) {
      const plot = this.interact.farm.find((x) => x.id === f.id);
      if (plot) { plot.crop = f.crop as "wheat" | null; plot.stage = f.stage; plot.plantedAt = f.plantedAt < 1_000_000_000_000 ? Date.now() : f.plantedAt; this.interact.growMeshes(plot); }
    }
    for (const uid of s.world.collected) {
      const pk = this.world.pickups.find((x) => x.uid === uid);
      if (pk) { pk.taken = true; pk.mesh.setEnabled(false); }
    }
    for (const [uid, opened] of Object.entries(s.world.chests)) {
      const c = this.world.chests.find((x) => x.uid === uid);
      if (c) { c.opened = opened; if (opened) swapChestOpen(c); }
    }
    this.world.visited = new Set(s.world.visited);
    this.homeLevel = s.home.level;
    this.build.revokeAuthorization();
    if (s.home.buildZone && s.home.authorized) {
      this.build.setBuildZone(new Vector3(s.home.buildZone[0], s.home.buildZone[1], s.home.buildZone[2]), s.home.buildZoneRadius ?? 5.5);
      this.build.authorizeBudget(s.home.buildBudget ?? {}, s.home.buildAllowedParts);
      this.build.pauseAuthorization(!!s.home.authorizationPaused);
    }
    for (const n of s.npcs) {
      const npc = this.npcs.find((x) => x.persona.id === n.id);
      if (npc) {
        npc.pos.set(n.pos[0], n.pos[1], n.pos[2]);
        npc.loadMemory(n.memory);
        npc.affinity = n.affinity;
      }
    }
    // 旧 v1 可能在任务尚未走到 q4 时已开图纸箱：只从已有宝箱/库存迁移这一真实事实。
    const recoveredFacts = new Set(s.questFacts ?? []);
    if (this.world.chests.some((c) => c.opened && c.grants.some((g) => g.item === "blueprint_berth")) || this.inv.count("blueprint_berth") > 0) recoveredFacts.add("blueprint_found");
    this.quests.load(s.quests, [...recoveredFacts]);
    // M4：项目/宠物/搭档恢复（阶段事实：泊位整备按存档与任务事实双源）
    this.projects.hydrate({
      projects: s.home.projects, expeditions: s.home.expeditions, provisionedOpIds: s.home.provisionedOpIds,
      forgeUnlocked: s.home.forgeUnlocked, companion: s.home.companion, beaconCompleted: s.home.beaconCompleted,
      generatedTypesVisited: s.world.generatedTypesVisited,
    });
    this.projects.homeUpgraded = s.home.upgradedBerth || this.quests.has("home_upgraded");
    this.pet.hydrate(s.home.pet ?? null);
    // 搭档同行状态恢复：存档记录邀请事实，运行时回到跟随
    this.companion.active = !!s.home.companion?.invited;
    // 进行中远征接续：刷新/中断后归航仍能结算（无口粮重扣——provisionedOpIds 幂等）
    this.journeyOpId = s.world.journeyOpId ?? null;
    this.journeyDocks = [...(s.world.journeyDocks ?? [])];
    this.projects.attachFarmPlots(this.interact.farm);
    if (this.projects.facilityOnline("explore")) this.spawnObsArrow();
    this.world.ship.energy = Math.max(0, Math.min(100, s.ship.energy ?? this.world.ship.energy));
    setNpcWorldContext(s);
    this.refreshFacilities();
    // 图纸类解锁按任务进度恢复
    if (this.quests.has("blueprint_found") || this.quests.has("built_berth_stabilizer")) {
      this.build.unlockedQuests.add("berth_upgrade");
    }
    if (this.homeLevel > 0) this.doHomeUpgrade();
    this.hud.toast("旅程已恢复。", 3);
  }

  startNew() {
    this.worldId = crypto.randomUUID();
    // 出发行装：风刃长剑（风峡雾灵是必经战斗，武器是首段体验的必要装备）
    this.inv.add("windblade_sword", 1);
    setNpcWorldContext(this.collectSave());
    this.started = true;
    this.hud.closeTitle();
    this.hud.toast("欢迎来到栖云屿。先和居民聊聊，然后登上你的云舟。", 6);
  }

  async startContinue() {
    let s: SaveData | null;
    try { s = await loadGame(); } catch (error) { console.warn("load failed", error); this.hud.titleStatus(getLastSaveIssue() ?? "存档读取失败。"); return; }
    if (!s) {
      const issue = getLastSaveIssue();
      this.hud.titleStatus(issue ?? "没有可读取的本地存档，请导入存档或选择云端副本。");
      return;
    }
    try {
      await this.applySave(s);
      this.started = true;
      this.hud.closeTitle();
    } catch (error) {
      console.warn("restore failed", error);
      this.hud.titleStatus("恢复失败：原存档未被覆盖。");
      return;
    }
    const issue = getLastSaveIssue();
    if (issue) this.hud.toast(issue, 7);
  }

  // ---------- 主循环 ----------

  private frame() {
    this.dayEnvironment.update(this.playSeconds);
    const nowTs = performance.now();
    this.lastFrameAt = nowTs;
    this.frameDeltaMs = Math.min(50, Math.max(1, this.frameDeltaMs * 0 + (nowTs - (this.prevFrameTs2 || nowTs - 16.6))));
    this.prevFrameTs2 = nowTs;
    const dt = Math.min(0.05, this.frameDeltaMs / 1000);
    if (!this.started) {
      const home = this.world.islands[0] as LsicHomeIsland;
      const viewpoint = homeAnchor(home, "viewpoint");
      const plaza = homeAnchor(home, "plaza");
      // 标题从西北高脊望向聚落与东南港湾，避免旧岛坐标落入新地形。
      this.camera.position.set(viewpoint.x - 28, viewpoint.y + 17, viewpoint.z + 24);
      this.camera.setTarget(new Vector3(plaza.x + 18, plaza.y + 2.5, plaza.z - 15));
      this.world.update(dt);
      this.scene.render();
      return;
    }
    this.updateKeys();
    if (this.freeFly.enabled) {
      // 自由相机:玩法模拟整体暂停(角色物理/NPC/云舟/生存数值/计时/自动存档),仅保留装饰动画
      this.freeFly.update(dt);
      this.world.update(dt);
      this.cloudSea.update(dt, this.camera.position);
      this.scene.render();
      this.input.endFrame();
      return;
    }
    this.playSeconds += dt;
    this.world.update(dt);
    // 流式岛屿:以玩家(航行时随船)为焦点请求/装载/卸载
    this.streamer.update(dt, this.player.node.position);

    // 玩家模式推进（驾驶的相机/角色钉位在 ship.update 之后统一处理）
    if (this.player.mode !== "sail") {
      this.player.update(dt, { islands: this.world.islands, updrafts: this.world.updrafts, seaLevel: SEA_LEVEL });
    }
    this.world.ship.update(dt, this.input, this.player, this.world.islands);
    // 驾驶时角色钉在舵位随船移动（存档恢复同样成立）
    if (this.player.mode === "sail") {
      this.player.stickTo(this.world.ship.helmStandPos(), this.world.ship.root.rotation.y);
      this.player.updateSailCamera(dt, this.world.ship.helmWorldPos);
    }
    // 平台随动：玩家站在甲板上时继承云舟位移
    if (this.player.mode === "walk" && this.playerStandsOnShip()) {
      this.player.applyPlatformDelta(this.world.ship.lastDelta.deltaPos, this.world.ship.lastDelta.deltaRotY, this.world.ship.pos);
    }

    this.build.updateGhost();
    this.create.update();
    // 声音：脚步（地面行走且按移动键）+ 环境风（航行/滑翔增强）
    this.audio.footstep(dt, this.player.mode === "walk" && this.input.isDown("KeyW", "KeyA", "KeyS", "KeyD") && !this.hud.panelVisible() && !this.hud.dialogVisible());
    this.audio.update(dt, this.player.mode === "sail" ? 0.75 : this.player.mode === "glide" ? 0.55 : 0.1);
    this.interact.update(dt);
    this.combat.update(dt, this.world.updrafts);
    this.quests.update(performance.now());
    for (const npc of this.npcs) npc.update(dt);
    // M4：项目执行、宠物随行、搭档同行
    this.projects.update();
    const sailing = this.player.mode === "sail";
    this.pet.update(dt, sailing ? this.world.ship.deckBoardPos() : null, sailing);
    this.companion.update(dt, sailing, this.world.ship.root);
    this.cloudSea.update(dt, this.camera.position);

    // 生存数值
    this.hungervt += dt;
    if (this.hungervt > 3) {
      this.hungervt = 0;
      this.player.hunger = Math.max(0, this.player.hunger - 0.6);
      if (this.player.hunger <= 0) this.player.hp = Math.max(0, this.player.hp - 4);
      else if (this.player.hp < this.player.maxHp && this.player.hunger > 60) this.player.hp = Math.min(this.player.maxHp, this.player.hp + 1.5);
      if (this.player.hp <= 0) this.player.startRespawn("饿晕了过去……被云流送回家。");
    }

    this.updateInteraction();
    this.updateHud();
    this.updateBeacon();
    this.updateBubbles();

    // 自动存档
    this.saveTimer += dt;
    if (this.saveTimer > 30) { this.saveTimer = 0; void this.persist(); }

    this.scene.render();
    this.input.endFrame();
  }

  private playerStandsOnShip(): boolean {
    // 简化：玩家在甲板范围内且高度接近甲板
    const p = this.player.node.position;
    const s = this.world.ship;
    if (s.state !== "docked" && this.player.mode !== "walk") return false;
    const local = Vector3.TransformCoordinates(p, s.root.getWorldMatrix().clone().invert());
    return Math.abs(local.x) < 3.2 && local.z > -8.4 && local.z < 8.4 && local.y > -0.5 && local.y < 2.5;
  }

  /** 开发者自由相机开关:冻结/恢复角色物理,玩法模拟由主循环分支暂停。 */
  /** Development review only; null restores the persisted simulation clock. */
  setTimeOfDay(hour: number | null) {
    if (import.meta.env.DEV) this.dayEnvironment.setTimeOfDay(hour);
  }

  toggleFreeFly() {
    const on = this.freeFly.toggle();
    this.player.setPhysicsFrozen(on);
    if (on && !document.pointerLockElement) this.input.requestPointerLock();
    this.hud.toast(on ? "开发者自由相机已启用(F8 退出)" : "已切回正常游戏", 2);
  }

  private updateKeys() {
    const input = this.input;
    if (input.wasPressed("F8")) this.toggleFreeFly();
    if (this.freeFly.enabled) {
      // 自由相机:吞掉玩法按键(建造/背包/交互),仅保留退出键
      if (input.wasPressed("Escape")) this.toggleFreeFly();
      this.hud.setPrompt("开发者自由相机:F8/Esc 退出 · WASD 水平移动 · Space/Ctrl 升降 · Shift 加速 · 鼠标环视");
      return;
    }
    // Esc 层级
    if (input.wasPressed("Escape")) {
      if (this.hud.panelVisible()) this.hud.hidePanel();
      else if (this.create.state === "preview") this.create.close();
      else if (this.hud.dialogVisible()) this.hud.hideDialog();
      else if (this.build.mode !== "off") this.build.exit();
      else if (document.pointerLockElement) input.releasePointerLock();
    }
    if (input.wasPressed("F3")) this.perfVisible = !this.perfVisible;
    if (!input.uiCapture && input.wasPressed("KeyM")) {
      this.hud.toast(this.audio.toggleMute() ? "已静音（M 恢复）" : "声音已开启", 2);
    }
    if (this.create.state === "preview") {
      if (input.wasPressed("KeyR")) this.create.rotate();
      if (input.wasPressed("Enter")) this.create.confirm();
    }
    if (!input.uiCapture && !this.hud.dialogVisible() && !this.hud.panelVisible()) {
      if (input.wasPressed("KeyC") && this.create.state === "closed") {
        if (this.quests.has("creation_unlocked")) this.create.open();
        else this.hud.toast("还没有筑语石——完成泊位整备后，岩会把它交给你。", 4);
      }
      if (input.wasPressed("KeyB")) this.hud.showBuildPanel(null, (c) => this.inv.canAfford(c));
      if (input.wasPressed("KeyI")) this.hud.showInventory(this.inv.export(), (id) => { this.interact.eat(id); this.hud.hidePanel(); }, (id) => { this.equipSwordVisual(id); this.hud.hidePanel(); });
      if (input.wasPressed("KeyK")) {
        this.hud.setAuthInventory(this.inv.export());
        this.hud.showNpcAuth(
          { zone: this.build.buildZone ? "家园空岛中央广场（已划定）" : "未划定（开始授权将划定在家园中心）", budget: this.build.buildBudget, parts: ["railing", "planter", "lantern", "floor", "table", "chair", "step"], paused: this.build.authorizationPaused, radius: this.build.buildZone?.radius },
          (zone, budget, parts, radius) => {
            if (!this.build.buildZone) {
              const home = this.world.islands[0];
              this.build.setBuildZone(home.root.position.add(new Vector3(0, (home.heightAt(home.root.position.x, home.root.position.z) ?? 0) + 0.05, 0)), radius);
            } else this.build.setBuildZone(this.build.buildZone.center, radius);
          this.build.authorizeBudget(budget, parts);
            this.hud.hidePanel();
            this.hud.toast("已授权：居民可在区域内用预算内材料建设。", 4);
            for (const npc of this.npcs) npc.remember("玩家划定了建设区域和预算，授权我们进行小型建设。", "authorize");
            void (this.npcs[0].decide());
            void (this.npcs[1].decide());
          },
          () => {
            this.build.revokeAuthorization();
            this.hud.hidePanel();
            this.hud.toast("已收回居民建设授权。", 3);
            void this.persist();
          },
          (paused) => {
            this.build.pauseAuthorization(paused);
            this.hud.hidePanel();
            this.hud.toast(paused ? "居民建设已暂停。" : "居民建设已继续。", 3);
            void this.persist();
          },
        );
      }
      if (input.wasPressed("KeyP")) void this.persist();
      if (input.wasPressed("KeyJ")) { if (this.projects.isBoardOpen) this.projects.closeBoard(); else this.projects.showBoard(); }
      if (input.wasPressed("KeyT")) this.pet.toggleStay();
      if (input.wasPressed("KeyY")) this.pet.recall();
      if (input.wasPressed("KeyQ")) this.chargeStrike();
    }
    this.hud.uiCapture = this.hud.dialogVisible() || this.hud.panelVisible();
    this.input.uiCapture = this.hud.uiCapture; // 玩家/船读取的是 Input 字段——统一单一来源
    if (this.input.uiCapture && document.pointerLockElement) this.input.releasePointerLock();
    // 建造操作
    if (this.build.mode === "place") {
      if (input.wasPressed("KeyR")) this.build.rotateGhost(Math.PI / 4);
      if (input.mouseLeftPressed) {
        const placed = this.build.confirmPlace();
        if (placed) {
          this.hud.toast(`放置了${BUILD_CATALOG.find((p) => p.id === placed.partId)?.name}`);
          if (placed.partId === "chair" || placed.partId === "stove" || placed.partId === "berth_stabilizer") this.refreshFacilities();
        }
      }
    } else if (!this.hud.panelVisible() && !this.hud.dialogVisible()) {
      if (input.wasPressed("KeyG")) {
        const b = this.build.nearestBuilding(3.2);
        if (b && this.build.enterMoveMode(b.uid)) this.hud.toast(`移动${BUILD_CATALOG.find((p) => p.id === b.partId)?.name}：左键确认，Esc 取消`);
      }
      if (input.wasPressed("KeyX")) {
        const b = this.build.nearestBuilding(3.2);
        if (b) {
          this.build.remove(b.uid, true);
          this.hud.toast(`拆除${BUILD_CATALOG.find((p) => p.id === b.partId)?.name}，返还一半材料`);
        }
      }
    }
  }

  /** 蓄力风斩（风锻台解锁）：20 体力、5m、45 伤害、1.5s 冷却 */
  private chargeStrike() {
    if (!this.projects.forgeUnlocked) { this.hud.toast("蓄力风斩还没解锁——先在风锻台整备武器。", 3); return; }
    if (this.player.equipped !== "windblade_sword") { this.hud.toast("需要装备风刃长剑才能使出风斩。", 3); return; }
    if (performance.now() < this.chargeCd) { this.hud.toast("风斩还在冷却。", 2); return; }
    if (!this.player.trySpendStamina(20)) { this.hud.toast("体力不足（风斩需要 20）。", 2); return; }
    this.chargeCd = performance.now() + 1500;
    const origin = this.player.node.position.add(new Vector3(0, 1.2, 0));
    // 玩家前方 = (sin(camYaw), 0, cos(camYaw))（与移动同向）
    const dir = new Vector3(Math.sin(this.player.camYaw), 0, Math.cos(this.player.camYaw));
    const hit = this.combat.meleeAttack("player", origin, dir, 5, 45);
    this.onGameEvent("charge_strike", { hit });
    this.hud.toast(hit ? "蓄力风斩命中！" : "风斩掠过空处。", 2);
  }

  private updateInteraction() {
    if (this.player.mode === "sail") {
      this.hud.setPrompt("W/S 前进减速 · A/D 转向 · 空格/Shift 升降 · F 停泊 · E 下舵");
      if (this.input.wasPressed("KeyE")) { this.player.mode = "walk"; this.player.setSailing(false); this.player.teleport(this.world.ship.deckBoardPos().add(new Vector3(0, 0.3, 0))); this.barsEnergy(false); }
      if (this.input.wasPressed("KeyF")) {
        const dock = this.world.ship.nearestDock(14);
        if (dock) this.world.ship.beginDock(dock);
        else this.hud.toast("附近没有可停泊的位置");
      }
      return;
    }
    if (this.player.mode === "sit") {
      this.hud.setPrompt("按 E 起身");
      if (this.input.wasPressed("KeyE")) {
        const seatUid = this.player.seatBuildingUid;
        this.player.standUp();
        const seat = this.interact.chairSeats.find((entry) => entry.uid === seatUid);
        if (seat?.occupant === "player") seat.occupant = null;
        this.interact.sitting = false;
        this.hud.setPrompt(null);
      }
      return;
    }
    const t = this.interact.findTarget(3.4);
    if (!t) {
      // 船交互
      const shipDist = Vector3.Distance(this.player.node.position, this.world.ship.pos);
      if (shipDist < 7) {
        this.hud.setPrompt("E 登上云舟");
        if (this.input.wasPressed("KeyE")) this.boardShip();
      } else this.hud.setPrompt(null);
      return;
    }
    const verb = t.kind === "pickup" ? "拾取" : t.kind === "chest" ? "打开" : t.kind === "sit" ? "坐下" : t.kind === "npc" ? "交谈" : "使用";
    this.hud.setPrompt(`E ${verb} · ${t.label}`);
    if (this.input.wasPressed("KeyE")) t.act("player");
  }

  private boardShip() {
    // 登船即出航：解除停泊状态，F 停泊 / 靠泊吸附才能正常闭合
    this.world.ship.undock();
    this.player.teleport(this.world.ship.deckBoardPos());
    this.player.mode = "sail";
    this.player.setSailing(true);
    this.player.camYaw = this.world.ship.root.rotation.y + Math.PI;
    this.barsEnergy(true);
    this.onGameEvent("boarded_ship");
    // M4：远征整备——口粮按本次出航 opId 只扣一次；不足则搭档留守
    this.journeyOpId = `exp-${Date.now()}`;
    this.journeyDocks = [];
    if (this.companion.active && !this.projects.provision(this.journeyOpId)) {
      this.companion.holdHome = true;
      this.hud.toast("岩：口粮不够……下次带块蒸饼再来叫我。（本次留守家园）", 5);
    }
    this.hud.toast("航行：寻找远方地标。风峡岛在西（-X），云间遗迹在东北（+X+Z）。", 6);
  }

  barsEnergy(show: boolean) { (this.hud as unknown as { _showEnergy?: boolean })._showEnergy = show; }

  /** 观测台箭头：指向最近未探索的固定岛（生成岛卸载后不在 islands 里，靠 landmarks 兜底） */
  private spawnObsArrow() {
    if (this.obsArrow) return;
    const tower = this.build.buildings.find((b) => b.partId === "obs_tower");
    if (!tower) return;
    const arrow = MeshBuilder.CreateCylinder("obsArrow", { height: 1.6, diameterTop: 0.05, diameterBottom: 0.42, tessellation: 6 }, this.scene);
    const mat = new StandardMaterial("obsArrowMat", this.scene);
    mat.emissiveColor = new Color3(0.25, 0.75, 1.0);
    mat.diffuseColor = new Color3(0.1, 0.3, 0.4);
    arrow.material = mat;
    arrow.isPickable = false;
    arrow.position.set(tower.pos.x, tower.pos.y + 4.4, tower.pos.z);
    this.obsArrow = arrow;
    this.updateObsArrow();
  }

  private updateObsArrow() {
    if (!this.obsArrow) return;
    const target = this.nearestUnexplored();
    if (!target) return;
    const dx = target.x - this.obsArrow.position.x, dz = target.z - this.obsArrow.position.z;
    // 圆锥默认指 +Y；先放倒成水平指 +Z，再按目标方位自转
    this.obsArrow.rotation.x = Math.PI / 2;
    this.obsArrow.rotation.y = Math.atan2(dx, dz);
  }

  private nearestUnexplored(): Vector3 | null {
    for (const isle of this.world.islands) {
      if (isle.def.id === "home" || isle.def.kind === "islet" || this.world.visited.has(isle.def.id)) continue;
      return isle.root.position.clone();
    }
    for (const lm of this.world.landmarks) {
      if (this.world.visited.has(lm.id)) continue;
      return lm.pos.clone();
    }
    return null;
  }

  equipSwordVisual(id: string | null) {
    if (!id) {
      this.player.setSword(null);
      return;
    }
    const model = this.luxSwordReady;
    if (model) {
      const node = new TransformNode("equippedSword", this.scene);
      const inst = new TransformNode("swordModel", this.scene);
      const entries = model.container.instantiateModelsToScene(undefined, false, { doNotInstantiate: true });
      for (const c of entries.rootNodes) c.parent = inst;
      inst.scaling.setAll(model.scale);
      // Ground alignment is only appropriate for placeable world instances;
      // the hand-bone attachment supplies the equipped model's transform.
      inst.position.y = 0;
      inst.parent = node;
      // 握持姿态：剑指向前上
      inst.rotation.set(Math.PI / 2, 0, 0);
      this.player.setSword(node);
      this.hud.toast("装备了风刃长剑（Lux3D）", 3);
    }
  }

  private updateHud() {
    this.hud.setBars({
      hp: this.player.hp, maxHp: this.player.maxHp,
      hunger: this.player.hunger,
      stamina: this.player.currentStamina, maxStamina: this.player.totalStamina,
      energy: this.world.ship.energy,
      showEnergy: this.player.mode === "sail" || ((this.hud as unknown as { _showEnergy?: boolean })._showEnergy ?? false),
    });
    // 罗盘
    const yaw = Math.atan2(this.camera.getTarget().x - this.camera.position.x, this.camera.getTarget().z - this.camera.position.z);
    let marks = "";
    const deg2 = (a: number) => ((a * 180 / Math.PI) + 360) % 360;
    const items: { a: number; label: string; color: string }[] = [];
    for (const l of this.world.landmarks) {
      const a = Math.atan2(l.pos.x - this.camera.position.x, l.pos.z - this.camera.position.z);
      items.push({ a, label: l.name, color: "#f0c878" });
    }
    for (const isle of this.world.islands) {
      if (isle.def.id === "home" || isle.def.kind === "islet") continue;
      const a = Math.atan2(isle.root.position.x - this.camera.position.x, isle.root.position.z - this.camera.position.z);
      items.push({ a, label: isle.def.name.split("·")[0], color: "#9fd8ef" });
    }
    const placedX: number[] = [];
    for (const it of items) {
      let rel = deg2(it.a - yaw) - 180;
      if (rel > 180) rel -= 360;
      if (rel < -180) rel += 360;
      const x = 210 + rel * 2.6;
      if (x < 4 || x > 416) continue;
      if (placedX.some((px) => Math.abs(px - x) < 44)) continue; // 同方位标签防重叠
      placedX.push(x);
      marks += `<div style="position:absolute; left:${x}px; top:6px; font-size:11px; color:${it.color}; transform:translateX(-50%); text-shadow:0 1px 2px #000; white-space:nowrap;">${it.label}</div>`;
    }
    marks += `<div style="position:absolute; left:50%; top:2px; width:1px; height:26px; background:rgba(255,255,255,.4);"></div>`;
    this.hud.setCompass(marks);
    // 任务
    const q = this.quests.states["first_expedition"], q2 = this.quests.states["berth_upgrade"];
    const steps = ["认识家园", "整备出发", "风峡探秘", "遗迹之岛", "返回家园"];
    let qhtml = `<div style="color:#f0c878;">◆ 第一次远征</div>`;
    steps.forEach((s, i) => {
      qhtml += `<div style="opacity:${i === q.step ? 1 : i < q.step ? 0.4 : 0.65};">${i < q.step ? "✔" : i === q.step ? "▶" : "·"} ${s}</div>`;
    });
    if (q.step >= 5 && q2.step < 4) {
      qhtml += `<div style="color:#f0c878; margin-top:6px;">◆ 泊位整备</div><div style="opacity:.9;">▶ ${["建造灶台", "布置生活区", "建造稳定装置", "家园升级"][q2.step]}</div>`;
    }
    this.hud.setQuest(qhtml);
    // 性能
    this.fpsSamples.push(1000 / Math.max(1, this.frameDeltaMs));
    if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    if (this.perfVisible) {
      const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / Math.max(1, this.fpsSamples.length);
      const st = this.streamer.stats();
      this.hud.setPerf(
        `FPS ${this.engine.getFps().toFixed(0)}（1s avg ${avg.toFixed(0)}）\n` +
        `draw ${this.scene.getActiveMeshes().length} · mesh ${this.scene.meshes.length}\n` +
        `pos ${this.player.node.position.asArray().map((n) => n.toFixed(0)).join(",")}\n` +
        `模式 ${this.player.mode} · 舟 ${this.world.ship.state} v=${this.world.ship.speed.toFixed(1)}\n` +
        `流式岛 载入${st.loaded} 生成中${st.generating} 失败${st.failed}\n` +
        `设施 ${this.build.buildings.length} · NPC 记忆 ${this.npcs.map((n) => n.memory.length).join("/")}`,
        true
      );
    }
  }

  perfVisible = false;

  private updateBeacon() {
    const q = this.quests.states["first_expedition"], q2 = this.quests.states["berth_upgrade"];
    let pos: Vector3 | null = null, label = "";
    const npcLing = this.npcs[0];
    if (q.step === 0) { pos = npcLing.node.position; label = "与居民交谈"; }
    else if (q.step === 1) { pos = this.world.ship.pos; label = "登上云舟"; }
    else if (q.step === 2) { pos = this.world.islands[1].root.position.add(new Vector3(0, 20, 0)); label = "风峡岛·收集风晶"; }
    else if (q.step === 3) { pos = this.world.islands[3].root.position.add(new Vector3(0, 16, 0)); label = "云间遗迹·寻找图纸"; }
    else if (q.step === 4) { pos = this.world.docks[0].pos; label = "返回家园泊位"; }
    else if (q2.step < 4) { pos = this.world.islands[0].root.position.add(new Vector3(0, 10, 0)); label = "家园建设与升级"; }
    this.quests.setBeacon(pos, label);
  }

  private updateBubbles() {
    const now = performance.now();
    for (const npc of this.npcs) {
      if (now < npc.sayUntil) this.hud.showBubble(npc.persona.id, npc.headWorldPos(), this.camera, this.scene, npc.sayText);
      else this.hud.hideBubble(npc.persona.id);
    }
  }

  /** 供验证脚本使用 */
  __test = {
    state: () => this.collectSave(),
    warpPlayer: (x: number, y: number, z: number) => this.player.teleport(new Vector3(x, y, z)),
    warpShip: (x: number, y: number, z: number) => { this.world.ship.root.position.set(x, y, z); this.world.ship.heading = this.world.ship.root.rotation.y; },
    give: (id: ItemId, n: number) => this.inv.add(id, n),
    mark: (flag: string) => this.quests.mark(flag),
    npc: (i: number) => this.npcs[i],
    build: () => this.build,
    interact: () => this.interact,
    player: () => this.player,
    freeFly: () => this.freeFly,
    toggleFreeFly: () => this.toggleFreeFly(),
    ship: () => this.world.ship,
    quests: () => this.quests,
    inv: () => this.inv,
    persist: () => this.persist(),
  };
}

function require_BabylonPointLight(): any {
  // 延迟取 PointLight，避免顶层重复导入
  const mod = (window as unknown as { __babylon?: any }).__babylon;
  return mod?.PointLight ?? (async () => (await import("@babylonjs/core")).PointLight);
}

void require_BabylonPointLight;

const game = new Game();
game.boot().catch((e) => {
  console.error(e);
  document.body.innerHTML += `<pre style="color:#fff; position:fixed; top:0; left:0; z-index:99;">启动失败: ${e}</pre>`;
});
