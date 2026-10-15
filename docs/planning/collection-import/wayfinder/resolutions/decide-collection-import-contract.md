# Decide the collection import contract

**Ticket:** [Decide the collection import contract](https://github.com/ry-cen/prizecheck/issues/224), with [Decide collection import limits](https://github.com/ry-cen/prizecheck/issues/222) merged in.
**Resolved:** 2026-10-15. The owner set the size cap. Claude settled the plumbing, which the owner delegates.
**Builds on:**
- [what the import accepts](decide-what-the-import-accepts.md);
- [how rows match](decide-how-rows-match.md);
- [the review](prototype-collection-import-review.md);
- decklist import's [import contract](../../../decklist-import/wayfinder/resolutions/decide-import-contract.md) on `feature/decklist-import`.

## Owner decision

**One import holds at most 10,000 rows and 5 MB.** That's three times the largest real Pokémon export found. The 5 MB applies to the upload and to the unzipped content, and the 10,000 rows include left-out rows. A bigger collection is split into two imports. The error says so and gives the limit (422 `IMPORT_TOO_LARGE`, `IMPORT_TOO_MANY_ROWS`). A paste has the same limits.

## Technical calls

### The review is held on the server

A stateless review like decklist import's would post megabytes on every fix. Instead the server parses and matches once and keeps the result as an **import draft**:

- **What a draft is.** A draft belongs to one collector, who has at most one open at a time. Starting a new import replaces the open draft, and the screen confirms this first. A draft expires 24 hours after its last change.
- **What it stores.** Each source row's raw text, group, status, matched Printing and Edition, candidates and the collector's fix, plus the landing Location, the excluded groups, a `draft_revision`, and the `catalog_revision` it was matched against.
- **Privacy.** Raw rows are deleted when the draft is saved or expires. Only a small receipt is kept (id, saved time, counts, result) for the idempotent replay below, also for 24 hours.

### Interfaces

All of these are under `/api/collection-imports`, for the signed-in owner only.

- **`POST /api/collection-imports`** starts a draft. Its body is either the file (`.csv`, `.tsv`, `.txt`, or a `.zip` holding exactly one of those) or `{ "text": … }`, plus the landing `location_id`.
  - **Parsing and matching** run in the request, with set and number lookups batched rather than made per row.
  - **The spec sets a budget:** 10,000 fixture rows parse and match within 10 seconds in CI. If that can't be met, the spec moves the work to a detached job (ADR 0003's launcher pattern), with no change to this interface.
  - **Returns** the draft id and its summary.
- **`GET /api/collection-imports/current`** returns the open draft's summary, or 404 when there is none. The summary holds the counts per status (Needs you, Finish unknown, Matched by name, Skipped and ready), the cards to add, the groups with their row counts and whether each is included, the left-out counts by reason, the "already in your Collection" count, the landing Location and `draft_revision`.
- **`GET /api/collection-imports/{id}/rows?filter=needs|finish|name|all|skipped&cursor=`** returns rows in pages of 100. Each row has its number, group, raw text, quantity, status, card, Edition, the card's Editions (for the finish picker), candidates and copies already held.
- **`POST /api/collection-imports/{id}/changes`** takes `{ draft_revision, changes: [...] }`. Each change is one of:
  - `{ rows | filter, pick: printing_id | edition_id }`;
  - `{ rows | filter, finish: <descriptor> }`, which applies only where the card has that Edition and reports the rows it couldn't apply to;
  - `{ rows | filter, skip | restore }`;
  - `{ group, include }`;
  - `{ location_id }`.

  A `filter` selector is what makes **Select all** and **Skip all N** one call. A stale `draft_revision` returns 409 `STALE_DRAFT`, and the screen reloads.
- **`GET /api/collection-imports/{id}/skipped.csv`** and **`/left-out.csv`** return those rows in the file's own header and columns. A paste comes back as the pasted lines.
- **`POST /api/collection-imports/{id}/save`** takes `{ draft_revision, idempotency_key }`.

### Saving

- **One transaction.** It adds one Holding increment per resolved Card Edition to the landing Storage Leaf and advances the owner revision once. It isn't a batch through `MAX_BATCH_EDITIONS`, which stays at 200 for the other add paths.
- **Checks before writing.** Saving is refused with 409 `REVIEW_CHANGED`, and the review reloads, in three cases:
  - Needs-you rows remain (422 `ROWS_NEED_YOU`);
  - the landing Location is no longer the collector's Storage Leaf;
  - an Edition became inactive since the catalog revision the draft was matched against. Those rows return to Needs you.
- **Saving twice is impossible, since there's no undo.** A repeated `idempotency_key` replays the first result. Saving a draft that is already saved returns that result again and writes nothing.
- **No undo** (owner): the result carries no undo id. Saved copies are ordinary Holdings.

### Load and abuse bounds

- **The gateway:** the start route alone accepts bodies up to 5 MB, and nginx's `client_max_body_size` is raised for that location only. Every other route keeps its limit, and decklist import's routes keep 64 KiB.
- **Zip files:**
  - exactly one entry, with a permitted extension;
  - no encryption and no nesting;
  - it's read as a stream and stops at 5 MB uncompressed, which guards against zip bombs.
- **Decoding:** UTF-8 (a BOM is dropped), falling back to Windows-1252.
- **Rate limit:** at most 20 drafts started per collector per day (429 `IMPORT_RATE_LIMITED`). Changes and saves are bounded by the draft, so they need no separate limit.
- **Catalog pulls:** imports never start one.

### Prices

- **The review shows no prices.** It reads no quotes and isn't a price access ([ADR 0006](../../../../adr/0006-access-triggered-price-refresh.md)).
- **After saving,** the new cards are priced as any others are: Collection tiles request prices only near the viewport ([ADR 0013](../../../../adr/0013-import-pricing-seeds-the-price-cache.md)). An import never queues a refresh per row.

### Scope ADR

[ADR 0014](../../../../adr/0014-collection-import-in-scope.md) records the owner's reversal of the MVP spec's import exclusion, and the boundaries this map drew around it.
