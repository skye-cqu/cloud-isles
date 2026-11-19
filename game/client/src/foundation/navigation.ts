import { CreateNavigationPluginAsync } from "@babylonjs/addons/navigation/factory";
import { Vector3, type Mesh } from "@babylonjs/core";
import * as RecastCore from "@recast-navigation/core";
import * as RecastGenerators from "@recast-navigation/generators";

const localRecast = { ...RecastCore, ...RecastGenerators };
let initialization: Promise<void> | null = null;

function initializeRecast() {
  initialization ??= RecastCore.init().catch((error: unknown) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

/** Builds one disposable, local-island navmesh. Dynamic construction obstacles are intentionally not included. */
export async function createFoundationNavigation(meshes: Mesh[]) {
  await initializeRecast();
  const plugin = await CreateNavigationPluginAsync({ instance: localRecast });
  plugin.createNavMesh(meshes, {
    cs: 0.2,
    ch: 0.2,
    walkableSlopeAngle: 45,
    walkableHeight: 3,
    walkableClimb: 1,
    walkableRadius: 1,
    maxEdgeLen: 12,
    maxSimplificationError: 1.3,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
  });
  let disposed = false;

  return {
    path(start: Vector3, end: Vector3) {
      if (disposed) throw new Error("foundation navigation is disposed");
      const path = plugin.computePath(start, end);
      const last = path.at(-1);
      // Recast returns a partial corridor to the closest edge for disconnected targets.
      return last && Vector3.Distance(last, end) <= 0.25 ? path : [];
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      plugin.dispose();
    },
  };
}
