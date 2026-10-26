import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerModelFile } from "../models";
import {
  loadScannerAssets,
  type LoadDeps,
  type ScannerProgress,
} from "./loader";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytesOf = (s: string) => new Uint8Array(new TextEncoder().encode(s));

function table(key: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    gzipSync(
      JSON.stringify({
        format: 1,
        key,
        sets: [],
        printings: { id: [], set: [], number: [], name: [], image: [] },
      })
    )
  );
}

const emb = bytesOf("embedder-bytes");
const rec = bytesOf("recognizer-bytes!");
const dict = bytesOf("dictionary");
const MODELS: ScannerModelFile[] = [
  {
    role: "embedder",
    name: "e",
    path: "/scanner/m/aa/e.onnx",
    bytes: emb.length,
    sha256: sha(emb),
  },
  {
    role: "ocr-recognizer",
    name: "r",
    path: "/scanner/m/bb/r.onnx",
    bytes: rec.length,
    sha256: sha(rec),
  },
  {
    role: "ocr-dictionary",
    name: "d",
    path: "/scanner/m/cc/d.txt",
    bytes: dict.length,
    sha256: sha(dict),
  },
];
const DEPS: LoadDeps = {
  models: MODELS,
  modelId: "m1",
  caps: () => ({ ok: true }),
};

type Index = {
  fp: Uint8Array<ArrayBuffer>;
  cards: Uint8Array<ArrayBuffer>;
  cardsKey: string;
};
function index(tag: string): Index {
  return {
    fp: bytesOf(`fingerprints-${tag}`),
    cards: table(`k-${tag}`),
    cardsKey: `k-${tag}`,
  };
}
function manifestOf(i: Index) {
  return {
    format: 1,
    model: "m1",
    catalog_revision: 1,
    cards: {
      key: i.cardsKey,
      url: `/api/scanner/cards/${i.cardsKey}`,
      bytes: i.cards.length,
    },
    fingerprints: {
      sha256: sha(i.fp),
      url: `/api/scanner/fingerprints/${sha(i.fp)}`,
      bytes: i.fp.length,
      count: 1,
      dim: 1,
    },
  };
}

class FakeCache {
  store = new Map<string, Uint8Array>();
  failPut: ((key: string) => boolean) | null = null;
  async match(key: string) {
    const b = this.store.get(key);
    return b ? new Response(b.slice()) : undefined;
  }
  async put(key: string, res: Response) {
    if (this.failPut?.(key))
      throw new DOMException("quota", "QuotaExceededError");
    this.store.set(key, new Uint8Array(await res.arrayBuffer()));
  }
  async delete(key: string | Request) {
    return this.store.delete(
      typeof key === "string" ? key : new URL(key.url).pathname
    );
  }
  async keys() {
    return [...this.store.keys()].map(
      (k) => new Request(`http://localhost${k}`)
    );
  }
}

let cache: FakeCache;
let routes: Map<string, () => Response | Promise<Response>>;
let calls: string[];
let current: Index;

function serve(i: Index) {
  routes.set("/api/scanner/manifest?model=m1", () =>
    Response.json(manifestOf(i))
  );
  routes.set(manifestOf(i).cards.url, () => new Response(i.cards));
  routes.set(manifestOf(i).fingerprints.url, () => new Response(i.fp));
}
function serveModels(
  over: Partial<Record<string, Uint8Array<ArrayBuffer>>> = {}
) {
  const real = [emb, rec, dict];
  MODELS.forEach((m, n) =>
    routes.set(m.path, () => new Response(over[m.path] ?? real[n]))
  );
}

beforeEach(() => {
  cache = new FakeCache();
  routes = new Map();
  calls = [];
  current = index("a");
  vi.stubGlobal("caches", { open: async () => cache });
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const r = routes.get(url);
    if (!r) throw new TypeError("offline");
    return r();
  });
  serve(current);
  serveModels();
});
afterEach(() => vi.unstubAllGlobals());

const apiErr = (status: number, code: string) =>
  Response.json({ detail: { code } }, { status });

describe("loadScannerAssets", () => {
  it("reports an unsupported browser", async () => {
    expect(
      await loadScannerAssets({}, { ...DEPS, caps: () => ({ ok: false }) })
    ).toEqual({ failed: "unsupported" });
    expect(calls).toEqual([]);
  });

  it("downloads, verifies and stores everything under content-addressed keys", async () => {
    const r = await loadScannerAssets({}, DEPS);
    const m = manifestOf(current);
    expect(r).toEqual({
      assets: {
        embedder: MODELS[0].path,
        ocr: MODELS[1].path,
        dict: MODELS[2].path,
        cards: m.cards.url,
        fingerprints: m.fingerprints.url,
      },
    });
    for (const k of [
      ...MODELS.map((x) => x.path),
      m.cards.url,
      m.fingerprints.url,
    ])
      expect(cache.store.has(k)).toBe(true);
    expect(calls[0]).toBe("/api/scanner/manifest?model=m1");
  });

  it("verifies before putting: a hash mismatch stores nothing", async () => {
    serveModels({ [MODELS[0].path]: bytesOf("embedder-BYTES") });
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
    expect(cache.store.has(MODELS[0].path)).toBe(false);
  });

  it("rejects a fingerprint file whose hash differs", async () => {
    routes.set(
      manifestOf(current).fingerprints.url,
      () => new Response(bytesOf("fingerprints-X"))
    );
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
    expect(cache.store.has(manifestOf(current).fingerprints.url)).toBe(false);
  });

  it("rejects a card table that does not parse or has the wrong length", async () => {
    const m = manifestOf(current);
    const junk = new Uint8Array(gzipSync("{not json"));
    routes.set(m.cards.url, () => new Response(junk));
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
    expect(cache.store.has(m.cards.url)).toBe(false);
    routes.set(m.cards.url, () => new Response(current.cards.slice(0, -1)));
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
    expect(cache.store.has(m.cards.url)).toBe(false);
  });

  it("rejects a card table whose key is not the manifest's", async () => {
    routes.set(
      manifestOf(current).cards.url,
      () => new Response(table("other"))
    );
    // same length is not guaranteed; pad the manifest to the served bytes so only the key is wrong
    const served = table("other");
    routes.set("/api/scanner/manifest?model=m1", () =>
      Response.json({
        ...manifestOf(current),
        cards: { ...manifestOf(current).cards, bytes: served.length },
      })
    );
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
  });

  it("treats a quota error on put as a failed start and keeps nothing partial", async () => {
    const m = manifestOf(current);
    cache.failPut = (k) => k === m.cards.url;
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
    expect(cache.store.has(m.cards.url)).toBe(false);
  });

  it("treats an interrupted download as a failed start", async () => {
    routes.set(MODELS[1].path, () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(rec.slice(0, 3));
          c.error(new TypeError("network"));
        },
      });
      return new Response(stream);
    });
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
    expect(cache.store.has(MODELS[1].path)).toBe(false);
  });

  it("fails the start when the manifest has no fingerprints", async () => {
    routes.set("/api/scanner/manifest?model=m1", () =>
      Response.json({ ...manifestOf(current), fingerprints: null })
    );
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
    expect(calls).toEqual(["/api/scanner/manifest?model=m1"]);
  });

  it("fails the start on CATALOG_UNAVAILABLE even with a cache", async () => {
    await loadScannerAssets({}, DEPS);
    routes.set("/api/scanner/manifest?model=m1", () =>
      apiErr(404, "CATALOG_UNAVAILABLE")
    );
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
  });

  it("reads the manifest again once when the card table is not current", async () => {
    const next = index("b");
    let reads = 0;
    routes.set("/api/scanner/manifest?model=m1", () =>
      Response.json(manifestOf(reads++ === 0 ? current : next))
    );
    routes.set(manifestOf(current).cards.url, () =>
      apiErr(404, "CARDS_NOT_CURRENT")
    );
    routes.set(manifestOf(next).cards.url, () => new Response(next.cards));
    routes.set(manifestOf(next).fingerprints.url, () => new Response(next.fp));
    const r = await loadScannerAssets({}, DEPS);
    expect(r).toMatchObject({ assets: { cards: manifestOf(next).cards.url } });
    expect(reads).toBe(2);
  });

  it("re-reads only once", async () => {
    routes.set(manifestOf(current).cards.url, () =>
      apiErr(404, "CARDS_NOT_CURRENT")
    );
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
    expect(calls.filter((c) => c.includes("manifest"))).toHaveLength(2);
  });

  it("opens offline from the cache", async () => {
    const first = await loadScannerAssets({}, DEPS);
    routes.clear();
    calls.length = 0;
    expect(await loadScannerAssets({}, DEPS)).toEqual(first);
    expect(calls).toEqual(["/api/scanner/manifest?model=m1"]);
  });

  it("fails offline with nothing cached", async () => {
    routes.clear();
    expect(await loadScannerAssets({}, DEPS)).toEqual({
      failed: "cannot-start",
    });
  });

  it("does not hit the network for assets on a warm open", async () => {
    await loadScannerAssets({}, DEPS);
    calls.length = 0;
    const seen: ScannerProgress[] = [];
    await loadScannerAssets({ onProgress: (p) => seen.push(p) }, DEPS);
    expect(calls).toEqual(["/api/scanner/manifest?model=m1"]);
    expect(seen).toEqual([]);
  });

  it("deletes entries no longer referenced after a successful load", async () => {
    cache.store.set("/api/scanner/cards/old", bytesOf("x"));
    cache.store.set("/scanner/m/zz/old.onnx", bytesOf("x"));
    await loadScannerAssets({}, DEPS);
    expect(cache.store.has("/api/scanner/cards/old")).toBe(false);
    expect(cache.store.has("/scanner/m/zz/old.onnx")).toBe(false);
  });

  describe("progress", () => {
    it("totals the lock file bytes plus the manifest's, and ends at the total", async () => {
      const seen: ScannerProgress[] = [];
      await loadScannerAssets({ onProgress: (p) => seen.push(p) }, DEPS);
      const m = manifestOf(current);
      const total =
        emb.length +
        rec.length +
        dict.length +
        m.fingerprints.bytes +
        m.cards.bytes;
      expect(seen[0]).toEqual({ loaded: 0, total });
      expect(seen.at(-1)).toEqual({ loaded: total, total });
      expect(Object.keys(seen[0]).sort()).toEqual(["loaded", "total"]);
    });

    it("leaves out entries already cached", async () => {
      cache.store.set(MODELS[0].path, emb);
      cache.store.set(MODELS[1].path, rec);
      const seen: ScannerProgress[] = [];
      await loadScannerAssets({ onProgress: (p) => seen.push(p) }, DEPS);
      const m = manifestOf(current);
      expect(seen[0].total).toBe(
        dict.length + m.fingerprints.bytes + m.cards.bytes
      );
    });
  });

  describe("background update", () => {
    it("scans with the cached index, then verifies, stores, swaps and deletes the old entries", async () => {
      await loadScannerAssets({}, DEPS);
      const old = manifestOf(current);
      const next = index("b");
      serve(next);
      const n = manifestOf(next);
      const updates: unknown[] = [];
      let oldGoneAtSwap: boolean | null = null;
      const done = new Promise<void>((resolve) => {
        void loadScannerAssets(
          {
            onUpdate: async (u) => {
              oldGoneAtSwap = !cache.store.has(old.cards.url);
              updates.push(u);
              resolve();
            },
          },
          DEPS
        ).then((r) => {
          expect(r).toMatchObject({
            assets: {
              cards: old.cards.url,
              fingerprints: old.fingerprints.url,
            },
          });
        });
      });
      await done;
      await vi.waitFor(() =>
        expect(cache.store.has(old.cards.url)).toBe(false)
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        cards: n.cards.url,
        fingerprints: n.fingerprints.url,
      });
      expect(oldGoneAtSwap).toBe(false);
      expect(cache.store.has(n.cards.url)).toBe(true);
      expect(cache.store.has(old.fingerprints.url)).toBe(false);
    });

    it("swaps nothing and keeps the old entries when the new file fails verification", async () => {
      await loadScannerAssets({}, DEPS);
      const old = manifestOf(current);
      const next = index("b");
      serve(next);
      routes.set(
        manifestOf(next).fingerprints.url,
        () => new Response(bytesOf("fingerprints-Z"))
      );
      const onUpdate = vi.fn();
      await loadScannerAssets({ onUpdate }, DEPS);
      await new Promise((r) => setTimeout(r, 20));
      expect(onUpdate).not.toHaveBeenCalled();
      expect(cache.store.has(old.cards.url)).toBe(true);
      expect(cache.store.has(old.fingerprints.url)).toBe(true);
      expect(cache.store.has(manifestOf(next).fingerprints.url)).toBe(false);
    });
  });
});
