// 同行搭档（M4）：岩——真实协作完成后在泊位邀请；跟随/等待、登离船/换岛、战斗支援与一次救援。
// 信任规则在 shared/projects.ts（companionTrust）；本系统只执行与表现。
import { Vector3, TransformNode } from "@babylonjs/core";
import type { NpcActor } from "./npc/npc";
import type { Player } from "../world/player";
import type { World } from "../world/world";
import type { ProjectsSystem } from "./projects";
import type { CombatSystem } from "./combat";
import { findWalkPath, type WalkPoint } from "./npc/npcPath";

const FOLLOW_NEAR = 2.6;
const FOLLOW_SPEED = 5.2;
/** 战斗支援：1.4s 一跳 12 伤害（M4 表） */
const SUPPORT_INTERVAL = 1.4;
const SUPPORT_DAMAGE = 12;
const SUPPORT_RANGE = 7;
/** 救援阈值与恢复量 */
const RESERVE_HP_THRESHOLD = 25;
const RESCUE_HEAL = 25;

export class CompanionSystem {
  private _active = false;
  get active() { return this._active; }
  set active(value: boolean) {
    this._active = value;
    const yan = this.getYan();
    if (yan) { yan.suspended = value && !this.holdHome; yan.action = null; yan.state = "idle"; }
  }
  /** true=跟随，false=原地等待 */
  following = true;
  /** 本次出航因口粮不足留守家中（归航后自动解除） */
  holdHome = false;
  onEvent?: (kind: string, data?: unknown) => void;
  private supportTimer = 0;
  private followRoute: WalkPoint[] = [];
  private routeTimer = 0;
  private lastFollowAnim = "";
  /** 登船时把 NPC 挂到船上 */
  private shipParent: TransformNode | null = null;
  private deckOffset = new Vector3(1.6, 0.4, -0.8);

  constructor(
    private projects: ProjectsSystem,
    private player: Player,
    private world: World,
    private combat: CombatSystem,
    private getYan: () => NpcActor | null,
  ) {}

  /** 泊位邀请（信任条件由 main 用 companionTrust 校验） */
  invite(): boolean {
    if (this.active) return false;
    const yan = this.getYan();
    if (!yan) return false;
    this.active = true;
    this.following = true;
    this.projects.companion.invited = true;
    yan.remember("船长邀请我同行远征，从泊位出发。", "companion_invite");
    yan.say("好嘞，带上我！口粮备好就出发。");
    this.onEvent?.("toast", "岩加入了队伍：跟随 / 等待由你指挥。");
    this.onEvent?.("companion_invited", {});
    return true;
  }

  dismiss(reason = "在家看家。") {
    if (!this.active) return;
    const yan = this.getYan();
    this.active = false;
    this.unboardShip();
    if (yan) {
      yan.remember("远征结束，回到家园继续干活。", "companion_home");
      yan.say(reason);
    }
    this.onEvent?.("companion_dismissed", {});
  }

  /** 登船：NPC 挂到船甲板随行位（与乘员钉位同思路，船体是 kinematic 载体） */
  boardShip(shipRoot: TransformNode) {
    const yan = this.getYan();
    if (!yan || !this.active) return;
    this.shipParent = shipRoot;
    yan.node.parent = shipRoot;
    yan.node.position.copyFrom(this.deckOffset);
    yan.state = "idle";
    yan.action = null;
    yan.suspended = true;
  }

  unboardShip() {
    const yan = this.getYan();
    if (!yan || !this.shipParent) return;
    yan.suspended = this.active && !this.holdHome;
    yan.node.parent = null;
    // 落到玩家附近的岛面
    const p = this.player.node.position;
    yan.node.position.set(p.x + 1.4, p.y + 0.2, p.z);
    yan.pos.set(p.x + 1.4, p.y + 0.2, p.z);
    this.shipParent = null;
  }

  get onShip(): boolean { return this.shipParent !== null; }

  update(dt: number, sailing: boolean, shipRoot: TransformNode | null) {
    const yan = this.getYan();
    if (!yan) return;
    if (!this.active) return;

    if (this.holdHome) {
      if (this.onShip) this.unboardShip();
      yan.suspended = false;
      // 战斗支援/救援仍生效（岩在家守望）；不跟随、不登船
      return;
    }
    yan.suspended = true;

    if (sailing) {
      if (!this.onShip && shipRoot) this.boardShip(shipRoot);
    } else if (this.onShip) {
      this.unboardShip();
    } else if (this.following) {
      // The companion exclusively owns this actor while active; routes use existing walk rules.
      const pos = yan.pos;
      const p = this.player.node.position;
      const dx = p.x - pos.x, dz = p.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > FOLLOW_NEAR) {
        this.routeTimer -= dt;
        if (this.routeTimer <= 0) {
          this.routeTimer = .7;
          this.followRoute = findWalkPath(pos, p, { arrivalDistance: FOLLOW_NEAR, canStand: (x,z) => this.world.islands.some(isle => isle.heightAt(x,z) !== null && (!isle.canWalkAt || isle.canWalkAt(x,z))) }).points;
        }
        while (this.followRoute.length && Math.hypot(this.followRoute[0].x-pos.x,this.followRoute[0].z-pos.z)<.12) this.followRoute.shift();
        const next = this.followRoute[0];
        if (next) {
          const nx=next.x-pos.x,nz=next.z-pos.z,d=Math.hypot(nx,nz);
          const step = Math.min(d, dist-FOLLOW_NEAR, FOLLOW_SPEED*dt);
          const x=pos.x+nx/d*step,z=pos.z+nz/d*step,h=this.surfaceAt(x,z);
          if(h!==null) { pos.set(x,h,z); yan.node.rotation.y=Math.atan2(nx,nz); yan.state="walking"; }
        } else yan.state="idle";
      } else if (yan.state === "walking") {
        yan.state = "idle";
      }
    }
    if (!this.onShip) {
      if (!this.following) yan.state="idle";
      yan.node.position.copyFrom(yan.pos);
      const animation=yan.state==="walking"?"Walking_A":"Idle";
      if (animation!==this.lastFollowAnim) { yan.rig?.play(animation); this.lastFollowAnim=animation; }
    }

    // 战斗支援：信任解锁后，玩家附近的雾灵每 1.4s 挨 12 点（复用统一挥击判定：掉落/事件/击退一致）
    const facts = this.projects.companion;
    if (facts.expeditionReturned) {
      this.supportTimer -= dt;
      if (this.supportTimer <= 0) {
        this.supportTimer = SUPPORT_INTERVAL;
        const origin = yan.node.position;
        let target: typeof this.combat.wisps[number] | null = null;
        for (const w of this.combat.wisps) {
          if (w.state === "dead") continue;
          if (Vector3.Distance(w.mesh.position, origin) < SUPPORT_RANGE && Vector3.Distance(w.mesh.position, this.player.node.position) < 14) { target = w; break; }
        }
        if (target) {
          const dir = target.mesh.position.subtract(origin);
          dir.y = 0;
          if (dir.lengthSquared() < 0.01) dir.set(0, 0, 1);
          this.combat.meleeAttack("companion", origin, dir.normalize(), SUPPORT_RANGE, SUPPORT_DAMAGE);
        }
      }
    }

    // 救援：每次远征一次，HP<25 恢复 25（真实共同击败雾灵后解锁）
    if (facts.jointWispKill && !facts.rescueUsedThisExpedition && this.player.hp < RESERVE_HP_THRESHOLD && this.player.hp > 0) {
      facts.rescueUsedThisExpedition = true;
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + RESCUE_HEAL);
      if (yan) yan.say("稳住！喝口药顶住！");
      this.onEvent?.("toast", "岩把你从晕眩边缘拉了回来（救援）。");
      this.onEvent?.("companion_rescue", {});
    }
  }

  private surfaceAt(x: number, z: number): number | null {
    for (const isle of this.world.islands) {
      const h = isle.heightAt(x, z);
      if (h !== null) return h;
    }
    return null;
  }
}
