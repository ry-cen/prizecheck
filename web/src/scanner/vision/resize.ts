import type { Img } from "../types";
import { assertImg } from "./img";

type Axis = { taps: number; idx: Int32Array; wt: Float64Array };

const clampI = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function cubicW(d: number): number {
  const A = -0.75;
  const a = Math.abs(d);
  if (a <= 1) return (A + 2) * a * a * a - (A + 3) * a * a + 1;
  if (a < 2) return A * a * a * a - 5 * A * a * a + 8 * A * a - 4 * A;
  return 0;
}

function buildAxis(
  sn: number,
  dn: number,
  interp: "area" | "linear" | "cubic"
): Axis {
  if (interp === "area") {
    // destination pixel d covers source [d*sn/dn, (d+1)*sn/dn); integer arithmetic in units of 1/dn
    const taps = Math.ceil(sn / dn) + 1;
    const idx = new Int32Array(dn * taps);
    const wt = new Float64Array(dn * taps);
    for (let d = 0; d < dn; d++) {
      const lo = d * sn;
      const hi = (d + 1) * sn;
      let t = 0;
      for (let i = Math.floor(lo / dn); i < sn && i * dn < hi; i++) {
        const ov = Math.min(hi, (i + 1) * dn) - Math.max(lo, i * dn);
        if (ov <= 0) continue;
        idx[d * taps + t] = i;
        wt[d * taps + t] = ov / sn;
        t++;
      }
    }
    return { taps, idx, wt };
  }
  const scale = sn / dn;
  if (interp === "linear") {
    const idx = new Int32Array(dn * 2);
    const wt = new Float64Array(dn * 2);
    for (let d = 0; d < dn; d++) {
      const fx = (d + 0.5) * scale - 0.5;
      let sx = Math.floor(fx);
      let fr = fx - sx;
      if (sx < 0) {
        sx = 0;
        fr = 0;
      }
      if (sx >= sn - 1) {
        sx = sn - 1;
        fr = 0;
      }
      idx[d * 2] = sx;
      idx[d * 2 + 1] = Math.min(sn - 1, sx + 1);
      wt[d * 2] = 1 - fr;
      wt[d * 2 + 1] = fr;
    }
    return { taps: 2, idx, wt };
  }
  const idx = new Int32Array(dn * 4);
  const wt = new Float64Array(dn * 4);
  for (let d = 0; d < dn; d++) {
    const fx = (d + 0.5) * scale - 0.5;
    const sx = Math.floor(fx);
    const fr = fx - sx;
    for (let k = 0; k < 4; k++) {
      idx[d * 4 + k] = clampI(sx - 1 + k, 0, sn - 1);
      wt[d * 4 + k] = cubicW(fr - (k - 1));
    }
  }
  return { taps: 4, idx, wt };
}

/** Round half to even, saturate to 0..255. */
function sat(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  const r = d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

/** uint8 resize of any channel count. "area" only shrinks (throws on enlarge). */
export function resize(
  src: Img,
  dw: number,
  dh: number,
  interp: "area" | "linear" | "cubic"
): Img {
  assertImg(src);
  const { width: sw, height: sh, channels: c } = src;
  if (!(dw >= 1 && dh >= 1) || !Number.isInteger(dw) || !Number.isInteger(dh))
    throw new Error(`bad size ${dw}x${dh}`);
  if (dw === sw && dh === sh)
    return {
      width: sw,
      height: sh,
      channels: c,
      data: Uint8Array.from(src.data),
    };
  if (interp === "area" && (dw > sw || dh > sh))
    throw new Error(`area resize cannot enlarge ${sw}x${sh} to ${dw}x${dh}`);
  const ax = buildAxis(sw, dw, interp);
  const ay = buildAxis(sh, dh, interp);
  const s = src.data;
  const mid = new Float64Array(sh * dw * c);
  const tx = ax.taps;
  for (let y = 0; y < sh; y++) {
    const row = y * sw * c;
    for (let x = 0; x < dw; x++) {
      for (let k = 0; k < c; k++) {
        let acc = 0;
        for (let t = 0; t < tx; t++)
          acc += ax.wt[x * tx + t] * s[row + ax.idx[x * tx + t] * c + k];
        mid[(y * dw + x) * c + k] = acc;
      }
    }
  }
  const out = new Uint8Array(dw * dh * c);
  const ty = ay.taps;
  const stride = dw * c;
  for (let y = 0; y < dh; y++) {
    for (let j = 0; j < stride; j++) {
      let acc = 0;
      for (let t = 0; t < ty; t++)
        acc += ay.wt[y * ty + t] * mid[ay.idx[y * ty + t] * stride + j];
      out[y * stride + j] = sat(acc);
    }
  }
  return { width: dw, height: dh, channels: c, data: out };
}
