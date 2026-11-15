# Riftbound fixture Collection (#662 WP1)

The WP1 baseline below describes the original local read-only prototype. WP2, documented later on this page, supersedes the no-writer statements with simulated fixture writes. Neither slice satisfies the real-API acceptance criteria for #662. The dev-server entry under `web/src/games/riftbound/local/` explicitly supplies both fixture readers. Production Rollup inputs exclude it; the bundle checker must continue rejecting Riftbound modules. No HTTP, auth, network, persistence or writer adapter is introduced.

## Verified core facts and provisional contracts

Paths below describe the checked-out dependency, not a promised Riftbound HTTP API.

| Verified shared-core fact (file:line) | Provisional fixture contract |
| --- | --- |
| One fungible Holding per owner, Location and Edition: `migrations/core/000_baseline.sql:310`, primary key at `:1830`; quantity and version are positive. | `collection.ts` HoldingRow retains an Edition snapshot, locationId, positive safe-integer quantity and version. Owner belongs to the reader. |
| Core Holding quantities are decimal strings: `api/app/core/inventory/holdings.py:68`; Add also uses strings at `:33`. | Fixture numbers are deliberately small; a live adapter must handle decimal quantities without loss. |
| Add requires an owned node of kind storage_leaf or deck (`api/app/core/inventory/holdings.py:123`), and explicitly rejects children with NOT EXISTS at `:125`. | Only storage_leaf nodes hold rows; folders only disclose their children. |
| Core kinds include storage_leaf, organization and deck: `migrations/core/000_baseline.sql:531`. | TreeNode from location_generated; only storage_leaf and organization, no Deck. Hidden and for-trade are false, lent/borrowed counts zero. |
| First-owner reads create root Unsorted: `api/app/core/inventory/locations.py:30` and `:32`, `api/app/location_tree.py:130` and `:133`. | Each fixture has root Unsorted, including the empty scenario. No Location commands or rename policy are implemented. |
| The commands increment, transfer or remove quantities; there is no setter: `api/app/core/inventory/holdings.py:101`, `api/app/core/inventory/moves.py:161`, `:177`. | No writer. |
| Single Add returns no Undo: `api/app/core/inventory/holdings.py:37`; batch Add has an undo_id at `:63`. | No Add or Undo control. |
| Owner revision serializes inventory mutations: `api/app/core/inventory/holdings.py:106`, `migrations/core/000_baseline.sql:342`. | Fixture version is 1; no concurrency or revision protocol is simulated. |
| Same idempotency key/digest replays the stored result; a different digest is refused: `api/app/core/inventory/holdings.py:110`. | No command or replay simulation. |
| Only Pokémon routers are mounted: `api/app/main.py:12`, `:40`. | No Riftbound HTTP route or generated client is assumed. |
| D4 facet shape is undecided: `api/tests/test_riftbound_shared_readers.py:165`. | No Collection facets; supplied domain/type appear only in details. |
| The core read carries a descriptor: `api/app/core/inventory/holdings.py:77`; fixture finish is game-owned in `web/src/games/riftbound/catalog.ts:13`. | Fixture Edition.finish is a supplied display string; a real adapter must map the descriptor. |
| Core reads page Holdings: `api/app/core/inventory/collection.py:264`. | Prototype pages 24 copy tiles. Each page row adds `copies: { first, count }`, a zero-based range. HoldingRow.quantity always remains the true quantity, even across pages. Inspector reads exact owner/Edition Holdings separately. This is provisional fixture paging, not a backend paging promise. |

## Composition and behavior

Use `npm run dev:riftbound` and open `/src/games/riftbound/local/index.html`. Catalog keeps `?scenario=empty|failure|detail-failure|slow`. Collection uses `?collection=empty|failure|slow`, and `?owner=b` supplies a distinct Collection with deliberately overlapping Edition and Location IDs. Failures never switch to a fallback reader. The failure scenario independently fails the first tree and list reads; each Retry recovers. Timers accept AbortSignal.

All owned, leaf Locations, empty Locations, substring name/number search and fixed Name A–Z/set/number ordering use synthetic fixtures. A retained Edition comes directly from its Holding snapshot, without a Catalog lookup. Two finishes of one Printing stay separate. A Holding expands locally into one CopyTile per visible copy, with the Location caption. Desktop selection opens an inspector; phone selection opens a sheet. Selection toggles one expanded copy tile and is local, owner/view keyed; the inspector still reads the whole Edition distribution. It is cleared by Location/search/page changes. Catalog and Collection remain mounted across section changes; neither section throws away the other's query or read result.

`#riftbound:` history carries section, Catalog query/detail and Collection location/search/page. Search replaces; Location and page changes push. Old Catalog hashes retain their prior interpretation. Read keys include game, operation, owner and query fields. useRead protects both keyed rendering and effect lifetime against late responses, including readers that ignore abort. Owner-change tests prove that reads and selection are rekeyed, including clamping page 2 for a smaller Collection; they do not claim to prove a React remount. Tree and list reads pause while Collection is inactive and retain same-key values while refetching on return. Out-of-range page responses replace history with the last valid page and are never displayed as empty Locations. No localStorage or sessionStorage is used: there are no persisted filters in this prototype and no approved cross-game preference contract. Pokémon preference bytes are untouched.

The shared LocationNav and locationTree were checked before reuse: imports are React, lucide, neutral UI and the generated location type (and their own tree helper). No runtime Pokémon, price, Loan or social module imports occur. Optional management, lent, borrowed and drop props are absent. Organization disclosure only expands/collapses children, matching LocationNav and Workspace. Organization-level listing is omitted: Pokémon does not make it reachable through this tree. Fixtures therefore list leaves or All owned only.

## Scope and sequence

WP1 implements read-only Collection and Locations with local fixtures and responsive navigation. WP2 adds Add/Move/Remove/Undo after their contracts are approved. Create/rename Locations follow, then #661 and live #662 after authenticated game-specific APIs, then #663 Decks. No shared shell, Pokémon route, generated client or preference file changes are needed for this prototype.

## Test limits

Unit tests cover copy expansion and split-page ranges, leaf navigation, search, totals/paging, owner collisions, retained Editions, empty Collection versus empty Location, retry/abort, backward-compatible hashes and superseded reads. The focused browser spec checks both viewports, keyboard/focus, drawer/sheet/inspector, history, state scenarios and absence of API/auth calls, and attaches desktop inspector, phone Collection and phone drawer screenshots. These are fixture UI tests, not backend, authentication, command, owner authorization, revision or idempotency proof. No live-data, full API, deployment or real-API acceptance is claimed. Actual verification results belong in the implementation handoff; unrun checks are not passes.

Review round 1 aligns the heading and lowercase pluralized totals on one baseline row, uses Small tile tokens, caps search at 420 px, and keeps the desktop inspector below the header with its own bounded scroll. Inspector finish is labelled “Variant”; a divider separates Edition facts from per-Location quantities. The phone Locations opener has space before the heading.

## WP2: provisional simulated writes

WP2 remains fixture-only. `CollectionWriter` is a game-owned provisional contract, not verified Riftbound HTTP shapes. #534 owns real authenticated Collection/Holdings/Locations/move/removal/undo routes, authorization, revisions and idempotency. This does not satisfy #662's real-API criteria. Production composition still excludes Riftbound; no API, auth, network or storage adapter is supplied.

All core citations below were re-read in the WP2 checkout. Fixture quantities remain small safe-integer numbers, unlike core decimal-string quantities. Overflow comparisons use the core signed-bigint maximum (`api/app/inventory_core.py:12`) with BigInt; fixtures do not claim lossless HTTP quantity conversion.

| Verified shared-core semantics (file:line) | Simulated fixture behavior |
| --- | --- |
| Single Add input/result: `api/app/core/inventory/holdings.py:30`, `:37`; incrementing upsert `:142`, `:144`. No Undo is written by this handler. | Add increments an exact Edition in a leaf, returns resulting quantity/version/ownerRevision, and shows no Undo. There is no quantity setter. |
| Batch Add has its own result with Undo `api/app/core/inventory/holdings.py:56`; Move/remove entry points `api/app/core/inventory/moves.py:161`, `:177`. | Batch Add is not implemented. Single-copy Move/Remove only; no multi-select. Commit-without-undo (`:168`) and Put away (`:237`) are omitted. |
| Stale before insufficient quantity: `api/app/core/inventory/moves.py:251`; deletion at zero and revision-version updates `:279`; destination increment `:288`. | Reject stale expectedVersion, insufficient quantity and same Location; mutate once under the single-threaded in-memory command, bump revision by one and version changed Holdings with it. Zero removes the Holding. |
| Owner serialization and replay `api/app/core/inventory/holdings.py:106`, `:110`; digest mismatch `:117`; Move replay `api/app/core/inventory/moves.py:205`. | Owner-scoped reader/writer store and successful-result map. Same key/payload replays; differing payload refuses. Failed commands never become successful replays. No durable recovery or 24-hour key retention is claimed. |
| Undo replay precedes record lookup `api/app/core/inventory/moves.py:336` (replay at `:342`); missing `:350`, expired `:352`, newest-only `:353`. | Same ordered checks: replay/key reuse, not found, expiry, not newest, then compatibility. |
| Undo source/destination leaves `api/app/core/inventory/moves.py:367`; restoration overflow `:376`; destination has every arrival `:382` (shortage at `:394`), all in `:336–400`. | Only these conditions produce UNDO_INCOMPATIBLE. A changed Holding version alone does not prevent Undo. Removal has no destination check. Tests directly edit the tree for otherwise UI-unreachable non-leaf cases, and dismiss a newer removal to expose a move destination shortage. |
| Undo restores/decrements quantities with new revision/version `api/app/core/inventory/moves.py:396`, `:398`, `:409`, consumes record `:422`. | Restore copies, increment revision, version changed Holdings, consume record. The success toast says “Undone”. |
| Ten-minute expiry `migrations/core/000_baseline.sql:357`; newest five, pruning `api/app/inventory_core.py:32`; list `api/app/core/inventory/moves.py:320`. Dismiss `:328` deletes a record without bumping inventory revision. | Injectable clock, newest ≤5 unexpired list, keep five records; dismissal consumes without changing inventory revision. |
| Promises are Loans/Trades: `api/app/inventory_core.py:54`; removal invokes them `api/app/core/inventory/moves.py:276`. | Promises and PROMISED_TO_* errors are omitted. Location create/rename/delete is deferred to WP3. |
| Only Pokémon routers are composed `api/app/main.py:12`, `:40`. | HTTP contract and game routing remain unverified for Riftbound; no runtime registry or cross-game imports. |

The local composition adds `?collection=write-failure|write-slow|stale`. Failure rejects once, slow delays writes, stale rejects the first Move/Remove. Add uses a leaf picker and Stepper (1–99), freezes its payload after submission and reuses the key on failure. A synchronous submission guard prevents repeated clicks or Enter from applying twice. A confirmed write rekeys Collection reads by owner revision. An unmounted dialog ignores late success/failure even if a writer ignores abort, matching `read.ts`'s cleanup guard. Owner changes remount the composition. Navigation removes an action dialog; no stale result can report success in the new view.

Move/Remove use a local single-copy bar with neutral Menu/Button and the same actions in phone details. Stale leaves the action dialog open; “Reload and retry” reads the current Holding version without reopening details. Undo errors say “This Undo is no longer available.” or “Cards changed since then, so this can't be undone.” Single Add has no Undo. No InventoryDialogs, SelectionBar, galleryModel or useInventoryActions is imported.

### #663 Decks: planning prerequisites only

Issue #663 remains gated on #534's approved game-owned Deck shape, minimal read/write operations/models and section/grouping policy, after the shell, real-read and Collection slices. Historical Legend/Chosen Champion/main/rune/Battlefield/sideboard counts and eligibility need verification. Legality/publication readiness cannot be invented. Want List and Pick List need actual backend semantics and tests before exposure. Game/user isolation, stale/repeated edits, failed saves, navigation and responsive keyboard flows need verification against the approved API. No Deck implementation is included here.

Command and selection lifecycle: Dismiss mirrors the core non-idempotent DELETE (`api/app/core/inventory/moves.py:328–333`): it accepts only a signal, records no replay, and a second dismissal returns UNDO_NOT_FOUND (treated by the UI as already dismissed). Undo retains its original key and payload after transient failure or a lost response, and only the terminal Undo errors remove its retry action. Its lifetime belongs to the owner/writer and survives Location/page navigation. Late completions update/dismiss only the toast ID they created. Add derives its default from the loaded tree's top-level Unsorted leaf, otherwise its first leaf, and remains disabled without a valid leaf. Cancel/Escape preserve copy selection and return focus to Actions; only confirmed writes clear it. The local floating selection pill includes Edition/Location counts and reserves inspector space.
