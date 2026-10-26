import type { CropSpec, Img } from "../types";
import { assertImg, cropImg } from "./img";
import { roundHalfEven } from "./pyround";
import { resize } from "./resize";

/** ocr.crop_regions with pad = 0: integer crop bounds from the card fractions, at least 1 px each way. */
export function cropRegions(card: Img, crops: readonly CropSpec[]): Img[] {
  assertImg(card);
  const { width: w, height: h } = card;
  return crops.map(([, x0, x1, y0, y1]) => {
    const xa = Math.trunc(roundHalfEven(Math.max(0, x0) * w));
    const xb = Math.trunc(roundHalfEven(Math.min(1, x1) * w));
    const ya = Math.trunc(roundHalfEven(Math.max(0, y0) * h));
    const yb = Math.trunc(roundHalfEven(Math.min(1, y1) * h));
    const xe = Math.min(w, Math.max(xb, xa + 1));
    const ye = Math.min(h, Math.max(yb, ya + 1));
    return cropImg(card, xa, ya, xe - xa, ye - ya);
  });
}

/** Height 48, width max(8, round(w*48/h)); cubic when the crop is shorter than 48, else area. */
export function ocrResize(crop: Img): Img {
  const nw = Math.max(
    8,
    Math.trunc(roundHalfEven((crop.width * 48) / crop.height))
  );
  const interp =
    crop.height < 48 ? "cubic" : nw > crop.width ? "linear" : "area";
  return resize(crop, nw, 48, interp);
}

// (v/255 - 0.5)/0.5 in float32, as numpy does it
const OCR_LUT = new Float32Array(256);
for (let v = 0; v < 256; v++)
  OCR_LUT[v] = Math.fround(Math.fround(Math.fround(v / 255) - 0.5) / 0.5);

/** Paddle input [1,3,48,W], planes B, G, R. */
export function ocrTensor(resized: Img): { data: Float32Array; width: number } {
  assertImg(resized);
  if (resized.height !== 48 || resized.channels === 1)
    throw new Error("ocrTensor needs a 48-high colour image");
  const w = resized.width;
  const c = resized.channels;
  const n = 48 * w;
  const data = new Float32Array(3 * n);
  const s = resized.data;
  for (let i = 0; i < n; i++) {
    data[i] = OCR_LUT[s[i * c + 2]]; // B
    data[n + i] = OCR_LUT[s[i * c + 1]]; // G
    data[2 * n + i] = OCR_LUT[s[i * c]]; // R
  }
  return { data, width: w };
}

/** The card as the embedder sees it: 224x224 area, RGB. */
export function embedResize(card: Img): Img {
  assertImg(card);
  const rgb: Img =
    card.channels === 4
      ? { ...card, channels: 3, data: stripAlpha(card) }
      : card;
  return resize(rgb, 224, 224, "area");
}

function stripAlpha(card: Img): Uint8Array {
  const n = card.width * card.height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = card.data[i * 4];
    out[i * 3 + 1] = card.data[i * 4 + 1];
    out[i * 3 + 2] = card.data[i * 4 + 2];
  }
  return out;
}

const MEAN = [0.485, 0.456, 0.406].map(Math.fround);
const STD = [0.229, 0.224, 0.225].map(Math.fround);
const EMBED_LUT = MEAN.map((m, k) => {
  const t = new Float32Array(256);
  for (let v = 0; v < 256; v++)
    t[v] = Math.fround(Math.fround(Math.fround(v / 255) - m) / STD[k]);
  return t;
});

/** DINOv2 input [1,3,224,224], planes R, G, B, ImageNet mean and std. */
export function embedTensor(resized224: Img): Float32Array {
  assertImg(resized224);
  if (
    resized224.width !== 224 ||
    resized224.height !== 224 ||
    resized224.channels === 1
  ) {
    throw new Error("embedTensor needs a 224x224 colour image");
  }
  const n = 224 * 224;
  const c = resized224.channels;
  const s = resized224.data;
  const out = new Float32Array(3 * n);
  for (let k = 0; k < 3; k++) {
    const lut = EMBED_LUT[k];
    for (let i = 0; i < n; i++) out[k * n + i] = lut[s[i * c + k]];
  }
  return out;
}
