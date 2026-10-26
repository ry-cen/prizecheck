import { describe, expect, it } from "vitest";
import {
  blobImg,
  readBlob,
  readJson,
  readPng,
  type Blob,
} from "../fixtures/read";
import type { Quad } from "../types";
import { warpPerspective, rectify, CARD_H, CARD_W } from "./warp";

type Prim = {
  id: string;
  op: string;
  params: { dw: number; dh: number };
  in: Blob[];
  out: Blob;
};
type Scene = { id: string; png: string; quadUsed?: Quad; card?: Blob };
const man = readJson<{ prim: Prim[]; scenes: Scene[] }>("manifest.json");

function compare(
  got: Uint8Array,
  want: Uint8Array
): { max: number; within1: number } {
  expect(got.length).toBe(want.length);
  let max = 0;
  let ok1 = 0;
  for (let i = 0; i < want.length; i++) {
    const d = Math.abs(got[i] - want[i]);
    max = Math.max(max, d);
    if (d <= 1) ok1++;
  }
  return { max, within1: ok1 / want.length };
}

describe("warpPerspective", () => {
  it.each(man.prim.filter((p) => p.op === "warp"))(
    "$id: max <= 2, 99.9% within 1",
    (p) => {
      const src = blobImg(p.in[0]);
      const M = readBlob(p.in[1]) as Float64Array;
      const got = warpPerspective(src, M, p.params.dw, p.params.dh);
      const r = compare(got.data as Uint8Array, readBlob(p.out) as Uint8Array);
      console.log(
        `warpPerspective ${p.id} max abs diff ${r.max}, within 1: ${(r.within1 * 100).toFixed(3)}%`
      );
      expect(r.max).toBeLessThanOrEqual(2);
      expect(r.within1).toBeGreaterThanOrEqual(0.999);
    }
  );

  const withCard = man.scenes.filter((s) => s.card && s.quadUsed);
  it("has scenes carrying a card", () =>
    expect(withCard.length).toBeGreaterThan(0));
  it.each(withCard)("rectify($id) from Python's quad matches card.png", (s) => {
    const card = rectify(readPng(s.png), s.quadUsed as Quad);
    expect([card.width, card.height]).toEqual([CARD_W, CARD_H]);
    const r = compare(
      card.data as Uint8Array,
      readBlob(s.card as Blob) as Uint8Array
    );
    console.log(
      `rectify ${s.id} max abs diff ${r.max}, within 1: ${(r.within1 * 100).toFixed(3)}%`
    );
    expect(r.max).toBeLessThanOrEqual(2);
    expect(r.within1).toBeGreaterThanOrEqual(0.999);
  });
});
