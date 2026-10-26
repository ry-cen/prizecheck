import { describe, expect, it } from "vitest";
import { blobImg, readBlob, readJson, type Blob } from "../fixtures/read";
import { resize } from "./resize";

type Prim = {
  id: string;
  op: string;
  params: { mode: "area" | "linear" | "cubic"; dw: number; dh: number };
  in: Blob;
  out: Blob;
};
const prims = readJson<{ prim: Prim[] }>("manifest.json").prim.filter(
  (p) => p.op === "resize"
);

describe("resize", () => {
  it("has the 7 fixture cases", () => expect(prims.length).toBe(7));
  it.each(prims)("$id ($params.mode) within 1", (p) => {
    const got = resize(blobImg(p.in), p.params.dw, p.params.dh, p.params.mode);
    const want = readBlob(p.out) as Uint8Array;
    expect(got.data.length).toBe(want.length);
    let max = 0;
    for (let i = 0; i < want.length; i++)
      max = Math.max(max, Math.abs(got.data[i] - want[i]));
    console.log(`resize ${p.id} ${p.params.mode} max abs diff ${max}`);
    expect(max).toBeLessThanOrEqual(1);
  });
  it("copies when the size is unchanged and refuses to enlarge with area", () => {
    const img = {
      width: 2,
      height: 2,
      channels: 1 as const,
      data: Uint8Array.of(1, 2, 3, 4),
    };
    expect(Array.from(resize(img, 2, 2, "area").data)).toEqual([1, 2, 3, 4]);
    expect(() => resize(img, 4, 4, "area")).toThrow();
  });
  it("area on one equal axis uses identity weights", () => {
    const img = {
      width: 4,
      height: 2,
      channels: 1 as const,
      data: Uint8Array.of(0, 10, 20, 30, 40, 50, 60, 70),
    };
    expect(Array.from(resize(img, 4, 1, "area").data)).toEqual([
      20, 30, 40, 50,
    ]);
  });
});
