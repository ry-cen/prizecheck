# Decide scanner plumbing

**Ticket:** map ticket 2, "Decide scanner plumbing" (no GitHub issue yet) on the [card scanner map](../map.md).
**Resolved:** 2026-10-22. The owner answered the collector-facing questions below, one at a time. Claude settled the plumbing, which the owner delegates.
**Builds on:**
- the [recognition spike findings](../research/recognition-spike-findings.md);
- Collection Import's [import contract](../../../collection-import/wayfinder/resolutions/decide-collection-import-contract.md), whose destination rule (a Storage Leaf, no Deck) and review components the scanner takes. Its save transaction copies batch add's shape (`api/app/holdings.py:170-239`), keyed by the tray's items rather than a draft id;
- [card image sources](../../../tcg-collection-tracker/wayfinder/research/card-image-sources.md).

**Status of the runtime and model choices.** D1 to D3 and the 224-pixel int8 embedder are provisional. They were to hold only if the phone measurement gate passed (see "Measurement gate"). The gate, carried by map ticket 3, ran on 2026-10-23 and missed G2, G3 and G4; the owner accepted these choices anyway and they are improved later behind the recognition module ([results](../research/phone-gate-results.md)). Everything else here is settled.

**Paths.** Repo paths are relative to the repository root. Paths starting `scanspike/` or `data/tuning/` are in the spike repository (`~/dev/prizecheck-scan-spike`), which is unpublished; they are cited for provenance and are not linked.

## Owner decisions

These are collector-facing. The full list of 12 answers is under "Owner answers".

- **Finish default (amends a closed decision).** When a Printing has several Editions and no Unspecified Variant, the row defaults to Normal, or to the first active Edition if there is no Normal. The chip shows selected and one tap changes it.
- **Fingerprint rights.** The scanner runs only on the private, sign-in-only deployment. A public launch waits for a written rights check.
- **Lock feedback.** A visual cue everywhere, vibration where supported, and a short sound that is off by default.
- **Deck not a destination, no undo, tray per account, tray cap 200 Editions and 999 copies, iOS eviction accepted, first download starts at once with a progress bar, a 29-day (the receipt lasts 30) stale-save note, and the no-index screen.**

## Delegated decisions

Settled here, in this order: runtime (D1), image work (D2), model delivery (D3), the index build and its storage (D4), the number table (D5), set totals (D6), index format and staleness (D7), live Edition lookup (D8), device storage (D9), tray identity (D10), stale Editions (D11), the save route (D12), bundle and code boundaries (D13), UI copy (D14). D15 (2026-10-28) was added later: look-alike Printings and the choice prompt. It supersedes owner answer 5 (Q5) and amends D5, D8 and the tray schema note.

## Established inputs, assumptions and open points

- **Established.** The closed owner decisions on the map; the spike's pins and tuned values; the repo facts cited below.
- **Assumption, unmeasured.** Every speed, memory and download figure for phones. The spike ran in Python on a Mac only.
- **Assumption, to verify in the spec package.** That stored `catalog_generation.raw_gzip` records carry `set.cardCount`. The live API does. The D6 package must stop and report if the stored records do not.
- **Verified from upstream, not from the image.** nginx's `mime.types` (release 1.28.0) maps `.wasm` to `application/wasm` and has no `mjs` entry (D3, A1 below). The image itself could not be read here, so the G6 check confirms it on the deployed site.
- **Open for ticket 3.** How a stale row that still has live Editions presents its chips (D11).

## Decisions

Each gives the choice, then the alternatives rejected.

### D1. Runtime: onnxruntime-web 1.30.0, WASM only, one thread, in a module Web Worker

- **Package.** Pin `onnxruntime-web@1.30.0` and import only the `onnxruntime-web/wasm` entry (about 50 KB of glue).
- **Threads.** `numThreads = 1`, `proxy = false`. Version 1.30 ships only the threaded binary, which runs single-threaded when the page is not cross-origin isolated. The wasm is 14.2 MB raw and 3.7 MB gzipped (measured 2026-10-21).
- **Same origin.** The glue and the wasm are imported with Vite `?url`, land in `/assets/` with hashed names, and `env.wasm.wasmPaths` is set explicitly so ORT never falls back to a CDN. ORT streams the wasm from the immutable URL, which keeps streaming compilation and the browser's compiled-code cache.
- **One importer, including the URL imports.** Every `onnxruntime-web` import, the `?url` subpaths included, lives only in `web/src/scanner/worker/ort.ts`, inside the worker graph. The D13 guardrail has no exemption. The `init` message carries no runtime URLs.

  ```ts
  // web/src/scanner/worker/ort.ts (worker only)
  import * as ort from "onnxruntime-web/wasm";
  import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
  import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
  ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  export { ort };
  ```
- **Worker format.** Set `worker: { format: "es" }` in `web/vite.config.ts`, so the worker is an ES module matching `{ type: "module" }` and the URL imports and ORT's runtime `import()` of the glue work in the worker bundle.
- **Worker.** All recognition runs in a module worker: gate, corners, warp, OCR, embedding, search, combining and voting. The main thread grabs frames and draws.
- **Capability check before the scanner loads.** SIMD (`WebAssembly.validate` on a probe), module `Worker`, `OffscreenCanvas` 2d in a worker, `createImageBitmap`, `getUserMedia`, `crypto.subtle`, `caches`, `navigator.locks` and `typeof DecompressionStream === "function"`. If any is missing the scanner shows the "no camera" screen (same copy).

Rejected:
- multi-thread WASM: needs cross-origin isolation, and Safari has no `COEP: credentialless`; kept as fallback F3 only;
- WebGPU: iOS 26 and later only, a 28 MB wasm, and ORT calls the EP experimental; fallback F4;
- the default or `/all` entry: pulls WebGPU code we don't use;
- the main thread: janks the camera preview and the tray;
- supplying the wasm bytes from Cache Storage (`wasmBinary`): loses streaming compilation and the compiled-code cache, and needs a separate sha256 pin.

### D2. Image work is hand-written TypeScript, not OpenCV.js

The shipped spike path uses about 12 primitives: resize (area, linear, cubic), BGR to Lab, a 5x5 Gaussian, Sobel and Laplacian 3x3, `fitLine`, shoelace area, `getPerspectiveTransform` and bilinear `warpPerspective`. They are used by the guided corner finder, the rectify step, the gate, the embedding preprocessing and the OCR crops (spike repo: `scanspike/corners.py:389-430, 593-596`, `gate.py:27-49`, `embed.py:100-104`, `ocr.py:61-73`, `paddle_rec.py:112-124`). A few hundred lines under `web/src/scanner/vision/`, with parity pinned by fixtures (see "Test strategy").

Rejected:
- prebuilt OpenCV.js: about 10 MB more download for about 12 functions;
- a custom OpenCV.js build: needs an emscripten toolchain in CI for the same 12 functions;
- porting the contour-based `find_card`: not the shipped path.

### D3. Models are static assets in the web image, pinned by sha256, fetched at image build

- **Lock file.** `web/scanner-models.lock.json` lists `{ name, url, bytes, sha256 }` per file, with the spike's pins:
  - embedder `onnx-community/dinov2-small` at revision `8b1f705a3a7f6f062f6bdd21986c1583d3ef105d`, `onnx/model_quantized.onnx`, 24,446,700 B, sha256 `c179f8f7f592449c4c1bca4cd124a7538021428c5ffb89afde9503935b197efb` (spike repo: `scanspike/embed.py:14-20`);
  - OCR `monkt/paddleocr-onnx` at revision `7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65`: `languages/english/rec.onnx`, 7,830,888 B, sha256 `4e16deb22c4da6468bdca539b2cd3c8687825538b67109177c47d359ab994cd7`; `dict.txt`, 1,416 B, sha256 `e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6` (spike repo: `scanspike/paddle_rec.py:16-23`).
- **Fetch.** `scripts/fetch-scanner-models.mjs` (Node, because `deploy/docker/web.Dockerfile`'s build stage has no Python) downloads from `huggingface.co` only, checks bytes and sha256, and writes `web/public/scanner/m/<sha256[0:16]>/<name>`, which is gitignored. The Dockerfile runs it before `vite build`. CI's build skips it; tests use stubs.
- **Model id.** `SCANNER_MODEL_ID = "dinov2s-int8-c179f8f7-p1"` (model, first 8 hex of the sha, preprocessing version 1), in `web/src/scanner/models.ts`, generated from the lock file. `--check` fails if they disagree and runs in `npm run check`.
- **nginx.** A `location ^~ /scanner/m/`: GET/HEAD, `try_files $uri =404`, `Cache-Control: public, max-age=31536000, immutable`, plus the two security headers every location repeats (`deploy/docker/nginx.conf:68-74` is the pattern).
- **gzip.** nginx has none today. Add `gzip on; gzip_types application/wasm;` in `location /assets/` (14.2 to 3.7 MB) and `gzip on; gzip_comp_level 5; gzip_types application/octet-stream text/plain;` in `/scanner/m/` (embedder 24.4 to 19.7 MB, OCR 7.8 to 7.2 MB, measured). `fetch` inflates before the sha256 check, so verification is unchanged. `gzip_static` is a later optimisation.
- **The `.mjs` MIME type (blocking).** Upstream nginx `conf/mime.types` (release 1.28.0) maps `js` and `wasm` but has **no `mjs`**, and `nginxinc/nginx-unprivileged:1.28-alpine` installs the nginx.org packages that ship that file. So the glue `/assets/<name>-<hash>.mjs` would be served as `application/octet-stream`, and with `nosniff` the browser refuses the module `import()`. `.wasm` is verified as `application/wasm`. Add a nested regex location inside `location /assets/`. A bare `types {}` block is rejected because it would replace the whole map. `add_header`, `if` and `try_files` are not inherited into a nested location, so each is repeated:

  ```nginx
  location /assets/ {
      if ($request_method !~ ^(GET|HEAD)$) { return 405; }
      try_files $uri =404;
      gzip on;
      gzip_types application/wasm;
      add_header Cache-Control "public, max-age=31536000, immutable" always;
      add_header X-Content-Type-Options nosniff always;
      add_header X-Frame-Options DENY always;
      # ES module files (the onnxruntime-web glue imported with ?url keeps .mjs); nginx's mime.types has no mjs.
      location ~* \.mjs$ {
          if ($request_method !~ ^(GET|HEAD)$) { return 405; }
          try_files $uri =404;
          default_type text/javascript;
          gzip on;
          gzip_types text/javascript;
          add_header Cache-Control "public, max-age=31536000, immutable" always;
          add_header X-Content-Type-Options nosniff always;
          add_header X-Frame-Options DENY always;
      }
  }
  ```

  `default_type` applies because `mjs` is in no `types` entry. Tests are under "Test strategy"; the live check is part of G6.

Rejected:
- committing models to git or LFS: about 32 MB a version, kept forever;
- serving them through the API: the gateway would stream them uncached through Node;
- a third-party CDN: none exists (ADR 0002) and it adds an origin for CSP and privacy;
- Vite `?url` model imports: need the files in the repo.

### D4. The fingerprint index is catalog data: built by a separate job image, stored in PostgreSQL, served behind sign-in

**Why a separate image.** The index follows `catalog_state.revision` and the active generation, not deploys. Building needs `onnxruntime`, `opencv-python-headless`, `numpy` and the 24.4 MB model: roughly 200 to 250 MB that the API image (`deploy/docker/api.Dockerfile`, five small dependencies) should not carry on every replica. The catalog import's post-commit hook runs in the API container (`api/app/catalog.py:744-751`), which won't have them.

**The job.**
- **Image.** `deploy/docker/scanner-index.Dockerfile`, following `api.Dockerfile`, with `api/requirements-scanner.txt` (`numpy>=2.1,<3`, `opencv-python-headless==4.12.0.88`, `onnxruntime==1.31.0`, the spike's versions). It downloads and verifies the embedder from the same lock file into `/opt/scanner-models/<sha16>/`. Image `ghcr.io/ry-cen/prizecheck-scanner-index`; compose service `scanner-index`, tools-style on `backend` and `egress`, run with `docker compose run --rm scanner-index` (pattern: `compose.deploy.yml:158-169`).
- **Command.** `python scripts/scanner_index_job.py [--full]`, a portable job ([portable jobs](../../../../operations/portable-jobs.md)), hourly at minute 40 UTC, a no-op when current. **No scheduler is installed (ADR 0002).** On the Unraid dev deployment the operator runs it by hand after each catalog pull, or from an Unraid User Scripts cron.
- **Algorithm.**
  1. Take `pg_try_advisory_lock(914711)`; if held, exit 3.
  2. Read `catalog_state` (`active_generation`, `revision`).
  3. `inputs` = non-tombstoned active-generation printings with an `image_url`. `inputs_digest` = sha256 of canonical JSON `{"model": SCANNER_MODEL_ID, "printings": [[printing_id, image_url], ...]}` over `inputs`, sorted by printing id.
  4. `missing` = the inputs with no `scanner_fingerprint` row for `(printing_id, model_id, image_url)`. `due` = the members of `missing` that have no failure row for the same `image_url`, or whose `last_failed_at + backoff(failures) <= now()`. `backoff(n) = min(7 days, 1 hour x 4^(n-1))`: 1 h, 4 h, 16 h, 64 h, then 7 days. **Exit 0 early with no network use only when** the newest artifact for the model has the current `inputs_digest` **and** `due` is empty.
  5. Fetch and embed `due`: `{image_url}/low.webp` (low, because the spike's accuracy was measured on low; spike repo: `scanspike/index.py:24-35`), at most 5 requests a second with 4 workers, `User-Agent: PrizeCheck-scanner-index/1 (+owner contact)`, 20 s timeout, 2 tries, hosts `assets.tcgdex.net` and `*.tcgdex.net` only, off-host redirects refused. Decode in memory, embed, and on success upsert the int8 row and its scale and delete any failure row. On failure upsert the failure row with `failures + 1` and `last_failed_at = now()`; a changed `image_url` resets it to `failures = 1`. **Image bytes are never written to disk or the database.**
  6. **Systemic failure.** If this run's failures exceed 2% of `len(inputs)` (not of `due`), publish nothing and exit 2. Otherwise continue, so a handful of permanently broken images neither block publishing nor cost a fetch every hour. A failed printing is number-only (D6, D7) until it succeeds.
  7. Assemble the fingerprint file (see "Contracts") in printing id byte order and take its sha256. Store `count` (embedded) and `inputs_count` (printings with art at build time); `count < inputs_count` means some are missing. If the sha256 equals the newest artifact's, only update that row's `catalog_revision`, `inputs_digest` and `inputs_count`. Otherwise insert a new `scanner_index` row. Delete all but the newest 2 artifacts per model, so devices mid-download can finish. All in one transaction.
  8. Exit 0, or 1 when the database is unreachable (as `scripts/format_standing_job.py`).
- **`--full`** ignores existing rows; use it for a preprocessing change or an art refresh. A model change is a new `model_id` and needs no flag.
- **Size and time.** First full build: about 19.7k fetches (about 300 MB) at 5 a second is about 66 minutes, plus about 11 minutes of embedding at the spike's 33 ms. A new set of about 200 images takes about a minute.
- **Storage.** PostgreSQL: about 7.6 MB of rows plus at most 2 artifacts of about 8 MB per model, about 24 MB in backups. The job and the API share only `DATABASE_URL`.
- **Serving.** `GET /api/scanner/fingerprints/{sha256}` answers the bytes as `application/octet-stream` with `Content-Disposition: attachment`. It is signed-in only, which keeps the derived data off public URLs. The gateway turns any non-attachment answer into text (`auth/src/server.ts:813-824`); its attachment branch (`:787-812`) streams bytes unchanged and sets `no-store`, which suits a device that caches by content hash. **No gateway change.** A gateway test pins binary round-trip.

Rejected:
- the API image plus an ADR 0003 detached launch: about 200 MB of ML dependencies on every replica;
- a shared volume read by nginx: the `web` container is `read_only` on `edge` only (`compose.deploy.yml:134-139`), it would make the index public, and the undecided provider may not offer a shared filesystem;
- the public projection filesystem adapter (`api/app/public_projection.py:19-62`): it serves sanitized snapshots anonymously;
- base-plus-delta downloads: one 8 MB file per catalog change is acceptable because pulls are owner-triggered and rare.

### D5. The number table is built by the API on request

- `GET /api/scanner/cards/{key}` answers gzipped JSON with `Content-Type: application/octet-stream` and `Content-Disposition: attachment; filename="cards.json.gz"` (so the gateway streams it unchanged) and **no `Content-Encoding`**, so neither the gateway's `fetch` nor the browser inflates it. The client does `new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).json()`; the Cache Storage entry holds the gzip bytes as received. About 21k printings, 2.3 MB raw, about 0.6 MB gzipped (estimated).
- **Deterministic bytes.** `gzip.compress(json_bytes, compresslevel=6, mtime=0)` over `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`, with `sets` sorted by set id and `printings` columns in printing id order. The same key always builds the same bytes.
- **The key ignores set counts on purpose.** Set counts change only inside an import's promotion transaction, where the generation id in the key changes, or through the one-time backfill. So the backfill must run for the active generation **before the scanner routes are reachable** in an environment (ship blocker 6). The backfill is `ON CONFLICT DO NOTHING`, so a rerun changes no bytes and the key stays valid.
- `key` is the first 16 hex of sha256 over `{"f":1, "rev": catalog_state.revision, "gen": active_generation, "codes": set_codes.DIGEST}`. (Amended 2026-10-28 by D15: the inputs also carry a Reprint Group membership digest and a column marker, so the key changes whenever group membership changes.) The same inputs build the same bytes, so no content hash. A non-current key answers 404 `CARDS_NOT_CURRENT` and the client re-reads the manifest.
- The API keeps the last `(key, bytes)` in memory; a miss rebuilds in one query.
- It is cheap SQL, so a new set is recognizable by number the moment the import commits, with no job lag.

Rejected:
- building it in the job: ties number matching to the job's lag and needs the job image;
- folding it into the fingerprint file: different rebuild triggers;
- including Editions: they go stale and are fetched live (D8).

### D6. Set totals get a structured table, from the card records

- **Table.** `catalog_generation_set_count(generation_id uuid REFERENCES catalog_generation(id) ON DELETE CASCADE, set_id text CHECK (length 1..80), official integer NOT NULL CHECK (official >= 0), total integer NOT NULL CHECK (total >= 0), PRIMARY KEY (generation_id, set_id))`, in the next free migration (144 is the latest on this branch). Catalog data only; advances no revision, like migration 044. Not added to `catalog_generation_set`, whose `release_date` is NOT NULL while an undated set has no row.
- **Source.** Each TCGdex card record's `set.cardCount {official, total}`, verified against the live API on 2026-10-21. Filled in `import_catalog` inside the promotion transaction beside the release-date insert (`api/app/catalog.py:573-576`). Per set, take the pair most records carry; break ties with the larger `official`; no integer pair, no row.
- **Backfill.** `scripts/backfill_set_counts.py` fills the active generation from `catalog_generation.raw_gzip` (read as at `catalog.py:400-403`), idempotent with `ON CONFLICT DO NOTHING`.
- **Printed set code** comes from `api/app/set_codes.py`, not TCGdex's `abbreviation.official` that the spike used (spike repo: `scanspike/catalog.py:27-31`), because `set_codes.tsv`'s header forbids TCGdex abbreviations as a source. Consequence: tier-3 reads (set code plus number) fire only for sets `set_codes.tsv` lists. That affects only ordering within a number's candidates, and gate check G0 measures it.

Rejected:
- fetching `/sets/{id}` per import (`catalog.py:225-246`): best effort and cannot backfill offline;
- reading `raw_gzip` per table build: decompresses tens of MB each time.

### D7. Index staleness, model mismatch and printings without art

- The device reads `GET /api/scanner/manifest?model=<id>` each time the scanner opens, and uses its cache offline.
- A newer artifact or key downloads in the background while the cached one keeps scanning. The device verifies (sha256 for fingerprints; length plus parse for cards), writes the new entry, swaps in memory, deletes the old, and never mixes versions inside a frame.
- A printing in the card table but not the index is matched by number only, with the combiner's `no_art_sim`. A printing in the index but not the card table (tombstoned since) is dropped from every candidate list. Edition validity is always checked live (D8, D11), so a stale index cannot put a bad Edition in the Collection.
- With no active catalog generation the manifest answers 404 `CATALOG_UNAVAILABLE` (there is no card table to name); the device shows the generic cannot-start screen.
- `fingerprints: null` in the manifest means no artifact for the app's model. The device uses no cached index from another model and shows the no-camera screen (Q12), not a number-only scanner: number OCR alone scored 5 of 30 first. **Deploy order for a model change:** build the new model's artifact first, then deploy the web image.
- About 1.6k printings have no art (Celebrations Classic Collection, 161 energies) and are matched by number or by search. Nothing else changes.

### D8. Candidates resolve to Editions live, through one batch route

- `POST /api/scanner/printings` takes `{printing_ids: [at most 100 UUIDs]}` and answers `{catalog_revision, printings: ScannerPrinting[], missing: UUID[]}`, reusing `catalog_search._views` (`api/app/catalog_search.py:111-135`) with the `NOT gp.tombstoned` filter of `printing_detail` (`:169-182`). `ScannerPrinting` is `PrintingView` plus `default_edition_id: UUID | None`.
- **At lock.** See "A lock whose Edition cannot be resolved" below. The main thread calls this route for the lock's candidates (and, since D15, its look-alikes). A card that needs no choice is added at once with the first candidate that has a `default_edition_id`; any other card opens the choice prompt (D15), and the row is written with the Printing and Edition the collector taps.
- **On tray open** (reload, resume) the UI calls it for every row's printing, in chunks of 100. That gives fresh names and art and pre-flags stale rows (D11).

**The finish rule** (owner decision, amended 2026-10-22; it amends the closed Finish decision for Printings without an Unspecified Variant). The server computes the default Edition, so the tray holds no port of the descriptor logic. `api/app/scanner.py` gets `default_edition(editions: list[EditionView]) -> UUID | None`, "the tray's starting Edition for a Printing; None when it has no active Edition; never from the photo". Over the Printing's **active** Editions in the order `catalog_search._views` returns them (`ORDER BY e.descriptor_key, e.id`, `api/app/catalog_search.py:119`), it picks, in order:
1. no active Edition: `None` (the Printing cannot be added);
2. exactly one active Edition: that one;
3. an active Unspecified Variant (`catalog_targets.is_unspecified`): that one (the closed decision, unchanged);
4. an active Normal: `collection_import_finish.choose(NORMAL, active)` with `NORMAL = Finish(type="normal")` (`api/app/collection_import_finish.py:155`), which means type normal, no stamps, no foil pattern, standard size, preferring a subtype of none. `choose` reads `edition["descriptor"]` (`collection_import_finish.py:130`), so `default_edition` first maps the `EditionView`s to `{"descriptor": ...}` dicts. If `choose` answers `None` because several Normals fit, take the first fitting Edition with no subtype, else the first fitting one, in `descriptor_key` order;
5. otherwise the first active Edition in `descriptor_key` order.

The chosen chip shows as selected and is one tap to change. The rule is a default the collector confirms, never inferred from the photo, so it stays inside ADR 0007's rule that a scan only suggests ([ADR 0007](../../../../adr/0007-edition-marketplace-metadata-boundary.md)). **Every row always has an Edition and Confirm never waits on a finish.**

*Amended 2026-10-28 (D15):* the starting Edition now applies only to a **direct add**, that is, a card with exactly one active Edition and no look-alikes (rule 2 above, so the start is that single Edition). A card with more than one active Edition, or with look-alikes, opens the choice prompt, where the collector picks the finish and the scanner preselects none. Rules 3 to 5 therefore no longer decide a row the scanner adds; the route still returns `default_edition_id` unchanged, and no API change was made.

**A lock whose Edition cannot be resolved.** Recognition runs offline from cached assets, but adding a row needs the printings route. No row is ever written without an Edition.
- After `lock`, the main thread calls the route for the lock's up to 3 printing ids and its look-alikes (D15), with a 5 s timeout. A direct add (D15) writes a row for the first candidate, in the worker's order, that is in `printings` with a non-null `default_edition_id`; its `candidates` are up to 3 printing ids: that Printing first, then the other resolvable ids, best first. A skipped first candidate (no active Edition, or in `missing`) is skipped silently. When the card needs a choice, the same answer feeds the choice prompt instead, and the row is written for the Printing and Edition the collector taps.
- Outcomes:

| Outcome | What happens | What the collector sees |
|---|---|---|
| A candidate resolves | Write the row, or add one copy to the newest row with the same Printing and Edition (Q5 was superseded on 2026-10-28; see D15). Send `lockOutcome {added: true}`. | the lock cue and the row slides in |
| The route answers, but no candidate resolves | Auto lock: no row, `lockOutcome {added: false}`. Shutter: open search, the same as `miss`. | auto: the hint "Couldn't add this card. Tap the shutter to search." (final wording for the spec). Shutter: search opens |
| The route fails (offline, timeout, 5xx) | No row; `lockOutcome {added: false}`. | the hint "Can't reach PrizeCheck. Check your connection and scan again." Final wording is for the spec |

- **Voting.** While a lookup is pending the worker makes no new lock. On `added: false` it empties the window and re-arms without requiring an absence, and makes no lock for the next 2 s, so a failing route is called at most every 2 s (the pause does not apply to `reason: "full"`, which follows the next rule). On `added: true` the absence rule applies as before. On `reason: "full"` the card must also leave the frame before the next lock, as for `added: true`, so a full tray cannot re-prompt for the same card; and while the full-tray prompt is open the main thread sends `pause`, then `resume` when it closes. Since D15 the row and Edition are not known before the route answers, so the capacity check (`trayEditAllowed`) runs when the copy is added, after the route call (or after the collector's tap), not before it.
- **Offline cost.** Scanning therefore needs a connection to add rows even though recognition does not.
- **Offline tray display.** If the route fails when the tray opens, rows render from the cached card table (name, printed code or set id, number, art); finish chips and Confirm are disabled; a plain line asks the collector to reconnect. The printings call is retried on the browser's `online` event and whenever the tray is reopened. No row is marked `needs_pick` from an outage; only a successful answer marks stale rows.

Rejected:
- N calls to `GET /api/catalog/printings/{id}`: up to 200 round trips on open;
- Editions inside the card table: they go stale;
- **no finish by default, with Confirm held until each such row is picked** (the planner's first proposal, as Collection Import treats ambiguous rows): the owner chose the first-finish default instead.

### D9. Device storage: Cache Storage for blobs, `localStorage` for the tray

- **Blobs.** One cache, `prizecheck-scanner`, keyed by content-addressed URL: the 2 models and `dict.txt` (`/scanner/m/<sha16>/...`), the fingerprints (`/api/scanner/fingerprints/<sha256>`) and the card table (`/api/scanner/cards/<key>`). Each is verified before `cache.put`, and entries no longer referenced are deleted after each successful load. The worker reads them. The runtime glue (24 KB) and wasm (3.7 MB gzipped) use the normal HTTP cache from immutable `/assets/` URLs; an eviction costs at most a 3.7 MB re-download.
- **Tray.** `localStorage`, at most 400 rows of about 200 B each, about 80 KB (the cap is 200 distinct Editions, but one Edition can sit in several rows after chip changes; see D12). Reads are synchronous before first render, as in `web/src/workspace/galleryPrefs.ts:33-34, 96-118`. Every read-modify-write runs inside `navigator.locks.request("prizecheck:scanner:tray:<userId>", ...)`, and other tabs re-read on the `storage` event.
- **Persistence.** After the first row of a tray is added, call `navigator.storage.persist()` once per device when `persisted()` is false, and never ask again. Chrome grants silently or refuses; Safari grants mainly to Home Screen web apps; Firefox is not a target.

**Device storage and eviction.**
- **WebKit.** All script-writable storage shares one per-origin policy: up to 60% of disk for a browser origin, LRU eviction under pressure or after long non-use, and persistent origins exempt.
- **ITP, separately.** All script-writable storage is deleted after seven days of Safari use without interaction with the site. Home Screen web apps count their own days. PrizeCheck has no web app manifest, so in iOS Safari it is a normal tab.
- **Chrome.** Best-effort storage is evicted LRU under pressure unless persisted.
- **Guaranteed.** The tray survives reloads, closing the tab and restarting the phone. On iOS Safari it can be deleted after 7 days of Safari use without opening PrizeCheck, or under storage pressure. On Chrome Android only under pressure, unless `persist()` was granted.
- **After an eviction** the collector sees an empty tray and the assets download again on the next open. Nothing reaches the Collection. The app cannot tell eviction from "never scanned", because the origin's storage goes together. **Owner accepted this with no UI note (Q3).**

Rejected:
- IndexedDB for the tray: async and transaction code for about 80 KB with the same eviction class;
- OPFS: sync access handles are worker-only, and URL-keyed blobs fit Cache Storage;
- a service worker: no offline-app requirement, and it adds a PWA surface that stays out of scope;
- the HTTP cache for models: evicted unpredictably, no integrity check.

### D10. Tray identity, versioning and accounts

- **Key and version.** `prizecheck:scanner:tray:v1:<userId>`, with `"v": 1` in the value too. A future v2 reads v1, writes v2, and deletes v1 only after the write succeeds, so a rollback still finds v1. An unparseable or unknown value is treated as an empty tray and left in place until the collector changes the tray.
- **Accounts.** Per user id. Another account on the device never sees it. `signOut()` (`web/src/main.tsx:209-226`, which calls `forgetBorrowDrafts()`) does not clear it. The tray is restored when that account signs back in (Q8).
- **Pending saves.** While a save's outcome is unknown, `pending_save` is set and **the tray is read-only**: changing items would change the digest and a retry would answer `IDEMPOTENCY_KEY_REUSED`. Retry uses the same key and items. A definite answer below 500 clears `pending_save`; success clears the tray. A network error or 5xx keeps the tray frozen with a Retry action.

Rejected: clearing the tray at sign-out (the Q8 alternative; the owner chose keep). Nothing else considered for versioning.

### D11. Stale Editions cannot hurt the collector

Validation runs twice.

1. **On tray open,** the printings route marks a row `needs_pick` when its printing is in `missing` or its `edition_id` is no longer an active Edition of that printing. **Reconciliation with the owner's Q2:** the row keeps its old `edition_id`, so every row still has an Edition in the stored data. The row shows no selected chip, and Save stays disabled while any row is `needs_pick`. This is a staleness refusal, not a finish wait: the collector's one tap on a chip (or a search, if the Printing is gone) clears it. The finish default does not re-run silently, because that would replace a choice the collector made. How ticket 3 presents it is open.
2. **At save,** the server refuses with 409 `EDITIONS_CHANGED`, listing **every** affected `{edition_id, printing_id}`. The client marks exactly those rows `needs_pick`. `catalog_edition.printing_id` survives inactivation, so the server can always name the printing of an Edition it once had. An Edition id the catalog never had comes back with `printing_id: null`, and the client sends that row to search.

The Collection changes only when every Edition is active at commit, under `catalog_state ... FOR SHARE`, as batch add does (`api/app/holdings.py:201-209`).

### D12. Save route: its own route, import-shaped

`POST /api/scanner/save` (contract below). Choices:
- **Destination and undo.** Like Collection Import: the target must be the collector's Storage Leaf with no children, through `collection_import.storage_leaf` (`api/app/collection_import.py:380-383`). The owner confirmed no Deck (Q6) and no undo (Q7), so the result has no undo id. Both are one-line switches later: `moves.leaf` (`api/app/moves.py:199-203`) for Decks; `record_undo` as at `holdings.py:233-234` for undo.
- **Transaction.** Copies batch add's (`api/app/holdings.py:170-239`): validate, digest, `lock_owner`, purge expired receipts, replay, location, catalog `FOR SHARE`, unavailable set, overflow, insert or upsert, owner revision +1, `mutation_request`, `move_response`. It differs in four places: the location check, refusing all unavailable Editions at once instead of the lowest, the receipt lifetime, and no undo. It starts no catalog pull and no price refresh or seed (ADR 0006, ADR 0013); it touches only `holding`, `inventory_owner`, `mutation_request` and `move_response`.
- **Receipt lifetime 30 days.** `mutation_request.expires_at = now() + interval '30 days'` (default is 24 h, `migrations/006_add_holdings.sql:19`). Every existing purge deletes only expired rows (for example `holdings.py:190`), so longer rows are safe. **Client rule:** a `pending_save` older than 29 days is not retried. The one-day margin keeps a retry from landing just after the receipt expires. The client drops the key, unfreezes the tray and shows the note in Q11.
- **Cap.** The owner set 200 distinct Editions per tray and 999 copies per row (Q9). The limits are:
  - at most **200 distinct `edition_id`s** across rows (the owner's cap);
  - at most **400 rows**, which bounds `localStorage` at about 80 KB, since one Edition can sit in several rows after chip changes;
  - at most 999 copies a row;
  - at most 9999 copies per Edition summed across rows.

  On the wire this is at most 200 items, `MAX_SCAN_SAVE_EDITIONS = 200` (the value of `MAX_BATCH_EDITIONS`, `holdings.py:28`). The tray merges rows that resolve to one Edition before saving, summing counts, so an item's `quantity` always fits `^[1-9][0-9]{0,3}$`. The largest body is about 14.6 KB, under the gateway's default 16,384 (`readBody`, `auth/src/server.ts:116-123`) and nginx's 64k, so **no `IMPORT_ROUTES` entry and no nginx location.**
- **Enforcement on every edit.** One pure function, `trayEditAllowed(tray, edit) -> "ok" | "full" | "row_limit" | "edition_limit"`, in `web/src/scanner/tray/store.ts`. Every tray mutation calls it inside the Web Lock, before writing: a lock (a new row or a copy to an existing row), a chip change (the distinct count can rise if the old Edition stays in another row), a search pick (new row, or replacing a row's Printing and Edition; the row takes the explicit Edition the collector picks in search, per the closed Misses decision, and a Printing with no active Edition cannot be picked), a needs-pick resolution, and a count increase. A rejected edit leaves the tray unchanged. For a lock it sends `lockOutcome {added: false, reason: "full"}`: there is no 2 s pause, but the card must leave the frame before the next lock (as after `added: true`), and the worker stays paused while the full-tray prompt is open. `full` or `row_limit` shows the owner's "tray is full, confirm first" message; `edition_limit` shows a plain "That's the most copies of one card in a tray" hint (final wording for the spec).
- **No rate limit.** Saves are idempotent, bounded and owner-scoped; batch add has none.
- **Module.** `api/app/scanner.py`, router prefix `/api/scanner`, included in `main.py`; `scripts/generate_scanner_client.py` writes `web/src/scanner_generated.ts`, added to `check:client`. The binary routes use plain `fetch`.

Rejected:
- reusing `POST /api/holdings/batch`: names only the lowest unavailable Edition, 24 h receipt, allows Decks, writes undo;
- reusing import save: needs a server draft, and the tray must never create or replace one;
- a 64 KiB `IMPORT_ROUTES` entry: not needed at 200.

### D13. Bundle and code boundaries

- `ScannerPage` is a new lazy page in `web/src/shell/lazyPages.ts`, so the bundle check covers it. Add `"scan"` to Collection's `sections` (`web/src/shell/routes.ts:37-45`) with `SCANNER_PATH = "/collection/scan"` in `web/src/scanner/route.ts`; the shell imports only that, as with `collectionImport/route.ts`.
- Add `src/scanner/worker/recognizer.worker.ts` and `src/scanner/worker/ort.ts` to `EXTRA_PRIVATE_MODULES` (`scripts/check_bundle_boundary.py:35-40`). The check sees only the main build's static graph, so these catch a static import of worker or ORT code into the entry or a public page, which is the failure that matters.
- A rule in `scripts/check_guardrails.py`: `from "onnxruntime-web` only in `web/src/scanner/worker/ort.ts`, with a test in `tests/tooling/`.
- **CSP.** None today. If added, the scanner needs `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, `connect-src 'self'` and `img-src 'self' https://assets.tcgdex.net data: blob:`, and `Permissions-Policy` must keep `camera=(self)`. Record this in `docs/deployment-boundaries.md`.
- **HTTPS.** `getUserMedia` needs a secure context. The Unraid deployment is HTTPS through Tailscale Serve. Ticket 3's phone tests must use an HTTPS origin, not a LAN IP.

No alternatives were weighed for D13.

### D14. UI copy

The scanner never shows similarity or OCR scores, tiers, model, runtime or source names, index or model versions, hashes, catalog revisions, or download state beyond plain progress. First-download progress reads "Getting the scanner ready" with a bar (Q10). Its total is the lock file's `bytes` for each model file (generated into `models.ts`) plus `manifest.fingerprints.bytes` plus `manifest.cards.bytes`, leaving out entries already cached and verified. Progress counts decoded body bytes: `fetch` decodes the `/scanner/m/` gzip, so decoded model bytes equal the lock file's; the card table counts its received gzip bytes, which equal `manifest.cards.bytes`. The runtime wasm goes through the HTTP cache and is not counted, so the bar finishes only when the wasm has loaded too. Gate hints may say "Hold steady" or "More light" with no numbers; exact copy is for the spec. The owner operations panel may show the index's age and count (owner review screens are exempt). No alternatives were weighed.

### D15. Look-alike Printings and the choice prompt (2026-10-28)

**Status.** Added after the first release work. The owner's collector-facing answers are under "Owner answers (2026-10-28)" below. The technical choices were delegated and are Claude's. This section supersedes owner answer 5 (Q5) and amends D5, D8 and the tray schema note. The tray's storage version stays `v: 1`.

**Why.** Two cases made a lock a guess. Reprints share artwork, so a Printing scanned from a photo may be a sibling the collector owns (Nidoking in Base Set and in Base Set 2). And a Printing with several active Editions (Normal and Reverse Holo) was added on a starting finish, with the chip as the only correction. The owner wants the scanner to ask in both cases.

**The rule.** A tray row is one Printing and one Edition. A lock whose card has exactly one active Edition and no look-alikes is added directly. Any other lock opens the choice prompt: one entry per version (a Printing), each with its finish chips, and **None of these**. Every `suggest` lock opens it as well.

**The signal: look-alike Printings.** The look-alikes of Printing P are the other Printings that:
- are in the same Reprint Group as P (a group never spans Card Identities);
- have a fingerprint; and
- have int8 cosine to P of at least `LOOKALIKE.minCosine`, **0.85**.

They are ordered closest first (ties by newer release, then id) and capped at 7. The device computes the cosine from the fingerprints it already holds, between members of one group, at lock time: at most a few dozen 384-long dot products. Nothing new is stored on the server and the job, the PCFP format and the migrations are unchanged.

*Measurements that led here.* On the spike index (same model sha `c179f8f7…`, int8 like the job):
- Same-name Printings with different art reach 0.865 to 0.876 (Illumise sm7-18 against xy1-9 at 0.865, Eevee sv03-166 against svp-043 at 0.872, both checked by eye). A name-only threshold below about 0.90 groups different cards.
- True shared-art reprints have a median of 0.935 (Base Set 2 against Base Set, Jungle and Fossil, n=130) and 0.944 for Legendary Collection. About 4% fall below 0.86 and 10% below 0.88. Nidoking base1-11 against base4-11 is 0.901; Professor Oak base1-88 against base4-116 is 0.873.
- Name-only at 0.86 gave stars of up to 15 members (30th Pikachu, basic energies). So the Reprint Group (identical rules text) removes different cards that share a name, and the cosine removes same-text alternate arts. The cap of 7 bounds what is left.

*Dev-database check (owner round 2, 2026-10-28; model of the newest `scanner_index`).* There is no clean cut-off. Shared-art reprints sit at 0.88 to 0.92 (Nidoking base1/base2 0.90, Bulbasaur 0.904, Squirtle lc/base1 0.889). Different-art pairs of one card, such as a regular and a full-art or gold version, sit alongside them (Mewtwo VSTAR swsh10.5 086/031 at 0.869). At 0.85 there are 1,197 pairs and 1,870 Printings with look-alikes, the largest star is 7 and the 99th percentile is 4. **The owner accepted 0.85 and the extra versions it adds to the prompt** (owner answer 6). They come mostly from image-only locks; number narrowing drops them when the printed number is read. This replaces the earlier release criteria for the threshold. `LOOKALIKE.minCosine` is one constant in `web/src/scanner/recognize/constants.ts` and can be retuned without a contract change.

*Known blind spot, accepted.* Shared-art Printings in different Reprint Groups (the text changed between prints) are never look-alikes.

**The `group` column.** The number table (format 2) gains an optional `group` column (see "Number table" under Contracts). `CARDS_FORMAT` stays 2. The cards key now covers a digest of `catalog_reprint_group_member` (an `md5` over the sorted `printing_id:group_id` pairs) and a column marker, because membership can change without a catalog revision (owner Reprint Group reviews) and more than one API process may serve the table. **A Reprint Group review therefore reaches devices at their next manifest read,** and two processes never serve different bytes under one key. The cost is one aggregate over about 20k rows per manifest and cards request. The membership is already public in public records, ADR 0017 is untouched (the index stays private and the table stays signed-in only), and **no ADR is needed.**

**The `lookalikes` lock field.** The worker's `lock` message gains `lookalikes: string[]` (see the contract). It is computed in the worker from the voter's first id, so the main thread needs no group data.

**Number narrowing for automatic locks.** An `auto` lock keeps a look-alike only if the printed number supports it at least as strongly as it supports the locked card. The voter unions the number-candidate ids of the frames that backed the lock, and the session filters the look-alikes by that union **before** applying the cap of 7. A scan whose set code or denominator separates two look-alikes therefore shows only the matching one; a bare number shows both. The union errs toward showing the choice: an early, weaker reading can keep a look-alike a later, stronger one excluded. `suggest` and shutter locks keep every look-alike.

**Absence for every pending lock.** The worker now tracks absence and posts `absent` for every pending lock, not only `suggest` (D8 and the spec had it for suggestions). The main thread uses it as follows:
- A direct add is never skipped by absence: the controller ignores `absent` until a prompt is decided.
- If the card leaves while a prompt is shown, or before an `auto` or `shutter` lock resolves into a prompt, the card is skipped: `lockOutcome {added: false, reason: "dismissed"}`. The card must leave the guide before the next lock, through the voter's existing re-arming after an outcome.
- A card that leaves while a direct add is resolving is still added, as before.
- While the prompt is open the shutter is disabled and the worker makes no new lock, as for a Scan Suggestion.

**The prompt.** Versions are ordered: for `suggest`, the first candidate, its look-alikes, then the other candidates; for `auto` and `shutter`, the first candidate, then its look-alikes. At most 8 versions show. A version that does not resolve or has no active Edition is left out; if the first candidate has no version on an `auto` or `shutter` lock, the first resolvable other candidate shows alone (today's fallback). A version with two or more active Editions shows finish chips with none selected; a version with one active Edition is a single button, and it shows the finish name after its set and number (owner answer 8). One tap adds one copy. The prompt shows no scores, sources or prices. The words are in the spec's Copy table.

**Adding a copy and merging.**
- *Add.* A copy goes to the newest row with the same Printing and Edition that is not `needs_pick` (count + 1), or to a new row at the top. The row's `candidates` keep the chosen Printing first and at most 3 ids (`withinCaps` makes a longer list unparseable). The capacity check runs at this step.
- *Chip change.* Changing a row's chip merges the row into another row with the same Printing and Edition, if one exists and is not `needs_pick`. The tapped row keeps its id and position and takes the summed count; the other row is removed (owner answer 5; the survivor is Claude's choice). A sum over 999 is refused with `full` and nothing is written. To move one copy, the collector steps the count down and rescans.
- *Change card and search.* **Change card** choosing another Printing and Edition merges in the same way. A search pick in add mode stacks onto a matching row like any other add.

**Storage.** The tray stays `v: 1` under the same key. D10's v2 is not needed because the shape is unchanged: a row was always a Printing, an Edition and a count. A tray stored before this change parses and keeps every row, duplicates included, and they merge at Confirm and on the next chip change. There is no migration, by design. `mergeItems`, `confirm`, the save route and `scanner_save.py` are unchanged.

**Owner answers (2026-10-28).** Asked in the planning round; the full text is in the feature brief's `decisions.md`.
1. A tray row is one Printing + one Edition; rows are no longer keyed by Printing alone. This supersedes Q5.
2. After the collector picks a version and finish, the copy goes to the row with that Printing and Edition (count + 1), or a new row.
3. The prompt appears for every scan whose card needs a choice: a look-alike group, or a single card with more than one active Edition. A card with one active Edition and no look-alikes is added directly.
4. The prompt shows versions, each with finish chips, one tap to add; "None of these" stays.
5. Changing a row's finish chip moves the whole row and merges with an existing row of that Printing and Edition.
6. The threshold errs toward asking: `LOOKALIKE.minCosine` stays 0.85 with the dev-check evidence above.
7. Headings are "Which version?" and "Which finish?"; "Is it one of these?" stays for suggestions.
8. A version with one active Edition shows its finish name after set and number.

*Decided by Claude, owner may override:* a card taken out of the guide with the prompt unanswered is skipped (the 2026-10-25 suggestion rule); the Scan Suggestion and the new prompt are one surface; no finish is preselected (ADR 0007); the shutter follows the rules of an automatic lock; the glossary terms **Look-alike Printings** and **Scan Choice** (accepted in round 2); the tapped row survives a merge.

**Tests.** The cases that pin these rules:
- API: the `group` column numbers a Reprint Group with 2 or more Printings and leaves a singleton null; the cards key changes when membership changes and the old key answers `CARDS_NOT_CURRENT`.
- Card table: a table without `group` parses with null groups; a malformed `group` column is `CARD_TABLE_INVALID`.
- Look-alikes: same group at or above the threshold, closest first; other groups, null groups, members below the threshold and members with no fingerprint are left out; ties by newer release, then id.
- Voter and session: `absent` fires once for any pending lock; an auto lock carries the number ids of its backing frames; narrowing runs before the cap.
- Tray store: the copy goes to the newest row with the same Printing and Edition, never one with another Edition and never a `needs_pick` row; a chip change and a replacing search pick merge, the tapped row keeps its id and position; a merge over 999 is `full` and writes nothing; a stored tray with two rows of one Printing and Edition parses with both and Confirm sends one summed item.
- Browser: a two-finish card opens the finish prompt and a tap adds that finish; a second scan of another finish makes a second row; a one-finish card adds with no prompt; look-alikes open the version prompt; a card taken away with the prompt open is skipped; a chip change to a finish another row has merges the two rows.

**Risks.**
- *Scan speed.* By owner answer 3, most modern cards (Normal and Reverse Holo) prompt on every scan. This was decided deliberately and changes scan speed noticeably. Watch for owner feedback after release.
- *Session restart.* The choice controller is a module singleton and lock ids restart per worker session; a late lookup from the old session must never show a prompt in the new one.
- *Extra versions.* At 0.85 the prompt can list a different-art version of the same card, mostly on image-only locks.

Rejected:
- a name-only cosine threshold (groups different cards below about 0.90);
- storing look-alike pairs on the server (a new table and job change for data the device can compute);
- tray storage v2 (the shape is unchanged);
- preselecting a finish in the prompt (ADR 0007).

## Contracts

### Routes (signed-in, owner-scoped, none under `/api/public/`)

| Method and path | Request | 200 answer | Notes |
|---|---|---|---|
| `GET /api/scanner/manifest?model=<id>` | `model`, at most 64 chars | `ScannerManifest` | JSON, `no-store` from the gateway; 404 `CATALOG_UNAVAILABLE` with no active generation |
| `GET /api/scanner/cards/{key}` | | gzip bytes, attachment | `application/octet-stream`, no `Content-Encoding`; 404 `CARDS_NOT_CURRENT` |
| `GET /api/scanner/fingerprints/{sha256}` | 64 hex characters | raw bytes, attachment | 404 `FINGERPRINTS_NOT_FOUND` (pruned) |
| `POST /api/scanner/printings` | `{printing_ids}`, 1 to 100 | `{catalog_revision, printings: ScannerPrinting[], missing}` | `ScannerPrinting` is `PrintingView` plus `default_edition_id: UUID or null` |
| `POST /api/scanner/save` | `ScanSave` | `ScanSaveResult` | refusals below |

### Save request and response

```python
class ScanSaveItem(BaseModel):
    edition_id: UUID
    quantity: str = Field(pattern=r"^[1-9][0-9]{0,3}$")   # 1..9999 after merging; a tray row is at most 999

class ScanSave(BaseModel):
    location_id: UUID
    idempotency_key: UUID
    items: list[ScanSaveItem] = Field(min_length=1, max_length=200)

class ScanSaveResult(BaseModel):
    location_id: UUID; edition_count: int; copy_count: str; owner_revision: int   # no undo_id
```

- **Digest.** As batch add (`holdings.py:180-183`) with its own action: `{"action": "scan_save", "location_id": ..., "items": [[edition_id, quantity], ...]}`, items sorted by `str(edition_id)`, canonical JSON, sha256. A different action from `batch_add` means a key reused across routes answers `IDEMPOTENCY_KEY_REUSED`.
- **Replay** reads `moves.REPLAY` (`api/app/moves.py:240-244`); the response row is `move_response(edition_count, copy_count, 0, 0)`, as at `holdings.py:230-232`.

### Refusal table for `POST /api/scanner/save`

Checks run in this order. `refuse` is `moves.fail` (`api/app/moves.py:66`). Refusals 3 to 8 happen before any write; the transaction rolls back.

| # | Status | Code | Detail | When | Client effect |
|---|---|---|---|---|---|
| 1 | 422 | (Pydantic) | | malformed body, over 200 items, bad quantity | a bug; the tray never sends it |
| 2 | 422 | `DUPLICATE_ADD_ITEM` | | same `edition_id` twice | a bug; the client merges first |
| 3 | 409 | `IDEMPOTENCY_KEY_REUSED` | | key exists with another digest | drop the key, unfreeze, new key on next Confirm |
| 4 | 409 | `REPLAY_OUTCOME_UNAVAILABLE` | | key exists, no `move_response` row | treat as saved-unknown, like the 29-day rule (Q11) |
| - | 200 | replay | | same key and digest, receipt present | success; clear the tray |
| 5 | 409 | `DESTINATION_CHANGED` | `location_id` | location missing, not this owner's, not a `storage_leaf`, or has children (a Deck is refused, Q6) | rows kept; destination picker reopens, default Unsorted |
| 6 | 409 | `EDITIONS_CHANGED` | `editions: [{edition_id, printing_id}]`, all of them, sorted by `edition_id`; `printing_id` is null for an Edition id the catalog never had | an Edition is not active, or its printing is tombstoned, in the active generation (the SQL of `holdings.py:204-209` without `LIMIT 1`, joined to `catalog_edition`) | exactly those rows become `needs_pick`; the rest are untouched |
| 7 | 422 | `QUANTITY_OVERFLOW` | `edition_id` (lowest) | an existing Holding plus the amount exceeds `MAX_QUANTITY` (`holdings.py:212-218`) | not reachable at 9999 an item; show the generic save error |
| 8 | 503 | `INVENTORY_TEMPORARILY_UNAVAILABLE` | | `psycopg.Error` | tray stays frozen; Retry with the same key |
| - | 401 / 503 | (gateway) | | signed out; or a body over 16 KiB on a route outside `IMPORT_ROUTES`, where the default reader's `readBody` throws a plain Error (`auth/src/server.ts:116-123`) and only `PayloadTooLarge` maps to 413 (`:841-843`), so the answer is a 503, not a 413 | sign-in screen; the oversized body is impossible at the cap |

Refusals 5 and 6 are separate on purpose. Destination is checked first: a request failing both answers `DESTINATION_CHANGED`, and after the collector re-picks, the next attempt surfaces `EDITIONS_CHANGED`.

### Index manifest

```json
{"format":1,"model":"dinov2s-int8-c179f8f7-p1","catalog_revision":412,
 "cards":{"key":"<16 hex>","url":"/api/scanner/cards/<key>","bytes":612345},
 "fingerprints":{"sha256":"<64 hex>","url":"/api/scanner/fingerprints/<sha256>","bytes":7942008,"count":19659,"dim":384}}
```

`fingerprints` is `null` when no artifact exists for the model. `cards.bytes` is the gzip length. Pydantic models: `ScannerManifest {format: Literal[1], model, catalog_revision, cards: {key, url, bytes}, fingerprints: {sha256, url, bytes, count, dim} | None}`.

### Fingerprint file `PCFP` v1

Little-endian, sections 4-byte aligned.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"PCFP"` |
| 4 | 2 | u16 format = 1 |
| 6 | 2 | u16 dim = 384 |
| 8 | 4 | u32 count N |
| 12 | 32 | model sha256 (raw bytes) |
| 44 | 16 x N | printing UUIDs (RFC 4122 byte order), ascending |
| 44 + 16N | 4 x N | f32 scale per row |
| 44 + 20N | dim x N | int8 vectors, row-major, clipped to [-127, 127] |

- **Quantization,** per row as the spike (`scanspike/index.py:75-83`): each vector is L2-normalised, `scale = max|v| / 127`, `q = round(v / scale)`. The device scores `scale_i x sum(q_ij x x_j)` with the query in fp32 and L2-normalised, which is the cosine.
- **Size.** 44 + 404 x 19,659 is about 7.94 MB.
- **Server tables.** `scanner_fingerprint(printing_id uuid REFERENCES catalog_printing(id), model_id text, image_url text NOT NULL, scale real NOT NULL, vector bytea NOT NULL CHECK (length(vector)=384), computed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (printing_id, model_id))` and `scanner_index(sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'), model_id text NOT NULL, catalog_revision bigint NOT NULL, inputs_digest text NOT NULL, count integer NOT NULL, inputs_count integer NOT NULL, bytes bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())` with an index on `(model_id, created_at DESC)`; `count` is the number embedded and `count < inputs_count` means some printings are missing. The failure ledger, in the same migration, is `scanner_fingerprint_failure(printing_id uuid REFERENCES catalog_printing(id), model_id text, image_url text NOT NULL, failures integer NOT NULL CHECK (failures >= 1), last_failed_at timestamptz NOT NULL, PRIMARY KEY (printing_id, model_id))`.

### Number table (card table, format 2)

*Updated 2026-10-28.* This section described format 1 (an `image` column of raw URLs). The shipped table is **format 2**: `art` replaces `image` (#359), and D15 adds the optional `group` column. The device still parses format 1 (`image`) and format 2 (`art`), and `group` is optional, so an older client ignores it. `CARDS_FORMAT` stays 2 because an old tab rejects any format other than 1 or 2.

gzip of compact column-oriented JSON:

```json
{"format":2,"key":"<16 hex>","catalog_revision":412,
 "sets":[{"id":"sv01","code":"SVI","official":198,"total":258,"released":"2023-03-31"}],
 "printings":{"id":["<uuid>"],"set":[0],"number":["025"],"name":["Sprigatito"],
              "art":["<8 hex>"],"group":[null]}}
```

- `code`, `official`, `total` and `released` may be `null`. `set` indexes `sets`. `number` is `catalog_generation_printing.collector_number`. `art` is the 8-hex version of the Printing's TCGdex small artwork, or `null` when it has none.
- `group` (D15) is an integer Reprint Group ordinal for every Printing whose Reprint Group has 2 or more Printings in the table, and `null` otherwise. Ordinals are assigned in first-seen order down the id-sorted columns and mean nothing outside this table. The key covers group membership.
- Rows are active-generation printings with `NOT tombstoned`, manual printings included. No Editions (D5).
- On the device it builds the spike's `NumberIndex` (spike repo: `scanspike/numbers.py:38-61`): printed denominator from `official`, per-prefix denominators as the maximum number per prefix within a set, set codes from `code`, release from `released`.

### Tray storage schema (`localStorage`, key `prizecheck:scanner:tray:v1:<userId>`)

```ts
type TrayV1 = {
  v: 1;
  location_id: string | null;             // null = Unsorted, resolved through the locations API at save
  rows: TrayRow[];                         // at most 400 rows and 200 distinct edition_ids, newest first
  pending_save: { key: string; location_id: string;
                  items: [edition_id: string, quantity: string][];   // exactly what was sent
                  started_at: string } | null;
  updated_at: string;
};
type TrayRow = {
  id: string;                              // crypto.randomUUID(), row identity for the UI
  printing_id: string;
  edition_id: string;                      // never null: set from default_edition_id at lock; a stale row keeps its old id (D11)
  count: number;                           // 1..999
  candidates: string[];                    // up to 3 printing ids: printing_id first, then the other resolvable ids, best first
  needs_pick: boolean;                     // set by D11 only
};
```

- No names, images, prices, scores or photos are stored. Display data is fetched on open (D8).
- A row is one Printing and one Edition (D15, 2026-10-28; this replaces Q5's "newest row of that Printing"). A Normal and a Reverse Holo of one Printing are two rows. A repeat copy of a Printing and Edition adds exactly one copy to the **newest row with both** that is not `needs_pick`, or makes a new row at the top. Changing a row's chip merges it into another row with the same Printing and Edition if there is one (D15). Trays stored before this change may hold several rows with one Printing and Edition; they parse unchanged and merge at Confirm. The tray holds at most 200 distinct Editions, 400 rows, 999 copies a row and 9999 copies per Edition (Q9, D12); at the cap, adding another asks the collector to confirm first, and every edit is checked inside the Web Lock.
- Rows resolving to one Edition merge into one save item at Confirm, with the total capped at 9999 (D12).

### Frame voting and capture (starting rule; ticket 3 tunes it)

- **Window.** The last 4 analysed frames within 2.0 s. A lock needs the same printing top-1 in at least 3. The row's 3 candidates are the locked printing, then the next two by Borda count (rank r scores 10 - r), ties by printing id.
- **One lock per placement.** After a lock, no new lock of any printing until an absence: at least 2 consecutive analysed frames whose 32x32 grey thumbnail of the guide region differs from the lock frame's by a mean absolute difference over 24/255. This gives "stays once, out and back in is a second copy" and stops reprint twins locking twice in one placement.
- **Shutter.** With a window frame younger than 1 s, lock the Borda leader; otherwise analyse the current frame and lock its top-1. With no candidates, post `miss` and the UI opens search. The shutter ignores the absence rule.
- **Cadence.** The cheap gate runs on every accepted frame; the full pipeline runs only on gate-passing frames, one in flight.
- **Lock feedback (Q4).** A visual cue everywhere (the guide flashes, the row slides in), vibration where the browser supports it (Android), and a short sound that is off by default behind one setting. An iPhone tab has no vibration API, so it is silent and still unless the sound is on.

### Worker message contract

```ts
// web/src/scanner/worker/messages.ts — main thread <-> recognizer worker.
// Frames: the main thread crops each camera frame to the guide rectangle expanded by 25% of the guide's width and
// height on every side (clipped to the frame), at native resolution, and transfers it as an ImageBitmap. `guide` is
// the guide rectangle in that bitmap's pixels [x0, y0, x1, y1]. At most one frame is in flight; the main thread drops
// frames while the worker is busy.

export type ScannerAssets = {
  embedder: string;               // Cache Storage key: /scanner/m/<sha16>/model_quantized.onnx
  ocr: string;                    // Cache Storage key: /scanner/m/<sha16>/rec.onnx
  dict: string;                   // Cache Storage key: /scanner/m/<sha16>/dict.txt
  cards: string;                  // Cache Storage key: /api/scanner/cards/<key>
  fingerprints: string | null;    // Cache Storage key: /api/scanner/fingerprints/<sha256>; null = image matching off
};

export type ToWorker =
  | { t: "init"; assets: ScannerAssets; debugTiming: boolean }   // runtime wasm/mjs URLs come from ort.ts, not here
  | { t: "frame"; id: number; bitmap: ImageBitmap; guide: [number, number, number, number] }  // bitmap transferred
  | { t: "shutter" }
  | { t: "lockOutcome"; lockId: number; added: boolean; reason?: "unresolved" | "offline" | "full" }
  | { t: "pause" }                // tray sheet open or page hidden: drop frames, keep state
  | { t: "resume" }
  | { t: "swap"; cards?: string; fingerprints?: string };        // new verified assets; applied between frames

export type FromWorker =
  | { t: "ready"; imageMatching: boolean }
  | { t: "frameDone"; id: number }                                // the next frame may be sent
  | { t: "gate"; id: number; ok: boolean; reason?: "soft" | "dark" | "bright" | "clipped" }  // plain UI hint only
  | { t: "lock"; lockId: number; printingIds: string[]; via: "auto" | "shutter" }  // up to 3, best first
  | { t: "miss" }                                                 // shutter with no candidate: open search
  | { t: "timing"; id: number; ms: Record<string, number> }       // only when init.debugTiming
  | { t: "error"; code: "INIT_FAILED" | "ASSET_INVALID" };
```

Rules:
- After `lock`, the worker makes no further `lock` until it receives the matching `lockOutcome`.
- `added: true` arms the absence rule.
- `added: false` empties the window and re-arms with no absence needed. With `reason` `"unresolved"` or `"offline"`, no lock comes for 2 s. With `reason` `"full"`, the absence rule applies as for `added: true` and the main thread sends `pause` while the full-tray prompt is open, then `resume`.
- `swap` never mixes two asset versions within one frame.
- No message ever carries a frame or any image data from the worker to the main thread.
- `gate.reason` feeds a plain hint such as "Hold steady" or "More light"; it never shows numbers.
- *Amended 2026-10-28 (D15):* `lock` also carries `lookalikes: string[]`, up to 7 Printing ids that look like `printingIds[0]`, closest first, never `printingIds[0]` itself, `[]` when none. The worker posts `absent` once for **every** pending lock, whatever its `via`, when the card has left the guide.

### Pipeline parity table

The browser pipeline, and the index job where marked **[job]**, match the recognition spike (`~/dev/prizecheck-scan-spike`, unpublished). Constants live in `web/src/scanner/recognize/constants.ts` and `api/app/scanner_constants.py`, each with a comment naming the spike file, and the parity tests keep the two in step. Spike sources are spike-repo paths.

| Step | Contract | Spike source |
|---|---|---|
| Guide | Centred 63:88 rectangle; height 0.80 of the frame, width at most 0.86 of the frame. | `scanspike/guide.py:9-24` |
| Gate | Grey guide crop resized to height 512 (AREA when shrinking, LINEAR when enlarging); 3x3 Laplacian; variance over the crop minus a 3% border on each side. Pass needs sharpness at least 5333.31, mean luma 40 to 215, and at most 0.25 of pixels at or above 250. | `gate.py:17-58`; `data/tuning/gate.json` |
| Corners | Guided outermost-edge finder: the frame resized so the guide is 512 px high; Lab; 5x5 Gaussian per channel; per-channel Sobel 3x3, max over channels; scanline edge search with the spike's `GUIDED_*` constants (`corners.py:139-164`); `guide_ok` with area ratio 0.50 to 1.30, corner tolerance 0.35 x guide height, side angle at most 20 degrees. On failure, use the guide quad. | `corners.py:139-164, 180-198, 389-430, 583-590` |
| Warp | `getPerspectiveTransform` to 630x880, bilinear. | `corners.py:9, 593-596` |
| OCR crops | Four crops as card fractions (x0, x1, y0, y1): left (0.03, 0.36, 0.930, 0.972); right (0.72, 0.98, 0.938, 0.985); right_narrow (0.80, 0.98, 0.938, 0.985); right_high (0.72, 0.98, 0.910, 0.946). No padding, no contrast step. | `data/tuning/ocr.json`; `ocr.py:61-73` |
| OCR input | **BGR channel order**, with no RGB conversion. Height 48; width `max(8, round(w x 48 / h))`; CUBIC when h < 48, else AREA. Scaled `(x/255 - 0.5)/0.5`; NCHW `[1, 3, 48, W]`; one `run` per crop. | `paddle_rec.py:112-124` |
| OCR decode | Greedy CTC over 438 classes: blank, the `dict.txt` lines, then space. | `paddle_rec.py:73-90` |
| Number parse | `parse_number_text`, strict (`tolerant = false`), then `lookup`, tiers 1 to 3. Set codes come from `set_codes.tsv`, not TCGdex abbreviations. | `numbers.py:122-240` |
| Embed input **[job]** | Job: `{image_url}/low.webp` composited over grey 128. Browser: the warped 630x880 card. Then RGB, resized to 224x224 with AREA, ImageNet mean and std, NCHW, **one image per `run`** (int8 dynamic quantisation makes batched results differ). | `embed.py:87-104, 132-140`; `index.py:24-35` |
| Embed output **[job]** | `last_hidden_state[:, 0, :]` (the CLS token), L2-normalised, 384 dimensions. | `embed.py:132-149` |
| Index precision **[job]** | Per-row int8: `scale = max\|v\|/127`, `q = round(v/scale)` clipped to +-127. The device scores `scale_i x sum(q_ij x_j)`. | `index.py:75-83` |
| Search | Top 50 by cosine, plus `sims_for` the OCR candidates. | `index.py:114-136`; `evaluate.py:150-151` |
| Combiner | Tuned values: `distrust_margin = 0.05`, `no_art_sim = 0.7`, `max_out = 10`, `verified_hedge = true`, `image_sure = 0.85` (not the dataclass defaults). | `combine.py:9-81`; `data/tuning/combine.json`, `combine_trust.json` |

## Measurement gate (map ticket 3)

The prototype runs the real pipeline with a timing overlay behind a dev-only flag, over HTTPS. Record the exact model and OS of each device: a recent iPhone (iPhone 13 class or newer, iOS 26, Safari) and a mid-range Android (Pixel 6a or Galaxy A5x class, current Chrome). Every threshold must pass on both.

| # | Metric | How measured | Threshold |
|---|---|---|---|
| G0 | int8 index parity | Rerun the spike's ebay2 set (30 photos) in Python with the int8 index and `set_codes.tsv` codes instead of TCGdex abbreviations. The spike's real-photo figures used the fp32 index. | combined top-1 at least 19/30 and top-3 at least 24/30, else stop and report |
| G1 | Capability | On iOS Safari the threaded wasm instantiates and runs with `numThreads=1` while not cross-origin isolated; SIMD present | pass or fail; fail means the plan is void |
| G2 | Analysis per gated frame | at least 100 frames after a 10-frame warm-up, per-stage timing in the worker | p50 at most 300 ms, p90 at most 500 ms |
| G3 | Cheap gate per frame | same | p90 at most 15 ms |
| G4 | Time to lock | card placed to lock cue, the owner's 30 cards | p50 at most 1.5 s, p90 at most 2.5 s |
| G5 | First ready, warm | scanner opened to first frame analysed | p50 at most 2.0 s, max 3.0 s |
| G6 | Cold download | bytes on the wire for a first open; time on home Wi-Fi recorded | at most 45 MB (expected about 39.5 MB); `content-encoding: gzip` arrives for `.wasm` and `.onnx`. On each gate phone and on the deployed dev site, also record `curl -sI https://<host>/assets/<glue>.mjs` answering `content-type: text/javascript` and `x-content-type-options: nosniff`, and the `.wasm` answering `content-type: application/wasm` and, with `Accept-Encoding: gzip`, `content-encoding: gzip` |
| G7 | Peak memory | Safari Web Inspector (iOS) or Chrome remote DevTools (Android) | at most 350 MB over 5 minutes; no reloads or crashes in a 10-minute, 100-lock session |
| G8 | Sustained speed | G2 p50 in minute 5 against minute 1 | at most 1.5x |
| G9 | Voting | 20 cards placed, held 3 s, removed; 5 placed back; 3 swapped directly | no double counts; at most 1 of 5 second copies missed; wrong-printing locks no worse than single-frame top-1 error; report false absences |
| G10 | Accuracy through the phone pipeline | the owner's about 30 photographed cards, live, with the guide | report top-1 and top-3; below top-1 18/30 or top-3 24/30, stop and take it to the owner, not to plumbing fallbacks |

**Fallbacks.** If G2, G4, G5 or G7 fail, apply these in order, re-measuring after each and stopping at the first that passes.
1. **F1, fewer OCR crops.** `left` and `right` only; skip OCR on later frames of a window when the image's top-1 score is at least 0.85 and agrees with the window leader. Re-score ebay2 in Python first; accept only if combined top-1 and top-3 do not fall.
2. **F2, cadence.** Analyse only frames whose guide thumbnail has been stable for 150 ms (MAD at most 8/255), and request 1280x720.
3. **F3, threads.** Serve `/collection/scan` as its own full-navigation document with `COOP: same-origin` and `COEP: require-corp` and `crossorigin="anonymous"` on every `<img>` in it (TCGdex sends ACAO `*`); `numThreads = min(4, hardwareConcurrency / 2)`. Needs an nginx location and a separate HTML entry.
4. **F4, WebGPU.** Where `navigator.gpu` exists, use the `.jsep` build (+28 MB) with the fp16 embedder (44.4 MB). Needs a separate fingerprint artifact per model id, and G0 rerun for fp16. fp16 is not a WASM speed fallback.
5. **F5, smaller embed input.** 224 to 168; changes `model_id` (`-p2`), needs a `--full` rebuild, and G0 and G10 rerun.
6. **F6, OCR plus a smaller embedder.** A new spike round with an owner decision, because accuracy drops. Out of plumbing's hands.

If G7 fails alone: keep one frame in flight, never dequantize the index, release the OCR session after 60 s idle, then go to F2.

## Test strategy

- **Fixture rule: no Pokemon card artwork is committed anywhere in the repository,** including fixtures, test images, fake-camera clips, screenshots and baselines.
  - Every scanner fixture is synthetic: card-shaped rectangles in flat colours, collector numbers and set codes drawn from a bundled open font, plain or noise backgrounds, and the spike's perspective, blur and glare transforms.
  - Parity fixtures derived from the spike's synthetic renders (spike repo: `scanspike/synth.py`) are committed only after the card's art region is replaced by one flat colour. The art region is the card fractions x 0.08 to 0.92, y 0.10 to 0.55, the illustration window; only the border, the text box and the number strip remain.
  - Fixtures that need real art (embedding parity against the real index, the ebay2 rerun G0, and the owner's cards in G10) run only locally and are never committed. They are listed in `.gitignore` under `web/src/scanner/__local__/` and `.local/scanner-models/`.
  - `scripts/make_scanner_fixtures.py` regenerates every committed scanner fixture deterministically with a fixed seed, and fails if the outputs exceed 2 MB in total.
- **API (pytest, `api/tests/test_scanner_save.py`, `test_scanner_index.py`, structure of `api/tests/test_batch_add.py`).**
  - Save: one owner revision; Holdings incremented; `move_response` written; `expires_at` about 30 days out; no `inventory_undo` row; no `price_*`, `catalog_run` or `collection_import` row touched.
  - Replay with items in another order returns the same result; the same key with other items gives `IDEMPOTENCY_KEY_REUSED`.
  - `DESTINATION_CHANGED` for a deleted Location, another owner's, a Deck and a Location with children; rows unchanged.
  - `EDITIONS_CHANGED` lists every inactive or tombstoned Edition with its `printing_id`, sorted, and writes nothing; destination wins when both apply.
  - Body shape: `DUPLICATE_ADD_ITEM`; quantities `"0"`, `"10000"`, `"01"` and 201 items give 422; 200 items at `"9999"` serialise to at most 16,384 bytes (pins "no `IMPORT_ROUTES` entry"); psycopg error gives 503.
  - Printings route: `missing` holds tombstoned and unknown ids; 101 ids gives 422.
  - **Finish default** (`default_edition`): `None` with no active Edition; the only active Edition; an active Unspecified Variant over a Normal; with several Editions and a Normal, the Normal (a subtype of none preferred; several fitting Normals take the first in `descriptor_key` order); with several and no Normal, the first in `descriptor_key` order; inactive Editions are never chosen.
  - Cards: key changes with `catalog_state.revision`; stale key gives 404; the gzip inflates to the documented shape; set counts come from the new table. `test_cards_bytes_deterministic`: two builds at the same key are byte-equal. `test_cards_no_content_encoding`: the answer has `application/octet-stream` and no `Content-Encoding`.
  - Manifest: `fingerprints: null` with no artifact; another model's artifact is never returned. Fingerprints: bytes round-trip; a pruned sha gives 404.
  - Set counts: majority rule, tie to the larger; the backfill is idempotent.
  - Job, with an injected stub embedder and stub fetcher (no `onnxruntime` in the API test venv): artifacts pruned to 2; the file layout matches byte for byte on a 3-printing fixture; image bytes are never persisted. The real-model job test is `slow` and runs only in the scanner-index image's CI step. The failure-ledger tests are:
    - `test_failed_printing_retried_when_due`: run 1 fails 1 of 50, publishes 49 and exits 0; run 2, before the backoff ends, exits early with no fetch; run 3, after `last_failed_at` is moved back 2 h, fetches only that printing, publishes 50 and removes the failure row;
    - `test_permanent_failures_do_not_block_new_set`: 5 printings always fail (404) and 200 new printings arrive; the run publishes the 200 and exits 0, since 5 is under 2% of the inputs;
    - `test_systemic_failure_publishes_nothing`: more than 2% of the inputs fail, so the job exits 2 and the newest artifact is unchanged;
    - `test_unchanged_inputs_no_network`: digest equal and nothing due, so the fetcher is never called;
    - `test_image_url_change_resets_backoff`.
- **Web unit and parity (vitest).** Add `web/src/scanner/**/*.test.ts` to `vitest.config.ts` (today only `auth/tests/**`); they run under `npm run verify -- --suite auth`, a naming quirk to note in the PR.
  - Ports of the spike's own tests: numbers, combine (tuned config), guide, gate.
  - Vision primitives against OpenCV fixtures generated once in the spike repo, at most 2 MB total: resize max abs diff 1, Lab 2, Gaussian, Sobel and Laplacian 1e-3 relative, `getPerspectiveTransform` 1e-6, warp 1, guided corner quad 2 px on 10 synthetic scenes, gate measures within 1%.
  - CTC decode on canned logits; PCFP reader and int8 search on a 5-row fixture within 1e-5 of the Python scores.
  - Tray store: v1 round-trip; garbage left in place; per-user keys isolated; Web Locks serialise two writers; `pending_save` freezes edits; a 29-day-old key is dropped.
  - **Tray cap** (`web/src/scanner/tray/store.test.ts`, on `trayEditAllowed`): `rejects_201st_distinct_edition_on_lock`; `rejects_chip_change_that_adds_201st_edition`; `allows_chip_change_that_keeps_count`; `rejects_search_pick_over_cap`; `rejects_401st_row`; `rejects_count_over_999_and_edition_total_over_9999`.
  - **Row from the default:** a row built from `default_edition_id` always has an Edition with its chip selected, and Confirm is enabled. No test asserts a row without a finish blocking Confirm. A lock whose candidates all lack a `default_edition_id` writes no row.
  - Repeat lock adds one copy to the newest row with that Printing and Edition (changed 2026-10-28, D15). The D15 tests are listed there.
  - Voting: lock at 3 of 4; no relock without an absence; relock after one; shutter Borda; shutter `miss`.
  - Model-dependent parity (real ONNX models) in `*.models.test.ts` via `npm run test:scanner-models`: embedding cosine at least 0.995 to the spike's, OCR text equal on 10 strips, top-3 ids equal on a 200-row slice of the real index. Local only, never CI; ticket 3 and the gate run it.
- **Browser (Playwright).**
  - **Frame injection.** `FrameSource` in `web/src/scanner/frames.ts`:

    ```ts
    export interface FrameSource {
      start(): Promise<void>;                // camera: getUserMedia; scripted: preload images
      next(): Promise<ImageBitmap | null>;   // null = no frame available now (caller retries on the next tick)
      stop(): void;                          // releases tracks / bitmaps
    }
    ```

    - `CameraFrameSource` uses `getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } })`, then a `<video>`, then `createImageBitmap(video, sx, sy, sw, sh)` with the worker contract's crop.
    - `ScriptedFrameSource(script)` is used only when `import.meta.env.DEV && window.__PRIZECHECK_SCANNER_TEST__` is set. Production builds drop the branch.
  - **Stub script,** set with `page.addInitScript` before the page loads:

    ```ts
    type ScannerTestScript = {
      frames: {
        url: string;                                              // synthetic PNG under web/tests/fixtures/scanner/
        gate?: "ok" | "soft" | "dark" | "bright" | "clipped";     // default "ok"
        top?: string[];                                           // ranked printing ids (up to 10) this frame "recognizes"
      }[];
      loop?: boolean;                                             // repeat frames until stop; default false
      shutter?: "leader" | "miss";                                // what a shutter press yields; default "leader"
    };
    declare global { interface Window { __PRIZECHECK_SCANNER_TEST__?: { script: ScannerTestScript } } }
    ```

    `StubRecognizer` replaces only the gate verdict and the ranking, taking `gate` and `top` from the script. Voting, the absence rule (the 32x32 thumbnail difference computed on the real scripted bitmaps), `lock` and `lockOutcome`, `miss` and the tray all run for real. No model, wasm, index or card table is downloaded with the stub; the manifest and printings routes still run against the test stack.
  - `scanner-tray.spec.ts`: a lock adds a row with its default finish selected; a second placement increments the count; a shutter `miss` opens search; a lock with an unreachable printings route (route-intercept) adds no row and shows the hint; the tray persists across reload; a second collector does not see it (`web/tests/support/collectors.ts`); no request body during a scan contains image bytes.
  - `scanner-save.spec.ts`: Confirm saves into Unsorted; `EDITIONS_CHANGED` sends exactly those rows back; `DESTINATION_CHANGED` reopens the picker; a lost response retried with the same key replays; the tray is frozen while pending.
  - `scanner-fallback.spec.ts`: denied camera, missing capability, and no index built each show the same fallback screen.
  - **Real-camera smoke test** (`web/tests/scanner-camera.spec.ts` only). These are file-level options, not a new Playwright project:

    ```ts
    import path from "node:path";
    test.use({
      permissions: ["camera"],
      launchOptions: {
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-video-capture=${path.resolve("web/tests/fixtures/scanner/synthetic-card.mjpeg")}`,
        ],
      },
    });
    ```

    The `.mjpeg` is a synthetic 320x240 clip of about 20 frames made by `scripts/make_scanner_fixtures.py` under the fixture rule, under 200 KB. The spec asserts only that `CameraFrameSource` delivers frames, using the stub recognizer.
  - Stack setup copies `collection-import.spec.ts` (`startAsNewOwner`); obey the guardrails (no `waitForTimeout`, touch targets through `expectTouchTarget`).
- **Tooling.**
  - `tests/tooling/test_bundle_boundary.py`: the 2 new entries.
  - `tests/tooling/test_proxy_config.py::test_assets_mjs_served_as_javascript`: the `/assets/` block contains a nested `location ~* \.mjs$` with `default_type text/javascript`, the GET/HEAD guard, `try_files $uri =404` and all three `add_header` lines, and no `types {` block appears anywhere in `nginx.conf`.
  - `test_proxy_config.py::test_assets_gzip_wasm`: `gzip_types application/wasm` in `/assets/`, and the `/scanner/m/` location with GET/HEAD, immutable cache, security headers and gzip for `application/octet-stream`.
  - `test_onnxruntime_imports_only_in_ort_ts` (guardrail): a fixture file importing `onnxruntime-web/ort-wasm-simd-threaded.wasm?url` from any other path fails the guardrail.
  - `fetch-scanner-models.mjs --check` in `npm run check`.
  - `auth/tests/`: binary attachment pass-through (bytes 0x00 to 0xFF).

## Ship blockers

1. **Fingerprint rights.** The index is derived from TCGdex artwork fetched in bulk, which is The Pokemon Company's copyright. [Card image sources](../../../tcg-collection-tracker/wayfinder/research/card-image-sources.md) finds no source licensed for re-hosting, and that research covers re-hosting artwork, not deriving and publishing an index. **The owner's decision (Q1): the scanner is built and used only on the private, sign-in-only deployment; images are never stored; the index is never published; a public launch waits for a written rights check.** Already designed in: the index sits behind sign-in, never in git or the web image, and the job is rate-limited and identifies PrizeCheck.
2. G0 and G1 pass, and the rest of the gate passes or ends in a recorded fallback.
3. A scanner index has been published once for the shipped `model_id`, and the job is wired to run after catalog pulls in the target deployment (no scheduler today, ADR 0002).
4. CI and the deploy workflows (`.github/workflows/verify.yml`, `deploy-dev.yml`) build and push `prizecheck-scanner-index`, and the compose service exists.
5. The web image carries the verified models; nginx `/scanner/m/` is in place; gzip is verified for `.wasm` under `/assets/` and `.onnx` under `/scanner/m/`; and the `.mjs` glue is verified to answer `text/javascript` (the G6 curl check).
6. Set counts are backfilled for the active generation **before the scanner routes are reachable** in that environment.
7. An HTTPS origin for every phone (Tailscale Serve).
8. The index job's request rate and User-Agent are recorded in `docs/deployment-boundaries.md`.

## Owner answers

All asked one at a time on 2026-10-22.

1. **Fingerprint rights.** Accepted the default: private, sign-in-only deployment only; never store images; never publish the index; a public launch waits for a written rights check.
2. **Finish with several Editions and no Unspecified Variant.** The owner chose to default to the first finish, not the planner's no-finish default. Plumbing detail: Normal when the Printing has it, else the first active Edition in descriptor order; the chip shows selected and one tap changes it. Every row has an Edition; Confirm never waits on a finish; never inferred from the photo. This amends the closed Finish decision for Printings without an Unspecified Variant.
3. **Tray loss on iOS Safari.** Accepted: 7-day and storage-pressure eviction, no UI note.
4. **Lock feedback.** Accepted: visual cue everywhere, vibration where supported, a short sound off by default behind one setting. An iPhone is silent and still unless sound is on. This settles the map's lock-sound item.
5. **Repeat lock.** Accepted: the copy goes to the newest row of that Printing. Superseded 2026-10-28: a row is one Printing + one Edition; a repeat copy goes to the newest row with both; the owner answers are recorded under [D15](#d15-look-alike-printings-and-the-choice-prompt-2026-10-28).
6. **Deck as destination.** Accepted: no, Storage Leaves only.
7. **Undo after Confirm.** Accepted: none.
8. **Tray on sign-out or another account.** Accepted: kept per account, hidden from others, restored on that account's sign-in.
9. **Tray cap.** Accepted: 200 distinct Editions per tray, 999 copies per row; a full tray asks to confirm first.
10. **First download of about 40 MB.** Accepted: starts at once with a progress bar ("Getting the scanner ready"), no prompt, no cellular warning.
11. **Unanswered save older than the receipt window.** Accepted: unfreeze the tray with "This tray may already be in your Collection. Check before confirming again." The client acts at 29 days against a 30-day receipt, so a retry never meets an expired receipt.
12. **No index built yet.** Accepted: the same screen as "no camera", offering search and Collection Import.

## Effects on later tickets

- **Ticket 3, scan tray prototype.** Carries the measurement gate and tunes the voting rule (the absence threshold and K-of-N). Builds the real pipeline over HTTPS with a timing overlay, not a mock. Needs the owner's about 30 cards (G10) and the local ebay2 int8 rerun (G0). Shows the stale-row, needs-pick, destination-changed and pending-save states, the first-download progress, the selected default finish chip and the lock cues. Reuses the import review's row, candidate, finish-chip and search components (`web/src/collectionImport/ImportRowItem.tsx`, `ImportRowResolver.tsx`), fed `PrintingView` data from D8.
- **Ticket 4, terms.** Define **Scan Tray** (the on-device list of Card Editions and counts awaiting Confirm, one per collector per device, never synced) and **Scan Session** (one destination Storage Leaf from opening to Confirm or Clear). State that a Scan Tray is not an import draft and never replaces one. The fingerprint index is a docs term only. The Finish entry in `CONTEXT.md`, if any, must carry the amended default.
- **Ticket 5, spec.** Carries the contracts as the contract, the test strategy as the test plan and the ship blockers as the release gate. Work packages: (1) migration, set counts and backfill; (2) `scanner.py` routes and client generator; (3) the job, its image and compose; (4) web vision, recognizer and worker; (5) tray store and save flow; (6) nginx, Dockerfile and bundle tooling. Packages 1 to 4 can run in parallel on disjoint files; 5 needs 2's generated client. The Collection Import Camera source opens `SCANNER_PATH` and never calls `POST /api/collection-imports`.
- **ADR.** Write one, "On-device recognition assets and the scanner index job", recording D3, D4 and D9. No ADR covers static assets or caching today.

## Risks

- **Accuracy drift from porting.** The spike scored with fp32 search, TCGdex abbreviations and Python OpenCV. G0 checks the first two and the parity fixtures the third.
- **The gateway's binary path** depends on the attachment branch staying a raw pipe; the pass-through test pins it.
- **The 30-day receipt** widens `mutation_request` for scanner keys only. The purges compare `expires_at`, but check that no job assumes a 24 h maximum (search `expires_at` in `api/app`).
- **Postgres storage** adds about 24 MB per model to backups. The artifacts can later move to the private object-store factory; only the serving route changes.
- **No scheduler.** The index can lag a catalog pull until the operator runs the job; number matching for new sets works at once (D5).
- **Concurrency.** Two tabs share the tray through Web Locks. Two devices hold independent trays by design, so their saves are separate additions.
- **Security.** All routes are owner-scoped; downloads are signed-in only; the save takes `lock_owner` and the catalog `FOR SHARE`; no photo leaves the device.

## Sources

- ONNX Runtime Web env flags (numThreads, proxy, cross-origin isolation): https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html
- ONNX Runtime Web deploy (wasm binaries, wasmPaths, CSP since 1.19): https://onnxruntime.ai/docs/tutorials/web/deploy.html
- onnxruntime-web 1.30.0 package and exports: https://registry.npmjs.org/onnxruntime-web/latest ; `env.d.ts`: https://cdn.jsdelivr.net/npm/onnxruntime-common@1.30.0/dist/esm/env.d.ts ; wasm sizes measured from https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/
- ORT WebGPU EP (experimental; WebGPU on by default from iOS 26): https://onnxruntime.ai/docs/execution-providers/WebGPU-ExecutionProvider.html
- COEP and the credentialless browser data (Safari: not supported): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy , https://github.com/mdn/browser-compat-data/blob/main/http/headers/Cross-Origin-Embedder-Policy.json
- WebKit storage policy (Safari 17 quotas, eviction, persist): https://webkit.org/blog/14403/updates-to-storage-policy/
- WebKit 7-day cap on script-writable storage and the Home Screen exception: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- onnxruntime 1.31.0 wheels (cp314 manylinux): https://pypi.org/project/onnxruntime/1.31.0/
