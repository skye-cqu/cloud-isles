import {
  CubeTexture, DirectionalLight, Mesh, Scene, ShadowGenerator, Vector3,
} from "@babylonjs/core";

interface ShadowMeshCandidate {
  name: string;
  isVisible: boolean;
  isEnabled(): boolean;
  getTotalVertices(): number;
  material: { name?: string; alpha?: number } | null;
}

const NON_SHADOW_NAMES = /skybox|cloud|puff|glow|spark|beam|effect|splat/i;

/** 只接入真正构成世界的可见几何，避免天空和半透明特效污染阴影图。 */
export function shouldConfigureShadowForMesh(mesh: ShadowMeshCandidate): boolean {
  if (!mesh.isVisible || !mesh.isEnabled() || mesh.getTotalVertices() === 0) return false;
  if (NON_SHADOW_NAMES.test(mesh.name) || NON_SHADOW_NAMES.test(mesh.material?.name ?? "")) return false;
  return (mesh.material?.alpha ?? 1) >= 0.98;
}

/** InstancedMesh 的 receiveShadows 无效，Babylon 需要把状态设置到其源网格。 */
export function shadowTargetForMesh<T extends object>(mesh: T): T {
  return (mesh as T & { sourceMesh?: T }).sourceMesh ?? mesh;
}

export function shouldUpdateShadowAnchor(anchor: Vector3 | null, cameraPosition: Vector3): boolean {
  return anchor === null || Vector3.DistanceSquared(cameraPosition, anchor) > 64;
}

function colorFace(top: string, bottom: string, horizon: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><linearGradient id="g" x2="0" y2="1"><stop stop-color="${top}"/><stop offset=".55" stop-color="${horizon}"/><stop offset="1" stop-color="${bottom}"/></linearGradient><rect width="32" height="32" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/**
 * 不依赖网络的低频天空/地表 cubemap。它给 PBR 金属提供真实的环境反射，
 * 同时让场景主色维持在现有暖晨光范围内。
 */
export function setupLighting(scene: Scene, sun: DirectionalLight): void {
  const warmSky = colorFace("#b9d8f2", "#8b806d", "#f2d1a5");
  const zenith = colorFace("#7fb1df", "#a8967f", "#b9d8f2");
  const ground = colorFace("#726b58", "#4d4a42", "#8b806d");
  const environment = new CubeTexture("", scene, { files: [warmSky, zenith, warmSky, warmSky, ground, warmSky] });
  scene.environmentTexture = environment;
  scene.environmentIntensity = 0.58;

  sun.position = new Vector3(-64, 88, -92);
  sun.shadowFrustumSize = 140;
  sun.shadowOrthoScale = 0;
  sun.autoUpdateExtends = false;
  sun.autoCalcShadowZBounds = false;
}

/**
 * 将阴影图限定在相机附近的活动区，以 1024 贴图维持可辨的角色和建筑投影；
 * 新加载的 GLB、角色和建造物会在后续帧自动加入。
 */
export function configureSceneShadows(scene: Scene, shadows: ShadowGenerator): void {
  const sun = shadows.getLight() as DirectionalLight;
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.darkness = 0.42;
  shadows.bias = 0.0002;
  shadows.normalBias = 0.025;
  shadows.forceBackFacesOnly = false;
  // 方向光随活动区移动，投影深度不应继承相机 6km 的远裁面，否则接触阴影精度不足。
  sun.shadowMinZ = 20;
  sun.shadowMaxZ = 300;

  const casterIds = new Set<number>();
  let frame = 0;
  let anchor: Vector3 | null = null;
  const update = () => {
    const cameraPosition = scene.activeCamera?.globalPosition;
    if (cameraPosition && shouldUpdateShadowAnchor(anchor, cameraPosition)) {
      // 8 米网格减少移动时的阴影抖动，同时在远征岛屿仍保持附近投影精度。
      anchor = new Vector3(
        Math.round(cameraPosition.x / 8) * 8,
        Math.round(cameraPosition.y / 8) * 8,
        Math.round(cameraPosition.z / 8) * 8,
      );
    }
    if (anchor) sun.position.copyFrom(anchor.subtract(sun.direction.scale(150)));

    for (const mesh of scene.meshes) {
      if (!shouldConfigureShadowForMesh(mesh)) continue;
      const target = shadowTargetForMesh(mesh);
      target.receiveShadows = true;
      if (!casterIds.has(target.uniqueId)) {
        shadows.addShadowCaster(target, false);
        casterIds.add(target.uniqueId);
      }
    }
  };

  update();
  scene.onBeforeRenderObservable.add(() => {
    if (++frame % 12 === 0) update();
  });
}
