// Port of scanspike/guide.py. Operation order matches Python so the doubles agree bit for bit.
import type { Quad, Rect } from "./types";

export const CARD_ASPECT = 63 / 88;
export const GUIDE_H_FRAC = 0.8;
export const GUIDE_W_MAX_FRAC = 0.86;
/** Frames are cropped to the guide grown by this fraction of its width and height on every side. */
export const GUIDE_EXPAND = 0.25;

/** Centred card guide (x0, y0, x1, y1) in frame pixels (doubles, as in Python). */
export function guideRect(frameW: number, frameH: number): Rect {
  let gh = GUIDE_H_FRAC * frameH;
  let gw = gh * CARD_ASPECT;
  if (gw > GUIDE_W_MAX_FRAC * frameW) {
    gw = GUIDE_W_MAX_FRAC * frameW;
    gh = gw / CARD_ASPECT;
  }
  const x0 = (frameW - gw) / 2;
  const y0 = (frameH - gh) / 2;
  return [x0, y0, x0 + gw, y0 + gh];
}

/** Guide corners TL, TR, BR, BL. Python returns float32, so each coordinate is rounded to float32. */
export function guideQuad(r: Rect): Quad {
  const [x0, y0, x1, y1] = r.map(Math.fround) as Rect;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Crop window [sx, sy, sw, sh]: the guide grown by frac of its width/height per side, clipped to the frame. */
export function expandGuide(
  r: Rect,
  frac: number,
  frameW: number,
  frameH: number
): [sx: number, sy: number, sw: number, sh: number] {
  const dx = frac * (r[2] - r[0]);
  const dy = frac * (r[3] - r[1]);
  const sx = Math.max(0, Math.floor(r[0] - dx));
  const sy = Math.max(0, Math.floor(r[1] - dy));
  const ex = Math.min(frameW, Math.ceil(r[2] + dx));
  const ey = Math.min(frameH, Math.ceil(r[3] + dy));
  return [sx, sy, ex - sx, ey - sy];
}
