// One frame through the recognition pipeline (port of scanspike/evaluate.py _stages and real_eval.process_photo, guided mode).
// Pure orchestration: pixels come in as an Img, models arrive as an interface. The worker times `read` and `vote`.
import { guideQuad } from "../guide";
import type { CropSpec, Img, Quad, Rect } from "../types";
import {
  cropRegions,
  embedResize,
  embedTensor,
  ocrResize,
  ocrTensor,
} from "../vision/prep";
import { findCardGuided } from "../vision/corners";
import { decideGate, measureGate } from "../vision/gate";
import type { GateReason } from "../vision/gate";
import { rectify } from "../vision/warp";
import { parseCardTable } from "./cardTable";
import { combine } from "./combine";
import { COMBINE, OCR_CROPS_FOUR, SEARCH_TOP_K } from "./constants";
import { ctcDecode, loadClasses } from "./ctc";
import { groupMembers } from "./lookalike";
import type { Models } from "./models";
import { buildNumberIndex, lookup, parseNumberText } from "./numbers";
import { parsePcfp } from "./pcfp";
import { l2normalize, rowIndex, scoreAll, simsFor, topK } from "./search";
import type { StageTimer } from "./timing";
import type { VoteFrame } from "./vote";
import type {
  Candidate,
  CardDb,
  CombinePath,
  NumberIndex,
  NumberReading,
  Pcfp,
} from "./types";

export type RecognizerData = {
  db: CardDb;
  nidx: NumberIndex;
  release: Map<string, string>;
  fp: Pcfp | null;
  fpRows: Map<string, number> | null;
  /** Reprint Group ordinal to its card ids (groups of two or more), for the look-alikes. */
  groups: Map<number, string[]>;
  classes: string[];
};

/** `cardsJson` is the inflated card table, `pcfpBuf` the fingerprint file (null: image matching off). */
export function loadData(
  cardsJson: unknown,
  pcfpBuf: ArrayBuffer | null,
  dictText: string
): RecognizerData {
  const db = parseCardTable(cardsJson);
  const nidx = buildNumberIndex(db);
  const fp = pcfpBuf ? parsePcfp(pcfpBuf) : null;
  return {
    db,
    nidx,
    release: nidx.release,
    fp,
    fpRows: fp ? rowIndex(fp) : null,
    groups: groupMembers(db),
    classes: loadClasses(dictText),
  };
}

/** Image search and the per-candidate similarities. `q` is already L2-normalised. */
export function searchStage(
  q: Float32Array,
  ocrCands: readonly Candidate[],
  data: RecognizerData
): { top: Candidate[] | null; simOf: Map<string, number> } {
  let top: Candidate[] | null = null;
  let simOf = new Map<string, number>();
  if (data.fp && data.fpRows) {
    const scores = scoreAll(data.fp, q);
    top = topK(data.fp, scores, SEARCH_TOP_K, (id) => data.db.rowOf.has(id));
    simOf = simsFor(
      data.fp,
      data.fpRows,
      q,
      ocrCands.map((c) => c.id)
    );
  }
  return { top, simOf };
}

export type GateInfo = {
  ok: boolean;
  reasons: GateReason[];
  sharpness: number;
  meanLuma: number;
  clippedFrac: number;
};

export type FullResult = {
  quadFound: boolean;
  quad: Quad | null;
  texts: string[];
  readings: NumberReading[];
  ocrCands: Candidate[];
  embedding: Float32Array;
  imageTop: Candidate[];
  ranked: string[];
  rankedScores: (number | null)[];
  path: CombinePath;
};

export type FrameAnalysis = {
  gate: GateInfo;
  thumb: Uint8Array;
  full: FullResult | null;
};

/** `force`: run the full pipeline even when the gate fails (a shutter press). `crops` defaults to the four tuned OCR crops. */
export type AnalyseOpts = { force: boolean; crops?: readonly CropSpec[] };

/**
 * What one analysed frame gives the voter. A frame is eligible (may count toward a lock or a suggestion) only when a card
 * is evidently there: corners found, or OCR read at least one catalog candidate. Without this, an empty dark surface falls
 * back to the guide crop and every blank frame votes for the same top-1. It is text-backed when the printed number agrees
 * with the pick, that is, top[0] is one of the frame's own OCR candidates.
 */
export function voteInput(a: FrameAnalysis, t: number): VoteFrame {
  const f = a.full;
  const eligible = f !== null && (f.quadFound || f.ocrCands.length > 0);
  const textBacked =
    f !== null &&
    f.ranked.length > 0 &&
    f.ocrCands.some((c) => c.id === f.ranked[0]);
  // The OCR candidates that read the printed number at least as strongly as the pick: a look-alike the number does not
  // support is dropped from an automatic lock.
  const own = f ? f.ocrCands.find((c) => c.id === f.ranked[0]) : undefined;
  const numberIds =
    f && own
      ? f.ocrCands.filter((c) => c.tier >= own.tier).map((c) => c.id)
      : [];
  return {
    t,
    thumb: a.thumb,
    top: f ? f.ranked : null,
    eligible,
    textBacked,
    numberIds,
  };
}

export async function analyseFrame(
  img: Img,
  guide: Rect,
  data: RecognizerData,
  models: Models,
  opts: AnalyseOpts,
  timer: StageTimer
): Promise<FrameAnalysis> {
  const m = measureGate(img, guide);
  const d = decideGate(m);
  const gate: GateInfo = {
    ok: d.ok,
    reasons: d.reasons,
    sharpness: m.sharpness,
    meanLuma: m.meanLuma,
    clippedFrac: m.clippedFrac,
  };
  timer.lap("gate");
  const run = opts.force || d.ok;
  if (!run) return { gate, thumb: m.thumb, full: null };

  const found = findCardGuided(img, guide);
  const quadUsed: Quad = found ?? guideQuad(guide);
  timer.lap("corners");
  const card = rectify(img, quadUsed);
  timer.lap("warp");

  const tensors = cropRegions(card, opts.crops ?? OCR_CROPS_FOUR).map((c) =>
    ocrTensor(ocrResize(c))
  );
  timer.lap("ocrPrep");
  const outs: { data: Float32Array; T: number; C: number }[] = [];
  for (const t of tensors) outs.push(await models.ocr(t.data, t.width));
  timer.lap("ocrRun");
  const texts = outs.map((o) => ctcDecode(o.data, o.T, o.C, data.classes));
  const readings = parseNumberText(
    texts.join("\n"),
    data.nidx.knownPrefixes,
    data.nidx.knownAbbrs,
    data.nidx.knownDens,
    false
  );
  const ocrCands = lookup(readings, data.nidx);
  timer.lap("ocrParse");

  const x = embedTensor(embedResize(card));
  timer.lap("embedPrep");
  const raw = await models.embed(x);
  timer.lap("embedRun");

  const q = l2normalize(raw);
  const { top, simOf } = searchStage(q, ocrCands, data);
  timer.lap("search");
  const { ranked, path } = combine(ocrCands, top, simOf, data.release, COMBINE);
  timer.lap("combine");

  return {
    gate,
    thumb: m.thumb,
    full: {
      quadFound: found !== null,
      quad: found,
      texts,
      readings,
      ocrCands,
      embedding: q,
      imageTop: top ? top.slice(0, 10) : [],
      ranked: ranked.map((c) => c.id),
      rankedScores: ranked.map((c) => c.score),
      path,
    },
  };
}
