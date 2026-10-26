// Shared P4 types. Kept in one file so constants.ts and combine.ts don't import each other.
import type { VoteState } from "../worker/messages";

export type { VoteState };

export type Candidate = {
  id: string;
  source: "ocr" | "image" | "both";
  tier: number;
  score: number | null;
};

export type NumberReading = {
  prefix: string;
  number: number;
  suffix: string;
  denominator: number | null;
  denPrefix: string;
  setCode: string | null;
  raw: string;
  denPartial: string;
};

export type CardSet = {
  id: string;
  code: string | null;
  official: number | null;
  total: number | null;
  released: string | null;
};

export type CardDb = {
  key: string;
  ids: string[];
  rowOf: Map<string, number>;
  setOfRow: Int32Array;
  numbers: string[];
  names: string[];
  images: (string | null)[];
  sets: CardSet[];
};

export type NumberIndex = {
  byKey: Map<string, string[]>;
  printedDen: Map<string, Map<string, number>>;
  abbrToSets: Map<string, string[]>;
  cardSet: Map<string, string>;
  release: Map<string, string>;
  knownPrefixes: string[];
  knownAbbrs: string[];
  knownDens: number[];
};

export type Pcfp = {
  dim: number;
  count: number;
  modelSha256: string;
  ids: string[];
  scale: Float32Array;
  q: Int8Array;
};

export type CombinePath =
  | "none"
  | "image_only"
  | "ocr_only"
  | "distrusted"
  | "verified_image"
  | "verified_ocr"
  | "both";

export type CombineConfig = {
  noArtSim: number;
  distrustMargin: number;
  maxOut: number;
  verifiedHedge: boolean;
  imageSure: number;
};

export type VoteConfig = {
  windowFrames: number;
  windowMs: number;
  need: number;
  absenceMad: number;
  absenceFrames: number;
  failPauseMs: number;
  shutterFreshMs: number;
  bordaBase: number;
};

/** Compare strings by code point order (`a < b`), never localeCompare. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
