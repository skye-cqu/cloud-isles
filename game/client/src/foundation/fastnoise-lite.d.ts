declare module "fastnoise-lite" {
  export default class FastNoiseLite {
    constructor(seed?: number);
    SetFrequency(frequency: number): void;
    GetNoise(x: number, y: number, z?: number): number;
  }
}
