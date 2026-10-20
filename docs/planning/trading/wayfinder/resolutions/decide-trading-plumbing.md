# Decide the Trading plumbing: module boundary, reservations and ownership transfer

Resolves the candidate ticket "Decide the module boundary, ownership-transfer plumbing and glossary terms" of the [Trading decision map](../map.md) on 2026-10-17. The owner delegated the technical plumbing, which Claude decided. The map is the authority on what collectors see; where it is silent and a plumbing choice would change what collectors see, the choice is listed under "What collectors see" with the default this resolution assumes. The cross-owner pattern is recorded in [ADR 0015](../../../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md), which extends [ADR 0014](../../../../adr/0014-friend-reads-and-two-owner-loans.md). It builds on the [social module boundary](../../../social-network/wayfinder/resolutions/decide-social-module-boundary.md). Migration numbers are in [the Trading migrations note](../../migrations.md).

## What collectors see

The nine questions below were put to the owner with a default each. On 2026-10-19 the owner allowed gifts (question 5) and approved the other eight defaults as written.

1. **A Deck inside a For trade Location.** **Owner's choice (2026-10-19):** its cards are not on the Trade List; Decks never are. Alternative: they are, which removes the Deck exclusion from `for_trade_locations`. Dependent: Data model 1, and the Trade step tests in Testing.
2. **Wants from a Deck in a Hidden Location.** **Owner's choice (2026-10-19):** Friends do not see them in trade discovery. Lines of Decks inside Hidden Locations are left out of what Friends read. The collector's own matching still uses every want. Dependent: Matching reads, and the privacy tests.
3. **Will accept scope.** **Owner's choice (2026-10-19):** one choice per card (Card Edition), wherever it appears on the Want List, not per Deck. Dependent: Data model 3.
4. **Trade Wants quantity.** **Owner's choice (2026-10-19):** a line goes down at Confirm swap and is deleted at 0. **Refined by the owner on 2026-10-19:** a Trade Wants line adds to the Want List's need for the same Card Edition, and received copies of that Edition fill the Deck needs first, so the line goes down only by the copies left over. Example: the Decks need 2, Trade Wants say 4, and 3 copies arrive; the Decks get 2 and the line goes from 4 to 3. Discovery shows the combined count with the Deck part, for example "6 wanted (2 for Decks)". Dependent: Data model 2, Confirm swap step 4, Matching reads, and the Confirm swap and Matching tests.
5. **Gifts.** **Owner's choice (2026-10-19):** gifts are allowed. A proposal may have cards on one side and nothing (no cards, no cash) on the other. Only a proposal with no cards on either side is refused, with `TRADE_HAS_NO_CARDS`, so a Trade is never cash for nothing. Dependent: the shape rules under Data model.
6. **Counters and the cash-only rule.** **Owner's choice (2026-10-19, reversed from the first default after the prototype):** a collector who is not Open to cash offers sends "my $10 for your card"; the other side CAN counter with "$15". The `CASH_ONLY_NOT_OPEN` check is skipped on a Counter when the countered proposal already had a cash-only side (either side), because the Counter's recipient put cash on the table. It still applies to a Counter whose countered proposal had no cash-only side. Dependent: the shape rules under Data model.
7. **Out-of-date picks at Confirm swap.** **Owner's choice (2026-10-19):** refuse and ask the collector to Use suggested picks, as Loans do. Alternative: re-pick automatically at confirm. Dependent: Confirm swap step 1.
8. **Take back a Confirm swap.** **Owner's choice (2026-10-19):** no. It is final for that side, which fits "no partial swap" and "not undoable". Alternative: allow take-back before the other side confirms, which adds a take-back step and an `allowed` entry.
9. **"Same name" across languages.** **Owner's choice (2026-10-19):** Will accept "any card with the same name" uses Card Identity as defined, which may include Printings in other languages that the catalog links to the same identity. Dependent: the `accepts` expansion under Matching reads.

Not blocking, left to the prototype ticket (listed again under "Not yet specified"): where Trades are listed, the destination picker's default for received copies, the wording of `PROMISED_TO_TRADE` and of the Remove Friend and Block counts, whether and how an Undo of a Deck switch is offered after Confirm swap, and the liability notice.

### Later decisions (2026-10-19)

These came after the nine questions, so they are not numbered with them.

- **Switching a Deck line to a card Will accept takes.** **Owner's choice (2026-10-19):**
  - **At Confirm swap.** When a copy the confirmer receives arrived only through a widened Will accept rule (any finish, or the same Card Identity) for a want that came from a Deck's Deck List line, the confirm step offers to switch that Deck List line. A switch lowers the line's Edition by the copies and raises or adds the received Edition's line by as many, per Deck, oldest Deck first, never more than that line still needs. The web shows each offer ticked by default (`Use for <Deck> instead of <card>?`) and the collector can untick it. Dependent: Confirm swap steps 1, 3b and 4, and the Confirm swap tests.
  - **Spare copies already owned.** The Want List's existing Swap hint (today it offers other Editions in the line's Reprint Group that the counting setting makes available) also considers the Editions the line's Will accept rule accepts, with the same one-pass, never-offered-twice rules and the same Deck List changes batch. With Will accept left at "this exact card" the hints are unchanged and every existing Swap hint test passes unchanged. Dependent: Matching reads and the Swap hint tests.
  - **Matching.** **Owner's choice (2026-10-19):** until a switch is made, the collector's own spare copies of Editions their Will accept rule accepts do not reduce the need in discovery. The Swap hint is how they make those copies count. This holds for the viewer's own wants and for `friend_wants`.
- **F3 (independent review, 2026-10-19), and the owner's answer.** The scenario: a collector's Deck needs 1 copy of card A, their Will accept for A is "any card with the same name", and they already own a spare copy of B, another Edition of the same Card Identity that no Deck line holds. Discovery shows the collector still wanting A, so a Friend offering A matches although the collector holds an acceptable card. **Owner's choice (2026-10-19):** that is intended. Owned spares do not reduce the need in discovery. The collector makes the spare count by taking the Swap hint, which switches the Deck line from A to B, and the need then falls. The scenario is the writer's reconstruction of F3 from the owner's answer, not a quotation of the review, and the orchestrator should check it against the review.
- **Plumbing (orchestrator, delegated, 2026-10-19):**
  - The own-inventory side gains a read of the candidate switches under `/api/trades`, never `/api/social`. Confirm swap's body takes an optional list of chosen switches. A switch that the step cannot match to its own computation refuses the whole step with 409 `DECK_SWITCH_CHANGED`. A switch is applied with the Deck List changes batch logic in the same transaction, under the confirmer's own lock.
  - Writer's proposals within that (to confirm): the candidates are a field `deck_switches` of the existing side read `GET /api/trades/{id}/side` rather than a new route; the batch's write part is extracted and shared rather than the route being called; the helper is named `deck_switch_candidates`; the cap on chosen switches is 50. They never go into `TradeView` or any `/api/social` response.
  - A gift plus cash is allowed and one Edition on both sides is refused (Valid shapes); hidden Decks' wants are allocated with every Deck and then dropped (Matching reads).
- **Points settled by the orchestrator (delegated plumbing, 2026-10-19)** after the writer raised them:
  1. The Deck List changes batch's write part is extracted as a function that takes the connection and runs no lock, replay or revision check. The route keeps its own lock and checks and calls it; Confirm swap calls it under `lock_owners`.
  2. When the destination is a Deck `D`, the received copies are already committed to `D`'s line of the received Edition by `add_in`, so switch candidates for those copies are offered for `D` only, and such a switch only lowers `D`'s original line. Copies sent to a Deck are never offered as switches into another Deck.
  3. Under "One Deck at a time" counting, the copies switched across all Decks total at most the copies available for switching, allocated oldest Deck first.
  4. `accepts` lives outside the social area, in `api/app/card_accepts.py` (Trading #275), which `swap_hints` imports and, from Trading #276, the social matches module (`ALLOWED_IMPORTS['social/trade_matches.py']` lists `('..card_accepts','accepts')`) and from #279 Confirm swap's Deck switches. It was never in `social/friend_reads.py`, so no `ALLOWED_IMPORTS` entry was replaced.
  5. The implementation ticket checks whether a Want List revision pin or the Mass Entry 409 hashes the Swap hint. If one does, a pin that changes when the collector widens Will accept is acceptable, because the hint changed. **Checked (Trading #275):** none does. The pins the Want List answers carry and the Mass Entry, export and cost routes compare are `owner_revision`, `settings_revision` and `deck_lists_digest`, read from the inventory, the settings row and the Deck List lines; none reads `trade_accept` or the hints, so widening Will accept moves no pin, and a download at the pins read before the change still succeeds (`test_trade_wants.py`). The Want List page reads the Want List again after a choice so the hints follow it.
  6. The Swap hint with Will accept widened applies even when the line's Printing is in no Reprint Group ("No group, no hint" is relaxed only for Editions the rule accepts).
  7. At most 50 chosen switches per step (`MAX_TRADE_LINES`), else 422 `TOO_MANY_LINES`, which keeps the body under the gateway limit.
  8. Exact wants come before widened ones: received copies of `E` fill the Decks' lines of `E`, then the Trade Wants line for `E`, and only the copies left after both are offered as switches. A copy the collector asked for by name in Trade Wants did not arrive "only through a widened rule".

## Module boundary

Trading lives in the `social` area and follows the Loan split exactly. The social area is split today between `api/app/social/loans.py:84`, which serves `/api/social/loans` (the shared Loan facts and the steps that change no inventory), and `api/app/loan_inventory.py:83` (`APIRouter(prefix='/api/loans')`), which serves the steps that read or write one collector's own inventory. The contract guard `api/tests/test_social_contract.py` enforces the split: `READERS` (line ~38) lets only `social/friend_copies.py` and `social/hidden_locations.py` name `holding|deck_list_line|deck_list|location|borrowed_holding` in SQL; `ALLOWED_IMPORTS` lists every app import each social module may use; `FRIENDS_OF_READERS` lists the only modules that may call `friends_of`; and the OpenAPI walk refuses any `/api/social` response field or component whose name contains `location`, `locations`, `deck`, `decks`, `leaf`, `leaves`, `unsorted`, `binder`, `shelf` or `storage` (`FORBIDDEN`), with `in_deck` the one exception (`ALLOWED`) and free-form objects allowed only when listed in `OPAQUE`.

| Module | Prefix | Owns |
| --- | --- | --- |
| `api/app/social/trades.py` | `/api/social/trades` | TradeView, `TradeStep`, list and read, decline, withdraw, cancel, `run_trade_step`, `write_trade`, `close_trade`, `end_trades_between`, `TRADES`, `trade_facts`, `trade_views`, `record_trade_update`, `waiting_trade_step`, `trade_waiting_since`, the `allowed` rule, and Open to cash offers (`GET/PUT /api/social/trade-settings`, declared in this module with its own path) |
| `api/app/social/trade_matches.py` | `/api/social` | `GET /trade-matches`, `GET /trade-lists/{handle}`, `GET /trade-card-matches?printing_id=` |
| `api/app/social/friend_copies.py` (extended) | none | adds `TRADE_READ` + `friend_trade_copies`, and `friend_wants`, the only cross-collector Trade reads |
| `api/app/trade_inventory.py` | `/api/trades` | send, counter, accept, confirm swap, use suggested picks, own side view (`GET /api/trades/{id}/side`, which also returns the reader's Deck switch candidates as `deck_switches`) |
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
   - At most 500 lines per owner (422 `TOO_MANY_LINES`, the status every line cap in Loans and Trades uses, `loan_inventory.py:475`).
   - `PUT /api/trade-wants/{edition_id} {quantity}` sets the line, and `"0"` deletes it. It is idempotent by value, so it needs no key.
   - The quantity means "copies I want to receive beyond what my Decks need". It adds to the Want List's combined need for the same Edition: wanted in total = Want List need + Trade Wants quantity. Confirm swap fills the Deck needs first and lowers the line only by the copies left over (Confirm swap step 4, question 4).
3. **Will accept.** `trade_accept(owner_id text REFERENCES inventory_owner ON DELETE CASCADE, edition_id uuid REFERENCES catalog_edition, rule text NOT NULL CHECK (rule IN ('printing','identity')), PRIMARY KEY (owner_id, edition_id))`.
   - A missing row means `edition` (this exact card), the default.
   - Keyed by owner and Edition, so one choice applies to that card wherever it appears on the Want List (question 3).
   - Reason: the Want List is derived and never edited directly (`CONTEXT.md`, Want List), so the choice cannot live on a Want List row. A `deck_list_line` column would tie a trading preference to the Deck List and split one card across Decks.
   - Rows outlive the card leaving the Want List and apply again if it returns. Reads apply rows only to current wants. No cleanup trigger.
   - `PUT /api/trade-wants/will-accept/{edition_id} {rule: 'edition'|'printing'|'identity'}` sets it (`edition` deletes the row).
   - The Want List response (`GET /api/want-list`) keeps its shape, counts, totals and exports, and Will accept never changes them. Only the content of a line's Swap hint differs when its Will accept is widened (Later decisions). Whether revision pins and the Mass Entry 409 hash the hint is settled in Later decisions point 5. The Want List page reads Will accept from `GET /api/trade-wants` (`{lines, will_accept: [{edition_id, rule}]}`).
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
6. **Trade lines per side.** `trade_line(trade_id uuid REFERENCES trade ON DELETE CASCADE, side text CHECK (side IN ('proposer','recipient')), edition_id uuid REFERENCES catalog_edition, position integer NOT NULL CHECK (position >= 0), quantity bigint NOT NULL CHECK (quantity > 0), PRIMARY KEY (trade_id, side, edition_id))`. The primary key makes `trade_id`, `side` and `edition_id` NOT NULL. `side` is the giver. At most 50 lines per side (422 `TOO_MANY_LINES`). An Edition is on at most one side of a row; the steps refuse it on both with 422 `SAME_CARD_BOTH_SIDES` (Valid shapes).
7. **Trade Pick List.** `trade_pick(id bigint PRIMARY KEY DEFAULT nextval('loan_pick_id_seq'), trade_id uuid NOT NULL, side text NOT NULL, owner_id text NOT NULL REFERENCES inventory_owner ON DELETE CASCADE, edition_id uuid NOT NULL, source_location_id uuid, quantity bigint NOT NULL CHECK (quantity > 0), FOREIGN KEY (trade_id, side, edition_id) REFERENCES trade_line ON DELETE CASCADE, CONSTRAINT trade_pick_source FOREIGN KEY (owner_id, source_location_id) REFERENCES location(owner_id, id) ON DELETE SET NULL (source_location_id))`, plus indexes `(trade_id, side)` and `(owner_id, source_location_id)`.
   - The ids come from `loan_pick`'s sequence, so a pick id is unique across both tables and the dicts keyed by pick id in `pick_shortfalls` and `loan_inventory.replacement_picks` (`loan_inventory.py:349-370`) stay correct without a key change.
   - Only `source_location_id` is nullable.
   - Picks are made when a side's copies are reserved and deleted at that side's Confirm swap. There is no `lent` state.
   - Every close deletes the row's picks: `social/trades.close_trade(conn, row, user_id, reason) -> dict` runs `DELETE FROM trade_pick WHERE trade_id = %s` and returns `{'state': 'closed', 'closed_reason': reason, 'closed_by': user_id, 'closed_at': NOW}` for `write_trade`, as `loans.close` does (`loans.py:643-647`). Decline, withdraw, the Counter's old row, cancel, `end_trades_between`, account deletion and the `swapped` close all use it.
8. **Per-side swap confirmation.** `proposer_swap_at` and `recipient_swap_at` record each side's confirmation, as the Loan handover timestamps do. They are not states.

   State model:

   - `proposed` becomes `accepted` (recipient's Accept), or `closed` with `declined` (recipient), `withdrawn` (proposer), `countered` (recipient's Counter) or `cancelled` (unfriend, Block, account deletion).
   - `accepted` becomes `closed/cancelled` (either side, while both `*_swap_at` are NULL), or `closed/swapped` once both are set. It also closes as `swapped` when the side still to confirm has a deleted account and the other side has confirmed (Locks, cancel and ending a friendship).
   - A Counter closes the old row as `countered` and inserts a new `proposed` row with `countered_from = old.id`, both in one transaction, in the order given under "Counter order" (Locks, cancel and ending a friendship).
9. **Migrations, trading block 140-179.** See [the Trading migrations note](../../migrations.md). Migrations 140-144 are re-runnable: each `ADD CONSTRAINT` in 140 and 144 sits in a DO block that skips it when `pg_constraint` already has that name, each trigger is created after `DROP TRIGGER IF EXISTS`, functions use `CREATE OR REPLACE`, tables and indexes `IF NOT EXISTS`, and the two kind widenings (141 and 144) use migration 105's DO-block pattern (`migrations/105_loans.sql:90-107`). Migrations 140, 141 and 143 only add objects. Migration 144 also makes `inbox_update.loan_id` nullable and widens a CHECK, and migration 142 redefines `reserved_copies` and `check_loan_promises` (both from migration 106), so neither is purely additive. Whoever merges second applies the 106 rule from the [social migrations note](../../../social-network/migrations.md): the last definition applied must be the union. The same rule covers the two kind CHECKs (see the migrations note).

**Valid shapes of a proposal** (checked on send and Counter): at least one side gives at least one card. Otherwise the step answers 422 `TRADE_HAS_NO_CARDS`. A side may give nothing, so a gift in either direction is valid (question 5). A side that gives only cash requires `recipient.open_to_cash_offers`, else 409 `CASH_ONLY_NOT_OPEN`. That applies to both directions (buying and selling), because the map says "nobody can send them a proposal with only cash on one side". A Counter is a proposal sent to its recipient, so the Counter's recipient's setting applies too, except that the check is skipped when the countered proposal already had a cash-only side (question 6); the Counter flow reads the old row's lines and cash before closing it.

- "Gives only cash" means the side gives no cards and is the cash payer. A side that gives cards and pays cash while the other side gives nothing (a gift plus cash) is valid and needs no Open to cash offers check, because no side gives only cash.
- One Edition on both sides of one proposal is refused with 422 `SAME_CARD_BOTH_SIDES`. The same Edition twice on one side is 422 `DUPLICATE_EDITION`.

## Step contracts

**Request bodies** (`api/app/trade_inventory.py`; `TradeStep` is defined in `social/trades.py` beside `TradeView`, as `LoanStep` is in `social/loans.py:191`). No list carries a Pydantic `max_length`, so the caps answer their named codes instead of FastAPI's generic 422, and the step counts lines in code as `send_lend_offer` does (`loan_inventory.py:474-475`). The gateway's general body limit, `BUDGET_BODY_BYTES = 16_384` (`auth/src/server.ts:72`), bounds the parse: 100 lines at about 75 bytes each is about 7.5 KB.

```python
MAX_TRADE_LINES = 50

class TradeLineRequest(BaseModel):
    edition_id: UUID
    quantity: str                    # whole number 1..9999 as a decimal string, else 422 INVALID_QUANTITY

class TradeCashRequest(BaseModel):
    cents: str                       # whole number 1..99999999 as a decimal string, else 422 INVALID_CASH
    payer: Literal['you', 'them']    # relative to the collector sending this proposal

class SendTradeProposal(BaseModel):
    recipient_id: str = Field(min_length=1, max_length=200)
    you_give: list[TradeLineRequest] = []
    you_get: list[TradeLineRequest] = []
    cash: TradeCashRequest | None = None     # None: no cash
    idempotency_key: UUID

class TradeStep(BaseModel):          # Accept, Use suggested picks, decline, withdraw, cancel
    revision: int = Field(ge=1)
    idempotency_key: UUID

class CounterTrade(TradeStep):
    you_give: list[TradeLineRequest] = []
    you_get: list[TradeLineRequest] = []
    cash: TradeCashRequest | None = None

class DeckSwitchRequest(BaseModel):
    deck_id: UUID
    from_edition_id: UUID                    # the Deck List line to lower (the want)
    to_edition_id: UUID                      # the received Edition whose line is raised or added
    count: str                               # whole number 1..9999 as a decimal string, else 422 INVALID_QUANTITY

class ConfirmSwap(TradeStep):
    destination_id: UUID | None = None       # ignored when the confirmer receives no cards
    deck_switches: list[DeckSwitchRequest] = []   # the offers the collector left ticked; empty switches nothing
```

- `deck_switches` has no Pydantic `max_length`; the step counts it in code and answers more than 50 entries with 422 `TOO_MANY_LINES` (Later decisions point 7), after the quantity check and before the transaction. The same `(deck_id, from_edition_id, to_edition_id)` twice is 422 `DUPLICATE_EDITION`. Whether each switch is valid is decided inside the transaction (Confirm swap step 3b).
- Cash is stored as `cash_cents` and `cash_payer` (`'you'` becomes the sender's role, `'proposer'` on send and the Counter's proposer on Counter). No cash is `cash: null`, and `"0"` cents is 422 `INVALID_CASH`.
- Checks before the transaction, in this order:
  1. 409 `OWN_ACCOUNT` (send to oneself);
  2. 422 `INVALID_QUANTITY`;
  3. 422 `DUPLICATE_EDITION` (one side);
  4. 422 `SAME_CARD_BOTH_SIDES`;
  5. 422 `TOO_MANY_LINES` (more than 50 Editions on a side);
  6. 422 `TRADE_HAS_NO_CARDS`;
  7. 422 `INVALID_CASH`.
- Checks inside the transaction, under the locks:
  1. 409 `NOT_FRIENDS`;
  2. 409 `CASH_ONLY_NOT_OPEN`;
  3. 409 `NOT_TRADEABLE`, raised as `refuse(409, 'NOT_TRADEABLE', edition_id=..., available=<int>, side='you_give'|'you_get')`, as `NOT_LENDABLE` is at `loan_inventory.py:392`. `side` is the caller's side of the line.

  An unknown Edition has no listable copies, so it is `NOT_TRADEABLE` with `available` 0.

**TradeView** (`social/trades.py`), the response of every Trade step and of `GET /api/social/trades/{id}`. It never carries picks, a destination, a Location or a Deck. The collector's own picks and Location names are only in `GET /api/trades/{id}/side`.

```python
TradeAction = Literal['accept', 'decline', 'counter', 'confirm_swap', 'use_suggested_picks', 'withdraw', 'cancel']

class TradeParty(BaseModel):
    collector_id: str | None         # None once that account is deleted
    display_name: str
    handle: str | None
    open_to_cash_offers: bool

class TradeCard(BaseModel):
    edition_id: UUID
    name: str
    set_code: str
    set_name: str
    collector_number: str
    descriptor: dict                 # in OPAQUE, as LoanCard.descriptor
    image_url: str | None
    copies: str

class TradeCash(BaseModel):
    cents: str
    payer: Literal['you', 'them']

class TradeView(BaseModel):
    id: UUID
    state: Literal['proposed', 'accepted', 'closed']
    closed_reason: Literal['declined', 'withdrawn', 'countered', 'cancelled', 'swapped'] | None
    closed_by: Literal['you', 'them'] | None
    role: Literal['proposer', 'recipient']
    other: TradeParty
    countered_from: UUID | None
    you_give: list[TradeCard]
    you_get: list[TradeCard]
    cash: TradeCash | None
    you_confirmed_swap: bool
    they_confirmed_swap: bool
    needs_you: bool
    waiting: Literal['answer', 'fix_picks', 'confirm_swap'] | None
    section: Literal['needs_you', 'to_swap', 'pending', 'history']
    actions: list[TradeAction]
    revision: int
    created_at: datetime
```

`section` is decided in this order:

1. `needs_you` when `waiting` is not None;
2. `history` when the row is closed;
3. `to_swap` when the row is accepted and the reader has not confirmed;
4. `pending` otherwise (the reader's own proposal waiting for an answer, or the reader confirmed and the other side has not).

**`allowed(user_id, row, gives) -> list[TradeAction]`** is pure on the row, as `loans.allowed` is (`loans.py:369`). `gives` means the reader's side has at least one `trade_line`. It returns actions in `TradeAction` order. A step whose action is not listed answers 409 `STEP_NOT_ALLOWED`.

| Row | Reader | `actions` |
| --- | --- | --- |
| `proposed` | recipient | `accept`, `decline`, `counter` |
| `proposed` | proposer | `use_suggested_picks` (when `gives`), `withdraw` |
| `accepted`, neither side confirmed | either side | `confirm_swap`, `use_suggested_picks` (when `gives`), `cancel` |
| `accepted`, only the other side confirmed | reader | `confirm_swap`, `use_suggested_picks` (when `gives`) |
| `accepted`, the reader confirmed | reader | none |
| `closed` | either side | none |

`use_suggested_picks` is listed while the reader's side gives cards and still reserves. The step answers 409 `PICKS_UP_TO_DATE` when nothing is stale, as the Loan step does (`loan_inventory.py:797-799`).

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

- **Guards.** Add deferred constraint triggers that call `check_loan_promises(owner, edition)` only for a side whose promise rises, mirroring `loan_promise_guard` (`migrations/106_loan_promises.sql:60-76`).
  - `trade_promise_guard` on `trade` (`AFTER INSERT OR UPDATE OF state, proposer_swap_at, recipient_swap_at, proposer_id, recipient_id`): it checks a side when NEW reserves it (the predicates of `trade_reserved_copies`) and either `TG_OP` is INSERT, or OLD did not reserve it, or that side's owner id changed. So a send checks the proposer's lines, an Accept checks the recipient's, and a direct write that clears a swap time, which re-reserves the copies, is checked as well. Closing a row, or setting a swap time, leaves NEW not reserving that side, so it still checks nothing. This mirrors `loan_promise_guard` (`migrations/106_loan_promises.sql:60-76`).
  - `trade_line_promise_guard` on `trade_line` (`AFTER INSERT OR UPDATE OF quantity, edition_id, side`) finds the owner from the side: `CASE NEW.side WHEN 'proposer' THEN t.proposer_id ELSE t.recipient_id END`. It checks only while that side reserves (the proposer side while the row is `proposed` or `accepted` and `proposer_swap_at IS NULL`; the recipient side while `accepted` and `recipient_swap_at IS NULL`).
- Redefine `check_loan_promises`'s message to "Open Loans and Trades promise ...". Keep `CONSTRAINT = 'loan_promises_owned'` and SQLSTATE `23514`.
- **Where reserved copies sit** is read only from `loan_pick`, in three places today: `counts.reserved_picks` (`counts.py:55`), `loan_picks.pick_shortfalls` (`loan_picks.py:14`) and `counts.move_picks` (`counts.py:115`, called by Deck deletion and leaf conversion). `copy_allocation.spare_rule` (`copy_allocation.py:165`) places the reserved count at the picked Locations first (`EditionCopies.picked`).
- **Placement.** Add `reserving_picks` in migration 142. Two sort keys keep today's Loan order exactly: `loan_picks.pick_shortfalls` sorts `o.accepted_at NULLS LAST, o.created_at, o.id, p.id` today (`loan_picks.py:24-27`), so an offered Lend Offer always sorts after every accepted Loan, and a single coalesced time would break that.

  ```sql
  CREATE OR REPLACE FUNCTION reserving_picks(owners text[], editions uuid[])
  RETURNS TABLE(kind text, loan_id uuid, trade_id uuid, pick_id bigint, owner_id text, edition_id uuid,
                source_location_id uuid, quantity bigint, sort_accepted_at timestamptz, sort_created_at timestamptz)
  LANGUAGE sql STABLE AS $$
    SELECT 'loan', p.loan_id, NULL::uuid, p.id, p.owner_id, p.edition_id, p.source_location_id, p.quantity::bigint,
           o.accepted_at, o.created_at
      FROM loan_pick p JOIN loan o ON o.id = p.loan_id
      WHERE p.owner_id = ANY(owners) AND o.lender_id = p.owner_id AND p.state = 'reserved'
        AND o.state IN ('offered','accepted') AND o.lender_handover_at IS NULL   -- counts.RESERVING
        AND (editions IS NULL OR p.edition_id = ANY(editions))
    UNION ALL
    SELECT 'trade', NULL::uuid, p.trade_id, p.id, p.owner_id, p.edition_id, p.source_location_id, p.quantity,
           t.accepted_at, CASE WHEN p.side = 'proposer' THEN t.created_at ELSE t.accepted_at END
      FROM trade_pick p JOIN trade t ON t.id = p.trade_id
      WHERE p.owner_id = ANY(owners) AND (editions IS NULL OR p.edition_id = ANY(editions))
        AND ((p.side = 'proposer' AND t.proposer_id = p.owner_id
              AND t.state IN ('proposed','accepted') AND t.proposer_swap_at IS NULL)
          OR (p.side = 'recipient' AND t.recipient_id = p.owner_id
              AND t.state = 'accepted' AND t.recipient_swap_at IS NULL))
  $$;
  ```

  The keys per source are: a Loan `(o.accepted_at, o.created_at)`; a Trade proposer side `(t.accepted_at, t.created_at)`; a Trade recipient side `(t.accepted_at, t.accepted_at)`. Python reads it for one owner through one new helper in `social/counts.py`:

  ```python
  def reserving_pick_rows(conn, owner_id: str, edition_ids) -> list[dict]:
      """The owner's reserving Loan and Trade picks of these Editions, oldest accepted first, unaccepted last, with keys
      id, kind, loan_id, trade_id, edition_id, source_location_id, quantity. Call it through the module."""
      editions = sorted(set(edition_ids))
      if not editions:
          return []
      return conn.execute("""SELECT pick_id AS id, kind, loan_id, trade_id, edition_id, source_location_id, quantity
        FROM reserving_picks(ARRAY[%s]::text[], %s::uuid[])
        ORDER BY sort_accepted_at NULLS LAST, sort_created_at, kind, coalesce(loan_id, trade_id), pick_id""",
                          (owner_id, editions)).fetchall()
  ```

  With no Trades, `kind` is always `'loan'` and `coalesce(loan_id, trade_id)` is `o.id`, so the order is today's exactly. Switch the three placement readers:
  - `counts.reserved_picks` reads `reserving_picks(ARRAY[%s]::text[], %s::uuid[])` summed per Edition and source, so `spare_rule` places Trade-reserved copies at their picks and allocation never offers them elsewhere;
  - `loan_picks.pick_shortfalls` replaces its `loan_pick` select with `counts.reserving_pick_rows(conn, lender_id, editions)`. The returned rows keep `id` and `loan_id` (NULL for Trade picks), so `stale_pick_loans` and `replacement_picks`, which filter on `pick['loan_id'] == loan_id`, are unchanged. Lend Offers and Loan accepts then never pick copies a Trade covers, and the other way round. `trade_picks` reads through the same helper;
  - `counts.move_picks` also runs `UPDATE trade_pick SET source_location_id = %s WHERE owner_id = %s AND source_location_id = %s`.
- **When.** The sender's lines reserve on send and on Counter. The recipient's lines reserve on Accept. Both are released by decline, withdraw, Counter (the old proposal's sender), cancel, unfriend, Block and account deletion. Each side's reservation also ends at its own Confirm swap, in the transaction that removes the copies. There is no expiry (map).
- **What may be offered.** Every line a side gives must be at most that side's listable copies at the moment its copies reserve (send and Counter for the sender, Accept for the recipient), else 409 `NOT_TRADEABLE` with `{edition_id, available, side}` (`side` is `you_give` or `you_get`, the caller's side of the line). Listable means on its Trade List (map: "What a collector offers: a Location marked For trade"). For the other side's lines on send or Counter, the cap is that Friend's listable copies through `friend_trade_copies`, called on the step's own connection (for a Counter, after the old proposal is closed; see "Counter order"). Nothing of the Friend's is reserved until they accept.
- **Trade Pick List.** Picks are made at reservation: per Edition, For trade Locations first (largest Holding first, then name, then id), never from copies other reserving picks cover. Use `pick_shortfalls`' `covered` and `deck_pick_list.suggest` (`deck_pick_list.py:130`) over places filtered to For trade Locations. The listable cap guarantees enough. "Use suggested picks" may draw on any Location (For trade first, then the Deck Pick List order). Stale picks are computed, not stored, as for Loans.
- **Listable (own and Friend), one rule.** Per owner and Edition: `ft_held` is the sum of Holdings in `for_trade_locations`; `ft_picked` is the sum over For trade Locations of `least(reserving picks there, held there)`; `listable = greatest(0, least(ft_held - ft_picked, total_held - reserved))`. A Loan's or Trade's reserved copies picked from a Deck therefore do not shrink the Trade List, while stale picks can never over-list. Lent copies are not in `holding`, and Borrowed Copies are in `borrowed_holding`, which is never read. The rule is written once, as a SQL function in migration 142 (it needs `for_trade_locations` from 140 and `reserving_picks` and `reserved_copies` from 142). `friend_copies.TRADE_READ` and `trade_list.own_trade_copies` both call it, and nothing else restates it:

  ```sql
  CREATE OR REPLACE FUNCTION trade_listable(owners text[], editions uuid[])
  RETURNS TABLE(owner_id text, edition_id uuid, listable bigint) LANGUAGE sql STABLE AS $$
    WITH ft AS (SELECT DISTINCT f.owner_id, f.location_id FROM for_trade_locations(owners) f),
    picked AS (
      SELECT p.owner_id, p.edition_id, p.source_location_id AS location_id, sum(p.quantity)::bigint AS quantity
      FROM reserving_picks(owners, editions) p WHERE p.source_location_id IS NOT NULL GROUP BY 1, 2, 3),
    per AS (
      SELECT h.owner_id, h.edition_id, sum(h.quantity)::bigint AS total_held,
        coalesce(sum(h.quantity) FILTER (WHERE ft.location_id IS NOT NULL), 0)::bigint AS ft_held,
        coalesce(sum(least(coalesce(pk.quantity, 0), h.quantity)) FILTER (WHERE ft.location_id IS NOT NULL), 0)::bigint
          AS ft_picked
      FROM holding h
      LEFT JOIN ft ON ft.owner_id = h.owner_id AND ft.location_id = h.location_id
      LEFT JOIN picked pk ON pk.owner_id = h.owner_id AND pk.edition_id = h.edition_id AND pk.location_id = h.location_id
      WHERE h.owner_id = ANY(owners) AND (editions IS NULL OR h.edition_id = ANY(editions))
      GROUP BY h.owner_id, h.edition_id),
    listed AS (
      SELECT per.owner_id, per.edition_id,
        greatest(0, least(per.ft_held - per.ft_picked, per.total_held - coalesce(r.reserved, 0)))::bigint AS listable
      FROM per LEFT JOIN reserved_copies(owners, editions) r
        ON r.owner_id = per.owner_id AND r.edition_id = per.edition_id)
    SELECT owner_id, edition_id, listable FROM listed WHERE listable > 0
  $$;
  ```

  `own_trade_copies(conn, user_id, edition_ids=None)` is `SELECT edition_id, listable FROM trade_listable(ARRAY[%s]::text[], %s::uuid[])`. `GET /api/trades/list` takes its per-Edition counts from the same call and its own Location names from `for_trade_locations(ARRAY[%s]::text[])` joined to the collector's own `holding`.

**Rejected:** a separate `trade_reserved` mechanism or trigger set. It would leave a copy promisable once to a Loan and once to a Trade, which is exactly what the map forbids, and would add a second definition that every inventory reader would have to learn.

## Confirm swap

`POST /api/trades/{id}/confirm-swap {revision, idempotency_key, destination_id: UUID|null}` is in `trade_inventory.py` and runs through `run_trade_step`, under the confirmer's own owner lock only. The lock is taken with `owners.lock_owners` (`FOR NO KEY UPDATE`), never `moves.lock_owner` or `location_tree.owner_and_rows`: both take `FOR UPDATE`, which would block the foreign-key checks the other side's steps take on this owner's row (`loan_inventory.py:703-709` says why). It changes only the confirmer's inventory. The inventory writes available today, and why they need care:

- `moves.take_out` (`moves.py:130`) removes copies with Removal semantics and no Undo record. The lender's Loan handover uses it.
- `moves.put_back` (`moves.py:151`) inserts copies with `tcg.undo_returns_surplus='on'`, so arriving copies do not raise Deck List lines (migration 047). That is right for returns and wrong for newly owned copies.
- Copies leaving a Deck never lower its lines (`migrations/115_borrowed_deck_lists.sql:12`).

Steps:

1. If the confirmer gives cards and any of their picks is stale, the step answers 409 `PICKS_OUT_OF_DATE` and the collector uses `POST /api/trades/{id}/picks/use-suggested` (409 `PICKS_UP_TO_DATE` when nothing is stale). This mirrors the Loan handover (`loan_inventory.py:723-737`) (question 7). Then, before any write, the step reads the confirmer's `revision` (`SELECT revision FROM inventory_owner WHERE user_id = %s`, under the lock) and, when the confirmer receives cards, `needs = want_list.edition_needs(conn, user_id, received_editions)` for step 4. When the confirmer receives cards it also computes the Deck switch candidates for step 3b, from the same allocation and the same reads (below), so that every chosen switch is validated against the state the step is about to change.
2. **Copies given.** `new_revision = moves.take_out(conn, user_id, items_from_own_picks, revision)`, the same write as the Loan handover: no Undo record, and Deck List lines are not lowered. Then `DELETE FROM trade_pick WHERE trade_id = %s AND side = <own side>`. The side's reservation ends in the same transaction, because the `trade` row write sets `<side>_swap_at`. The deferred invariant sees Holdings and promises fall by the same count. When the confirmer gives no cards, nothing is taken out and `new_revision = revision + 1`.
3. **Copies received** (the other side's lines) arrive as new Holdings.
   - **Destination.** A given `destination_id` must pass `moves.leaf(conn, user_id, destination_id)` (`moves.py:179`, a plain select: one of the confirmer's Storage Leaves or Decks with no children), else 404 `LOCATION_NOT_FOUND`. A null `destination_id` means Unsorted: `deck_deletion.unsorted_leaf(conn, user_id, _locations(conn, user_id), None)`, where `_locations` is the same plain select as `loan_inventory._locations` (`loan_inventory.py:703-709`), defined again in `trade_inventory.py`. `unsorted_leaf` creates Unsorted when there is none and answers 409 `UNSORTED_UNAVAILABLE` when the root named Unsorted cannot hold cards (`deck_deletion.py:57-58`). When the confirmer receives no cards, `destination_id` is ignored: it is not checked, and Unsorted is not created.
   - **Write.** A new `moves.add_in(conn, user_id, location_id, items, new_revision) -> None` is the `put_back` upsert (`moves.py:151-165`) without `tcg.undo_returns_surplus`, so copies arriving in a Deck raise its lines as an Add does (migrations 031 and 047). Each Holding takes `version = new_revision`, and it runs `UPDATE inventory_owner SET revision = %s WHERE user_id = %s` with `new_revision`. `take_out` and `add_in` together therefore advance the confirmer's revision exactly once. It writes no Undo record.
   - `add_in` is a new writer. That is a delegated deviation from the map's "goes through the existing Move and `holding` writers" (map: Notes). It is the existing `holding` upsert with the Deck List trigger left on, so Undo and the triggers see an ordinary Holding insert.
   - Receiving does not depend on the other account still existing, because it reads only `trade_line`.

3b. **Deck switches** (Later decisions, owner, 2026-10-19): the Deck List lines move to the cards that arrived.
   - **Candidates.** `want_list.deck_switch_candidates(conn, user_id, received) -> list[DeckSwitch(deck_id, from_edition_id, to_edition_id, count)]` is new and read-only. For each received Edition `E'` with `received` copies, let `exact = needs.get(E', 0)`: those copies fill the Decks' lines of `E'` itself and are never switched. Copies covering the confirmer's Trade Wants line for `E'` come next and are never switched either (point 8): let `tw = trade_want quantity for E'` (0 if none). The remaining `max(0, received - exact - tw)` copies are candidates; when the destination is a Deck, only that Deck is offered them (point 2). A want `F` (an Edition other than `E'`) offers them when `E' in accepts({F: rule})`, where `rule` is the confirmer's `trade_accept` row for `F`, and when a Deck List line of `F` still needs copies. `edition_needs` allocates only the received Editions, so the candidate computation runs its own `allocate` (same counting setting, same single read before any write) over the received Editions plus every Edition `F` that has a Deck List line, whose `trade_accept` rule accepts one of them, found from the confirmer's own rule rows and the Deck List lines that share the received Edition's Printing or Card Identity. Candidates are given per Deck, oldest Deck first, `count = min(that Deck's remaining need for F, copies of E' still unassigned)`, never more than the line still needs. Under "one Deck at a time" the copies of `E'` switched across all Decks total at most `received - exact - tw` (point 3). Hidden Decks are included, as for the confirmer's own Want List. Only an Edition that may start a new Deck List line is a target (active in the active catalog generation, of a Printing that isn't withdrawn), unless the Deck already lists it, as the Swap hint and the batch route require.
   - **Side read.** `GET /api/trades/{id}/side` returns the same list as `deck_switches` for the reader's own side while the Trade is accepted and the reader has not confirmed, each with the Deck's name and the card facts of both Editions, read without `FOR UPDATE`. It is an own read under `/api/trades`, never `/api/social`, so no Deck field reaches an `/api/social` response.
   - **Validation.** Each entry of `ConfirmSwap.deck_switches` must equal a candidate in Deck and Editions, with `count` no greater than the candidate's. Any other entry (unknown Deck, a pair that is not a candidate, too high a count, or a candidate that moved because the Deck List or the holdings changed) refuses the whole step with 409 `DECK_SWITCH_CHANGED` and changes nothing, since the transaction rolls back. A replay by idempotency key returns the stored answer.
   - **Write.** After steps 2 and 3, still under the confirmer's own `lock_owners` lock and in the same transaction, each chosen switch is applied with the Deck List changes batch's own write logic: the batch takes each line's new total and refuses a repeated Edition (422 `DUPLICATE_EDITION`), so the step folds a Deck's switches into one set of new line totals, summed per Edition from the Deck's current lines (the line of `from_edition_id` lowered by `count`, removed at 0, and the line of `to_edition_id` raised or added by as many), and calls the shared write once per Deck. Switches in one Deck that share an Edition, such as A to B plus C to B or A to B plus A to C, are therefore allowed and folded, and are validated together against the candidates. The write is followed by the Deck List revision advance and format checks the batch performs (`decks.advance_deck_list`). The batch route itself cannot be called because it takes `FOR UPDATE` through `owner_and_rows` and runs its own replay and revision check; its write part is extracted as a function that takes the connection (Later decisions point 1). It touches no Holding, the inventory revision or an inventory Undo record, so Confirm swap's revision still moves exactly once. Each switched Deck's own Deck List revision advances once.
   - **Destination is the switched Deck.** When `destination_id` is a Deck `D` and a switch for `D` raises `to_edition_id`, `add_in` has already raised that line by the received copies, so the switch only lowers the `from_edition_id` line (point 2).
   - **Undo.** A switch takes no inventory Undo slot. It follows the Deck List changes batch's own Undo rules: its Undo is the inverse batch the Deck builder sends at the Deck List revision the switch produced (`STALE_DECK_LIST` if the list changed since), exactly as for a Swap today. Undo of any inventory step does not undo it, and a switch does not undo anything. Confirm swap itself stays not undoable. `TradeView` carries no Deck revision, so whether and how the web offers that Undo after Confirm swap is left to the prototype.
4. **Trade Wants** (question 4 as refined): Deck needs come first, then switches.
   - `want_list.edition_needs(conn, user_id, edition_ids) -> dict[UUID, int]` is new in `api/app/want_list.py`. It reads `want_list_counting` with `settings.read_settings(conn, user_id)` (a plain select) and calls `copy_allocation.allocate(conn, user_id, editions, counting)` over every Deck, hidden ones included, as the collector's own Want List does. It combines each Edition's line needs by `sum` (`all_at_once`) or `max` (`one_at_a_time`), as `want_list.combined` does (`want_list.py:185-196`). It never calls `capture_want_list` or `owner_and_rows`, which lock `FOR UPDATE`, and it is read in step 1, before any write.
   - After steps 2, 3 and 3b, for each received Edition `E` with `received` copies: `left = max(0, received - needs.get(E, 0))`. The order is therefore: the Decks' needs for `E` itself, then Trade Wants for `E`, then switches, which by point 8 only ever take copies left after both. A switched copy counts as having filled a Deck need. If the confirmer has a `trade_want` row for `E`, delete it when `quantity <= left`, otherwise `UPDATE trade_want SET quantity = quantity - left`. The CHECK `quantity BETWEEN 1 AND 9999` never sees 0.
   - Only the exact Edition counts: copies of `E` never lower a line for another Edition. A copy received through a widened Will accept choice fills no Deck line that names another Edition unless the collector's chosen switch (step 3b) moved that line to `E`, so otherwise that need stays on the Want List. An unticked offer leaves the Deck List alone. The destination does not change any of these numbers.
5. Row columns: `{<side>_swap_at: NOW}`, plus `state='closed', closed_reason='swapped', closed_at=NOW, closed_by=user_id` when the other side already confirmed. In that case `record_trade_update(..., 'swapped')` goes to the other side.
6. Cash: nothing beyond the recorded amount. The app never handles money (map). Nothing about cash changes at confirm.

- **Not an Inventory Removal in the collector's eyes:** it takes no inventory Undo slot, as with the Loan handover. A Deck switch is a Deck List change and takes none either.
- **Not undoable.** A confirmed swap takes no Undo record, has no take-back (question 8) and nothing reverses it. The one carve-out is a Deck switch (step 3b): it is a Deck List change with the Deck List changes batch's own Undo, and undoing it never reverses the swap. Undo records older than the swap keep their usual checks (`UNDO_NOT_NEWEST`, `UNDO_INCOMPATIBLE`, `check_promises`), as after a Loan handover.
- **Giver short at confirm.** This cannot happen while the invariant holds. A stale pick answers 409 as above. `HoldingShort` from `take_out` is a bug and rolls back (500), as for Loans.
- **The other side's account deleted:** see the next section.

## Locks, cancel and ending a friendship

**Lock order (extends ADR 0014):** `inventory_owner` rows in ascending `user_id`, then `loan` rows in id order, then `trade` rows in id order. Today `social/owners.py:22` `lock_owners` locks `inventory_owner` rows `FOR NO KEY UPDATE` in ascending `user_id`, so foreign-key checks from the other collector's rows never wait on it, and `social/loans.py:553` `run_step` writes the `loan` row exactly once per transaction (a second write re-checks FKs and closed a deadlock cycle). `moves.lock_owner` (`moves.py:169`) is the single-owner `FOR UPDATE` lock that inventory commands use. Each Trade step writes its `trade` row exactly once (`write_trade`, a copy of `write_loan`, `loans.py:592`). Row locks are `FOR NO KEY UPDATE`. A deadlock the database ends anyway answers 503 `INVENTORY_TEMPORARILY_UNAVAILABLE`. Commands use `begin_command`'s pattern: advisory per-collector command lock, `location_command` replay, then count `'trade_command'` (120 per hour, `TOO_MANY_CHANGES`). Every Trade step locks owner rows only through `owners.lock_owners`, never `moves.lock_owner` or `location_tree.owner_and_rows`, and reads Locations with plain selects, as Loan steps do (`loan_inventory.py:703-709`).

| Step | Route | Locks | Revisions advanced |
| --- | --- | --- | --- |
| Send proposal | `POST /api/trades` | proposer | proposer |
| Counter (recipient R of proposal from P) | `POST /api/trades/{id}/counter` | both | P (released) and R (reserved) |
| Accept | `POST /api/trades/{id}/accept` | recipient | recipient |
| Decline | `POST /api/social/trades/{id}/decline` | both | proposer |
| Withdraw (proposer, before an answer) | `POST /api/social/trades/{id}/withdraw` | proposer | proposer |
| Cancel an accepted Trade (either side, nobody confirmed) | `POST /api/social/trades/{id}/cancel` | both | both |
| Confirm swap | `POST /api/trades/{id}/confirm-swap` | confirmer | confirmer, exactly once (`take_out` returns the new revision and `add_in` sets it); a Deck switch advances only that Deck's Deck List revision |
| Use suggested picks | `POST /api/trades/{id}/picks/use-suggested` | that side | that side |
| Unfriend or Block | inside the Friend command | both (already locked) | each side whose reservation was released |
| Reads, inbox | GET | none | none |

- **Counter order.** `counter_trade` is its own transaction flow, not `run_trade_step`, because the sender's caps must be read after the old proposal stops reserving. R is the Counter's sender (the old row's recipient) and P is the old row's proposer.
  1. `begin_command(conn, R, key, payload)`; a replay returns the stored view.
  2. Read the old row's parties (404 `TRADE_NOT_FOUND` when R is not one), then `lock_owners(conn, P, R)`.
  3. `SELECT * FROM trade WHERE id = %s FOR NO KEY UPDATE`; 409 `TRADE_CHANGED` on a stale revision; 409 `STEP_NOT_ALLOWED` unless `counter` is in `allowed`; 409 `NOT_FRIENDS` unless P is in `friend_ids(conn, R)`; 409 `CASH_ONLY_NOT_OPEN` when a side of the Counter gives only cash and P is not Open to cash offers.
  4. `write_trade(conn, old.id, close_trade(conn, old, R, 'countered'))`: the old row is written once and its picks are deleted, so P's copies stop being reserved.
  5. Read the caps on the step's own READ COMMITTED connection, which sees step 4: `own_trade_copies(conn, R, give_editions)` for R's lines and `friend_trade_copies(conn, R, [P], get_editions)` for P's. A line above its cap answers 409 `NOT_TRADEABLE` and the whole transaction rolls back, leaving the old row `proposed` with P's picks.
  6. Insert the new `trade` row (`proposer_id = R`, `recipient_id = P`, `countered_from = old.id`), its `trade_line` rows and R's picks.
  7. `advance_revision(conn, P)` and `advance_revision(conn, R)`, once each.
  8. Store and return R's view of the new row.

  Each row is written once, so `write_trade`'s rule needs no exception. As the Loan `run_step` does (`loans.py:553`), `counter_trade` maps `DeadlockDetected` to 503 `INVENTORY_TEMPORARILY_UNAVAILABLE`.
- **Send, Counter and Accept** check friendship with `friends.friend_ids` under the step's locks, else 409 `NOT_FRIENDS`. Accept's check is the same one-line check as the Loan accept (`loan_inventory.py:427`). Decline and cancel need no friendship check, because unfriend and Block close every unconfirmed Trade first (below) and serialise on the owner locks.
- **Cancel rules (map).**
  - Before acceptance: the proposer withdraws; the recipient declines or counters.
  - After acceptance: either side cancels while both `*_swap_at` are NULL.
  - Once either side has confirmed, nobody can cancel, and the remaining side may only Confirm swap. A Counter is allowed only on a `proposed` row.
- **Unfriend and Block.** Today `social/friends.py:161` `friendship_ended` calls `social/loans.py:657` `end_loans_between`, inside the Friend command that already locked both owners; it cancels Loans nobody confirmed a handover for. `friendship_ended` also calls the new `social.trades.end_trades_between(conn, user_id, other_id)` after `end_loans_between`. It:
  - locks the pair's Trades in `('proposed','accepted')` with both `*_swap_at` NULL, `ORDER BY id FOR NO KEY UPDATE`;
  - closes each with `write_trade(conn, row['id'], close_trade(conn, row, user_id, 'cancelled'))`, once per row, and records a `'cancelled'` update for the other side, never why. Unfriend and Block write the same update. For an accepted Trade it is also the same update a plain cancel writes. For a proposed row it reads "cancelled", as `end_loans_between` does for an unanswered Lend Offer, and never says whether an unfriend or a Block caused it;
  - advances the revision of every side whose copies were reserved, once each.

  Trades with one confirmation stay open, and the remaining side can still confirm after a Block, which reveals nothing. Add `('.trades', 'end_trades_between')` to `ALLOWED_IMPORTS['social/friends.py']`. The Remove Friend and Block questions' counts of what gets cancelled must count Trades too. The copy belongs to the prototype ticket.
- **Account deletion** (the feature does not exist yet; add these requirements to the spec's account-deletion list):
  1. Lock the deleting collector and every counterparty of an open Loan or Trade in one `lock_owners` call (ascending `user_id`), then cancel every unconfirmed Trade with `close_trade`, as unfriend does.
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

- **`friend_trade_copies(conn, viewer_id, friend_ids=None, edition_ids=None) -> list[TradeCopies(friend_id, edition_id, listable)]`.** One statement, `TRADE_READ`, which joins `friends_of` to `trade_listable` (`friend_copies.py:48` `READ` is the model for the Friend filter):

  ```sql
  WITH friend AS (
    SELECT f.friend_id FROM friends_of(ARRAY[%(viewer)s]::text[]) f
    WHERE %(friends)s::text[] IS NULL OR f.friend_id = ANY(%(friends)s::text[]))
  SELECT t.owner_id AS friend_id, t.edition_id, t.listable
  FROM trade_listable(ARRAY(SELECT friend_id FROM friend), %(editions)s::uuid[]) t
  ORDER BY t.owner_id, t.edition_id
  ```

  - only Friends (`friends_of`), with no Block either way;
  - For trade membership comes from `for_trade_locations` inside `trade_listable`, with no hidden filter (map: a hidden For trade Location stays on the Trade List);
  - reservations and placement come from `trade_listable`, the one listable rule.

  It returns no Location id. It never reads `borrowed_holding`. `listable > 0` only.
- **`friend_wants(conn, viewer_id, friend_ids, edition_ids) -> list[FriendWant(friend_id, edition_id, want_list_need, trade_wants_quantity, rule)]`** reads each Friend's own wants, restricted to `edition_ids`, one row per (Friend, Edition) with either part above 0:
  - Want List part, `want_list_need`: allocate over every Deck and Holding of the Friend, hidden Decks included, exactly as their own Want List (their counting setting, Borrowed and lent copies), so a hidden older Deck still takes Spare Copies in the usual order. Then drop the `LineCount`s of Decks inside Hidden Locations (question 2), and only then combine per Edition with `sum` (`all_at_once`) or `max` (`one_at_a_time`), as `want_list.combined` (`want_list.py:185-196`) does. For each Deck outside a Hidden Location, the need is exactly what the Friend sees for that Deck on their own Want List. `rule` is the Will accept rule from `trade_accept` and widens only this part. As for the viewer, the Friend's own spare copies of Editions their rule accepts do not reduce `want_list_need` (Later decisions, F3).
  - Trade Wants part, `trade_wants_quantity`: the `trade_want` quantity for that exact Edition, always matched as `edition`.
  - The two parts add: the Friend wants `want_list_need + trade_wants_quantity` copies.
  - It never names a Deck: the field is `want_list_need`, not a Deck field, because the contract guard forbids the word.
  - **Performance lever.** Allocation is independent per Edition (`copy_allocation.py:11`), so it is restricted to the candidate Editions that could match the viewer's Trade List: all Editions sharing a Card Identity with a listable Edition of the viewer's, the widest Will accept. Friends whose Deck Lists name none of them are skipped by a prefilter statement.
  - **No per-Friend allocate and no Friend lock, and the multi-owner SQL stays in the choke point.** `want_list.capture_want_list` (`want_list.py:158`) runs under the owner lock (`owner_and_rows`, FOR UPDATE) and calls `copy_allocation.allocate` (`copy_allocation.py:250`). `allocate` reads per owner: Holdings, Deck List lines, Deck `created_at`, `reserved_counts`, `reserved_picks`, `lent_counts`, `lent_picks` and `borrowed_in`. The counting setting is `inventory_owner.want_list_counting` (`settings.py:45`). First a figure-neutral refactor ticket splits `allocate` into:
    - a frozen dataclass `AllocationRows(holdings, lines, deck_created, reserved, picked, lent, lent_at, borrowed)`, the inputs one owner's allocation reads;
    - the single-owner reader `read_allocation_rows(conn, user_id, editions) -> AllocationRows`, which is today's reads moved unchanged;
    - the pure `allocate_rows(rows, editions, counting) -> Allocation`.

    `allocate(conn, user_id, editions, counting)` becomes `allocate_rows(read_allocation_rows(...), ...)` with unchanged figures, and the existing Want List, Deck cost and import tests are the proof. No multi-owner reader is added to `copy_allocation`, `counts` or `borrowed_copies`. `friend_wants` builds one `AllocationRows` per prefiltered Friend from its own batched statements in `friend_copies.py` (`WANTS_READ`, `owner_id = ANY(%s)` over `holding`, `deck_list_line`, Deck `created_at` from `location`, `inventory_owner.want_list_counting`, the Friends' own `borrowed_holding` in their Decks, lent picks, and which Decks sit in Hidden Locations from `hidden_locations(friends)`) plus `counts.reserved_by_owner` and `reserving_picks`. It then calls the pure `copy_allocation.allocate_rows` over every Deck, hidden ones included, drops the hidden Decks' lines from the result and only then combines, all inside one `REPEATABLE READ READ ONLY` transaction: one snapshot, no locks, so a Friend read never waits on a Friend's writes. ADR 0014 forbids allocation once per Friend; this reads once for all of them. `WANTS_READ` may read `borrowed_holding`, because Borrowed Copies fill the Friend's own Deck lines, but it returns only needs. `test_the_choke_points_statement_never_reads_borrowed_holdings` keeps checking `READ` and adds `TRADE_READ`, not `WANTS_READ`.
- **Expansion for Will accept** (new and separate from `reach` in `social/friend_reads.py:146`, whose `'exact'` already means "any finish" and which also has `'reprint_group'`): `accepts(conn, wanted: dict[edition, rule]) -> dict[wanted_edition, set[edition]]`, in `api/app/card_accepts.py`, outside the social area (Later decisions point 4):
  - `edition` gives `{w}`;
  - `printing` gives every Edition of `w`'s Card Printing;
  - `identity` gives every Edition of every Card Printing with `w`'s `identity_id` (`catalog_printing.identity_id`, `friend_reads.py:96-104`) (question 9).

  It does not involve the counting setting. Trade Wants always use `edition`.
- **The Swap hint also uses `accepts`** (Later decisions). `swap_hints.hints` offers, for a line that still needs copies, the Editions of the line's Reprint Group that the counting setting makes available (today's rule) and also the Editions `accepts({line edition: rule})` returns for the line's `trade_accept` rule, with the same availability and the same one-pass, never-offered-twice pass over every Deck oldest first, and still one Edition per hint (the most copies available, then card order). Sending the hint is the same Deck List changes batch. With the rule `edition` (no row) `accepts` adds nothing, so hints, counts and the existing Swap hint tests are unchanged. `swap_hints` reads `trade_accept` for the owner (an own read, not a social module) and needs `accepts` (Later decisions point 4). The hint is how a spare copy of an accepted Edition comes to count against a Deck line; until it is taken the spare copy reduces no need, in the Want List or in discovery.
- **`GET /api/social/trade-matches`** (`trade_matches.py`) runs in this order:
  1. Viewer's wants: `want_list.capture_want_list(user_id)` under the viewer's own lock (as `friend_reads.wanted_editions`), plus `trade_wants.own_wants`. Each want is `(edition, want_list_need, trade_wants_quantity, rule)`: the Want List part over every Deck, hidden ones included (question 2), combined by the viewer's counting setting, and the Trade Wants quantity. The Will accept rule widens the Want List part only. The viewer's own spare copies of Editions their rule accepts do not reduce this need (Later decisions, F3).
  2. Viewer's Trade List: `trade_list.own_trade_copies(conn, user_id)`, an own read in the inventory module `api/app/trade_list.py` that also backs `GET /api/trades/list`.
  3. On a separate connection in one `REPEATABLE READ READ ONLY` transaction, call `friend_trade_copies(viewer, None, union of accepts(viewer wants))` and `friend_wants(viewer, None, candidate Editions of the viewer's Trade List)`.
  4. Pair the results in memory.

  Response `TradeMatches { has_friends, rows: [TradeMatchRow] }`. Each `TradeMatchRow` has:
  - `collector_id`, `handle`, `display_name`, `open_to_cash_offers`;
  - `match: 'two_way'|'has_what_you_want'|'wants_what_you_have'`;
  - `you_get: [TradeMatchCard]`, the Friend's listable copies that some viewer want accepts;
  - `you_give: [TradeMatchCard]`, the viewer's listable copies that the Friend's wants accept;
  - `TradeMatchCard {edition_id, name, set_code, set_name, collector_number, descriptor, image_url, copies: str, need: str, want_list_need: str, origin: 'want_list'|'trade_wants'|'both', accepts_as: 'exact'|'any_finish'|'same_name'|None}`. For a card of Edition X, read on the side that would receive it (the viewer for `you_get`, the Friend for `you_give`):
    - `want_list_need` is the sum of `want_list_need` over that side's wants W whose `accepts(W, rule)` contains X;
    - `need` is `want_list_need` plus that side's `trade_wants_quantity` for X itself;
    - `origin` is `both` when both parts are above 0, else the part that is;
    - `accepts_as` is set on `you_get` cards only. It is the narrowest match: `exact` when X is itself one of the viewer's wants, else `any_finish` when a `printing` rule reaches it, else `same_name`. It is None on `you_give` cards.

    The screen shows `need` with the Deck part, for example "6 wanted (2 for Decks)".
  - `more_you_get`, `more_you_give` as counts.

  Rows are sorted two-way first, then has-what-you-want, then wants-what-you-have, then by Display Name and Handle. Each row carries at most 20 cards per side, and `GET /api/social/trade-matches/{collector_id}` returns the full lists for one Friend. There are no values in discovery (map). Add `TradeMatchCard.descriptor` to `OPAQUE`.
- **`GET /api/social/trade-lists/{handle}`** is a Friend's whole Trade List, for the composer to add cards beyond the matches. It mirrors `friend_collection` (`friend_reads.py:171`): the same `FRIEND_BY_HANDLE` 404 `FRIEND_NOT_FOUND` rule, paging by Card Identity, and `q`.
- **`GET /api/social/trade-card-matches?printing_id=`** backs the card popup's Ask to trade: Friends with listable copies of the Printing's Editions.
- **Privacy guard changes** (`api/tests/test_social_contract.py`):
  - add `trade_want|trade_accept` to `INVENTORY_TABLE`, so in the social area only `friend_copies.py` reads them (`READERS` unchanged);
  - add `test_only_the_choke_point_reads_several_owners_inventory`: it scans every string constant (and f-string piece, never a docstring, as `inventory_reads` does) of every `api/app/**/*.py` outside `social/friend_copies.py`, and fails on one that both reads `holding`, `deck_list_line`, `location` or `borrowed_holding` (the `INVENTORY_TABLE` form) and filters with `owner_id = ANY(` or `borrower_id = ANY(`. A scan of today's code finds no hit, so it needs no allowlist. `counts.reserved_by_owner` reads only `reserved_copies`. It does not see `IN (...)` lists, joins through `friends_of`, unfiltered scans or SQL split across concatenated constants; review covers those (ADR 0015). Owner and admin aggregate reads such as `catalog_reconciliation.py:270-272` are exempt by the ADR;
  - the three caller guards below (`reserving_picks`, `trade_listable` and `for_trade_locations`) match string constants only (SQL text and f-string pieces, never docstrings or comments), as `inventory_reads` does. Prose in an error message or any other string must therefore not write the call form, the name followed by an open parenthesis;
  - add `test_only_counts_and_the_choke_point_call_reserving_picks`: across `api/app/**/*.py`, the files with a string constant that matches `\breserving_picks\s*\(` are exactly `{'social/counts.py', 'social/friend_copies.py'}`. `counts.py` calls it only for one owner (`ARRAY[%s]`), and every other reader goes through `counts.reserving_pick_rows` or `counts.reserved_picks`;
  - add `test_only_the_trade_list_and_the_choke_point_call_the_listable_rule`: across `api/app/**/*.py`, the files matching `\btrade_listable\s*\(` are exactly `{'trade_list.py', 'social/friend_copies.py'}`, and the files matching `\bfor_trade_locations\s*\(` are exactly `{'trade_list.py'}`;
  - add `('..copy_allocation', 'allocate_rows')` and `('..copy_allocation', 'AllocationRows')` to `ALLOWED_IMPORTS['social/friend_copies.py']`, beside the existing `('..', 'copy_allocation')`;
  - widen `HIDDEN_CALL` to `re.compile(r'\b(?:hidden_location(?:s|_ids)|for_trade_locations|trade_listable)\s*\(')`, so in the social area only `READERS` may call the For trade or listable rule, as for `hidden_locations`;
  - add `ALLOWED_IMPORTS['social/trades.py']` = `('..trade_picks','stale_pick_trades')`, `('..main','connect')`, `('..main','verified_user')`, `('..location_tree','error')`, `('..location_tree','replay')`, `('.friend_reads','card_facts')`, `('.owners','ensure_owner')`, `('.owners','lock_owners')`, `('.loans','advance_revision')`, `('.loans','NOW')` and `('.friends','friend_ids')`. Trades do not reuse `count_loan_command`; `social/trades.py` defines its own `count_trade_command` under kind `'trade_command'`. Because `social/friends.py` imports `end_trades_between` from `social/trades.py`, `trades.py` imports `friend_ids` inside the function that needs it, as `loans.loan_views` does (`loans.py:444`);
  - add `ALLOWED_IMPORTS['social/trade_matches.py']`, with `('..trade_list','own_trade_copies')`, `('..trade_wants','own_wants')`, `('..want_list','capture_want_list')`, `('.friend_copies','friend_trade_copies')`, `('.friend_copies','friend_wants')`, `('.friend_reads','card_facts')`, `('..card_accepts','accepts')`, `('.friend_reads','FRIEND_BY_HANDLE')`, `('.friend_reads','search_key')`, `('.friend_reads','PAGE_IDENTITIES')`, `('.','name_rules')`, `('.friends','friend_ids')`, `('..main','connect')`, `('..main','verified_user')` and `('..location_tree','error')`;
  - add to `ALLOWED_IMPORTS['social/inbox.py']` (beside its Loan entries, `test_social_contract.py:76-79`): `('.trades','TRADES')`, `('.trades','TradeView')`, `('.trades','trade_facts')`, `('.trades','trade_views')`, `('.trades','waiting_trade_step')` and `('.trades','trade_waiting_since')`;
  - leave `FRIENDS_OF_READERS` unchanged: `trade_matches` gets the viewer's Friends through `('.friends','friend_ids')` (add that import entry) and reads `collector_profile` for those ids only, so it never calls `friends_of` itself;
  - add `OPAQUE` entries for `TradeCard.descriptor` and `TradeMatchCard.descriptor`;
  - extend `test_every_social_route_answers_success_with_a_schema_the_walk_reads` with the new routes;
  - add `test_the_trade_statement_never_reads_borrowed_holdings` (`'borrowed_holding' not in friend_copies.TRADE_READ`).
- **Friend count assumption.** Nothing in the repo states one. Design target: 200 Friends, 2,000 listable Editions and 60 Decks per collector, `GET /api/social/trade-matches` p95 at most 1.5 s on the verification host. The spec requires a `slow` (`capacity:`) test that seeds this and measures it, marked `serial` because it bounds time.

## Value cues

`POST /api/trades/value` (`trade_value.py`):

- Body: `{lines: [{side: 'you_give'|'you_get', edition_id, quantity}]}`, at most 100 lines, duplicates refused with 422 `DUPLICATE_EDITION` per side. The list has no Pydantic `max_length`; more than 100 lines is 422 `TOO_MANY_LINES`, counted in code after the duplicate check. 100 lines at about 90 bytes each (about 9 KB) fit under the gateway's `BUDGET_BODY_BYTES = 16_384` (`auth/src/server.ts:72`).
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
  - rebuild the kind CHECK as the union of migration 130's kinds and `'swapped'`, with migration 105's DO-block pattern (skip when a CHECK already allows `'swapped'`, else drop every kind CHECK and add `inbox_update_kind_check CHECK (kind IN ('accepted','partly_accepted','declined','cancelled','return_by_changed','swapped'))`), under the migrations note's "whoever merges second" rule.

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
  - The existing `waiting` and `updates` fields are byte-identical, and their tests pass unchanged.
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
  | `NOT_TRADEABLE` | 409 | a line above its side's listable copies; `{edition_id, available, side}`, `side` being `you_give` or `you_get` |
  | `SAME_CARD_BOTH_SIDES` | 422 | one Edition on both sides of a proposal |
  | `TRADE_NOT_FOUND` | 404 | also for non-parties |
  | `TRADE_CHANGED` | 409 | stale revision |
  | `TRADE_HAS_NO_CARDS` | 422 | no side gives a card |
  | `CASH_ONLY_NOT_OPEN` | 409 | a cash-only side to a collector not Open to cash offers |
  | `INVALID_CASH` | 422 | `cents` not a whole number from 1 to 99,999,999 |
  | `DECK_SWITCH_CHANGED` | 409 | a chosen Deck switch that matches no candidate of the step's own computation (stale, unknown or too high); nothing changes |
  | `DECK_NOT_FOR_TRADE` | 409 | marking a Deck For trade |
  | `LOCATION_FOR_TRADE_BY_PARENT` | 409 | un-marking inside a marked ancestor |

- **Reused codes:** `STEP_NOT_ALLOWED`, `NOT_FRIENDS`, `OWN_ACCOUNT`, `DUPLICATE_EDITION`, `TOO_MANY_LINES` (422 everywhere: 50 lines per side, 100 value lines, 500 Trade Wants lines), `INVALID_QUANTITY`, `PICKS_OUT_OF_DATE`, `PICKS_UP_TO_DATE`, `LOCATION_NOT_FOUND`, `UNSORTED_UNAVAILABLE` (409, Confirm swap into Unsorted when the root named Unsorted cannot hold cards, `deck_deletion.py:57-58`), `TOO_MANY_CHANGES`, `INVENTORY_TEMPORARILY_UNAVAILABLE`.
- **Writers:**

  | Writer | Treatment |
  | --- | --- |
  | Moves | unchanged; a Location does not matter to a promise. Moving a picked copy makes the pick stale |
  | Inventory Removal, Undo, Edition reassignment | refuse via `check_promises` |
  | Deck deletion, leaf conversion | `counts.move_picks` re-keys `trade_pick` too |
  | Location deletion | refuses Holdings as today; a deleted pick source sets NULL, and the pick is stale |
  | Hide or show | unchanged; independent of For trade |
  | Add, batch add, Collection Import, Decklist Import | unchanged |
  | Confirm swap (new) | given copies leave through `moves.take_out`; received copies arrive through the new `moves.add_in`, a delegated deviation from the map's "existing writers" (Confirm swap step 3); chosen Deck switches are written with the Deck List changes batch's write logic (step 3b) |
  | Deck List changes batch | its write part is shared with Confirm swap's Deck switches and Swap; the route keeps its own lock, replay and revision check |
  | `swap_hints` | gains the Editions the line's Will accept rule accepts (Matching reads); unchanged when the rule is the exact card |
  | `copy_allocation`, `deck_pick_list`, `deck_ownership`, `available_to`, the Want List | figures follow `reserved_counts` and `reserved_picks`, so Trade-promised copies stop being Spare Copies as Loan-promised ones do, with no code change |
  | `friend_copies` (lend view) | a Trade-promised copy is no longer lendable (`reserved_by_owner`) |
  | `loan_inventory.can_promise` and Lend Offer caps | see Trade promises through `reserved_counts` and `pick_shortfalls` |
  | `counts.deck_loan_picks` ("reserved for Sam" on Deck lines) | stays Loan-only in Stage 1; a Trade pick in a Deck appears only after Use suggested picks (see "Not yet specified") |

## Glossary

[`CONTEXT.md`](../../../../CONTEXT.md) gains nine entries after **Write-off**, in this order: **Trade**, **Trade Proposal**, **For trade Location**, **Trade List**, **Trade Wants**, **Will accept**, **Trade Pick List**, **Confirm swap** and **Open to cash offers**. Three existing entries are amended so the glossary does not contradict itself:

- **Spare Copy**: "isn't promised to a Loan" becomes "isn't promised to a Loan or a Trade".
- **Friend**: Friends can also see each other's Trade Lists, and can lend and trade each other cards.
- **Hidden Location**: a hidden For trade Location's copies still appear on its owner's Trade List, though never its name.

The **Will accept** entry no longer says it changes only trade matching: a card received through a widened rule can switch the Deck line, offered at Confirm swap, and the Swap hint also considers the cards the rule accepts. **Trade Wants** adds that a line adds to any Deck need for the same Card Edition.

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
   - a direct SQL write that clears `proposer_swap_at` on a Trade whose copies are gone fails at commit (the guard fires on `proposer_swap_at`, `recipient_swap_at` and the owner ids, and checks a side that NEW reserves and OLD did not);
   - Deck deletion and leaf conversion carry `trade_pick`;
   - Lend Offers never pick copies a Trade covers;
   - **the pick order without Trades is today's** (`test_an_offered_lend_offer_still_yields_to_an_accepted_loan_for_picks`): lender L holds 3 copies of E in binder B. Lend Offer O1 is created first and picks 1 from B, and stays offered. Borrow Request R2 is created and accepted later, and picks 2 from B. A Move takes 1 copy from B to C. Then `stale_pick_loans(L, [O1, R2]) == {O1}`, R2's handover is not refused with `PICKS_OUT_OF_DATE`, O1's `replacement_picks` names C, and `covered[E] == {B: 2}`. A coalesced reserved time would make R2 the stale one;
   - `trade_listable` agrees with the listable rule: a reserved copy picked from a Deck does not shrink the Trade List, a stale pick never over-lists, a marked binder inside a marked box lists each copy once, and the own and Friend reads give the same count for the same collector;
   - two concurrent sends, or a send racing an accept, for the same copies: one succeeds and the sums hold.
3. **Trade steps (`test_trades.py`):**
   - every state and closed reason;
   - Counter closes, reopens prefilled, swaps the reserved side and checks `countered_from`;
   - `test_a_counter_keeping_every_card_the_sender_listed_exactly_succeeds`: P lists exactly 2 copies of E and proposes them for R's F. R counters asking for both copies of E, and the response is 200. The old row is `closed/countered`, the new row is `proposed` with `countered_from` set, P's 2 copies of E are not reserved, and R's F is;
   - `test_a_refused_counter_leaves_the_original_proposal_and_its_picks`: R counters asking for 3 copies of E when P lists 2. The response is 409 `NOT_TRADEABLE` with `{edition_id: E, available: 2, side: 'you_get'}`, the old row is still `proposed` at its old revision, and P's picks and reserved count are unchanged;
   - the `allowed` table row by row, including Use suggested picks for the proposer of a `proposed` row and `PICKS_UP_TO_DATE` when nothing is stale;
   - `SAME_CARD_BOTH_SIDES`, and a gift plus cash (cards and cash from one side, nothing from the other) accepted with the recipient not Open to cash offers;
   - Accept refused with `NOT_FRIENDS` once the friendship is gone (seeded directly, since unfriend would cancel the Trade first);
   - accept and decline are whole only;
   - cancel is allowed only while nobody has confirmed;
   - a half-confirmed Trade allows only Confirm swap for the other side;
   - `TRADE_CHANGED` on a stale revision;
   - idempotent replay;
   - the 120-per-hour limit;
   - every shape rule (`TRADE_HAS_NO_CARDS`, a gift with nothing on one side accepted, `CASH_ONLY_NOT_OPEN` both directions and on a Counter whose recipient is not Open to cash offers when the countered proposal had no cash-only side, and a cash Counter allowed when it had one, `INVALID_CASH`, cash alongside cards always allowed);
   - lines capped at listable copies, with a hidden For trade Location counting, a Deck inside a For trade Location never counting, and Borrowed Copies never counting.
4. **Confirm swap (`test_trade_swap.py`):**
   - given copies leave their picks with no Undo record and Deck List lines unchanged;
   - received copies land in the destination (or Unsorted) and raise a Deck's line;
   - totals change on both sides only after each side's own confirm;
   - stale picks give `PICKS_OUT_OF_DATE`, then Use suggested picks;
   - Trade Wants drop only by the copies the Decks did not need: Decks need 2, Trade Wants say 4, 3 arrive, and the line goes to 3. When received copies cover the line, it is deleted, never set to 0. Copies of another Edition received through Will accept lower no line;
   - the confirmer's revision advances exactly once, whether they give, receive or both;
   - `destination_id` is ignored when the confirmer receives nothing: a bad id is not refused, and no Unsorted is created;
   - 409 `UNSORTED_UNAVAILABLE` when no destination is given and the root named Unsorted is an Organizational Location;
   - the second confirm closes the Trade as `swapped`;
   - confirming alone after the other's account is gone, and after a Block;
   - an older Undo record behaves as after a Loan handover;
   - **Deck switches:**
     - `test_a_ticked_switch_moves_the_deck_line_and_the_need_goes`: Deck D needs 1 of A, the confirmer's Will accept for A is the same name, and 1 copy of B (same Card Identity) arrives. Confirm swap with the switch moves D's line from A to B, the Want List no longer needs A, and the Trade Wants line for B is untouched;
     - `test_an_unticked_switch_leaves_the_deck_list_alone`: the same Trade confirmed with no `deck_switches`: D still lists A, the Want List still needs A and the received B arrived as an ordinary Holding;
     - `test_a_stale_switch_gives_deck_switch_changed_and_changes_nothing`: after the side read, D's line of A is changed or removed, or the switch asks for a higher count than the candidate. The response is 409 `DECK_SWITCH_CHANGED`, no copy left or arrived, no `*_swap_at` is set, no Deck List moved, and the inventory revision is unchanged;
     - a switch never exceeds the line's remaining need, copies are switched oldest Deck first, and copies the Decks need of B itself are not switched;
     - the switch advances only the Decks' own Deck List revisions, never the inventory revision (the confirmer's revision still moves once), and is undone by the Deck List changes batch's inverse, with no inventory Undo record written;
     - a destination that is the switched Deck is not counted twice.
5. **Ending a friendship (extend `test_ending_friendship.py`):**
   - Remove Friend and Block cancel unconfirmed Trades and release both sides' reservations with the right revisions;
   - half-confirmed Trades stay;
   - the update reads "cancelled" with no reason. It is byte-identical between unfriend and Block, and for an accepted Trade it is also byte-identical to a plain cancel. A proposed row's update reads "cancelled" whichever ended the friendship.
6. **Privacy (`test_trade_matches.py`, extend `test_social_contract.py`):**
   - non-Friends, a Blocked collector either way and pending requests see no Trade List and no wants;
   - promised copies leave the Trade List at once, and copies come back when released;
   - wants from Decks in Hidden Locations are absent (question 2);
   - `test_a_hidden_older_deck_still_takes_spare_copies_from_a_friends_view` under `all_at_once`: the Friend holds 1 copy of E, an older hidden Deck needs 1 and a newer visible Deck needs 1. The viewer sees `want_list_need` 1 for E, the visible Deck's need on the Friend's own Want List, not 0 and not 2;
   - only `social/counts.py` and `social/friend_copies.py` call `reserving_picks`; only `trade_list.py` and `social/friend_copies.py` call `trade_listable`;
   - no `/api/social` trade response has a Location or Deck field, and the Deck switch candidates appear only in `GET /api/trades/{id}/side`, never in a `TradeView`;
   - in the social area, no social module calls `for_trade_locations`, and only `friend_copies.py` calls `trade_listable` or reads `trade_want` or `trade_accept`;
   - `TRADE_READ` never reads `borrowed_holding`.
7. **Matching:**
   - two-way, has-what-you-want and wants-what-you-have ordering;
   - each Will accept rule (exact Edition only; any finish; same Card Identity including other Printings);
   - Trade Wants are always exact;
   - `origin` is `want_list`, `trade_wants` or `both`; `need` is the Want List part plus the Trade Wants quantity, and `want_list_need` is the Want List part;
   - a Friend's need follows their counting setting;
   - the 20-card cap with `more_*` counts and the full per-Friend read;
   - Open to cash offers on the row;
   - no values in discovery;
   - the collector's own spare copies of an Edition their Will accept rule accepts do not reduce the need shown in discovery, for the viewer's wants and for a Friend's (`friend_wants`), until a switch is made;
   - **Swap hint with Will accept widened:** a line of A that needs copies, Will accept the same name, and a spare copy of B owned: the line carries a hint offering B, sending it is one Deck List changes batch that lowers A and raises or adds B, and the need then falls; a spare copy is offered to one line only, oldest Deck first;
   - **Swap hint with the exact card:** with no `trade_accept` row (or `edition`) every hint, count and figure is identical to today's, and the existing Swap hint tests pass unchanged.
8. **Capacity (`slow`, `capacity:`, `serial`):** 200 Friends x 2,000 listable Editions x 60 Decks; `trade-matches` p95 at most 1.5 s.
9. **Value (`test_trade_value.py`):** exact micro-dollar fold per side; statuses; the response schema has no `provider_*`, `checked_at`, `refresh` or source name; the route is budgeted (401 without a budget, as `want-list/cost`).
10. **Inbox (extend `test_inbox.py`):**
    - `answer`, `fix_picks`, `confirm_swap` and their `since`;
    - the four stored kinds with `withdrawn` read from `closed_reason`;
    - Trade updates clear and read through the existing routes and are pruned after 90 days;
    - an old-style query (inner join on `loan`) ignores Trade rows;
    - with no Trades, the `waiting` and `updates` fields are byte-identical to today's.
11. **Concurrency (real PostgreSQL, opposite directions):**
    - Counter versus withdraw;
    - cancel versus Confirm swap;
    - both Confirm swaps at once: one answers 200, the other 409 `TRADE_CHANGED`, and its retry with the new revision closes the Trade as `swapped`;
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
- whether and how the web offers an Undo of a Deck switch after Confirm swap (`TradeView` carries no Deck);
- nudges for unanswered proposals;
- Edit and resend for proposals.

Risks to carry into the spec and tickets:

- **The `reserved_copies` redefinition is the riskiest change.** Every inventory figure reads it. The implementation ticket must land the allocation refactor and this redefinition with figure-neutral tests (no Trades present means identical figures), and must check the 106 redefinition rule when merging.
- **Pick ids across two tables.** Sharing `loan_pick_id_seq` keeps `pick_shortfalls`' dict keys unique. The reviewer should confirm no code assumes a pick id is a `loan_pick` row id; `loan_inventory.replacement_picks` filters by `loan_id` first.
- **Lock order.** Unfriend now cancels Loans then Trades inside one Friend command: owners, then `loan` rows, then `trade` rows. Any future step touching both a Loan and a Trade must keep that order.
- **The Friend Want List read is the first cross-collector use of `allocate`.** It must stay inside `friend_copies.py`, run lock-free in one snapshot, and return only `(friend, Edition, want_list_need, trade_wants_quantity, rule)`.
- **Reservations never expire** (map). A half-confirmed Trade whose remaining side never confirms keeps that side's copies promised indefinitely. Surfacing it is only the `confirm_swap` waiting line.
- **Deploy order.** Migrations 140-144 keep an older API build working: it ignores Trade inbox rows and sees `reserved_copies` with no Trades. Deploy migrations first.
- **Deck switches cross two writers.** Confirm swap must reuse the Deck List changes batch's write part without its `FOR UPDATE` lock, and Swap hints now read `trade_accept`. The refactor of the batch must be figure-neutral (the existing batch and Swap hint tests pass unchanged). See the settled points under Later decisions.
- **Gateway allowlist.** `/api/trades/value` must be added to `auth/src/server.ts` as well as `price_budget.py`.
