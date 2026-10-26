import { describe, expect, it } from "vitest";
import { readJson, readPng } from "../fixtures/read";
import { GUIDE_EXPAND, expandGuide } from "../guide";
import type { Img, Quad, Rect } from "../types";
import { findCardGuided } from "./corners";
import { measureGate } from "./gate";

type Scene = { id: string; png: string; guide: Rect };
const s0 = readJson<{ scenes: Scene[] }>("manifest.json").scenes[0];

describe("live crop path on scene 0 (TS vs TS)", () => {
  it("gate is identical and corners agree within 2 px on an RGBA crop of the padded frame", () => {
    const scene = readPng(s0.png);
    const gw = s0.guide[2] - s0.guide[0];
    const gh = s0.guide[3] - s0.guide[1];
    const pad = Math.ceil(0.3 * Math.max(gw, gh)) + 8;
    const W = scene.width + 2 * pad;
    const H = scene.height + 2 * pad;
    const full: Img = {
      width: W,
      height: H,
      channels: 3,
      data: new Uint8Array(W * H * 3),
    };
    for (let i = 0; i < W * H; i++) full.data.set([90, 95, 100], i * 3);
    for (let y = 0; y < scene.height; y++) {
      full.data.set(
        scene.data.subarray(y * scene.width * 3, (y + 1) * scene.width * 3),
        ((y + pad) * W + pad) * 3
      );
    }
    const guide = s0.guide.map((v) => Math.round(v) + pad) as Rect;
    const mFull = measureGate(full, guide);
    const qFull = findCardGuided(full, guide) as Quad;
    expect(qFull).not.toBeNull();

    const [sx, sy, sw, sh] = expandGuide(guide, GUIDE_EXPAND, W, H);
    expect(sx).toBeGreaterThan(0);
    expect(sy).toBeGreaterThan(0);
    expect(sx + sw).toBeLessThan(W);
    expect(sy + sh).toBeLessThan(H);
    const crop: Img = {
      width: sw,
      height: sh,
      channels: 4,
      data: new Uint8Array(sw * sh * 4).fill(255),
    };
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const o = ((sy + y) * W + sx + x) * 3;
        crop.data.set(full.data.subarray(o, o + 3), (y * sw + x) * 4);
      }
    }
    const g2: Rect = [
      guide[0] - sx,
      guide[1] - sy,
      guide[2] - sx,
      guide[3] - sy,
    ];
    const mCrop = measureGate(crop, g2);
    expect(mCrop.sharpness).toBe(mFull.sharpness);
    expect(mCrop.meanLuma).toBe(mFull.meanLuma);
    expect(mCrop.clippedFrac).toBe(mFull.clippedFrac);
    expect(Array.from(mCrop.thumb)).toEqual(Array.from(mFull.thumb));

    const qCrop = findCardGuided(crop, g2) as Quad;
    expect(qCrop).not.toBeNull();
    let max = 0;
    for (let i = 0; i < 4; i++)
      max = Math.max(
        max,
        Math.hypot(
          qCrop[i][0] + sx - qFull[i][0],
          qCrop[i][1] + sy - qFull[i][1]
        )
      );
    console.log(`livecrop max corner distance ${max}`);
    expect(max).toBeLessThanOrEqual(2);
  });
});
