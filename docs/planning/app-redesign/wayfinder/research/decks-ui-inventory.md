# Research — What the Decks UI must present

**Ticket:** [Inventory what the Decks UI must present](https://github.com/ry-cen/prizecheck/issues/124)

**Gathered:** 2026-10-12, on `feature/app-redesign` at `6507500`

**Sources:**
- the [Deck Lists and format validation spec](../../../deck-format-validation/spec.md), cited as "story N" below;
- the routes in `api/app/decks.py`, `deck_*.py`, `publications.py` and `published_*.py`;
- the clients in `web/src/decks_generated.ts`, `format_checks_generated.ts`, `publications_generated.ts`, `mass_entry_generated.ts` and `prices_generated.ts`;
- today's `web/src/Decks.tsx` and `web/src/workspace/DeckHeading.tsx`.

The owner wants all of the Deck List spec presented. This is the checklist for [Prototype the Deck experience](https://github.com/ry-cen/prizecheck/issues/125) and the spec.

## Summary

- **Every route the Deck List spec needs exists and has a generated web client.** No web code calls any of them yet:
  - Deck List edits;
  - add by Printing;
  - Pick List and confirm;
  - format checks;
  - owned publications and publication commands by token;
  - Deck deletion.
- **Today's UI still describes the Deck's Holdings, not its Deck List.** Decks shows the Holdings-based basic checks and the legacy single cost figure. The export panels use the Holdings checks for their "not 60 cards" note, even though both exports now read the Deck List. The Mass Entry client defaults to the whole Deck List, against the spec's not-owned default (story 66).
- **Three backend gaps block a complete UI.** They are listed under [Backend gaps](#backend-gaps-the-spec-must-close).

## 1. Deck List editing

| What | Route and client | Request, response and states |
| --- | --- | --- |
| Read the Deck, Deck List, ownership, surplus and competition | `GET /api/decks/{id}`, `getDeck` | `DeckDetail`:<br>• `deck` (TreeNode)<br>• `checks`, the basic checks over Holdings<br>• `deck_list_checks`, the same checks over the Deck List<br>• `deck_list {revision, lines[{edition_id, quantity, in_deck}]}`<br>• `ownership[]`, `surplus[]`, `competition[]`<br>• `owner_revision`, `catalog_revision` |
| Add a line by Edition | `POST …/deck-list/lines`, `addDeckListLine` | `{edition_id, quantity, revision, idempotency_key}` → `DeckListCommandResult {deck_id, deck_list, format_checks}`. Errors: `STALE_DECK_LIST` 409, `DECK_LIST_LINE_EXISTS` 409, `EDITION_UNAVAILABLE` 422, `DECK_NOT_FOUND` 404, a bad quantity 422 |
| Add a line by Printing, with the cheapest Edition chosen (stories 3–6) | `POST …/deck-list/printings`, `addDeckListPrinting` | Same result plus `edition_id` and `chosen_by: cheapest_price \| catalog_order`. The UI should say which rule chose the Edition (story 5). Errors: `PRINTING_UNAVAILABLE` 422, `PRICES_UNAVAILABLE` 503, `DECK_LIST_LINE_EXISTS` 409, `STALE_DECK_LIST` 409 |
| Change a quantity | `PATCH …/deck-list/lines/{edition_id}`, `changeDeckListLine` | `{quantity, revision, idempotency_key}`. `DECK_LIST_LINE_NOT_FOUND` 404, `STALE_DECK_LIST` 409 |
| Remove a line | `DELETE …/deck-list/lines/{edition_id}`, `removeDeckListLine` | `{revision, idempotency_key}`. Same errors |
| Basic checks over the list (stories 32–34) | `deck_list_checks` in `DeckDetail` | `total`, `shortage`, `excess`, `size_status` and per-identity `status`, each one of `within_limit`, `over_limit`, `basic_energy_exempt` or `unresolved`. The disclaimer now points to format checks |

Each command is idempotent by key and checked against the Deck List `revision`. A retry with the same key replays the stored response. Every edit returns fresh `format_checks` in the same response (story 37), so the UI never needs a second read after an edit. Editing never moves cards (story 24). Cutting a line below `in_deck` creates surplus (story 25).

Finding a card that isn't owned uses Catalog search: `GET /api/catalog/search` returns Printings with their Editions. The add flow is Catalog search, then add by Printing or by a chosen Edition. Where that search sits (in Decks or in Catalog's "add to Deck") is for the prototype to decide.

## 2. Ownership states, surplus and competition

From `DeckDetail`. Everything is computed from current Holdings on every read (story 14).

- `ownership[]` has one entry per line: `{edition_id, quantity, in_deck, elsewhere, not_owned, locations[{location_id, name, kind, quantity}]}`. `kind` tells loose storage (`storage_leaf`) from another `deck`. A location's `quantity` is every copy held there, not just the copies this line needs. These cover stories 11–13.
- `surplus[]` is `{edition_id, quantity}`: copies the Deck holds beyond its list (story 26).
- `competition[]` is `{edition_id, spare, counted_elsewhere, decks[{deck_id, name, in_deck, elsewhere}]}`: several Decks counting the same spare copies (story 15).

## 3. Pick List and put-away

| What | Route and client | Shape and states |
| --- | --- | --- |
| Read | `GET …/pick-list`, `getPickList` | `PickList`:<br>• `deck_list_revision`, `owner_revision`<br>• `rows[{edition_id, quantity` (copies to fetch)`, in_deck, elsewhere, not_owned, sources[…]}]`<br>• `put_away[{edition_id, quantity, version}]`<br>• `competition[]`<br>Each source is `{location_id, name, kind, available, committed, version, suggested, warning}`, and a warning is `{deck_id, name, short_by}` |
| Confirm one row, a selection, or all (stories 19–21) | `POST …/pick-list/confirm`, `confirmPicks` | `{items[{source_id, edition_id, quantity, expected_version}], deck_list_revision, idempotency_key}`, with at most 5 distinct sources per confirmation → `{edition_count, copy_count, owner_revision}`. Each source becomes one ordinary Move with its own Undo record |

- Sources come in suggestion order: loose storage first, then fewest Locations, then other Decks. A source with `suggested` > 0 is the default (stories 16–18). Choosing a different source means sending a different `source_id` (story 19).
- A source in another Deck carries a `warning` saying how short taking from it leaves that Deck (story 18). The UI must show it before the collector confirms.
- **Confirm errors:**
  - `TOO_MANY_PICK_SOURCES` 422 (more than 5 sources);
  - `DUPLICATE_MOVE_ITEM` 422;
  - `EDITION_NOT_ON_DECK_LIST` 422;
  - `SAME_LOCATION` 409;
  - `LOCATION_NOT_FOUND` 404;
  - `STALE_HOLDING` 409 and `INSUFFICIENT_QUANTITY` 409, each naming `source_id` and `edition_id`;
  - `QUANTITY_OVERFLOW` 409;
  - `STALE_DECK_LIST` 409;
  - `IDEMPOTENCY_KEY_REUSED` 409 and `REPLAY_OUTCOME_UNAVAILABLE` 409;
  - `INVENTORY_TEMPORARILY_UNAVAILABLE` 503.
- **"Confirm all" over more than 5 sources** has to be split into batches of at most 5, or the UI has to say why it can't confirm everything at once. The UI decides which.
- **Put-away** (story 27) is an ordinary Move out of the Deck. The UI sends `put_away[].version` as the Holding version through the Move manifest routes (`/api/moves/manifests`, then commit), to a Location the collector picks. Collection's existing Move flow can carry it.

## 4. Format checks

| What | Route and client | Shape |
| --- | --- | --- |
| All three formats, one format, or as of a date | `GET …/format-checks?format=&as_of=YYYY-MM-DD`, `getDeckFormatChecks(deckId, {format, asOf})` | `DeckFormatChecks`:<br>• `deck_list_revision`, `attribute_revision`, `catalog_revision`<br>• `results[]`, one per format: `{format, status: legal \| not_legal \| unknown, issues[], rules_version, evaluated_on, notes[], computed_at}`<br>• `disclaimer`<br>Errors: `INVALID_AS_OF` 422, `UNKNOWN_FORMAT` 422, `DECK_NOT_FOUND` 404 |

- The formats are `standard`, `expanded` and `glc` (Gym Leader Challenge). Each issue is `{code, reason, kind: deck | card, effect: not_legal | unknown, lines[edition_id]}`. `lines` ties an issue to Deck List lines (story 41). Deck issues and card issues are shown separately (story 42).
- **Codes that make a format `not_legal`:**
  - `deck_size`, `no_basic_pokemon`, `not_in_card_pool`, `copy_limit`;
  - `ace_spec_limit`, `radiant_limit`, `prism_star_limit`;
  - `banned`;
  - `single_type`, `exclusive_cards`, `rule_box_not_allowed`, `ace_spec_not_allowed`.
- **Codes that make a format `unknown`:**
  - `set_date_not_recorded`, `regulation_mark_not_recorded`, `regulation_mark_not_in_rules`;
  - `attribute_unknown`, `rules_fact_unsettled`;
  - `before_rules_coverage`, `reprint_legality_unknown`.
- `reason` is plain language from the server, so the UI can show it as is and use `code` only for grouping or icons.
- A future `as_of` adds a note that later rules are unknown (story 57). The UI must show `notes[]`, `rules_version` (story 58) and the advisory `disclaimer`. Results never block anything.
- Saved results are reused while they still apply (stories 59–60). The UI doesn't have to manage this.

## 5. Cost and exports

- **Cost:** `GET …/cost`, `getDeckCost`. The response still carries the legacy top-level figure, the Deck's own Holdings: `status`, `reason`, `total_copies`, `priced_copies`, `stale_copies`, `unknown_age_copies`, `fallback_copies`, `amount`, `display_amount`. It also carries `deck_list_revision` and two Deck List figures, each with the same fields:
  - `deck_list_cost`, every line (story 61);
  - `cost_to_complete`, not-owned lines only, `empty` ($0.00) when nothing needs buying (stories 62–64).
- Cost `status` is one of `priced`, `empty`, `no_quotes` or `incomplete`. An incomplete cost has a `reason`: `deadline`, `store_unavailable`, `validation_unavailable` or `inventory_unavailable`. `DeckCostSummary` and `CostSection` today show only the legacy figure.
- **Pokémon TCG Live:** `GET …/exports/live` and `live.txt`. The view is `{status: ok | blocked | empty, text, inline, byte_length, total_copies, blockers[{edition_id, name, set_name, collector_number, descriptor, quantity, reason}], owner_revision, deck_list_revision, catalog_revision}`. It reads the whole Deck List (story 65).
  - Download errors: `INVENTORY_CHANGED` 409, `DECK_LIST_CHANGED` 409, `DECK_EMPTY` 422, `LIVE_EXPORT_BLOCKED` 409.
- **TCGplayer Mass Entry:** `GET …/exports/tcgplayer?scope=not_owned|deck_list` and `.txt`. The view is `{status: link | text | empty, url, fallback_reason: missing_mapping | encoded_length | quantity_unsupported, text, inline, byte_length, lines[{quantity, text, less_specific}], line_count, less_specific_count, total_copies, scope, owner_revision, deck_list_revision, catalog_revision}`.
  - The API defaults to `not_owned` (story 66), with `deck_list` as the alternative (story 67). The web client `getMassEntryExport` defaults to `deck_list`, so the new UI must pass the scope and offer both.
  - Download errors: `INVENTORY_CHANGED`, `DECK_LIST_CHANGED`, `DECK_EMPTY` (deck_list scope) and `NOTHING_NOT_OWNED` (not_owned scope).

## 6. Publishing

| What | Route and client |
| --- | --- |
| This Deck's publication | `GET /api/decks/{id}/publication`, `getPublication` → `{token, version, title, visibility, projection_pending}`, with nulls when it isn't published |
| Publish, republish or revoke | `POST`, `PUT` or `DELETE /api/decks/{id}/publication`, via `publishDeck`, `republishDeck` or `revokeDeck`. Publish and republish take `{title (1–120), idempotency_key}` |
| Visibility (listed or unlisted) | `PATCH /api/decks/{id}/publication/visibility`, `setPublicationVisibility` |
| **Every active publication, including ones whose Deck was deleted** (stories 73–74) | `GET /api/publications`, `getOwnedPublications` → `[{token, version, title, visibility, deck_id \| null, projection_pending}]` |
| Revoke or change visibility by token, with or without a Deck | `DELETE /api/publications/{token}` and `PATCH /api/publications/{token}/visibility`, via `revokePublication` and `setPublishedDeckVisibility` |

- **Publish errors:**
  - `DECK_ALREADY_PUBLISHED` 409;
  - `DECK_NOT_PUBLISHED` 409 (republish, revoke or visibility with no active publication);
  - `PUBLICATION_REVOKED` 409 (by token);
  - `PUBLICATION_NOT_FOUND` 404 (bad, unknown or someone else's token);
  - `DECK_NOT_FOUND` 404;
  - `IDEMPOTENCY_KEY_REUSED` 409;
  - `PUBLICATION_UNAVAILABLE` 503, which means retry with the same key;
  - a 422 for a bad title.
- Publishing snapshots the Deck List, not the Holdings (story 68). The snapshot reveals no ownership or storage (story 69). A publication with no Deck can't be republished.
- Nothing in the UI lists publications today. A Published Deck whose Deck was deleted can only be managed through the by-token routes. The UI needs a home for that list. Where it goes (Decks, the avatar menu, or the Published Deck page when the owner is signed in) is for the prototype or [Decide the Published Deck and Discover pages](https://github.com/ry-cen/prizecheck/issues/127).

## 7. Deck lifecycle

- **Create:** `POST /api/decks`, `createDeck` `{name, idempotency_key}`. Today only the old Decks page creates Decks; Collection's Create Location dialog makes non-Deck Locations only. An empty Deck is valid (story 8).
- **Rename and move:** `PATCH /api/decks/{id}`, `editDeck`. Collection's Manage Locations does this today.
- **Delete** (stories 28–29): `DELETE /api/decks/{id}`, `deleteDeck` `{name (typed confirmation), version, idempotency_key}` → `{deleted_id, unsorted_id, edition_count, copy_count, owner_revision}`.
  - Errors: `LOCATION_NAME_CONFIRMATION_MISMATCH` 409, `STALE_LOCATION` 409, `UNSORTED_UNAVAILABLE` 409, `QUANTITY_OVERFLOW` 409, `DECK_NOT_FOUND` 404, `INVENTORY_TEMPORARILY_UNAVAILABLE` 503.
  - **Nothing in the web UI can delete a Deck.** Manage Locations shows "Decks can't be deleted here", and the old Decks page has no delete either.
  - The UI should say that the cards go to Unsorted, and that any Published Deck stays live.
- **Index:** `GET /api/decks?cursor=`, `getDecks`. Pages hold 30 Decks, sorted by name. `INVENTORY_CHANGED` 409 means restart, and `INVALID_CURSOR` 400.

## 8. What today's Decks page does

`web/src/Decks.tsx`, the `decks` view:

- **Create a Deck** by name. It retries safely with the same idempotency key, handles `LOCATION_NAME_CONFLICT`, and reports "may have completed" on a 5xx.
- **Deck index** with "More Decks" paging, a restart on `INVENTORY_CHANGED`, and an "Open in workspace" link per Deck.
- **Selected Deck:**
  - card count with the 60-card status (from the Holdings);
  - `DeckCostSummary`, the legacy Holdings cost;
  - four-copy check per identity, the disclaimer, and Refresh checks;
  - `Holdings`, the old leaf grid: name, set and number filters, sort, paging, Add cards, `MoveHoldings` with select, move, remove and undo;
  - `PublishDeck`: publish, republish, toggle visibility, revoke, a "View public snapshot" link, a projection-pending notice, and safe-retry messaging;
  - `DeckLiveExport` and `DeckMassEntryExport`, with "not 60 cards" notes from the Holdings checks.
- **Not shown:** Deck List, ownership, surplus, competition, Pick List, format checks, cost to complete, Mass Entry scope, owned publications, Deck deletion.

## 9. What Collection's Deck heading shows

`web/src/workspace/DeckHeading.tsx`, when a Deck is open in Collection:

- `DeckCostSummary`, the legacy Holdings cost.
- An **Export ▾** menu that opens the Live or Mass Entry panel in a dialog. It's disabled when the Deck has no cards, going by the Holdings `checks.total`.
- It re-reads the Deck when the gallery's owner revision moves ahead, and shows a retry on failure.
- The gallery below shows the Deck's **Holdings** as tiles, with Move, Remove and Undo.
- Rename and move happen in Manage Locations.
- **Not shown:** anything from the Deck List.

## Backend gaps the spec must close

1. **Deck List lines carry no card display data.** `deck_list.lines`, `ownership`, `surplus`, `competition`, `PickList.rows` and `put_away` give only `edition_id`, with no name, set, number, Variant or image. Cards held in the Deck can be matched to Collection's Holdings listing, but **not-owned lines have no route that turns an `edition_id` into display data.** Catalog detail is keyed by Printing ID (`GET /api/catalog/printings/{printing_id}`), and the line doesn't carry one. The Live export's `blockers` are the only deck response with names. The spec needs either display fields on these responses or a batch Edition lookup.
2. **No Deck deletion UI anywhere.** The route and client exist, so this is a UI gap, not a backend one. It's listed here because the old pages never offered it either.
3. **Client defaults that contradict the Deck List spec.**
   - `getMassEntryExport` and `massEntryDownloadHref` default `scope` to `deck_list`, where the spec says `not_owned`.
   - The Live and Mass Entry panels and `DeckHeading`'s "empty" test read the Holdings `checks`, not `deck_list_checks`. A Deck with a Deck List but no cards can't be exported from Collection today.
