// Node-only helpers for reading the committed parity fixtures (fixtures/parity) and the local real-art fixtures
// (__local__, gitignored). PNGs are decoded with node:zlib so the tests need no image dependency.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import type { Img } from "../types";

export const FIX = fileURLToPath(new URL("./parity/", import.meta.url));
export const LOCAL = fileURLToPath(new URL("../__local__/", import.meta.url));

export type Blob = {
  file: string;
  dtype: "u8" | "i8" | "f32" | "f64";
  shape: number[];
};
export type BlobData = Uint8Array | Int8Array | Float32Array | Float64Array;

export function readJson<T>(rel: string, base: string = FIX): T {
  return JSON.parse(readFileSync(join(base, rel), "utf8")) as T;
}

type Decoded = {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  data: Uint8Array;
};

/** Decode a non-interlaced 8-bit grey, RGB or RGBA PNG (what cv2.imwrite writes). */
function decodePng(path: string): Decoded {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  let width = 0;
  let height = 0;
  let channels: 1 | 3 | 4 = 3;
  const idat: Buffer[] = [];
  for (let pos = 8; pos < buf.length;) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      if (depth !== 8 || body[12] !== 0)
        throw new Error(
          `${path}: only 8-bit non-interlaced PNGs are supported`
        );
      if (color === 0) channels = 1;
      else if (color === 2) channels = 3;
      else if (color === 6) channels = 4;
      else throw new Error(`${path}: unsupported PNG colour type ${color}`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c =
        x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0)
        throw new Error(`${path}: bad PNG filter ${filter}`);
      out[y * stride + x] = (raw[line + x] + pred) & 255;
    }
  }
  return { width, height, channels, data: out };
}

export function readBlob(b: Blob, base: string = FIX): BlobData {
  const path = join(base, b.file);
  const n = b.shape.reduce((a, c) => a * c, 1);
  if (b.file.endsWith(".png")) {
    if (b.dtype !== "u8")
      throw new Error(`${b.file}: PNG blobs must be u8, got ${b.dtype}`);
    const png = decodePng(path);
    const c = b.shape.length === 3 ? b.shape[2] : 1;
    if (b.shape.length < 2 || b.shape.length > 3 || png.channels !== c)
      throw new Error(`${b.file}: PNG channels do not match shape`);
    if (png.height !== b.shape[0] || png.width !== b.shape[1]) {
      throw new Error(
        `${b.file}: PNG is ${png.width}x${png.height}, shape says ${b.shape[1]}x${b.shape[0]}`
      );
    }
    return png.data;
  }
  const buf = readFileSync(path);
  // Copy: a Buffer can be a slice of a pooled ArrayBuffer at an unaligned offset.
  const ab = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength
  ) as ArrayBuffer;
  const Ctor = {
    u8: Uint8Array,
    i8: Int8Array,
    f32: Float32Array,
    f64: Float64Array,
  }[b.dtype];
  if (ab.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
    throw new Error(
      `${b.file}: ${ab.byteLength} bytes is not a multiple of ${Ctor.BYTES_PER_ELEMENT}`
    );
  }
  const out = new Ctor(ab);
  if (out.length !== n)
    throw new Error(`${b.file}: ${out.length} elements, shape wants ${n}`);
  return out;
}

/** A u8 blob of shape [h,w] or [h,w,c] as an Img. */
export function blobImg(b: Blob, base: string = FIX): Img {
  if (b.dtype !== "u8")
    throw new Error(`${b.file}: blobImg needs u8, got ${b.dtype}`);
  const [height, width] = b.shape;
  const channels = b.shape.length === 2 ? 1 : b.shape[2];
  if (
    b.shape.length < 2 ||
    b.shape.length > 3 ||
    (channels !== 1 && channels !== 3 && channels !== 4)
  ) {
    throw new Error(
      `${b.file}: unsupported image shape [${b.shape.join(",")}]`
    );
  }
  return { width, height, channels, data: readBlob(b, base) as Uint8Array };
}

/** Decode a PNG file into a 3-channel RGB Img (alpha dropped). */
export function readPng(rel: string, base: string = FIX): Img {
  const png = decodePng(join(base, rel));
  if (png.channels === 3)
    return {
      width: png.width,
      height: png.height,
      channels: 3,
      data: png.data,
    };
  const n = png.width * png.height;
  const data = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++)
      data[i * 3 + k] =
        png.data[i * png.channels + (png.channels === 1 ? 0 : k)];
  return { width: png.width, height: png.height, channels: 3, data };
}

export function hasLocal(): boolean {
  return existsSync(join(LOCAL, "e2e.json"));
}
