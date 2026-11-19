import { it, expect } from "vitest";
import { islandSideQuad } from "../src/world/island";
import { VertexData } from "@babylonjs/core";

it("岛侧四边形的外缘只出现一次，两个三角形共用内部对角线", () => {
  const indices = islandSideQuad(0,1,2,3);
  const counts = new Map<string,number>();
  for(let i=0;i<indices.length;i+=3) for(let j=0;j<3;j++) {
    const edge=[indices[i+j],indices[i+(j+1)%3]].sort().join(":");
    counts.set(edge,(counts.get(edge)??0)+1);
  }
  for(const edge of ["0:1","0:2","1:3","2:3"]) expect(counts.get(edge)).toBe(1);
  expect([...counts.values()].filter(n=>n===2)).toHaveLength(1);
});

it("岛侧在Babylon左手坐标中法线向外", () => {
  const normals: number[]=[];
  VertexData.ComputeNormals([1,1,0, 0,1,1, .5,0,0, 0,0,.5],islandSideQuad(0,1,2,3),normals);
  expect(normals[0]+normals[2]).toBeGreaterThan(0);
});
