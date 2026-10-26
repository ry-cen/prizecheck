// PCFP v1 fingerprint file (the resolution's "Fingerprint file PCFP v1").
import type { Pcfp } from "./types";

export type { Pcfp };

const DIM = 384;

function invalid(msg: string): never {
  throw new Error(`ASSET_INVALID: pcfp ${msg}`);
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0")
);

function uuidAt(u8: Uint8Array, o: number): string {
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += HEX[u8[o + i]];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

export function parsePcfp(buf: ArrayBuffer): Pcfp {
  if (buf.byteLength < 44) invalid(`too short (${buf.byteLength} bytes)`);
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x50 || u8[1] !== 0x43 || u8[2] !== 0x46 || u8[3] !== 0x50)
    invalid("bad magic");
  const dv = new DataView(buf);
  const format = dv.getUint16(4, true);
  const dim = dv.getUint16(6, true);
  const n = dv.getUint32(8, true);
  if (format !== 1) invalid(`format ${format}`);
  if (dim !== DIM) invalid(`dim ${dim}`);
  if (buf.byteLength !== 44 + (16 + 4 + DIM) * n)
    invalid(`length ${buf.byteLength} for count ${n}`);
  let sha = "";
  for (let i = 0; i < 32; i++) sha += HEX[u8[12 + i]];
  const ids: string[] = new Array<string>(n);
  for (let i = 0; i < n; i++) ids[i] = uuidAt(u8, 44 + 16 * i);
  const scale = new Float32Array(buf, 44 + 16 * n, n);
  const q = new Int8Array(buf, 44 + 20 * n, DIM * n);
  return { dim, count: n, modelSha256: sha, ids, scale, q };
}
