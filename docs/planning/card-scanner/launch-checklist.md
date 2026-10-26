# Card scanner launch checklist

**Ticket:** [#321](https://github.com/ry-cen/prizecheck/issues/321), under [#308](https://github.com/ry-cen/prizecheck/issues/308).
**Spec:** [spec.md](spec.md), sections "Checks that need a person and a phone" and "Ship blockers".
**Drafted:** 2026-10-26, on `feature/card-scanner`.

The browser specs run in CI. These checks need the deployed dev site and the owner's iPhone, so a person runs them once and fills in the blanks. Nothing here is a public launch: the scanner stays on the private, sign-in-only site (ship blocker 1).

## Before any check

Do these in order. The checks below need all of them.

1. **Deploy `dev`** with the scanner merged. The deploy pulls the web, API, auth and scanner-index images.
2. **Run the set-count backfill** for the active catalog generation. Run it before anyone opens the scanner (ship blocker 6):

   ```sh
   prizecheck-deploy.sh tool /app/scripts/backfill_set_counts.py
   ```

   - The script has no arguments and no usage line of its own. It reads `DATABASE_URL`, which the `tools` service already has. Its docstring in `scripts/backfill_set_counts.py` gives the exit codes.
   - Exit 0: filled, or already full. A second run changes nothing.
   - Exit 1: the database is unreachable.
   - Exit 2: it stopped without writing. There is no active generation, or the stored records carry no `set.cardCount`. Import the catalog again first.
3. **Run the index job** and let it finish:

   ```sh
   prizecheck-deploy.sh compose run --rm scanner-index
   ```

   - It is run by hand, after a catalog pull. No scheduler starts it (ADR 0002). Add `--full` to refetch every image.
   - Exit 0: it published, or nothing was due. Exit 1: the database is unreachable. Exit 2: a systemic failure (more than 2% of the images failed, the model is unusable, or no contact is set), and nothing was published. Exit 3: another run holds the lock.
   - It reads `SCANNER_INDEX_CONTACT`, else `OWNER_EMAIL`, for its User-Agent.
4. **The index must be published before the scanner can start.** With no index built, the manifest answers `fingerprints: null` and the scanner shows its "cannot start" screen. If the scanner will not start on the phone, check this first.

| Step | Done on | By | Result |
| --- | --- | --- | --- |
| Deploy of `dev` | | | |
| Set-count backfill (exit code) | | | |
| Index job (exit code, Printings published) | | | |

## Check 1. G6 on the deployed dev site

Goal: the right headers on every asset type, and a cold download of at most 45 MB.

### Headers

Set the origin once. Use the dev site's HTTPS address:

```sh
export ORIGIN=https://unraid.<tailnet>.ts.net
```

Find the hashed asset names. Open the scanner in a desktop browser with devtools open, go to the Network tab, and reload. Filter on `ort-wasm` for the runtime glue and wasm. Filter on `/scanner/m/` for the models. Copy each URL. Or from a shell:

```sh
curl -s "$ORIGIN/collection/scan" | grep -o '/assets/[^"]*\.js'
# open each listed chunk and look for the names: grep -o 'ort-wasm[^"]*\.\(mjs\|wasm\)'
```

The model paths come from `web/scanner-models.lock.json`: `/scanner/m/<first 16 hex of the sha256>/<name>`. For the embedder that is `/scanner/m/c179f8f7f592449c/dinov2-small-model_quantized.onnx`.

Then run one command per asset type. Ask for gzip, as a browser does:

```sh
curl -sI -H 'Accept-Encoding: gzip' "$ORIGIN/collection/scan"
curl -sI -H 'Accept-Encoding: gzip' "$ORIGIN/scanner/m/c179f8f7f592449c/dinov2-small-model_quantized.onnx"
curl -sI -H 'Accept-Encoding: gzip' "$ORIGIN/assets/<ort-wasm-simd-threaded-hash>.wasm"
curl -sI -H 'Accept-Encoding: gzip' "$ORIGIN/assets/<ort-wasm-simd-threaded-hash>.mjs"
curl -sI -H 'Accept-Encoding: gzip' "$ORIGIN/assets/<scan-entry-hash>.js"
```

If a `HEAD` answer looks different from what the browser got, repeat with `curl -s -o /dev/null -D - ...`, which does a `GET`.

| Asset | Header expected | Seen | Pass |
| --- | --- | --- | --- |
| `/collection/scan` (the document) | `cross-origin-opener-policy: same-origin` and `cross-origin-embedder-policy: require-corp` | | |
| Any other HTML page, such as `/collection` | no `cross-origin-opener-policy` and no `cross-origin-embedder-policy` | | |
| `.onnx` model under `/scanner/m/` | `content-encoding: gzip`, `cache-control: public, max-age=31536000, immutable`, `x-content-type-options: nosniff` | | |
| OCR model `paddleocr-english-rec.onnx` under `/scanner/m/` | `content-encoding: gzip` | | |
| `.wasm` under `/assets/` | `content-type: application/wasm`, `content-encoding: gzip`, `cross-origin-embedder-policy: require-corp` | | |
| `.mjs` glue under `/assets/` | `content-type: text/javascript`, `x-content-type-options: nosniff`, `cross-origin-embedder-policy: require-corp` | | |
| scanner entry `.js` under `/assets/` | `cross-origin-embedder-policy: require-corp` | | |

The reverse proxy in front of nginx must pass these headers through and add no `Cross-Origin-*` header of its own. If a header is missing here but is in `deploy/docker/nginx.conf`, the proxy is the cause.

### Cold download bytes

1. Open the scanner in a desktop Chromium browser on the dev site. Use a private window, so there is no cached copy.
2. Open devtools, go to the Network tab, and tick **Disable cache**.
3. Clear the site's storage: Application, Storage, **Clear site data**.
4. Reload `/collection/scan` and wait until the camera guide shows.
5. Read the **transferred** total in the Network tab's status bar. This is the bytes on the wire, after gzip. Do not read the "resources" figure, which is the size after decoding.
6. Write it down. The limit is **45 MB**.

| Measure | Limit | Seen | Pass |
| --- | --- | --- | --- |
| Transferred, cold, cache disabled | at most 45 MB | | |
| Date, browser and version | | | |

If it is over 45 MB, stop and tell the owner. Do not change the models to fit.

## Check 2. The iPhone lock run, with a bare-table stretch

Goal: no phantom lock on an empty table, and a count of how often a card gives a Scan Suggestion instead of a lock.

Needs: the owner's iPhone (iPhone 17 Pro Max, iOS 27.0.1 was the spike's phone), the dev site over HTTPS, the owner's cards, and the checks above done.

1. Sign in on the phone at `$ORIGIN`. Open Collection and tap **Scan cards**. Note whether the address starts with `https://` (ship blocker 7).
2. Wait for the first download to finish. Note the time it took.
3. **Bare-table stretch.** Point the camera at the empty table, with the guide on it, for 60 seconds. Move the phone about a little. Count the locks and the suggestions. Expect none.
4. **Lock run.** Place the owner's cards one at a time, in the guide, and take each out before the next. Use at least 30 cards. Mix cards with a printed number strip and ones without, and a few reprints.
5. For each card, write which of these happened: automatic lock (the row appears), Scan Suggestion, or neither. For a suggestion, write whether the right card was among the candidates.
6. Repeat step 3 once more at the end, with the tray full.
7. Check that the tray shows only the cards you scanned. Open the tray, add them to a Storage Leaf, and check the toast.

| Measure | Expected | Seen |
| --- | --- | --- |
| Locks on the bare table, start | 0 | |
| Suggestions on the bare table, start | 0 | |
| Locks on the bare table, end | 0 | |
| Cards placed | at least 30 | |
| Automatic locks | | |
| Scan Suggestions instead of a lock | | |
| Suggestions with the right card shown | | |
| Cards with neither | | |
| Wrong cards locked automatically | 0 expected; record any | |
| Address starts with `https://` | yes | |
| Date, phone and iOS version | | |

For reference, the spike's phone runs gave number-backed locks right 22 of 22 and image-only locks right 3 of 9 (spec, "Recognition decided by the primary"). A high share of suggestions is expected. Phantom locks are not.

## Check 3. The gate in dim light and on foils

Goal: the shipped gate setting works in poor light and on shiny cards. The setting is sharpness off, with dark, bright and clipped on.

1. In a dim room, place cards in the guide. Note whether the dark hint shows, and whether cards lock when the hint is not showing.
2. In bright light, aim the phone at a window or a lamp. Note whether the bright hint shows.
3. Place foil and holo cards under a lamp so a glare patch crosses the art. Note whether the glare hint (clipped) shows, and whether tilting the card clears it and lets it lock.
4. Place the same foil cards in even light. Note whether they lock or suggest as plain cards do.
5. Confirm that no hint says anything about blur. The blurry hint cannot appear while sharpness is off.

| Case | Expected | Seen |
| --- | --- | --- |
| Dim room, dark hint shown | the dark hint shows when too dark; cards lock when it does not | |
| Bright light, bright hint shown | the bright hint shows when too bright | |
| Foil under a lamp, glare hint shown | the glare hint shows, and tilting clears it | |
| Foil in even light | locks or suggests as a plain card does | |
| Blurry hint ever shown | never | |
| Date, phone and iOS version | | |

## Ship blockers

From [spec.md](spec.md#ship-blockers). The commits are from `git log --oneline dev..HEAD` on 2026-10-26. "Met on branch" means the code is committed and tested here. "Pending deploy" means it can only be confirmed after the deploy above.

| # | Blocker | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Fingerprint rights | **Open** (stays open for any public launch) | The index is built from TCGdex artwork. The scanner is for the private, sign-in-only site, stores no images and publishes no index (`docs/deployment-boundaries.md`, d3e2308). A written rights check is still needed before a public launch. |
| 2 | Phantom-lock fix present | **Met on branch, pending deploy** | The eligibility rule is in `web/src/scanner/recognize/vote.ts` (76c22ed). A frame with no corners and no OCR candidate does not count, and `web/tests/scanner-suggestion.spec.ts` runs an `eligible: false` frame and a run of no-card frames (ef43e4b). The in-app bare-table run on the phone is Check 2. |
| 3 | Index published once, and the job wired to run after catalog pulls | **Open** | The job, its image and its compose service exist (59de6ae). It is run by hand after a catalog pull, with no scheduler (ADR 0002), as in "Before any check". It has not been run on the dev site, so no index is published yet. |
| 4 | CI and deploy build and push the job image, and the compose service exists | **Met on branch, pending deploy** | `scanner-index-image` job in `.github/workflows/verify.yml`, `scanner-index` in the `deploy-dev.yml` image matrix, the `scanner-index` service in `compose.deploy.yml`, and `PULL_SERVICES` in `deploy/unraid/prizecheck-deploy.sh` (all 59de6ae). The first push of the image happens on the next `dev` deploy. |
| 5 | Web image carries the models. nginx has `/scanner/m/`, the scanner document's COOP and COEP, and COEP on `/assets/` and the `.mjs` location. gzip and the `.mjs` type verified on the deployed site (G6) | **Met on branch, pending deploy** | `deploy/docker/web.Dockerfile` fetches the pinned models, and `deploy/docker/nginx.conf` has the locations (d3e2308). `tests/tooling/test_proxy_config.py` and `test_scanner_dev_server.py` pin them. G6 on the live site is Check 1. |
| 6 | Set counts backfilled for the active generation before the scanner routes are reachable | **Open** | `scripts/backfill_set_counts.py` and migration 150 (d88e0c4). Not yet run in any deployed environment. The command is under "Before any check". |
| 7 | HTTPS origin for every phone | **Open** (the owner confirms on the phone) | `docs/deployment-unraid.md` serves the dev site over HTTPS with Tailscale Serve. Check 2, step 1 records the address on the iPhone. |
| 8 | Index job's request rate and User-Agent in `docs/deployment-boundaries.md` | **Met** | The "Card scanner delivery" section records 5 requests a second with 4 workers, only `assets.tcgdex.net` and `*.tcgdex.net`, and the `PrizeCheck-scanner-index/1` User-Agent (d3e2308). |

## What the branch already proves

These need no person. They run in the browser gate, with the stub recognizer:

- `web/tests/scanner-isolation.spec.ts`: opened through Scan cards, `crossOriginIsolated` is true on the page and inside the recognizer worker, the pictures load, and no COEP console error appears.
- `web/tests/scanner-camera.spec.ts`: Chromium's fake camera plays `web/tests/fixtures/scanner/synthetic-card.mjpeg`, and the real `CameraFrameSource` delivers frames to the worker.
- `web/tests/scanner-save.spec.ts`: Close and the return after Confirm are full navigations.
- `web/tests/scanner-entry.spec.ts`: each way into the scanner is a full navigation.
- `web/tests/scanner-{tray,fallback,suggestion}.spec.ts`: locks, suggestions, the tray, and the cannot-start screens, at 1280x800 and 375x812.

Regenerate the browser fixtures with `python scripts/make_scanner_fixtures.py --browser`. They are synthetic, hold no card artwork, and stay under 2 MB.

## Sign-off

| Check | Result | Date | By |
| --- | --- | --- | --- |
| Before any check | | | |
| Check 1. G6 | | | |
| Check 2. iPhone lock run | | | |
| Check 3. Gate in dim light and on foils | | | |
| Ship blockers 2 to 7 closed | | | |
