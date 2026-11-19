// 玩家角色：Havok 胶囊 + 自定义运动（行走/滑翔/驾驶）、第三人称相机、平台随动。
// Ruike 骨骼角色的动画随运动状态切换。
import {
  Scene, Vector3, Color3, Mesh, MeshBuilder, StandardMaterial, TransformNode,
  PhysicsAggregate, PhysicsShapeType, PhysicsMotionType, Ray, Quaternion, Matrix,
  UniversalCamera, Space, Mesh as BMesh,
} from "@babylonjs/core";
import { Input } from "../core/input";
import type { Island } from "./island";
import { CHARACTER_FACE_YAW, loadCharacter, CharacterRig } from "./characters";
import { resolveCameraPosition } from "./cameraObstruction";

export type PlayerMode = "walk" | "glide" | "sail" | "sit" | "respawning";

export interface PlayerDeps {
  scene: Scene;
  input: Input;
  camera: UniversalCamera;
}

const GRAVITY = -17;

export function seatedAnchor(pos: Vector3, rotY: number): { pos: Vector3; rotY: number } {
  return { pos: pos.clone(), rotY };
}

export function seatedExitPosition(pos: Vector3, rotY: number): Vector3 {
  return pos.add(new Vector3(Math.sin(rotY) * 0.8, 0.05, Math.cos(rotY) * 0.8));
}

export class Player {
  node: TransformNode;
  body: PhysicsAggregate;
  capsule!: Mesh;
  meshRoot: TransformNode;
  rig: CharacterRig | null = null;
  glider!: TransformNode;
  sword!: TransformNode;
  private swordAnchor: Mesh | null = null;
  mode: PlayerMode = "walk";
  hp = 100; maxHp = 100;
  hunger = 100;
  stamina = 100; maxStamina = 100;
  staminaPool = 0; staminaPoolUntil = 0;
  xp = 0; level = 1;
  equipped: string | null = null;
  attackCooldown = 0;
  grounded = false;
  groundBodyId = -1;
  /** 云舟随动用：上一帧所在的移动平台 */
  platform: { node: TransformNode; bodyId: number } | null = null;
  speedBoost = 0;
  // 相机控制
  camYaw = 0; camPitch = 0.32; camDist = 6.2;
  // 动画计时
  private walkPhase = 0;
  private attackT = 0;
  private lastVy = 0;
  private respawnT = 0;
  private lastAnim = "";
  private seat: { pos: Vector3; rotY: number } | null = null;
  onEvent?: (kind: string, data?: unknown) => void;
  onAttack?: (origin: Vector3, dir: Vector3) => boolean;

  constructor(private deps: PlayerDeps, spawn: Vector3) {
    const { scene } = deps;
    this.node = new TransformNode("player", scene);
    this.node.position.copyFrom(spawn);

    // 物理胶囊：独立于视觉节点，物理直接驱动它；渲染节点每帧跟随。
    this.capsule = MeshBuilder.CreateCapsule("playerCapsule", { radius: 0.42, height: 1.84, tessellation: 8 }, scene);
    this.capsule.isVisible = false;
    this.capsule.position.copyFrom(spawn).addInPlace(new Vector3(0, 0.92, 0));
    this.body = new PhysicsAggregate(this.capsule, PhysicsShapeType.CAPSULE, { mass: 72, friction: 0.2, restitution: 0 }, scene);
    this.body.body.setMotionType(PhysicsMotionType.DYNAMIC);
    this.body.body.setMassProperties({ mass: 72, inertia: Vector3.Zero() });
    this.body.body.setLinearDamping(0.02);
    this.body.body.setAngularDamping(1);
    this.body.body.setLinearVelocity(Vector3.Zero());
    this.body.body.disablePreStep = false;

    this.meshRoot = new TransformNode("playerMesh", scene);
    this.meshRoot.parent = this.node;
    this.buildGlider(scene);
    void this.initVisual(scene);
  }

  private async initVisual(scene: Scene) {
    try {
      const rig = await loadCharacter(scene, "player", 1.72);
      this.rig = rig;
      rig.root.parent = this.meshRoot;
      this.meshRoot.rotation.y = CHARACTER_FACE_YAW;
      // 装备在模型就绪后挂载
      if (this.equipped) this.equipSwordModel();
      if (this.mode === "sit") this.playAnim("Sit_Chair_Idle");
    } catch (e) {
      console.warn("[player] character load failed", e);
    }
  }

  private buildGlider(scene: Scene) {
    this.glider = new TransformNode("glider", scene);
    const canvasMat = new StandardMaterial("gliderMat", scene);
    canvasMat.diffuseColor = new Color3(0.95, 0.9, 0.78);
    canvasMat.specularColor = new Color3(0.06, 0.06, 0.06);
    canvasMat.backFaceCulling = false;
    const trimMat = new StandardMaterial("gliderTrim", scene);
    trimMat.diffuseColor = new Color3(0.85, 0.48, 0.3);
    trimMat.specularColor = new Color3(0.04, 0.04, 0.04);
    // 翼面：两段斜板拼成浅 V 形
    for (const side of [-1, 1]) {
      const wing = MeshBuilder.CreateBox(`gliderWing${side}`, { width: 1.7, height: 0.05, depth: 1.05 }, scene);
      wing.position.set(side * 0.82, 1.98, -0.12);
      wing.rotation.z = -side * 0.14;
      wing.material = canvasMat;
      wing.parent = this.glider;
      wing.isPickable = false;
      const tip = MeshBuilder.CreateBox(`gliderTip${side}`, { width: 0.5, height: 0.05, depth: 0.8 }, scene);
      tip.position.set(side * 1.75, 1.9, -0.05);
      tip.rotation.z = -side * 0.3;
      tip.material = trimMat;
      tip.parent = this.glider;
      tip.isPickable = false;
    }
    // 翼骨
    for (const side of [-1, 1]) {
      const spar = MeshBuilder.CreateCylinder(`gliderSpar${side}`, { height: 1.9, diameter: 0.05, tessellation: 6 }, scene);
      spar.rotation.z = Math.PI / 2 - side * 0.14;
      spar.position.set(side * 0.85, 2.0, -0.1);
      spar.material = trimMat;
      spar.parent = this.glider;
      spar.isPickable = false;
    }
    const keel = MeshBuilder.CreateCylinder("gliderKeel", { height: 0.7, diameter: 0.05, tessellation: 6 }, scene);
    keel.position.set(0, 1.75, -0.2);
    keel.material = trimMat;
    keel.parent = this.glider;
    keel.isPickable = false;
    this.glider.setEnabled(false);
    this.glider.parent = this.node;
  }

  setSword(t: TransformNode | null) {
    if (this.sword) { this.sword.dispose(); this.sword = null!; }
    if (this.swordAnchor) { this.swordAnchor.dispose(); this.swordAnchor = null; }
    if (t) {
      this.sword = t;
      t.setEnabled(true);
      this.equipped = "windblade_sword";
      this.equipSwordModel();
    } else {
      this.equipped = null;
    }
  }

  /** 把剑挂到手骨（无骨骼时挂到身侧） */
  private equipSwordModel() {
    if (!this.sword) return;
    this.sword.parent = null;
    const rig = this.rig;
    const skin = rig?.skeleton
      ? rig.root.getChildMeshes().find((mesh) => mesh.skeleton === rig.skeleton)
      : null;
    if (rig?.handBone && skin) {
      const anchor = new Mesh("swordAnchor", this.deps.scene);
      anchor.isVisible = false;
      anchor.attachToBone(rig.handBone, skin);
      this.swordAnchor = anchor;
      this.sword.parent = anchor;
      // Grip centre at mesh Y=-1.13, placed between Ruike's thumb and index.
      // The blade extends from the little finger towards the index finger.
      this.sword.position.set(-0.456, 0.250, 0.037);
      this.sword.rotation.set(-0.398, -1.477, 1.492);
      this.sword.scaling.setAll(0.35);
    } else {
      this.sword.parent = this.meshRoot;
      this.sword.position.set(0.42, 0.85, 0.1);
      this.sword.rotation.set(-0.5, 0, 0.35);
      this.sword.scaling.setAll(1);
    }
  }

  get eyePos(): Vector3 {
    return this.node.position.add(new Vector3(0, 1.5, 0));
  }

  get totalStamina(): number { return this.maxStamina + this.staminaPool; }
  get currentStamina(): number {
    const base = this.stamina;
    return this.staminaPool > 0 && performance.now() < this.staminaPoolUntil ? base + this.staminaPool : base;
  }

  private useStamina(v: number): boolean {
    const now = performance.now();
    if (this.staminaPool > 0 && now < this.staminaPoolUntil) {
      if (this.staminaPool >= v) { this.staminaPool -= v; return true; }
      v -= this.staminaPool; this.staminaPool = 0;
    }
    if (this.stamina < v) return false;
    this.stamina -= v;
    return true;
  }

  /** 对外的体力支出（蓄力风斩等系统共用同一池与扣减顺序） */
  trySpendStamina(v: number): boolean {
    return this.useStamina(v);
  }

  teleport(pos: Vector3) {
    this.body.body.disablePreStep = true;
    this.capsule.position.set(pos.x, pos.y + 0.92, pos.z);
    this.body.body.setLinearVelocity(Vector3.Zero());
    this.body.body.disablePreStep = false;
    this.node.position.copyFrom(pos);
  }

  seatBuildingUid: string | null = null;

  sitAt(pos: Vector3, rotY: number, buildingUid?: string) {
    this.seat = seatedAnchor(pos, rotY);
    this.seatBuildingUid = buildingUid ?? null;
    this.mode = "sit";
    this.glider.setEnabled(false);
    this.body.body.setMotionType(PhysicsMotionType.STATIC);
    this.pinToSeat();
    this.playAnim("Sit_Chair_Idle");
  }

  standUp() {
    const seat = this.seat;
    if (!seat) return;
    const exit = seatedExitPosition(seat.pos, seat.rotY);
    this.seat = null;
    this.seatBuildingUid = null;
    this.body.body.setMotionType(PhysicsMotionType.DYNAMIC);
    this.mode = "walk";
    this.teleport(exit);
    this.playAnim("Idle");
  }

  isSittingOn(uid: string) { return this.mode === "sit" && this.seatBuildingUid === uid; }

  /** 航行驾驶时身体转 STATIC：钉位驾驶不需要动力学参与，船体防穿抬升/倒车瞬移
   *  不会把解算冲量灌进乘员胶囊（历史坑：乘员被反复抛出甲板坠海）。 */
  setSailing(on: boolean) {
    this.body.body.setMotionType(on ? PhysicsMotionType.STATIC : PhysicsMotionType.DYNAMIC);
  }

  private pinToSeat() {
    if (!this.seat) return;
    this.body.body.disablePreStep = true;
    this.capsule.position.set(this.seat.pos.x, this.seat.pos.y + 0.92, this.seat.pos.z);
    this.body.body.setLinearVelocity(Vector3.Zero());
    this.body.body.disablePreStep = false;
    this.node.position.copyFrom(this.seat.pos);
    this.node.rotation.y = this.seat.rotY;
  }

  /** 驾驶时把角色钉在舵位（随船体每帧同步，节点不再停留在旧登船点） */
  stickTo(pos: Vector3, rotY: number) {
    this.body.body.disablePreStep = true;
    this.capsule.position.set(pos.x, pos.y + 0.92, pos.z);
    this.body.body.disablePreStep = false;
    // 钉位后清零速度：船体防穿抬升等瞬移会把解算冲量累积进速度，最终把乘员抛出甲板
    this.body.body.setLinearVelocity(Vector3.Zero());
    this.node.position.copyFrom(pos);
    this.node.rotation.y = rotY;
  }

  giveFoodBuff(staminaBonus: number, duration: number) {
    this.staminaPool = staminaBonus;
    this.staminaPoolUntil = performance.now() + duration * 1000;
  }

  /** 开发者自由相机期间冻结角色物理(不受重力/碰撞影响);退出时恢复原运动类型。 */
  private frozenMotion: PhysicsMotionType | null = null;
  setPhysicsFrozen(frozen: boolean) {
    if (frozen === (this.frozenMotion !== null)) return;
    if (frozen) {
      this.frozenMotion = this.mode === "sit" ? PhysicsMotionType.STATIC : PhysicsMotionType.DYNAMIC;
      this.body.body.setMotionType(PhysicsMotionType.STATIC);
    } else {
      this.body.body.setMotionType(this.frozenMotion!);
      this.frozenMotion = null;
    }
    this.body.body.setLinearVelocity(Vector3.Zero());
  }

  damage(v: number) {
    this.hp = Math.max(0, this.hp - v);
    this.onEvent?.("hp_change");
    if (this.hp <= 0) this.startRespawn("你在云海中晕了过去，被云流送回了出发地。");
  }

  startRespawn(msg: string) {
    if (this.mode === "respawning") return;
    if (this.mode === "sit") {
      this.seat = null;
      this.body.body.setMotionType(PhysicsMotionType.DYNAMIC);
    }
    if (this.mode === "sail") this.setSailing(false);
    this.mode = "respawning";
    this.respawnT = 2.2;
    this.onEvent?.("respawn", msg);
  }

  addXp(v: number) {
    this.xp += v;
    const next = this.level * 120;
    if (this.xp >= next) {
      this.xp -= next;
      this.level += 1;
      this.maxStamina += 10;
      this.stamina = this.maxStamina;
      this.onEvent?.("level_up", this.level);
    }
  }

  update(dt: number, ctx: {
    islands: Island[];
    updrafts: { center: Vector3; radius: number; height: number; power: number }[];
    seaLevel: number;
  }) {
    const { input, camera } = this.deps;
    const pos = this.node.position;
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.attackT = Math.max(0, this.attackT - dt);

    if (this.mode === "respawning") {
      this.respawnT -= dt;
      if (this.respawnT <= 0) {
        this.hp = Math.max(45, this.maxHp * 0.5);
        this.mode = "walk";
        this.onEvent?.("respawn_done");
      }
      this.syncNodeFromBody();
      this.updateCamera(dt);
      return;
    }

    if (this.mode === "sail") {
      // 驾驶：角色锁定在舵位
      this.updateCamera(dt);
      return;
    }

    if (this.mode === "sit") {
      this.pinToSeat();
      this.playAnim("Sit_Chair_Idle");
      this.updateCamera(dt);
      return;
    }

    // ---- 地面检测 ----
    const from = pos.add(new Vector3(0, 0.6, 0));
    const ray = new Ray(from, new Vector3(0, -1, 0), 2.0);
    const hit = this.deps.scene.pickWithRay(ray, (m) =>
      /islandTop_|^shipHull$|^shipDeck$|^buildCollider|^padDisc/.test(m.name) && m.name !== "playerCapsule"
    );
    this.grounded = !!hit?.hit && hit.distance < 1.35 && this.lastVy <= 0.01;

    // ---- 模式切换 ----
    if (this.mode === "walk") {
      if (!this.grounded && this.lastVy < -3 && input.wasPressed("KeyF") && this.currentStamina > 8) {
        this.mode = "glide";
        this.glider.setEnabled(true);
        this.onEvent?.("glide_open");
      }
      if (this.grounded) {
        if (input.wasPressed("Space")) {
          const v = this.body.body.getLinearVelocity();
          this.body.body.setLinearVelocity(new Vector3(v.x, 6.4, v.z));
          this.grounded = false;
        }
        // 体力回复
        this.stamina = Math.min(this.maxStamina, this.stamina + dt * 9);
        if (input.isDown("ShiftLeft") && (input.isDown("KeyW", "KeyA", "KeyS", "KeyD"))) {
          this.stamina = Math.max(0, this.stamina - dt * 4);
        }
      }
    } else if (this.mode === "glide") {
      this.glider.setEnabled(true);
      if (input.wasPressed("KeyF") || this.currentStamina <= 0.5) {
        this.mode = "walk";
        this.glider.setEnabled(false);
      }
    }

    // ---- 水平运动 ----
    let mx = 0, mz = 0;
    if (!input.uiCapture) {
      if (input.isDown("KeyW")) mz += 1;
      if (input.isDown("KeyS")) mz -= 1;
      if (input.isDown("KeyA")) mx -= 1;
      if (input.isDown("KeyD")) mx += 1;
    }
    const fwd = new Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    const right = new Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    const wish = fwd.scale(mz).add(right.scale(mx));
    const hasWish = wish.lengthSquared() > 0.001;
    if (hasWish) wish.normalize();

    const vel = this.body.body.getLinearVelocity();
    let targetSpeed = 0;
    if (this.mode === "walk") {
      targetSpeed = input.isDown("ShiftLeft") ? 7.0 : 4.5;
      targetSpeed += this.speedBoost;
    } else if (this.mode === "glide") {
      targetSpeed = 12;
    }
    const accel = this.grounded || this.mode === "glide" ? 26 : 8;
    const nvx = vel.x + (wish.x * targetSpeed - vel.x) * Math.min(1, accel * dt);
    const nvz = vel.z + (wish.z * targetSpeed - vel.z) * Math.min(1, accel * dt);

    // ---- 垂直运动 ----
    let nvy = vel.y;
    if (this.mode === "glide") {
      // 滑翔：目标竖直速度（负=下沉）；W 俯冲加速、S 减速
      const pitchInput = input.isDown("KeyW") ? -1 : input.isDown("KeyS") ? 1 : 0;
      this.useStamina(2.4 * dt);
      let vyTarget = -(2.2 + pitchInput * 1.6);
      // 上升气流：柱内给正升力，越靠中心越强
      for (const u of ctx.updrafts) {
        const d = Math.hypot(pos.x - u.center.x, pos.z - u.center.z);
        if (d < u.radius && pos.y > u.center.y && pos.y < u.center.y + u.height) {
          vyTarget = u.power * (1 - d / u.radius);
          break;
        }
      }
      nvy += (vyTarget - vel.y) * Math.min(1, 3.2 * dt);
      targetSpeed = 11 + pitchInput * -3.5;
    } else if (!this.grounded) {
      nvy += GRAVITY * dt;
    } else {
      nvy = Math.min(vel.y, 0.5) - 2 * dt;
    }

    this.body.body.setLinearVelocity(new Vector3(nvx, nvy, nvz));
    this.lastVy = nvy;

    // ---- 朝向 ----
    // 仅在移动时转向（待机保持最后朝向；待机对齐 camYaw 会与 rig 偏移叠加导致面向相机）
    if (hasWish) {
      const targetRot = Math.atan2(wish.x, wish.z);
      const cur = this.node.rotation.y;
      let diff = targetRot - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.node.rotation.y = cur + diff * Math.min(1, 12 * dt);
      this.meshRoot.rotation.z = diff * 0.12;
    } else {
      this.meshRoot.rotation.z *= Math.max(0, 1 - 8 * dt);
    }
    this.meshRoot.rotation.x = this.mode === "glide" ? -0.5 : 0;

    // ---- 攻击 ----
    if (this.equipped && input.mouseLeftPressed && !input.uiCapture && this.attackCooldown <= 0 && this.mode === "walk") {
      this.attackCooldown = 0.55;
      this.attackT = 0.3;
      // 站定时身体不随镜头转，攻击方向必须取镜头朝向，否则转身后挥空
      const dir = new Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
      this.node.rotation.y = this.camYaw;
      this.onAttack?.(this.node.position.add(new Vector3(0, 1.1, 0)), dir);
      if (this.rig) { this.lastAnim = "attack"; this.rig.play("1H_Melee_Attack_Slice_Horizontal", false, 1.5); }
    }

    // ---- 动画状态机（骨骼动画驱动，不再用位移悬浮模拟） ----
    const speed2d = Math.hypot(nvx, nvz);
    this.walkPhase += dt * speed2d * 2.2;
    if (this.rig && this.attackT <= 0) {
      if (this.mode === "glide") this.playAnim("Jump_Idle");
      else if (!this.grounded && this.lastVy > 2) this.playAnim("Jump_Start");
      else if (speed2d > 6.2) this.playAnim("Running_A", true, 1.15);
      else if (speed2d > 0.5) this.playAnim("Walking_A", true, Math.min(1.4, Math.max(0.85, speed2d / 4.2)));
      else this.playAnim("Idle");
    }

    // ---- 坠入云海 ----
    if (pos.y < ctx.seaLevel + 6) {
      this.startRespawn("云海托住了你，把你送回了出发的地方。");
    }

    this.syncNodeFromBody();
    // 平台随动：站在云舟上时继承平台运动
    this.updateCamera(dt);
  }

  /** 每帧把渲染节点同步到物理胶囊（胶囊中心比脚高 0.92） */
  syncNodeFromBody() {
    const p = this.capsule.position;
    this.node.position.set(p.x, p.y - 0.92, p.z);
  }

  /** 云舟移动后调用：若玩家站在舟上，绕舟心施加平台位移 */
  applyPlatformDelta(deltaPos: Vector3, deltaRotY: number, pivot: Vector3) {
    const bodyPos = this.capsule.position;
    const local = bodyPos.subtract(pivot);
    const cos = Math.cos(deltaRotY), sin = Math.sin(deltaRotY);
    const rotated = new Vector3(local.x * cos + local.z * sin, local.y, -local.x * sin + local.z * cos);
    const world = pivot.add(rotated).add(deltaPos);
    this.body.body.disablePreStep = true;
    this.capsule.position.copyFrom(world);
    this.body.body.disablePreStep = false;
    this.node.position.set(world.x, world.y - 0.92, world.z);
  }

  private updateCamera(dt: number) {
    const { input, camera } = this.deps;
    if (!document.pointerLockElement && !input.uiCapture) {
      // 未锁定时不响应鼠标（UI 模式）
    }
    if (document.pointerLockElement) {
      // 视线前向 = (sin yaw, cos yaw),Babylon 左手系沿 +z 看时 +x 在右:
      // yaw 增大 = 视线右转,故鼠标右移(dx>0)必须做加法,减号会把水平视角镜像。
      this.camYaw += input.mouseDX * 0.0026;
      this.camPitch = Math.min(1.25, Math.max(-0.42, this.camPitch + input.mouseDY * 0.0022));
      if (input.wheel !== 0) {
        this.camDist = Math.min(12, Math.max(3, this.camDist + input.wheel * 0.8));
      }
    }
    const target = this.node.position.add(new Vector3(0, 1.6, 0));
    const dir = new Vector3(
      -Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      -Math.cos(this.camYaw) * Math.cos(this.camPitch)
    );
    const want = target.add(dir.scale(this.camDist));
    if (want.y < -40) want.y = -40;
    const safe = resolveCameraPosition(this.deps.scene, target, want, this.node);
    camera.position = resolveCameraPosition(this.deps.scene, target, Vector3.Lerp(camera.position, safe, Math.min(1, 14 * dt)), this.node);
    camera.setTarget(target);
  }

  /** 驾驶时相机环视；角色保持待机姿态 */
  updateSailCamera(dt: number, helmPos: Vector3) {
    const { input, camera } = this.deps;
    if (this.rig && this.lastAnim !== "sail_idle") {
      this.lastAnim = "sail_idle";
      this.rig.play("Idle");
    }
    if (document.pointerLockElement) {
      // 同 updateCamera:yaw 增大 = 右转,鼠标右移做加法
      this.camYaw += input.mouseDX * 0.0026;
      this.camPitch = Math.min(0.9, Math.max(-0.2, this.camPitch + input.mouseDY * 0.0022));
    }
    const dir = new Vector3(
      -Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch) + 0.5,
      -Math.cos(this.camYaw) * Math.cos(this.camPitch)
    );
    const want = helmPos.add(dir.scale(9.5));
    const target = helmPos.add(new Vector3(0, 1.6, 0));
    const safe = resolveCameraPosition(this.deps.scene, target, want, this.node);
    camera.position = resolveCameraPosition(this.deps.scene, target, Vector3.Lerp(camera.position, safe, Math.min(1, 6 * dt)), this.node);
    camera.setTarget(target);
  }

  private playAnim(name: string, loop = true, speed = 1) {
    if (this.lastAnim === name) return;
    this.lastAnim = name;
    this.rig?.play(name, loop, speed);
  }

  dispose() {
    this.body.dispose();
    this.node.dispose();
  }
}
