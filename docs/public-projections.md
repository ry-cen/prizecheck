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

## Public catalog records: reviewed state, outbox and delivery

`api/app/public_catalog.py` is the only writer of the `catalog:printing:<ref>`, `catalog:edition:<ref>` and `quarantine:edition:<ref>` records. PostgreSQL is authoritative; the store is a derived, rebuildable copy. Values are exact allowlists. No internal UUID, source ID, owner, reviewer, evidence URL, free-text reason, report, reporter, rejected fingerprint, source candidate or quote amount is ever published.

```
catalog:printing:<ref>   {printing_ref, name, set_id, set_name, collector_number, image_url,
                          revision,
                          live: {state: unsupported|eligible|suspended, reason: <code|null>, rule_version: <int|null>,
                                 identity: {category, name, set_code, number} | null}}
catalog:edition:<ref>    {edition_ref, printing_ref, descriptor, revision,
                          marketplace: {state: unverified|verified|quarantined, reason: <code|null>, mapping_revision,
                                        product_id: <int|null>,
                                        quote_lookup: {source: "tcgdex", card, variant} | null}}
quarantine:edition:<ref> {edition_ref, revision, mapping_revision, state: clear|quarantined}
```

`revision` is the commit-ordered public review revision (`public_revision`). `product_id` is published only while the Edition is verified. `quote_lookup` is published only while it is verified and has a reviewed quote variant. Live identity is published only while the Printing is eligible. Reason codes are the fixed enums in migration 023.

`quote_lookup` names the source card and the variant key but not the product, so two rules keep it honest. First, an Edition is priced only when the product it publishes belongs to that variant block: a maintainer `correct` keeps its `quote_variant` only while the Edition's own source block for that variant key holds the reviewed `productId`; otherwise the Edition is published verified but unpriced (`quote_variant` NULL). Second, one `(Printing, quote_variant)` price slot belongs to a single verified Edition, whatever product its sibling holds (code check plus the unique index `catalog_edition_verified_printing_slot`). **Obligation for the quote writers (tickets 07 and 08):** before storing a quote under `quote:<ref>:<mapping_revision>`, check that the fetched variant block's `productId` equals the published `product_id`; a mismatch is `absent`, never a quote.

### Delivery

Every correction takes its `public_revision` from one PostgreSQL clock row that stays locked until commit, and a trigger enqueues the changed target in `catalog_public_outbox` in the same transaction. A drain (`drain`) selects pending targets ordered by `(priority, sequence)`, so quarantines and suspensions go first. For each target it re-reads current committed PostgreSQL state and compares the revision with what is stored:

- Stored revision lower (a missing record counts as -1, a ticket-04 record without a revision as 0): write.
- Equal revision and equal value: mark delivered; nothing is written (replay is free).
- Equal revision, different value: write nothing; the row stays pending with `last_error=RevisionValueMismatch`.
- Stored revision higher than PostgreSQL's: write nothing; the row stays pending with `last_error=StoreAhead`. Run the rebuild.

An Edition's catalog and quarantine records always go in the same compare-and-swap, which holds at most 64 Editions or 128 Printing keys. A lost compare-and-swap rebuilds from PostgreSQL instead of trusting the stale read. A stalled or late drainer can therefore never write an older revision over a newer one, and an invalidation cannot be overtaken by a stale clear. Rows are marked delivered only up to the revision actually stored.

No PostgreSQL transaction or row lock is held during store I/O. A session advisory lock (914706) keeps one drainer running; correctness does not depend on it. A busy drain reports `pending`, and the holder re-checks once after unlocking. There is no scheduler: the drain runs after catalog import and after missing-card approval (`publish_catalog_best_effort`, now a shim over `drain`), at the start of the decision and rule-activation paths, and from the rebuild script. Request paths use a short budget and report `public_delivery: delivered|pending`. Rows whose target no longer exists are marked delivered without a write (`last_error=TargetMissing`).

A records-store outage (`ProjectionUnavailable`) never rolls back PostgreSQL. The row stays pending with `attempts` and `last_error=ProjectionUnavailable`; the next drain delivers it. The owner operations status reports `catalog_outbox_pending` and `catalog_outbox_oldest_seconds`. Anonymous readers see the previous eligibility until delivery, so a nonzero pending count is the lag to watch. There is no owner "retry delivery" endpoint.

### Readers fail closed

`marketplace_states(store, edition_refs, deadline)` reads `catalog:edition` and `quarantine:edition` for all references at one pinned generation, then reads quote state with `quote_states(..., generation=g)` at that same generation. An Edition is `unknown` (ineligible) if either record is missing or malformed, if their `revision` or `mapping_revision` differ, or if it is quarantined or not verified. A verified Edition is product-eligible when `product_id` is set, and price-eligible when `quote_lookup` is set. `live_states(store, printing_refs, deadline)` does the same for `catalog:printing`. Quote writers (tickets 07 and 08) must include the `quarantine:edition:<ref>` version in `expected` on every fenced write and write only the current `mapping_revision`.

### Recovery

`scripts/backfill_public_catalog.py` (the name is kept) rebuilds the records from PostgreSQL. It first scans the store for the highest stored revision (`store_max`) and for records PostgreSQL does not explain, advances the clock with `greatest(revision, store_max)`, marks each unexplained target `quarantined` or `suspended` with reason `recovery_conflict` at a revision above `store_max`, then re-enqueues and delivers every target. It never initializes the store (run `init_public_records.py` first), exits 1 when the store is unreachable or delivery cannot finish, and a second run writes nothing. See `docs/operations/local-recovery.md` for the R1 to R3 procedures.
