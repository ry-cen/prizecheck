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

### Nested anonymous routes

The gateway treats every `/api/public/` path as anonymous: no session lookup, no identity forwarded, whatever cookies arrive. A budgeted public route is signed with an `anon:` caller. Enrichment routes under a snapshot (`/api/public/decks/{token}/versions/{version}/...`: the Published Deck cost and the four Published Deck export routes) reach a snapshot only through `api/app/public_deck.py`. A route calls `public_path` (query, body and syntax), then `read_active`, then its own eligibility read, then `revalidate` before it responds; `same_printing` proves a frozen row's reference against the Printing the public catalog records name. `public_deck.printing_matches` is the one proof rule behind both `same_printing` and `published_cost`. `SnapshotGone` is 404 `PUBLISHED_DECK_NOT_FOUND`, `SnapshotChanged` is 409 `PUBLISHED_DECK_CHANGED`, for the cost route, `SnapshotLate` is a withheld `deadline` answer, and `ProjectionUnavailable` is 503 at entry but a withheld `validation_unavailable` answer at the final check. The module validates the token and version syntax and rejects any query string or body, reads the active frozen snapshot from the manifest under the caller's deadline (derived rows, opaque references, quantities, and a digest of the frozen content), and re-reads it before a response so that a revoke (404), a republish or a rewritten snapshot (409) is never answered with enrichment computed for other content. Enrichment never writes the manifest, so the discovery revision is unchanged by quote updates and runner writes.

Export routes are unbudgeted and use `read_for_export`/`revalidate_for_export`, which map every failure to an HTTP error (no withheld answer).

### Published Deck exports (tickets 13 and 14)

Four anonymous routes export the active frozen snapshot, and take only a token and a version:

- `GET /api/public/decks/{token}/versions/{version}/exports/live` answers `PublishedLiveExportView` (`version, digest, status, text, inline, byte_length, total_copies, blockers`);
- `.../exports/live.txt` streams the Live text;
- `.../exports/tcgplayer` answers `PublishedMassEntryView` (`version, digest, status, url, fallback_reason, text, inline, byte_length, lines, line_count, less_specific_count, total_copies`);
- `.../exports/tcgplayer.txt` streams the Mass Entry text.

Any query string or body is `422 INVALID_REQUEST`; POST is the framework's 405. Every answer and every route-raised error carries `PUBLIC_HEADERS` (`Cache-Control: no-store`, `Pragma: no-cache`, `X-Robots-Tag: noindex, nofollow`). No answer contains an internal UUID, owner id or Deck id.

| status | code                            | when                                                                                             |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| 422    | `INVALID_REQUEST`               | a query string or a body                                                                         |
| 404    | `PUBLISHED_DECK_NOT_FOUND`      | bad token or version syntax, a token not active at entry, or no longer active at the final check |
| 409    | `PUBLISHED_DECK_CHANGED`        | another active version, or the digest changed between entry and the final check                  |
| 503    | `PUBLIC_PROJECTION_UNAVAILABLE` | the manifest is unreadable, invalid or late, at entry or at the final check                      |
| 503    | `PUBLIC_CATALOG_UNAVAILABLE`    | the record store is unreadable or late while eligibility is read                                 |
| 422    | `DECK_EMPTY`                    | `.txt` of an empty snapshot                                                                      |
| 409    | `LIVE_EXPORT_BLOCKED`           | `live.txt` while any row blocks                                                                  |

Exports have no withheld answer: a failure is an error, and the snapshot route stays available.

**Deadline.** One deadline of `EXPORT_SECONDS` (5 s) is computed per request and bounds the entry read, the eligibility read and revalidation. The routes are synchronous, because the HTTP record adapter refuses to run on an event loop. Each route reads the snapshot, reads eligibility, builds the export, then revalidates (token, version, digest) before it answers, including before a `.txt` stream starts, so a revoke gives 404 and a republish or same-version rewrite gives 409.

**Live.** A row's Printing is proven when its frozen Printing reference is present and `live_states` resolves it to a well-formed public Printing record. Marketplace state is never read, so a quarantine of the Edition never changes or blocks Live. The text uses the current reviewed identity of that Printing; blockers show the frozen name, set, number and descriptor. An unproven row blocks with reason `unproven_reference` and the snapshot stays readable; an unsupported or suspended Printing blocks every row of that Printing with its reviewed reason (and so the whole export).

**Mass Entry.** A row gets a product only when `marketplace_states` says the Edition is `product_eligible`, `same_printing` holds against the Edition record's Printing, and the frozen variant is known (not the Unspecified Variant). A quarantine turns the link into complete `missing_mapping` text at once. There is one line per proven Printing; unproven rows stay on their own name-only lines, labelled less specific. There is no specificity crosswalk, so the frozen Card Identity name is the line name.

**Reuse.** Formatting, grouping, blocking, fallback, the inline limit, the URL limit and the downloads come from the private formatters (`live_export.format_live`, `mass_entry_export.format_mass_entry`) and the shared `export_fields`/`view_fields`/`text_download` helpers in `deck_live_export` and `deck_mass_entry`. The private routes are unchanged.

**Legacy rows.** A snapshot row without references is never proven, because no store of preserved reviewed publication evidence exists and association sidecars and private lookups are forbidden. Live blocks it with `unproven_reference`, Mass Entry uses a name-only line, and a republish recaptures the references.

**Digest.** The digest is returned for diagnostics and checked server-side within a request (a change is 409); it is never an input. The client discards an answer for another version and re-reads the snapshot on 409 or 404. The snapshot route and its allowlist are unchanged (an owner decision).

**Eligibility lag.** Eligibility comes from the store's `catalog:*` and `quarantine:*` records, so a PostgreSQL decision, suspension or quarantine reaches the exports only after outbox delivery, as for prices.

**Isolation.** The routes make zero session, PostgreSQL and private-inventory access, write no record, and leave the manifest bytes and the discovery revision unchanged. They are proven by `api/tests/test_published_live_export.py`, `api/tests/test_published_mass_entry.py`, the export test in `auth/tests/published-cost.test.ts` (zero gateway and API database connections for absent, forged and valid cookies), `web/tests/published-live-export.spec.ts` and `web/tests/published-mass-entry.spec.ts`.

**Launch gates.** Actual Live import per supported case and actual Mass Entry product and text acceptance remain separate, independent launch-checklist gates. Automated tests are not destination acceptance. No rule is activated.

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

Contradictions are judged on the inputs a rule reads, not on the whole source value. Live reads the export candidate's category, name, `localId` and `set.id`; marketplace matching reads the correspondence, the TCGplayer block's product IDs by variant key and `thirdParty.tcgplayer`. A change to anything else (a regulation mark, a Cardmarket ID, a variant ID) is enrichment: the target stays as it is, nothing is published, and the mapping revision (which quotes are keyed on) does not move. Rejections stay keyed on the full source fingerprint.

Rules are code, and a changed rule digest deactivates the approved rule. A new Live set code therefore ships as a new `LiveRulesV2` next to V1, never as an edit of V1; `test_registered_rule_digests_are_pinned` guards every registered version. A deprecated or replaced Edition gives up its verified product and price slot (it becomes unmapped, `reviewed_unmapped`) so its replacement can be verified.

`quote_lookup` names the source card and the variant key but not the product, so two rules keep it honest. First, an Edition is priced only when the product it publishes belongs to that variant block: a maintainer `correct` keeps its `quote_variant` only while the Edition's own source block for that variant key holds the reviewed `productId`; otherwise the Edition is published verified but unpriced (`quote_variant` NULL). Second, one `(Printing, quote_variant)` price slot belongs to a single verified Edition, whatever product its sibling holds (code check plus the unique index `catalog_edition_verified_printing_slot`). **Obligation for the quote writers (tickets 07 and 08):** before storing a quote under `quote:<ref>:<mapping_revision>`, check that the fetched variant block's `productId` equals the published `product_id`; a mismatch is `absent`, never a quote.

### Delivery

Every correction takes its `public_revision` from one PostgreSQL clock row that stays locked until commit, and a trigger enqueues the changed target in `catalog_public_outbox` in the same transaction. A drain (`drain`) selects pending targets ordered by `(priority, sequence)`, so quarantines and suspensions go first. For each target it re-reads current committed PostgreSQL state and compares the revision with what is stored:

- Stored revision lower (a missing record counts as -1, a ticket-04 record without a revision as 0): write.
- Equal revision and equal value: mark delivered; nothing is written (replay is free).
- Equal revision, different value: write nothing; the row stays pending with `last_error=RevisionValueMismatch`.
- Stored revision higher than PostgreSQL's: write nothing; the row stays pending with `last_error=StoreAhead`. Run the rebuild.

An Edition's catalog and quarantine records always go in the same compare-and-swap, which holds at most 64 Editions or 128 Printing keys. A lost compare-and-swap rebuilds from PostgreSQL instead of trusting the stale read. A stalled or late drainer can therefore never write an older revision over a newer one, and an invalidation cannot be overtaken by a stale clear. Rows are marked delivered only up to the revision actually stored.

No PostgreSQL transaction or row lock is held during store I/O. A session advisory lock (914706) keeps one drainer running; correctness does not depend on it. A busy drain reports `pending`, and the holder re-checks once after unlocking. There is no scheduler: the drain runs after the commit of a catalog import, a missing-card approval, a metadata decision and a rule activation (`publish_catalog_best_effort`, a shim over `drain`), and from the rebuild script; it never runs at the start of a decision path. `drain` COMMITS on its connection, so it raises `DrainMisuse` for a connection with an open transaction (the shim lets that error through) and is called only after the caller's own commit. Request paths use a short budget and report `public_delivery: delivered|pending`. A request passes its `printing_ids`, and that Printing and its Editions are delivered before any unrelated backlog. A rule (de)activation can change thousands of targets, so when anything is still pending after its short drain it starts `python -m app.catalog_import --drain` in a detached session, an unbounded drain that waits out a busy lock; until it finishes the owner sees `pending` (rerun `scripts/backfill_public_catalog.py` if it stays pending). Every drain also checks that the store still holds the most recently delivered targets at their delivered revisions, and re-enqueues everything when it does not (an older store copy or a replaced store). The outbox is per database, so tests empty it around each test. Rows whose target no longer exists are marked delivered without a write (`last_error=TargetMissing`).

A records-store outage (`ProjectionUnavailable`) never rolls back PostgreSQL. The row stays pending with `attempts` and `last_error=ProjectionUnavailable`; the next drain delivers it. The owner operations status reports `catalog_outbox_pending` and `catalog_outbox_oldest_seconds`. Anonymous readers see the previous eligibility until delivery, so a nonzero pending count is the lag to watch. There is no owner "retry delivery" endpoint.

### Readers fail closed

`marketplace_states(store, edition_refs, deadline)` reads `catalog:edition` and `quarantine:edition` for all references at one pinned generation, then reads quote state with `quote_states(..., generation=g)` at that same generation. An Edition is `unknown` (ineligible) if either record is missing or malformed, if their `revision` or `mapping_revision` differ, or if it is quarantined or not verified. A verified Edition is product-eligible when `product_id` is set, and price-eligible when `quote_lookup` is set. `live_states(store, printing_refs, deadline)` does the same for `catalog:printing`. Quote writers (tickets 07 and 08) must include the `quarantine:edition:<ref>` version in `expected` on every fenced write and write only the current `mapping_revision`.

### Recovery

`scripts/backfill_public_catalog.py` (the name is kept) rebuilds the records from PostgreSQL. It first scans the store for the highest stored revision (`store_max`) and for records PostgreSQL does not explain, advances the clock with `greatest(revision, store_max)`, marks each unexplained target `quarantined` or `suspended` with reason `recovery_conflict` at a revision above `store_max`, then re-enqueues and delivers every target. It never initializes the store (run `init_public_records.py` first), exits 1 when the store is unreachable or delivery cannot finish, and a second run writes nothing. See `docs/operations/local-recovery.md` for the R1 to R3 procedures.
