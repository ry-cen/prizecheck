// Test-only helpers shared by the recognize suites (not imported by production code).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIX, readBlob, readJson } from "./read";
import type { Blob } from "./read";
import { inflateCardTable, parseCardTable } from "../recognize/cardTable";
import type { CardDb, NumberReading } from "../recognize/types";

export function arrayBufferOf(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength
  ) as ArrayBuffer;
}

export async function loadSubsetTable(): Promise<CardDb> {
  return parseCardTable(
    await inflateCardTable(arrayBufferOf(join(FIX, "subset-table.json.gz")))
  );
}

export type SnakeReading = {
  prefix: string;
  number: number;
  suffix: string;
  denominator: number | null;
  den_prefix: string;
  set_code: string | null;
  raw: string;
  den_partial: string;
};

export function toReading(r: SnakeReading): NumberReading {
  return {
    prefix: r.prefix,
    number: r.number,
    suffix: r.suffix,
    denominator: r.denominator,
    denPrefix: r.den_prefix,
    setCode: r.set_code,
    raw: r.raw,
    denPartial: r.den_partial,
  };
}

export type Known = { prefixes: string[]; abbrs: string[]; dens: number[] };
export type ParseEntry = {
  text: string;
  ascii: boolean;
  pythonError: boolean;
  readings: SnakeReading[];
};

export type Logic = {
  known: Known;
  subsetKnown: Known;
  lookup: { readings: SnakeReading[]; expected: [number, number][] }[];
  combine: {
    ocr: [number, number][];
    top: number[] | null;
    topOff: number;
    sim: number[];
    simOff: number;
    ranked: number[];
    path: string;
  }[];
  ctc: { file: string; T: number; C: number; text: string }[];
  pcfp: {
    file: string;
    ids: string[];
    query: number[];
    scores: number[];
    top3: string[];
  };
  parse: ParseEntry[];
};

export function loadLogic(): Logic {
  return readJson<Logic>("logic.json");
}

export function f32(rel: string): Float32Array {
  return readBlob({
    file: rel,
    dtype: "f32",
    shape: [arrayBufferOf(join(FIX, rel)).byteLength / 4],
  } as Blob) as Float32Array;
}

export type CorpusResult = {
  asciiMismatch: string[];
  nonAscii: number;
  nonAsciiMismatch: string[];
  throws: string[];
};

/** Shared parse-corpus check: ASCII exact (all 8 fields, order); non-ASCII mismatches counted; the parser must never throw. */
export function checkParseCorpus(
  entries: ParseEntry[],
  known: Known,
  parse: (
    text: string,
    p: string[],
    a: string[],
    d: number[],
    tol: boolean
  ) => NumberReading[],
  label: string
): CorpusResult {
  const asciiMismatch: string[] = [];
  const nonAsciiMismatch: string[] = [];
  const throws: string[] = [];
  let nonAscii = 0;
  let pyErrors = 0;
  for (const e of entries) {
    let got: NumberReading[] = [];
    let threw = false;
    try {
      got = parse(e.text, known.prefixes, known.abbrs, known.dens, false);
    } catch (err) {
      threw = true;
      throws.push(`${JSON.stringify(e.text)}: ${String(err)}`);
    }
    if (e.pythonError) {
      pyErrors++;
      continue;
    }
    if (!e.ascii) nonAscii++;
    const same =
      !threw &&
      JSON.stringify(got) === JSON.stringify(e.readings.map(toReading));
    if (!same)
      (e.ascii ? asciiMismatch : nonAsciiMismatch).push(JSON.stringify(e.text));
  }
  console.log(
    `${label}: total ${entries.length}, ascii ${entries.length - nonAscii - pyErrors} (+${pyErrors} pythonError skipped), non-ascii ${nonAscii}, ` +
      `ascii mismatches ${asciiMismatch.length}, non-ascii mismatches ${nonAsciiMismatch.length}, pythonError ${pyErrors}, throws ${throws.length}`
  );
  if (nonAsciiMismatch.length)
    console.log(`${label} non-ASCII mismatches:`, nonAsciiMismatch);
  if (asciiMismatch.length)
    console.log(`${label} ASCII mismatches:`, asciiMismatch);
  return { asciiMismatch, nonAscii, nonAsciiMismatch, throws };
}
