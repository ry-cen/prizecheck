import { describe, expect, it } from "vitest";
import { blobImg, readBlob, readJson, type Blob } from "../fixtures/read";
import type { CropSpec } from "../types";
import {
  cropRegions,
  embedResize,
  embedTensor,
  ocrResize,
  ocrTensor,
} from "./prep";

// data/tuning/ocr.json config.crops (kept local so this test does not depend on recognize/)
const CROPS: CropSpec[] = [
  ["left", 0.03, 0.36, 0.93, 0.972],
  ["right", 0.72, 0.98, 0.938, 0.985],
  ["right_narrow", 0.8, 0.98, 0.938, 0.985],
  ["right_high", 0.72, 0.98, 0.91, 0.946],
];
type Scene = {
  id: string;
  card?: Blob;
  ocr?: { name: string; crop: Blob; resized: Blob }[];
  embed224?: Blob;
};
const scenes = readJson<{ scenes: Scene[] }>("manifest.json").scenes.filter(
  (s) => s.card && s.ocr && s.embed224
);

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe("prep from Python's card", () => {
  it("has scenes carrying a card", () =>
    expect(scenes.length).toBeGreaterThan(0));
  it.each(scenes)(
    "$id: crops exact, 48-high resize <= 1, embed224 <= 1, tensors <= 1e-6",
    (s) => {
      const card = blobImg(s.card as Blob);
      const crops = cropRegions(card, CROPS);
      const ocr = s.ocr as NonNullable<Scene["ocr"]>;
      expect(crops.length).toBe(ocr.length);
      ocr.forEach((o, i) => {
        expect(CROPS[i][0]).toBe(o.name);
        const want = blobImg(o.crop);
        expect([crops[i].width, crops[i].height]).toEqual([
          want.width,
          want.height,
        ]);
        expect(maxDiff(crops[i].data, want.data)).toBe(0);
        const rs = ocrResize(crops[i]);
        const wantRs = blobImg(o.resized);
        expect([rs.width, rs.height]).toEqual([wantRs.width, wantRs.height]);
        const d = maxDiff(rs.data, wantRs.data);
        console.log(`prep ${s.id} ${o.name} resize max abs diff ${d}`);
        expect(d).toBeLessThanOrEqual(1);
        // tensor from the uint8 (Python's own resized): B, G, R planes
        const t = ocrTensor(wantRs);
        expect(t.width).toBe(wantRs.width);
        const n = 48 * wantRs.width;
        let td = 0;
        for (let p = 0; p < n; p++) {
          for (let c = 0; c < 3; c++) {
            const v = wantRs.data[p * 3 + (2 - c)];
            td = Math.max(
              td,
              Math.abs(t.data[c * n + p] - (v / 255 - 0.5) / 0.5)
            );
          }
        }
        expect(td).toBeLessThanOrEqual(1e-6);
      });
      const e = embedResize(card);
      const want224 = blobImg(s.embed224 as Blob);
      const d = maxDiff(e.data, want224.data);
      console.log(`prep ${s.id} embed224 max abs diff ${d}`);
      expect(d).toBeLessThanOrEqual(1);
      const t = embedTensor(want224);
      const mean = [0.485, 0.456, 0.406];
      const std = [0.229, 0.224, 0.225];
      let td = 0;
      for (let c = 0; c < 3; c++) {
        for (let p = 0; p < 224 * 224; p++) {
          td = Math.max(
            td,
            Math.abs(
              t[c * 224 * 224 + p] -
                (want224.data[p * 3 + c] / 255 - mean[c]) / std[c]
            )
          );
        }
      }
      console.log(`prep ${s.id} embed tensor max abs diff ${td}`);
      expect(td).toBeLessThanOrEqual(1e-6);
    }
  );
  it("orders OCR planes B, G, R and embed planes R, G, B on a 1-pixel image", () => {
    const px = {
      width: 1,
      height: 48,
      channels: 3 as const,
      data: new Uint8Array(48 * 3),
    };
    for (let i = 0; i < 48; i++) px.data.set([255, 0, 0], i * 3); // pure red
    const t = ocrTensor(px);
    expect([t.data[0], t.data[48], t.data[96]]).toEqual([-1, -1, 1]); // B, G, R
    const e224 = {
      width: 224,
      height: 224,
      channels: 3 as const,
      data: new Uint8Array(224 * 224 * 3),
    };
    e224.data.set([255, 0, 0], 0);
    const et = embedTensor(e224);
    expect(et[0]).toBeCloseTo((1 - 0.485) / 0.229, 5); // plane 0 is R
    expect(et[224 * 224]).toBeCloseTo((0 - 0.456) / 0.224, 5);
  });
});
