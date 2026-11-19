// 任务引导：目标推进、目标点标记（3D 信标 + 屏幕边缘指示）。
import { Scene, Vector3, Color3, Mesh, MeshBuilder, StandardMaterial } from "@babylonjs/core";
import { QUESTS } from "shared";

export interface QuestState { step: number; done: string[] }

export class QuestSystem {
  states: Record<string, QuestState> = {};
  /** 已观察到的世界事实。事实可先于任务步骤发生，重载后仍用于重算进度。 */
  facts = new Set<string>();
  /** 当前引导目标（世界坐标 + 名称），HUD 据此画指示 */
  beacon: { pos: Vector3; label: string } | null = null;
  onEvent?: (kind: string, data?: unknown) => void;
  private beaconMesh: Mesh;

  constructor(private scene: Scene) {
    for (const q of QUESTS) this.states[q.id] = { step: 0, done: [] };
    this.beaconMesh = MeshBuilder.CreateCylinder("questBeacon", { height: 1.6, diameterTop: 0, diameterBottom: 1.1 }, this.scene);
    const m = new StandardMaterial("questBeaconMat", this.scene);
    m.emissiveColor = new Color3(1.0, 0.8, 0.25);
    m.diffuseColor = new Color3(1, 0.85, 0.4);
    m.disableLighting = true;
    this.beaconMesh.material = m;
    this.beaconMesh.isPickable = false;
    this.beaconMesh.setEnabled(false);
  }

  /** 完成标记 */
  mark(flag: string) {
    if (this.facts.has(flag)) return;
    this.facts.add(flag);
    this.advance();
  }

  has(flag: string): boolean {
    return this.facts.has(flag);
  }

  /** 旧存档只有 states/done，仍可无损恢复已知事实。 */
  load(states: Record<string, QuestState> | undefined, facts?: string[]) {
    this.facts.clear();
    for (const q of QUESTS) {
      const saved = states?.[q.id];
      const done = saved?.done?.filter((flag) => q.steps.some((step) => step.done === flag)) ?? [];
      this.states[q.id] = { step: Math.min(done.length, q.steps.length), done: [...new Set(done)] };
      for (const flag of done) this.facts.add(flag);
    }
    for (const flag of facts ?? []) this.facts.add(flag);
    this.advance(false);
  }

  private advance(announce = true) {
    let changed = false;
    for (const q of QUESTS) {
      const st = this.states[q.id];
      while (st.step < q.steps.length && this.facts.has(q.steps[st.step].done)) {
        const step = q.steps[st.step];
        if (!st.done.includes(step.done)) st.done.push(step.done);
        st.step += 1;
        changed = true;
        if (announce) {
          this.onEvent?.("quest_step", { quest: q.id, step: st.step, title: step.title });
          const next = q.steps[st.step];
          if (next) this.onEvent?.("toast", `✅ ${step.title} — ${next.desc}`);
          else this.onEvent?.("quest_done", { quest: q.id, name: q.name });
        }
      }
    }
    if (changed) this.refreshBeacon();
  }

  refreshBeacon() {
    // 找当前任务的当前步骤目标位置（由 main 注册）
    this.onEvent?.("quest_changed");
    this.updateBeaconMesh();
  }

  setBeacon(pos: Vector3 | null, label: string) {
    this.beacon = pos ? { pos: pos.clone(), label } : null;
    this.updateBeaconMesh();
  }

  private updateBeaconMesh() {
    if (!this.beacon) { this.beaconMesh.setEnabled(false); return; }
    this.beaconMesh.setEnabled(true);
    this.beaconMesh.position.copyFrom(this.beacon.pos);
  }

  update(t: number) {
    if (this.beacon) {
      this.beaconMesh.position.y = this.beacon.pos.y + 0.6 + Math.sin(t * 0.003) * 0.25;
      this.beaconMesh.rotation.y = t * 0.001;
    }
  }
}
