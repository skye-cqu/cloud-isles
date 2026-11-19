// 飞舟引擎内可用性验收：加载体素 + 碰撞体，用第一人称胶囊实际走一遍
// 甲板 → 船楼下层 → 甲板 → 外梯 → 露台 → 船楼上层 → 甲板 → 舱口梯 → 底舱。
// 通过 window.__airship 暴露脚本化行走接口，供无头浏览器驱动并截图取证据。
import {
  Color3, Color4, DirectionalLight, Engine, HavokPlugin, HemisphericLight,
  ImportMeshAsync, Mesh, MeshBuilder, PhysicsAggregate, PhysicsMotionType,
  PhysicsShapeType, Ray, Scene, StandardMaterial, TargetCamera, Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { GLTFLoaderCoordinateSystemMode } from "@babylonjs/loaders/glTF";
import HavokPhysics from "@babylonjs/havok";

type Vec3 = { x: number; y: number; z: number };
type Waypoint = { x: number; z: number; y?: number; note: string; radius?: number };

const canvas = document.getElementById("render") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const routeEl = document.getElementById("route") as HTMLDivElement;

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });
engine.resize();
const scene = new Scene(engine);
// Babylon 只在确定性锁步模式下通知 onBeforeStepObservable；角色速度必须在物理步进前写入
// @babylonjs/core 里这两个 setter 在 Engine 子类（ThinEngine）上，类型声明不全，照引擎源码直接写属性
(engine as any).setDeterministicLockStep?.(true);
(engine as any).setLockstepMaxSteps?.(4);
(engine as any)._deterministicLockstep = true;
(engine as any)._lockstepMaxSteps = 4;
scene.clearColor = new Color4(0.62, 0.78, 0.93, 1);

const sun = new DirectionalLight("sun", new Vector3(-0.45, -1, -0.35), scene);
sun.position = new Vector3(30, 48, 26);
sun.intensity = 2.4;
sun.diffuse = new Color3(1.0, 0.94, 0.86);
const hemi = new HemisphericLight("hemi", new Vector3(0.1, 1, 0.1), scene);
hemi.intensity = 0.55;
hemi.diffuse = new Color3(0.78, 0.86, 1.0);
hemi.groundColor = new Color3(0.42, 0.4, 0.36);

const havok = await HavokPhysics({ locateFile: () => "/havok/HavokPhysics.wasm" });
scene.enablePhysics(new Vector3(0, -17, 0), new HavokPlugin(true, havok));

// ---------------------------------------------------------------- ship
// glTF 资产已经是 Y-up、+Z 向前，和 Babylon 约定一致。加载器默认会再套一层
// __root__（绕 Y 180° + z 取负）把整个船镜像到另一侧，楼梯、舱口、船楼内部全部错位。
// 这里把所有导入统一走 RIGHT_HANDED，再手动摆正：船头朝 +x。
const importOpts = { pluginOptions: { gltf: { coordinateSystemMode: GLTFLoaderCoordinateSystemMode.FORCE_RIGHT_HANDED } } };
const visual = await ImportMeshAsync("/airship/airship.glb", scene, importOpts);
const collider = await ImportMeshAsync("/airship/airship_collision.glb", scene, importOpts);
// 检查器：列出两个文件的所有顶层节点实际变换
(window as any).__roots = [visual.meshes, collider.meshes].map((ms) => ms.filter((m) => !m.parent).map((m) => ({ n: m.name, t: m.position.asArray(), r: m.rotation.asArray(), s: m.scaling.asArray() })));
{
  let mn = new Vector3(1e9, 1e9, 1e9), mx = new Vector3(-1e9, -1e9, -1e9);
  for (const m of visual.meshes) {
    const bb = m.getBoundingInfo?.().boundingBox;
    if (!bb) continue;
    mn = Vector3.Minimize(mn, bb.minimumWorld);
    mx = Vector3.Maximize(mx, bb.maximumWorld);
  }
  (window as any).__shipBounds = { mn: [mn.x, mn.y, mn.z], mx: [mx.x, mx.y, mx.z] };
}
const colliderMeshes = collider.meshes.filter((m) => (m as Mesh).getTotalVertices?.() > 0) as Mesh[];
for (const m of colliderMeshes) {
  m.isVisible = false;
  m.isPickable = false;
  const agg = new PhysicsAggregate(m, PhysicsShapeType.MESH, { mass: 0, friction: 0.55, restitution: 0 }, scene);
  agg.body.setMotionType(PhysicsMotionType.STATIC);
}
for (const m of visual.meshes) m.receiveShadows = false;

// ---------------------------------------------------------------- player
const SPAWN = new Vector3(6.0, 1.35, 0.0);
const capsule = MeshBuilder.CreateCapsule("player", { radius: 0.42, height: 1.84, tessellation: 10 }, scene);
const skin = new StandardMaterial("playerMat", scene);
skin.diffuseColor = new Color3(0.92, 0.42, 0.30);
skin.emissiveColor = new Color3(0.15, 0.05, 0.03);
capsule.material = skin;
capsule.position.copyFrom(SPAWN);
const body = new PhysicsAggregate(capsule, PhysicsShapeType.CAPSULE, { mass: 72, friction: 0.16, restitution: 0 }, scene);
const __colHits: string[] = [];
body.body.setCollisionCallbackEnabled(true);
body.body.getCollisionObservable().add((ev: any) => {
  const n = ev.collider?.transformNode?.name ?? ev.collider?.name ?? "?";
  if (!__colHits.includes(n)) __colHits.push(n);
});
body.body.setMotionType(PhysicsMotionType.DYNAMIC);
body.body.setMassProperties({ mass: 72, inertia: Vector3.Zero() });
body.body.setAngularDamping(1);
body.body.setLinearDamping(0.0);

const camera = new TargetCamera("cam", new Vector3(SPAWN.x + 1, SPAWN.y + 6, SPAWN.z + 12), scene);
camera.fov = 0.9;
camera.minZ = 0.1;
let camYaw = 2.5;
let mkId = 0;
let freeCam: { p: Vector3; t: Vector3 } | null = null;

// ---------------------------------------------------------------- input
const keys = new Set<string>();
let pointerDown = false;
addEventListener("keydown", (e) => { keys.add(e.key.toLowerCase()); if (e.key === " ") e.preventDefault(); });
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
canvas.addEventListener("pointerdown", () => { pointerDown = true; });
addEventListener("pointerup", () => { pointerDown = false; });
addEventListener("pointermove", (e) => { if (pointerDown) camYaw -= e.movementX * 0.004; });

// ---------------------------------------------------------------- autopilot
const LADDER = { x0: -1.62, x1: -0.72, z0: -0.95, z1: 0.95, top: 0.55, bottom: -2.35 };

let target: Waypoint | null = null;
let climb = 0; // -1 down, +1 up while on the ladder
const log: { note: string; x: number; y: number; z: number; t: number }[] = [];
let grounded = false;
let lastY = 0;
let blocked = 0; // 被高于台阶高度的障碍挡住的时间，用来触发跳跃
let onLadder = false;

/** 向下打射线找脚下的碰撞面；返回命中高度或 null。 */
function supportHeight(): number | null {
  const origin = capsule.position.clone().add(new Vector3(0, -0.85, 0));
  const hit = scene.pickWithRay(
    new Ray(origin, new Vector3(0, -1, 0), 1.6),
    (m) => colliderMeshes.includes(m as Mesh),
  );
  return hit && hit.hit && hit.pickedPoint ? hit.pickedPoint.y : null;
}

function setTarget(w: Waypoint) {
  target = { radius: 0.55, ...w };
}

function step(dt: number) {
  const p = capsule.position;
  const vel = body.body.getLinearVelocity();

  // 梯子区域：上下由 climb 驱动
  // 只有已经下到甲板以下、或者正在主动攀爬时才算在梯子上；
  // 否则站在舱口旁边的甲板上会被判成“梯子上”而冻结。
  const inLadderZone = p.x > LADDER.x0 && p.x < LADDER.x1 && p.z > LADDER.z0 && p.z < LADDER.z1 &&
    p.y > LADDER.bottom - 0.4 && p.y < LADDER.top + 1.2;
  // 还要真的在梯子开口上方：舱口洞在舱口框内，框外是甲板
  const inHole = p.x > LADDER.x1 && p.x < LADDER.x0 && Math.abs(p.z) < LADDER.z1;
  onLadder = inLadderZone && (climb !== 0 || (p.y < LADDER.top && inHole));

  const gh = supportHeight();
  const resting = Math.abs(vel.y) < 0.35 && Math.abs(p.y - lastY) < 0.004;
  grounded = (gh !== null && gh > p.y - 1.02 && p.y - gh < 1.05) || resting;
  lastY = p.y;

  let want = new Vector3(0, 0, 0);
  if (target) {
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < (target.radius ?? 0.55)) {
      log.push({ note: target.note, x: p.x, y: p.y, z: p.z, t: performance.now() });
      target = null;
      blocked = 0;
    } else {
      want.set(dx / d, 0, dz / d);
    }
  } else {
    const f = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    const s = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
    if (f || s) {
      const cos = Math.cos(camYaw), sin = Math.sin(camYaw);
      want.set(f * sin + s * cos, 0, f * cos - s * sin).normalize();
    }
  }

  if (onLadder) {
    const up = climb > 0 || (climb === 0 && (keys.has("w") || keys.has("arrowup")));
    const down = climb < 0 || (climb === 0 && (keys.has("s") || keys.has("arrowdown")));
    const vy = up ? 2.4 : down ? -2.4 : 0;
    body.body.setLinearVelocity(new Vector3(want.x * 0.45, vy, want.z * 0.45));
    if (vy === 0) body.body.setLinearVelocity(new Vector3(0, 0.01, 0));
    return;
  }

  const SPEED = 2.9;
  const accel = grounded ? 16 : 5;
  // 台阶辅助：角色控制器没有 step offset 时，0.27m 的楼梯会被当成墙
  let stepLift = 0;
  if (grounded && (want.x || want.z)) {
    const probe = capsule.position.add(new Vector3(want.x * 0.55, 0, want.z * 0.55));
    const ahead = scene.pickWithRay(new Ray(probe.add(new Vector3(0, 0.45, 0)), new Vector3(0, -1, 0), 1.5),
      (m) => colliderMeshes.includes(m as Mesh));
    if (ahead && ahead.hit && ahead.pickedPoint) {
      const rise = ahead.pickedPoint.y - (p.y - 0.92);
      if (rise > 0.06 && rise < 0.52) stepLift = 2.6;
    }
  }
  const tvx = want.x * SPEED;
  const tvz = want.z * SPEED;
  const k = Math.min(1, accel * dt);
  let vx = vel.x + (tvx - vel.x) * k;
  let vz = vel.z + (tvz - vel.z) * k;
  let vy = vel.y;
  if (stepLift > 0) vy = Math.max(vy, stepLift);
  // 真人遇到箱子/矮墙会跳过去：卡住超过 0.45s 就起跳
  const moving = Math.hypot(vel.x, vel.z);
  if (grounded && (want.x || want.z) && moving < 0.45) blocked += dt; else blocked = 0;
  if (blocked > 0.45) { vy = 6.6; blocked = 0; }
  if (grounded && (keys.has(" ") || keys.has("space"))) vy = 6.6;
  body.body.setLinearVelocity(new Vector3(vx, vy, vz));
}

// 物理步进前写入速度：写在 onBeforeRender 里读到的是本帧积分前的值，会把重力反复清零。
scene.onBeforeStepObservable.add(() => {
  step(Math.min(engine.getDeltaTime() / 1000, 0.05));
});

scene.onBeforeRenderObservable.add(() => {

  const p = capsule.position;
  if (freeCam) {
    camera.position.copyFrom(freeCam.p);
    camera.setTarget(freeCam.t);
    return;
  }
  // 追随相机
  const dist = 9.0;
  camera.position.set(p.x + Math.sin(camYaw) * dist, p.y + 3.6, p.z + Math.cos(camYaw) * dist);
  camera.setTarget(new Vector3(p.x, p.y + 0.5, p.z));

  const mode = onLadder ? "ladder" : grounded ? "ground" : "air";
  hud.innerHTML =
    `pos ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}\n` +
    `vel ${body.body.getLinearVelocity().length().toFixed(2)}  mode <span class="${grounded || onLadder ? "ok" : "bad"}">${mode}</span>\n` +
    `target ${target ? `${target.note} → ${target.x.toFixed(1)},${target.z.toFixed(1)}` : "—"}`;
});

// ---------------------------------------------------------------- harness API
type HarnessState = {
  ready: boolean; x: number; y: number; z: number; grounded: boolean; onLadder: boolean;
  target: string | null; log: typeof log; visuals: number; colliders: number;
};
const api = {
  ready: true,
  visuals: visual.meshes.length,
  colliders: colliderMeshes.length,
  teleport(x: number, y: number, z: number) {
    body.body.disablePreStep = false;
    capsule.position.set(x, y, z);
    body.body.setLinearVelocity(Vector3.Zero());
    target = null;
  },
  goTo(x: number, z: number, note: string, y?: number) { setTarget({ x, z, y, note }); },
  climb(dir: number) { climb = dir; },
  stop() { target = null; climb = 0; },
  bounds() { return (window as any).__shipBounds; },
  colHits() { return __colHits.slice(); },
  diag() {
    return {
      physOn: scene.isPhysicsEnabled(),
      grav: scene.getPhysicsEngine()?.gravity?.asArray() ?? null,
      bodyType: body.body.getMotionType(),
      capPos: capsule.position.asArray(),
      capAggPos: (capsule as any).physicsBody?.transformNode?.position?.asArray?.() ?? null,
      vel: body.body.getLinearVelocity().asArray(),
      frames: engine.frameId,
      colliderAggs: colliderMeshes.map((m) => ({ n: m.name, b: !!(m as any).physicsBody, mt: (m as any).physicsBody?.getMotionType?.() })),
    };
  },
  look(dir: string) {
    const d: Record<string, number> = { front: 0, back: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 };
    camYaw = d[dir] ?? 0;
  },
  probeDown(x: number, y: number, z: number) {
    const hit = scene.pickWithRay(new Ray(new Vector3(x, y, z), new Vector3(0, -1, 0), 30),
      (m) => colliderMeshes.includes(m as Mesh));
    return hit && hit.hit ? { y: hit.pickedPoint?.y, d: hit.distance } : null;
  },
  /** 竖直打穿：沿一条竖线收集所有三角面交点，得到楼板/屋面分层高度。 */
  multi(x: number, z: number) {
    const ys: number[] = [];
    for (const m of colliderMeshes) {
      const idx = m.getIndices(); const pos = m.getVerticesData("position");
      if (!idx || !pos) continue;
      const wm = m.getWorldMatrix();
      for (let t = 0; t < idx.length; t += 3) {
        const tri: Vector3[] = [];
        for (let k = 0; k < 3; k++) {
          const i = idx[t + k] * 3;
          tri.push(Vector3.TransformCoordinates(new Vector3(pos[i], pos[i + 1], pos[i + 2]), wm));
        }
        // 2D point-in-triangle on XZ, then interpolate Y
        const [a, b2, c] = tri;
        const d = (b2.z - c.z) * (a.x - c.x) + (c.x - b2.x) * (a.z - c.z);
        if (Math.abs(d) < 1e-9) continue;
        const l1 = ((b2.z - c.z) * (x - c.x) + (c.x - b2.x) * (z - c.z)) / d;
        const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        ys.push(l1 * a.y + l2 * b2.y + l3 * c.y);
      }
    }
    ys.sort((p1, p2) => p2 - p1);
    const out: number[] = [];
    for (const y of ys) if (!out.length || Math.abs(out[out.length - 1] - y) > 0.06) out.push(+y.toFixed(2));
    return out;
  },
  /** 碰撞体可视化：红色半透明线框，用于人工核对碰撞面位置。 */
  /** 碰撞体单文件模式：隐藏外观，只加载碰撞体网格；配合 multi() 定位引擎里的真实几何。 */
  async soloCollider(on: boolean) {
    for (const m of visual.meshes) m.setEnabled(!on);
  },
  showColliders(on: boolean) {
    for (const m of colliderMeshes) {
      m.isVisible = on;
      m.alwaysSelectAsActiveMesh = true;
      if (on) {
        const mat = new StandardMaterial("coll", scene);
        mat.diffuseColor = new Color3(1.0, 0.2, 0.55);
        mat.emissiveColor = new Color3(0.55, 0.05, 0.25);
        mat.alpha = 1.0; mat.wireframe = false;
        m.material = mat;
      }
    }
  },
  /** 只看碰撞体：隐藏外观网格，用于核对碰撞面覆盖范围。 */
  showVisual(on: boolean) {
    for (const m of visual.meshes) m.setEnabled(on);
  },
  /** 只看某个外观对象（按名字前缀），用来定位穿模的部件。 */
  isolate(prefix: string | null) {
    for (const m of visual.meshes) m.setEnabled(!prefix || m.name.startsWith(prefix));
  },
  /** 统计某个高度带内碰撞体三角形的 x/z 范围，用来定位几何在哪。 */
  slice(y0: number, y1: number) {
    let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9, n = 0;
    for (const m of colliderMeshes) {
      m.computeWorldMatrix(true);
      const idx = m.getIndices(); const pos = m.getVerticesData("position");
      if (!idx || !pos) continue;
      const wm = m.getWorldMatrix();
      const v = new Vector3();
      for (let i = 0; i < idx.length; i += 3) {
        Vector3.TransformCoordinatesFromFloatsToRef(pos[idx[i] * 3], pos[idx[i] * 3 + 1], pos[idx[i] * 3 + 2], wm, v);
        if (v.y < y0 || v.y > y1) continue;
        n++; mnx = Math.min(mnx, v.x); mxx = Math.max(mxx, v.x);
        mnz = Math.min(mnz, v.z); mxz = Math.max(mxz, v.z);
      }
    }
    return n ? { n, x: [+mnx.toFixed(2), +mxx.toFixed(2)], z: [+mnz.toFixed(2), +mxz.toFixed(2)] } : { n: 0 };
  },
  /** 同一高度带内同时统计外观与碰撞体的顶点，用来判断碰撞体是否真的漏了部件。 */
  compareBand(y0: number, y1: number, x0 = -20, x1 = 20) {
    const scan = (list: Mesh[]) => {
      let n = 0; const zs: number[] = [];
      for (const m of list) {
        const pos = m.getVerticesData("position");
        if (!pos) continue;
        const wm = m.getWorldMatrix();
        for (let i = 0; i < pos.length / 3; i++) {
          const v = Vector3.TransformCoordinatesFromFloatsToRef(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], wm, new Vector3());
          if (v.y < y0 || v.y > y1 || v.x < x0 || v.x > x1) continue;
          n++; if (zs.length < 6) zs.push(+v.z.toFixed(2));
        }
      }
      return { n, zs };
    };
    return {
      visual: scan(visual.meshes.filter((m) => (m as Mesh).getTotalVertices?.() > 0) as Mesh[]),
      collider: scan(colliderMeshes),
    };
  },
  /** 在给定的 x/y 窗口里按 z 分桶统计外观与碰撞体顶点，直接看出部件落在哪一侧。 */
  zBuckets(x0: number, x1: number, y0: number, y1: number, step = 0.5) {
    const scan = (list: Mesh[]) => {
      const b: Record<string, number> = {};
      for (const m of list) {
        m.computeWorldMatrix(true);
        const pos = m.getVerticesData("position");
        if (!pos) continue;
        const wm = m.getWorldMatrix();
        for (let i = 0; i < pos.length / 3; i++) {
          const v = Vector3.TransformCoordinatesFromFloatsToRef(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], wm, new Vector3());
          if (v.x < x0 || v.x > x1 || v.y < y0 || v.y > y1) continue;
          const k = (Math.floor(v.z / step) * step).toFixed(1);
          b[k] = (b[k] ?? 0) + 1;
        }
      }
      return b;
    };
    return { visual: scan(visual.meshes.filter((m) => (m as Mesh).getTotalVertices?.() > 0) as Mesh[]), collider: scan(colliderMeshes) };
  },
  /** 高度带内按 x 分区、按 z 正负统计外观与碰撞体顶点，用于判断内部部件是否落在另一侧。 */
  compareBandHist(y0: number, y1: number) {
    const scan = (list: Mesh[]) => {
      const out: Record<string, { pos: number; neg: number; min: number; max: number }> = {};
      for (const m of list) {
        m.computeWorldMatrix(true);
        const pos = m.getVerticesData("position");
        if (!pos) continue;
        const wm = m.getWorldMatrix();
        for (let i = 0; i < pos.length / 3; i++) {
          const v = Vector3.TransformCoordinatesFromFloatsToRef(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], wm, new Vector3());
          if (v.y < y0 || v.y > y1) continue;
          const k = Math.floor(v.x / 2) * 2;
          const e = (out[k] ??= { pos: 0, neg: 0, min: 9, max: -9 });
          if (v.z >= 0) e.pos++; else e.neg++;
          e.min = Math.min(e.min, +v.z.toFixed(2)); e.max = Math.max(e.max, +v.z.toFixed(2));
        }
      }
      return out;
    };
    return { visual: scan(visual.meshes.filter((m) => (m as Mesh).getTotalVertices?.() > 0) as Mesh[]), collider: scan(colliderMeshes) };
  },
  /** 限定 x 区间与高度带，返回该处三角形顶点的 z 分布，用来看部件落在哪一侧。 */
  sliceXZ(x0: number, x1: number, y0: number, y1: number) {
    const zs: number[] = [];
    for (const m of colliderMeshes) {
      const idx = m.getIndices(); const pos = m.getVerticesData("position");
      if (!idx || !pos) continue;
      const wm = m.getWorldMatrix(); const v = new Vector3();
      for (let i = 0; i < idx.length; i += 3) {
        Vector3.TransformCoordinatesFromFloatsToRef(pos[idx[i] * 3], pos[idx[i] * 3 + 1], pos[idx[i] * 3 + 2], wm, v);
        // 注意 glTF 轴向：导入后几何是 y-up，这里 v 已是世界坐标，直接比较
        if (v.x < Math.min(x0, x1) || v.x > Math.max(x0, x1) || v.y < y0 || v.y > y1) continue;
        zs.push(+v.z.toFixed(2));
      }
    }
    zs.sort((a, b) => a - b);
    return { n: zs.length, min: zs[0] ?? null, max: zs[zs.length - 1] ?? null, sample: zs.slice(0, 8) };
  },
  /** 外观/碰撞体的世界包围盒与世界矩阵分解，用于核对两者是否错位。 */
  transforms() {
    const box = (list: Mesh[]) => {
      const mn = new Vector3(1e9, 1e9, 1e9), mx = new Vector3(-1e9, -1e9, -1e9);
      for (const m of list) {
        const bb = m.getBoundingInfo?.().boundingBox;
        if (!bb) continue;
        mn.minimizeInPlace(bb.minimumWorld); mx.maximizeInPlace(bb.maximumWorld);
      }
      return { mn: mn.asArray().map((v) => +v.toFixed(2)), mx: mx.asArray().map((v) => +v.toFixed(2)) };
    };
    const dec = (m: Mesh) => {
      const wm = m.getWorldMatrix();
      const sc = new Vector3(), q = new Vector3(), t = new Vector3();
      wm.decompose(sc, q as any, t);
      return { name: m.name, pos: t.asArray().map((v) => +v.toFixed(2)), scale: sc.asArray().map((v) => +v.toFixed(3)),
               parent: m.parent?.name ?? null };
    };
    return {
      visual: box(visual.meshes.filter((m) => (m as Mesh).getTotalVertices?.() > 0) as Mesh[]),
      collider: box(colliderMeshes),
      colliderNodes: colliderMeshes.map(dec),
      visualRoots: visual.meshes.filter((m) => !m.parent).map((m) => dec(m as Mesh)),
      colliderRoots: collider.meshes.filter((m) => !m.parent).map((m) => dec(m as Mesh)),
    };
  },
  /** 在引擎坐标上打标记球，用来肉眼核对几何到底在哪。 */
  marker(x: number, y: number, z: number, color = "#ff00aa") {
    const m = MeshBuilder.CreateSphere(`mk${mkId++}`, { diameter: 0.35, segments: 8 }, scene);
    const mat = new StandardMaterial(`mkMat${mkId}`, scene);
    mat.emissiveColor = Color3.FromHexString(color);
    mat.disableLighting = true;
    m.material = mat;
    m.position.set(x, y, z);
    m.isPickable = false;
    return m.name;
  },
  clearMarkers() { for (const m of scene.meshes) if (m.name.startsWith("mk") && !m.name.startsWith("mkMat")) m.dispose(); },
  /** 在给定 x/z 窗口里按 y 分桶统计顶点，用来判断几何是否被沿 Y 镜像。 */
  yBuckets(x0: number, x1: number, z0: number, z1: number, step = 0.2) {
    const scan = (list: Mesh[]) => {
      const b: Record<string, number> = {};
      for (const m of list) {
        m.computeWorldMatrix(true);
        const pos = m.getVerticesData("position");
        if (!pos) continue;
        const wm = m.getWorldMatrix();
        for (let i = 0; i < pos.length / 3; i++) {
          const v = Vector3.TransformCoordinatesFromFloatsToRef(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], wm, new Vector3());
          if (v.x < x0 || v.x > x1 || v.z < z0 || v.z > z1) continue;
          const k = (Math.floor(v.y / step) * step).toFixed(1);
          b[k] = (b[k] ?? 0) + 1;
        }
      }
      return b;
    };
    return { visual: scan(visual.meshes.filter((m) => (m as Mesh).getTotalVertices?.() > 0) as Mesh[]), collider: scan(colliderMeshes) };
  },
  colliderRootInfo() {
    const m = colliderMeshes[0] as Mesh;
    m.computeWorldMatrix(true);
    const bi = m.getBoundingInfo();
    return { name: m.name, verts: m.getTotalVertices(), pos: m.position.asArray(), scaling: m.scaling.asArray(),
             rotQ: m.rotationQuaternion?.asArray() ?? null, parent: m.parent?.name ?? null,
             bbMin: bi.boundingBox.minimumWorld.asArray(), bbMax: bi.boundingBox.maximumWorld.asArray() };
  },
  colliderMeshesDebug() { return colliderMeshes; },
  colliderVertCount() { return colliderMeshes.map((m) => (m as Mesh).getTotalVertices()); },
  /** 自由机位出图。 */
  cam(px: number, py: number, pz: number, tx: number, ty: number, tz: number) {
    freeCam = { p: new Vector3(px, py, pz), t: new Vector3(tx, ty, tz) };
  },
  releaseCam() { freeCam = null; },
  /** 外观网格清单（名称 + 材质名），用于核对导出对象。 */
  meshList() {
    return visual.meshes.map((m) => ({
      n: m.name, v: (m as Mesh).getTotalVertices?.() ?? 0,
      mat: (m as Mesh).material?.name ?? null, vis: m.isVisible, en: m.isEnabled(),
    }));
  },
  probe(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number) {
    const hit = scene.pickWithRay(new Ray(new Vector3(fx, fy, fz), new Vector3(tx, ty, tz).normalize(), 12),
      (m) => colliderMeshes.includes(m as Mesh));
    return hit && hit.hit ? { mesh: hit.pickedMesh?.name, y: hit.pickedPoint?.y, d: hit.distance } : null;
  },
  /** 最近一支向下射线打到的外观网格名。 */
  pickVisual(x: number, y: number, z: number) {
    const hit = scene.pickWithRay(new Ray(new Vector3(x, y, z), new Vector3(0, -1, 0), 8),
      (m) => visual.meshes.includes(m as Mesh));
    return hit && hit.hit ? { mesh: hit.pickedMesh?.name, y: hit.pickedPoint?.y } : null;
  },
  state(): HarnessState {
    const p = capsule.position;
    return {
      ready: true, x: p.x, y: p.y, z: p.z, grounded, onLadder,
      target: target?.note ?? null, log: log.slice(), visuals: visual.meshes.length,
      colliders: colliderMeshes.length,
    };
  },
  reset() { log.length = 0; }
};
(window as any).__airship = api;

routeEl.textContent = "航路：\n甲板 → 船楼下层 → 甲板 → 外梯 → 露台 → 上层 → 甲板 → 舱口 → 底舱";
engine.runRenderLoop(() => {
  scene.render();
  (window as any).__frames = engine.frameId;
});

// 无头浏览器可能完全不跑 rAF：定时器兜底按 60 Hz 驱动场景，物理与画面同步推进
setInterval(() => {
  if (!(window as any).__rafAlive) {
    scene.render();
    (window as any).__frames = ((window as any).__frames ?? 0) + 1;
  }
}, 16);
requestAnimationFrame(() => { (window as any).__rafAlive = true; });
