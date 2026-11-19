// 开发者自由相机(Dev Free-Fly Camera):场景漫游、模型检查与关卡验收专用。
// 启用期间主循环暂停玩法模拟(见 main.frame),仅保留渲染与装饰动画;
// 相机不受重力、碰撞体、地形及角色物理约束;退出后由玩家相机 Lerp 平滑接管。
import { UniversalCamera, Vector3 } from "@babylonjs/core";
import type { Input } from "./input";

const SENS_X = 0.0026; // 与玩家相机一致的鼠标灵敏度
const SENS_Y = 0.0022;
const BASE_SPEED = 12;
const FAST_SPEED = 36;
const PITCH_LIMIT = Math.PI / 2 - 0.06;

export class FreeFlyCamera {
  enabled = false;
  private yaw = 0;
  private pitch = 0;

  constructor(private camera: UniversalCamera, private input: Input) {}

  /** 进入自由飞行:朝向取自当前相机取景,位置原地不动 */
  enable() {
    const d = this.camera.getTarget().subtract(this.camera.position);
    const len = d.length();
    this.yaw = Math.atan2(d.x, d.z);
    this.pitch = len > 1e-4 ? -Math.asin(Math.max(-1, Math.min(1, d.y / len))) : 0;
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  toggle(): boolean {
    if (this.enabled) this.disable();
    else this.enable();
    return this.enabled;
  }

  /** 每帧:鼠标环视 + WASD 水平 / Space·Ctrl 垂直 / Shift 加速 */
  update(dt: number) {
    if (!this.enabled) return;
    const input = this.input;
    if (document.pointerLockElement) {
      // 视线前向 = (sin yaw, cos yaw),yaw 增大 = 右转:与玩家相机同向,鼠标右移做加法
      this.yaw += input.mouseDX * SENS_X;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + input.mouseDY * SENS_Y));
    }
    let mx = 0, mz = 0, my = 0;
    if (input.isDown("KeyW")) mz += 1;
    if (input.isDown("KeyS")) mz -= 1;
    if (input.isDown("KeyA")) mx -= 1;
    if (input.isDown("KeyD")) mx += 1;
    if (input.isDown("Space")) my += 1;
    if (input.isDown("ControlLeft", "ControlRight")) my -= 1;
    const speed = input.isDown("ShiftLeft", "ShiftRight") ? FAST_SPEED : BASE_SPEED;
    const move = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).scale(mz)
      .add(new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).scale(mx));
    move.y += my;
    if (move.lengthSquared() > 0) {
      move.normalize();
      this.camera.position.addInPlace(move.scale(speed * dt));
    }
    // 直接写 Euler:x=pitch(正=低头), y=yaw,无 roll
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }
}
