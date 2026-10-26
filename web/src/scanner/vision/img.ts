import type { Img } from "../types";

export function assertImg(src: Img): void {
  if (
    !(src.width > 0 && src.height > 0) ||
    !Number.isInteger(src.width) ||
    !Number.isInteger(src.height)
  ) {
    throw new Error(`bad image size ${src.width}x${src.height}`);
  }
  if (src.channels !== 1 && src.channels !== 3 && src.channels !== 4)
    throw new Error(`bad channel count ${src.channels}`);
  if (src.data.length !== src.width * src.height * src.channels) {
    throw new Error(
      `image data length ${src.data.length} != ${src.width}x${src.height}x${src.channels}`
    );
  }
}

/** Copy the integer rectangle [x, x+w) x [y, y+h), keeping the channel count. The rectangle must lie inside src. */
export function cropImg(
  src: Img,
  x: number,
  y: number,
  w: number,
  h: number
): Img {
  if (
    x < 0 ||
    y < 0 ||
    w < 1 ||
    h < 1 ||
    x + w > src.width ||
    y + h > src.height
  ) {
    throw new Error(
      `crop ${x},${y} ${w}x${h} outside ${src.width}x${src.height}`
    );
  }
  const c = src.channels;
  const out = new Uint8Array(w * h * c);
  const rowBytes = w * c;
  for (let j = 0; j < h; j++) {
    const from = ((y + j) * src.width + x) * c;
    out.set(src.data.subarray(from, from + rowBytes), j * rowBytes);
  }
  return { width: w, height: h, channels: c, data: out };
}

/** Drop alpha; 1-channel input becomes grey RGB; 3-channel input is returned as is. */
export function toRgb(src: Img): Img {
  if (src.channels === 3) return src;
  const n = src.width * src.height;
  const out = new Uint8Array(n * 3);
  if (src.channels === 4) {
    for (let i = 0, p = 0, q = 0; i < n; i++, p += 4, q += 3) {
      out[q] = src.data[p];
      out[q + 1] = src.data[p + 1];
      out[q + 2] = src.data[p + 2];
    }
  } else {
    for (let i = 0; i < n; i++)
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = src.data[i];
  }
  return { width: src.width, height: src.height, channels: 3, data: out };
}
