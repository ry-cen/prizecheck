import type { Img } from "../types";
import { assertImg } from "./img";
import { roundHalfEven } from "./pyround";

/**
 * RGB(A) to 1-channel grey. The brief says 14-bit coefficients (4899, 9617, 1868); cv2 4.12 (the fixture generator)
 * uses 15-bit ones that sum to exactly 32768: Y = (R*9798 + G*19235 + B*3735 + 16384) >> 15. Verified bit-exact
 * on 160k random pixels and facts.json; the 14-bit form differs by 1 on about 0.3% of pixels.
 */
export function toGray(src: Img): Img {
  assertImg(src);
  const n = src.width * src.height;
  const out = new Uint8Array(n);
  if (src.channels === 1) {
    out.set(src.data);
  } else {
    const c = src.channels;
    const d = src.data;
    for (let i = 0, p = 0; i < n; i++, p += c)
      out[i] = (d[p] * 9798 + d[p + 1] * 19235 + d[p + 2] * 3735 + 16384) >> 15;
  }
  return { width: src.width, height: src.height, channels: 1, data: out };
}

// OpenCV's 8-bit BGR2Lab integer path (color_lab.cpp, RGB2Lab_b).
const LAB_SHIFT = 12;
const GAMMA_SHIFT = 3;
const LAB_SHIFT2 = LAB_SHIFT + GAMMA_SHIFT;
const CBRT_SIZE = ((256 * 3) / 2) * (1 << GAMMA_SHIFT); // 3072
const M = [
  [0.412453, 0.35758, 0.180423],
  [0.212671, 0.71516, 0.072169],
  [0.019334, 0.119193, 0.950227],
];
const WHITE = [0.950456, 1, 1.088754];
const C: number[] = [];
for (let i = 0; i < 3; i++)
  for (let j = 0; j < 3; j++)
    C.push(roundHalfEven((1 << LAB_SHIFT) * (M[i][j] / WHITE[i])));
const LSCALE = ((116 * 255 + 50) / 100) | 0;
const LSHIFT = -(((16 * 255 * (1 << LAB_SHIFT2) + 50) / 100) | 0);

const sat16 = (v: number) => Math.min(65535, Math.max(0, v));
const GAMMA = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  const x = i / 255;
  const lin = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  GAMMA[i] = sat16(roundHalfEven(255 * (1 << GAMMA_SHIFT) * lin));
}
const CBRT = new Int32Array(CBRT_SIZE);
for (let i = 0; i < CBRT_SIZE; i++) {
  const t = i / (255 * (1 << GAMMA_SHIFT));
  const f = t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  CBRT[i] = sat16(roundHalfEven((1 << LAB_SHIFT2) * f));
}
const descale = (x: number, n: number) => (x + (1 << (n - 1))) >> n;
const sat8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** RGB(A) to 3-channel uint8 L, a, b, matching OpenCV's 8-bit conversion. */
export function toLab(src: Img): Img {
  assertImg(src);
  if (src.channels === 1) throw new Error("toLab needs a colour image");
  const n = src.width * src.height;
  const out = new Uint8Array(n * 3);
  const c = src.channels;
  const d = src.data;
  for (let i = 0, p = 0, q = 0; i < n; i++, p += c, q += 3) {
    const R = GAMMA[d[p]];
    const G = GAMMA[d[p + 1]];
    const B = GAMMA[d[p + 2]];
    const fX = CBRT[descale(R * C[0] + G * C[1] + B * C[2], LAB_SHIFT)];
    const fY = CBRT[descale(R * C[3] + G * C[4] + B * C[5], LAB_SHIFT)];
    const fZ = CBRT[descale(R * C[6] + G * C[7] + B * C[8], LAB_SHIFT)];
    out[q] = sat8(descale(LSCALE * fY + LSHIFT, LAB_SHIFT2));
    out[q + 1] = sat8(
      descale(500 * (fX - fY) + 128 * (1 << LAB_SHIFT2), LAB_SHIFT2)
    );
    out[q + 2] = sat8(
      descale(200 * (fY - fZ) + 128 * (1 << LAB_SHIFT2), LAB_SHIFT2)
    );
  }
  return { width: src.width, height: src.height, channels: 3, data: out };
}
