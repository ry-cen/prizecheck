import type { Img } from "../types";
import { assertImg } from "./img";

function reflect101(i: number, n: number): number {
  if (n === 1) return 0;
  if (i < 0) i = -i;
  if (i >= n) i = 2 * n - 2 - i;
  return i;
}

/** 5x5 Gaussian, kernel [1,4,6,4,1]/16 both ways, uint8 in and out, BORDER_REFLECT_101. */
export function gaussian5(src: Img): Img {
  assertImg(src);
  if (src.channels !== 1) throw new Error("gaussian5 needs a 1-channel image");
  const { width: w, height: h } = src;
  const s = src.data;
  const tmp = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = reflect101(x - 2, w);
      const xm1 = reflect101(x - 1, w);
      const xp1 = reflect101(x + 1, w);
      const xp2 = reflect101(x + 2, w);
      tmp[r + x] =
        s[r + xm2] +
        4 * s[r + xm1] +
        6 * s[r + x] +
        4 * s[r + xp1] +
        s[r + xp2];
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const r0 = reflect101(y - 2, h) * w;
    const r1 = reflect101(y - 1, h) * w;
    const r2 = y * w;
    const r3 = reflect101(y + 1, h) * w;
    const r4 = reflect101(y + 2, h) * w;
    for (let x = 0; x < w; x++) {
      out[r2 + x] =
        (tmp[r0 + x] +
          4 * tmp[r1 + x] +
          6 * tmp[r2 + x] +
          4 * tmp[r3 + x] +
          tmp[r4 + x] +
          128) >>
        8;
    }
  }
  return { width: w, height: h, channels: 1, data: out };
}

/** 3x3 Sobel (ksize 3), BORDER_REFLECT_101. dx=1: [-1,0,1] across by [1,2,1] down; dy=1 is the transpose. */
export function sobel3(
  src: Float32Array,
  w: number,
  h: number,
  dx: 0 | 1,
  dy: 0 | 1
): Float32Array {
  if (dx + dy !== 1) throw new Error("sobel3 supports exactly one of dx, dy");
  if (src.length !== w * h) throw new Error("sobel3: length mismatch");
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = reflect101(y - 1, h) * w;
    const y0 = y * w;
    const yp = reflect101(y + 1, h) * w;
    for (let x = 0; x < w; x++) {
      const xm = reflect101(x - 1, w);
      const xp = reflect101(x + 1, w);
      if (dx === 1) {
        out[y0 + x] =
          src[ym + xp] -
          src[ym + xm] +
          2 * (src[y0 + xp] - src[y0 + xm]) +
          (src[yp + xp] - src[yp + xm]);
      } else {
        out[y0 + x] =
          src[yp + xm] -
          src[ym + xm] +
          2 * (src[yp + x] - src[ym + x]) +
          (src[yp + xp] - src[ym + xp]);
      }
    }
  }
  return out;
}

/** cv2.Laplacian(ksize=3): kernel [[2,0,2],[0,-8,0],[2,0,2]], BORDER_REFLECT_101. */
export function laplacian3(src: Img): Float32Array {
  assertImg(src);
  if (src.channels !== 1) throw new Error("laplacian3 needs a 1-channel image");
  const { width: w, height: h } = src;
  const s = src.data;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = reflect101(y - 1, h) * w;
    const y0 = y * w;
    const yp = reflect101(y + 1, h) * w;
    for (let x = 0; x < w; x++) {
      const xm = reflect101(x - 1, w);
      const xp = reflect101(x + 1, w);
      out[y0 + x] =
        2 * (s[ym + xm] + s[ym + xp] + s[yp + xm] + s[yp + xp]) - 8 * s[y0 + x];
    }
  }
  return out;
}
