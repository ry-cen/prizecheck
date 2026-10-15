# Research: copy allocation, Spare Copies and the Want List, and where Loans plug in

**Label:** wayfinder:research · **Ticket:** [#242](https://github.com/ry-cen/prizecheck/issues/242) · **Feeds:** [Decide the Loan inventory model (#236)](https://github.com/ry-cen/prizecheck/issues/236)

Codebase research done on 2026-10-15 against `feature/social-network` (HEAD `7752082`). Terms are those of [`CONTEXT.md`](../../../../../CONTEXT.md) and [Decide the social network behaviour](../resolutions/decide-social-behaviour.md). Line numbers are for that commit. This note doesn't pick a representation; #236 does.

## Summary

- A Holding is `(owner_id, location_id, edition_id) → quantity`. The owner of the copies and the owner of the Location are one column, and SQL enforces that (composite FK, leaf guard trigger, Deck List FKs). Nothing records who owns a copy apart from where it is.
- Each figure reads the Holdings of one owner: allocation, ownership states, Pick List, Want List, Swap hint, deck cost, the exports, Collection totals and the Location tree. "Owned" always means "a `holding` row with `owner_id = me`".
- Nothing is reserved today. `deck_ownership` says so in its docstring, and `copy_allocation` derives Spare Copies fresh on every read.
- There is no Collection value figure today. The nearest figures are the Collection copy totals and the Estimated Deck Cost of a Deck's Holdings.
- Published Deck snapshots, the Live export and published cost read only Deck List lines or the frozen snapshot. Loans don't affect them.
- The hardest cross-cutting facts for any Loan model:
  - every lock and revision is per owner;
  - Holding rows have no stable identity, because they are deleted at zero and re-inserted on arrival;
  - there is no RLS, so isolation is `owner_id = %s` in application SQL.

## 1. How it works today

### Holdings and the one-owner invariant

- Table: `migrations/006_add_holdings.sql:3-11`.
  - PK `(owner_id, location_id, edition_id)` (:9).
  - `quantity > 0` (:7). A zero Holding is deleted, never stored.
  - `version` is the owner revision at its last write (:8).
  - Composite FK `(owner_id, location_id) → location(owner_id, id)` (:10). A Holding can only sit in a Location of the same owner.
- `holding_leaf_guard` (`006_add_holdings.sql:24-38`) is a deferred constraint trigger. It requires `l.owner_id = NEW.owner_id` and a childless `storage_leaf` or `deck`.
- `location.kind` is `storage_leaf`, `organization` or `deck` (`001_inventory.sql:10`). A Deck is a Location, and Unsorted is unique per owner (`001_inventory.sql:14`).
- Deck Lists: `deck_list` and `deck_list_line` (`029_deck_lists.sql:7-22`) are keyed and FK'd by `(owner_id, deck_id)` (:12, :21). A Deck List line names one Edition and has no link to Holdings.
- **Copies follow into the Deck List.** `deck_list_cover_holdings` adds to or raises a Deck's line whenever a statement raises a Holding in that Deck, to `greatest(listed, least(listed, before) + added)`.
  - The rule is in `031_deck_list_follows_moves.sql:1-13`.
  - The live body is `047_put_away_undo_returns_surplus.sql:20+`. It is 039's EXECUTE form plus a `tcg.undo_returns_surplus` early return at :23-25.
  - Every join in it is owner-scoped (`d.owner_id = n.owner_id`).
  - Triggers: `031:69-74`.
- **Owner row lock and revision.** `location_tree.owner_and_rows` (`api/app/location_tree.py:79-85`) creates the owner if needed and takes `inventory_owner ... FOR UPDATE`. Every Holding, Deck List and settings writer takes it, and so does every consistent reader.
  - Each inventory write advances `inventory_owner.revision`, for example `moves.py:347`.
  - Clients pin figures to that revision.
- **No RLS.** No migration has `CREATE POLICY` or `ROW LEVEL SECURITY`. Isolation is `verified_user` (`api/app/main.py:69`) plus `WHERE owner_id=%s` in every query. Reading a Friend's Collection would be the first cross-owner read.

### Copy allocation (`api/app/copy_allocation.py`)

- `allocate` (:121-172) runs three range reads under the caller's owner lock:
  - the owner's Holdings of the given Editions (:129);
  - the owner's Deck List lines naming them (:134);
  - those Decks' `created_at` (:137).
- **The Spare Copy rule** is at :147-149.
  - `own[deck] = min(line quantity, Deck's Holding)`.
  - `spare_copies = total − Σ own`. That total is every copy wherever it is: loose copies, plus copies a Deck holds beyond its line or without a line.
- **Counting setting** (`inventory_owner.want_list_counting`, `049_want_list_counting.sql:12-24`):
  - `all_at_once` (Every Deck built at once): Spare Copies are handed to short Decks oldest first (`_hand_out` :110-118, :155-156).
  - `one_at_a_time` (One Deck at a time): each Deck counts Spare Copies, then other Decks' own copies (:157-169).
- `LineCount.need` (:75-78) is the copies a line "still needs from outside the Collection". `Allocation.owned` (:89) is every copy of the Edition. `places` (:91) is copies by Location.
- `deck_lines` (:175-187) runs it for one Deck. It allocates only the lines the Deck is short of.
- `available_to` (:226-274) gives the copies the setting makes available to one Deck, or to a new Deck. The order is loose Locations first, then other Decks' copies beyond their lines (:244-246, :254-255).
  - Callers: Decklist Import's owned pool (`import_owned.py:92` → `import_allocation.py`), which also covers Copy to my Decks, and Replace (`import_replace.py`).
  - Decklist Import itself writes only Deck List lines. `deck_import.py` has no `holding` SQL.

### Deck ownership states, Surplus and Gather (`api/app/deck_ownership.py`, `deck_pick_list.py`)

- `read_ownership` (`deck_ownership.py:108-179`) splits each line into `in_deck`, `elsewhere` and `not_owned`, regardless of the counting setting.
  - `elsewhere` is every copy in another Location of the owner (:132-135).
- `beyond_list` (:94-98) gives Surplus: a Deck's copies beyond its line, or all of them for an Edition with no line.
- `competition` (:159-176) warns when short Decks count the same copies. Its own spare figure is at :173.
- **Pick List and Gather:**
  - `GET /api/decks/{id}/pick-list` (`deck_pick_list.py:152-205`) reads `read_ownership`, then each source's `committed = least(h.quantity, line)` (:166-172).
  - `suggest` (:128-150) takes copies from loose Storage Leaves first, then other Decks' Surplus, then other Decks' own copies, with a warning.
  - Confirm (:208-300) is a multi-source Move into the Deck. It deletes or decrements the sources (:270-277), inserts the arrivals (:280-285), writes one Undo record, and the trigger covers the arrivals.
- **Put away** has no route. It is an ordinary Move out of the Deck with `put_away=true` (`moves.py:47-50`, :289-290), and its Undo returns the copies as Surplus (migration 047).

### Want List and Swap hint (`api/app/want_list.py`, `swap_hints.py`)

- `capture_want_list` (`want_list.py:155-183`) takes the owner lock, reads the setting, Deck order and Deck List revisions, and runs `allocate` over every listed Edition (:176).
- Sections show lines with `need > 0` (:137-140). `combined` (:186-196) sums the needs, or takes the largest need under One Deck at a time.
- The answer is pinned to `owner_revision`, `settings_revision` and `deck_lists_digest` (:105-112). The Mass Entry export of it (`want_list_mass_entry.py`) refuses with 409 `INVENTORY_CHANGED` when they move.
- `swap_hints.available` (`swap_hints.py:138-145`) reuses `allocate`. It computes the Spare Copies again as `owned − Σ held` (:144).

### Estimated Deck Cost, exports, Collection figures

- `deck_list_capture.capture_deck_list` (`deck_list_capture.py:50-70`) captures the Deck's Holdings (:60-62) and `deck_lines` needs under the owner lock.
- `deck_cost.private_deck_cost` (`deck_cost.py:150-177`) produces three figures:
  - the top-level fields are the Estimated Deck Cost of the Deck's **Holdings** (`figures(held)`, :175);
  - `deck_list_cost` covers every line;
  - `cost_to_complete` covers `need` only (:165).
- Private exports:
  - Mass Entry `not_owned` (Buy missing) sends `need` (`deck_mass_entry.py` docstring);
  - `deck_list` scope sends every line;
  - the Live export sends the whole Deck List and leaves out Holdings beyond it (`deck_live_export.py` docstring).
- **Collection value does not exist.** Searching `api/app`, `web/src` and `docs` for collection value, total value and `collectionValue` finds nothing. The nearest figures are:
  - Collection totals of Holdings, Editions and copies (`collection.py:341-346`);
  - the Location tree's `copy_count` (`location_tree.py:170-171`).

  The resolution's "never count toward the borrower's Collection or its value" is a constraint on future work.

### Moves, Inventory Removal, Undo, deletion

- **Moves** use a staged manifest (`moves.py:165-215`), then `apply_selection` (:246-366).
  - It snapshots the involved Holdings (:292-294) and checks `expected_version` and quantity (:304-316).
  - It deletes rows that reach zero and decrements the rest (:330-335), then upserts at the destination (:336-342).
- **Inventory Removal** is the same path with no destination (`remove_inventory` :233-237; `action` `remove` at :249). Copies simply leave.
- **Undo** (:385-476, `undo_add` :478+) re-inserts copies at the recorded source Locations (:458-460) and takes them from the destination.
  - `inventory_undo.action` allows `move`, `remove` and `add` (`046_inventory_undo_add.sql:19-20`).
  - The payload names Location ids (`012_inventory_undo.sql:1-10`).
- **Other Holding writers:**
  - Add and batch add (`holdings.py:110-165`, :214-225);
  - Edition reassignment, which turns copies of one Edition into another in place (`catalog_reconciliation.py:190-235`);
  - Deck deletion, which moves every Holding to Unsorted (`deck_deletion.py:84-100`);
  - leaf conversion, which relocates a whole leaf's Holdings with `move_holdings` (`location_tree.py:134-136`, :202, :266).
- **Location deletion** refuses a Location with Holdings (`location_tree.py:298`).

### Published Deck snapshots

- `publications.snapshot` (`publications.py:174-198`) reads `deck_list_line` only, and its docstring says "never its Holdings".
- Published cost (`published_cost.py`) and the published exports read the frozen snapshot.
- Loans and Borrowed Copies **don't affect** publishing, except that the snapshot takes the publisher's owner lock (:181).

## 2. Every place that assumes a Holding's copies belong to its Location's owner

For each site: what it reads, then what a Loan model has to answer there. "Lent" means owned by the lender but physically with the borrower. "Reserved" means an accepted Loan not yet handed over. "Borrowed" means a Borrowed Copy in the borrower's Deck.

### SQL invariants

- **Holding owner equals Location owner** (`006_add_holdings.sql:9-10`).
  - Reads: composite PK and FK.
  - Loans: a Borrowed Copy can't be a lender-owned row in a borrower Location. If it's a borrower-owned row, it is "owned" everywhere below.
- **`holding_leaf_guard`** (`006:24-35`).
  - Reads: `l.owner_id = NEW.owner_id`.
  - Loans: same as above.
- **Deck List keys and FKs** (`029:12`, :21).
  - Reads: `(owner_id, deck_id)`.
  - Loans: a Borrowed Copy can fill only a line that belongs to the borrower. That is already fine if the copy lives on the borrower's side.
- **Deck List trigger** (`047:20+`, rule `031:9-13`).
  - Reads: owner-scoped joins on `holding` rises.
  - Loans: should a Borrowed Copy arriving in a Deck extend its Deck List? Should a lent copy leaving a Deck leave its line alone? Today Moves out of a Deck never lower a line.

### Allocation and its callers

- **`allocate`** (`copy_allocation.py:129`, :147-149).
  - Reads: every `holding` row of the owner per Edition.
  - Loans: are lent copies "owned" for `need`? Are reserved copies still Spare? Do Borrowed Copies count as `held` for the borrower's line?
- **`deck_lines`** (`copy_allocation.py:178-182`).
  - Reads: the Deck's Holdings, to pick short lines.
  - Loans: does a Deck holding Borrowed Copies count as short?
- **`available_to`** (`copy_allocation.py:233-271`).
  - Reads: `allocate.places`, then loose-first order.
  - Loans: can an import, Replace or Copy to my Decks take reserved or lent copies? Can a Borrowed Copy count as one Deck's "own" copy under Replace?
- **Swap hint** (`swap_hints.py:138-145`).
  - Reads: `owned − Σ held`.
  - Loans: should a lent copy of another Printing be offered as a Swap?
- **Want List** (`want_list.py:176`, :244).
  - Reads: `allocate`, and `owned` for "Your N are counted for other Decks".
  - Loans: the resolution says Borrowed Copies clear the Want List. Is a lent copy still "owned"?

### Deck reads

- **`read_ownership`** (`deck_ownership.py:120-135`).
  - Reads: the Deck's Holdings, then every other Location's Holdings.
  - Loans: is a Borrowed Copy `in_deck`? Is a lent copy `elsewhere`, a Location that can't be gathered from?
- **`beyond_list` / Surplus** (`deck_ownership.py:94-98`).
  - Reads: Holdings beyond the line.
  - Loans: can a Borrowed Copy be Surplus? It can't be put away into the borrower's Collection.
- **Competition spare** (`deck_ownership.py:162-176`).
  - Reads: `outside − claimed`.
  - Loans: reserved or lent copies may need to come out of it.
- **Pick List `committed` and sources** (`deck_pick_list.py:166-172`, :128-150).
  - Reads: every other Holding as a gatherable source.
  - Loans: a lent copy isn't physically there. Should a reserved copy be offered for Gather?
- **Pick confirm** (`deck_pick_list.py:262-285`).
  - Reads: decrements the source and inserts into the Deck.
  - Loans: can a lent or reserved copy be moved?
- **Deck index `in_deck`** (`decks.py:261-284`, :271).
  - Reads: the Deck's Holdings against its lines.
  - Loans: does the progress count Borrowed Copies?
- **`basic_checks` 'holdings'** (`decks.py:287-289`, :351).
  - Reads: the Deck's Holdings for the physical-card checks.
  - Loans: are Borrowed Copies part of the physical Deck? Physically, yes.
- **`deck_contents`** (`decks.py:559-587`).
  - Reads: the Deck's Holdings.
  - Loans: same question.
- **`import_replace.read_replaced`** (`import_replace.py:71`).
  - Reads: the Deck's Holdings, for Replace's Surplus preview.
  - Loans: what does Replace do with Borrowed Copies?

### Cost and exports

- **Deck cost, top-level fields** (`deck_cost.py:163`, :175; `deck_list_capture.py:60-62`).
  - Reads: Estimated Deck Cost of the Deck's Holdings.
  - Loans: does the cost include Borrowed Copies? The glossary says "physical Card Editions in a Deck".
- **`cost_to_complete` and Mass Entry `not_owned`** (`deck_cost.py:165`; `deck_mass_entry.py`).
  - Reads: `need`.
  - Loans: they follow whatever `allocate` decides.

### Collection and catalog figures

- **Collection listing and totals** (`collection.py:118`, :130, :162-169, :341-346).
  - Reads: every `holding` row of the owner.
  - Loans: lent copies are still in the lender's Collection; are they marked? Borrowed Copies must not count.
- **Location tree `copy_count`** (`location_tree.py:170-171`).
  - Reads: `sum(quantity)` per Location.
  - Loans: same question.
- **Catalog "owned" filter and counts** (`catalog_browse.py:360`, :410-413).
  - Reads: `EXISTS holding`, `sum(quantity)` and `in_deck`.
  - Loans: Borrowed Copies shouldn't count as owned, but `in_deck` might count them.

### Writers

- **Moves and Removal** (`moves.py:292-342`).
  - Reads: any Holding of the owner, checked by version and quantity.
  - Loans: can lent or reserved copies be moved or removed? A Borrowed Copy must not be removable as the borrower's own.
- **Undo** (`moves.py:385-476`).
  - Reads: re-inserts at recorded Locations.
  - Loans: Undo of a Move that touched copies since reserved or lent. A Write-off is an Inventory Removal; is it undoable, and by whom?
- **Deck deletion** (`deck_deletion.py:84-100`).
  - Reads: moves the Deck's Holdings to Unsorted.
  - Loans: Borrowed Copies in a deleted Deck can't go to the borrower's Unsorted as owned copies.
- **Leaf conversion** (`location_tree.py:134-136`).
  - Reads: `UPDATE holding SET location_id` for a whole leaf.
  - Loans: anything keyed by Location must follow.
- **Edition reassignment** (`catalog_reconciliation.py:216-234`).
  - Reads: changes the Edition of copies in place.
  - Loans: anything keyed by Edition must follow, or reassignment must refuse lent copies.
- **Location deletion and Unsorted rules** (`location_tree.py:247`, :298).
  - Reads: `has_holdings`.
  - Loans: a Location that holds only Borrowed Copies.

### Unaffected

- **Published Deck snapshot** (`publications.py:174-198`): reads Deck List lines only.
- **Live export and published cost:** read the Deck List or the snapshot.

### Where the Spare Copy rule is coded

Spare Copy and Surplus are computed in five places that #236 would have to keep in step:

- `copy_allocation.py:147-149`;
- `available_to` at :254;
- `deck_ownership.beyond_list` :94-98, and competition spare at :173;
- `swap_hints.py:144`;
- Pick List `committed` at `deck_pick_list.py:169`.

The rule doesn't depend on the counting setting. The resolution's spare or in-a-Deck label for a Friend's copy would read the Friend's Holdings and Deck Lists with this same rule.

## 3. Cross-cutting constraints

### Locks and revisions are per owner

Every consistent read and every write takes one owner's `inventory_owner FOR UPDATE` (`location_tree.py:81`, `holdings.py:116`, `publications.py:181`) and pins its answer to that owner's revision:

- the Want List and its export (`want_list.py:105-112`);
- the Deck cost `owner_revision` (`deck_cost.py:70`);
- Collection cursors (`collection.py:209-217`);
- the Pick List and Moves, through `expected_version`.

Some Loan steps change both sides' figures: accept, handover, return, Write-off, and the cancel that unfriending triggers. Any representation therefore has to:

- lock both owner rows in a fixed order, for example by `user_id`, to avoid deadlock;
- advance both revisions, or the borrower's pinned figures and exports go stale without a 409.

Lender-only steps change the borrower's figures too: a Write-off removes the Borrowed Copies. Steps one side takes alone change the other side's figures as well: accept and cancel change what the lender has Spare.

### Holding rows have no stable identity

A row is deleted when it reaches zero and re-inserted on arrival:

- `moves.py:330-342`;
- `deck_pick_list.py:270-285`;
- Undo at `moves.py:458`.

Its key can also change underneath:

- Deck deletion moves rows to Unsorted (`deck_deletion.py:95-100`);
- leaf conversion rewrites `location_id` (`location_tree.py:134-136`);
- reassignment rewrites the Edition (`catalog_reconciliation.py:225-234`).

So a foreign key from a Loan line to a `holding` row breaks on ordinary use. A sub-quantity column on `holding` must be carried through every one of these paths.

### Undo

Inventory Undo records Location ids and quantities (`012_inventory_undo.sql:1-10`) and re-inserts by key. A Loan step taken between a Move and its Undo can leave the Undo pointing at copies that are now reserved or lent. Each candidate below needs either an Undo refusal (`UNDO_INCOMPATIBLE`, the existing pattern) or Loan steps that never touch `holding`.

### Authorization

Every check is `verified_user` plus `owner_id=%s`. A Loan touches two owners, so its routes need an explicit Friend check, with Block and unfriend taken into account, before any cross-owner read or write. Today no SQL policy backstops a missing `owner_id` filter.

## 4. Candidate representations

Lent and reserved copies are a lender-side question. Borrowed Copies are a borrower-side question. The options below pair up: one from L, one from B. No winner is picked here.

### L1. `reserved` and `lent` sub-quantities on `holding`

Add `reserved bigint DEFAULT 0` and `lent bigint DEFAULT 0` to `holding`, with `CHECK (reserved + lent <= quantity)`.

**Touches:**

- migration 006's table, with a new migration;
- every Holding writer: Moves and Removal (`moves.py:330-342`), Pick confirm (`deck_pick_list.py:270-285`), Undo (`moves.py:446-460`), reassignment, Deck deletion and leaf conversion. Each must refuse to take reserved or lent copies, or carry the counts along;
- `allocate`, `read_ownership`, the Pick List, `swap_hints`, `available_to` and `beyond_list`, which must subtract reserved and lent copies wherever they mean "available";
- Collection views, which would show lent copies.

**Breaks or costs:**

- The PK is `(owner, location, edition)` (`006:9`), so the columns can't say *which* Loan or Friend holds the copies. A Loan table is still needed, and the two must stay in sync.
- A `DELETE ... WHERE quantity = moved` path would drop a row that still has reserved copies unless every writer checks first.
- Lent copies keep their Location, which matches "the lender still owns lent copies" and lets them return to the same place.

### L2. A Loan-line table, keyed by owner, Location and Edition

`loan_line(loan_id, lender_id, location_id, edition_id, quantity, state)`, with no FK to `holding`. A deferred constraint trigger, in the style of `holding_leaf_guard`, checks `Σ reserved+lent ≤ holding.quantity` per `(lender, location, edition)`.

**Touches:**

- a new table and trigger;
- every reader above, which joins in or subtracts the open Loan lines of the Editions it reads. The reads are already per-Edition range reads, so this is one more range read paired in memory, the codebase's existing pattern;
- Moves, Removal and Pick confirm, which must count Loan lines when they check `INSUFFICIENT_QUANTITY`. Otherwise the deferred trigger fails the commit;
- Deck deletion and leaf conversion, which must re-key the Loan lines' `location_id`. Reassignment must re-key `edition_id` or refuse.

**Breaks or costs:**

- Another table with Location-keyed rows to keep in step on relocation.
- Pinpoints Loan and Friend per copy.
- An FK to `holding` instead would break on the row lifecycle above.

### L3. Move lent copies to a system "Lent" Storage Leaf

At handover, Move the copies into a per-owner system Location, as Unsorted is (`001_inventory.sql:14`). Reserved copies stay where they are, under L1 or L2.

**Touches:**

- `owner_and_rows` or a migration, to create the leaf;
- Location tree and edit rules that protect it, as Unsorted is protected (`location_tree.py:246-248`);
- a record of each copy's original Location, for the return;
- `allocate`, `available_to`, the Pick List and `read_ownership`, which would treat the leaf as loose and count its copies as Spare unless they are excluded explicitly.

**Breaks or costs:**

- Lent copies would surface as ordinary Holdings in a Location, and Friends never see Location names anyway.
- Undo of a Move out of the Lent leaf would need to be blocked.
- Handover and return become inventory writes with Undo records, unless they are kept out of Undo.

### B1. A separate `borrowed_holding` table in the borrower's Storage Leaf

`borrowed_holding(borrower_id, location_id, edition_id, loan_id, quantity)`, FK'd to the borrower's Location, with no row in `holding`.

**Touches:**

- `allocate` and `deck_lines`, to add Borrowed Copies to `held` for the Deck that holds them;
- `read_ownership`, the Deck index, `basic_checks`, `deck_contents`, `deck_list_capture` and Deck cost, to union them in where "physical Deck" is meant;
- Gather and Put away, to decide whether Borrowed Copies can move between the borrower's Decks or Locations.

Collection, tree, catalog and Removal reads stay correct without change, because they never see Borrowed Copies.

**Breaks or costs:**

- The Deck List trigger (`047:20+`) won't fire for these rows. That is good if Borrowed Copies should only fill existing lines, but the Deck List won't grow by itself.
- Deck deletion (`deck_deletion.py:84-100`) must handle these rows, since they can't go to Unsorted as owned copies.
- Each Deck read takes a second range read.

### B2. Borrowed rows in `holding`, flagged by `loan_id`

Add a nullable `loan_id` to `holding`, so a Borrowed Copy is a borrower-owned row with the flag set.

**Touches:**

- the PK, which must take `loan_id` so a Borrowed and an owned Holding of one Edition can share a Location;
- every `holding WHERE owner_id=` read: Collection, tree, catalog, `allocate.owned`, Want List "owned", Removal and Moves. Each needs `loan_id IS NULL` where "Collection" is meant, and the opposite where "physical Deck" is meant.

**Breaks or costs:**

- This is the widest blast radius. Every existing read silently counts Borrowed Copies as the borrower's own until it is changed.
- The `047` trigger extends the borrower's Deck List on arrival, which is the existing rule for any copy entering a Deck.
- Moves and Undo by `(owner, location, edition)` collide with the new key.

### Pairings to note

- **L2 + B1** keeps `holding` meaning "copies this collector owns, where they are" and adds two parallel tables.
- **L1 + B2** keeps everything in `holding`, but changes its meaning and key.
- **L3** composes with either B option and uses existing Move machinery for handover.

## 5. Questions for #236

1. Can a reserved copy still be moved, gathered, removed or played in a Deck before handover?
2. When a lent copy leaves one of the lender's Decks, is that Deck's line short (on the Want List), or still counted as owned?
3. Is a lent copy a Spare Copy for the lender's other Decks under either counting setting? Is it offered by the Swap hint or Decklist Import?
4. Do Borrowed Copies only fill existing Deck List lines, or can they extend the list as copies moved in do today?
5. Can a Borrowed Copy be moved between the borrower's Decks or Locations, or put away as Surplus?
6. Does the Estimated Deck Cost of the borrower's Deck include Borrowed Copies?
7. On return, do the lender's copies go back to their original Location, to Unsorted, or somewhere the lender picks?
8. Is a Write-off undoable through Inventory Undo, and does it take one of the lender's five Undo records?
9. What happens to Borrowed Copies when the borrower deletes their Deck?
