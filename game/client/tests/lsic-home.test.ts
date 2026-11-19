import { describe, expect, it } from "vitest";
import { NullEngine, Scene, TransformNode } from "@babylonjs/core";
import {
  createHomeSurface, legacyHomeHeightAt, obstacleColliderSpec,
  homeRespawnState, isLegacyHomeDockedShip, needsHomeLsicV1Migration, recoverHomeBuildPosition,
  recoverHomeWalkPosition, makeVisualHomeMeshes, type HomeSurfaceData,
} from "../src/world/lsicHome";
import exportedSurface from "../public/assets/lsic/home-surface.json";
import visualV3Surface from "../public/assets/lsic/home-visual-v3/surface.json";
import { LOCAL_SAVE_DB_NAME } from "../src/core/save";

const surface: HomeSurfaceData = {
  version: 1,
  origin: [0, 0],
  step: 1,
  width: 3,
  depth: 3,
  heights: [0, 0, 0, 0, 2, 4, 0, 4, 8],
  dock: { pos: [2, 4, 2], rotY: -0.6 },
  obstacles: [{ x: 1, z: 1, width: 1, depth: 1, height: 3 }],
  buildZones: [{ x: 0.5, z: 0.5, radius: 1 }],
};

describe("LSIC 家园高度表", () => {
  it("视觉制作版使用独立本地存档，不覆写原家园档", () => {
    expect(LOCAL_SAVE_DB_NAME).toBe("cloud-isles-home-visual-v3");
  });

  it("正式导出覆盖出生、生活设施与泊位岸端", () => {
    const home = createHomeSurface(exportedSurface as HomeSurfaceData);

    // world-v2 岛(2026-11-03 LSIC 导出)为分层台地:断言结构性质而非固定标高,允许后续地形修订
    expect(exportedSurface.heights.filter((h) => h !== null).length).toBeGreaterThan(5000);
    expect(home.heightAt(0, 0)).not.toBeNull();
    expect(home.heightAt(8, 10)).toBeGreaterThan(15); // 出生点位于住宅高台层
    expect(home.canWalkAt(8, 10)).toBe(true);
    expect(home.heightAt(-17, -19)).not.toBeNull(); // 生活设施区(灶台/桌椅)
    expect(home.heightAt(-29, 1)).not.toBeNull();
    expect(home.heightAt(23.5, -6.5)).not.toBeNull(); // 登船栈道岸端(泊位台地边缘)
  });

  it("在四个采样点都有地表时作双线性高度插值", () => {
    const home = createHomeSurface(surface);

    expect(home.heightAt(0.5, 0.5)).toBe(0.5);
    expect(home.heightAt(1.5, 1.5)).toBe(4.5);
  });

  it("拒绝高度表外与缺失的地表", () => {
    const home = createHomeSurface({ ...surface, heights: [0, 0, 0, 0, null, 4, 0, 4, 8] });

    expect(home.heightAt(-0.1, 0)).toBeNull();
    expect(home.heightAt(0.5, 0.5)).toBeNull();
  });

  it("只允许平缓且不被生活建筑占用的建造位置", () => {
    const home = createHomeSurface({ ...surface, heights: Array(9).fill(0) });

    expect(home.canBuildAt(0.46, 0.46)).toBe(true);
    expect(home.canBuildAt(1.5, 1.5)).toBe(false);
    expect(createHomeSurface(surface).canBuildAt(1.8, 0.2)).toBe(false);
  });

  it("生活建筑的物理盒以地表为底并保持导出占地", () => {
    expect(obstacleColliderSpec(surface.obstacles[0], 7.5)).toEqual({
      x: 1, y: 9, z: 1, width: 1, height: 3, depth: 1,
    });
  });

  it("旧存档位于岛外或静态障碍时恢复到最近安全陆地", () => {
    const home = createHomeSurface({
      ...surface, width: 5, depth: 5, heights: Array(25).fill(7.5),
      dock: { pos: [3, 7.5, 3], rotY: -0.6 }, obstacles: [{ x: 2, z: 2, width: 1, depth: 1, height: 3 }],
      buildZones: [{ x: 2, z: 2, radius: 4 }],
    });

    expect(recoverHomeWalkPosition(home, 6, 2)).toEqual({ x: 3, y: 8.1, z: 2, moved: true });
    expect(recoverHomeWalkPosition(home, 2, 2)).toEqual({ x: 2, y: 8.1, z: 1, moved: true });
  });

  it("旧建筑迁到新可建面后保留相对旧地表的高度", () => {
    const home = createHomeSurface({
      ...surface, width: 5, depth: 5, heights: Array(25).fill(10),
      dock: { pos: [3, 10, 3], rotY: -0.6 }, obstacles: [{ x: 2, z: 2, width: 1, depth: 1, height: 3 }],
      buildZones: [{ x: 2, z: 2, radius: 4 }],
    });
    const savedY = legacyHomeHeightAt(2, 2)! + 1.25;
    const restored = recoverHomeBuildPosition(home, 2, savedY, 2);

    expect(restored).toMatchObject({ x: 2, z: 1, moved: true });
    expect(restored!.y - home.heightAt(restored!.x, restored!.z)!).toBeCloseTo(1.25, 6);
  });

  it("家园迁移只运行一次，后续保存载入不再改变建筑位置", () => {
    const home = createHomeSurface({
      ...surface, width: 5, depth: 5, heights: Array(25).fill(10),
      dock: { pos: [3, 10, 3], rotY: -0.6 }, obstacles: [{ x: 2, z: 2, width: 1, depth: 1, height: 3 }],
      buildZones: [{ x: 2, z: 2, radius: 4 }],
    });
    const first = recoverHomeBuildPosition(home, 2, legacyHomeHeightAt(2, 2)! + 0.35, 2)!;
    const second = needsHomeLsicV1Migration({ homeLsicV1: true })
      ? recoverHomeBuildPosition(home, first.x, first.y, first.z)!
      : first;

    expect(needsHomeLsicV1Migration({})).toBe(true);
    expect(second).toEqual(first);
  });

  it("只识别旧家园泊位的停泊云舟", () => {
    expect(isLegacyHomeDockedShip([26, 8, -20], true)).toBe(true);
    expect(isLegacyHomeDockedShip([26, 8, -20], false)).toBe(false);
    expect(isLegacyHomeDockedShip([-560, 15, -180], true)).toBe(false);
  });

  it("回生落在 LSIC 家园出生地，并恢复最低饱食", () => {
    const home = createHomeSurface(exportedSurface as HomeSurfaceData);
    const state = homeRespawnState(home);

    expect(state).toMatchObject({ x: 8, z: 10, hunger: 40, moved: false });
    expect(state.y).toBeCloseTo(home.heightAt(8, 10)! + 0.6, 3);
    expect(home.canWalkAt(state.x, state.z)).toBe(true);
  });

  it("v3 家园从导出的出生锚点回生，并暴露命名布局锚点", () => {
    const home = createHomeSurface(visualV3Surface as HomeSurfaceData);
    const state = homeRespawnState(home);

    expect(state).toMatchObject({ x: -53, z: 48, hunger: 40, moved: false });
    expect(state.y).toBeCloseTo(visualV3Surface.anchors.spawn[1] + 0.6, 3);
    expect(visualV3Surface.anchors.dock).toEqual(visualV3Surface.dock.pos);
    expect(home.canWalkAt(state.x, state.z)).toBe(true);
  });

  it("v3 在聚落北西侧保留高脊地标，同时东南泊位仍可步行", () => {
    const home = createHomeSurface(visualV3Surface as HomeSurfaceData);
    const peak = Math.max(...visualV3Surface.heights.filter((h): h is number => h !== null));
    expect(peak).toBeGreaterThan(64);
    expect(home.heightAt(visualV3Surface.dock.pos[0], visualV3Surface.dock.pos[2])).toBeCloseTo(visualV3Surface.dock.pos[1], 3);
    expect(home.canWalkAt(visualV3Surface.dock.pos[0], visualV3Surface.dock.pos[2])).toBe(true);
  });

  it("v3 可视顶面法线朝上，与地表碰撞三角形保持同一绕序", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const [top] = makeVisualHomeMeshes(scene, new TransformNode("root", scene), {
      ...surface, obstacles: [], heights: Array(9).fill(6),
    });
    const normals = top.getVerticesData("normal")!;
    expect(normals.filter((_, i) => i % 3 === 1).every((y) => y > 0.99)).toBe(true);
    scene.dispose(); engine.dispose();
  });
});
