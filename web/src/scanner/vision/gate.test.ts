import { describe, expect, it } from "vitest";
import { readBlob, readJson, readPng, type Blob } from "../fixtures/read";
import type { Img, Rect } from "../types";
import {
  GATE,
  TUNED_GATE,
  decideGate,
  measureGate,
  type GateConfig,
} from "./gate";

type Scene = {
  id: string;
  png: string;
  guide: Rect;
  gate: {
    sharpness: number;
    mean_luma: number;
    clipped_frac: number;
    ok: boolean;
    reasons: string[];
  };
  thumb: Blob;
};
const scenes = readJson<{ scenes: Scene[] }>("manifest.json").scenes;
// Centred 63:88 guide (scanspike/guide.py): height 0.80 of the frame, width at most 0.86 of the frame.
function guideRect(fw: number, fh: number): Rect {
  let gh = 0.8 * fh;
  let gw = gh * (63 / 88);
  if (gw > 0.86 * fw) {
    gw = 0.86 * fw;
    gh = gw / (63 / 88);
  }
  const x0 = (fw - gw) / 2;
  const y0 = (fh - gh) / 2;
  return [x0, y0, x0 + gw, y0 + gh];
}
const flat = (w: number, h: number, v: number): Img => ({
  width: w,
  height: h,
  channels: 3,
  data: new Uint8Array(w * h * 3).fill(v),
});

describe("measureGate and decideGate on the synthetic scenes", () => {
  it("has 10 scenes", () => expect(scenes.length).toBe(10));
  it.each(scenes)("$id measures, decides and thumbs like Python", (s) => {
    const m = measureGate(readPng(s.png), s.guide);
    const rel = Math.abs(m.sharpness - s.gate.sharpness) / s.gate.sharpness;
    const dl = Math.abs(m.meanLuma - s.gate.mean_luma);
    const dc = Math.abs(m.clippedFrac - s.gate.clipped_frac);
    const thumb = readBlob(s.thumb) as Uint8Array;
    expect(m.thumb.length).toBe(1024);
    let dt = 0;
    for (let i = 0; i < 1024; i++)
      dt = Math.max(dt, Math.abs(m.thumb[i] - thumb[i]));
    console.log(
      `gate ${s.id} sharpness rel ${rel.toExponential(2)}, luma diff ${dl.toExponential(2)}, clipped diff ${dc}, thumb max ${dt}`
    );
    expect(rel).toBeLessThanOrEqual(0.01);
    expect(dl).toBeLessThanOrEqual(0.5);
    expect(dc).toBeLessThanOrEqual(0.002);
    expect(dt).toBeLessThanOrEqual(1);
    const nearThreshold =
      Math.abs(s.gate.sharpness - TUNED_GATE.sharpMin) / TUNED_GATE.sharpMin <=
      0.01;
    if (!nearThreshold) {
      const d = decideGate(m, TUNED_GATE);
      expect(d.ok).toBe(s.gate.ok);
      expect(d.reasons).toEqual(s.gate.reasons);
    }
  });
});

describe("decideGate (tests/test_gate.py::test_decide_reasons)", () => {
  const rect = guideRect(720, 960);
  const cfg0: GateConfig = {
    sharpMin: 0,
    lumaMin: 40,
    lumaMax: 215,
    clipMax: 0.25,
  };
  it("reports dark, bright, bright+clipped, soft and ok", () => {
    const dark = measureGate(flat(720, 960, 20), rect);
    expect(decideGate(dark, cfg0)).toEqual({ ok: false, reasons: ["dark"] });
    const bright = measureGate(flat(720, 960, 240), rect);
    expect(decideGate(bright, cfg0)).toEqual({
      ok: false,
      reasons: ["bright"],
    });
    const clip = measureGate(flat(720, 960, 255), rect);
    expect(decideGate(clip, cfg0)).toEqual({
      ok: false,
      reasons: ["bright", "clipped"],
    });
    const soft = decideGate(dark, { ...cfg0, sharpMin: dark.sharpness + 1 });
    expect(soft.ok).toBe(false);
    expect(soft.reasons[0]).toBe("soft");
    const mid = measureGate(flat(720, 960, 128), rect);
    expect(decideGate(mid, cfg0)).toEqual({ ok: true, reasons: [] });
  });
  it("keeps the tuned config for parity", () => {
    expect(TUNED_GATE).toEqual({
      sharpMin: 5333.3134765625,
      lumaMin: 40,
      lumaMax: 215,
      clipMax: 0.25,
    });
    const mid = measureGate(flat(720, 960, 128), rect);
    expect(decideGate(mid, TUNED_GATE).reasons).toEqual(["soft"]);
  });
  it("ships with the sharpness check off and the other checks on", () => {
    expect(GATE).toEqual({ ...TUNED_GATE, sharpMin: 0 });
    expect(decideGate(measureGate(flat(720, 960, 128), rect))).toEqual({
      ok: true,
      reasons: [],
    });
    expect(decideGate(measureGate(flat(720, 960, 20), rect)).reasons).toEqual([
      "dark",
    ]);
    expect(decideGate(measureGate(flat(720, 960, 240), rect)).reasons).toEqual([
      "bright",
    ]);
    expect(decideGate(measureGate(flat(720, 960, 255), rect)).reasons).toEqual([
      "bright",
      "clipped",
    ]);
  });
  it("passes a sharp and a soft textured frame", () => {
    const sharpImg = flat(720, 960, 128);
    const softImg = flat(720, 960, 128);
    for (let y = 0; y < 960; y++)
      for (let x = 0; x < 720; x++) {
        const hard = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 90 : 170;
        const soft = Math.round(130 + 6 * Math.sin(x / 40) * Math.cos(y / 40));
        sharpImg.data.fill(hard, (y * 720 + x) * 3, (y * 720 + x) * 3 + 3);
        softImg.data.fill(soft, (y * 720 + x) * 3, (y * 720 + x) * 3 + 3);
      }
    const ms = measureGate(sharpImg, rect);
    const mf = measureGate(softImg, rect);
    expect(mf.sharpness).toBeLessThan(TUNED_GATE.sharpMin);
    expect(ms.sharpness).toBeGreaterThan(mf.sharpness);
    expect(decideGate(ms).ok).toBe(true);
    expect(decideGate(mf)).toEqual({ ok: true, reasons: [] });
    expect(decideGate(mf, TUNED_GATE).reasons).toEqual(["soft"]);
  });
});
