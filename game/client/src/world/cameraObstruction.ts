import { Scene, Vector3, Ray, TransformNode } from "@babylonjs/core";

/** Apply after smoothing too, so interpolation can never carry the camera through a wall. */
export function resolveCameraPosition(scene: Scene, target: Vector3, wanted: Vector3, ignore?: TransformNode): Vector3 {
  const arm = wanted.subtract(target), length = arm.length();
  if (length < .01) return wanted.clone();
  const direction = arm.scale(1/length);
  let distance = length;
  for (const offset of [Vector3.Zero(),new Vector3(.16,0,0),new Vector3(-.16,0,0),new Vector3(0,-.16,0)]) {
    const hit = scene.pickWithRay(new Ray(target.add(offset),direction,length), mesh =>
      mesh.isEnabled() && mesh.isPickable && (!ignore || (mesh !== ignore && !mesh.isDescendantOf(ignore))) && !/glow|pickup|cloud|skybox|playerCapsule/i.test(mesh.name));
    if (hit?.hit) distance=Math.min(distance,Math.max(.15,hit.distance-.25));
  }
  return target.add(direction.scale(distance));
}
