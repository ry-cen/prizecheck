import type { Img, Rect } from "../types";
import { toGray } from "./color";
import { laplacian3 } from "./filter";
import { assertImg, cropImg } from "./img";
import { roundHalfEven } from "./pyround";
import { resize } from "./resize";

export type GateConfig = {
  sharpMin: number;
  lumaMin: number;
  lumaMax: number;
  clipMax: number;
};
/** The tuned config of data/tuning/gate.json (config.sharp_min 5333.3134765625, luma_min 40, luma_max 215, clip_max 0.25). */
export const GATE: GateConfig = {
  sharpMin: 5333.3134765625,
  lumaMin: 40,
  lumaMax: 215,
  clipMax: 0.25,
};
export type GateMeasure = {
  sharpness: number;
  meanLuma: number;
  clippedFrac: number;
  thumb: Uint8Array;
};
export type GateReason = "soft" | "dark" | "bright" | "clipped";

const WORK_H = 512;

/** Port of gate.measure: sharpness (Laplacian variance), luma and clipping of the 512-high grey inside the guide. */
export function measureGate(src: Img, guide: Rect): GateMeasure {
  assertImg(src);
  const { width: w, height: h } = src;
  const xa = Math.max(0, Math.trunc(roundHalfEven(guide[0])));
  const ya = Math.max(0, Math.trunc(roundHalfEven(guide[1])));
  const xb = Math.min(w, Math.trunc(roundHalfEven(guide[2])));
  const yb = Math.min(h, Math.trunc(roundHalfEven(guide[3])));
  if (xb <= xa || yb <= ya)
    throw new Error("gate: guide lies outside the frame");
  const crop =
    xa === 0 && ya === 0 && xb === w && yb === h
      ? src
      : cropImg(src, xa, ya, xb - xa, yb - ya);
  const g = toGray(crop);
  const s = WORK_H / g.height;
  const g512 = resize(
    g,
    Math.max(1, roundHalfEven(g.width * s)),
    WORK_H,
    s < 1 ? "area" : "linear"
  );
  const lap = laplacian3(g512);
  const th = g512.height;
  const tw = g512.width;
  const by = Math.trunc(roundHalfEven(0.03 * th));
  const bx = Math.trunc(roundHalfEven(0.03 * tw));
  let n = 0;
  let sum = 0;
  for (let y = by; y < th - by; y++) {
    for (let x = bx; x < tw - bx; x++) {
      sum += lap[y * tw + x];
      n++;
    }
  }
  let sharpness = 0;
  if (n > 0) {
    const mean = sum / n;
    let ss = 0;
    for (let y = by; y < th - by; y++) {
      for (let x = bx; x < tw - bx; x++) {
        const d = lap[y * tw + x] - mean;
        ss += d * d;
      }
    }
    sharpness = ss / n;
  }
  let lumaSum = 0;
  let clipped = 0;
  const d = g512.data;
  for (let i = 0; i < d.length; i++) {
    lumaSum += d[i];
    if (d[i] >= 250) clipped++;
  }
  return {
    sharpness,
    meanLuma: lumaSum / d.length,
    clippedFrac: clipped / d.length,
    thumb: resize(g512, 32, 32, "area").data as Uint8Array,
  };
}

export function decideGate(
  m: GateMeasure,
  cfg: GateConfig = GATE
): { ok: boolean; reasons: GateReason[] } {
  const reasons: GateReason[] = [];
  if (m.sharpness < cfg.sharpMin) reasons.push("soft");
  if (m.meanLuma < cfg.lumaMin) reasons.push("dark");
  if (m.meanLuma > cfg.lumaMax) reasons.push("bright");
  if (m.clippedFrac > cfg.clipMax) reasons.push("clipped");
  return { ok: reasons.length === 0, reasons };
}
