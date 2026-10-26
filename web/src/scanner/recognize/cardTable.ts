// Card table v1 (the resolution's "Number table"): gzip of column-oriented JSON.
import type { CardDb, CardSet } from "./types";

export type { CardDb, CardSet };

function bad(msg: string): never {
  throw new Error(`CARD_TABLE_INVALID: ${msg}`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function nullableNum(x: unknown, what: string): number | null {
  if (x === null || x === undefined) return null;
  if (typeof x !== "number") bad(`${what} is not a number`);
  return x;
}

function nullableStr(x: unknown, what: string): string | null {
  if (x === null || x === undefined) return null;
  if (typeof x !== "string") bad(`${what} is not a string`);
  return x;
}

export function parseCardTable(json: unknown): CardDb {
  if (!isRecord(json)) bad("not an object");
  if (json.format !== 1) bad(`format ${String(json.format)}`);
  if (typeof json.key !== "string") bad("key");
  if (!Array.isArray(json.sets)) bad("sets");
  const sets: CardSet[] = json.sets.map((s: unknown, i: number) => {
    if (!isRecord(s) || typeof s.id !== "string") bad(`sets[${i}]`);
    return {
      id: s.id,
      code: nullableStr(s.code, `sets[${i}].code`),
      official: nullableNum(s.official, `sets[${i}].official`),
      total: nullableNum(s.total, `sets[${i}].total`),
      released: nullableStr(s.released, `sets[${i}].released`),
    };
  });
  const p = json.printings;
  if (!isRecord(p)) bad("printings");
  const cols = ["id", "set", "number", "name", "image"] as const;
  for (const c of cols)
    if (!Array.isArray(p[c])) bad(`printings.${c} is not an array`);
  const id = p.id as unknown[];
  const set = p.set as unknown[];
  const number = p.number as unknown[];
  const name = p.name as unknown[];
  const image = p.image as unknown[];
  const n = id.length;
  if (
    set.length !== n ||
    number.length !== n ||
    name.length !== n ||
    image.length !== n
  ) {
    bad(
      `column lengths differ (id ${n}, set ${set.length}, number ${number.length}, name ${name.length}, image ${image.length})`
    );
  }
  const ids: string[] = new Array<string>(n);
  const rowOf = new Map<string, number>();
  const setOfRow = new Int32Array(n);
  const numbers: string[] = new Array<string>(n);
  const names: string[] = new Array<string>(n);
  const images: (string | null)[] = new Array<string | null>(n);
  for (let i = 0; i < n; i++) {
    const a = id[i],
      s = set[i],
      num = number[i],
      nm = name[i];
    if (typeof a !== "string") bad(`printings.id[${i}]`);
    if (
      typeof s !== "number" ||
      !Number.isInteger(s) ||
      s < 0 ||
      s >= sets.length
    )
      bad(`printings.set[${i}]`);
    if (typeof num !== "string") bad(`printings.number[${i}]`);
    if (typeof nm !== "string") bad(`printings.name[${i}]`);
    ids[i] = a;
    rowOf.set(a, i);
    setOfRow[i] = s;
    numbers[i] = num;
    names[i] = nm;
    images[i] = nullableStr(image[i], `printings.image[${i}]`);
  }
  return { key: json.key, ids, rowOf, setOfRow, numbers, names, images, sets };
}

export function releaseOf(db: CardDb, row: number): string {
  return db.sets[db.setOfRow[row]].released ?? "";
}

/** Gzip (magic 1f 8b) or plain JSON, to the parsed value. */
export async function inflateCardTable(bytes: ArrayBuffer): Promise<unknown> {
  const u8 = new Uint8Array(bytes);
  if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).json();
  }
  return JSON.parse(new TextDecoder("utf-8").decode(u8));
}
