# Want List: Friend requests waiting on a Deck's missing lines (corrected design, not yet authorized)

Status: design only. The endpoint still needs the user's approval, and independent review findings are folded in
below. No production code.
Base: `origin/dev` 2ea3f72; PR 455 head 93e7350 (it owns `WantListView`, `NeededLines` and `DeckWantListPanel`).
Product decision (owner, 2026-10-30 22:40): show the copies asked for and the copies a Friend accepted as separate
information, without lowering what the app says the collector still owns or needs to buy. No merging of requests,
no defaults, no bulk handovers and no draft merging.

## First slice (coordinator bounds)

- Per Deck only: requested, accepted and lender attribution for one Deck's missing lines.
- No All Decks aggregate, no `loan_id` for navigation and no index migration. A benchmark can justify an index later.
- Accepted Lend Offers that name a Deck count as accepted, because that is their real state. Unanswered offers have
  no Deck and are out of scope.
- Drafts stay client-only (`BorrowDrafts.tsx`, `sessionStorage`) with their own indicator. The API never sees them,
  so they can't be counted twice.

## Facts from the code

- `loan.deck_id` is the borrower's Deck, or NULL for Unsorted. A FK keeps it inside the borrower's Locations, and
  deleting the Deck sets it to NULL.
- Sending a request (`loan_inventory.send_borrow_request`) creates `state='requested'` with `requested` set and
  `promised=0`.
- Accepting (`loan_inventory.accept`): per line `0 <= promised <= requested`, at least one copy in all, then
  `accepted`. Accepting a Lend Offer (`accept_offer`) sets `deck_id` and `accepted`, with `promised` as the copies taken.
- Handover: each side confirms separately, and the state stays `accepted` until both have. The borrower's
  confirmation inserts `promised - written_off` into `borrowed_holding` at the Deck, or at Unsorted when the Deck is
  gone, sets `borrower_handover_at` and moves the borrower's `owner_revision`. The copies then count as `borrowed`.
  Take-back reverses this.
- Write-off (`loan_inventory.write_off`, lines 951–987) needs the lender's handover confirmed. It can happen while the
  borrower hasn't received, so it lowers what is still pending. It moves only the lender's revision and **stores no
  `inbox_update`**.
- **Review finding 1:** `social.loans.end_loans_between` cancels only Loans with **both** `lender_handover_at` and
  `borrower_handover_at` NULL. An accepted Loan the lender has confirmed and the borrower hasn't survives Remove Friend
  and Block, and is still pending. The design does **not** filter on the current friendship: such a Loan stays
  pending until the borrower receives the copies or the Loan closes.
- Sending, accepting, declining, withdrawing, cancelling and write-off never move the borrower's `owner_revision`.

## Count semantics (borrower B, Deck D, Card Edition E)

- **requested** = sum of `loan_line.requested` over B's Loans with `state='requested'`, `deck_id=D` and that Edition.
- **accepted** = sum of `promised - written_off` over B's Loans with `state='accepted'`, `borrower_handover_at IS NULL`,
  `deck_id=D` and that Edition, where `promised > written_off`. This includes accepted Lend Offers that name D, and
  Loans that outlived a friendship that ended (finding 1).
- A Loan is in exactly one state, so nothing is counted twice. A partly accepted request shows only what was promised.
  Once the borrower confirms receipt, the copies leave this read and appear as `borrowed` in the Want List. Take-back
  brings them back here.
- Not counted: closed or handed-over Loans, unanswered Lend Offers, Unsorted or deleted-Deck Loans, and Editions D's
  Deck List doesn't name (silently absent, disclosed below).
- Nothing changes in `need`, `to_get`, `combined`, cost, Mass Entry, exports, the
  `held + borrowed + spare + other_decks + lent + need == quantity` identity, `owner_revision` or any pin. The counts
  are information only and aren't capped at `need`.

## API (pending user approval): a separate read with no pins

`GET /api/loans/pending?deck=<uuid>` in `app/loan_inventory.py`, using `verified_user`:

```python
class PendingLender(BaseModel):
    lender: str                              # Lender's Display Name, as LoanView shows it to the borrower
    state: Literal['requested', 'accepted']
    copies: str

class PendingLine(BaseModel):
    edition_id: UUID
    requested: str                           # Sum over the 'requested' lenders
    accepted: str                            # Sum over the 'accepted' lenders
    lenders: list[PendingLender]             # Accepted first, then requested, oldest Loan first

class PendingLoans(BaseModel):
    deck_id: UUID
    lines: list[PendingLine]                 # Only Editions that D's Deck List names; Edition order
```

- `deck` is required and must be one of the caller's own Decks, otherwise 404 `DECK_NOT_FOUND`. There is no All
  Decks form.
- The read is one batched statement through `app.social.counts.pending_for_borrower(conn, borrower_id, deck_id)`.
  It joins `loan` and `loan_line` with the semi-join `edition_id IN (SELECT edition_id FROM deck_list_line WHERE
  owner_id=%s AND deck_id=%s)` and `borrower_id = caller`. It takes no owner lock, runs no per-line query and reads
  no prices.
- No `loan_id`, `collector_id`, Handle, or Location or Deck of the lender is returned. ADR 0014's `friend_copies`
  single point is untouched. The lender's and a stranger's reads return nothing.
- `capture_want_list`, `WantList`, `WantListLine`, cost and Mass Entry are **unchanged**. This avoids re-reading the
  owner-locked capture, and the new price lookup `useWantListCost` starts for every new answer
  (`WantListCost.tsx:44-75`), just to refresh pending information.
- No index migration in this slice. The existing `loan_borrower(borrower_id, created_at DESC)` serves it. An
  `EXPLAIN` of a borrower with a long Loan history goes with the PR, and a partial index is a later decision.

## Web refresh contract (bounded; no new polling and no shared revision)

Today (evidence): `WantListView.tsx:144-162` reads only on mount, a change of scope and `attempt`. PR 455's
`PanelBody` reads on `[deckId, pins, attempt]`. A hidden Decks slot renders `/decks` (`keptPages.pageAddress`,
`main.tsx:320-383`), so both views remount when the collector comes back from another tab. Neither listens for focus,
the pulse or Loans changes.

A hook `usePendingLoans(deckId: string | null)`. Its only consumers are the Deck's Want List section and the PR 455
panel, and it is wired in after PR 455 merges. It reads the endpoint again on:

1. Mount and a change of the Deck in scope. A null scope (All Decks) reads nothing.
2. `window` `focus` and `document` `visibilitychange` to visible. These two are **deduped**, so one burst gives one
   read: no new read starts while one for the same key is in flight or within a short coalescing window.
3. The existing `usePulseChanged()` counter.
4. The existing `useLoansChanged()` counter.
5. A send by this tab. On success, the `BorrowDrafts.tsx` composer calls the existing `useNoteLoansChanged()`, which
   covers Edit and resend too. That is one line, agreed with the draft-prefill track. `BorrowDraftsProvider` sits
   inside `InboxProvider` (`Shell.tsx:112-127`).

Rules:
- **No work while hidden.** A trigger while `document.visibilityState !== 'visible'` is ignored, and the visible event
  reads.
- **Abort or discard obsolete answers.** Each read carries `(accountId, deckId, generation)`. A new trigger aborts the
  read in flight. An answer whose key no longer matches is dropped, which covers a scope change, an account switch
  (the same sign-out pattern as `forgetBorrowDrafts`) and an unmount.
- **A failed read is explicit.** Never show zero. With an earlier answer for the same key, keep it and mark it
  stale (a quiet "may be out of date" cue with a retry). With none, show an error state for the pending information
  only, and never "nothing requested". The Want List figures are unaffected either way.
- It never re-reads the Want List or cost.

What this guarantees: the information is current on mount, on a change of scope, on coming back to the tab or window,
after a local send, after a Friend command in this tab, and after any event that moves the pulse. That covers the
lender's accept, partly accept, decline and cancel, and ending a friendship, within the pulse cadence (60 s while
visible) while the page is in the foreground.

**Limitation (finding 2): no bounded freshness for some remote events while the page stays in the foreground.** The
pulse hashes `inbox_update` rows, not Loan revisions. A lender's write-off stores no inbox update, and neither do the
borrower's own steps on another device (withdraw, cancel, receipt, take-back), because those updates go to the lender.
While the page stays visible and focused, those changes show only at the next focus, visibility change, navigation or
other trigger. This slice accepts that. Fixing it would need new polling or a shared Loan revision contract, both
out of scope. It matches today's Want List, which doesn't follow changes from other devices at all.

## Affected files (when authorized)

- `api/app/social/counts.py`: `pending_for_borrower`.
- `api/app/loan_inventory.py`: the route and its models.
- `api/tests/test_pending_loans.py` (new).
- `api/tests/api_contract/openapi.json` and `routes.json`, and the regenerated loans/social generated client.
- `scripts/python_architecture_rules.py` only if the boundary check asks for it.
- Web, after PR 455: `web/src/loans/usePendingLoans.ts` and its Vitest, the one-line `BorrowDrafts.tsx` hook, the
  consumers in `WantListView` and `DeckWantListPanel`, and a Playwright spec.

## Acceptance tests

API:
1. A request for D, E:3 → requested 3, accepted 0, with the lender's name. The `GET /api/want-list` answer, including
   `owner_revision` and the digest, is identical to the answer before the request.
2. Partial accept, 1 of 3 → requested 0, accepted 1. A line left out (promised 0) shows nothing.
3. Decline, withdraw, cancel and Edit and resend → the old request goes, and the resent one shows once.
4. Lender confirms the handover, borrower hasn't → still accepted. Borrower confirms → pending gone and `borrowed`
   up in the Want List. Take-back → accepted again.
5. **Partial write-off** after the lender confirmed and before the borrower received → accepted =
   `promised - written_off`. A full write-off of the line → absent.
6. A Lend Offer still offered → nothing. Accepted with Deck D → accepted. Accepted to Unsorted → nothing.
7. Unsorted, deleted Deck, an Edition D doesn't list → nothing. A `deck` that isn't one of the caller's Decks → 404.
8. Two lenders on one line → two entries and summed counts. The same Edition for D1 and D2 → each Deck shows only its
   own.
9. **Finding 1:** unfriend or Block with both handover timestamps NULL → gone. Unfriend or Block after the lender
   confirmed and before the borrower did → still accepted, still attributed.
10. The lender's read and a stranger's read → nothing. The response has no `loan_id`, `collector_id`, Handle,
    Location or Deck.
11. One statement per read whatever the number of Loans and lines. No owner lock and no price access.

Vitest (`usePendingLoans`, mocked fetch, document and window):
- Reads on mount and on a scope change. A null scope reads nothing.
- A `focus` and `visibilitychange` together cause one read.
- No read while hidden. Becoming visible reads.
- Moving the pulse or loans-changed counter causes a read.
- A slow answer for an old scope, account or generation is discarded.
- **Account switch:** no answer from the earlier account shows after the switch.
- **Failed refresh:** an earlier answer stays and is marked stale. With no earlier answer, an error shows and never
  zero.
- The Want List and cost are never fetched by the hook.

Playwright (after PR 455; two browser contexts where noted):
- Ask from the Want List, then send in the composer → the line shows the request without reloading.
- The lender accepts in the second context, then the pulse moves or a focus → the line shows the promised copies.
- **Partial write-off with the pulse unchanged:** the lender confirms the handover and writes off part of it. The
  borrower page shows the old count until a blur and focus, then shows `promised - written_off`.
- **Receipt on another device:** the borrower's second context confirms receipt. The first context clears the
  pending count on focus.
- **Failed refresh:** the route fails on refocus → the stale cue shows and the counts are not zeroed.

## Risks and open items

- The endpoint is a public API addition and needs the user's approval and independent review before merge.
- The foreground limitation above is accepted for this slice and stays visible in this file and the PR.
- Requests for an Edition D doesn't list are silently absent.
- The one-line `BorrowDrafts.tsx` hook needs the draft-prefill track's agreement.
- The consumers wait for PR 455, and the order is 455, then location, then loanlink.
- UI copy and placement next to the draft indicator are decided after PR 455.

## Implementation status (2026-10-31, local, uncommitted, on e6e29e0)

User approved the endpoint (2026-10-30 23:58). Drafted:
- API: `counts.PENDING_FOR_DECK` / `pending_for_deck` (one statement; the Deck check is the CTE's LEFT JOIN, so a
  foreign or missing Deck gives no row and 404), and `loan_inventory.pending_loans` (`GET /api/loans/pending`) with
  `PendingLender` / `PendingLine` / `PendingLoans`. `routes.json`, `generate_social_client.py` and
  `social_generated.ts` updated by hand to match the generator. `openapi.json` must be regenerated in the gate window.
- Tests: `api/tests/test_pending_loans.py` (15 cases) and `web/src/decks/pendingLoans.test.ts` (reader rules,
  write-off-at-return, failure, disposal).
- Web: `decks/pendingLoans.ts` (pure reader and note text), `decks/usePendingLoans.ts`, `NeededLines` /
  `NeededLine` / `DeckSection` / `WantListView` (scoped Deck only) and `DeckWantListPanel` `PanelBody`.
- `BorrowDrafts.tsx` (cleared): the `useNoteLoansChanged` import, and in `BorrowComposer` the hook next to its
  `useToast()` and one `noteLoansChanged()` after `onClose()` in `send()` success.
- Not run: pytest, vitest, tsc, prettier, guardrails, client check, Playwright. No `.venv` or `node_modules` in this
  worktree.
- Playwright: `web/tests/deck-pending-loans.spec.ts` (6 tests, written, not run):
  - a same-tab send
  - a lender's partial accept picked up by the pulse, using a fake clock (`page.clock`)
  - a write-off with an unchanged pulse, then focus
  - receipt on another device (`page.request`), then focus
  - a failed refresh showing the stale cue, then Retry
  - Deck scope, All Decks and the lender's view
  Account isolation on sign-out is covered by the reader's disposal unit test, not by a browser test.
- The hand-edited generated client must be replaced by real generator output and verified in the gate window.

## Review corrections (2026-10-31, P2 ×2)

1. **Return dedupe.** The reader no longer uses a time window: a read within 1 s of *any* read used to swallow a
   genuine blur/focus, so a write-off with no pulse could stay stale until the next visit. Now `leave()` (window
   `blur`, or `visibilitychange` to hidden) arms the next return, and a `return` (focus, or visible) reads only while
   armed, or while a hidden-time trigger is due. The two notifications of one return read once, and every later
   return reads however soon after. The `now` option and `COALESCE_MS` are gone.
2. **Same-Deck invalidation.** `setDeck(deckId)` became `setScope(deckId, pins)`. New pins for the same Deck read
   again and keep the answer on screen.
   - `WantListView` passes `wantListPins(list)` (`owner_revision:settings_revision:deck_lists_digest` of the answer it
     already holds).
   - `DeckWantListPanel` passes the builder's existing `pins`.
   - The pending read follows the Want List reads and never causes one, so there are no extra Want List or price
     reads, and the revision contract is unchanged.

Regressions:
- Vitest: blur/focus straight after a read reads (fails under the old window); one leave and two notifications read
  once; new pins for the same Deck read and keep the answer, while unchanged pins don't.
- Playwright: the `focus` helper now dispatches blur then focus with no clock skip. A new test adds a same-Deck
  Deck List line for an Edition with a waiting request, followed by the builder's `prizecheck:deck-list-changed`
  signal, and expects the request note to appear (7 tests).

## Validation (2026-10-31, worktree's own environment, on c0ad5cd)

- Fast-forwarded from e6e29e0 to c0ad5cd (PR 456 touched 5 files, none of this change's).
- Generators: `generate_all_clients.py` output for `social_generated.ts` is byte-identical to the hand edit.
  `openapi.json` was regenerated with the contract test's own serializer (+175 lines, additive only). The regenerated
  `routes.json` equals the hand edit.
- Guardrail fix: `social-inventory-readers` rejected `app.social.counts` reading `location`/`deck_list_line` (ADR 0014
  boundary). `PENDING_FOR_DECK` / `pending_for_deck` moved to `app.loan_inventory`; `counts.py` is unchanged.
- TS fix: a name clash with WantListView's existing `pending` (Friend matches); the hook value is now `friendRequests`.
- `npm run check` passed. `npm run guardrails` passed (508 tooling tests). Vitest `pendingLoans.test.ts` 11/11.
  Mutations of the return dedupe and of same-Deck pins each fail the regressions.
- API runs:
  - `20261031T003041Z-f34a8bbb`: `test_pending_loans.py` (14) and `test_api_contract.py` (2), 16 passed.
  - `20261031T003235Z-708e87b7`: loans, handover, write_off, lend_offers, ending_friendship, borrowed_copies,
    want_list, want_list_cost and want_list_mass_entry, 114 passed.
- Browser run `20261031T003625Z-3f78a4d7`: `deck-pending-loans.spec.ts`, `--browser-workers 1 --shard 1/1`, 7 passed.
- Prettier is clean apart from the git-ignored `.impeccable/hook.cache.json`, which is not part of this change.
