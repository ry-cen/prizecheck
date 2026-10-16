# Decide the social module boundary and privacy enforcement

Resolves [Decide the social module boundary and privacy enforcement](https://github.com/ry-cen/prizecheck/issues/241) on 2026-10-15. The owner delegated the technical plumbing, which Claude decided. The owner was grilled only on what collectors see; those answers are marked **Owner's choice**. It builds on the [copy allocation research](../research/copy-allocation-and-loans.md), [the Loan inventory model](decide-loan-inventory-model.md), [the Loan steps](decide-loan-steps.md) and [the Handle and Invite Link rules](decide-handle-and-invite-link-rules.md). The cross-owner pattern is recorded in [ADR 0014](../../../../adr/0014-friend-reads-and-two-owner-loans.md).

## What collectors see

- **Owner's choice:** Friends see only copies the collector could lend now. Reserved and lent copies are left out of every Friend view, so their counts can be lower than the collector's own Collection total. Borrowed Copies are never shown to Friends either.
- **Owner's choice:** any Location can be hidden: an organization Location, a Storage Leaf, a Deck or Unsorted. Hiding covers everything inside, including Locations added later. A Location inside a hidden one can't be un-hidden on its own. Moving copies into or out of a hidden Location changes what Friends see straight away. Hiding never affects accepted Loans. The collector's own screens mark the Location "Hidden from Friends".
- **Owner's choice:** a Handle lookup shows the Display Name and Handle with **Send Friend Request**, or says the two are already Friends or a request is pending. A miss shows "No collector has that Handle." Someone who has Blocked you gets exactly the same result. A collector you've Blocked is shown with **Unblock**. Each account gets 30 lookups per hour, and after that sees "Too many searches. Try again in N minutes."
- Generated Handles can be looked up by exact match like any other, since they're too long to guess. That settles #238's "indistinguishable" point: blocked-you and unknown give one identical response, and a generated Handle isn't special.

## Module boundary

- A new `social` area of the API (`api/app/social/`) owns Friends, Friend Requests, Handles and Display Names, Invite Links, Blocks, Hidden Locations, Loans and the inbox. Its routes live under `/api/social/...` (Friend reads, Loans, inbox) and `/api/profile` (Handle, Display Name, Invite Link). Its tables are new. The only existing table it changes is `location`, which gains a hidden flag.
- Inventory code doesn't import Loan logic. It calls a few narrow functions that the `social` area exports:
  - `reserved_counts(conn, owner_id, edition_ids)`: copies reserved and not yet handed over by the lender, per Edition. That covers both Lend Offers that have been sent and accepted Borrow Requests, because a Lend Offer reserves copies the moment it's sent.
  - `lent_counts(conn, owner_id, edition_ids)`: copies the lender has handed over and not had back or written off, per Edition, for Collection totals and the lender's lent view.
  - `borrowed_in(conn, owner_id, location_ids)`: Borrowed Copies in those Locations, for every read that means "the physical Deck".
- The `social` area calls back into inventory only through existing functions (the owner lock, the Spare Copy rule, Location lookups). It never writes `holding` rows except through the inventory functions that Moves already use, so Undo and the Deck List trigger stay consistent.

## The Spare Copy rule moves into one function

- Before any Loan code lands, the rule written out in five places (`copy_allocation.py:147-149` and `:254`, `deck_ownership.py:94-98` and `:173`, `swap_hints.py:144`, `deck_pick_list.py:169`) becomes one function in `copy_allocation`. It takes the Holdings, Deck List lines and `reserved_counts`, and returns spare and per-Deck own copies.
- The Friend view becomes the sixth caller instead of a sixth copy. That refactor is its own implementation ticket and must not change any figure.

## Lender-side data: Loan lines and picks (the research's L2, per Edition)

- `loan_line(loan_id, edition_id, requested, promised, written_off)` holds what was asked, what the lender promised (or offered) and how many copies have been written off.
- `loan_pick(loan_id, edition_id, source_location_id, quantity, state)` is the Pick List and remembers each copy's source. `source_location_id` is a nullable FK to the lender's Location, `ON DELETE SET NULL`. A deleted source returns copies to Unsorted by default.
- **The invariant is per Edition, not per Location**, because lent copies sit in no Location. For each lender and Edition: Σ `loan_line.promised` over Loans that are `offered` or `accepted` and not yet handed over by the lender ≤ Σ `holding.quantity`. A deferred constraint trigger on `holding`, `loan` and `loan_line` (in the style of `holding_leaf_guard`) enforces it. Picks are left out on purpose, because they're allowed to go stale. Writers check first, so collectors get a clear 409 instead of a failed commit:
  - Inventory Removal, inventory Undo and Edition reassignment refuse with `PROMISED_TO_LOAN` when they would break it.
  - Moves are fine, because Location doesn't matter to the invariant.
- **Stale picks are computed, not stored.** A pick whose source Location now has fewer copies of that Edition than other picks claim is flagged when read, with a suggested new source from the same suggestion order as the Pick List.
- Lender handover confirm removes the picked copies from their Holdings in one statement through the Moves path, with no destination and no Undo record. `lent_counts` then covers them. Return confirm inserts them at each pick's source, or at the chosen Locations, again with no Undo record.
- Collection totals and the Location tree's figures add `lent_counts` back as a lent line, because the lender still owns those copies. The catalog's "owned" filter counts them as owned.
- Deck deletion and leaf conversion re-key `loan_pick.source_location_id` in the same transaction as they move Holdings. Location deletion already refuses a Location with Holdings; a lent source with no Holdings left may be deleted, and its picks then point to Unsorted.

## Borrower-side data: a separate table (the research's B1)

- `borrowed_holding(id, loan_id, borrower_id, location_id, edition_id, quantity)` has a composite FK `(borrower_id, location_id)` to the borrower's Location. It never appears in `holding`, so the Collection, tree, catalog, Removal and Undo stay correct without changes.
- Reads that mean "the physical Deck" union in `borrowed_in`: `allocate` and `deck_lines` (Borrowed Copies count as `held` for the Deck they're in only), `read_ownership`, the Deck index, `basic_checks`, `deck_contents`, `deck_list_capture` and the Estimated Deck Cost.
- Reads that never see Borrowed Copies: Spare Copies, Surplus, `available_to` (Use cards I own), Swap hints, Removal, Undo, Collection totals, and every Friend view.
- **Deck List growth:** a trigger on `borrowed_holding` calls the same rule as the `holding` trigger in migration 047, through one shared SQL function, so a Borrowed Copy entering a Deck adds or raises a line exactly as an owned copy does.
- Moving a Borrowed Copy is a dedicated `social` route, not a general Move, because it carries `loan_id` and must never mix with owned copies. Deck deletion moves the Deck's `borrowed_holding` rows to the borrower's Unsorted.
- **Write-off** is lender-only and lender-locked: it raises `loan_line.written_off` and never touches the borrower's rows, so it can cover part of a line even when the Borrowed Copies are spread across several Decks. The borrower's keep-or-remove choice is a borrower-locked step. The borrower picks which `borrowed_holding` rows make up the written-off count. *Keep* deletes them and inserts owned Holdings at the same Locations through the Add path, with an Undo record. *Remove* deletes them. Until the borrower chooses, the Loan shows those copies as written off and awaiting their choice.

## Loans, requests and the inbox

- `loan(id, kind, state, lender_id, borrower_id, lender_name, borrower_name, deck_id, return_by, lender_handover_at, borrower_handover_at, created_at, revision)` is one table for Borrow Requests, Lend Offers and the Loans they become.
  - `lender_id` and `borrower_id` are nullable FKs with `ON DELETE SET NULL`. `lender_name` and `borrower_name` keep a copy of each Display Name, so "Ash deleted their account" still shows after deletion. The copy is refreshed whenever the Display Name changes.
  - `deck_id` is the borrower's Deck, `ON DELETE SET NULL`.
  - `state` is one of `requested`, `offered`, `accepted`, `handed_over`, `closed`, with `closed_reason` set to `declined`, `withdrawn`, `cancelled`, `returned` or `written_off`. The one-sided handover confirmations are the two timestamps, not extra states.
- `loan_return(id, loan_id, lender_confirmed_at, borrower_confirmed_at)` and `loan_return_line(return_id, edition_id, quantity, destination_location_id)` carry partial returns. A one-sided confirmation is accepted only when the counterparty column is NULL.
- `friendship(user_low, user_high, state, requested_by, created_at)` stores each pair once, in `user_id` order. `block(blocker_id, blocked_id)` stores Blocks.
- **Inbox:** "waiting on you" is derived on each read from Friend Request, Loan, return and Write-off state. Nothing about it is stored, so it can't drift. The app has no scheduler, so the time-based Updates (overdue, and the 14-day nudge) are also derived on read, from `return_by` and the Loan's timestamps. A stored dismissal (`loan_notice_seen(loan_id, user_id, kind)`) makes each one appear only once. Event Updates are stored in `inbox_update(id, recipient_id, kind, loan_id, other_name, created_at, read_at, dismissed_at)`. Cancel updates record only that the Loan was cancelled and by whom, never why, so a Block or unfriend is never shown. Read and dismissed updates are deleted lazily 90 days after they were read.

## Locks and revisions

- **Global lock order:** `inventory_owner` rows in ascending `user_id`, then the `loan` row. Every route that touches two owners locks both owner rows in that order before reading anything.
- Most steps touch one owner, because each side's confirmation changes only their own inventory:

| Step | Locks | Revisions advanced |
|---|---|---|
| Lender accepts a Borrow Request, or sends a Lend Offer | lender | lender |
| Lender confirms handover or return, or writes off | lender | lender |
| Borrower confirms handover or return, moves Borrowed Copies, or chooses keep or remove | borrower | borrower |
| Borrower cancels an accepted Loan, declines a Lend Offer, or accepts part of one | both | lender (released reservation) |
| Lender cancels, declines or withdraws before handover | lender | lender |
| Unfriend or Block cancels Loans not yet handed over | both | lender of each cancelled Loan |
| Date changes, extension requests, inbox reads | `loan` row only | none |

- Two acceptances racing for the same copies both need the lender's owner lock, so they run one after the other, and the second sees the first's reservation. The deferred trigger is the backstop.
- Taking back a one-sided handover confirmation reverses only that side's inventory write, under that side's lock.

## Friend-facing reads: one choke point

- Every Friend-facing read goes through one function, `friend_copies(conn, viewer_id, friend_ids, edition_ids=None)`. It is the only code in the API that reads another collector's inventory. In one statement it:
  - keeps only Friends with an accepted friendship and no Block in either direction;
  - drops Holdings in hidden Locations, worked out with a recursive CTE over `location.parent_id`;
  - subtracts `reserved_counts`. Lent copies are already absent from `holding`, and Borrowed Copies live in another table;
  - applies the shared Spare Copy rule and returns only `(friend_id, edition_id, spare, in_deck)`.

  It never returns a Location or Deck name or id.
- It is batched across all of the viewer's Friends and requested Editions. The `holding` primary key already leads with `owner_id`, so the read is one index range per Friend, paired in memory. It does not run `allocate` once per Friend.
- **Friend matches are a separate, unpinned read.** `/api/social/want-list-matches` takes the viewer's Want List Editions and expands them by the viewer's counting setting (other Printings in the Reprint Group under Use cards I own). The Want List response, its revision pin and its Mass Entry 409 don't depend on other collectors' revisions.
- A contract test walks the generated OpenAPI schema for every `/api/social` response and fails on any field named for a Location or Deck. That guards the privacy rule against future edits.
- A Friend Collection view uses the same function with `edition_ids=None` and pages by Card Identity.
- **Card search** (the catalog card popup, and ad-hoc search for any card) calls the same function for that card's Editions, expanded by the viewer's counting setting the same way the Want List matches are.

## Handles, Invite Links and lookup

- `collector_profile(user_id, handle, handle_key, display_name, handle_changed_at)` lives in the API database. `user_id` is the PK and an FK to `inventory_owner` with `ON DELETE CASCADE`, and `handle_key` (the lower-cased Handle) is unique. A Handle and Display Name are generated when the `inventory_owner` row is created, and a migration backfills existing accounts.
- `released_handle(handle_key, released_at)` holds a changed Handle for 30 days. The 30-day change limit uses `handle_changed_at`.
- `invite_link(user_id, token_hash, created_at)` keeps one row per collector. Regenerating it replaces the hash.
- **The signed-out Invite Link page** follows the Published Deck rule that anonymous reads never wake PostgreSQL. The public projection gains an `invites` map from token hash to Display Name. Creating, regenerating and Display Name changes write it, and account deletion removes the entry. The gateway serves it under the existing `PublicReadLimiter`. Signed in, the page uses an authenticated route that also applies Blocks ("this link no longer works").
- **Lookup limit:** `handle_lookup_event(user_id, created_at)` counts lookups, and old rows are pruned when one is written, as `auth_rate_event` is. Unknown and blocked-you lookups run the same single query and return the same 404 body, so the two can't be told apart.

## Account deletion

- No account deletion feature exists yet. When it's built, it must first close everything #237 lists: cancel Loans not yet handed over (releasing reservations and sending Updates), and leave handed-over Loans to the other side through `ON DELETE SET NULL`. Only then is the `inventory_owner` row deleted, which cascades the collector's own rows.
- The other side's `borrowed_holding` and the Loan rows survive, because they belong to the remaining collector or to the Loan.

## ADR

- [ADR 0014](../../../../adr/0014-friend-reads-and-two-owner-loans.md) records the two new patterns: the first read across collectors, which is guarded in application code because there's no row-level security, and steps that lock two owners in a fixed order.
