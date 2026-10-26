import { describe, expect, it } from "vitest";
import { blobImg, readBlob, readJson, type Blob } from "../fixtures/read";
import { gaussian5, laplacian3, sobel3 } from "./filter";

type Prim = {
  id: string;
  op: string;
  params: { dx?: 0 | 1; dy?: 0 | 1 };
  in: Blob;
  out: Blob;
};
const prims = readJson<{ prim: Prim[] }>("manifest.json").prim;
const facts = readJson<{ gaussian5: number[]; laplacian3: number[][] }>(
  "facts.json"
);

function floatDiff(got: Float32Array, want: Float32Array): number {
  expect(got.length).toBe(want.length);
  let worst = 0;
  for (let i = 0; i < want.length; i++) {
    const rel =
      Math.abs(got[i] - want[i]) / (1e-3 * Math.max(1, Math.abs(want[i])));
    worst = Math.max(worst, rel);
  }
  return worst; // <= 1 means within tolerance
}

describe("filters", () => {
  it("kernels equal facts.json", () => {
    // gaussian5: impulse response of the 1-D kernel is [1,4,6,4,1]
    expect(facts.gaussian5.map((v) => v * 16)).toEqual([1, 4, 6, 4, 1]);
    const imp = {
      width: 7,
      height: 7,
      channels: 1 as const,
      data: new Uint8Array(49),
    };
    imp.data[24] = 255;
    const lap = laplacian3({
      ...imp,
      data: Uint8Array.from(imp.data, (v) => (v ? 1 : 0)),
    });
    const resp = [0, 1, 2].map((r) =>
      [0, 1, 2].map((c) => lap[(2 + r) * 7 + 2 + c])
    );
    expect(resp).toEqual(facts.laplacian3);
  });
  it.each(prims.filter((p) => p.op === "gauss5"))("$id within 1", (p) => {
    const got = gaussian5(blobImg(p.in)).data;
    const want = readBlob(p.out) as Uint8Array;
    let max = 0;
    for (let i = 0; i < want.length; i++)
      max = Math.max(max, Math.abs(got[i] - want[i]));
    console.log(`gaussian5 ${p.id} max abs diff ${max}`);
    expect(max).toBeLessThanOrEqual(1);
  });
  it.each(prims.filter((p) => p.op === "sobel"))(
    "$id within 1e-3 relative",
    (p) => {
      const [h, w] = p.in.shape;
      const got = sobel3(
        readBlob(p.in) as Float32Array,
        w,
        h,
        p.params.dx ?? 0,
        p.params.dy ?? 0
      );
      const worst = floatDiff(got, readBlob(p.out) as Float32Array);
      console.log(`sobel3 ${p.id} worst/tolerance ${worst}`);
      expect(worst).toBeLessThanOrEqual(1);
    }
  );
  it.each(prims.filter((p) => p.op === "laplacian3"))(
    "$id within 1e-3 relative",
    (p) => {
      const worst = floatDiff(
        laplacian3(blobImg(p.in)),
        readBlob(p.out) as Float32Array
      );
      console.log(`laplacian3 ${p.id} worst/tolerance ${worst}`);
      expect(worst).toBeLessThanOrEqual(1);
    }
  );
});
