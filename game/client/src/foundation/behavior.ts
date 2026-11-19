import { ArriveBehavior, EntityManager, Vector3, Vehicle } from "yuka";
import type { Vector3 as BabylonVector3 } from "@babylonjs/core";

/** A small Yuka-driven actor loop; it is not an ecosystem or NPC policy. */
export function createFoundationBehavior(target: BabylonVector3) {
  const vehicle = new Vehicle();
  vehicle.maxSpeed = 4;
  vehicle.maxForce = 20;
  const destination = new Vector3(target.x, target.y, target.z);
  vehicle.steering.add(new ArriveBehavior(destination, 3, 0.15));
  const manager = new EntityManager();
  manager.add(vehicle);
  let updates = 0;
  let paused = false;
  let disposed = false;

  return {
    vehicle,
    get ticks() { return updates; },
    get state() { return paused ? "paused" : vehicle.position.distanceTo(destination) <= 0.15 ? "arrived" : "arriving"; },
    get paused() { return paused; },
    setPaused(value: boolean) { paused = value; },
    tick(deltaSeconds: number) {
      if (disposed || paused) return;
      manager.update(deltaSeconds);
      updates += 1;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      manager.clear();
      vehicle.steering.clear();
    },
  };
}
