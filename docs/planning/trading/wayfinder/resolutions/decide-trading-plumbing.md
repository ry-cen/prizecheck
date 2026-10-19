# Decide the Trading plumbing: module boundary, reservations and ownership transfer

Resolves the candidate ticket "Decide the module boundary, ownership-transfer plumbing and glossary terms" of the [Trading decision map](../map.md) on 2026-10-17. The owner delegated the technical plumbing, which Claude decided. The map is the authority on what collectors see; where it is silent and a plumbing choice would change what collectors see, the choice is listed under "What collectors see" with the default this resolution assumes. The cross-owner pattern is recorded in [ADR 0015](../../../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md), which extends [ADR 0014](../../../../adr/0014-friend-reads-and-two-owner-loans.md). It builds on the [social module boundary](../../../social-network/wayfinder/resolutions/decide-social-module-boundary.md). Migration numbers are in [the Trading migrations note](../../migrations.md).

## What collectors see

The nine questions below were put to the owner with a default each. On 2026-10-19 the owner allowed gifts (question 5) and approved the other eight defaults as written.

1. **A Deck inside a For trade Location.** **Owner's choice (2026-10-19):** its cards are not on the Trade List; Decks never are. Alternative: they are, which removes the Deck exclusion from `for_trade_locations`. Dependent: Data model 1, and the Trade step tests in Testing.
2. **Wants from a Deck in a Hidden Location.** **Owner's choice (2026-10-19):** Friends do not see them in trade discovery. Lines of Decks inside Hidden Locations are left out of what Friends read. The collector's own matching still uses every want. Dependent: Matching reads, and the privacy tests.
3. **Will accept scope.** **Owner's choice (2026-10-19):** one choice per card (Card Edition), wherever it appears on the Want List, not per Deck. Dependent: Data model 3.
4. **Trade Wants quantity.** **Owner's choice (2026-10-19):** a line goes down by the copies received at Confirm swap and is deleted at 0. Alternative: it stays until edited. Dependent: Data model 2, Confirm swap step 4, and the Confirm swap tests.
5. **Gifts.** **Owner's choice (2026-10-19):** gifts are allowed. A proposal may have cards on one side and nothing (no cards, no cash) on the other. Only a proposal with no cards on either side is refused, with `TRADE_HAS_NO_CARDS`, so a Trade is never cash for nothing. Dependent: the shape rules under Data model.
6. **Counters and the cash-only rule.** **Owner's choice (2026-10-19):** a collector who is not Open to cash offers sends "my $10 for your card"; the other side cannot counter with "$15", because a Counter is a proposal sent to its recipient and their setting applies. The Counter is refused with `CASH_ONLY_NOT_OPEN`; the other side can only accept or decline. Alternative: skip the check when the countered proposal already had a cash-only side. Dependent: the shape rules under Data model.
7. **Out-of-date picks at Confirm swap.** **Owner's choice (2026-10-19):** refuse and ask the collector to Use suggested picks, as Loans do. Alternative: re-pick automatically at confirm. Dependent: Confirm swap step 1.
8. **Take back a Confirm swap.** **Owner's choice (2026-10-19):** no. It is final for that side, which fits "no partial swap" and "not undoable". Alternative: allow take-back before the other side confirms, which adds a take-back step and an `allowed` entry.
9. **"Same name" across languages.** **Owner's choice (2026-10-19):** Will accept "any card with the same name" uses Card Identity as defined, which may include Printings in other languages that the catalog links to the same identity. Dependent: the `accepts` expansion under Matching reads.

Not blocking, left to the prototype ticket (listed again under "Not yet specified"): where Trades are listed, the destination picker's default for received copies, the wording of `PROMISED_TO_TRADE` and of the Remove Friend and Block counts, and the liability notice.

## Module boundary

Trading lives in the `social` area and follows the Loan split exactly. The social area is split today between `api/app/social/loans.py:84`, which serves `/api/social/loans` (the shared Loan facts and the steps that change no inventory), and `api/app/loan_inventory.py:83` (`APIRouter(prefix='/api/loans')`), which serves the steps that read or write one collector's own inventory. The contract guard `api/tests/test_social_contract.py` enforces the split: `READERS` (line ~38) lets only `social/friend_copies.py` and `social/hidden_locations.py` name `holding|deck_list_line|deck_list|location|borrowed_holding` in SQL; `ALLOWED_IMPORTS` lists every app import each social module may use; `FRIENDS_OF_READERS` lists the only modules that may call `friends_of`; and the OpenAPI walk refuses any `/api/social` response field or component whose name contains `location`, `locations`, `deck`, `decks`, `leaf`, `leaves`, `unsorted`, `binder`, `shelf` or `storage` (`FORBIDDEN`), with `in_deck` the one exception (`ALLOWED`) and free-form objects allowed only when listed in `OPAQUE`.

| Module | Prefix | Owns |
| --- | --- | --- |
| `api/app/social/trades.py` | `/api/social/trades` | TradeView, list and read, decline, withdraw, cancel, `end_trades_between`, `record_trade_update`, `waiting_trade_step`, the `allowed` rule, and Open to cash offers (`GET/PUT /api/social/trade-settings`, declared in this module with its own path) |
| `api/app/social/trade_matches.py` | `/api/social` | `GET /trade-matches`, `GET /trade-lists/{handle}`, `GET /trade-card-matches?printing_id=` |
| `api/app/social/friend_copies.py` (extended) | none | adds `TRADE_READ` + `friend_trade_copies`, and `friend_wants`, the only cross-collector Trade reads |
| `api/app/trade_inventory.py` | `/api/trades` | send, counter, accept, confirm swap, use suggested picks, own side view (`GET /api/trades/{id}/side`) |
| `api/app/trade_list.py` | `/api/trades` | own Trade List (`GET /api/trades/list`, with the collector's own Location names) and `own_trade_copies(conn, user_id, edition_ids=None) -> dict[edition, listable]`, which `trade_inventory` (send, Counter and Accept caps) and `social/trade_matches` import |
| `api/app/trade_picks.py` | none | `trade_pick_shortfalls`, `stale_pick_trades`, `suggest_trade_picks` (own Holdings only) |
| `api/app/trade_wants.py` | `/api/trade-wants` | own Trade Wants and Will accept: `GET /api/trade-wants`, `PUT /api/trade-wants/{edition_id}`, `PUT /api/trade-wants/will-accept/{edition_id}`, plus `own_wants(conn, user_id)` for `trade_matches` |
| `api/app/trade_value.py` | `/api/trades` | `POST /api/trades/value` (budgeted) |
| `api/app/location_tree.py` (extended) | `/api/location-tree` | `PUT /{location_id}/for-trade`, and `for_trade` / `for_trade_by` on tree nodes |

**Reasons.**

- Stage 1 is Friends-only and depends on `friends_of`, Blocks, `lock_owners`, the inbox and the choke point, all of which are social.
- Every `/api/social/trades*` and `/api/social/trade-*` response falls under the existing OpenAPI walk with no new guard code (`test_social_contract.py`, `social_responses()` filters on `/api/social`).
- Own-inventory steps and own Location names belong outside `/api/social`, as with `/api/loans` (`loan_inventory.py:1-9`).
- Own Trade Wants live outside `social` so the guard can forbid `trade_want` and `trade_accept` reads in every social module except the choke point.

Stage 2 reuses the same modules. Non-Friend reads add a second filter beside `friends_of` in `friend_copies.py`, not a new module.

Web:

- `/api/social/*` trade types go into the explicit component list of `scripts/generate_social_client.py` (line 28).
- A new `scripts/generate_trades_client.py` producing `web/src/trades_generated.ts` covers `/api/trades*` and `/api/trade-wants*`, and is added to `check:client` in `package.json`.
- Page placement (a Trades tab or not) is the prototype ticket's choice. The API supports a `/trades/<id>` page with `param: true`, as Loans do in `web/src/shell/routes.ts` (`PageId`, `PAGES`).
- `web/src/discover/` is Published Deck discovery, not trading.

## Data model

Every table is new apart from three columns: `location.for_trade`, `collector_profile.open_to_cash_offers`, and the `inbox_update` change in the Inbox section.

1. **For trade Location.**
   - Add `location.for_trade boolean NOT NULL DEFAULT false`, `CREATE INDEX location_for_trade ON location(owner_id) WHERE for_trade`, and the constraint `location_deck_not_for_trade CHECK (NOT for_trade OR kind <> 'deck')`.
   - Add the SQL function `for_trade_locations(owners text[]) RETURNS TABLE(owner_id text, location_id uuid)`. It is recursive over `location.parent_id` from each marked Location, mirroring `hidden_locations` (`migrations/101_hidden_locations.sql`). Its output excludes `kind = 'deck'` rows, so a Deck is never on a Trade List, even inside a For trade Location (question 1). This is the one definition of "effectively For trade".
   - The setter `PUT /api/location-tree/{id}/for-trade {for_trade, version, idempotency_key}` mirrors `set_location_hidden` (`location_tree.py:350-376`). It refuses a Deck with 409 `DECK_NOT_FOR_TRADE`, refuses un-marking inside a marked ancestor with 409 `LOCATION_FOR_TRADE_BY_PARENT` (detail `for_trade_by`), and bumps the Location version but never the inventory revision.
   - The tree node gains `for_trade` and `for_trade_by`, computed with the existing pure `hidden_locations.hidden_by(parents, marked)`, which is generic: "nearest marked ancestor".
   - Hidden and For trade are independent columns.
2. **Trade Wants.** `trade_want(owner_id text REFERENCES inventory_owner ON DELETE CASCADE, edition_id uuid REFERENCES catalog_edition, quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 9999), created_at timestamptz DEFAULT now(), PRIMARY KEY (owner_id, edition_id))`.
   - Each line is an exact Card Edition (map).
   - At most 500 lines per owner (409 `TOO_MANY_LINES`).
   - `PUT /api/trade-wants/{edition_id} {quantity}` sets the line, and `"0"` deletes it. It is idempotent by value, so it needs no key.
   - The quantity means "copies I want to receive". Confirm swap lowers it by the copies received (question 4).
3. **Will accept.** `trade_accept(owner_id text REFERENCES inventory_owner ON DELETE CASCADE, edition_id uuid REFERENCES catalog_edition, rule text NOT NULL CHECK (rule IN ('printing','identity')), PRIMARY KEY (owner_id, edition_id))`.
   - A missing row means `edition` (this exact card), the default.
   - Keyed by owner and Edition, so one choice applies to that card wherever it appears on the Want List (question 3).
   - Reason: the Want List is derived and never edited directly (`CONTEXT.md`, Want List), so the choice cannot live on a Want List row. A `deck_list_line` column would tie a trading preference to the Deck List and split one card across Decks.
   - Rows outlive the card leaving the Want List and apply again if it returns. Reads apply rows only to current wants. No cleanup trigger.
   - `PUT /api/trade-wants/will-accept/{edition_id} {rule: 'edition'|'printing'|'identity'}` sets it (`edition` deletes the row).
   - The Want List response (`GET /api/want-list`) is unchanged, so its revision pins and the Mass Entry 409 are untouched. The Want List page reads Will accept from `GET /api/trade-wants` (`{lines, will_accept: [{edition_id, rule}]}`).
4. **Open to cash offers.** `collector_profile.open_to_cash_offers boolean NOT NULL DEFAULT false`. It sits in the social profile row that cascades on account deletion, and a Friend's discovery row reads it.
5. **Trade and Trade Proposal rows.** One table, as `loan` holds Borrow Requests, Lend Offers and the Loans they become (`migrations/105_loans.sql:16`). Each row is one Trade Proposal (one round), and the row that is accepted is the Trade.

   ```sql
   CREATE TABLE trade (
     id uuid PRIMARY KEY,
     state text NOT NULL CHECK (state IN ('proposed','accepted','closed')),
     closed_reason text CHECK (closed_reason IN ('declined','withdrawn','countered','cancelled','swapped')),
     proposer_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
     recipient_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
     proposer_name text NOT NULL CHECK (char_length(proposer_name) BETWEEN 1 AND 40),
     recipient_name text NOT NULL CHECK (char_length(recipient_name) BETWEEN 1 AND 40),
     countered_from uuid REFERENCES trade(id) ON DELETE SET NULL,  -- the proposal this one answers
     cash_cents bigint NOT NULL DEFAULT 0 CHECK (cash_cents BETWEEN 0 AND 99999999),
     cash_payer text CHECK (cash_payer IN ('proposer','recipient')),
     created_at timestamptz NOT NULL DEFAULT now(),
     accepted_at timestamptz,
     proposer_swap_at timestamptz,
     recipient_swap_at timestamptz,
     closed_at timestamptz,
     closed_by text,
     revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
     CONSTRAINT trade_two_collectors CHECK (proposer_id <> recipient_id),
     CONSTRAINT trade_closed_has_reason CHECK ((state = 'closed') = (closed_reason IS NOT NULL)),
     CONSTRAINT trade_cash_has_payer CHECK ((cash_cents = 0) = (cash_payer IS NULL)),
     CONSTRAINT trade_swap_after_accept CHECK (state <> 'proposed' OR (proposer_swap_at IS NULL AND recipient_swap_at IS NULL))
   );
   CREATE INDEX trade_proposer ON trade(proposer_id, created_at DESC);
   CREATE INDEX trade_recipient ON trade(recipient_id, created_at DESC);
   CREATE INDEX trade_reserving_proposer ON trade(proposer_id)
     WHERE state IN ('proposed','accepted') AND proposer_swap_at IS NULL;
   CREATE INDEX trade_reserving_recipient ON trade(recipient_id)
     WHERE state = 'accepted' AND recipient_swap_at IS NULL;
   ```

   - A Display Name change refreshes both names through a `trade_names_follow_profile` trigger on `collector_profile`, a copy of `loan_names_follow_profile` (migration 105).
   - Cash is integer US cents, paid by one side. The cap of 99,999,999 ($999,999.99) is only a sanity bound.
6. **Trade lines per side.** `trade_line(trade_id uuid REFERENCES trade ON DELETE CASCADE, side text CHECK (side IN ('proposer','recipient')), edition_id uuid REFERENCES catalog_edition, position integer CHECK (position >= 0), quantity bigint CHECK (quantity > 0), PRIMARY KEY (trade_id, side, edition_id))`. `side` is the giver. At most 50 lines per side (422 `TOO_MANY_LINES`).
7. **Trade Pick List.** `trade_pick(id bigint PRIMARY KEY DEFAULT nextval('loan_pick_id_seq'), trade_id uuid, side text, owner_id text REFERENCES inventory_owner ON DELETE CASCADE, edition_id uuid, source_location_id uuid, quantity bigint CHECK (quantity > 0), FOREIGN KEY (trade_id, side, edition_id) REFERENCES trade_line ON DELETE CASCADE, CONSTRAINT trade_pick_source FOREIGN KEY (owner_id, source_location_id) REFERENCES location(owner_id, id) ON DELETE SET NULL (source_location_id))`, plus indexes `(trade_id, side)` and `(owner_id, source_location_id)`.
   - The ids come from `loan_pick`'s sequence, so a pick id is unique across both tables and the dicts keyed by pick id in `pick_shortfalls` and `loan_inventory.replacement_picks` (`loan_inventory.py:349-370`) stay correct without a key change.
   - Picks are made when a side's copies are reserved and deleted at that side's Confirm swap. There is no `lent` state.
8. **Per-side swap confirmation.** `proposer_swap_at` and `recipient_swap_at` record each side's confirmation, as the Loan handover timestamps do. They are not states.

   State model:

   - `proposed` becomes `accepted` (recipient's Accept), or `closed` with `declined` (recipient), `withdrawn` (proposer), `countered` (recipient's Counter) or `cancelled` (unfriend, Block, account deletion).
   - `accepted` becomes `closed/cancelled` (either side, while both `*_swap_at` are NULL), or `closed/swapped` once both are set. It also closes as `swapped` when the side still to confirm has a deleted account and the other side has confirmed (Locks, cancel and ending a friendship).
   - A Counter closes the old row as `countered` and inserts a new `proposed` row with `countered_from = old.id`, both in one transaction.
9. **Migrations, trading block 140-179.** See [the Trading migrations note](../../migrations.md). Migrations 140-144 are additive and re-runnable. Migration 142 redefines `reserved_copies` and `check_loan_promises` (both from migration 106). Whoever merges second applies the 106 rule from the [social migrations note](../../../social-network/migrations.md): the last definition applied must be the union.

**Valid shapes of a proposal** (checked on send and Counter): at least one side gives at least one card. Otherwise the step answers 422 `TRADE_HAS_NO_CARDS`. A side may give nothing, so a gift in either direction is valid (question 5). A side that gives only cash requires `recipient.open_to_cash_offers`, else 409 `CASH_ONLY_NOT_OPEN`. That applies to both directions (buying and selling), because the map says "nobody can send them a proposal with only cash on one side". A Counter is a proposal sent to its recipient, so the Counter's recipient's setting applies too, with no exemption (question 6).

## Reservations

**Chosen:** migration 142 redefines `reserved_copies` as the union of the Loan part (unchanged) and a new Trade part, so `check_loan_promises`, every deferred trigger, `reserved_counts`, `reserved_by_owner` and every Python caller cover Trades with no parallel mechanism.

Today `reserved_copies(owners, editions)` in `migrations/106_loan_promises.sql` is "the one definition of reserved". `check_loan_promises(owner, edition)` is called by the deferred constraint triggers `holding_promise_guard_*`, `loan_promise_guard_trigger` and `loan_line_promise_guard_trigger`. Python reads it through `social/counts.py:27` `reserved_counts` and `:39` `reserved_by_owner`. Its callers include `moves.check_promises` (`api/app/moves.py:108-123`, which raises `PROMISED_TO_LOAN`), `copy_allocation.allocate` (`copy_allocation.py:271`), `deck_ownership.py:165`, `deck_pick_list.py:187`, `loan_inventory.can_promise` (`loan_inventory.py:277`) and `friend_copies` (`friend_copies.py:83`).

```sql
CREATE OR REPLACE FUNCTION trade_reserved_copies(owners text[], editions uuid[])
RETURNS TABLE(owner_id text, edition_id uuid, reserved bigint) LANGUAGE sql STABLE AS $$
  SELECT x.owner_id, x.edition_id, sum(x.quantity)::bigint FROM (
    SELECT t.proposer_id AS owner_id, l.edition_id, l.quantity FROM trade t JOIN trade_line l ON l.trade_id = t.id
      WHERE l.side = 'proposer' AND t.proposer_id = ANY(owners)
        AND t.state IN ('proposed','accepted') AND t.proposer_swap_at IS NULL
    UNION ALL
    SELECT t.recipient_id, l.edition_id, l.quantity FROM trade t JOIN trade_line l ON l.trade_id = t.id
      WHERE l.side = 'recipient' AND t.recipient_id = ANY(owners)
        AND t.state = 'accepted' AND t.recipient_swap_at IS NULL
  ) x WHERE editions IS NULL OR x.edition_id = ANY(editions)
  GROUP BY x.owner_id, x.edition_id
$$;
-- reserved_copies becomes: (migration 106's Loan SELECT) UNION ALL (SELECT * FROM trade_reserved_copies(owners, editions)),
-- summed again per (owner_id, edition_id). Same signature, so no caller changes.
```

- **Guards.** Add deferred constraint triggers that call `check_loan_promises(owner, edition)` for every reserving side's lines: `trade_promise_guard` on `trade` (`AFTER INSERT OR UPDATE OF state, proposer_swap_at, recipient_swap_at, proposer_id, recipient_id`) and `trade_line_promise_guard` on `trade_line` (`AFTER INSERT OR UPDATE OF quantity, edition_id, side`).
- Redefine `check_loan_promises`'s message to "Open Loans and Trades promise ...". Keep `CONSTRAINT = 'loan_promises_owned'` and SQLSTATE `23514`.
- **Where reserved copies sit** is read only from `loan_pick`, in three places today: `counts.reserved_picks` (`counts.py:55`), `loan_picks.pick_shortfalls` (`loan_picks.py:14`) and `counts.move_picks` (`counts.py:115`, called by Deck deletion and leaf conversion). `copy_allocation.spare_rule` (`copy_allocation.py:165`) places the reserved count at the picked Locations first (`EditionCopies.picked`).
- **Placement.** Add `reserving_picks(owners text[], editions uuid[]) RETURNS TABLE(kind text, loan_id uuid, trade_id uuid, pick_id bigint, owner_id text, edition_id uuid, source_location_id uuid, quantity bigint, reserved_at timestamptz)`. It is the reserved `loan_pick` rows of `RESERVING` Loans (`counts.py:22`), with `reserved_at = coalesce(accepted_at, created_at)`, UNION ALL the `trade_pick` rows of reserving Trade sides, with `reserved_at = created_at` for the proposer and `accepted_at` for the recipient. Switch the three placement readers to it:
  - `counts.reserved_picks` reads `reserving_picks`, so `spare_rule` places Trade-reserved copies at their picks and allocation never offers them elsewhere;
  - `loan_picks.pick_shortfalls` reads `reserving_picks` ordered by `reserved_at, kind, coalesce(loan_id, trade_id), pick_id`. The returned rows keep `loan_id` (NULL for Trade picks), so `stale_pick_loans` and `replacement_picks`, which filter on `pick['loan_id'] == loan_id`, are unchanged. Lend Offers and Loan accepts then never pick copies a Trade covers, and the other way round;
  - `counts.move_picks` also runs `UPDATE trade_pick SET source_location_id = %s WHERE owner_id = %s AND source_location_id = %s`.
- **When.** The sender's lines reserve on send and on Counter. The recipient's lines reserve on Accept. Both are released by decline, withdraw, Counter (the old proposal's sender), cancel, unfriend, Block and account deletion. Each side's reservation also ends at its own Confirm swap, in the transaction that removes the copies. There is no expiry (map).
- **What may be offered.** Every line a side gives must be at most that side's listable copies at the moment its copies reserve (send and Counter for the sender, Accept for the recipient), else 409 `NOT_TRADEABLE` with `{edition_id, available}`. Listable means on its Trade List (map: "What a collector offers: a Location marked For trade"). For the other side's lines on send or Counter, the cap is that Friend's listable copies through `friend_trade_copies`. Nothing of the Friend's is reserved until they accept.
- **Trade Pick List.** Picks are made at reservation: per Edition, For trade Locations first (largest Holding first, then name, then id), never from copies other reserving picks cover. Use `pick_shortfalls`' `covered` and `deck_pick_list.suggest` (`deck_pick_list.py:130`) over places filtered to For trade Locations. The listable cap guarantees enough. "Use suggested picks" may draw on any Location (For trade first, then the Deck Pick List order). Stale picks are computed, not stored, as for Loans.
- **Listable (own and Friend), one rule.** Per owner and Edition: `ft_held` is the sum of Holdings in `for_trade_locations`; `ft_picked` is the sum over For trade Locations of `least(reserving picks there, held there)`; `listable = greatest(0, least(ft_held - ft_picked, total_held - reserved))`. A Loan's or Trade's reserved copies picked from a Deck therefore do not shrink the Trade List, while stale picks can never over-list. Lent copies are not in `holding`, and Borrowed Copies are in `borrowed_holding`, which is never read.

**Rejected:** a separate `trade_reserved` mechanism or trigger set. It would leave a copy promisable once to a Loan and once to a Trade, which is exactly what the map forbids, and would add a second definition that every inventory reader would have to learn.

## Confirm swap

`POST /api/trades/{id}/confirm-swap {revision, idempotency_key, destination_id: UUID|null}` is in `trade_inventory.py` and runs through `run_trade_step`, under the confirmer's own owner lock only. It changes only the confirmer's inventory. The inventory writes available today, and why they need care:

- `moves.take_out` (`moves.py:130`) removes copies with Removal semantics and no Undo record. The lender's Loan handover uses it.
- `moves.put_back` (`moves.py:151`) inserts copies with `tcg.undo_returns_surplus='on'`, so arriving copies do not raise Deck List lines (migration 047). That is right for returns and wrong for newly owned copies.
- Copies leaving a Deck never lower its lines (`migrations/115_borrowed_deck_lists.sql:12`).

Steps:

1. If the confirmer gives cards and any of their picks is stale, the step answers 409 `PICKS_OUT_OF_DATE` and the collector uses `POST /api/trades/{id}/picks/use-suggested` (409 `PICKS_UP_TO_DATE` when nothing is stale). This mirrors the Loan handover (`loan_inventory.py:723-737`) (question 7).
2. **Copies given.** `moves.take_out(conn, user_id, items_from_own_picks, revision)`, the same write as the Loan handover: Removal semantics and no Undo record. Deck List lines are not lowered. Then `DELETE FROM trade_pick WHERE trade_id = %s AND side = <own side>`. The side's reservation ends in the same transaction, because the `trade` row write sets `<side>_swap_at`. The deferred invariant sees Holdings and promises fall by the same count.
3. **Copies received** (the other side's lines) arrive as new Holdings in `destination_id`, which must be one of the confirmer's Storage Leaves or Decks (`moves.leaf`, `moves.py:179`). It defaults to Unsorted (`deck_deletion.unsorted_leaf`), and a bad destination answers 404 `LOCATION_NOT_FOUND`. Use a new `moves.add_in(conn, user_id, location_id, items, revision) -> int`: the `put_back` upsert without `tcg.undo_returns_surplus`, so copies arriving in a Deck raise its lines as an Add does (migrations 031 and 047). It writes no Undo record and advances the owner revision. Receiving does not depend on the other account still existing, because it reads only `trade_line`.
4. Lower the confirmer's `trade_want` rows by the copies received per Edition, deleting rows that reach 0 (question 4).
5. Row columns: `{<side>_swap_at: NOW}`, plus `state='closed', closed_reason='swapped', closed_at=NOW, closed_by=user_id` when the other side already confirmed. In that case `record_trade_update(..., 'swapped')` goes to the other side.
6. Cash: nothing beyond the recorded amount. The app never handles money (map). Nothing about cash changes at confirm.

- **Not an Inventory Removal in the collector's eyes:** no Removal history row and no Undo slot, as with the Loan handover.
- **Not undoable.** A confirmed swap takes no Undo record, has no take-back (question 8) and nothing reverses it. Undo records older than the swap keep their usual checks (`UNDO_NOT_NEWEST`, `UNDO_INCOMPATIBLE`, `check_promises`), as after a Loan handover.
- **Giver short at confirm.** This cannot happen while the invariant holds. A stale pick answers 409 as above. `HoldingShort` from `take_out` is a bug and rolls back (500), as for Loans.
- **The other side's account deleted:** see the next section.

## Locks, cancel and ending a friendship

**Lock order (extends ADR 0014):** `inventory_owner` rows in ascending `user_id`, then `loan` rows in id order, then `trade` rows in id order. Today `social/owners.py:22` `lock_owners` locks `inventory_owner` rows `FOR NO KEY UPDATE` in ascending `user_id`, so foreign-key checks from the other collector's rows never wait on it, and `social/loans.py:553` `run_step` writes the `loan` row exactly once per transaction (a second write re-checks FKs and closed a deadlock cycle). `moves.lock_owner` (`moves.py:169`) is the single-owner `FOR UPDATE` lock that inventory commands use. Each Trade step writes its `trade` row exactly once (`write_trade`, a copy of `write_loan`, `loans.py:592`). Row locks are `FOR NO KEY UPDATE`. A deadlock the database ends anyway answers 503 `INVENTORY_TEMPORARILY_UNAVAILABLE`. Commands use `begin_command`'s pattern: advisory per-collector command lock, `location_command` replay, then count `'trade_command'` (120 per hour, `TOO_MANY_CHANGES`).

| Step | Route | Locks | Revisions advanced |
| --- | --- | --- | --- |
| Send proposal | `POST /api/trades` | proposer | proposer |
| Counter (recipient R of proposal from P) | `POST /api/trades/{id}/counter` | both | P (released) and R (reserved) |
| Accept | `POST /api/trades/{id}/accept` | recipient | recipient |
| Decline | `POST /api/social/trades/{id}/decline` | both | proposer |
| Withdraw (proposer, before an answer) | `POST /api/social/trades/{id}/withdraw` | proposer | proposer |
| Cancel an accepted Trade (either side, nobody confirmed) | `POST /api/social/trades/{id}/cancel` | both | both |
| Confirm swap | `POST /api/trades/{id}/confirm-swap` | confirmer | confirmer |
| Use suggested picks | `POST /api/trades/{id}/picks/use-suggested` | that side | that side |
| Unfriend or Block | inside the Friend command | both (already locked) | each side whose reservation was released |
| Reads, inbox | GET | none | none |

- **Send and Counter** check friendship with `friends.friend_ids` under the sender's lock, else 409 `NOT_FRIENDS`. Accept, decline and cancel need no friendship check, because unfriend and Block close every unconfirmed Trade first (below) and serialise on the owner locks.
- **Cancel rules (map).**
  - Before acceptance: the proposer withdraws; the recipient declines or counters.
  - After acceptance: either side cancels while both `*_swap_at` are NULL.
  - Once either side has confirmed, nobody can cancel, and the remaining side may only Confirm swap. A Counter is allowed only on a `proposed` row.
- **Unfriend and Block.** Today `social/friends.py:161` `friendship_ended` calls `social/loans.py:657` `end_loans_between`, inside the Friend command that already locked both owners; it cancels Loans nobody confirmed a handover for. `friendship_ended` also calls the new `social.trades.end_trades_between(conn, user_id, other_id)` after `end_loans_between`. It:
  - locks the pair's Trades in `('proposed','accepted')` with both `*_swap_at` NULL, `ORDER BY id FOR NO KEY UPDATE`;
  - closes each as `cancelled` by `user_id` and records a `'cancelled'` update for the other side, never why;
  - advances the revision of every side whose copies were reserved, once each.

  Trades with one confirmation stay open, and the remaining side can still confirm after a Block, which reveals nothing. Add `('.trades', 'end_trades_between')` to `ALLOWED_IMPORTS['social/friends.py']`. The Remove Friend and Block questions' counts of what gets cancelled must count Trades too. The copy belongs to the prototype ticket.
- **Account deletion** (the feature does not exist yet; add these requirements to the spec's account-deletion list):
  1. Cancel every unconfirmed Trade, as unfriend does.
  2. A Trade only the deleting side confirmed stays open for the other side to confirm alone. Their confirm works because it reads only `trade_line`.
  3. A Trade only the remaining side confirmed closes as `swapped`, since the remaining side's inventory already reflects the swap and nobody can finish it.
  4. `proposer_id` and `recipient_id` go NULL through `ON DELETE SET NULL`, and the names are kept.
  5. The existing `DELETE FROM inbox_update WHERE recipient_id = <id>` also covers Trade updates (Inbox).
  6. `trade_want`, `trade_accept` and `trade_pick` cascade with `inventory_owner`.
- **Edition reassignment does not carry Trades.** `catalog_reconciliation.reassign` (`catalog_reconciliation.py:190-245`) locks the reassigner plus the Loan counterparties from `replacement_parties` (`loan_inventory.py:1127`), then runs `follow_replacement` (`:1134`) and then `check_promises`. `check_promises` already counts Trade promises, so a reassignment that would break one is refused with `PROMISED_TO_TRADE`, and the collector swaps or cancels first.
  - Reasons: `follow_replacement` exists because handed-over Loans keep lines for copies outside `holding` for months. A Trade promise is always on copies still in `holding`, and a Trade is open only until the swap.
  - This keeps `replacement_parties` and the reassignment's lock set unchanged (`catalog_reconciliation.py:200-206`), with no new cross-owner locking.
  - Received copies of a deprecated Edition arrive as that Edition, and the existing replacement prompt offers to reassign them.
  - `trade_want` and `trade_accept` rows are not re-keyed (they name cards the collector does not own).

## Matching reads

All cross-collector Trade reads are in `social/friend_copies.py`, the module the guard already treats as the choke point (`READERS`). ADR 0015 updates ADR 0014's "one function" to "one module".

- **`friend_trade_copies(conn, viewer_id, friend_ids=None, edition_ids=None) -> list[TradeCopies(friend_id, edition_id, listable)]`.** One statement, `TRADE_READ` (`friend_copies.py:48` `READ` is the model: it drops hidden Locations, takes off reservations per Edition and applies `spare_rule`, returning only `(friend_id, edition_id, spare, in_deck)`):
  - only Friends (`friends_of`), with no Block either way;
  - Holdings of the Editions asked about;
  - For trade membership from `for_trade_locations(friends)`, with no hidden filter (map: a hidden For trade Location stays on the Trade List);
  - reservations from `reserved_copies` and placement from `reserving_picks`, aggregated per (friend, Edition) in SQL with the listable rule.

  It returns no Location id. It never reads `borrowed_holding`. `listable > 0` only.
- **`friend_wants(conn, viewer_id, friend_ids, edition_ids) -> list[FriendWant(friend_id, edition_id, need, origin: 'want_list'|'trade_wants', rule)]`** reads each Friend's own wants, restricted to `edition_ids`:
  - Want List part: each Friend's Want List combined-total need per Edition, computed exactly as their own Want List (their counting setting, Borrowed and lent copies, every Deck), leaving out lines of Decks inside Hidden Locations (question 2). Combine per Edition with `sum` (`all_at_once`) or `max` (`one_at_a_time`), as `want_list.combined` (`want_list.py:189`) does. The Will accept rule comes from `trade_accept`.
  - Trade Wants part: `trade_want` rows, with rule `edition`.
  - It never names a Deck. The field is `origin`, not "deck", because the contract guard forbids the word.
  - **Performance lever.** Allocation is independent per Edition (`copy_allocation.py:11`), so it is restricted to the candidate Editions that could match the viewer's Trade List: all Editions sharing a Card Identity with a listable Edition of the viewer's, the widest Will accept. Friends whose Deck Lists name none of them are skipped by a prefilter statement.
  - **No per-Friend allocate and no Friend lock, and the multi-owner SQL stays in the choke point.** `want_list.capture_want_list` (`want_list.py:158`) runs under the owner lock (`owner_and_rows`, FOR UPDATE) and calls `copy_allocation.allocate` (`copy_allocation.py:250`). `allocate` reads per owner: Holdings, Deck List lines, Deck `created_at`, `reserved_counts`, `reserved_picks`, `lent_counts`, `lent_picks` and `borrowed_in`. The counting setting is `inventory_owner.want_list_counting` (`settings.py:45`). First a figure-neutral refactor ticket splits `allocate` into:
    - a frozen dataclass `AllocationRows(holdings, lines, deck_created, reserved, picked, lent, lent_at, borrowed)`, the inputs one owner's allocation reads;
    - the single-owner reader `read_allocation_rows(conn, user_id, editions) -> AllocationRows`, which is today's reads moved unchanged;
    - the pure `allocate_rows(rows, editions, counting) -> Allocation`.

    `allocate(conn, user_id, editions, counting)` becomes `allocate_rows(read_allocation_rows(...), ...)` with unchanged figures, and the existing Want List, Deck cost and import tests are the proof. No multi-owner reader is added to `copy_allocation`, `counts` or `borrowed_copies`. `friend_wants` builds one `AllocationRows` per prefiltered Friend from its own batched statements in `friend_copies.py` (`WANTS_READ`, `owner_id = ANY(%s)` over `holding`, `deck_list_line`, Deck `created_at` from `location`, `inventory_owner.want_list_counting`, the Friends' own `borrowed_holding` in their Decks, lent picks) plus `counts.reserved_by_owner` and `reserving_picks`. It then calls the pure `copy_allocation.allocate_rows`, all inside one `REPEATABLE READ READ ONLY` transaction: one snapshot, no locks, so a Friend read never waits on a Friend's writes. ADR 0014 forbids allocation once per Friend; this reads once for all of them. `WANTS_READ` may read `borrowed_holding`, because Borrowed Copies fill the Friend's own Deck lines, but it returns only needs. `test_the_choke_points_statement_never_reads_borrowed_holdings` keeps checking `READ` and adds `TRADE_READ`, not `WANTS_READ`.
- **Expansion for Will accept** (new and separate from `reach` in `social/friend_reads.py:146`, whose `'exact'` already means "any finish" and which also has `'reprint_group'`): `accepts(conn, wanted: dict[edition, rule]) -> dict[wanted_edition, set[edition]]`, in `social/friend_reads.py` beside `REACH`:
  - `edition` gives `{w}`;
  - `printing` gives every Edition of `w`'s Card Printing;
  - `identity` gives every Edition of every Card Printing with `w`'s `identity_id` (`catalog_printing.identity_id`, `friend_reads.py:96-104`) (question 9).

  It does not involve the counting setting. Trade Wants always use `edition`.
- **`GET /api/social/trade-matches`** (`trade_matches.py`) runs in this order:
  1. Viewer's wants: `want_list.capture_want_list(user_id)` under the viewer's own lock (as `friend_reads.wanted_editions`), plus `trade_wants.own_wants`. Each want is `(edition, need, origin, rule)`.
  2. Viewer's Trade List: `trade_list.own_trade_copies(conn, user_id)`, an own read in the inventory module `api/app/trade_list.py` that also backs `GET /api/trades/list`.
  3. On a separate connection in one `REPEATABLE READ READ ONLY` transaction, call `friend_trade_copies(viewer, None, union of accepts(viewer wants))` and `friend_wants(viewer, None, candidate Editions of the viewer's Trade List)`.
  4. Pair the results in memory.

  Response `TradeMatches { has_friends, rows: [TradeMatchRow] }`. Each `TradeMatchRow` has:
  - `collector_id`, `handle`, `display_name`, `open_to_cash_offers`;
  - `match: 'two_way'|'has_what_you_want'|'wants_what_you_have'`;
  - `you_get: [TradeMatchCard]`, the Friend's listable copies that some viewer want accepts, each with card facts, `copies`, `your_need`, `origin` and `accepts_as: 'exact'|'any_finish'|'same_name'`;
  - `you_give: [TradeMatchCard]`, the viewer's listable copies that the Friend's wants accept, with `their_need` and `origin`;
  - `more_you_get`, `more_you_give` as counts.

  Rows are sorted two-way first, then has-what-you-want, then wants-what-you-have, then by Display Name and Handle. Each row carries at most 20 cards per side, and `GET /api/social/trade-matches/{collector_id}` returns the full lists for one Friend. There are no values in discovery (map). Add `TradeMatchCard.descriptor` to `OPAQUE`.
- **`GET /api/social/trade-lists/{handle}`** is a Friend's whole Trade List, for the composer to add cards beyond the matches. It mirrors `friend_collection` (`friend_reads.py:171`): the same `FRIEND_BY_HANDLE` 404 `FRIEND_NOT_FOUND` rule, paging by Card Identity, and `q`.
- **`GET /api/social/trade-card-matches?printing_id=`** backs the card popup's Ask to trade: Friends with listable copies of the Printing's Editions.
- **Privacy guard changes** (`api/tests/test_social_contract.py`):
  - add `trade_want|trade_accept` to `INVENTORY_TABLE`, so in the social area only `friend_copies.py` reads them (`READERS` unchanged);
  - add `test_only_the_choke_point_reads_several_owners_inventory`: it scans every `api/app/**/*.py` outside `social/friend_copies.py` and fails on SQL that filters `holding`, `deck_list_line`, `location` or `borrowed_holding` with `owner_id = ANY(` or `borrower_id = ANY(` (string constants only, as `inventory_reads` does). It allows the existing single-owner readers and `counts.reserved_by_owner`, which reads only Loan and Trade tables;
  - add `('..copy_allocation', 'allocate_rows')` and `('..copy_allocation', 'AllocationRows')` to `ALLOWED_IMPORTS['social/friend_copies.py']`, beside the existing `('..', 'copy_allocation')`;
  - add `for_trade_locations\s*\(` to `HIDDEN_CALL`;
  - add `ALLOWED_IMPORTS['social/trades.py']` = `('..trade_picks','stale_pick_trades')`, `('..main','connect')`, `('..main','verified_user')`, `('..location_tree','error')`, `('..location_tree','replay')`, `('.friend_reads','card_facts')`, `('.owners','ensure_owner')`, `('.owners','lock_owners')`, `('.loans','advance_revision')`, `('.loans','NOW')` and `('.friends','friend_ids')`. Trades do not reuse `count_loan_command`; `social/trades.py` defines its own `count_trade_command` under kind `'trade_command'`. Because `social/friends.py` imports `end_trades_between` from `social/trades.py`, `trades.py` imports `friend_ids` inside the function that needs it, as `loans.loan_views` does (`loans.py:444`);
  - add `ALLOWED_IMPORTS['social/trade_matches.py']`, with `('..trade_list','own_trade_copies')`, `('..trade_wants','own_wants')`, `('..want_list','capture_want_list')`, `('.friend_copies','friend_trade_copies')`, `('.friend_copies','friend_wants')`, `('.friend_reads','card_facts')`, `('.friend_reads','accepts')`, plus the `connect`, `verified_user` and `error` entries;
  - leave `FRIENDS_OF_READERS` unchanged: `trade_matches` gets the viewer's Friends through `('.friends','friend_ids')` (add that import entry) and reads `collector_profile` for those ids only, so it never calls `friends_of` itself;
  - add `OPAQUE` entries for `TradeCard.descriptor` and `TradeMatchCard.descriptor`;
  - extend `test_every_social_route_answers_success_with_a_schema_the_walk_reads` with the new routes;
  - add `test_the_trade_statement_never_reads_borrowed_holdings` (`'borrowed_holding' not in friend_copies.TRADE_READ`).
- **Friend count assumption.** Nothing in the repo states one. Design target: 200 Friends, 2,000 listable Editions and 60 Decks per collector, `GET /api/social/trade-matches` p95 at most 1.5 s on the verification host. The spec requires a `slow` (`capacity:`) test that seeds this and measures it, marked `serial` because it bounds time.

## Value cues

`POST /api/trades/value` (`trade_value.py`):

- Body: `{lines: [{side: 'you_give'|'you_get', edition_id, quantity}]}`, at most 100 lines, duplicates refused with 422 `DUPLICATE_EDITION` per side.
- It calls `prices.private_edition_quotes(editions, budget, releases)` (`prices.py:195`, an access under ADR 0006 that needs a gateway `Budget`) once and folds each side with `deck_cost.summarize`, the shared fold.
- It answers `TradeValue { you_give: SideValue, you_get: SideValue }`, where `SideValue = {status: 'priced'|'empty'|'no_quotes'|'incomplete', display_total: str|None, priced_copies: str, total_copies: str}`.
- No `provider_*`, `checked_at`, `refresh` or source name ever appears in the response. `QuoteView` carries `provider_updated_at` and `checked_at`, which must never reach a collector's screen.
- It is a POST, so unsaved drafts and Counters can be valued too. Cash is not part of it (no suggested cash, per the map).
- Add `('POST', re.compile(r'^/api/trades/value$'))` to `price_budget.BUDGETED_ROUTES` and the same pattern to `BUDGETED_ROUTES` in `auth/src/server.ts` (~line 60). The two lists must change together.

**Rejected:** calling `POST /api/prices/editions` from the client. Its 64-Edition cap is below a full proposal (100 lines), it exposes quote metadata to the screen code, and it would put the money arithmetic in the client instead of the shared exact fold.

## Inbox

Today `migrations/130_inbox.sql` creates `inbox_update(id, recipient_id [no FK on purpose], kind CHECK(...), loan_id NOT NULL FK, other_name, created_at, read_at, dismissed_at)`; `social/inbox.py:65` defines `InboxWaiting(LoanView)`; `:138` reads event updates with `JOIN loan o ON o.id = u.loan_id`; `/read` and `/clear` take bare update UUIDs (`_split`, `:153`); and the web bell badge is `view.waiting.length` (`web/src/inbox/Inbox.tsx:156`).

- **Migration 144:**
  - `ALTER TABLE inbox_update ALTER COLUMN loan_id DROP NOT NULL`;
  - `ADD COLUMN trade_id uuid REFERENCES trade(id) ON DELETE CASCADE` (the step holds the trade row, so the key check never waits);
  - `ADD CONSTRAINT inbox_update_one_subject CHECK (num_nonnulls(loan_id, trade_id) = 1)` (precedent: `migrations/023_metadata_review.sql:185`);
  - `CREATE INDEX inbox_update_trade ON inbox_update(trade_id)`;
  - widen the kind CHECK with `'swapped'`.

  An older API build's `JOIN loan o ON o.id = u.loan_id` skips Trade rows, so deploying in either order is safe.
- **Waiting on you** is derived, nothing is stored, and there is one line per Trade. `social/trades.waiting_trade_step` returns, in order:
  - `answer`: the reader is the recipient of a `proposed` row; a Counter is the same step, and the view's `countered_from` lets the screen say "countered";
  - `fix_picks`: `accepted`, the reader has not confirmed, and their picks are stale (`trade_picks.stale_pick_trades`);
  - `confirm_swap`: `accepted`, the other side confirmed and the reader has not.

  An accepted Trade nobody has confirmed is not waiting on either side, as for an accepted Loan. `since` is `created_at`, the stale-pick fallback `accepted_at`, or the other side's `*_swap_at`.
- **Updates** are stored through `record_trade_update(conn, row, actor_id, kind)` (a copy of `loans.record_update`, `loans.py:631`, writing `trade_id`):
  - `accepted` goes to the proposer;
  - `declined` goes to the proposer;
  - `cancelled` goes to the other side, for cancel, withdraw, unfriend, Block or deletion; withdraw reads as `withdrawn` from `closed_reason`, as for Loans;
  - `swapped` goes to the side that confirmed first, when the second confirms.

  A Counter stores no update, because the new proposal is the reader's `answer` line. There are no time-based Trade updates (no expiry, no nudge decided).
- **Response, additive:** `InboxView` gains `trade_waiting: list[InboxTradeWaiting]` (a `TradeView` plus `since`) and `trade_updates: list[InboxTradeUpdate {id, kind, trade_id, trade_state, role, other_name, read, at}]`, newest first, at most 50.
  - The existing `waiting` and `updates` and their tests are unchanged.
  - `/read` and `/clear` work unchanged, because Trade update ids are `inbox_update` UUIDs (`_split`, `inbox.py:153`), and `_prune` covers them.
  - The web merges the lists by time. The bell badge becomes `waiting.length + trade_waiting.length`, one per Loan or Trade that needs the collector.
  - `GET /api/social/trades` returns `TradesView {trades, needs_you}` for whichever screen lists Trades.

## Error codes and writers

- **`PROMISED_TO_TRADE`** (409, detail `{edition_id, promised}`). `moves.check_promises` (`moves.py:108`) keeps one combined check: `promised` is Loans plus Trades from `reserved_counts`. It answers `PROMISED_TO_TRADE` when `counts.trade_reserved_counts(conn, owner, [edition])` (new, reading `trade_reserved_copies`) is above 0 for the refused Edition, and `PROMISED_TO_LOAN` otherwise, so every existing test and screen stays the same.
  - Callers that inherit it: Inventory Removal, Undo of an add, and Edition reassignment.
  - The web must map it at the four sites where `PROMISED_TO_LOAN` is mapped today (`web/src/catalog/catalogText.ts:151`, `web/src/workspace/inventoryActionsModel.ts:203`, `web/src/workspace/useInventoryActions.ts:440` and `web/src/EditionCorrections.tsx:45`), with plain sentences, worded in the prototype ticket.
- **New codes:**

  | Code | Status | When |
  | --- | --- | --- |
  | `NOT_TRADEABLE` | 409 | `{edition_id, available, side}` |
  | `TRADE_NOT_FOUND` | 404 | also for non-parties |
  | `TRADE_CHANGED` | 409 | stale revision |
  | `TRADE_HAS_NO_CARDS` | 422 | no side gives a card |
  | `CASH_ONLY_NOT_OPEN` | 409 | a cash-only side to a collector not Open to cash offers |
  | `INVALID_CASH` | 422 | out of range, or payer missing or extra |
  | `DECK_NOT_FOR_TRADE` | 409 | marking a Deck For trade |
  | `LOCATION_FOR_TRADE_BY_PARENT` | 409 | un-marking inside a marked ancestor |

- **Reused codes:** `STEP_NOT_ALLOWED`, `NOT_FRIENDS`, `OWN_ACCOUNT`, `DUPLICATE_EDITION`, `TOO_MANY_LINES`, `INVALID_QUANTITY`, `PICKS_OUT_OF_DATE`, `PICKS_UP_TO_DATE`, `LOCATION_NOT_FOUND`, `TOO_MANY_CHANGES`, `INVENTORY_TEMPORARILY_UNAVAILABLE`.
- **Writers:**

  | Writer | Treatment |
  | --- | --- |
  | Moves | unchanged; a Location does not matter to a promise. Moving a picked copy makes the pick stale |
  | Inventory Removal, Undo, Edition reassignment | refuse via `check_promises` |
  | Deck deletion, leaf conversion | `counts.move_picks` re-keys `trade_pick` too |
  | Location deletion | refuses Holdings as today; a deleted pick source sets NULL, and the pick is stale |
  | Hide or show | unchanged; independent of For trade |
  | Add, batch add, Collection Import, Decklist Import | unchanged |
  | `copy_allocation`, `deck_pick_list`, `deck_ownership`, `swap_hints`, `available_to`, the Want List | figures follow `reserved_counts` and `reserved_picks`, so Trade-promised copies stop being Spare Copies as Loan-promised ones do, with no code change |
  | `friend_copies` (lend view) | a Trade-promised copy is no longer lendable (`reserved_by_owner`) |
  | `loan_inventory.can_promise` and Lend Offer caps | see Trade promises through `reserved_counts` and `pick_shortfalls` |
  | `counts.deck_loan_picks` ("reserved for Sam" on Deck lines) | stays Loan-only in Stage 1; a Trade pick in a Deck appears only after Use suggested picks (see "Not yet specified") |

## Glossary

[`CONTEXT.md`](../../../../CONTEXT.md) gains nine entries after **Write-off**, in this order: **Trade**, **Trade Proposal**, **For trade Location**, **Trade List**, **Trade Wants**, **Will accept**, **Trade Pick List**, **Confirm swap** and **Open to cash offers**. Three existing entries are amended so the glossary does not contradict itself:

- **Spare Copy**: "isn't promised to a Loan" becomes "isn't promised to a Loan or a Trade".
- **Friend**: Friends can also see each other's Trade Lists, and can lend and trade each other cards.
- **Hidden Location**: a hidden For trade Location's copies still appear on its owner's Trade List, though never its name.

The **Loan** entry stays word for word, including `_Avoid_: Trade, gift, transfer`, because a Loan is not a Trade.

Use these terms everywhere: "Trade Proposal", not "offer". "Promised", not "held". "Confirm swap", not "complete".

## Testing

Tests use the same seams as the social spec: signed HTTP against PostgreSQL, then a real-PostgreSQL concurrency seam, then Playwright with two-collector contexts (`web/tests/support/collectors.ts`). Prior art: `test_loans.py`, `test_loan_promises.py`, `test_lend_offers.py`, `test_ending_friendship.py`, `test_friend_copies.py`, `test_inbox.py`, `test_social_contract.py`.

1. **The Spare Copy and allocation refactor is figure-neutral:** `read_allocation_rows` and `allocate_rows` reproduce every existing figure. The existing Want List, Deck counting, cost and import test files pass unchanged.
2. **Promise invariant (`test_trade_promises.py`, real PostgreSQL):**
   - `reserved_counts` sums Loan and Trade promises, and a copy promised to a Loan cannot be put in a proposal (`NOT_TRADEABLE`), or the other way round (`can_promise`);
   - Removal, add Undo and reassignment refuse with `PROMISED_TO_TRADE` (and still `PROMISED_TO_LOAN` with only Loans);
   - Moves are free and make picks stale;
   - a direct SQL write that breaks the invariant fails at commit through the `trade` and `trade_line` triggers;
   - Deck deletion and leaf conversion carry `trade_pick`;
   - Lend Offers never pick copies a Trade covers;
   - two concurrent sends, or a send racing an accept, for the same copies: one succeeds and the sums hold.
3. **Trade steps (`test_trades.py`):**
   - every state and closed reason;
   - Counter closes, reopens prefilled, swaps the reserved side and checks `countered_from`;
   - accept and decline are whole only;
   - cancel is allowed only while nobody has confirmed;
   - a half-confirmed Trade allows only Confirm swap for the other side;
   - `TRADE_CHANGED` on a stale revision;
   - idempotent replay;
   - the 120-per-hour limit;
   - every shape rule (`TRADE_HAS_NO_CARDS`, a gift with nothing on one side accepted, `CASH_ONLY_NOT_OPEN` both directions and on a Counter whose recipient is not Open to cash offers, `INVALID_CASH`, cash alongside cards always allowed);
   - lines capped at listable copies, with a hidden For trade Location counting, a Deck inside a For trade Location never counting, and Borrowed Copies never counting.
4. **Confirm swap (`test_trade_swap.py`):**
   - given copies leave their picks with no Undo record and Deck List lines unchanged;
   - received copies land in the destination (or Unsorted) and raise a Deck's line;
   - totals change on both sides only after each side's own confirm;
   - stale picks give `PICKS_OUT_OF_DATE`, then Use suggested picks;
   - Trade Wants drop by copies received;
   - the second confirm closes the Trade as `swapped`;
   - confirming alone after the other's account is gone, and after a Block;
   - an older Undo record behaves as after a Loan handover.
5. **Ending a friendship (extend `test_ending_friendship.py`):**
   - Remove Friend and Block cancel unconfirmed Trades and release both sides' reservations with the right revisions;
   - half-confirmed Trades stay;
   - the update reads "cancelled" with no reason, and is byte-identical for unfriend, Block and a plain cancel.
6. **Privacy (`test_trade_matches.py`, extend `test_social_contract.py`):**
   - non-Friends, a Blocked collector either way and pending requests see no Trade List and no wants;
   - promised copies leave the Trade List at once, and copies come back when released;
   - wants from Decks in Hidden Locations are absent (question 2);
   - no `/api/social` trade response has a Location or Deck field;
   - only `friend_copies.py` reads `trade_want`, `trade_accept` or calls `for_trade_locations` in the social area;
   - `TRADE_READ` never reads `borrowed_holding`.
7. **Matching:**
   - two-way, has-what-you-want and wants-what-you-have ordering;
   - each Will accept rule (exact Edition only; any finish; same Card Identity including other Printings);
   - Trade Wants are always exact;
   - `origin` is `want_list` or `trade_wants`;
   - a Friend's need follows their counting setting;
   - the 20-card cap with `more_*` counts and the full per-Friend read;
   - Open to cash offers on the row;
   - no values in discovery.
8. **Capacity (`slow`, `capacity:`, `serial`):** 200 Friends x 2,000 listable Editions x 60 Decks; `trade-matches` p95 at most 1.5 s.
9. **Value (`test_trade_value.py`):** exact micro-dollar fold per side; statuses; the response schema has no `provider_*`, `checked_at`, `refresh` or source name; the route is budgeted (401 without a budget, as `want-list/cost`).
10. **Inbox (extend `test_inbox.py`):**
    - `answer`, `fix_picks`, `confirm_swap` and their `since`;
    - the four stored kinds with `withdrawn` read from `closed_reason`;
    - Trade updates clear and read through the existing routes and are pruned after 90 days;
    - an old-style query (inner join on `loan`) ignores Trade rows;
    - Loan inbox output is byte-identical with no Trades.
11. **Concurrency (real PostgreSQL, opposite directions):**
    - Counter versus withdraw;
    - cancel versus Confirm swap;
    - both Confirm swaps at once;
    - unfriend while an accept runs;
    - Lend Offer versus Trade send for the same copies.

    None deadlocks, and the right revisions move.
12. **Browser:**
    - A marks a binder For trade; B sees a two-way row and proposes from it; A counters with cash; B accepts; each confirms the swap; ownership has moved on both sides.
    - The card popup's Ask to trade.
    - A cash-only proposal refused, then allowed after Open to cash offers is turned on.
    - The Trade screen shows the liability notice.
    - Phone width, and the accessibility checks the social spec lists.

## Not yet specified

Left to the prototype ticket:

- where Trades are listed (a tab, or inside Loans);
- the destination picker's default for received copies;
- the wording of `PROMISED_TO_TRADE` and of the Remove Friend and Block counts;
- the liability notice (its own candidate ticket; it needs someone qualified to check it before launch);
- Deck-line "promised in a Trade" labels (Deck lines show Loan reservations only in Stage 1);
- nudges for unanswered proposals;
- Edit and resend for proposals.

Risks to carry into the spec and tickets:

- **The `reserved_copies` redefinition is the riskiest change.** Every inventory figure reads it. The implementation ticket must land the allocation refactor and this redefinition with figure-neutral tests (no Trades present means identical figures), and must check the 106 redefinition rule when merging.
- **Pick ids across two tables.** Sharing `loan_pick_id_seq` keeps `pick_shortfalls`' dict keys unique. The reviewer should confirm no code assumes a pick id is a `loan_pick` row id; `loan_inventory.replacement_picks` filters by `loan_id` first.
- **Lock order.** Unfriend now cancels Loans then Trades inside one Friend command: owners, then `loan` rows, then `trade` rows. Any future step touching both a Loan and a Trade must keep that order.
- **The Friend Want List read is the first cross-collector use of `allocate`.** It must stay inside `friend_copies.py`, run lock-free in one snapshot, and return only `(friend, Edition, need, origin, rule)`.
- **Reservations never expire** (map). A half-confirmed Trade whose remaining side never confirms keeps that side's copies promised indefinitely. Surfacing it is only the `confirm_swap` waiting line.
- **Deploy order.** Migrations 140-144 are additive. An older API build ignores Trade inbox rows and sees `reserved_copies` with no Trades. Deploy migrations first.
- **Gateway allowlist.** `/api/trades/value` must be added to `auth/src/server.ts` as well as `price_budget.py`.
