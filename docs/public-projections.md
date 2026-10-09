# Local public Deck object projection

Anonymous Deck reads open only the sanitized projection in `PUBLIC_PROJECTION_DIR` (default `.local/public-projections`). They never connect to PostgreSQL or look up a session. The JSON response allowlist is defined by `PublicSnapshot`; nested models reject extra fields. React renders source metadata and titles as text. Unlisted snapshots use `noindex, nofollow`, and all snapshot responses use `Cache-Control: no-store`.

Before starting a NEW local environment, initialize its empty object store:

```sh
PUBLIC_PROJECTION_DIR=/absolute/path/public-projections .venv/bin/python scripts/init_public_projection.py
```

For an EXISTING install that predates shared records, initialize only the records store. The same command upgrades an empty legacy records store and does nothing for an established store:

```sh
PUBLIC_PROJECTION_DIR=/absolute/path/public-projections .venv/bin/python scripts/init_public_records.py
```

It never touches the publication/discovery manifest. It is idempotent and creates the store only when no records files exist. It exits with status 1 and changes nothing if established records are missing or corrupt, if a leftover `initialized` marker or generation files exist without a valid pointer, or if a legacy (format-1) records store holds data. Restore those from backup rather than resetting them. There is no in-place migration of a populated legacy store; no such store was written by production code. A new environment's `init_public_projection.py` initializes both stores, so this script is not needed there (running it afterwards is harmless). With the HTTP adapter the script calls the relay's `initialize` action (`docs/http-public-projection.md`).

Keep that path in the API environment and outside any static-file web root. All API processes must share the same writable filesystem. The local adapter uses a process lock, fsync, and atomic file replacement to switch the complete public snapshot/discovery manifest. No public snapshot history is retained. The adapter assumes macOS/Linux filesystem semantics and is a development boundary; deployment provider selection must supply shared storage with equivalent serialization and atomic updates. Public snapshots and their visibility are the only content in this projection; owner linkage, command records, and token tombstones remain private PostgreSQL data.

A publication command commits its token linkage and a sanitized projection operation to a durable private outbox, then applies the public operation. It returns success only after the complete object switch. An interrupted or failed object write returns `503 PUBLICATION_UNAVAILABLE`; the prior complete object remains available when replacement did not occur. Retry with the same idempotency key. Any subsequent authorized publication command first drains pending operations in order, so it cannot overwrite a newer result with an older retry. A crash after the object switch repeats that same operation safely. No scheduler or polling worker is required. Revocation removes the public token object and permanently records the burned token privately; publishing again generates a fresh 192-bit token.

Missing or corrupt object storage returns `503 PUBLIC_PROJECTION_UNAVAILABLE`, rather than pretending the Deck was deleted. Do not initialize an empty manifest to recover lost storage. Restore the public store from its backup, or rebuild it from the private publication command history with revoked-token and visibility state preserved. Back up this private command history together with publication linkage. Never expose those private tables or records through an anonymous route. A public store failure does not report successful publication or revocation.

CI must use a disposable database and a fresh `PUBLIC_PROJECTION_DIR`, initialize the store before browser tests, and remove it afterward. Individual HTTP tests isolate their object stores. Hosting and object-storage vendors remain unselected under ADR 0002.

Listed visibility changes reuse the same atomic manifest switch and private outbox, so discovery, sitemap, and snapshot indexing headers change together. Visibility changes preserve snapshot content and version. Public search matches public title or included Card Identity name, orders by publication time and stable token, and returns 30 summaries per page. Signed cursors bind the normalized query and monotonically increasing projection revision; any intervening publication mutation returns `409 DISCOVERY_CHANGED`, and the UI restarts at page one. Public discovery and `/api/public/sitemap.xml` read only sanitized public objects.

The local auth gateway can enforce anonymous public-read budgets with `PublicReadLimiter` from `auth/src/publicReads.ts`. Mount it before proxying snapshot, discovery, and sitemap GET requests, using the existing trusted-proxy client address derivation. It retains only randomly salted caller digests in a bounded in-memory one-minute window, clears them on expiry, and writes no IP addresses or caller counts to PostgreSQL. The default is 120 reads per caller per minute. Return 429 with Retry-After when exhausted. Production edge selection must provide equivalent rate limiting across replicas; the local helper protects the single gateway process.

## Shared public records

Public catalog metadata, quotes, quarantine, and refresh coordination live in `PUBLIC_PROJECTION_DIR/records`, separate from the Deck manifest. Record writes never change the manifest, its revision, or discovery cursors. `api/app/public_records.py` defines the typed key families and the store API. The HTTP relay equivalent is in `docs/http-public-projection.md`.

The filesystem adapter stores immutable content-addressed generations behind one atomic pointer file. Its index has 4,096 shards, so a commit rewrites only the touched shards and a small manifest. Writers serialize on a shared `flock`. Reads take no lock, write nothing, and see one consistent generation. Only `quote:` payloads are evictable, up to 250,000 entries or 256 MiB, oldest first. Every other family is protected. A failed conditional commit writes nothing.

Cleanup runs only during writes. It is incremental and best-effort, so a cleanup failure never fails a commit. Cleanup always keeps the current generation and every generation superseded within the last 15 seconds. Readers can therefore pin one generation across many 128-key batches; after that window, reads of the old generation fail closed. The operation log keeps explicit operation IDs for 120 seconds. Deleted-record tombstones are compacted after 10 minutes without making old versions valid again.

Back up the `records` directory with the rest of the projection directory. A copy taken without stopping writers can capture a pointer that names a generation absent from that copy. If so, restore from a quiescent copy. Missing, corrupt, or full storage returns unavailable rather than older data. Do not delete files by hand or re-initialize over lost state.
