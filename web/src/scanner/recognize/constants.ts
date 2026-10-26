import type { CropSpec } from "../types";
import type { CombineConfig, VoteConfig } from "./types";

/** scanspike/combine.py CombineConfig with data/tuning/combine.json config (distrust_margin 0.05, no_art_sim 0.7, max_out 10)
 *  and the dataclass defaults verified_hedge True, image_sure 0.85. */
export const COMBINE: CombineConfig = {
  noArtSim: 0.7,
  distrustMargin: 0.05,
  maxOut: 10,
  verifiedHedge: true,
  imageSure: 0.85,
};

/** scanspike/g0_parity.py TOP_K (index.search k). */
export const SEARCH_TOP_K = 50;

/** scanspike/ocr.py crop table, as tuned in data/tuning/ocr.json: [name, x0, x1, y0, y1] in card fractions. */
export const OCR_CROPS_FOUR: readonly CropSpec[] = [
  ["left", 0.03, 0.36, 0.93, 0.972],
  ["right", 0.72, 0.98, 0.938, 0.985],
  ["right_narrow", 0.8, 0.98, 0.938, 0.985],
  ["right_high", 0.72, 0.98, 0.91, 0.946],
];

/** The plumbing resolution's "Frame voting and capture" starting rule (spike: web/src/scanner/recognize/constants.ts and vote.ts; the speed pass or a later retune may change it). */
export const VOTE: VoteConfig = {
  windowFrames: 4,
  windowMs: 2000,
  need: 3,
  absenceMad: 24,
  absenceFrames: 2,
  failPauseMs: 2000,
  shutterFreshMs: 1000,
  bordaBase: 10,
};
