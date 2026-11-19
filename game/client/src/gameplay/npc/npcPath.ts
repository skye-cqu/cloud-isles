export interface WalkPoint { x: number; z: number }

export interface WalkPath {
  reachable: boolean;
  points: WalkPoint[];
}

export interface WalkPathOptions {
  canStand: (x: number, z: number) => boolean;
  step?: number;
  arrivalDistance?: number;
  maxNodes?: number;
}

/** 在可走地表上寻找一条短的八方向路径；目标被占用时可抵达其交互半径。 */
export function findWalkPath(start: WalkPoint, target: WalkPoint, options: WalkPathOptions): WalkPath {
  const step = options.step ?? 1.2;
  const arrivalDistance = options.arrivalDistance ?? 0.6;
  const maxNodes = options.maxNodes ?? 5000;
  const distance = (a: WalkPoint, b: WalkPoint) => Math.hypot(a.x - b.x, a.z - b.z);
  const canCross = (a: WalkPoint, b: WalkPoint) => {
    const samples = Math.ceil(distance(a, b) / (step / 2));
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      if (!options.canStand(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
    }
    return true;
  };
  if (distance(start, target) <= arrivalDistance) return { reachable: true, points: [] };
  if (options.canStand(target.x, target.z) && canCross(start, target)) return { reachable: true, points: [target] };

  const bound = Math.ceil((distance(start, target) + 12) / step);
  const key = (x: number, z: number) => `${x},${z}`;
  const pointAt = (x: number, z: number): WalkPoint => ({ x: start.x + x * step, z: start.z + z * step });
  const open = [{ x: 0, z: 0 }];
  const came = new Map<string, string>();
  const points = new Map<string, WalkPoint>([[key(0, 0), start]]);
  const cost = new Map<string, number>([[key(0, 0), 0]]);
  const dirs = [
    [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
  ] as const;

  while (open.length && points.size <= maxNodes) {
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i], b = open[best];
      const ac = cost.get(key(a.x, a.z))! + distance(pointAt(a.x, a.z), target);
      const bc = cost.get(key(b.x, b.z))! + distance(pointAt(b.x, b.z), target);
      if (ac < bc) best = i;
    }
    const current = open.splice(best, 1)[0];
    const currentKey = key(current.x, current.z);
    const currentPoint = points.get(currentKey)!;
    if (currentKey !== key(0, 0) && distance(currentPoint, target) <= arrivalDistance) {
      const route: WalkPoint[] = [];
      for (let cursor = currentKey; cursor !== key(0, 0); cursor = came.get(cursor)!) route.push(points.get(cursor)!);
      route.reverse();
      return { reachable: true, points: route };
    }
    for (const [dx, dz] of dirs) {
      const x = current.x + dx, z = current.z + dz;
      if (Math.abs(x) > bound || Math.abs(z) > bound) continue;
      const nextKey = key(x, z);
      if (cost.has(nextKey)) continue;
      const next = pointAt(x, z);
      if (!options.canStand(next.x, next.z) || !canCross(currentPoint, next)) continue;
      if (dx && dz && (!options.canStand(currentPoint.x + dx * step, currentPoint.z) || !options.canStand(currentPoint.x, currentPoint.z + dz * step))) continue;
      points.set(nextKey, next);
      came.set(nextKey, currentKey);
      cost.set(nextKey, cost.get(currentKey)! + Math.hypot(dx, dz) * step);
      open.push({ x, z });
    }
  }
  return { reachable: false, points: [] };
}
