import { describe, expect, it } from "vitest";
import { readBlob, readJson, type Blob } from "../fixtures/read";
import type { Pt, Quad } from "../types";
import {
  contourArea,
  fitLineL2,
  isContourConvex,
  orderQuad,
  perspectiveTransform,
} from "./geom";

type Prim = {
  id: string;
  op: string;
  params: { degenerate?: boolean };
  in: Blob;
  out: Blob;
};
const prims = readJson<{ prim: Prim[] }>("manifest.json").prim;
const of = (op: string) => prims.filter((p) => p.op === op);

function pts(p: Prim): Pt[] {
  const a = readBlob(p.in);
  const out: Pt[] = [];
  for (let i = 0; i < a.length; i += 2)
    out.push([Number(a[i]), Number(a[i + 1])]);
  return out;
}

describe("contourArea", () => {
  it.each(of("area"))("$id within 1e-3 relative", (p) => {
    const want = (readBlob(p.out) as Float64Array)[0];
    const got = contourArea(pts(p));
    console.log(`contourArea ${p.id} got ${got} want ${want}`);
    expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-3 * Math.max(1, want));
  });
});

describe("isContourConvex", () => {
  it.each(of("convex"))("$id equals cv2", (p) => {
    expect(isContourConvex(pts(p))).toBe(
      (readBlob(p.out) as Uint8Array)[0] === 1
    );
  });
});

describe("orderQuad", () => {
  it.each(of("order"))("$id equals corners.order_quad", (p) => {
    const want = readBlob(p.out) as Float32Array;
    const got = orderQuad(pts(p));
    let max = 0;
    for (let i = 0; i < 4; i++) {
      max = Math.max(
        max,
        Math.abs(got[i][0] - want[i * 2]),
        Math.abs(got[i][1] - want[i * 2 + 1])
      );
    }
    console.log(`orderQuad ${p.id} max abs diff ${max}`);
    expect(max).toBeLessThanOrEqual(1e-4);
  });
});

describe("fitLineL2", () => {
  it.each(of("fitline"))("$id is parallel and shares the centroid", (p) => {
    const want = readBlob(p.out) as Float32Array; // vx, vy, x0, y0
    const [vx, vy, x0, y0] = fitLineL2(pts(p));
    const cross = Math.abs(vx * want[1] - vy * want[0]);
    const cen = Math.max(Math.abs(x0 - want[2]), Math.abs(y0 - want[3]));
    console.log(`fitLineL2 ${p.id} cross ${cross} centroid diff ${cen}`);
    expect(cross).toBeLessThanOrEqual(1e-5);
    expect(cen).toBeLessThanOrEqual(1e-4);
  });
});

describe("perspectiveTransform", () => {
  it.each(of("perspective"))("$id within 1e-6 relative", (p) => {
    const q = pts(p) as Quad;
    const dst: Quad = [
      [0, 0],
      [629, 0],
      [629, 879],
      [0, 879],
    ];
    const got = perspectiveTransform(q, dst);
    const want = readBlob(p.out) as Float64Array;
    let worst = 0;
    for (let i = 0; i < 9; i++)
      worst = Math.max(
        worst,
        Math.abs(got[i] - want[i]) / (1e-6 * Math.max(1, Math.abs(want[i])))
      );
    console.log(`perspectiveTransform ${p.id} worst/tolerance ${worst}`);
    expect(worst).toBeLessThanOrEqual(1);
  });
});
