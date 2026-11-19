import {
  Color3,
  CharacterSupportedState,
  FlyCamera,
  GizmoManager,
  MeshBuilder,
  PhysicsAggregate,
  PhysicsCharacterController,
  PhysicsMotionType,
  PhysicsShapeType,
  Quaternion,
  StandardMaterial,
  Vector3,
  type Scene,
} from "@babylonjs/core";

/** Creates an isolated controller/platform/editor-preview set after the caller enables Havok on its scene. */
export function createFoundationPhysics(scene: Scene) {
  const platform = MeshBuilder.CreateBox("foundation-platform", { width: 5, height: 0.4, depth: 5 }, scene);
  platform.position.y = -0.2;
  const platformBody = new PhysicsAggregate(platform, PhysicsShapeType.BOX, { mass: 0 }, scene);
  platformBody.body.setMotionType(PhysicsMotionType.ANIMATED);
  const controller = new PhysicsCharacterController(new Vector3(0, 1.1, 0), {
    capsuleHeight: 1.8,
    capsuleRadius: 0.35,
  }, scene);
  const avatar = MeshBuilder.CreateCapsule("foundation-character", { height: 1.8, radius: 0.35 }, scene);
  const avatarMaterial = new StandardMaterial("foundation-character-mat", scene);
  avatarMaterial.diffuseColor = new Color3(0.38, 0.85, 1);
  avatar.material = avatarMaterial;
  const camera = new FlyCamera("foundation-fly-camera", new Vector3(8, 6, -8), scene);
  camera.setTarget(Vector3.Zero());
  camera.attachControl(true);
  const gizmos = new GizmoManager(scene);
  gizmos.positionGizmoEnabled = true;
  gizmos.rotationGizmoEnabled = true;
  gizmos.scaleGizmoEnabled = false;
  const preview = MeshBuilder.CreateBox("foundation-build-preview", { size: 0.8 }, scene);
  preview.position.set(0, 0.4, 0);
  const previewMaterial = new StandardMaterial("foundation-build-preview-mat", scene);
  previewMaterial.diffuseColor = new Color3(0.9, 0.35, 0.85);
  preview.material = previewMaterial;
  gizmos.attachableMeshes = [preview];
  if (gizmos.gizmos.positionGizmo) gizmos.gizmos.positionGizmo.snapDistance = 0.5;
  if (gizmos.gizmos.rotationGizmo) gizmos.gizmos.rotationGizmo.snapDistance = Math.PI / 12;
  let support = "unknown";
  const gravity = new Vector3(0, -9.81, 0);
  const desiredVelocity = Vector3.Zero();
  const resolvedVelocity = Vector3.Zero();

  const beforeRender = scene.onBeforeRenderObservable.add(() => {
    const delta = scene.getEngine().getDeltaTime() / 1000;
    platform.position.x = Math.sin(performance.now() / 1200) * 1.5;
    platformBody.body.setTargetTransform(platform.position, platform.rotationQuaternion ?? Quaternion.Identity());
    const surface = controller.checkSupport(delta, new Vector3(0, -1, 0));
    support = surface.supportedState === CharacterSupportedState.SUPPORTED ? "supported" : "unsupported";
    desiredVelocity.set(Math.sin(performance.now() / 800) * 0.8, 0, 0);
    if (surface.supportedState === CharacterSupportedState.SUPPORTED) {
      controller.calculateMovementToRef(delta, Vector3.Forward(), surface.averageSurfaceNormal,
        controller.getVelocity(), surface.averageSurfaceVelocity, desiredVelocity, Vector3.Up(), resolvedVelocity);
    } else {
      resolvedVelocity.copyFrom(controller.getVelocity()).addInPlace(gravity.scale(delta));
      resolvedVelocity.x = desiredVelocity.x;
    }
    controller.setVelocity(resolvedVelocity);
    controller.integrate(delta, surface, gravity);
    avatar.position.copyFrom(controller.getPosition());
  });

  return {
    platform,
    controller,
    camera,
    gizmos,
    get support() { return support; },
    get characterPosition() { return controller.getPosition(); },
    get previewPosition() { return preview.position; },
    dispose() {
      scene.onBeforeRenderObservable.remove(beforeRender);
      gizmos.dispose();
      camera.dispose();
      controller.dispose();
      platformBody.dispose();
      avatar.dispose();
      avatarMaterial.dispose();
      preview.dispose();
      previewMaterial.dispose();
      platform.dispose();
    },
  };
}
