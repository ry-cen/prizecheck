# Riftbound fixture Collection (#662 WP1)

This is a local read-only prototype, not the real-API acceptance criteria for #662. The dev-server entry under `web/src/games/riftbound/local/` explicitly supplies both fixture readers. Production Rollup inputs exclude it; the bundle checker must continue rejecting Riftbound modules. No HTTP, auth, network, persistence or writer adapter is introduced.

## Verified core facts and provisional contracts

Paths below describe the checked-out dependency, not a promised Riftbound HTTP API.

| Verified shared-core fact (file:line) | Provisional fixture contract |
| --- | --- |
| One fungible Holding per owner, Location and Edition: `migrations/core/000_baseline.sql:310`, primary key at `:1827`; quantity and version are positive. | `collection.ts` HoldingRow retains an Edition snapshot, locationId, positive safe-integer quantity and version. Owner belongs to the reader. |
| Core Holding quantities are decimal strings: `api/app/core/inventory/holdings.py:66`; Add also uses strings at `:30`. | Fixture numbers are deliberately small; a live adapter must handle decimal quantities without loss. |
| Holdings require a leaf with no children: `api/app/core/inventory/holdings.py:121`. | Only storage_leaf nodes hold rows; folders only disclose their children. |
| Core kinds include storage_leaf, organization and deck: `migrations/core/000_baseline.sql:520`. | TreeNode from location_generated; only storage_leaf and organization, no Deck. Hidden and for-trade are false, lent/borrowed counts zero. |
| Unsorted is created on read: `api/app/core/inventory/locations.py:25`, `api/app/location_tree.py:129`. | Each fixture has root Unsorted, including the empty scenario. No Location commands or rename policy are implemented. |
| The commands increment, transfer or remove quantities; there is no setter: `api/app/core/inventory/holdings.py:101`, `api/app/core/inventory/moves.py:161`, `:177`. | No writer. |
| Single Add returns no Undo: `api/app/core/inventory/holdings.py:37`; batch Add has an undo_id at `:63`. | No Add or Undo control. |
| Owner revision serializes inventory mutations: `api/app/core/inventory/holdings.py:106`, `migrations/core/000_baseline.sql:339`. | Fixture version is 1; no concurrency or revision protocol is simulated. |
| Same idempotency key/digest replays the stored result; a different digest is refused: `api/app/core/inventory/holdings.py:110`. | No command or replay simulation. |
| Only Pokémon routers are mounted: `api/app/main.py:12`, `:40`. | No Riftbound HTTP route or generated client is assumed. |
| D4 facet shape is undecided: `api/tests/test_riftbound_shared_readers.py:165`. | No Collection facets; supplied domain/type appear only in details. |
| The core read carries a descriptor: `api/app/core/inventory/holdings.py:77`; fixture finish is game-owned in `web/src/games/riftbound/catalog.ts:13`. | Fixture Edition.finish is a supplied display string; a real adapter must map the descriptor. |
| Core reads page Holdings: `api/app/core/inventory/collection.py:210`. | Prototype pages 24 copy tiles. Each page row adds `copies: { first, count }`, a zero-based range. HoldingRow.quantity always remains the true quantity, even across pages. Inspector reads exact owner/Edition Holdings separately. This is provisional fixture paging, not a backend paging promise. |

## Composition and behavior

Use `npm run dev:riftbound` and open `/src/games/riftbound/local/index.html`. Catalog keeps `?scenario=empty|failure|detail-failure|slow`. Collection uses `?collection=empty|failure|slow`, and `?owner=b` supplies a distinct Collection with deliberately overlapping Edition and Location IDs. Failures never switch to a fallback reader. The failure scenario independently fails the first tree and list reads; each Retry recovers. Timers accept AbortSignal.

All owned, leaf Locations, empty Locations, substring name/number search and fixed Name A–Z/set/number ordering use synthetic fixtures. A retained Edition comes directly from its Holding snapshot, without a Catalog lookup. Two finishes of one Printing stay separate. A Holding expands locally into one CopyTile per visible copy, with the Location caption. Desktop selection opens an inspector; phone selection opens a sheet. Selection is single, local, owner/view keyed and cleared by Location/search/page changes. Catalog and Collection remain mounted across section changes; neither section throws away the other's query or read result.

`#riftbound:` history carries section, Catalog query/detail and Collection location/search/page. Search replaces; Location and page changes push. Old Catalog hashes retain their prior interpretation. Read keys include game, operation, owner and query fields. useRead protects both keyed rendering and effect lifetime against late responses, including readers that ignore abort. Changing reader owner remounts the composition. No localStorage or sessionStorage is used: there are no persisted filters in this prototype and no approved cross-game preference contract. Pokémon preference bytes are untouched.

The shared LocationNav and locationTree were checked before reuse: imports are React, lucide, neutral UI and the generated location type (and their own tree helper). No runtime Pokémon, price, Loan or social module imports occur. Optional management, lent, borrowed and drop props are absent. Organization disclosure only expands/collapses children, matching LocationNav and Workspace. Organization-level listing is omitted: Pokémon does not make it reachable through this tree. Fixtures therefore list leaves or All owned only.

## Scope and sequence

WP1 implements read-only Collection and Locations with local fixtures and responsive navigation. WP2 adds Add/Move/Remove/Undo after their contracts are approved. Create/rename Locations follow, then #661 and live #662 after authenticated game-specific APIs, then #663 Decks. No shared shell, Pokémon route, generated client or preference file changes are needed for this prototype.

## Test limits

Unit tests cover copy expansion and split-page ranges, leaf navigation, search, totals/paging, owner collisions, retained Editions, empty Collection versus empty Location, retry/abort, backward-compatible hashes and superseded reads. The focused browser spec checks both viewports, keyboard/focus, drawer/sheet/inspector, history, state scenarios and absence of API/auth calls, and attaches desktop inspector, phone Collection and phone drawer screenshots. These are fixture UI tests, not backend, authentication, command, owner authorization, revision or idempotency proof. No live-data, full API, deployment or real-API acceptance is claimed. Actual verification results belong in the implementation handoff; unrun checks are not passes.
