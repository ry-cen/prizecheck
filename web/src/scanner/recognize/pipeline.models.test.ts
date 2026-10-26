// Local only: real models (ONNX runtime, wasm, one thread) against the Python reference on real photos. Skipped unless
// web/src/scanner/__local__/ (gitignored) exists. It needs, besides e2e.json and its photos:
//   - the pinned models in web/public/scanner/m/ (`node scripts/fetch-scanner-models.mjs`), and
//   - __local__/index/cards.bin (the inflated-or-gzipped card table) and __local__/index/fingerprints.pcfp (a built index).
// Run with `npm run test:scanner-models`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ort } from "../worker/ort"; // the only module that imports the runtime
import { beforeAll, describe, expect, it } from "vitest";
import { LOCAL, blobImg, hasLocal, readJson, readPng } from "../fixtures/read";
import type { Blob } from "../fixtures/read";
import { arrayBufferOf } from "../fixtures/recognizeUtil";
import type { Img, Quad, Rect } from "../types";
import { embedTensor, ocrTensor } from "../vision/prep";
import { inflateCardTable } from "./cardTable";
import { COMBINE } from "./constants";
import { ctcDecode } from "./ctc";
import { combine } from "./combine";
import { SCANNER_MODEL_FILES } from "../models";
import { createModels } from "./models";
import type { Models, OrtLike } from "./models";
import { analyseFrame, loadData, searchStage } from "./pipeline";
import type { FullResult, RecognizerData } from "./pipeline";
import { l2normalize } from "./search";
import { COS_MIN, compareTop } from "./tieParity";
import type { TopCompare } from "./tieParity";
import { StageTimer } from "./timing";

type Item = {
  id: string;
  set: string;
  png: string;
  width: number;
  height: number;
  guide: Rect;
  truth: string;
  quad: Quad | null;
  texts: string[];
  embedding: number[];
  combined: string[];
  path: string;
  imageTop: [string, number][];
  ocrCands: [string, number][];
  ocrResized?: Blob[];
  embed224?: Blob;
};
type E2E = {
  items: Item[];
  summary: {
    ebay2Top1: number;
    ebay2Top3: number;
    synthTop1: number;
    synthTop3: number;
  };
};

type Tally = { eq: number; tie: number; emb: number; ocr: number; bad: number };
const PUBLIC = fileURLToPath(new URL("../../../public", import.meta.url));
const ORT_DIST = fileURLToPath(
  new URL("../../../../node_modules/onnxruntime-web/dist/", import.meta.url)
);
const modelBytes = (role: string): Uint8Array => {
  const file = SCANNER_MODEL_FILES.find((f) => f.role === role);
  if (!file) throw new Error(`no ${role} in the model lock`);
  return new Uint8Array(readFileSync(join(PUBLIC, file.path)));
};
const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / Math.sqrt(na * nb);
};
const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

let e2e: E2E;
let models: Models;
let data: RecognizerData;

describe.skipIf(!hasLocal())("real models vs the Python reference", () => {
  beforeAll(async () => {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = ORT_DIST; // Node: the runtime files from node_modules, not the Vite asset URLs
    e2e = readJson<E2E>("e2e.json", LOCAL);
    const dictText = new TextDecoder().decode(modelBytes("ocr-dictionary"));
    const cards = await inflateCardTable(
      arrayBufferOf(join(LOCAL, "index/cards.bin"))
    );
    data = loadData(
      cards,
      arrayBufferOf(join(LOCAL, "index/fingerprints.pcfp")),
      dictText
    );
    models = await createModels(
      ort as unknown as OrtLike,
      modelBytes("embedder"),
      modelBytes("ocr-recognizer"),
      data.classes
    );
  }, 300_000);

  it("(a) model parity on Python-prepared inputs, items 0-9", async () => {
    let strips = 0,
      textEq = 0,
      minCos = 1;
    const coss: number[] = [];
    const bad: string[] = [];
    for (const it of e2e.items.slice(0, 10)) {
      const rs = it.ocrResized as Blob[];
      for (let k = 0; k < rs.length; k++) {
        const t = ocrTensor(blobImg(rs[k], LOCAL));
        const o = await models.ocr(t.data, t.width);
        const text = ctcDecode(o.data, o.T, o.C, data.classes);
        strips++;
        if (text === it.texts[k]) textEq++;
        else
          bad.push(
            `${it.id}[${k}] ${JSON.stringify(text)} != ${JSON.stringify(it.texts[k])}`
          );
      }
      const q = l2normalize(
        await models.embed(embedTensor(blobImg(it.embed224 as Blob, LOCAL)))
      );
      const c = cosine(q, it.embedding);
      coss.push(c);
      minCos = Math.min(minCos, c);
    }
    const sorted = [...coss].sort((x, y) => x - y);
    const medCos = (sorted[4] + sorted[5]) / 2;
    console.log(
      `(a) OCR text equal ${textEq}/${strips}; embedding cosine min ${minCos.toFixed(5)} median ${medCos.toFixed(5)}`
    );
    if (bad.length) console.log("(a) OCR mismatches:", bad);
    expect(strips).toBe(40);
    expect(textEq).toBe(strips);
    expect(minCos).toBeGreaterThanOrEqual(COS_MIN);
  }, 600_000);

  it("(b) end to end on all 40 photos", async () => {
    const rows: string[] = [];
    const log: string[] = [];
    let quadAgree = 0,
      replayEq = 0,
      cropsEq = 0,
      cropsAll = 0,
      minCos = 1;
    let e2Top1 = 0,
      e2Top3 = 0,
      pyE2Top1 = 0,
      pyE2Top3 = 0,
      sTop1 = 0,
      sTop3 = 0;
    let cosFail = 0;
    const top1: Tally = { eq: 0, tie: 0, emb: 0, ocr: 0, bad: 0 };
    const top3: Tally = { eq: 0, tie: 0, emb: 0, ocr: 0, bad: 0 };
    const stageMs: Record<string, number[]> = {};
    for (const it of e2e.items) {
      const img: Img = readPng(it.png, LOCAL);
      const timer = new StageTimer();
      timer.begin();
      const a = await analyseFrame(
        img,
        it.guide,
        data,
        models,
        { force: true },
        timer
      );
      for (const [k, v] of Object.entries(timer.ms))
        (stageMs[k] ??= []).push(v as number);
      const f = a.full as FullResult;
      const gh = it.guide[3] - it.guide[1];
      const tol = 2 * Math.max(1, gh / 512);
      let agree: boolean;
      let dist = 0;
      if (it.quad === null || f.quad === null)
        agree = it.quad === null && f.quad === null;
      else {
        for (let i = 0; i < 4; i++)
          dist = Math.max(
            dist,
            Math.hypot(
              it.quad[i][0] - f.quad[i][0],
              it.quad[i][1] - f.quad[i][1]
            )
          );
        agree = dist <= tol;
      }
      const cos = cosine(f.embedding, it.embedding);
      let eqCrops = 0;
      for (let k = 0; k < it.texts.length; k++)
        if (f.texts[k] === it.texts[k]) eqCrops++;
      if (agree) {
        quadAgree++;
        cropsEq += eqCrops;
        cropsAll += it.texts.length;
        minCos = Math.min(minCos, cos);
        if (cos < COS_MIN) cosFail++;
      } else
        log.push(
          `quad disagree ${it.id}: dist ${dist.toFixed(2)} tol ${tol.toFixed(2)} py ${it.quad === null ? "null" : "found"} ts ${f.quad === null ? "null" : "found"}`
        );
      // Replay: Python's embedding and OCR candidates through the deterministic stages must reproduce Python's lists.
      const pyOcr = it.ocrCands.map(([id, tier]) => ({
        id,
        source: "ocr" as const,
        tier,
        score: null,
      }));
      const { top: rTop, simOf } = searchStage(
        l2normalize(Float32Array.from(it.embedding)),
        pyOcr,
        data
      );
      const rp = combine(pyOcr, rTop, simOf, data.release, COMBINE);
      const rImg = (rTop ?? []).slice(0, 10).map((c) => c.id);
      const rRank = rp.ranked.map((c) => c.id);
      const pyImg = it.imageTop.map((e) => e[0]);
      const firstDiff = (x: string[], y: string[]): number => {
        const n = Math.max(x.length, y.length);
        for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i;
        return -1;
      };
      const replayOk =
        firstDiff(rImg, pyImg) < 0 &&
        firstDiff(rRank, it.combined) < 0 &&
        rp.path === it.path;
      if (replayOk) replayEq++;
      else
        log.push(
          `replay miss ${it.id}: imageTop first diff ${firstDiff(rImg, pyImg)}, combined first diff ${firstDiff(rRank, it.combined)}, path ts ${rp.path} py ${it.path}; ` +
            `ts img ${JSON.stringify((rTop ?? []).slice(0, 10).map((c) => (c.score as number).toFixed(6)))} py img ${JSON.stringify(it.imageTop.map((e) => e[1].toFixed(6)))}`
        );
      const tsSide = {
        path: f.path,
        top: f.ranked,
        pool: f.imageTop.map((c) => ({ id: c.id, score: c.score })),
      };
      const pySide = {
        path: it.path,
        top: it.combined,
        pool: it.imageTop.map(([id, score]) => ({ id, score })),
      };
      const c1 = compareTop(1, tsSide, pySide, cos);
      const c3 = compareTop(3, tsSide, pySide, cos);
      const ocrKey = (xs: { id: string; tier: number }[]): string =>
        xs.map((c) => `${c.id}:${c.tier}`).join("|");
      const ocrSame =
        ocrKey(f.ocrCands) ===
        ocrKey(it.ocrCands.map(([id, tier]) => ({ id, tier })));
      const textDiff = it.texts.some((t, k) => f.texts[k] !== t);
      const bothImage = f.path === "image_only" && it.path === "image_only";
      const attribute = (
        c: TopCompare
      ): "equal" | "tie" | "bad" | "embedding" | "ocr" =>
        c.verdict === "equal"
          ? "equal"
          : bothImage
            ? c.verdict === "tie"
              ? "tie"
              : "bad"
            : ocrSame
              ? "embedding"
              : textDiff
                ? "ocr"
                : "bad";
      const tally = (k: 1 | 3, c: TopCompare, ct: Tally): string => {
        const at = attribute(c);
        if (at === "equal") ct.eq++;
        else if (at === "tie") ct.tie++;
        else if (at === "embedding") ct.emb++;
        else if (at === "ocr") ct.ocr++;
        else ct.bad++;
        if (at !== "equal")
          log.push(
            `top-${k} ${at} ${it.id}: gap ${c.gap?.toFixed(4) ?? "n/a"} eps ${c.eps?.toFixed(4) ?? "n/a"} cos ${cos.toFixed(5)} (path ts ${f.path} py ${it.path}) ocrSame ${ocrSame}`
          );
        return at === "equal"
          ? "="
          : at === "tie"
            ? "~"
            : at === "bad"
              ? "!"
              : "e";
      };
      const m1 = tally(1, c1, top1);
      const m3 = tally(3, c3, top3);
      if (eqCrops < it.texts.length)
        log.push(
          `texts ${it.id}: ts ${JSON.stringify(f.texts)} py ${JSON.stringify(it.texts)}`
        );
      const tsT1 = f.ranked[0] === it.truth;
      const tsT3 = f.ranked.slice(0, 3).includes(it.truth);
      const pyT1 = it.combined[0] === it.truth;
      const pyT3 = it.combined.slice(0, 3).includes(it.truth);
      if (it.set === "ebay2") {
        if (tsT1) e2Top1++;
        if (tsT3) e2Top3++;
        if (pyT1) pyE2Top1++;
        if (pyT3) pyE2Top3++;
      } else {
        if (tsT1) sTop1++;
        if (tsT3) sTop3++;
      }
      rows.push(
        `${it.id.padEnd(11)} quad ${agree ? "ok" : "NO"} cos ${cos.toFixed(5)} crops ${eqCrops}/${it.texts.length} top1 ${m1} top3 ${m3} truth ${tsT1 ? "1" : tsT3 ? "3" : "-"}/${pyT1 ? "1" : pyT3 ? "3" : "-"} ${f.path}`
      );
    }
    const med = (x: number[]): number => {
      const y = [...x].sort((p, q) => p - q);
      return y.length % 2
        ? y[(y.length - 1) / 2]
        : (y[y.length / 2 - 1] + y[y.length / 2]) / 2;
    };
    console.log(
      "(b) Node, 1 thread, per-stage p50 ms: " +
        Object.entries(stageMs)
          .map(([k, v]) => `${k} ${med(v).toFixed(1)}`)
          .join(", ")
    );
    console.log(rows.join("\n"));
    console.log(log.join("\n"));
    console.log(
      `(b) quad-agreeing ${quadAgree}/40; min cosine ${minCos.toFixed(5)}; OCR crops equal ${cropsEq}/${cropsAll}; ` +
        `replay ${replayEq}/40; top-1 eq ${top1.eq} tie ${top1.tie} emb ${top1.emb} ocr ${top1.ocr} bad ${top1.bad}; top-3 eq ${top3.eq} tie ${top3.tie} emb ${top3.emb} ocr ${top3.ocr} bad ${top3.bad}; ` +
        `ebay2 TS ${e2Top1}/30 top-1, ${e2Top3}/30 top-3 (Python in this run ${pyE2Top1}/${pyE2Top3}, summary ${e2e.summary.ebay2Top1}/${e2e.summary.ebay2Top3}); ` +
        `synth TS ${sTop1}/10, ${sTop3}/10 (summary ${e2e.summary.synthTop1}/${e2e.summary.synthTop3})`
    );
    expect(quadAgree).toBeGreaterThanOrEqual(38);
    expect(cosFail).toBe(0);
    expect(cropsEq / cropsAll).toBeGreaterThanOrEqual(0.95);
    expect(replayEq).toBe(40);
    expect(top1.bad).toBe(0);
    expect(top1.eq).toBeGreaterThanOrEqual(34);
    expect(top3.bad).toBe(0);
    expect(top3.eq).toBeGreaterThanOrEqual(31);
    expect(e2Top1).toBeGreaterThanOrEqual(19);
    expect(e2Top3).toBeGreaterThanOrEqual(24);
    expect(Math.abs(e2Top1 - e2e.summary.ebay2Top1)).toBeLessThanOrEqual(1);
    expect(Math.abs(e2Top3 - e2e.summary.ebay2Top3)).toBeLessThanOrEqual(1);
    expect(sTop1).toBeGreaterThanOrEqual(9);
    expect(sTop3).toBeGreaterThanOrEqual(9);
  }, 900_000);

  it("(c) RGBA input (as the worker reads pixels) gives the same result as RGB", async () => {
    const it = e2e.items[0];
    const rgb = readPng(it.png, LOCAL);
    const n = rgb.width * rgb.height;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = rgb.data[i * 3];
      rgba[i * 4 + 1] = rgb.data[i * 3 + 1];
      rgba[i * 4 + 2] = rgb.data[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
    const opts = { force: true };
    const t = new StageTimer();
    t.begin();
    const a = await analyseFrame(rgb, it.guide, data, models, opts, t);
    const b = await analyseFrame(
      { ...rgb, channels: 4, data: rgba },
      it.guide,
      data,
      models,
      opts,
      t
    );
    expect(b.full?.texts).toEqual(a.full?.texts);
    expect(b.full?.ranked).toEqual(a.full?.ranked);
    expect(b.gate.sharpness).toBeCloseTo(a.gate.sharpness, 3);
  }, 300_000);
});
