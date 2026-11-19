// 战斗：云雾灵敌人 + 玩家武器攻击判定。
import { Scene, Vector3, Color3, Color4, Mesh, MeshBuilder, StandardMaterial } from "@babylonjs/core";
import type { Player } from "../world/player";
import { Inventory } from "./items";

export interface Wisp {
  id: number;
  mesh: Mesh;
  hp: number;
  maxHp: number;
  home: Vector3;
  state: "idle" | "chase" | "dead";
  hitFlash: number;
  attackCd: number;
  respawnAt: number;
}

export class CombatSystem {
  wisps: Wisp[] = [];
  onEvent?: (kind: string, data?: unknown) => void;
  private nextId = 1;

  constructor(private scene: Scene, private player: Player, private inv: Inventory) {}

  spawnWisp(pos: Vector3) {
    const mesh = MeshBuilder.CreateSphere(`wisp_${this.nextId}`, { diameter: 1.1, segments: 8 }, this.scene);
    mesh.position.copyFrom(pos);
    const mat = new StandardMaterial(`wispMat_${this.nextId}`, this.scene);
    mat.diffuseColor = new Color3(0.7, 0.75, 0.9);
    mat.emissiveColor = new Color3(0.25, 0.35, 0.55);
    mat.alpha = 0.85;
    mat.specularColor = new Color3(0.3, 0.35, 0.45);
    mesh.material = mat;
    mesh.isPickable = false;
    const core = MeshBuilder.CreateSphere(`wispCore_${this.nextId}`, { diameter: 0.5, segments: 6 }, this.scene);
    core.parent = mesh;
    const coreMat = new StandardMaterial(`wispCoreMat_${this.nextId}`, this.scene);
    coreMat.emissiveColor = new Color3(0.85, 0.9, 1.0);
    coreMat.diffuseColor = new Color3(1, 1, 1);
    core.material = coreMat;
    core.isPickable = false;
    this.wisps.push({
      id: this.nextId++, mesh, hp: 60, maxHp: 60, home: pos.clone(),
      state: "idle", hitFlash: 0, attackCd: 0, respawnAt: 0,
    });
  }

  /** 近战挥击（统一入口：玩家与未来 NPC 战斗共用判定）；attacker 用于事件归因。 */
  meleeAttack(attacker: "player" | string, origin: Vector3, dir: Vector3, range: number, damage: number): boolean {
    let hitAny = false;
    for (const w of this.wisps) {
      if (w.state === "dead") continue;
      const to = w.mesh.position.subtract(origin);
      const dist = to.length();
      if (dist > range + 0.6) continue;
      // 高度差摊平后再判朝向（雾灵悬浮在头附近，纯竖直偏移不该导致挥空）
      const toFlat = new Vector3(to.x, 0, to.z);
      const dot = toFlat.lengthSquared() < 0.01 ? 1 : Vector3.Dot(toFlat.normalize(), dir);
      if (dot < 0.35) continue;
      w.hp -= damage;
      w.hitFlash = 0.25;
      w.state = "chase";
      // 击退
      const kb = dir.scale(3);
      kb.y = 1.5;
      w.mesh.position.addInPlace(kb.scale(0.25));
      hitAny = true;
      if (w.hp <= 0) {
        w.state = "dead";
        w.respawnAt = performance.now() + 45000;
        w.mesh.setEnabled(false);
        this.inv.add("wisp_essence", 1);
        if (Math.random() < 0.5) this.inv.add("windcrystal", 1);
        this.onEvent?.("wisp_defeated", { id: w.id, by: attacker });
      }
    }
    if (hitAny) this.onEvent?.("attack_hit");
    return hitAny;
  }

  update(dt: number, updrafts: { center: Vector3; radius: number; height: number; power: number }[]) {
    const p = this.player.node.position;
    const now = performance.now();
    for (const w of this.wisps) {
      if (w.state === "dead") {
        if (now > w.respawnAt) {
          w.state = "idle";
          w.hp = w.maxHp;
          w.mesh.setEnabled(true);
          w.mesh.position.copyFrom(w.home);
        }
        continue;
      }
      const m = w.mesh.position;
      const dist = Vector3.Distance(m, p);
      // 雾灵是岛屿守护者：驾驶云舟/重生期间不是有效目标，脱战回巢（避免靠泊被磨死、重生被秒）
      const vulnerable = this.player.mode === "walk" || this.player.mode === "glide" || this.player.mode === "sit";
      // 行为
      if (w.state === "idle" && vulnerable && dist < 11) {
        w.state = "chase";
        this.onEvent?.("wisp_aggro", { id: w.id });
      } else if (w.state === "chase" && (dist > 24 || !vulnerable)) {
        w.state = "idle";
      }
      if (w.state === "chase") {
        const dir = p.subtract(m);
        dir.y = 0;
        dir.normalize();
        const speed = dist > 1.4 ? 4.6 : 0;
        m.addInPlace(dir.scale(speed * dt));
        m.y += Math.sin(now * 0.004 + w.id) * 0.02;
        // 攻击
        w.attackCd -= dt;
        if (dist < 1.6 && w.attackCd <= 0) {
          w.attackCd = 1.1;
          this.player.damage(12);
          this.onEvent?.("player_hit", { from: "wisp", dmg: 12 });
        }
      } else {
        // 游荡回巢
        const homeDir = w.home.subtract(m);
        if (homeDir.length() > 0.5) {
          homeDir.normalize();
          m.addInPlace(homeDir.scale(1.4 * dt));
        }
        m.y = w.home.y + Math.sin(now * 0.0025 + w.id * 2) * 0.4;
      }
      // 受击闪白
      if (w.hitFlash > 0) {
        w.hitFlash -= dt;
        const mat = w.mesh.material as StandardMaterial;
        mat.emissiveColor = w.hitFlash > 0 ? new Color3(0.9, 0.7, 0.7) : new Color3(0.25, 0.35, 0.55);
      }
    }
    void updrafts;
  }
}
