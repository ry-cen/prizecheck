/** Interleaved 8-bit image. 3 or 4 channels are R,G,B(,A) in that order. */
export type Img = {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  data: Uint8Array | Uint8ClampedArray;
};
export type Rect = [x0: number, y0: number, x1: number, y1: number];
export type Pt = [x: number, y: number];
export type Quad = [Pt, Pt, Pt, Pt]; // TL, TR, BR, BL
export type CropSpec = readonly [
  name: string,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
]; // card fractions
