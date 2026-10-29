// The recognizer worker: gate, corners, warp, OCR, embedding, search, combine and frame voting (worker message contract).
import { inflateCardTable } from "../recognize/cardTable";
import { createModels } from "../recognize/models";
import type { Models } from "../recognize/models";
import { analyseFrame, loadData, voteInput } from "../recognize/pipeline";
import type { FrameAnalysis, RecognizerData } from "../recognize/pipeline";
import { lookalikesOf } from "../recognize/lookalike";
import { parsePcfp } from "../recognize/pcfp";
import { rowIndex } from "../recognize/search";
import { VoteSession } from "../recognize/session";
import { StageTimer } from "../recognize/timing";
import type { Img, Rect } from "../types";
import { SCANNER_CACHE } from "./messages";
import type { FromWorker, ScannerAssets, ToWorker } from "./messages";
import { configureOrt, ort } from "./ort";
import { threadCount } from "./threads";

const post = (m: FromWorker): void =>
  (self as unknown as Worker).postMessage(m);

let ready = false;
let paused = false;
let debugTiming = false;
let data: RecognizerData | null = null;
let models: Models | null = null;
let dictText = "";
// `data` is replaced on a swap; the closure reads the current value.
const session = new VoteSession((id) => (data ? lookalikesOf(id, data) : []));
let swapPending: { cards?: string; fingerprints?: string } | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx2d: OffscreenCanvasRenderingContext2D | null = null;

class AssetMissing extends Error {
  constructor(readonly key: string) {
    super(`asset missing from cache: ${key}`);
  }
}

async function readAsset(cache: Cache, key: string): Promise<ArrayBuffer> {
  const res = await cache.match(key);
  if (!res) throw new AssetMissing(key);
  return res.arrayBuffer();
}

async function init(assets: ScannerAssets, timing: boolean): Promise<void> {
  debugTiming = timing;
  configureOrt(threadCount());

  const cache = await caches.open(SCANNER_CACHE);
  const [embedBytes, ocrBytes, dictBytes, cardsBytes, fpBytes] =
    await Promise.all([
      readAsset(cache, assets.embedder),
      readAsset(cache, assets.ocr),
      readAsset(cache, assets.dict),
      readAsset(cache, assets.cards),
      assets.fingerprints
        ? readAsset(cache, assets.fingerprints)
        : Promise.resolve(null),
    ]);

  dictText = new TextDecoder().decode(dictBytes);
  const base = loadData(await inflateCardTable(cardsBytes), null, dictText);
  data = fpBytes ? withFingerprints(base, fpBytes) : base;
  models = await createModels(
    ort,
    new Uint8Array(embedBytes),
    new Uint8Array(ocrBytes),
    data.classes
  );

  const probe = new OffscreenCanvas(1, 1).getContext("2d", {
    willReadFrequently: true,
  });
  if (!probe) {
    post({ t: "error", code: "INIT_FAILED" });
    return;
  }
  ready = true;
  post({ t: "ready", imageMatching: data.fp !== null });
}

function withFingerprints(d: RecognizerData, buf: ArrayBuffer): RecognizerData {
  const fp = parsePcfp(buf);
  return { ...d, fp, fpRows: rowIndex(fp) };
}

async function applySwap(s: {
  cards?: string;
  fingerprints?: string;
}): Promise<void> {
  if (!data) return;
  const cache = await caches.open(SCANNER_CACHE);
  let next = data;
  if (s.cards)
    next = {
      ...loadData(
        await inflateCardTable(await readAsset(cache, s.cards)),
        null,
        dictText
      ),
      fp: next.fp,
      fpRows: next.fpRows,
    };
  if (s.fingerprints)
    next = withFingerprints(next, await readAsset(cache, s.fingerprints));
  data = next;
}

function readPixels(bitmap: ImageBitmap): Img {
  const w = bitmap.width;
  const h = bitmap.height;
  if (!canvas || !ctx2d) {
    canvas = new OffscreenCanvas(w, h);
    ctx2d = canvas.getContext("2d", { willReadFrequently: true });
  } else if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  if (!ctx2d) throw new Error("no 2d context");
  ctx2d.drawImage(bitmap, 0, 0);
  const id = ctx2d.getImageData(0, 0, w, h);
  return { width: w, height: h, channels: 4, data: id.data };
}

async function onFrame(
  id: number,
  bitmap: ImageBitmap,
  guide: Rect
): Promise<void> {
  if (paused || !ready || !data || !models) {
    bitmap.close();
    post({ t: "frameDone", id });
    return;
  }
  const timer = new StageTimer();
  timer.begin();
  let analysis: FrameAnalysis | null = null;
  let out: FromWorker[] = [];
  try {
    if (swapPending) {
      const s = swapPending;
      swapPending = null;
      await applySwap(s);
      timer.begin();
    }
    let img: Img;
    try {
      img = readPixels(bitmap);
    } finally {
      bitmap.close();
    }
    timer.lap("read");
    // A shutter press makes this frame run the full pipeline even when the gate fails.
    const shutter = session.takeShutter();
    analysis = await analyseFrame(
      img,
      guide,
      data,
      models,
      { force: shutter },
      timer
    );
    out = session.frame(voteInput(analysis, performance.now()), shutter);
    timer.lap("vote");
  } catch {
    bitmap.close(); // idempotent
  }
  timer.end();

  if (analysis)
    post({
      t: "gate",
      id,
      ok: analysis.gate.ok,
      reason: analysis.gate.reasons[0],
    });
  for (const m of out) post(m);
  if (debugTiming)
    post({ t: "timing", id, ms: timer.ms as Record<string, number> });
  post({ t: "frameDone", id });
}

self.onmessage = (ev: MessageEvent<ToWorker>): void => {
  const m = ev.data;
  switch (m.t) {
    case "init":
      init(m.assets, m.debugTiming).catch((e: unknown) => {
        post({
          t: "error",
          code: e instanceof AssetMissing ? "ASSET_INVALID" : "INIT_FAILED",
        });
      });
      break;
    case "frame":
      void onFrame(m.id, m.bitmap, m.guide as Rect);
      break;
    case "shutter":
      for (const out of session.shutter(performance.now())) post(out);
      break;
    case "lockOutcome":
      session.outcome(m, performance.now());
      break;
    case "pause":
      paused = true;
      break;
    case "resume":
      paused = false;
      break;
    case "swap":
      // A second swap before the first is applied adds to it: it never drops the first one's keys.
      swapPending = {
        cards: m.cards ?? swapPending?.cards,
        fingerprints: m.fingerprints ?? swapPending?.fingerprints,
      };
      break;
  }
};
