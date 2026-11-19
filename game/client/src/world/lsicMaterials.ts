import { Color3, Mesh, Scene, ShaderStore, Texture } from "@babylonjs/core";
import { TriPlanarMaterial } from "@babylonjs/materials/triPlanar";
// 显式注册 GLSL 源码，再进行 Babylon.js 9.33.1 的局部兼容替换；不修改 node_modules。
import "@babylonjs/materials/triPlanar/triplanar.fragment";

export type LsicTerrainStyle = "grass" | "cliff" | "path";

const BROKEN_TRIPLANAR_NORMAL = "normalW=normalize((2.0*baseNormal.xyz-1.0)*tangentSpace);";
const FIXED_TRIPLANAR_NORMAL = "normalW=normalize(tangentSpace*(2.0*baseNormal.xyz-1.0));";

/**
 * Babylon.js 9.33.1 的 triplanar GLSL 将 tangent-space normal 以 vec3 * mat3
 * 相乘，会让水平面法线翻到下方并使受光地形近黑。WebGL2 使用此 GLSL store。
 */
export function applyTriPlanarNormalCompatibilityPatch(): void {
  const key = "triplanarPixelShader";
  const source = ShaderStore.ShadersStore[key];
  if (!source || source.includes(FIXED_TRIPLANAR_NORMAL)) return;
  if (!source.includes(BROKEN_TRIPLANAR_NORMAL)) {
    console.warn("[lsic] unknown TriPlanar shader layout; normal compatibility patch skipped");
    return;
  }
  ShaderStore.ShadersStore[key] = source.replace(BROKEN_TRIPLANAR_NORMAL, FIXED_TRIPLANAR_NORMAL);
}

/** 仅匹配 LSIC 导出的材质层名，不依赖 Babylon 重命名后的 terrain_primitiveN。 */
export function getLsicTerrainStyle(name: string): LsicTerrainStyle | null {
  if (/^terrain_topr$/i.test(name)) return "path";
  // topG 是家园 GLB 的主草地表面（未映射时会以默认材质渲染成灰白地表）
  if (/^terrain_(?:baselayer|topg)$/i.test(name)) return "grass";
  if (/^terrain_(?:topb|sideg|sider)$/i.test(name)) return "cliff";
  return null;
}

function terrainTexture(scene: Scene, name: string): Texture {
  return new Texture(`/assets/tex/${name}`, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
}

function triPlanar(scene: Scene, name: string, top: string, side: string, tileSize: number): TriPlanarMaterial {
  const material = new TriPlanarMaterial(name, scene);
  material.diffuseTextureX = terrainTexture(scene, `${side}_diff.jpg`);
  material.diffuseTextureY = terrainTexture(scene, `${top}_diff.jpg`);
  material.diffuseTextureZ = terrainTexture(scene, `${side}_diff.jpg`);
  material.normalTextureX = terrainTexture(scene, `${side}_nor.jpg`);
  material.normalTextureY = terrainTexture(scene, `${top}_nor.jpg`);
  material.normalTextureZ = terrainTexture(scene, `${side}_nor.jpg`);
  // TriPlanarMaterial 没有 roughness 插槽；压低镜面项可避免无 UV 地形变成写实亮毯。
  material.specularColor = new Color3(0.035, 0.035, 0.035);
  material.specularPower = 18;
  material.tileSize = tileSize;
  material.maxSimultaneousLights = 2;
  return material;
}

/**
 * 为没有 UV 的 LSIC 导出层接入世界空间三向投影。TriPlanarMaterial 使用标准
 * Babylon 灯光/阴影定义，因此仍会接收 configureSceneShadows 注册的投影。
 * 材质按场景缓存:运行时生成的岛屿反复加载/卸载共享同一组材质,不随岛泄漏。
 */
const sceneMaterialCache = new WeakMap<Scene, Map<LsicTerrainStyle, TriPlanarMaterial>>();

/** 供程序化家园代理和 LSIC 导出网格共用的地形材质。 */
export function homeTerrainMaterial(scene: Scene, style: LsicTerrainStyle): TriPlanarMaterial {
  applyTriPlanarNormalCompatibilityPatch();
  let materials = sceneMaterialCache.get(scene);
  if (!materials) {
    materials = new Map();
    sceneMaterialCache.set(scene, materials);
  }
  const cached = materials.get(style);
  if (cached) return cached;
  const created = style === "grass"
    ? triPlanar(scene, "lsicTerrainGrass", "aerial_grass_rock", "cliff_side", 7)
    : style === "path"
      ? triPlanar(scene, "lsicTerrainPath", "old_stone_wall_02", "old_stone_wall_02", 2.2)
      : triPlanar(scene, "lsicTerrainCliff", "cliff_side", "cliff_side", 5);
  materials.set(style, created);
  return created;
}

export function applyLsicTerrainMaterials(scene: Scene, meshes: readonly Mesh[]): void {
  for (const mesh of meshes) {
    const style = getLsicTerrainStyle(mesh.material?.name ?? "");
    if (style) mesh.material = homeTerrainMaterial(scene, style);
  }
}
