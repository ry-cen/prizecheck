# Resolution — Import contract

**Owner confirmed:** 2026-10-14

**Ticket:** [Decide the import contract](https://github.com/ry-cen/prizecheck/issues/203)

**Builds on:**
- [the import and Want List behaviour](decide-import-and-want-list-behaviour.md);
- [the import review step](prototype-import-review.md);
- [the Want List contract](decide-want-list-contract.md);
- the research on [decklist text formats](../research/decklist-text-formats.md) and [set-code mapping](../research/set-code-mapping.md).

The owner settled the collector-facing choices. The plumbing below was decided from the code on `dev` at `2435ed8`, as the owner delegated:
- `decks.py`: the create and Deck List changes routes;
- `deck_list_printing.py`: add-by-Printing;
- `catalog_browse.py` and `set_codes.py`: catalog search;
- `publications.py`: Published Deck snapshots;
- `deck_ownership.py` and `missing_cards.py`.

## Owner decisions

1. **Use cards I own follows the Want List counting setting.** It draws only on the copies that the Want List's allocation would count for this Deck:
   - **Every Deck built at once** (the default): this Deck's own copies, then Spare Copies left after older Decks have counted theirs. A new Deck is the newest, so it gets the spares no existing Deck counts.
   - **One Deck at a time:** any copy outside this Deck, including copies sleeved in other Decks. The review notes these ("1 in Charizard ex").

   The review therefore never promises a card that the Want List, the builder's "to complete" or Buy missing then counts for another Deck.
2. **Exact printings uses owned copies of the named Printing, in any Edition,** on a new Deck as on a replaced one. It draws from the same available copies, and only the rest of the line gets the cheapest priced Edition. The two settings differ in one way only:
   - **Exact printings** never reaches another Printing.
   - **Use cards I own** reaches the other Printings in the Reprint Group.
3. **`PH` is ignored when choosing.** Copies you don't own get the cheapest priced Edition, like any other line. The pasted text still shows `PH`, and **Edition** on the line can switch to Reverse Holo.
4. **Nothing in a paste sets the Target Format, and nothing is inferred.** This clears the fog item on format headers: no paste format carries a Standard or Expanded marker, and section headers are section breaks only.
   - **A pasted list** starts on Standard, the default every Deck has. The paste screen's control can change it.
   - **Copy to my Decks** starts on the Published Deck's Target Format, which the snapshot carries.
   - **A mismatch** is flagged by the builder's advisory format check.
5. **A failed code falls back to the name.** When a line's code and number find nothing:
   - **One card:** if the name names exactly one Reprint Group, the line resolves as **Matched by name** and is listed under **Changed**, not **Needs you**.
   - **Several cards:** **Pick one**.
   - **No card:** **Not found**.

   A line with no set code at all stays **Can't read** ([the import review step](prototype-import-review.md)).

## Parsing

- **On the server.** Parsing lives in one pure Python module, `api/app/decklist_text.py`. It is tested against the nine research fixtures. The browser sends the text and draws the server's reading, so the alias table and the name rules live in one place.
- **Normalising first:**
  - LF, CRLF and CR line endings;
  - a leading BOM;
  - NBSP and zero-width spaces;
  - trailing spaces;
  - NFC normalisation;
  - `’` read as `'`;
  - `Pokemon:` read as `Pokémon:`;
  - an optional `* ` bullet.

  TCG Online's empty-set Energy line (`Water Energy  12`, two spaces) is recognised *before* repeated spaces collapse.
- **Line kinds:**
  - **header:** `Pokémon`, `Trainer`, `Trainer Cards`, `Energy` or `Energie`, with `:` or `-` and a number. It starts a section; its number is never used.
  - **ignored:** `Total Cards`, `Karten insgesamt` and `******` lines, and any line that doesn't start with a quantity.
  - **card:** quantity, name, set token, number and an optional `PH`, parsed from the right as the research describes. The set token may be `[A-Z0-9]{2,8}` with an optional `-[A-Z0-9]{2,4}`, or `Energy` after a name ending in Energy.
  - **Can't read:** a line that starts with a quantity but has no set token and number.
- **Totals** are worked out from the lines.
- **Limits:**
  - **Text:** at most 20,000 characters (422 `IMPORT_TOO_LONG`).
  - **Card lines:** at most 200 (422 `IMPORT_TOO_MANY_LINES`), matching `MAX_DECK_LIST_CHANGES`.

## Matching order

Each card line is matched in this order. The first step that answers wins.

1. **Code and number.**
   - **The code** is looked up first in `set_codes.tsv` (`sets_for_code`), then in the import alias table.
   - **The number** is compared with catalog search's `NUMBER_KEY`, after the alias table's number rules.
   - **Result:** one active Printing matches. No case in the research resolved to several Printings.
   - **No name cross-check.** The research found the 112 name mismatches after a code match were naming conventions: `◇`, "LV.X", subtitles, "Basic Grass Energy". A cross-check would only flag correct lines.
2. **Basic Energy by type.** This applies when the name is a Basic Energy (`Basic {P} Energy`, `Psychic Energy`, `Basic Psychic Energy`) and step 1 found nothing: `SVALT`, the `Energy N` pseudo-set, `MEE 9`–`16` before TCGdex has them, or the empty set code.
   - **The default Printing** is that type's Basic Energy Printing in the newest Basic Energy set the catalog holds (by release date).
   - **Its Edition** comes from the allocation below.
3. **Name, when step 1 failed.** Names are compared with migration 048's `catalog_search_words` normalisation (letters and digits only, no accents or punctuation). A Printing's parenthetical subtitle is optional, so `Boss's Orders` matches "Boss's Orders (Giovanni)". Counting the distinct effective Reprint Groups (`catalog_reprint_group_effective`) among active matching Printings:
   - **One group:** **Matched by name**, on the group's newest Printing by set release date.
   - **Several groups:** **Pick one**. The candidates are one per group, each its newest Printing.
   - **None:** **Not found**.
4. **No code:** **Can't read**. Name matching never runs for these lines.

### The import alias table

- **A separate file.** It is a checked-in `api/app/import_aliases.tsv`, separate from `set_codes.tsv`. The display table keeps its two-source rule. The alias table records *pasted* forms, and each row cites its evidence: Limitless's formatter code, or the research.
- **Rows:**
  - `PR-SV` and `SVP` → `svp`;
  - `PR-SW` and `SP` → `swshp`, with the number prefix `SWSH`;
  - `SMP` → `smp` (`SM`), `XYP` → `xyp` (`XY`), `BWP` and `PR-BLW` → `bwp` (`BW`), `HSP` → HGSS promos (`HGSS`), `DPP` → DP promos (`DP`), and `PR-SM` → `smp` (`SM`, for TCG Online pastes);
  - `SVE` → `sve` and `MEE` → `mee`;
  - `CEL` with a `CC` number → `cel25cc`.
- **Rules in code,** each with a fixture test:
  - the `<code>-TG|GG|RC <n>` split back to a prefixed number;
  - the `SHF` and `HIF` flat-number offsets (73 and 69) back to `SVnn`.
- **Never exported.** Nothing reads the table for exports, Format Standing or public records, and it doesn't feed `LiveRulesV1.SET_CODES`.
- **No rows for ALT codes.** `SVALT` and `SWSHALT` name no printed card, so those lines fall through to Basic Energy or to the name.

## Allocation and Edition choice

- **One function.** Allocation goes through the Want List's shared allocation function (owner decision 1), so the import, the Want List, "to complete" and Buy missing count the same copies.
- **Paste order.** Pasted lines are allocated in order, drawing on one shared pool, so two lines never count one copy twice.
- **Owned copies, in order:**
  - **Exact printings:**
    1. this Deck's copies of the named Printing (Replace only);
    2. available copies of the named Printing elsewhere.
  - **Use cards I own:** those two steps, then:
    3. this Deck's copies of other Printings in the Reprint Group;
    4. available copies of those Printings elsewhere.
- **Several owned Editions at one step.** The Edition with the most available copies goes first, then catalog order (`descriptor_key, id`). This keeps the Deck List to as few lines as it can.
- **The rest of the line** gets add-by-Printing's rule (`deck_list_printing.choose_edition`):
  - the cheapest stored quote among the named Printing's active Editions;
  - otherwise, the first Edition in catalog order. A Printing whose only Edition is the Unspecified Variant gets that Edition this way.

  `PH` changes nothing. For Copy to my Decks under Exact printings, the rest keeps the snapshot's Edition instead (see below).
- **Lines merge.** Parts naming the same Edition, from any pasted lines, merge into one Deck List line (ADR 0009).
- **Stored quotes only.** Like add-by-Printing, the review reads stored quotes and is not a price access (ADR 0006): it admits no refresh and waits for no runner. Cards to get carry their stored cost with Pricing Coverage. An unpriced copy is reported separately, never as $0.

## Copy to my Decks

- **The input** is the publication token, not text. A revoked or missing publication answers 404, as the public read does.
- **Each snapshot row** is one review line, with its quantity:
  - its `edition_ref` (the Edition's `public_ref`) resolves to an active Edition;
  - otherwise, its `printing_ref` resolves to an active Printing, whose Edition comes from the allocation;
  - otherwise, the line is **Not found**, showing the row's name, set and number.
- **Under Exact printings,** the copies you don't own keep the snapshot's Edition. Owned copies of the named Printing still come first (owner decision 2).
- **Under Use cards I own,** the allocation is as above.
- **Defaults:** the name is the Published Deck's title and the Target Format is the snapshot's. Copy only creates a new Deck ([the import review step](prototype-import-review.md)).

## Interfaces

### `POST /api/decks/import/review`

Read-only, with no idempotency key. It is a POST only because the text is too long for a query string.

- **Body:**
  - `source`: either `{ "text": "…" }` or `{ "publication": "<token>" }`;
  - `owned`: `exact` or `owned`;
  - `deck_id`: the Deck being replaced, if any;
  - `fixes`: the collector's choices so far, each `{ "line": n }` plus one of `"drop": true`, `"printing_id"` or `"edition_id"`.
- **Stateless.** The review screen posts again when the setting changes or a line is fixed. The server keeps nothing between calls.
- **Capture.** It reads one consistent capture under the owner row lock, as `GET /api/want-list` does. Its work grows with the pasted lines and the Holdings of the Reprint Groups they name, not with the whole Collection.
- **Returns:**
  - **`lines`,** each with:
    - the line number, the raw text and the section;
    - the quantity;
    - the status: `matched`, `by_name`, `energy`, `picked`, `ambiguous`, `not_found`, `unreadable` or `dropped`;
    - the Printing, and candidates when ambiguous;
    - the parts: Edition, quantity, source (`in_deck`, `elsewhere` or `new`) and Location names, plus `chosen_by` for new copies;
    - notes on copies kept for other Decks.
  - **`ignored`:** the ignored lines.
  - **`deck_list`:** the merged Editions and quantities that saving would write.
  - **`surplus`,** for Replace: the Deck's held copies the new list doesn't cover.
  - **`totals`:** cards, cards owned, and cards to get with their cost and Pricing Coverage.
  - **The counting setting used.**
  - **`owner_revision`, `catalog_revision`** and, for Replace, the Deck List `revision`.
- **Quantities** are base-10 strings, as elsewhere.

### `POST /api/decks/import` (a new Deck)

- **Body:** `{ name, target_format, lines: [{ edition_id, quantity }], idempotency_key }`, with at most 200 lines.
- **One transaction.** It creates the Deck (the existing trigger creates its Deck List), sets the Target Format and writes the lines, with no window in which an empty Deck exists.
- **Checks:**
  - the name, as Create Deck checks it;
  - every Edition is active, of a Printing that isn't withdrawn (422 `EDITION_UNAVAILABLE`);
  - no Edition appears twice (422 `DUPLICATE_EDITION`).
- **Returns** the new Location node with the Deck List command result: the Deck List, the Target Format and its format result.
- **Idempotency.** The idempotency key replays through `location_command`, as every Location and Deck List command does.
- **Undo** is the existing Deck deletion. An imported Deck holds no cards, so nothing moves.

### Replace

- **The route.** Replace is the existing `POST /api/decks/{id}/deck-list/changes` batch, at the Deck List `revision` the review returned. The batch carries:
  - every Edition of the new list at its new total;
  - `0` for every current line not on it.
- **A stale review.** `STALE_DECK_LIST` means the Deck List changed after the review, so the screen runs the review again.
- **Undo** is the inverse batch, as the builder's Undo already works.
- **No Holding moves.** Surplus is derived from Holdings beyond the Deck List, so the copies the review listed under **Will become Surplus** show up in the builder's Surplus group with **Put away all**.
- **The 200 cap** applies to new lines plus removed lines. A 60-card Deck replaced by another stays well under it.

### What saving trusts

- **The resolved Editions.** Saving sends the Editions the review resolved, never the text, and the server doesn't resolve again. What the collector checked is what is written.
- **The Collection is not checked.** A Holding change between the review and Save can make a "you own" note stale. The Deck List is still valid, because a Deck List never counts toward the Collection and nothing is moved, so no inventory revision is checked.

### Missing cards and the setting

- **Missing cards.** "Report … on Missing cards" opens the existing report form with the kind set to Printing, the English name, the pasted set code as the set, and the number filled in. The line stays unresolved until it is picked or dropped.
- **The owned-cards setting** is remembered per device, like other display preferences. It starts on **Use cards I own** ([the import review step](prototype-import-review.md)).

## Changes to earlier decisions

- **[The import review step](prototype-import-review.md):**
  - Exact printings uses owned copies of the named Printing from anywhere available, not only the replaced Deck's;
  - spare copies follow the counting setting rather than being Spare Copies only.
- **[The import and Want List behaviour](decide-import-and-want-list-behaviour.md):** **Exact printings** is the named Printing in any owned Edition first, then the cheapest priced Edition. **Use cards I own** draws on the copies the counting setting makes available.
