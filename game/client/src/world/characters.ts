// Ruike（quappa-el，CC BY 4.0），动画重定向自 KayKit（CC0）。
// 署名随模型分发：public/assets/chars/ATTRIBUTION.md。
import {
  Scene, TransformNode, AnimationGroup, Vector3, Mesh, Skeleton, Bone, SceneLoader,
} from "@babylonjs/core";

export type CharacterKind = "player" | "yan" | "ling";

// 保留导入根节点的左右手坐标系转换后，Ruike 正面与游戏移动的 +Z 对齐。
export const CHARACTER_FACE_YAW = 0;

const FILES: Record<CharacterKind, string> = {
  player: "Rogue_Hooded",
  yan: "Barbarian",
  ling: "Mage",
};

/** 逻辑动作 → KayKit 动画名 */
const CLIP = {
  idle: "Idle",
  walk: "Walking_A",
  run: "Running_A",
  jumpUp: "Jump_Start",
  jumpAir: "Jump_Idle",
  jumpLand: "Jump_Land",
  attack: "1H_Melee_Attack_Slice_Horizontal",
  sit: "Sit_Chair_Idle",
  act: "Interact",
  pickup: "PickUp",
};

export interface CharacterRig {
  /** 根节点（原点在脚底，已按目标身高标定） */
  root: TransformNode;
  height: number;
  /** 右手骨骼（挂武器用；找不到为 null） */
  handBone: Bone | null;
  skeleton: Skeleton | null;
  play(name: string, loop?: boolean, speed?: number): void;
  /** 当前动作（外部状态机用） */
  current: string;
  dispose(): void;
}

export function findRightHandBone(skeleton: Skeleton): Bone | null {
  // 精确匹配手掌：禁止命中手指、IK、handslot 或回退到左手。
  return skeleton.bones.find(b => /^(hand_r|hand\.r)$/i.test(b.name.replace(/^Clone of /, ""))) ?? null;
}

export async function loadCharacter(scene: Scene, kind: CharacterKind, targetHeight = 1.72): Promise<CharacterRig> {
  const url = `/assets/chars/${FILES[kind]}.glb`;
  const container = await SceneLoader.LoadAssetContainerAsync(url, "", scene);
  const entries = container.instantiateModelsToScene(undefined, false, { doNotInstantiate: false });
  const root = entries.rootNodes[0] as TransformNode;

  // 高度标定：包围盒高度 → 目标身高
  let min = new Vector3(1e9, 1e9, 1e9), max = new Vector3(-1e9, -1e9, -1e9);
  const allMeshes: Mesh[] = [];
  for (const rn of entries.rootNodes) {
    if (rn instanceof Mesh) allMeshes.push(rn);
    for (const c of rn.getChildMeshes()) if (c instanceof Mesh) allMeshes.push(c);
  }
  for (const m of allMeshes) {
    if (!m.getTotalVertices()) continue;
    m.refreshBoundingInfo(true);
    const bb = m.getBoundingInfo().boundingBox;
    for (const c of [bb.minimumWorld, bb.maximumWorld]) {
      min = Vector3.Minimize(min, c);
      max = Vector3.Maximize(max, c);
    }
  }
  const h = Math.max(0.01, max.y - min.y);
  const scale = targetHeight / h;
  // 保留 glTF 加载器在根节点上的坐标系转换，避免把蒙皮与正反面镜像。
  root.scaling.scaleInPlace(scale);
  // 底部对齐脚底
  root.position.y = -min.y * scale;

  // 隐藏 KayKit 自带武器附件（与游戏装备的 Lux 剑重复）；附件是 InstancedMesh，须用 AbstractMesh 匹配
  for (const m of root.getChildMeshes()) {
    if (/(knife|crossbow|throwable|arrow|book)/i.test(m.name)) {
      m.setEnabled(false);
      m.isPickable = false;
    }
  }

  // 动画表（instantiateModelsToScene 克隆的组名带 "Clone of " 前缀，剥离后按原始剪辑名索引）
  const anims = new Map<string, AnimationGroup>();
  for (const g of entries.animationGroups) anims.set(g.name.replace(/^Clone of /, ""), g);

  // 停掉全部动画，等待 play() 启动
  for (const g of anims.values()) { g.stop(); g.reset(); }

  // 右手骨骼
  let handBone: Bone | null = null;
  const skeleton: Skeleton | null = (entries.skeletons as Skeleton[])[0] ?? null;
  if (skeleton) {
    handBone = findRightHandBone(skeleton);
  }

  let current = "";
  const animsMap = anims;
  const allAnims: AnimationGroup[] = [...animsMap.values()];
  const rig: CharacterRig = {
    root,
    height: targetHeight,
    handBone,
    skeleton,
    get current() { return current; },
    play(name, loop = true, speed = 1) {
      const clip = CLIP[name as keyof typeof CLIP] ?? name;
      const g = anims.get(clip) ?? anims.get(CLIP.idle);
      if (!g) { return; }
      if (current === clip && g.isPlaying) { g.speedRatio = speed; return; }
      for (const other of anims.values()) if (other !== g) other.stop();
      g.reset();
      g.play(loop);
      g.speedRatio = speed;
      current = clip;
    },
    dispose() {
      for (const g of allAnims) g.dispose();
      root.dispose();
      container.dispose();
    },
  };
  rig.play("idle");
  return rig;
}
