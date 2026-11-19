import { AbstractMesh, Color3, Color4, DirectionalLight, HemisphericLight, PBRMaterial, PointLight, RawCubeTexture, Scene, ShaderMaterial, StandardMaterial, Texture, Vector3, Constants } from "@babylonjs/core";

type RGB = [number, number, number];
export interface DayCycleState {
  hour: number; skyTop: RGB; skyHorizon: RGB; fog: RGB; cloud: RGB;
  sunColor: RGB; ambient: RGB; sunIntensity: number; hemiIntensity: number;
  environmentIntensity: number; nightWeight: number;
}
type Key = Omit<DayCycleState, "hour"> & { hour: number };
const key = (hour: number, skyTop: RGB, skyHorizon: RGB, fog: RGB, cloud: RGB,
  sunColor: RGB, ambient: RGB, sunIntensity: number, hemiIntensity: number,
  environmentIntensity: number, nightWeight: number): Key =>
  ({ hour, skyTop, skyHorizon, fog, cloud, sunColor, ambient, sunIntensity, hemiIntensity, environmentIntensity, nightWeight });
const night = (h: number) => key(h, [.025,.045,.12], [.16,.21,.32], [.12,.17,.26], [.26,.33,.47], [.58,.7,1], [.38,.47,.67], .42,.34,.22,1);
const KEYS: Key[] = [night(0), night(5),
  key(6.5,[.29,.52,.76],[1,.76,.55],[.65,.74,.79],[.94,.86,.74],[1,.78,.56],[.68,.76,.86],1.15,.58,.45,.18),
  key(9,[.22,.49,.76],[.82,.9,.96],[.65,.78,.87],[.95,.97,1],[1,.94,.82],[.75,.83,.94],1.35,.65,.55,0),
  key(12,[.15,.41,.72],[.76,.88,.96],[.61,.76,.86],[.97,.98,1],[1,.97,.91],[.76,.83,.94],1.5,.62,.6,0),
  key(17.5,[.25,.32,.57],[1,.58,.33],[.57,.48,.57],[.97,.66,.43],[1,.58,.31],[.56,.6,.79],1.25,.48,.4,.5),
  key(19,[.075,.095,.23],[.49,.3,.37],[.25,.25,.37],[.44,.36,.48],[.67,.71,1],[.4,.44,.65],.4,.35,.23,.95),
  night(22), night(24)];
const rgb = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => v + (b[i]-v)*t) as RGB;
export function sampleDayCycle(playSeconds: number, overrideHour: number | null = null): DayCycleState {
  const hour = (((overrideHour ?? (8 + playSeconds / 60)) % 24) + 24) % 24;
  const i = KEYS.findIndex(k => k.hour > hour), a = KEYS[i-1], b = KEYS[i];
  const linear = (hour-a.hour)/(b.hour-a.hour), t = linear*linear*(3-2*linear);
  const state = { hour } as DayCycleState;
  for (const name of ["skyTop","skyHorizon","fog","cloud","sunColor","ambient"] as const) state[name] = rgb(a[name],b[name],t);
  for (const name of ["sunIntensity","hemiIntensity","environmentIntensity","nightWeight"] as const) state[name] = a[name]+(b[name]-a[name])*t;
  return state;
}

const isolated = new WeakSet<AbstractMesh>();
export function isolateNightMaterial(mesh: AbstractMesh): StandardMaterial | PBRMaterial | null {
  if (!(mesh.material instanceof StandardMaterial || mesh.material instanceof PBRMaterial)) return null;
  if (!isolated.has(mesh)) {
    mesh.material = mesh.material.clone(`${mesh.material.name}_night_${mesh.uniqueId}`);
    isolated.add(mesh);
  }
  return mesh.material as StandardMaterial | PBRMaterial;
}

/** One source of lighting state, including newly loaded houses and movable lanterns. */
export function createDayEnvironment(scene: Scene) {
  const sun = scene.getLightByName("sun") as DirectionalLight;
  const hemi = scene.getLightByName("hemi") as HemisphericLight;
  const sky = scene.getMaterialByName("skyMat") as ShaderMaterial;
  let overrideHour: number | null = null, frame = 0, previousBucket = -1;
  const originals = new WeakMap<PointLight, number>();
  const emitters = new Map<AbstractMesh, StandardMaterial | PBRMaterial>();
  const cubeFaces = (s: DayCycleState) => [s.skyHorizon,s.skyTop,s.skyHorizon,s.skyHorizon,s.fog,s.skyHorizon].map(c => new Uint8Array([...c.map(v=>Math.round(v*255)),255]));
  const reflection = new RawCubeTexture(scene, cubeFaces(sampleDayCycle(0)), 1, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, false, Texture.BILINEAR_SAMPLINGMODE);
  scene.environmentTexture?.dispose(); scene.environmentTexture = reflection;
  let current = sampleDayCycle(0);
  const update = (playSeconds: number) => {
    const s = current = sampleDayCycle(playSeconds, overrideHour);
    const angle = (s.hour-6)/12*Math.PI;
    const moon = Math.sin(angle) < 0;
    const toLight = new Vector3(Math.cos(angle)*(moon?-1:1), Math.max(.16, Math.abs(Math.sin(angle))), .38).normalize();
    sun.direction.copyFrom(toLight.negate()); sun.diffuse = Color3.FromArray(s.sunColor);
    // Fade the key light at the horizon before switching between sun and moon.
    sun.intensity = s.sunIntensity * Math.min(1, Math.abs(Math.sin(angle))*6);
    hemi.diffuse = Color3.FromArray(s.ambient); hemi.intensity = s.hemiIntensity;
    hemi.groundColor = Color3.FromArray(s.fog).scale(.58);
    scene.fogColor = Color3.FromArray(s.fog); scene.clearColor = new Color4(...s.fog, 1);
    scene.environmentIntensity = s.environmentIntensity;
    sky.setColor3("skyTop", Color3.FromArray(s.skyTop)); sky.setColor3("skyHorizon", Color3.FromArray(s.skyHorizon));
    sky.setVector3("sunDirection", toLight); sky.setColor3("sunColor", Color3.FromArray(s.sunColor)); sky.setFloat("nightWeight", s.nightWeight);
    const bucket = Math.floor(s.hour*12);
    if (bucket !== previousBucket) { reflection.update(cubeFaces(s), Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, false); previousBucket=bucket; }
    if (++frame % 12 === 1) {
      for (const mesh of scene.meshes) if (!emitters.has(mesh) && (mesh.metadata?.nightEmitter || /window_glow|buildGlow|night_window|night_lamp/i.test(mesh.name))) {
        const material = isolateNightMaterial(mesh); if (material) emitters.set(mesh, material);
      }
      const pos = scene.activeCamera?.globalPosition ?? Vector3.Zero();
      const lights = scene.lights.filter((light): light is PointLight => light instanceof PointLight);
      lights.sort((a,b)=>Vector3.DistanceSquared(a.position,pos)-Vector3.DistanceSquared(b.position,pos));
      lights.forEach((light,i)=>{
        if (!originals.has(light)) originals.set(light,light.intensity);
        light.intensity = originals.get(light)! * s.nightWeight;
        light.setEnabled(i<4 && s.nightWeight>.02);
      });
    }
    for (const [mesh, material] of emitters) {
      if (mesh.isDisposed()) { emitters.delete(mesh); continue; }
      material.emissiveColor = new Color3(1,.57,.22).scale(s.nightWeight*.85);
    }
    for (const material of scene.materials) if (/cloudFloorMat|distantLsicMat|distantIsle/i.test(material.name) && material instanceof StandardMaterial) {
      material.diffuseColor = Color3.FromArray(s.cloud);
      material.emissiveColor = Color3.FromArray(s.cloud).scale(/distant/i.test(material.name) ? .45 : .75);
    }
    for (const material of scene.materials) if (/^cloudFloorMat/.test(material.name) && material instanceof ShaderMaterial) {
      material.setColor3("cloudColor",Color3.FromArray(s.cloud));
      material.setColor3("fogColor",Color3.FromArray(s.fog));
    }
    for (const manager of scene.spriteManagers ?? []) if (manager.name === "cloudSprite") for (const sprite of manager.sprites) {
      sprite.color.r=s.cloud[0]; sprite.color.g=s.cloud[1]; sprite.color.b=s.cloud[2];
    }
    return s;
  };
  return { update, get state() { return current; }, setTimeOfDay(hour: number | null) { overrideHour=hour; previousBucket=-1; }, dispose() { emitters.clear(); reflection.dispose(); } };
}
