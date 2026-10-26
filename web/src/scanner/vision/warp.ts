import type { Img, Quad } from "../types";
import { assertImg } from "./img";
import { perspectiveTransform } from "./geom";
import { roundHalfEven } from "./pyround";

export const CARD_W = 630;
export const CARD_H = 880;

function invert3(M: Float64Array): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0) throw new Error("singular matrix");
  const k = 1 / det;
  return Float64Array.from([
    A * k,
    -(b * i - c * h) * k,
    (b * f - c * e) * k,
    B * k,
    (a * i - c * g) * k,
    -(a * f - c * d) * k,
    C * k,
    -(a * h - b * g) * k,
    (a * e - b * d) * k,
  ]);
}

const sat32 = (v: number) =>
  v > 2147483647 ? 2147483647 : v < -2147483648 ? -2147483648 : v;

/**
 * OpenCV warpPerspective, bilinear, BORDER_CONSTANT 0, 1/32 sub-pixel positions, 15-bit weights.
 * M is the forward matrix (source to destination). Output is RGB; alpha is ignored.
 */
export function warpPerspective(
  src: Img,
  M: Float64Array,
  dw: number,
  dh: number
): Img {
  assertImg(src);
  if (src.channels === 1)
    throw new Error("warpPerspective needs a colour image");
  const Mi = invert3(M);
  const { width: sw, height: sh, channels: sc } = src;
  const s = src.data;
  const out = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const X0 = Mi[1] * y + Mi[2];
    const Y0 = Mi[4] * y + Mi[5];
    const W0 = Mi[7] * y + Mi[8];
    for (let x = 0; x < dw; x++) {
      let W = W0 + Mi[6] * x;
      W = W ? 32 / W : 0;
      const X = sat32(roundHalfEven((X0 + Mi[0] * x) * W));
      const Y = sat32(roundHalfEven((Y0 + Mi[3] * x) * W));
      const ix = X >> 5;
      const iy = Y >> 5;
      const fx = X & 31;
      const fy = Y & 31;
      const w00 = (32 - fx) * (32 - fy) * 32;
      const w01 = fx * (32 - fy) * 32;
      const w10 = (32 - fx) * fy * 32;
      const w11 = fx * fy * 32;
      const in00 = ix >= 0 && ix < sw && iy >= 0 && iy < sh;
      const in01 = ix + 1 >= 0 && ix + 1 < sw && iy >= 0 && iy < sh;
      const in10 = ix >= 0 && ix < sw && iy + 1 >= 0 && iy + 1 < sh;
      const in11 = ix + 1 >= 0 && ix + 1 < sw && iy + 1 >= 0 && iy + 1 < sh;
      const o = (y * dw + x) * 3;
      for (let k = 0; k < 3; k++) {
        let acc = 16384;
        if (in00) acc += w00 * s[(iy * sw + ix) * sc + k];
        if (in01) acc += w01 * s[(iy * sw + ix + 1) * sc + k];
        if (in10) acc += w10 * s[((iy + 1) * sw + ix) * sc + k];
        if (in11) acc += w11 * s[((iy + 1) * sw + ix + 1) * sc + k];
        const v = acc >> 15;
        out[o + k] = v > 255 ? 255 : v < 0 ? 0 : v;
      }
    }
  }
  return { width: dw, height: dh, channels: 3, data: out };
}

/** corners.rectify: straighten the quad (TL, TR, BR, BL) to a 630x880 card. */
export function rectify(src: Img, quad: Quad): Img {
  const dst: Quad = [
    [0, 0],
    [CARD_W - 1, 0],
    [CARD_W - 1, CARD_H - 1],
    [0, CARD_H - 1],
  ];
  return warpPerspective(src, perspectiveTransform(quad, dst), CARD_W, CARD_H);
}
