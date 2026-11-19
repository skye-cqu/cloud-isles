import FastNoiseLite from "fastnoise-lite";

export type FoundationSample = { x: number; z: number; height: number };

/** Samples world coordinates only; callers choose their own island mesh and save format. */
export function createIslandSampler(seed: number) {
  const noise = new FastNoiseLite(seed);
  noise.SetFrequency(0.045);

  const heightAt = (x: number, z: number) => noise.GetNoise(x, z) * 1.8;
  const sampleEdge = (originX: number, originZ: number, size: number): FoundationSample[] =>
    Array.from({ length: size + 1 }, (_, index) => ({
      x: originX + index,
      z: originZ,
      height: heightAt(originX + index, originZ),
    }));

  return { heightAt, sampleEdge };
}
