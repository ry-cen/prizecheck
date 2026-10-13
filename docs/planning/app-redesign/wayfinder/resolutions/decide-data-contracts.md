# Resolution — Deck builder, Catalog and public data contracts

**Owner confirmed:** 2026-10-12

**Ticket:** [Decide the deck builder, Catalog and public data contracts](https://github.com/ry-cen/prizecheck/issues/138)

**Evidence:** `api/app/` on `dev` at `1f34e96` (`catalog_search.py`, `collection.py`, `decks.py`, `format_evaluator.py`, `deck_format_checks.py`, `holdings.py`, `moves.py`, `deck_pick_list.py`, `discovery.py`, `published_cost.py`, `public_catalog.py`), migrations 027 and 036, and the format rules files. Inputs: the "What the spec and backend need" sections of [the Deck experience](decide-deck-experience.md), [Catalog search](decide-catalog-search.md) and [Published Deck and Discover](decide-published-deck-and-discover.md) resolutions, and findings 1 and 2 of [the workspace reconciliation](../research/reconcile-workspace-tickets.md).

**Who decided what:** the owner decided the three collector-facing questions, marked **Owner's choice**. The owner delegated the technical contracts to Claude, so the rest is marked **Delegated**. A learning guide that explains the reasoning is kept outside the repo, in the owner's documents.

Route names and field names here are working names. The spec may rename them, but not change what they carry or the rules they enforce.

## Collector-facing decisions

### Format chips show unknown cards — Owner's choice

A format chip (Catalog, the deck builder's library, which starts on the Target Format) hides only cards whose **Format Standing** in that Format is `not_legal`. Cards whose standing is `unknown` stay in the results with a small "?" pill. The card popup gives the reason. The rules files list every older set as excluded, so unknown cards are mostly cards from a newly released set the rules don't list yet, cards with no recorded regulation mark, and a few cards whose rulings are unsettled. Hiding them would hide a new set during its first week. The publishing gate still requires a `legal` Deck List result, so an unknown card can't carry a deck onto Discover.

### Discover cost: partial totals get a plus — Owner's choice

A Discover card shows the cost read from cached prices only:
- **"$142"** when every priced copy has a cached quote;
- **"$118+"** when some don't, with a tooltip such as "3 cards not priced yet";
- **"Price on page"** (muted) when no copy has a cached quote.

Stale cached quotes count as priced. No price age is shown, as on Published Deck.

### Undo is one step, from the toast — Owner's choice

Each Undo toast undoes exactly the action it names. A new action replaces the toast, and Undo never reaches anything older. This matches Collection today. Deck List edits and inventory actions (Move, Remove, Add, Gather) never undo each other. Multi-step Undo in the deck builder could be added later without changing any contract here.

## Contracts — Delegated

### 1. One catalog browse route

`GET /api/catalog/editions` is a new route for signed-in users only. Catalog and the deck builder's library (All and Owned) both use it. `GET /api/catalog/search` stays for its existing callers until the spec retires it.

- **One row per Card Edition:** Edition id, Printing id, name, set id and name, collector number, Variant Descriptor (or Unspecified Variant), image URL, card kind, Trainer Type, evolves from, and its Format Standing in all three Formats (so the popup's pills need no second call).
- **Ownership merged in:** copies owned in total. When `deck_id` is given, also copies in that Deck and copies free elsewhere (owned and not in this Deck).
- **Query:** `q` is the smart search. A `q` that starts with a known set id followed by a number means set plus collector number; anything else is a name match. An empty `q` is allowed.
- **Filters:** `kind` (Pokémon, Supporter, Item, Tool, Stadium, Energy), `format` (hides `not_legal` only, as decided above), `set_id`, `owned` (only).
- **Paging:** keyset, 60 rows a page, with a signed cursor bound to the catalog revision, the owner revision and the standing key (section 2). A change returns 409 and the client starts again, as Collection does.
- **Where the copies are:** the popup keeps `GET /api/collection/editions/{edition_id}`. It's one Edition at a time, and the browse rows stay small.
- `GET /api/collection` (the per-Edition listing that the Deck experience resolution said to keep) is no longer needed by the builder. The spec decides when to remove it.

### 2. Stored Format Standing

Filtering by format on the server, with stable pages, needs the standing stored and indexed. Evaluating each page in Python would return short or empty pages.

- A table holds one row per Card Printing and Format, with its Format Standing (`legal`, `not_legal`, `unknown`). It's computed with the evaluator's own `line_standing` (Reprint Group legality and bans included) over the stored format facts.
- One key row per Format records what the standings were computed from: the rules file's sha256, the evaluator code's sha256, the attribute revision, the catalog revision, and the next rule date (`next_rule_date`). It's the same key as saved Deck results.
- When the key no longer matches (a rules commit, an attribute correction, a catalog import, or a rule date passing), the next reader rebuilds that Format's standings in bulk under an advisory lock while other readers wait. Catalog imports and attribute decisions may also rebuild eagerly. A full rebuild is a single pass over the catalog.
- A Card Edition's standing is its Card Printing's.
- Deck List format results are unchanged. They still run the whole-deck check.

### 3. One source for card type

- `catalog_card_attribute` (the effective attributes, which reviews correct) is the one source. Collection's category and type filters move onto it from `catalog_printing_metadata.category` and `elemental_types`. Those columns stay until a cleanup removes them.
- Attributes gain **Trainer Type** (`supporter`, `item`, `tool`, `stadium`, or null when unknown), derived from TCGdex `trainerType` and **correctable through the existing attribute review queue**, like card kind.
- Attributes gain **evolves from**, the name of the Pokémon this one evolves from, derived from TCGdex `evolveFrom`. It's used only to group Deck List lines by evolution line and is not reviewed: a wrong value only groups a card in the wrong place.
- A Trainer with no Trainer Type matches the Trainer type chips only through "Any". The tile shows no subtype.

### 4. Display data on Deck List lines

Every Deck List line in `GET /api/decks/{id}` and in every Deck List command response carries the line's display data: name, set, collector number, Variant Descriptor, image URL, card kind, Trainer Type, evolves from and Card Identity. Lines for cards the collector doesn't own render without a second lookup. There is no batch Edition lookup route.

### 5. One batch Deck List change command

- `POST /api/decks/{id}/deck-list/changes` takes `revision`, `idempotency_key` and `changes: [{edition_id, quantity}]`, where `quantity` is the line's new total and `0` removes it. It applies every change atomically, advances the Deck List revision once, and returns the usual Deck List command result.
- **Swap** is one batch (−1 on one Edition, +1 on another), so it undoes in one step.
- **Undo** sends the inverse batch (each touched line back to its old quantity) at the new revision. If the Deck List changed in between, the command returns `STALE_DECK_LIST` and the toast says "Can't undo: this deck changed".
- **Rapid ±1 taps:** the client sends one command at a time and merges taps queued behind it into the next batch, so taps never race the revision check.
- The per-line add, change and remove routes stay.

### 6. Batch add to one Location

- `POST /api/holdings/batch` takes `location_id`, `idempotency_key` and `items: [{edition_id, quantity}]`, up to 200 Editions. It adds them all in one transaction with one owner revision.
- It writes **one Undo record of a new `add` kind**: the target Location and the copies added, with no sources. Undoing it removes exactly those copies, only if the Location still holds all of them; otherwise `UNDO_INCOMPATIBLE`. The newest-only rule and the five-record limit are unchanged.
- Catalog's **Add N cards**, Collection's Add cards (which opens Catalog in Add mode) and the popup's single Add all use it. `POST /api/holdings` stays.

### 7. Gather writes one Undo record

The Pick List confirmation moves to the multi-source Move path (migration 026), as the code's own comment asks. It writes **one** multi-source Undo record per confirmation, and the five-source cap (`MAX_PICK_SOURCES`) goes. A Gather can no longer push Collection's Undo history out.

### 8. Target Format

- **Field:** `target_format` on the Deck List: `standard`, `expanded` or `glc`, not null, defaulting to `standard`. A migration sets existing Deck Lists to Standard. `PATCH /api/decks/{id}` accepts it, and a change advances the Deck List revision, because the saved result depends on it.
- **Reads:** `GET /api/decks/{id}` and Deck List command responses carry `target_format` and that Format's result only. `GET /api/decks/{id}/format-checks` defaults to the Target Format.
- **Publishing gate:** publish and republish recompute the Target Format result for today in the same transaction, and refuse anything but `legal` with `409 TARGET_FORMAT_NOT_LEGAL`, carrying the result so the UI can show the issues.
- **Snapshots** store their Target Format. Existing snapshots migrate to Standard.

### 9. Public routes

The privacy rule holds for every field below: no public route serves ownership or storage data. The browse route (section 1) is never public.

- **Published format checks:** `GET /api/public/decks/{token}/versions/{version}/format-checks` returns the snapshot's Target Format only.
- **Public cost:** the Published Deck cost response gains `editions: [{edition_ref, amount}]`, the per-copy amount or null, with no age. It goes through the existing price cache and admission caps; no new route.
- **Discover summaries** gain `target_format`, its result, and `cost: {amount, priced_copies, total_copies}` (amount null when nothing is priced). The client renders the three cost states above from these fields.
- **Discover filter:** `format=` (Standard, Expanded, GLC; absent means all).
- **Discover listing:** only Listed Published Decks whose snapshot is `legal` in its Target Format today. Each snapshot's result is cached by snapshot digest, rules sha256, evaluator code sha256, rule-date window and public format-fact revision, and recomputed when stale. A snapshot whose result can't be confirmed (store unavailable, deadline) is left out, never shown unchecked.
- **Cached-only cost:** Discover reads cached quotes only and never admits a refresh. Publish and republish start a background price refresh for the snapshot's Editions within the existing admission caps, so new listings are usually fully priced.

### 10. Gaps already closed on `dev`

From [the Decks UI inventory](../research/decks-ui-inventory.md):
- **Deleting a Deck:** `DELETE /api/decks/{id}` exists (`deck_deletion.py`). Only the UI is missing.
- **Export defaults:** the server's Mass Entry export already defaults to `not_owned`. Only the web clients' defaults need changing.
- **Line display data:** closed by section 4.

## Effect on the spec

- The app redesign spec carries every contract above. The [Deck Lists and format validation spec](../../../deck-format-validation/spec.md) is superseded where it says all three Formats are checked together and results never block publishing.
- New `CONTEXT.md` terms: **Format Standing** and **Trainer Type**.
- Rollout order (for example, Target Format and the publishing gate land before the Discover listing change) is for [Decide rollout and verification](https://github.com/ry-cen/prizecheck/issues/141).
