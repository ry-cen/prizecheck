// Pipeline orchestration with stub models, on the committed synthetic fixtures. Stubs sit at the OrtLike level, so
// createModels (CLS copy, class-count check, tensor disposal) is covered too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIX, readJson, readPng } from "../fixtures/read";
import { arrayBufferOf } from "../fixtures/recognizeUtil";
import { STAGES } from "../worker/messages";
import type { Rect } from "../types";
import { OCR_CROPS_FOUR } from "./constants";
import { createModels } from "./models";
import type { Models, OrtLike, SessionLike, TensorLike } from "./models";
import { analyseFrame, loadData, voteInput } from "./pipeline";
import type { AnalyseOpts, FrameAnalysis, FullResult } from "./pipeline";
import { parsePcfp } from "./pcfp";
import { StageTimer } from "./timing";

const pcfpBuf = arrayBufferOf(join(FIX, "pcfp5.bin"));
const fp5 = parsePcfp(pcfpBuf);
const dict = readFileSync(join(FIX, "dict.txt"), "utf8");
const scenes = readJson<{ scenes: { id: string; png: string; guide: Rect }[] }>(
  "manifest.json"
).scenes;

const table = {
  format: 1,
  key: "fixture",
  catalog_revision: 0,
  sets: [
    { id: "fx", code: null, official: 5, total: 5, released: "2020-01-01" },
  ],
  printings: {
    id: fp5.ids,
    set: fp5.ids.map(() => 0),
    number: ["1", "2", "3", "4", "5"],
    name: ["a", "b", "c", "d", "e"],
    image: fp5.ids.map(() => null),
  },
};

class FakeTensor implements TensorLike {
  disposed = false;
  constructor(
    readonly dims: readonly number[],
    readonly data: Float32Array
  ) {}
  dispose(): void {
    this.disposed = true;
  }
}

function fakeOrt(opts: { ocrClasses?: number } = {}): {
  ort: OrtLike;
  outputs: FakeTensor[];
  ocrCalls: number[];
} {
  const outputs: FakeTensor[] = [];
  const ocrCalls: number[] = [];
  const C = opts.ocrClasses ?? 438;
  let created = 0;
  const ort: OrtLike = {
    InferenceSession: {
      async create(): Promise<SessionLike> {
        const isEmbed = created++ === 0;
        return {
          inputNames: ["input"],
          outputNames: isEmbed ? ["last_hidden_state"] : ["logits"],
          async run(feeds): Promise<Record<string, TensorLike>> {
            const x = feeds["input"];
            if (isEmbed) {
              expect(x.dims).toEqual([1, 3, 224, 224]);
              const out = new Float32Array(2 * 384).fill(7); // row 1 is junk: only the CLS token (row 0) may be used
              for (let j = 0; j < 384; j++) out[j] = fp5.scale[0] * fp5.q[j];
              const t = new FakeTensor([1, 2, 384], out);
              outputs.push(t);
              return { last_hidden_state: t };
            }
            ocrCalls.push(x.dims[3]);
            const logits = new Float32Array(30 * C);
            for (let t = 0; t < 30; t++) logits[t * C] = 1; // blank everywhere
            const t = new FakeTensor([1, 30, C], logits);
            outputs.push(t);
            return { logits: t };
          },
        };
      },
    },
    Tensor: class implements TensorLike {
      constructor(
        _type: "float32",
        readonly data: Float32Array,
        readonly dims: number[]
      ) {}
      dispose(): void {}
    },
  };
  return { ort, outputs, ocrCalls };
}

const data = loadData(table, pcfpBuf, dict);
const bytes = new Uint8Array(1);

async function stubModels(): Promise<{
  models: Models;
  outputs: FakeTensor[];
  ocrCalls: number[];
}> {
  const f = fakeOrt();
  return {
    models: await createModels(f.ort, bytes, bytes, data.classes),
    outputs: f.outputs,
    ocrCalls: f.ocrCalls,
  };
}

const run = async (sceneIdx: number, opts: AnalyseOpts) => {
  const { models, outputs, ocrCalls } = await stubModels();
  const s = scenes[sceneIdx];
  const timer = new StageTimer();
  timer.begin();
  const r = await analyseFrame(
    readPng(s.png),
    s.guide,
    data,
    models,
    opts,
    timer
  );
  return { r, timer, outputs, ocrCalls };
};

describe("analyseFrame with stub models", () => {
  it("loads the dict with the model's class count", () =>
    expect(data.classes.length).toBe(438));

  it("scene 6 (dark) tuned, not forced: gate only", async () => {
    const { r, timer, outputs } = await run(6, { force: false });
    expect(r.full).toBeNull();
    expect(r.gate.ok).toBe(false);
    expect(r.gate.reasons).toContain("dark");
    expect(r.thumb.length).toBe(1024);
    expect(Object.keys(timer.ms)).toEqual(["gate"]);
    expect(outputs.length).toBe(0);
  });

  it("scene 6 forced runs the full pipeline with the tuned gate", async () => {
    const { r } = await run(6, { force: true });
    expect(r.full).not.toBeNull();
    expect(r.gate.ok).toBe(false);
  });

  it("scene 0 forced, four crops: image_only, row 0 first, every stage timed", async () => {
    const { r, timer, outputs, ocrCalls } = await run(0, { force: true });
    const f = r.full;
    expect(f).not.toBeNull();
    if (!f) return;
    expect(f.path).toBe("image_only");
    expect(f.ranked[0]).toBe(fp5.ids[0]);
    expect(f.ranked.length).toBe(5);
    expect(f.rankedScores[0]).toBeGreaterThan(0.99);
    expect(f.texts).toEqual(["", "", "", ""]);
    expect(f.readings).toEqual([]);
    expect(f.ocrCands).toEqual([]);
    expect(f.embedding.length).toBe(384);
    expect(f.imageTop.length).toBe(5);
    expect(f.quadFound).toBe(f.quad !== null);
    expect(ocrCalls.length).toBe(4);
    const expected = STAGES.filter(
      (s) => s !== "read" && s !== "vote" && s !== "total"
    );
    expect(Object.keys(timer.ms)).toEqual(expected);
    expect(outputs.length).toBe(5);
    expect(outputs.every((t) => t.disposed)).toBe(true);
  });

  it("two crops give two texts and two OCR calls", async () => {
    const { r, ocrCalls } = await run(0, {
      force: true,
      crops: OCR_CROPS_FOUR.slice(0, 2),
    });
    expect(r.full?.texts.length).toBe(2);
    expect(ocrCalls.length).toBe(2);
  });

  it("scene 9 has no guided quad and still rectifies the guide", async () => {
    const { r } = await run(9, { force: true });
    expect(r.full?.quadFound).toBe(false);
    expect(r.full?.quad).toBeNull();
  });

  it("without a fingerprint file the image path is off", async () => {
    const noFp = loadData(table, null, dict);
    const { models } = await stubModels();
    const s = scenes[0];
    const timer = new StageTimer();
    timer.begin();
    const r = await analyseFrame(
      readPng(s.png),
      s.guide,
      noFp,
      models,
      { force: true },
      timer
    );
    expect(r.full?.path).toBe("none");
    expect(r.full?.ranked).toEqual([]);
  });
});

describe("createModels", () => {
  it("throws when the recogniser's class count differs from the dict", async () => {
    const f = fakeOrt({ ocrClasses: 400 });
    const models = await createModels(f.ort, bytes, bytes, data.classes);
    await expect(models.ocr(new Float32Array(3 * 48 * 16), 16)).rejects.toThrow(
      /classes/
    );
    expect(f.outputs.every((t) => t.disposed)).toBe(true);
  });
});

describe("voteInput (eligibility and text backing)", () => {
  const thumb = new Uint8Array(1024);
  const full = (over: Partial<FullResult>): FullResult => ({
    quadFound: false,
    quad: null,
    texts: [],
    readings: [],
    ocrCands: [],
    embedding: new Float32Array(384),
    imageTop: [],
    ranked: ["A", "B"],
    rankedScores: [0.9, 0.8],
    path: "image_only",
    ...over,
  });
  const frame = (f: FullResult | null): FrameAnalysis => ({
    gate: {
      ok: true,
      reasons: [],
      sharpness: 0,
      meanLuma: 100,
      clippedFrac: 0,
    },
    thumb,
    full: f,
  });
  const cand = (id: string) => ({
    id,
    source: "ocr" as const,
    tier: 1,
    score: null,
  });

  it("a frame without a full run is not eligible and has no top", () => {
    expect(voteInput(frame(null), 5)).toEqual({
      t: 5,
      thumb,
      top: null,
      eligible: false,
      textBacked: false,
    });
  });
  it("neither corners nor an OCR candidate: not eligible", () => {
    expect(voteInput(frame(full({})), 0)).toMatchObject({
      top: ["A", "B"],
      eligible: false,
      textBacked: false,
    });
  });
  it("found corners make a frame eligible, but not text-backed", () => {
    expect(voteInput(frame(full({ quadFound: true })), 0)).toMatchObject({
      eligible: true,
      textBacked: false,
    });
  });
  it("an OCR candidate makes a frame eligible; backing needs the pick itself among them", () => {
    expect(voteInput(frame(full({ ocrCands: [cand("A")] })), 0)).toMatchObject({
      eligible: true,
      textBacked: true,
    });
    expect(voteInput(frame(full({ ocrCands: [cand("B")] })), 0)).toMatchObject({
      eligible: true,
      textBacked: false,
    });
    expect(
      voteInput(frame(full({ ocrCands: [cand("A")], ranked: [] })), 0)
    ).toMatchObject({ textBacked: false });
  });
});
