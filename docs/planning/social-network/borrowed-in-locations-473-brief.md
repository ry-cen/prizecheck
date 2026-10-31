# Borrowed Copies in the Collection's galleries, with a Borrowed mark, and the usual Move (#473)

Design brief for one implementation worker. Checkout `/home/t3/projects/prizecheck`, base `dev` @ 32b7d5c. Context
pack: `.scratch/ctx-bugs-swap-borrowed.md`, section "Bug D" ("pack §D" below). Line numbers are from 32b7d5c.

**Revision 2.** Owner decisions are folded in: a mixed Move moves everything with no Undo; borrowed tiles come after
owned ones; All owned **includes** Borrowed Copies. The advisor's review items 1–5 are addressed in §6.5, §5.4, §8.0,
§8 and §9.

## 1. Goal

The gallery shows the Borrowed Copies a collector holds, in the Location or Deck that holds them and in All owned.
Each is marked with its lender's name, and each moves with the gallery's usual Move (the dialog and drag and drop).
Storage and ownership stay separate: `borrowed_holding`, its own read and its own write route. Collection totals,
Spare Copies, Removal, Undo, the Trade List, Swap hints and every Friend view never see or count a Borrowed Copy.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Keep `borrowed_holding` and a dedicated write. Do not change `holding`, Undo, `GET /api/holdings/{id}`, `GET /api/collection` or the Location tree. `moves.py` changes in one way only. The dedicated `POST /api/moves/manifests/{manifest_id}/commit-without-undo` takes destination and idempotency key and atomically commits without writing an Undo record. The web client uses this route only for the owned stage of a Move that carries Borrowed Copies. Normal Move requests and fingerprints stay unchanged. This operation creates no Undo record; not a history barrier; an older Undo stays quantity-based. Removal, Put away and Undo itself are unchanged. | ADR 0014: single-owner reads stay correct unless they opt in. |
| D2 | A new owner-only **gallery projection**, `GET /api/collection/borrowed`, in a new module `api/app/borrowed_gallery.py`. It takes the query parameters of `GET /api/collection/holdings`, and `location_id` is optional: none means All owned. | The owned listing's paging, cursor and totals contract stays about ownership. The filters must match it exactly, so it reuses the listing's SQL fragments. |
| D3 | A new **batch write**, `POST /api/collection/borrowed/moves`, in the same module. It is all or nothing, advances the revision once, writes no Undo record and replays by key. It is written directly, not built by calling the singular route repeatedly. The singular `POST /api/loans/borrowed/move` stays unchanged for compatibility and for the Borrowed dialog. | The gallery moves many rows at once. The new routes stay out of `loan_inventory.py`, which #478 owns. |
| D4 | Borrowed tiles come **after** the collector's own tiles, in the gallery's sort among themselves, with no section heading. This holds in a Location view and in All owned. | Owner decision Q2. The gallery is one index-positioned grid, and a trailing run needs no layout change. |
| D5 | **All owned includes Borrowed Copies**, marked, after the owned tiles, with the Location caption that All owned already shows. The tree's Borrowed entry and its dialog stay. | Owner decision Q3. |
| D6 | **Counts.** Every owned figure stays owned-only: `totals`, `lent`, the tree's counts, the old `/api/collection` read and the Inspector's "copies owned". The heading adds a separate clause, "· N borrowed", in a Location view and in All owned. | "Never part of the Collection" now means never counted in it (§7). The clause explains why there are more tiles than the count. |
| D7 | Tile identity for a Borrowed Copy is **(Loan, Location, Card Edition)**, the unique key of `borrowed_holding`. The gallery key is `borrowed:${loan_id}:${location_id}:${edition_id}`. | It matches the write's row key, and it can't collide with an owned key. |
| D8 | **A mixed selection moves everything.** The Borrowed part goes to the batch route first, then the owned part through the general Move. A Move that includes any Borrowed Copy offers no Undo. | Owner decision Q1. |
| D9 | When the selection holds any Borrowed Copy, Actions lists only **Move…** and **Clear selection**, and the summary adds "· N borrowed". | Borrowed Copies are never removable or lendable. |
| D10 | **Drag and drop** carries Borrowed and owned copies together. It has the same valid targets (Storage Leaves and Decks, not folders) and runs the same operation as D8. | It is the same Move. |
| D11 | **The mark** is a pill at the bottom left of the art reading "From Ash K.". The tile's accessible name and title add "borrowed from Ash K.". The Inspector says "N borrowed from Ash K." in place of "N copies here". | AGENTS.md: names and counts only. It mirrors the Deck line's "1 from Ash K.". |
| D12 | The **Set filter** also offers the sets of the Borrowed Copies in view, in a Location view and in All owned. | A borrowed-only card stays reachable by filter. |
| D13 | A **snapshot token** names every revision a listing depends on: owner, catalog and card attribute. Both listings return it, and the client matches the owned walk and the borrowed read on it. | Review item 3: the cursor already binds the attribute revision (`collection.py:300-306`), but the response exposed only the catalog revision. |
| D14 | **A Move is one immutable operation record**, independent of the selection. It holds the carried items, both keys, the manifest and the state of each stage. An operation with an unknown outcome is resolved, by replaying with its keys, before anything else runs or is reported. | Review items 1 and 2. |

## 3. Acceptance criteria

1. `GET /api/collection/borrowed` returns the caller's `borrowed_holding` rows as `BorrowedGalleryPage` (§5.1): one
   Location's with `location_id`, all of them without. The search and filters of `/api/collection/holdings` apply,
   and rows come in that listing's sort, then by lender name (case-folded), then by Loan id. `total` is the sum of
   the listed quantities.
2. That route answers 404 `LOCATION_NOT_FOUND` for a Location that isn't the caller's, 409 `NOT_STORAGE_LEAF` for a
   folder, and 409 `TOO_MANY_BORROWED` past 2,000 rows (§5.1). Its `snapshot` equals that of `/api/collection/holdings`
   read with the same parameters at the same moment.
3. `/api/collection/holdings` gains only the additive `snapshot` field. Every other field, its order, totals, `lent`,
   revisions and cursor continuation match the golden fixture (§8.0) byte for byte, before and after the extraction
   and with Borrowed Copies present. `/api/holdings/{id}`, `/api/collection` and the Location tree are unchanged. The
   `holdings/{box} == []` assertion in `test_borrowed_copies.py` still passes, unchanged.
4. `/api/collection/sets` adds the sets of the Borrowed Copies in scope: that Location's, or all of them without
   `location_id`.
5. `POST /api/collection/borrowed/moves` moves every item or none to one of the caller's Storage Leaves or Decks. It
   advances the caller's revision exactly once, writes no Undo record, replays by `idempotency_key` (also under
   concurrent duplicates), and answers 409 `IDEMPOTENCY_KEY_REUSED` for a key reused with other items. Copies arriving
   in a Deck add to or raise its Deck List lines.
6. Batch refusals change nothing:
   - 422 `SAME_LOCATION` and 422 `DUPLICATE_MOVE_ITEM`;
   - 404 `LOCATION_NOT_FOUND` for a destination that isn't the caller's leaf or Deck;
   - 409 `NOT_ENOUGH_BORROWED`, with `loan_id`, `edition_id` and `from_location_id` in the detail, for a short or
     missing row, including a foreign Loan or a foreign source Location.
7. The batch takes the borrower's `inventory_owner` lock before touching any `borrowed_holding` row and takes no
   `loan` row lock (§9). A concurrent return or handover confirmation by the borrower runs before or after it, never
   interleaved, and leaves consistent rows.
8. In a Location view and in All owned, one tile per Borrowed Copy follows the owned tiles. Each carries the "From
   <lender>" pill, and its accessible name contains "borrowed from <lender>".
9. The heading shows "· N borrowed" whenever the view lists N > 0 Borrowed Copies. A view holding only Borrowed
   Copies shows them, not the empty message or Import from another tracker.
10. Borrowed tiles are selectable with owned ones: click, Shift-range, Ctrl/⌘ and marquee. The bar reads "… · N
    borrowed", and Actions lists only Move… and Clear selection.
11. Move… and drag and drop move owned and Borrowed Copies together. When any Borrowed Copy moved, the toast reads
    "Moved 7 copies to Box 2." with no Undo. An owned-only Move is unchanged, Undo included.
12. Failures are reported per §6.5. A definite refusal says what did and didn't move. An unknown outcome (a network
    error, timeout or 5xx) never says "Nothing moved". It keeps the operation and resolves it by replay before any
    later Move runs. No copy is moved twice, at either commit, even after the selection changes.
13. The Inspector and phone sheet read "N borrowed from <lender>" for a borrowed tile. "Copies owned" and "Copies by
    location" describe owned copies only.
14. Friend views, Spare Copies, Swap hints, the Trade List and Removal are unchanged; their existing tests pass, and
    `test_social_contract.py` passes with no edits.
15. CONTEXT.md and spec.md carry §7's wording. No copy shows a Loan id, state, date or data source.
16. Only `collection_generated.ts` and `moves_generated.ts` change among the generated clients (`npm run check:client` passes). The mixed Move uses the dedicated no-Undo route on the first attempt and every same-key replay. An initial definitive unknown-route 404/405 refuses the owned write; every other failure stays UNKNOWN until reconciled. An earlier uncertain attempt stays UNKNOWN even if a later retry gets 404/405. No Undo is offered.
    `npm run check`, `npm run guardrails` and the runs in §8 pass.

## 4. Context

- The pack's §D covers storage, triggers, the existing reads and routes, and the conflict between CONTEXT.md:195 and
  spec.md:285.
- **Owned listing** `api/app/collection.py`:
  - `HOLDING_PATHS` 150-157, `HOLDING_COLUMNS` 160-174, `HOLDING_FROM` 175-183;
  - `holding_keys` 195-207;
  - `collection_holdings` 279-361: the context and cursor at 300-306, filters at 307-319, the totals and `lent`
    block at 344-353;
  - `collection_sets` 373-395.
- **The singular route, a pattern only**: `api/app/loan_inventory.py:566-606`. It uses `ensure_owner` and
  `lock_owners` (`social.owners`), `replay` and `record_response` (`location_tree.py:220-233`; replay runs under the
  owner lock, so a concurrent duplicate key waits and then replays), `first_non_leaf` (`inventory_core`), the
  decrement-or-delete then upsert SQL at 592-600, and `advance_revision`.
- **Borrowed writers to race against**: `confirm_handover` (`loan_inventory.py:679-707`, inserting rows) and the
  borrower's return confirmation (`:913-932`, `give_back`, removing rows). Both go through `social.loans.run_step`,
  which locks the owner rows (`lambda role, row: [user_id]`) and then the `loan` row.
- **Contract guard**: `api/tests/test_social_contract.py:34,76,600`. The new SQL filters `h.borrower_id=%s`, never
  `ANY(`.
- **Web**:
  - `useGalleryData.ts`: the walk, its restarts, and the cache keyed on revisions at 89-100;
  - `galleryModel.ts:146-235,373-389`;
  - `Gallery.tsx:156,383,441`;
  - `Workspace.tsx:641-648,750-760`: the heading and the empty message and action;
  - `ui/CopyTile.tsx:66-150`;
  - `selectionModel.ts:1-40,150-172`;
  - `SelectionBar.tsx`;
  - `useInventoryActions.ts:194-310`: `run`, `pending`, the Undo lookup and failures;
  - `useInventoryActions.ts:350-355`: `dropMove`;
  - `inventoryActionsModel.ts:103-215`: `Failure`, `describeFailure`. Line 140 treats a non-`MoveError` or a
    status ≥ 500 as unknown, with `retrySame`;
  - `tileDrag.tsx:62-180`;
  - `Inspector.tsx:128-200`.
- **Pitfalls**:
  - The Undo lookup falls back to matching by shape when `undo_id` is absent. Skip it whenever a Borrowed item moved.
  - Borrowed entries must not go through `appendHoldings`/`holdingKey`; use D7's key.
  - `reconcileSelection` clamps kept entries to new quantities, so drop Borrowed entries from the selection once
    their stage is done.

## 5. API changes

### 5.1 Read: `GET /api/collection/borrowed`

```
borrowed_gallery(location_id: UUID | None = None, sort: HoldingSort = 'name-asc', name: str = '', set_id: str = '',
                 category=None, trainer_type=None, elemental_type=None, user_id=Depends(verified_user))
    -> BorrowedGalleryPage

class BorrowedGalleryView(BaseModel):
    loan_id: UUID; lender: str                      # lender = loan.lender_name
    edition_id: UUID; location_id: UUID; location_name: str; location_path: str; quantity: str
    printing_id: UUID; printing_name: str; set_id: str; set_name: str; set_code: str; collector_number: str
    descriptor: dict; image_url: str | None
    category: str | None; elemental_types: list[str]; trainer_type: str | None

class BorrowedGalleryPage(BaseModel):
    copies: list[BorrowedGalleryView]; total: str
    owner_revision: int; catalog_revision: int; snapshot: str
```

- Run it in one `REPEATABLE READ` transaction. Read the owner, catalog and attribute revisions exactly as
  `collection_holdings` does, and check the Location as it does (404 or 409).
- **Cap.** Query with `LIMIT 2001`. If 2,001 rows come back, answer 409 `TOO_MANY_BORROWED`; otherwise return them
  all. The constant is `BORROWED_GALLERY_CAP = 2000`, named in the module docstring.
- **Shared SQL.** Extract these from `collection.py`, changing no output (§8.0 proves it):
  - `CARD_JOINS`: the catalog joins of `HOLDING_FROM`, from `JOIN catalog_edition` through `catalog_card_attribute`;
  - `listing_conditions(name, set_id, category, trainer_type, elemental_type) -> tuple[str, list]`, the filter
    building with alias `h` and its `!`-escaped LIKE;
  - `listing_snapshot(owner_revision, catalog_revision, attribute_revision) -> str`, returning `f"{o}.{c}.{a}"`.
- **The borrowed query** is:

  ```
  {HOLDING_PATHS} SELECT … FROM borrowed_holding h
    JOIN location l ON l.id=h.location_id AND l.owner_id=h.borrower_id
    JOIN loan o ON o.id=h.loan_id
    LEFT JOIN paths lp ON lp.id=h.location_id
    {CARD_JOINS}
    WHERE h.borrower_id=%s [AND h.location_id=%s] {conditions}
  ```

  It selects `HOLDING_COLUMNS`' sort columns, with `edition_total` taken over the borrowed rows, plus
  `lower(o.lender_name) AS lender_key`. It orders by `holding_keys(sort)`, then `lender_key, h.loan_id`. Views come
  from `collection.views(rows, BorrowedGalleryView)` after dropping the sort-only columns.

### 5.2 Owned listing: an additive `snapshot` (D13)

`CollectionHoldingPage` gains `snapshot: str`, from `listing_snapshot(revision, state['revision'],
attributes['revision'])`, on every page. Nothing else in `collection_holdings` changes.

### 5.3 Sets (D12)

`collection_sets` unions the `borrowed_holding` rows with `borrower_id=%s`, plus `AND location_id=%s` when the
parameter is given, over the same `catalog_printing_display` join. Its output stays ordered and de-duplicated as now.

### 5.4 Write: `POST /api/collection/borrowed/moves`

```
class BorrowedMoveItem(BaseModel): loan_id: UUID; edition_id: UUID; from_location_id: UUID; quantity: str
class MoveBorrowedCopies(BaseModel):
    to_location_id: UUID; items: list[BorrowedMoveItem] = Field(min_length=1, max_length=500); idempotency_key: UUID
class BorrowedMoveResult(BaseModel): copy_count: str; owner_revision: int
```

Steps, in a fixed order:

1. Parse `quantity()` per item. A repeated `(loan_id, edition_id, from_location_id)` answers 422
   `DUPLICATE_MOVE_ITEM`. An item whose source is the destination answers 422 `SAME_LOCATION`.
2. In one transaction: `ensure_owner`, then `lock_owners(conn, user_id)`. This is the borrower's
   `inventory_owner`, taken first. Then `replay(conn, user_id, key, payload)`, where payload is
   `{'action': 'move_borrowed_batch', **command.model_dump(mode='json', exclude={'idempotency_key'})}`. Return any
   stored answer.
3. `first_non_leaf(conn, user_id, [to])` must be None, or answer 404 `LOCATION_NOT_FOUND`.
4. Lock and read every source row in one statement: `SELECT … FROM jsonb_to_recordset(%s) i JOIN borrowed_holding b
   ON (b.loan_id, b.location_id, b.edition_id) = (i.loan_id, i.from_location_id, i.edition_id) AND
   b.borrower_id=%s ORDER BY b.loan_id, b.location_id, b.edition_id FOR UPDATE OF b`. Then take the first item, in
   input order, that is missing or short, and answer 409 `NOT_ENOUGH_BORROWED` with
   `loan_id/edition_id/from_location_id`. A foreign Loan or a foreign source matches no row, so it lands here too.
   Use `api_errors.api_error` with keyword details if `location_tree.error` can't carry them.
5. For each item, in that sorted order, decrement or delete the source and upsert the destination with
   `loan_inventory.py:592-600`'s SQL. Then call `advance_revision` once and `record_response` with the
   `BorrowedMoveResult`.

It takes no `loan` lock and doesn't touch `loan`, `loan_line` or `holding`. Register the router in `api/app/main.py`.

## 6. Web changes

### 6.1 Client (`scripts/generate_collection_client.py` → `web/src/collection_generated.ts` only)

- Add the five new models to `NAMES`.
- In `BODY`, add `getBorrowedGallery(query: CollectionHoldingQuery)`, using `read`.
- Add `moveBorrowedCopies(body)` with a POST helper. It throws a new `BorrowedMoveError(status, code, detail)`,
  defined in `BODY`, for a non-OK answer. A network failure rethrows the fetch error.
- Regenerate with the repository generator. Don't regenerate or edit any other client.

### 6.2 Gallery data and model

- **`galleryModel.ts`**:
  - `GalleryHolding.borrowed: { loanId; lender } | null`.
  - `GalleryTotals.borrowed: number`.
  - `appendBorrowed(previous, loadedCopies, rows, byKey)` maps rows to a `CollectionHoldingView`-shaped `holding`
    with `version: 0`, documented as never sent, keys them with `borrowedKey`, and continues `start`.
  - Borrowed tiles' React keys are `${entry.key}:${ordinal}`.
  - `tileLabel` and `tileTitle` take an optional `lender` and insert "borrowed from <lender>" before the path.
  - `sameListing` compares `totals.borrowed`, each entry's `borrowed`, and `snapshot` in place of the revision pair.
  - `GalleryData` gains `snapshot: string | null`.
- **`useGalleryData.ts`**:
  - `cachedAt` holds the `snapshot`, not `{owner, catalog}`, so an attribute change clears kept listings too.
  - When the owned walk completes, call `getBorrowedGallery(params)` with the same params, `location_id`
    included or not.
  - If its `snapshot` differs from the walk's, `continue` the restart loop (it counts toward `MAX_RESTARTS`).
    Otherwise append and set `totals.borrowed = Number(total)`.
  - Its errors take the existing error path. `TOO_MANY_BORROWED` is not a stale signal.
- **`Gallery.tsx`**:
  - The tile count is `copies + borrowed`.
  - `empty` requires both to be 0.
  - `Tile` passes `borrowedFrom` and the lender to the label and title.
- **`Workspace.tsx`**: the heading appends `` ` · ${totals.borrowed} borrowed` `` after the lent clause. The empty
  message and Import from another tracker show only when both counts are 0.

### 6.3 The mark (`ui/CopyTile.tsx`)

- A new prop, `borrowedFrom?: string | null`. When it's set, an aria-hidden pill sits inside the art span (give the
  art span `relative`), at `bottom-1 left-1`: `max-w-[calc(100%-var(--space-2))] truncate rounded-round border-2
  border-solid border-bg bg-surface-raised px-2 text-caption leading-5 text-text`, with the badge lift shadow. Text:
  "From {name}".
- Add one sentence to DESIGN.md's Card Tile "Badges" bullet.

### 6.4 Selection

- **`selectionModel.ts`**:
  - `SelectedHolding.loanId: string | null`, filled from `holding.borrowed`.
  - `selectedGroups` skips Borrowed entries.
  - `selectedBorrowed(selection): BorrowedMoveItem[]`.
  - `summarizeSelection` gains `borrowed`, the copies in Borrowed entries.
- **`SelectionBar.tsx`**: append "· N borrowed" when N > 0. Hide Inventory Removal… and Lend to a Friend… when N > 0.
- **`useInventoryActions.ts`**: `lendRows` skips Borrowed entries.

### 6.5 The Move operation (new `web/src/workspace/moveOperation.ts`, used by `run` in `useInventoryActions.ts`)

**The record.** It is frozen when the operation starts and never rebuilt from the selection:

```ts
type Stage = "todo" | "done" | "unknown";
type MoveOperation = Readonly<{
  target: { kind: "move"; destinationId: string };
  owned: readonly SelectedGroup[];          // owned rows already at the destination removed
  borrowed: readonly BorrowedMoveItem[];
  stayed: number;                           // owned and Borrowed copies already at the destination
  noUndo: boolean;                          // original selection carried Borrowed Copies, even if they stayed
  borrowedKey: string; ownedKey: string;    // crypto.randomUUID() each, at creation
}>;
type OperationState = { manifestId: string | null; staged: boolean; borrowed: Stage; owned: Stage;
                        borrowedAttempted: boolean; ownedAttempted: boolean;
                        borrowedResult?: BorrowedMoveResult; ownedResult?: MoveResult };
```

Removal keeps today's path: an owned-only operation with no Borrowed stage. Only the record replaces the
signature-based `pending`.

**`advance(op, state, api): Promise<Outcome>`** is a pure orchestration function with the API injected
(`moveBorrowedCopies`, `startMove`, `stageMove`, `commitMove`, `commitMoveWithoutUndo`):

1. If `borrowed` is non-empty and the Borrowed stage isn't `done`, call `moveBorrowedCopies({to_location_id, items:
   op.borrowed, idempotency_key: op.borrowedKey})`.
   - A 2xx answer sets `done`.
   - A `BorrowedMoveError` with status < 500 is a **definite refusal**, except any rejection after an earlier uncertain attempt, or an unavailable replay, remains UNKNOWN. Return `{kind: "refused", stage: "borrowed"}` only for a definite refusal.
   - Anything else (a network error, timeout or 5xx) sets the stage to `unknown` and returns `{kind: "unknown",
     stage: "borrowed"}`. Stop.
2. If `owned` is non-empty and the owned stage isn't `done`, start a manifest if `manifestId` is null and stage
   (idempotent) if not `staged`. Commit with `op.ownedKey` and the same manifest. A mixed Move uses
   `commitMoveWithoutUndo`; owned-only Move and Removal keep their existing APIs. If all owned copies already
   occupy the destination, count them as stayed and skip the manifest entirely.
   - A 2xx receipt sets `done`; a non-null Undo id on the strict route instead retains the receipt as an
     unsupported diagnostic, never offers Undo and sends no DELETE.
   - For the strict route, only an initial unknown-route 404/405 (default route-not-found response) is refused.
     All other failures are UNKNOWN. After an earlier uncertain attempt, even a later 404/405 stays UNKNOWN.
   - Owned-only requests keep today's initial refusal classification; every rejection after an uncertain
     attempt stays UNKNOWN. Every retry uses the same route, key and manifest; no failure alone proves a
     possibly committed request did not execute.

3. When everything is `done`, return `{kind: "done"}`.

**`run` in the hook.**

- It keeps `operation.current: {op, state} | null`.
- If an operation is held whose stages aren't all `done` and which wasn't refused, **any** new Move call, dialog or
  drop, whatever its target or selection, resumes it with `advance` and ignores the new request. This resolves the
  uncertainty before anything else runs. The new request is not run. After the stored operation resolves, the
  gallery reloads and the collector chooses again.
- On `done` or a refusal, clear `operation.current`. On `unknown`, keep it.
- When the Borrowed stage becomes `done`, drop the Borrowed entries from the selection (Pitfall 3). The record still
  holds them, so this can't affect recovery.
- Closing the dialog doesn't drop a held operation.

**Messages.** These are new pure functions in `inventoryActionsModel.ts`; `n` is the Borrowed copy count, `place` the
destination.

| Outcome | Inline text (toast text drops the selection clause) | Reload |
|---|---|---|
| done | Toast: "Moved {all copies} to {place}.{stayed}". No Undo if `borrowed` was non-empty; otherwise today's Undo lookup with `undo_id`. | gallery and tree |
| refused, borrowed | `describeBorrowedFailure` lead + "Nothing moved." `NOT_ENOUGH_BORROWED`: "Some borrowed copies aren't where you selected them any more. Nothing moved." `LOCATION_NOT_FOUND`: today's destination-gone text. Anything else: "The Move was refused. Nothing moved." | gallery for `NOT_ENOUGH_BORROWED` and `LOCATION_NOT_FOUND`; tree as today |
| unknown, borrowed | "The Move may not have finished. Try again to check safely; your selection is kept." | none |
| initial unknown-route 404/405, owned, Borrowed done | "Moved {n borrowed copies} to {place}; your own copies didn't move: This Move is unavailable right now. Try again later." | gallery and tree |
| refused, owned, no Borrowed | owned-only: today's `describeFailure`; mixed selection whose Borrowed copies stayed: unavailable message only for initial unknown-route 404/405 | as today |
| unknown, owned, Borrowed done | "Moved {n borrowed copies} to {place}. Moving your own copies may not have finished. Try again to check safely." | gallery and tree (borrowed rows moved) |
| unknown, owned, no Borrowed | today's unknown text, unchanged | none |

`describeFailure` gains an option, `omitNothing: true`, which drops its `nothing` sentence, so the partial message can
reuse the lead.

### 6.6 Drag and drop (`tileDrag.tsx`)

- `onDrop(destinationId, carried: { groups; borrowed })`.
- A selected tile carries `selectedGroups` + `selectedBorrowed`. An unselected borrowed tile carries itself as one
  item with quantity "1".
- A target is valid when at least one carried copy isn't already there, over the union of `source_id` and
  `from_location_id`. Folders stay invalid.
- `dropMove` builds the operation as the dialog does.

### 6.7 Inspector (`Inspector.tsx`)

For a borrowed tile, "N copies here" becomes "N borrowed from <lender>". Nothing else changes.

## 7. Wording fixes (docs only)

- **CONTEXT.md:195, Borrowed Copy**: "A copy, held by the borrower, that a Friend has lent and handed over. It sits in
  any of the borrower's Locations, shows in the Collection's galleries marked with the lender's name, and moves with
  the usual Move, which offers no Undo for it; in a Deck it fills, or adds, a Deck List line and counts toward that
  Deck's Estimated Deck Cost. It is never counted in the borrower's Collection, never a Spare Copy and never
  removable, and leaves when the Loan is returned or written off."
- **spec.md:281**: append "The Collection's galleries, All owned and each Location, read Borrowed Copies through their
  own projection and list them after the owned copies; no Collection figure counts them."
- **spec.md:285**: "**Moving a Borrowed Copy** writes through its own route, never the general Move, because it
  carries `loan_id` and never joins the owned Holdings. The gallery's Move sends a selection's Borrowed Copies there
  first and its owned copies through the general Move. A Move that includes Borrowed Copies offers no Undo. Deck
  deletion moves the Deck's `borrowed_holding` rows to the borrower's Unsorted."
- **spec.md:386**, second sentence: "Borrowed Copies show in All owned and in the Location or Deck that holds them,
  after the collector's own, marked "From Ash K."; headings add "· 2 borrowed"."

## 8. Work package (one worker)

**Owned files**

- API:
  - `api/app/borrowed_gallery.py` (new);
  - `api/app/collection.py`: `CARD_JOINS`, `listing_conditions`, `listing_snapshot`, `snapshot` and the sets union
    only;
  - `api/app/main.py`: one router line;
  - `api/tests/test_collection_listing_golden.py` and `api/tests/fixtures/collection_listing_golden.json` (new);
  - `api/tests/test_borrowed_gallery.py` (new).
- Client: `scripts/generate_collection_client.py`, `web/src/collection_generated.ts`.
- Web:
  - `web/src/ui/CopyTile.tsx`;
  - `web/src/workspace/moveOperation.ts` (new);
  - `galleryModel.ts`, `useGalleryData.ts`, `Gallery.tsx`;
  - `Workspace.tsx`: the heading, the empty state and the `run`/`dropMove` plumbing;
  - `selectionModel.ts`, `SelectionBar.tsx`, `useInventoryActions.ts`, `inventoryActionsModel.ts`, `tileDrag.tsx`,
    `Inspector.tsx`;
  - the Move dialog in `InventoryDialogs.tsx`, only where it calls `run` or `movePreview`.
- Tests: `web/src/workspace/{moveOperation,selectionModel,galleryModel,inventoryActionsModel}.test.ts` (new) and
  `web/tests/social-borrowed.spec.ts` (extend).
- Docs: `CONTEXT.md`, `docs/planning/social-network/spec.md` (§7's lines), `DESIGN.md` (one sentence).

### 8.0 Step 0, before any change to `collection.py`: pin the owned listing

1. Write `test_collection_listing_golden.py` on the base code.
2. **Fixture**: a fixed catalog (copy the setup of `test_collection_holdings.py`, or `want_list_swap_fixtures`, if it
   has enough variety). One collector with:
   - Unsorted, a Binder, a nested Shelf / Box and a Deck;
   - at least 12 Holdings over several sets, categories, Trainer Types and elemental types;
   - repeated Editions across Locations;
   - copies lent to a Friend, so `lent` is non-zero.
3. **Normalise volatile values**:
   - ids become stable labels: a Location by its path, an Edition by set and number;
   - revisions become deltas from the first read;
   - `image_url` becomes present or absent;
   - `snapshot` is excluded until step 5.
4. **Cases.** For each case, record the full ordered rows (every field), totals, `lent`, `owner_revision` and
   `catalog_revision`:
   - each of the six sorts, for All owned and for one Location;
   - each filter alone (`set_id`, each `category`, each `trainer_type`, one `elemental_type`), and one combination;
   - `name` searches for a plain prefix, `%`, `_`, `!` and `a%b`. Each escaped character must match only literally;
   - a cursor walk with `HOLDING_PAGE_SIZE` monkeypatched to 3. Record each page's rows and whether it has a
     `next_cursor`, and assert that the concatenated pages equal the unpaged result.
5. Generate the JSON once on the base with `GOLDEN_UPDATE=1`, and keep it.
6. The test asserts equality with the JSON, field for field. If monkeypatching the page size doesn't reach the
   in-process app, stop and report.
7. Rerun the golden test after the extraction (§5.1). It must match byte for byte.
8. Add a second test that runs the same cases after lending the collector Borrowed Copies into Unsorted, the Box and
   the Deck. Its owned results must equal the same JSON.

**Order**: §8.0 → §5.1 extraction → golden green → §5.1–5.4 → API tests → §6.1 → §6.2–6.7 → vitest → browser → §7.

**API tests** (`api/tests/test_borrowed_gallery.py`; copy `lend`, `move`, `code` and `ok` from
`test_borrowed_copies.py:37-56`, and the thread pattern from `test_trade_swap.py:714-738`):

- **Reads**:
  - `test_a_locations_borrowed_copies_list_with_their_lender_and_stay_out_of_its_counts`;
  - `test_all_owned_lists_every_borrowed_copy_and_its_totals_and_lent_stay_owned_only`;
  - `test_two_loans_of_one_card_in_one_location_are_two_rows_by_lender`;
  - `test_the_borrowed_read_takes_the_listing_search_and_filters`, including escaped `%`;
  - `test_the_borrowed_read_refuses_a_foreign_or_folder_location`;
  - `test_the_borrowed_read_refuses_past_its_cap`: monkeypatch the cap to 2, hold 3 rows, expect 409, and 2 rows
    pass;
  - `test_both_listings_carry_one_snapshot_and_an_attribute_change_moves_it`: bump `catalog_attribute_state`, as
    the existing attribute tests do;
  - `test_the_set_filter_offers_borrowed_cards_sets_in_a_location_and_in_all_owned`.
- **Write**:
  - `test_borrowed_copies_move_in_one_batch_with_one_revision_and_no_undo`;
  - `test_a_batch_with_one_short_item_moves_nothing_and_names_it`;
  - `test_a_batch_refuses_a_foreign_loan_and_a_foreign_source`. The lender moves the borrower's rows, and the
    borrower names another collector's Location; both give 409 `NOT_ENOUGH_BORROWED` with nothing changed;
  - `test_a_batch_refuses_same_location_duplicates_and_a_foreign_or_folder_destination`;
  - `test_a_batch_replays_by_key_and_refuses_a_reused_key_with_other_items`;
  - `test_two_concurrent_batches_with_one_key_move_once_and_answer_alike`;
  - `test_a_batch_into_a_deck_raises_its_deck_list_line`.
- **Races**, two threads each, asserting a valid final state whichever runs first:
  - `test_a_batch_racing_the_borrowers_return_confirmation_serialises`: the return started by the lender and
    confirmed by the borrower, against a batch moving the same Loan's rows. Either both succeed with the rows
    consistent, or the batch answers `NOT_ENOUGH_BORROWED`. Rows are never negative, and the total equals promised
    less returned.
  - `test_a_batch_racing_a_handover_confirmation_of_another_loan_serialises`: both succeed, and the destination's
    quantities add up.

**Vitest**:

- `moveOperation.test.ts` uses a fake in-memory server keyed by idempotency key. The fake can "apply, then lose the
  response" (it throws a `TypeError`) or answer 500 after applying.
  1. A lost response at the Borrowed commit, then a retry: it replays with the same key, the borrowed rows move once,
     and the owned stage then runs.
  2. A lost response at the owned commit, then a retry: the same manifest and `ownedKey` are used, and nothing is
     committed twice.
  3. A retry after the selection changed, following each kind of loss: the held operation is resumed with its
     original items and keys, and the new request isn't run.
  4. A definite refusal at Borrowed: nothing more is called, and the operation is cleared.
  5. A definite refusal at owned after Borrowed is done: the outcome is partial, and the operation is cleared.
  6. A 500 that didn't apply, then a retry: it applies once.
  7. Borrowed only and owned only.
- `inventoryActionsModel.test.ts`: every row of §6.5's message table, plus `movePreview`'s stayed count.
- `selectionModel.test.ts` and `galleryModel.test.ts`: `selectedGroups` and `selectedBorrowed`; the borrowed
  summary; key separation; `sameListing` on `borrowed` and `snapshot`.

**Browser** (one new test in `web/tests/social-borrowed.spec.ts`, using the `support/loans` helpers; keep the
existing test):

1. Seed one owned card in a new Box. Lend Ash 2 Iono into his Deck, and move 1 to Box through the API.
2. Box: one tile has "borrowed from Misty W" in its name and a visible "From Misty W" pill, and the heading reads "1
   copy · 1 edition · 1 borrowed".
3. All owned: its heading ends "· 2 borrowed", and both borrowed tiles follow the owned ones.
4. Select both tiles in Box. The bar shows "· 1 borrowed", and Actions lists only Move… and Clear selection.
5. Move… to Unsorted. The toast reads "Moved 2 copies to Unsorted." with no Undo, and Box is empty.
6. Drag the borrowed tile from Unsorted onto Box, and it shows there.
7. Run `expectPageChecks` at DESKTOP and PHONE.

Use web-first assertions only.

**Verify** (one gate at a time; check `[ -n "$TEST_ADMIN_DATABASE_URL" ]` first):

```sh
npm run verify -- --suite api -- api/tests/test_collection_listing_golden.py      # on base first, then after each API step
npm run verify -- --suite api -- api/tests/test_borrowed_gallery.py api/tests/test_borrowed_copies.py
npm run verify -- --suite api -- api/tests/test_collection_holdings.py api/tests/test_collection.py api/tests/test_social_contract.py api/tests/test_moves.py api/tests/test_handover.py
npx vitest run web/src/workspace
npm run verify -- --suite browser -- web/tests/social-borrowed.spec.ts
npm run verify -- --suite browser -- <the gallery, selection and move specs that exist; list them in the report>
npm run check:client && npm run check && npm run guardrails
```

All must pass. Record the baseline and actual counts. The primary may then start
`gh workflow run verify.yml --ref <branch> -f integration=sharded`, because the change crosses suites.

## 9. Out of scope, coordination with #478, stop conditions

**Out of scope.**

- `holding` and Undo. `moves.py` changes only for the dedicated no-Undo route described in D1; Removal, Put away and Undo itself keep their existing behavior.
- `GET /api/holdings/{id}`, `GET /api/collection` and the Location tree.
- `loan_inventory.py`, including the singular route, which is kept as is.
- `BorrowedDialog.tsx`, `social_generated.ts` and every generated client except `collection_generated.ts` and `moves_generated.ts`.
- Deck builder views, Friend reads, the Trade List and Swap hints.
- Any migration.

**Lock-order invariant (record it in the new module's docstring, and for #478):**

- Every writer of `borrowed_holding` takes the borrower's `inventory_owner` lock (`lock_owners`) first.
- A step that also locks a `loan` row takes it after the owner locks, as `run_step` does today.
- No code takes a `loan` lock after it has locked `borrowed_holding` rows.
- The batch takes no `loan` lock at all.

**Coordination with #478.**

- #478 owns `loan_inventory.py`, `social/loans.py` and the Loan tests. Its WP4 owns "the generated clients" through
  one generation after its API packages land.
- This ticket regenerates **only** `web/src/collection_generated.ts` and `web/src/moves_generated.ts`, from their respective generators. `moves_generated.ts` is regenerated the same way, never hand-merged.
  Those files are not touched by #478's API packages.
- Whichever lands second reruns `scripts/generate_all_clients.py` and commits the result. Generated files are never
  hand-merged. If WP4's generation lands first, rebase and regenerate `collection_generated.ts` and `moves_generated.ts` with their generators.
- #478 must keep:
  - `borrowed_holding` keyed by `loan_id`;
  - `loan.lender_name` as the lender's kept Display Name;
  - the lock-order invariant above.
  Its "one live `loan` row per thread" replaces only `requested` rows, before any handover, so no Borrowed Copy
  points at a replaced row.
- A `thread_id` rename of the Loan routes doesn't reach `/api/collection/borrowed`.
- Likely textual conflicts: `api/app/main.py`, CONTEXT.md and spec.md.

**Stop and report if:**

- a referenced symbol or line is missing;
- the golden test can't be made deterministic on the base, or the extraction changes it;
- `test_social_contract.py` flags the new module;
- the gallery can't take a trailing run without changing `tileAt` or the marquee hit-testing;
- the Move dialog's path differs materially from §6.5;
- stage or commit replay by key doesn't work as `useInventoryActions.ts` assumes today (a manifest expiring before the
  replay, for example);
- any generated client other than `collection_generated.ts` or `moves_generated.ts` changes.

## 10. Risks and review notes

- **Two transactions per mixed Move.** The record and the resume-first rule (D14) carry the safety. The reviewer
  should check that no path builds a new key while an operation is held, and that no unknown outcome is reported as
  "Nothing moved".
- **Snapshot skew.** A mismatch restarts the walk, at most `MAX_RESTARTS` times, then the error path follows.
- **Friend leak.** The new module reads one owner only, adds no field to `/api/social`, and its SQL has no `ANY(`.
- **Owned figures.** The golden fixture (§8.0) is the guard. The `snapshot` field is the only change to the owned
  response.
- **All owned volume.** The 2,000-row cap returns a load error for an extreme borrower. Raising it, or paging the
  projection, is a later change.
- **Copy.** The pill shows `lender_name` as kept, as the Borrowed dialog already does.

## 11. Owner decisions (2026-10-31)

1. A mixed selection moves everything, with no Undo.
2. Borrowed tiles come after the owned ones.
3. All owned includes Borrowed Copies, marked, after the owned tiles. They stay out of every Collection figure,
   Spare Copies, Removal, Undo, the Trade List, Swap hints and every Friend view.


## 12. Owner-approved dedicated Move route and reconciliation

The owner approved `POST /api/moves/manifests/{manifest_id}/commit-without-undo` at 19:04 UTC. It replaces the proposed optional `CommitMove.undo` field completely. Its body accepts `destination_id` and `idempotency_key`, returns the existing MoveResult, shares normal Move locking, validation, transaction and replay, and atomically skips writing a new Undo record and trimming history for that record. `undo_id` is null on the first response and on replay. Its fingerprint uses action `move_without_undo`; the same key used across normal and strict routes returns 409 `IDEMPOTENCY_KEY_REUSED`. Normal Move bodies and fingerprints are unchanged. Put away and Removal use the existing routes and keep normal Undo. The strict body rejects `put_away` and requires a destination before locking, so the flag-specific `PUT_AWAY_NEEDS_UNDO` and `REMOVAL_NEEDS_UNDO` refusals no longer apply. No table, migration or additional lock is introduced.

**This operation creates no Undo record; not a history barrier; an older Undo stays quantity-based.** An older surviving Undo checks the recorded source, Card Edition and quantity, not physical-copy identity. Replenishing a destination can make an older Undo apply when it would otherwise fail; its quantity can include copies delivered by a later mixed Move. This amendment does not make older history identity-safe or solve that limitation.

### Mixed versions and residual windows

Images carry the same source tag and normal startup orders API → auth → web, but separate containers and rollback do not remove already loaded JavaScript. A capability GET cannot bind a later write to that server version. The dedicated route closes that particular unsafe fallback: an old or rolled-back API rejects its unknown route instead of interpreting the request as a normal undoable Move. There is no client fallback to normal commit and no after-commit DELETE.

Only an initial definitive unknown-route 404/405, before any possibly committed request, establishes that the owned part did not execute. The UI says the Move is unavailable and can be tried later. All other failures, including timeouts, lost or aborted responses, network errors, 5xx and other refusal responses, leave the strict owned outcome UNKNOWN. Reconciliation retries the same route, manifest and idempotency key; it never starts another operation with a new key while the result is unknown. An earlier uncertain request remains UNKNOWN if a later retry gets 404/405 after rollback. The borrowed batch runs first in its own transaction: when it succeeds, the UI reports those borrowed copies as moved even if the owned part is refused or remains unknown. No failure without a receipt is treated as proof that nothing moved.

The existing replay ledger records successful commits, not refusal outcomes. Under the required strict-client classification, a non-route refusal such as `STALE_HOLDING` therefore stays UNKNOWN if repeated requests never yield a receipt; the client does not silently turn it into a failed operation. Automatic resolution of that case would require separately approved recorded refusal outcomes or an outcome lookup. Neither is added here.

An idempotency receipt can expire after 24 hours. If replay becomes unavailable or the manifest is gone after an uncertain attempt, the client remains UNKNOWN and does not invent a result or mint a key. Automatic reconciliation after that retention window would need a separately approved durable outcome lookup or longer retention; this work adds neither. The in-memory operation can also be lost on reload or crash; no persistence or cross-tab recovery guarantee is claimed.

A non-null `undo_id` from this route violates its postcondition. Defence in depth retains that receipt, never offers the Undo, refuses further operation writes and shows "Undo unavailable". It sends no DELETE and does not claim that response diagnostics protect other tabs or repair a broken server. The safe no-Undo guarantee comes from the dedicated server transaction, not client cleanup.
