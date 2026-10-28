# Card art is served from our origin through a read-through store keyed by Printing

**Status:** accepted on 2026-10-27. Claude decided it under the owner's delegation of technical plumbing; the owner chose to serve card art from our own origin through a store that saves each image on first request, so the most-used images can later be upgraded to higher resolution (tickets #358 to #361).

The scanner page is cross-origin isolated (`Cross-Origin-Embedder-Policy: require-corp`, [ADR 0017](0017-on-device-recognition-assets-and-the-scanner-index-job.md)), so every scanner `<img>` carried `crossorigin="anonymous"` and the browser ran a CORS check on each image. About 20% of TCGdex's images (81 of 400 sampled) are sent with `Access-Control-Allow-Origin: *` twice, which browsers reject, so those cards showed a broken-image icon in the tray, Scan Suggestion and scanner card search. TCGdex sends no `Cross-Origin-Resource-Policy`, and COEP `credentialless` is not available in Safari, so the pictures have to come from our own origin.

**Decision.**

- **One route, keyed by Printing.** `GET /api/art/{printing_id}/{size}` (`size` is `small` or `large`) is signed-in only, like the scanner routes. It takes no URL: the source is resolved from catalog data (today the active generation's TCGdex `image_url` plus `/low.webp` or `/high.webp`), and the fetcher accepts exactly `https://assets.tcgdex.net`. The route therefore cannot act as an open proxy. Later sources plug into the resolver without changing the route.
- **The store saves each image on its first request.** The fetch has a timeout, a 2 MiB cap, a content-type allowlist (`image/webp`, `image/png`, `image/jpeg`; never SVG) and a magic-byte check, runs at most 5 requests a second and identifies itself as `PrizeCheck-art/1`. Concurrent first requests for one object coalesce into one upstream request. A failure is recorded with backoff (1 minute growing to a day), so a missing file is not refetched on every request. Every failure answers 404 so the owner's API fault counts stay meaningful.
- **Versioned URLs.** Clients get `/api/art/{id}/{size}?v=<8 hex of sha256(source URL)>`. The version only makes the URL change when the source does; the route never uses it to choose bytes. A request with the current version is cached for a year (`private, max-age=31536000, immutable`); any other request gets the current bytes with `private, no-cache`. Responses carry `Cross-Origin-Resource-Policy: same-origin` and `X-Content-Type-Options: nosniff`, and the gateway streams them as raw bytes.
- **Disk now, S3-compatible later, behind `ArtStorage`.** The interface is `get`, `put` and `delete` by key. The only implementation is a directory (`ART_STORE_DIR`, a bind mount under `PRIZECHECK_DATA_DIR` in the deployed stack) with atomic writes. A storage contract test runs through the interface only, so an object-storage implementation can reuse it. PostgreSQL records each stored object (source, key, sha256, type, size, time), a hit count and last hit per (Printing, size) for a later upgrade job, and the failure ledger.

**Considered options.**

- **A pass-through proxy with no store.** Rejected: it would fetch from TCGdex on every view, hold no per-image state to upgrade, and offer no place to rate-limit or remember failures.
- **COEP `credentialless`.** Rejected: Safari does not support it, and the scanner must work on iPhones.
- **Dropping `crossorigin` from the scanner images.** Rejected: under `require-corp` a cross-origin image without CORS needs a `Cross-Origin-Resource-Policy` header TCGdex does not send, so every image would fail.
- **A named Docker volume for the files.** Rejected: every other persistent mount is a bind mount under `PRIZECHECK_DATA_DIR`, and a volume would be the only state outside it. The deploy script's preflight requires the directory, so Docker never creates a root-owned one the API cannot write to.
- **A database advisory lock to coalesce fetches.** Rejected: the API is one process, and a lock held across a 10 second fetch would tie up a connection. Writes are atomic and upserts idempotent, so a second process would at worst fetch twice.

**Consequences.**

- **The first view of a card is slower, and a cold page may show placeholders.** The rate limit is 5 requests a second; when its queue is more than 10 seconds long a request answers 404 at once and the client shows the plain placeholder until the page is opened again.
- **The files are regenerable and stay out of backups.** `backup` archives only `public`. Deleting `art/` costs refetches. Each host runs `prizecheck-deploy.sh setup` once after the script update, because deploys refuse to run without `art/`.
- **TCGdex art is stored, not only linked.** This ADR stores TCGdex copies only. It does **not** copy TCGplayer images: [ADR 0019](0019-tcgcsv-daily-prices.md) chose "linked, not copied" for them, and whether to store them is #361's decision. ADR 0019 lives on the TCGCSV branches until they merge; the file name is the link target.
- **Number clashes are possible at merge.** Migration `156_` and this ADR number were chosen around the TCGCSV branches (migrations 152 to 155, ADR 0018 and 0019); renumber if another branch lands first. #354's planned guardrail on `/low.webp` will flag `art_urls.py`; whoever merges second routes the source through `catalog_printing_art` or allows it.
- **The index job and the API can overlap.** Each is held to 5 requests a second against TCGdex, so a manual index run alongside heavy first views can reach 10 a second. This is documented, not enforced.
- **Art is cached privately for a year.** It is public catalog art and survives sign-out on that device; the cache is `private`, so shared caches do not keep it.

**Amendment (#360): the signed-in app shows art from the route.**

- **The server builds every signed-in address.** `catalog_printing_art` (migration 157) carries `small_art_url` and `large_art_url`, built by `catalog_art_route`, so every signed-in read selects a route address and the client never edits a file name. The Published Deck page and the public catalog keep reading `low_image_url`, so no anonymous response holds a route address. The scanner stays on TCGdex art.
- **One version for both sizes.** `?v=` is the first 8 hex of the sha256 of the Printing's small source URL, for both sizes. A Printing's two files change together, so a large view asks for the same address with `large` in place of `small` and still gets the year-long cache.
- **Fallback art is linked.** The resolver reads the view's chosen source. A TCGdex file is fetched and stored as before. A TCGplayer fallback is not copied ([ADR 0019](0019-tcgcsv-daily-prices.md)): the route answers `302` to the exact `tcgplayer-cdn.tcgplayer.com/product/{id}_200w.jpg` or `_400w.jpg` address the view builds from an integer product id, so a Printing's art still comes from one place. Whether to store TCGplayer copies stays #361's decision.
- **Guardrail.** `scripts/check_guardrails.py` allows `/low.webp` and `/high.webp` only in `api/app/scanner.py` and `api/app/art_urls.py`, and nowhere in `web/src`.
