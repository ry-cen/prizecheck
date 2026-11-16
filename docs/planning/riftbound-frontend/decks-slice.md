# Riftbound Decks WP1 (#663, fixture-only)

Reference: frozen Pokémon M9 `0d22c23cea23277a1a43d86efadc60043c8ff99c`, saved PNGs only. This slice does **not** satisfy #663's real-API acceptance criteria. Contracts in `web/src/games/riftbound/decks.ts` are provisional game-owned seams. No backend, auth, network, storage, production composition, runtime registry or Pokémon Deck module is introduced.

## Verified core versus fixtures

All cited code was re-read in the accepted stack at `4360fbfc`.

| Verified core fact | Fixture implementation |
| --- | --- |
| Deck is a Location of kind deck (`migrations/core/000_baseline.sql:519`, kind constraint `:531`); a Deck cannot parent Locations (`api/app/location_tree.py:168`). | Deck nodes share Collection's owner-scoped store; they are holding leaves, never parent-picker choices. |
| Deck List header (`000_baseline.sql:228`), exact Edition line PK `(owner_id, deck_id, edition_id)` (`:1797`), revision starts at 1 (`:231`); header trigger (`:1133`, `:2845`). | Separate headers/revisions and exact Edition totals. No target_format field is simulated. |
| Quantities are decimal strings, positive per-line (`api/app/core/decks/store.py:20`); batch zero removes (`:98`). Batch validation and normalized replay (`api/app/games/pokemon/decks/routes.py:273`). | Small safe-integer numbers, new-total batches; zero deletes, same normalized batch/key replays once and reuse refuses. No lossless HTTP conversion claim. |
| List writes leave Holdings and inventory revision alone (`store.py:98`); revision mismatch (`:84`), advancement (`:147`). | Only listRevision advances per batch. Holding changes are visible on fresh Deck reads. |
| No persisted section/group columns (`000_baseline.sql:228`); Pokémon grouping is presentation (`web/src/games/pokemon/deckGroups.ts`). | Flat exact-Edition Deck List. No invented game groups. |
| Ownership per exact Edition (`api/app/core/decks/ownership.py:151`): min(list, physical held), min(remaining, outside), then lent, then remainder. | `ownership()` mirrors this formula with no Loans or Borrowed Copies; lent is zero. Lent copies must never be classified as not owned by a future adapter. Sheet reads actual per-Location Holdings separately. |
| Delete confirms cleaned name and version, replays before Deck lookup, merges owned Holdings into root Unsorted, then deletes (`api/app/deck_deletion.py:46`, `:65`, `:89`). | Name/version confirmation, owner-scoped successful replay, merge with updated Holding versions and owner revision. UNSORTED_UNAVAILABLE and overflow are typed conflicts. No Loan promises simulated. UI requires exact typed name. |
| Create root Deck, cleaned/check name/replay (`api/app/games/pokemon/decks/routes.py:29`); rename shared Location editing (`:46`, `core/decks/store.py:11`). | Root creation, casefold sibling uniqueness and versioned rename. |
| Only **new** batch lines require active Editions (`api/app/games/pokemon/decks/routes.py:273`, especially `new` construction and availability check). | Accepted brief correction: an existing retained-Edition line can increase **or** decrease. Once removed, it cannot be re-created by an explicit Deck List command (EDITION_UNAVAILABLE). Owned Holding arrivals are a separate core operation, described below. Tests cover both directions and refusal after removal. |
| Move leaf destinations include Decks (`api/app/inventory_core.py:145`; `core/inventory/moves.py:236`). | WP2 Move accepts Deck destinations and updates the shared Holdings store. WP3 parent pickers continue excluding Decks. |
| LocationNav suppresses Add child for deck (`web/src/workspace/LocationNav.tsx:173`); row text is just name (`:235`), no special Deck marker. | Reuse unchanged tree presentation, no invented marker. Gear opens only “Manage this Deck from Decks.” Ordinary management picker excludes Decks. |
| Pokémon auto-cover prefers Pokémon cards (`api/app/games/pokemon/decks/routes.py:76`). | Neutral placeholder; no cover selection or automatic policy. |

## Gates and omissions

Each stays outside this slice:

- Riftbound Deck shape and routes (#534 / owner).
- Core target_format default, which only allows standard/expanded/glc.
- Sections, groups, counts, eligibility and targets (rules owner); no target such as /60.
- Legality and readiness, formats.
- Prices, “to complete”, Buy missing.
- Publishing, Discover, Published Decks.
- Want List, Pick List, Gather, Put away.
- Printing-only add, which needs Printing→Edition selection.
- Import, export, Replace list.
- Cover policy.
- Deck List Undo: inverse-batch behavior **is grounded** in `api/app/games/pokemon/decks/routes.py:273` and `web/src/decks/useDeckListEdits.ts:147`, but omitted as an explicit WP1 scope boundary; no inventory Undo is reused.
- Lent presentation.
- Spread/List view switching (M9 presentation omitted in WP1).

## Composition and edit lifecycle

Local entry provides `?decks=decks-empty|decks-failure|decks-slow|deck-stale`; `?owner=b` has distinct data with colliding Deck/Edition/Location ids. The Collection scenario remains independently selectable. Data is memory-only. Keys include game and owner. Deck summaries show the Deck List total as “N cards in this Deck”, with no target.

Index reads pause in the editor and refetch on return. An idle editor accepts a refreshed detail read; an in-flight or pending write retains its own state until resolved. Hashes carry section=decks, deck id and deckTab=deck|library. Back/Forward restores tab and Deck, with heading focus. Library uses the existing CatalogReader for exact Editions. Copy sheet uses neutral Dialog/Button primitives and per-Location holdings. List writes serialize per editor; clicks during a write coalesce into the next absolute-total batch at the returned revision. Transient failures retain payload/key. Stale reload uses Pokémon wording. If every pending Edition still has its baseline quantity, its pending absolute total is retained for an explicit retry at the new revision and a new key. If any changed, pending totals are discarded and review is required. Unmount aborts and guards late completions, with no success toast. No collector-facing diagnostic IDs or source metadata appear.

WP3 correction: if automatic Location reload after refusal fails, show “Unable to save this change” instead of claiming the list refreshed (`web/src/games/riftbound/LocationWrites.tsx`, refusal catch).

## Test limits

Unit tests exercise exact Edition totals/zero deletion, independent revisions, stale rejection, replay/reuse, retained availability, ownership math, Unsorted merge, owner isolation, queued coalescing and late completion suppression. Browser tests exercise responsive fixture journeys and assert no /api or /auth calls and unchanged Pokémon preference sentinel. These cannot prove real routes, authentication/authorization, transactional durability, database locking or live catalog availability. No real-API acceptance, backend suite or hosted full/sharded suite is claimed. Actual commands, counts, run IDs, screenshots and failures belong in the reply-only implementation report.

Reference correction: supplied `j6-phone-builder.png` actually depicts “Trade Proposal to sam”, not a Deck builder. It was inspected read-only and not mirrored. `j4-phone-library.png` supplies the Library reference instead.

Validation order mirrors core: names are cleaned before replay (`api/app/location_tree.py:318`, `api/app/deck_deletion.py:67`); batch shape/duplicate/quantity validation precedes owner lock, replay and list revision (`api/app/games/pokemon/decks/routes.py:250`). Unit assertions cover invalid batches combined with stale revisions.


## Core arrival-coverage correction

Re-reading `migrations/core/000_baseline.sql:1143` (`deck_list_cover`), `:1218` (`deck_list_cover_holdings`) and the holding statement triggers at `:2813` and `:2817` established the inverse direction that the initial brief omitted: incoming Holdings can extend a Deck List. Departures never shrink it. With no Borrowed Copies, an arrival sets `max(listed, min(listed, held_before) + added)`. Filling an already-covered line leaves its revision unchanged; surplus cuts are preserved rather than listing every pre-existing physical copy. Insert and update transition-trigger phases each advance a growing Deck once, so a mixed upsert can advance it twice. This is generic core storage behavior, not a Riftbound construction count or target.

`local/deckListFixtures.ts` shares headers through the owner-scoped Collection store identity. Collection Add, Move and ordinary Inventory Undo invoke the coverage rule. Replay applies no arrival twice. A retained owned Edition may therefore acquire a new line through a physical Move, even though an explicit new Deck List line is refused by the active-catalog check. Inventory Undo restores Holdings through a single upsert (`api/app/core/inventory/moves.py:409`); Put away's returns-as-surplus exception remains outside this slice. No Deck List Undo UI or new Undo record is added.

Inventory revision changes refetch Deck reads without changing the same-Deck read key, so an idle editor updates ownership after the existing global Inventory Undo action. Pending list intent stays owned by its write queue. Unit cases cover mixed insert/update arrivals, replay and owner isolation, covered lines, surplus cuts, retained Editions and Inventory Undo. The browser journey moves an actual Collection copy into an empty Deck, then verifies its In this Deck count and the ownership refresh after Undo.

Copy sheets and command dialogs close when history changes the editor tab. Removing a line at zero clears its opener state and focuses the Deck heading, preserving all Holdings. Browser coverage checks Back/Forward with a sheet open and removal of the retained line without a phantom sheet reopening.


Decks WP1 review omissions:

- Surplus presentation is omitted: core computes owned copies held beyond the list with `beyond_list` (`api/app/core/decks/ownership.py:129`). These copies remain visible in Collection, including after a line is removed at zero; WP1's Deck tab only displays listed Editions.
- Competition warning (“Other Decks count the same spare copies”, M9 `j4-phone-deck.png`) is omitted. Core compares other Decks' counted copies with spare copies (`api/app/core/decks/ownership.py:180-186`). WP1 makes no exclusive allocation claim and adds no competition UI.
