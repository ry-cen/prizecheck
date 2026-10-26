# Deployment boundaries pending provider selection

This is a proposed provider-independent topology, checked against the application at `a197edb` on 2026-10-06. It is preparation for ticket 15, not a provisioned environment or production proof. ADR 0002 leaves all vendors undecided.

## Same-origin request path

A TLS reverse proxy serves the Vite build from `dist/web` and routes `/auth/*` and `/api/*` to the Better Auth gateway on a private loopback listener. Other application routes, including `/published/<token>` and `/discover`, receive the SPA entry point. Configure `PUBLIC_ORIGIN` to the exact HTTPS origin. Better Auth uses secure cookies for non-localhost origins, 30-day sessions, and daily rolling refresh. Mutating authentication endpoints check the request Origin.

The gateway verifies the session and signs the method, path, body hash, account ID, and timestamp with `INTERNAL_AUTH_SECRET` before forwarding protected API requests to the private FastAPI listener. The API verifies the signature and a 30-second timestamp window. The reverse proxy must never expose FastAPI directly. Only explicitly configured proxy peer addresses may supply the gateway's client-IP header; strip client-supplied forwarding and internal identity headers at ingress. Keep PostgreSQL and process-control interfaces private.

Anonymous snapshot, discovery and sitemap GETs bypass session lookup and read the sanitized public projection, avoiding private database wakeups. The current filesystem adapter needs a shared writable local filesystem with locks and atomic replacement, outside the static root. It is not a remote object-storage adapter. A chosen provider must preserve atomic publication, discovery, visibility and permanent revocation semantics. See [public projections](public-projections.md).

## Card scanner delivery

The scanner ([spec](planning/card-scanner/spec.md), [ADR 0017](adr/0017-on-device-recognition-assets-and-the-scanner-index-job.md)) is its own page, `web/scan.html`, served at `/collection/scan` by its own nginx location (`deploy/docker/nginx.conf`). That page alone sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which the threaded WASM runtime needs; no other HTML document does. `/assets/` and its nested `.mjs` location send `Cross-Origin-Embedder-Policy: require-corp` too, because the recognizer worker script and the runtime's glue are loaded by the isolated page and carry their own embedder policy. The `.mjs` location also answers `text/javascript`, since nginx's `mime.types` has no `mjs`. The reverse proxy in front of nginx must pass these headers through and add no `Cross-Origin-*` header of its own.

The pinned models are fetched at image build (`scripts/fetch-scanner-models.mjs` from `web/scanner-models.lock.json`, checked by size and sha256) and served under `/scanner/m/<sha256 prefix>/` with immutable caching and gzip. The build needs to reach `huggingface.co`.

If a Content-Security-Policy is ever added, the scanner needs:

- `script-src 'self' 'wasm-unsafe-eval'`
- `worker-src 'self' blob:` (the capability check probes module workers with a throwaway blob worker)
- `connect-src 'self'`
- `img-src 'self' https://assets.tcgdex.net data: blob:` (every scanner `<img>` carries `crossorigin="anonymous"`; TCGdex sends `Access-Control-Allow-Origin: *`)

The deployment sets no `Permissions-Policy` today. If one is added it must keep `camera=(self)`; `getUserMedia` also needs HTTPS (Tailscale Serve on Unraid).

The fingerprint index job fetches `{image_url}/low.webp` from `assets.tcgdex.net` and `*.tcgdex.net` only, at most 5 requests a second with 4 workers, and identifies itself with `User-Agent: PrizeCheck-scanner-index/1 (+owner contact)`. The index is behind sign-in and never public; a public launch waits for the written rights check (spec "Ship blockers").

## Jobs and recovery

The runtime must support detached Python imports surviving API restart, or supply an equivalent on-demand launcher whose exact-run and PostgreSQL ownership semantics are validated. A service manager must not terminate an import merely because it restarts the HTTP service. The import exits after one run; no permanently polling catalog worker is required. See ADR 0003.

Backups require a separate private storage namespace inaccessible from public projection routes. Daily scheduling, seven daily/four weekly retention, monthly disposable recovery, and an independent hourly backup-age watchdog must be connected to the selected runtime. A watchdog sharing only the backup process's lifetime cannot prove independence. Provider quotas and 70% warning thresholds must use actual selected allowances; unavailable metrics must remain unverified.

## Release and launch evidence still required

A provider implementation must bind a successful credential-free CI result to the exact release commit before secret-bearing deployment, serialize releases, verify compatible migrations and retain a previous compatible release. Local build/test success is insufficient to prove deployment, migration compatibility with an older application, or rollback.

The gateway currently admits only the configured owner email. Production real email delivery remains unimplemented: `deliverCode` only has local console/file adapters and rejects them in production. Selecting a provider and verifying its sending domain precede real owner/non-owner delivery and public signup. Never substitute local file-mail evidence for delivery proof.

Before provider selection is final, measure the agreed representative fixture and compare resources, idle and variable cost, region latency, storage, recovery, public projection consistency, import process lifetime, and operations responsibilities. Synthetic local fixture results must identify their deviations from the full English catalog and selected-host measurements. Tickets 15–18 remain open until their recorded decision and production gates are satisfied.
