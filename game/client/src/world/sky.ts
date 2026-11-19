// 天空、光照与云海。视觉方向：暖调晨光 + 清晰空间层次（docs/planning-artifacts/visual-targets/20261101-v01）。
// 注意历史坑：浅色资产 + 强环境光会过曝，环境/阳光强度需要平衡。
import {
  Scene, Vector3, Color3, Color4, Mesh, MeshBuilder, StandardMaterial,
  HemisphericLight, DirectionalLight, ShaderMaterial, Texture,
  DynamicTexture, Quaternion, SceneLoader, TransformNode, Sprite, SpriteManager,
} from "@babylonjs/core";

export interface SkyDeps {
  scene: Scene;
  sunDir: Vector3;
}

/** 天空穹顶（垂直渐变着色）+ 太阳 + 环境光 + 平行光 + 阴影 */
export function createSky(scene: Scene, shadowCasters: { add: (m: Mesh) => void }) {
  const skybox = MeshBuilder.CreateBox("skybox", { size: 2000 }, scene);
  skybox.infiniteDistance = true;
  skybox.isPickable = false;
  const skyMat = new ShaderMaterial(
    "skyMat",
    scene,
    {
      vertexSource: `
        precision highp float;
        attribute vec3 position;
        uniform mat4 worldViewProjection;
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = worldViewProjection * vec4(position, 1.0);
        }`,
      fragmentSource: `
        precision highp float;
        varying vec3 vPos;
        uniform vec3 skyTop;
        uniform vec3 skyHorizon;
        uniform vec3 sunDirection;
        uniform vec3 sunColor;
        uniform float nightWeight;
        void main() {
          float h = normalize(vPos).y;
          vec3 zenith = skyTop;
          vec3 mid = mix(skyHorizon, skyTop, 0.56);
          vec3 horizon = skyHorizon;
          vec3 col = mix(horizon, mid, smoothstep(-0.02, 0.16, h));
          col = mix(col, zenith, smoothstep(0.12, 0.72, h));
          // 晨光太阳晕（东南偏上）
          vec3 sunDir = sunDirection;
          float s = max(dot(normalize(vPos), sunDir), 0.0);
          col += sunColor * pow(s, 450.0) * mix(1.1,0.65,nightWeight);
          col += sunColor * pow(s, 7.0) * 0.12;
          vec3 p = normalize(vPos)*650.0;
          float star = pow(fract(sin(dot(floor(p),vec3(127.1,311.7,74.7)))*43758.5453),170.0);
          col += vec3(star * nightWeight * smoothstep(0.08,0.45,h) * 0.55);
          gl_FragColor = vec4(col, 1.0);
        }`,
    },
    { attributes: ["position"], uniforms: ["worldViewProjection","skyTop","skyHorizon","sunDirection","sunColor","nightWeight"] }
  );
  // 相机位于盒体内侧；默认背面剔除会把完整的渐变天空剔掉。
  skyMat.backFaceCulling = false;
  skyMat.disableDepthWrite = true;
  skybox.material = skyMat;
  skybox.applyFog = false;
  skybox.alwaysSelectAsActiveMesh = true;

  const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), scene);
  hemi.intensity = 0.55;
  hemi.diffuse = new Color3(0.82, 0.84, 0.9);
  hemi.groundColor = new Color3(0.5, 0.48, 0.44);

  const sun = new DirectionalLight("sun", new Vector3(0.42, -0.58, 0.62).normalize(), scene);
  sun.intensity = 2.2;
  sun.diffuse = new Color3(1.0, 0.88, 0.7);
  sun.specular = new Color3(0.75, 0.68, 0.52);

  return { skybox, hemi, sun };
}

function makeCloudTexture(scene: Scene): Texture {
  const size = 256;
  const tex = new DynamicTexture("cloudTex", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  // 一团柔和云斑：中心密、边缘散
  const blobs = 34;
  for (let i = 0; i < blobs; i++) {
    const t = i / blobs;
    const cx = size * 0.5 + (Math.random() - 0.5) * size * (0.62 - t * 0.3);
    const cy = size * 0.5 + (Math.random() - 0.5) * size * (0.4 - t * 0.18);
    const r = size * (0.06 + Math.random() * 0.14);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(255,252,246,${0.6 - t * 0.25})`);
    g.addColorStop(0.6, `rgba(255,250,242,${0.3 - t * 0.14})`);
    g.addColorStop(1, "rgba(255,250,242,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

type DistantIslandSpot = [x: number, y: number, z: number, radius: number, rotY: number];

/** 远景岛群：LSIC 同源地形加载失败前保留简化回退，避免云海出现空洞。 */
function createDistantIslands(scene: Scene) {
  const group = new TransformNode("distantIslands", scene);
  const mat = new StandardMaterial("distantIsleMat", scene);
  mat.diffuseColor = new Color3(0.56, 0.64, 0.7);
  mat.specularColor = Color3.Black();
  mat.alpha = 0.86;
  const topMat = new StandardMaterial("distantIsleTopMat", scene);
  topMat.diffuseColor = new Color3(0.5, 0.62, 0.45);
  topMat.specularColor = Color3.Black();
  topMat.alpha = 0.86;
  const rng = (seed: number) => { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
  const rand = rng(20261101);
  const spots: DistantIslandSpot[] = [];
  for (let i = 0; i < 16; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = 1600 + rand() * 2000;
    spots.push([Math.cos(ang) * dist, -30 + rand() * 90, Math.sin(ang) * dist, 40 + rand() * 110, rand() * Math.PI]);
  }
  // 控制远景遮挡；位置与尺度仍来自原先固定种子的前十个点。
  const visibleSpots = spots.slice(0, 10);
  visibleSpots.forEach(([x, y, z, r, rotY], i) => {
    // 顶宽底窄，避免从家园望出去像一排白色倒锥占位物。
    const cone = MeshBuilder.CreateCylinder(`distIsle${i}`, { diameterTop: r, diameterBottom: r * 0.22, height: r * 1.5, tessellation: 10, subdivisions: 2 }, scene);
    cone.position.set(x, y - r * 0.75, z);
    cone.rotation.y = rotY;
    cone.material = mat;
    cone.isPickable = false;
    cone.applyFog = true;
    cone.parent = group;
    const cap = MeshBuilder.CreateCylinder(`distIsleTop${i}`, { diameterTop: r * 0.74, diameterBottom: r * 0.94, height: r * 0.16, tessellation: 10 }, scene);
    cap.position.set(x, y + r * 0.02, z);
    cap.rotation.y = cone.rotation.y;
    cap.material = topMat;
    cap.isPickable = false;
    cap.applyFog = true;
    cap.parent = group;
  });
  void replaceDistantFallback(scene, visibleSpots, group);
  return group;
}

async function replaceDistantFallback(scene: Scene, spots: readonly DistantIslandSpot[], fallback: TransformNode): Promise<void> {
  try {
    const container = await SceneLoader.LoadAssetContainerAsync("/assets/lsic/distant.glb", "", scene);
    const material = new StandardMaterial("distantLsicMat", scene);
    material.disableLighting = true;
    material.diffuseColor = new Color3(0.28, 0.36, 0.42);
    material.emissiveColor = new Color3(0.11, 0.16, 0.2);
    material.specularColor = Color3.Black();
    material.alpha = 0.78;

    let meshCount = 0;
    for (const [x, y, z, radius, rotY] of spots) {
      const entries = container.instantiateModelsToScene(undefined, false, { doNotInstantiate: true });
      if (!entries.rootNodes.length) continue;
      const root = new TransformNode("distantLsicIsland", scene);
      const scale = radius / 55;
      // 导出 bounds 顶端约 y=11.5；让每座岛与旧回退相同的顶面高度对齐。
      root.position.set(x, y - 11.5 * scale, z);
      root.rotation.y = rotY;
      root.scaling.setAll(scale);
      for (const node of entries.rootNodes) {
        let outer = node;
        while (outer.parent) outer = outer.parent;
        // 保留 glTF loader 的 scaling.z=-1，仅移除它额外附加的 Y=π。
        if (outer instanceof TransformNode) outer.rotationQuaternion = Quaternion.Identity();
        outer.parent = root;
      }
      for (const mesh of root.getChildMeshes()) {
        mesh.material = material;
        mesh.isPickable = false;
        mesh.receiveShadows = false;
        mesh.applyFog = true;
        meshCount++;
      }
    }
    if (meshCount > 0) fallback.setEnabled(false);
  } catch (error) {
    console.warn("[sky] LSIC distant islands unavailable; keeping fallback silhouettes", error);
  }
}

/** 云海：下方云毯 + 环绕漂浮云团 + 远景岛群 */
function cloudFloorMaterial(scene: Scene, layer: number): ShaderMaterial {
  const mat = new ShaderMaterial(`cloudFloorMat${layer}`, scene, {
    vertexSource: `precision highp float;
      attribute vec3 position;
      uniform mat4 world; uniform mat4 worldViewProjection;
      varying vec3 vWorld;
      void main(){ vWorld=(world*vec4(position,1.0)).xyz; gl_Position=worldViewProjection*vec4(position,1.0); }`,
    fragmentSource: `precision highp float;
      varying vec3 vWorld;
      uniform vec3 cloudColor; uniform vec3 fogColor; uniform vec3 cameraPosition;
      uniform float flow; uniform float layer;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
      float cloud(vec2 p){return noise(p)*.57+noise(p*2.03+7.3)*.28+noise(p*4.11+13.9)*.15;}
      void main(){
        vec2 p=vWorld.xz*.003+vec2(flow*.004,layer*12.7);
        float n=cloud(p); float edge=cloud(p+vec2(.17,-.12))-n;
        vec3 col=cloudColor*(.74+n*.35+edge*.65);
        float distanceFog=smoothstep(1000.0,3900.0,length(vWorld.xz-cameraPosition.xz));
        col=mix(col,fogColor,distanceFog*.8);
        float alpha=layer<.5?1.0:mix(.42,.94,smoothstep(.28,.72,n));
        gl_FragColor=vec4(col,alpha);
      }`
  }, { attributes:["position"], uniforms:["world","worldViewProjection","cloudColor","fogColor","cameraPosition","flow","layer"], needAlphaBlending: layer>0 });
  mat.backFaceCulling=false;
  mat.setColor3("cloudColor",new Color3(.94,.96,1)); mat.setColor3("fogColor",new Color3(.65,.77,.85));
  mat.setVector3("cameraPosition",Vector3.Zero()); mat.setFloat("flow",0); mat.setFloat("layer",layer);
  return mat;
}

export function createCloudSea(scene: Scene) {
  const cloudTex = makeCloudTexture(scene);

  const seaRoot = new TransformNode("cloudSea", scene);
  const layers: Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const disc = MeshBuilder.CreateDisc(`cloudFloor${i}`, { radius: 4200, tessellation: 48 }, scene);
    disc.rotation.x = Math.PI / 2;
    disc.position.y = -140 + i * 26;
    disc.isPickable = false;
    disc.applyFog = true;
    const mat = cloudFloorMaterial(scene,i);
    disc.material = mat;
    disc.parent = seaRoot;
    layers.push(disc);
  }

  const sm = new SpriteManager("cloudSprite", "", 260, { width: 256, height: 256 }, scene);
  sm.texture = cloudTex;
  sm.isPickable = false;
  const puffs: Sprite[] = [];
  for (let i = 0; i < 110; i++) {
    const s = new Sprite("puff", sm);
    const bank = i < 24;
    const ang = bank ? Math.floor(i/4)*Math.PI/3+(i%4)*.09 : Math.random() * Math.PI * 2;
    const rad = bank ? 235+(i%4)*38 : 500 + Math.pow(Math.random(), 0.6) * 1700;
    s.position.set(Math.cos(ang) * rad, bank ? -100+(i%4)*9 : -60 + Math.random() * 90, Math.sin(ang) * rad);
    s.width = bank ? 160+Math.random()*85 : 60 + Math.random() * 150;
    s.height = s.width * (0.4 + Math.random() * 0.3);
    s.color = new Color4(1, 1, 1, 0.5 + Math.random() * 0.35);
    puffs.push(s);
  }

  const distant = createDistantIslands(scene);

  return {
    seaRoot,
    puffs,
    update(dt: number, camPos: Vector3) {
      for (const mesh of layers) {
        const material=mesh.material as ShaderMaterial;
        material.setVector3("cameraPosition",camPos);
        material.setFloat("flow",performance.now()*.001);
      }
      layers[0].position.x = camPos.x * 0.92;
      layers[0].position.z = camPos.z * 0.92;
      layers[1].position.x = camPos.x * 0.85 + performance.now() * 0.0006;
      layers[1].position.z = camPos.z * 0.85;
      for (let i = 0; i < puffs.length; i++) {
        const p = puffs[i];
        p.position.x += dt * (2.5 + (i % 5) * 0.5);
        if (p.position.x > camPos.x + 2400) p.position.x = camPos.x - 2400;
      }
      void distant;
    },
  };
}
