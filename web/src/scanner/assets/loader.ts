// Scanner asset loader (main thread). Gets the recognizer's blobs verified into Cache Storage and says which keys
// the worker should read. No UI here: #318 draws the progress bar and the cannot-start screen from this interface.
//
//   loadScannerAssets({ onProgress, signal, onUpdate }) ->
//     { assets: ScannerAssets } | { failed: "unsupported" | "cannot-start" }
//   - "unsupported": the capability check failed (the browser cannot run the scanner).
//   - "cannot-start": every other failure (no catalog, no index for this model, offline with nothing cached, a hash
//     or parse mismatch, an interrupted download, a quota error). The cause is never exposed.
//   - onProgress({ loaded, total }): bytes only, called while something is downloaded in the foreground; total leaves
//     out entries already cached and verified. Nothing is called on a warm open.
//   - onUpdate(assets): when the cached set was used but the manifest names a newer index or card table. They are
//     downloaded, verified and stored in the background; onUpdate then fires once so the caller can post the worker
//     `swap` between frames ({cards?, fingerprints?} are the keys that changed). Old entries are deleted after it
//     returns. A failed background update changes nothing.
//   - signal: aborting rejects with an AbortError and leaves only verified entries behind.
//
//   requestPersistOnce() (./persist): call after the first tray row.
//
// Cache keys are content-addressed paths; presence of an entry means it was verified before `cache.put`.
import {
  fetchScannerAsset,
  getScannerManifest,
  ScannerError,
  type ScannerManifest,
} from "../../scanner_generated";
import { checkCaps } from "../caps";
import {
  SCANNER_MODEL_FILES,
  SCANNER_MODEL_ID,
  type ScannerModelFile,
} from "../models";
import { inflateCardTable, parseCardTable } from "../recognize/cardTable";
import { SCANNER_CACHE, type ScannerAssets } from "../worker/messages";
import {
  createProgress,
  type ProgressMeter,
  type ScannerProgress,
} from "./progress";

export type { ScannerProgress } from "./progress";

export type LoadResult =
  { assets: ScannerAssets } | { failed: "unsupported" | "cannot-start" };

export type LoadOptions = {
  onProgress?: (p: ScannerProgress) => void;
  signal?: AbortSignal;
  onUpdate?: (update: {
    assets: ScannerAssets;
    cards?: string;
    fingerprints?: string;
  }) => void | Promise<void>;
};

/** Test seam: the lock file's model list and id, and the capability check. */
export type LoadDeps = {
  models?: readonly ScannerModelFile[];
  modelId?: string;
  caps?: () => { ok: boolean };
};

const MANIFEST_KEY = "/api/scanner/manifest";

type Kind = "model" | "cards" | "fingerprints";
type Entry = {
  key: string;
  bytes: number;
  kind: Kind;
  sha256?: string;
  cardsKey?: string;
};

class StartFailure extends Error {}

function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}

function entriesOf(
  manifest: ScannerManifest,
  models: readonly ScannerModelFile[]
): Entry[] {
  const out: Entry[] = models.map((m) => ({
    key: m.path,
    bytes: m.bytes,
    kind: "model",
    sha256: m.sha256,
  }));
  if (manifest.fingerprints)
    out.push({
      key: manifest.fingerprints.url,
      bytes: manifest.fingerprints.bytes,
      kind: "fingerprints",
      sha256: manifest.fingerprints.sha256,
    });
  out.push({
    key: manifest.cards.url,
    bytes: manifest.cards.bytes,
    kind: "cards",
    cardsKey: manifest.cards.key,
  });
  return out;
}

function assetsOf(
  manifest: ScannerManifest,
  models: readonly ScannerModelFile[]
): ScannerAssets {
  const path = (role: ScannerModelFile["role"]) => {
    const m = models.find((f) => f.role === role);
    if (!m) throw new StartFailure("model list");
    return m.path;
  };
  return {
    embedder: path("embedder"),
    ocr: path("ocr-recognizer"),
    dict: path("ocr-dictionary"),
    cards: manifest.cards.url,
    fingerprints: manifest.fingerprints?.url ?? null,
  };
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function readBody(
  response: Response,
  meter: ProgressMeter,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    meter.add(whole.length);
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
      meter.add(value.length);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  const out = new Uint8Array(new ArrayBuffer(length));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function verify(
  entry: Entry,
  bytes: Uint8Array<ArrayBuffer>
): Promise<void> {
  if (bytes.length !== entry.bytes) throw new StartFailure("length");
  if (entry.sha256 !== undefined) {
    const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
    if (digest !== entry.sha256) throw new StartFailure("hash");
  }
  if (entry.kind === "cards") {
    // Length plus parse: the table must inflate and parse, and be the table the manifest named.
    let key: string;
    try {
      const copy = bytes.slice().buffer;
      key = parseCardTable(await inflateCardTable(copy)).key;
    } catch {
      throw new StartFailure("parse");
    }
    if (key !== entry.cardsKey) throw new StartFailure("key");
  }
}

async function download(
  cache: Cache,
  entry: Entry,
  meter: ProgressMeter,
  signal?: AbortSignal
): Promise<void> {
  const response =
    entry.kind === "model"
      ? await fetch(entry.key, { signal })
      : await fetchScannerAsset(entry.key);
  if (!response.ok) throw new StartFailure("status");
  const bytes = await readBody(response, meter, signal);
  await verify(entry, bytes);
  try {
    await cache.put(
      entry.key,
      new Response(bytes, {
        headers: { "content-type": "application/octet-stream" },
      })
    );
  } catch {
    await cache.delete(entry.key).catch(() => false);
    throw new StartFailure("store");
  }
}

async function missingOf(cache: Cache, entries: Entry[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const e of entries) if (!(await cache.match(e.key))) out.push(e);
  return out;
}

const sum = (es: Entry[]) => es.reduce((n, e) => n + e.bytes, 0);

async function readCachedManifest(
  cache: Cache,
  modelId: string
): Promise<ScannerManifest | null> {
  try {
    const hit = await cache.match(MANIFEST_KEY);
    const m = hit ? ((await hit.json()) as ScannerManifest) : null;
    if (
      m &&
      m.format === 1 &&
      m.model === modelId &&
      typeof m.cards?.url === "string" &&
      m.fingerprints &&
      typeof m.fingerprints.url === "string"
    )
      return m;
  } catch {
    // unreadable: as if absent
  }
  return null;
}

async function fetchManifest(
  modelId: string,
  cache: Cache
): Promise<ScannerManifest> {
  try {
    const m = await getScannerManifest(modelId);
    if (m.format !== 1 || m.model !== modelId) throw new StartFailure("format");
    return m;
  } catch (e) {
    if (e instanceof ScannerError && e.status < 500)
      throw new StartFailure("manifest");
    if (e instanceof StartFailure) throw e;
    // Offline or a server fault: the cached manifest, if any.
    const cached = await readCachedManifest(cache, modelId);
    if (cached) return cached;
    throw new StartFailure("offline");
  }
}

async function cleanup(cache: Cache, keep: ScannerAssets): Promise<void> {
  const referenced = new Set<string>([
    MANIFEST_KEY,
    keep.embedder,
    keep.ocr,
    keep.dict,
    keep.cards,
  ]);
  if (keep.fingerprints) referenced.add(keep.fingerprints);
  for (const req of await cache.keys()) {
    if (!referenced.has(new URL(req.url).pathname))
      await cache.delete(req).catch(() => false);
  }
}

async function storeManifest(cache: Cache, m: ScannerManifest): Promise<void> {
  try {
    await cache.put(
      MANIFEST_KEY,
      new Response(JSON.stringify(m), {
        headers: { "content-type": "application/json" },
      })
    );
  } catch {
    // Only the offline fallback is lost.
  }
}

/** Downloads what is missing for the manifest, re-reading the manifest once when the API says the key moved on. */
async function fill(
  cache: Cache,
  first: ScannerManifest,
  models: readonly ScannerModelFile[],
  modelId: string,
  meter: ProgressMeter,
  signal?: AbortSignal
): Promise<ScannerManifest> {
  let manifest = first;
  for (let attempt = 0; ; attempt++) {
    const todo = await missingOf(cache, entriesOf(manifest, models));
    meter.replan(sum(todo));
    try {
      for (const e of todo) {
        if (signal?.aborted) throw abortError();
        await download(cache, e, meter, signal);
      }
      return manifest;
    } catch (e) {
      const moved =
        e instanceof ScannerError &&
        e.status === 404 &&
        (e.code === "CARDS_NOT_CURRENT" || e.code === "FINGERPRINTS_NOT_FOUND");
      if (!moved || attempt > 0) throw e;
      try {
        manifest = await getScannerManifest(modelId);
      } catch {
        throw new StartFailure("manifest");
      }
      if (!manifest.fingerprints || manifest.model !== modelId)
        throw new StartFailure("fingerprints");
    }
  }
}

export async function loadScannerAssets(
  opts: LoadOptions = {},
  deps: LoadDeps = {}
): Promise<LoadResult> {
  const models = deps.models ?? SCANNER_MODEL_FILES;
  const modelId = deps.modelId ?? SCANNER_MODEL_ID;
  if (!(deps.caps ?? checkCaps)().ok) return { failed: "unsupported" };
  try {
    const cache = await caches.open(SCANNER_CACHE);
    let manifest = await fetchManifest(modelId, cache);
    if (!manifest.fingerprints) throw new StartFailure("fingerprints");

    let todo = await missingOf(cache, entriesOf(manifest, models));
    if (todo.length === 0) {
      await storeManifest(cache, manifest);
      const assets = assetsOf(manifest, models);
      await cleanup(cache, assets);
      return { assets };
    }

    // Warm open: the previous load is intact, so scan with it and bring the newer index in behind.
    const prev = await readCachedManifest(cache, modelId);
    const prevIntact =
      prev !== null &&
      (await missingOf(cache, entriesOf(prev, models))).length === 0;
    if (prev && prevIntact) {
      const assets = assetsOf(prev, models);
      void backgroundUpdate(cache, manifest, prev, models, modelId, opts);
      return { assets };
    }

    const meter = createProgress(sum(todo), opts.onProgress);
    meter.emit();
    manifest = await fill(cache, manifest, models, modelId, meter, opts.signal);
    await storeManifest(cache, manifest);
    const assets = assetsOf(manifest, models);
    await cleanup(cache, assets);
    return { assets };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { failed: "cannot-start" };
  }
}

async function backgroundUpdate(
  cache: Cache,
  next: ScannerManifest,
  prev: ScannerManifest,
  models: readonly ScannerModelFile[],
  modelId: string,
  opts: LoadOptions
): Promise<void> {
  try {
    const meter = createProgress(0); // silent: the collector sees nothing of an update
    const done = await fill(cache, next, models, modelId, meter, opts.signal);
    const assets = assetsOf(done, models);
    const before = assetsOf(prev, models);
    await storeManifest(cache, done);
    await opts.onUpdate?.({
      assets,
      cards: assets.cards !== before.cards ? assets.cards : undefined,
      fingerprints:
        assets.fingerprints !== before.fingerprints && assets.fingerprints
          ? assets.fingerprints
          : undefined,
    });
    await cleanup(cache, assets);
  } catch {
    // The cached index keeps scanning; the next open tries again.
  }
}
