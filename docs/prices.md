# Cached exact-Edition prices

Ticket 06 shows cached USD TCGplayer market quotes (supplied through TCGdex) for one exact reviewed Edition, or an honest unavailable state. The route never writes PostgreSQL, never fetches a source in-request, and writes nothing at all for rows checked under one hour ago. Older rows are admitted for background refresh by ticket 07 (coordination records only; see `docs/price-refresh.md`). There is no refresh or force route.

**Launch gate.** Pricing stays closed for production. The launch checklist still requires exact physical Edition and quote-variant evidence and an activated matching rule before any price is enabled, and nothing writes quotes until ticket 08. Until then every production Edition reads as unavailable or "No cached price yet". Tests seed `quote:` and `result:` records through the store.

## What a price means

A quote is valid for an Edition only when all of these hold:

- PostgreSQL says the Edition is `verified` and publishes a `quote_lookup` (`{source:'tcgdex', card, variant}`). `edition_targets` sets it only when the source variant block's product matched the reviewed product.
- The keys are read under PostgreSQL's `mapping_revision` for that Edition (`quote:<public_ref>:<rev>`, `result:<public_ref>:<rev>`). Other revisions are never read. A revision is opaque and never reused.
- The payload's `card` and `variant` equal `quote_lookup` exactly, otherwise the row fails closed (`lookup_mismatch`).
- The amount matches `^(0|[1-9]\d{0,11})(\.\d{1,6})?$`, is held as a `Decimal`, and the payload says `USD` from `tcgdex`. A JSON float, exponent, sign, `NaN`, whitespace or a 13th digit fails only that row (`invalid_quote`). A validated zero amount is a real zero price and shows `$0.00`; missing, evicted or unknown data is never shown as zero.
- PostgreSQL is authoritative for state. The store's `quarantine:` record is never read. A PostgreSQL quarantine hides a price before any outbox delivery.
- `catalog_edition_metadata.quote_candidate` (an import snapshot) never seeds a price.

## Statuses

`status` is `quote`, `unavailable`, `failed` or `pending`. `reason` explains every non-quote row.

| status      | reason                               | meaning                                                                                                           |
| ----------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| unavailable | `not_found`                          | no such Edition                                                                                                   |
| unavailable | `unspecified_variant`                | Unspecified Variant: finish not established                                                                       |
| unavailable | `unverified` / `quarantined`         | not matched, or matching under review                                                                             |
| unavailable | `no_quote_variant`                   | verified but no price variant is published                                                                        |
| unavailable | `not_cached`                         | no result marker, an evicted payload, or no key for the current revision                                          |
| unavailable | `confirmed_absent`                   | the writer confirmed the provider has no quote; never resurrected                                                 |
| pending     | none                                 | a refresh is in flight; any stored quote is hidden                                                                |
| failed      | `lookup_mismatch`, `invalid_quote`   | the cached record failed validation, or its result/quote record was malformed (that row only)                     |
| failed      | `store_unavailable`                  | the store is down                                                                                                 |
| failed      | `deadline`, `validation_unavailable` | the budget ran out, or final PostgreSQL validation could not finish. The quote is withheld and `withheld` is true |

Display and age:

- `amount` is the exact decimal text. `display_amount` is the only rounded form: half-up to cents with thousands separators (`$0.44`). Any positive amount below one cent shows `<$0.01`, and half-up never rounds a sub-cent amount up to a cent. Rounding happens only in `format_usd`, never in the client.
- `provider_updated_at` comes from the quote payload and `checked_at` from the `result` marker. They are separate: a successful unchanged check never renews provider age.
- `age` is `known` or `unknown`. A missing, garbled, timezone-less or future (more than 5 minutes ahead) provider time is `unknown`, and `stale` is then null. `stale` is true only when the provider age is strictly over 48 hours.

## Record contract for ticket 08

```
quote:<ref>:<rev>  = {attempt, amount: "0.43", currency: "USD", source: "tcgdex",
                      card, variant, provider_updated_at: ISO-8601 with offset | null}
result:<ref>:<rev> = {state: "quote", attempt, checked_at, last_failure_at?}
                   | {state: "absent", checked_at, expires_at}
                   | {state: "pending", ...}
```

- `attempt` in the marker and payload must match (`quote_states` treats a mismatch or a missing payload as unknown).
- `amount` is always a string. `checked_at` lives only in `result`.
- 07/08 obligation: the fetched block's productId must equal the published `product_id`, and `card`/`variant` must be the Edition's `quote_lookup`.

## HTTP

`POST /api/prices/editions` with `{"edition_ids": [uuid...]}` (1 to 64, de-duplicated in order, extra fields forbidden). It returns `{prices: [{edition_id, status, reason, amount, display_amount, currency, provider_updated_at, checked_at, age, stale}], withheld}` with `cache-control: no-store`.

- `force`, `source_url`, `target` and any unknown field give 422. There is no refresh or force route.
- A body over 16 KiB (measured in bytes) gives 413, in the gateway and in the API.
- A missing or forged budget gives 401. A gateway abort gives 504 `{detail:{code:'PRICE_DEADLINE'}}`.
- The route is synchronous on purpose: the HTTP record-store adapter refuses to run on an event loop.

## Budget (shared by tickets 07, 08, 09, 12)

The gateway takes a monotonic receipt time before it reads the body or looks up the session, and gives budgeted routes three seconds from there (it aborts at 2.9 s so the 504 is written by 3.0 s). It signs what is left:

- `x-internal-budget-ms`: milliseconds left when sent. The API clamps it to 3000.
- `x-internal-budget-time`: epoch seconds, 30 s replay window.
- `x-internal-caller`: `user:<id>`. Ticket 12 adds `anon:<keyed digest>`.
- `x-internal-budget-signature = HMAC(secret, "budget\n{method}\n{path}\n{bodyhash}\n{caller}\n{ms}\n{time}")`.

The existing `x-internal-*` identity message is unchanged. Client-supplied `x-internal-*` headers never reach the API (the gateway builds its upstream headers from scratch), and the API ignores any other deadline header.

`app.price_budget`:

- `Budget(hard, caller, wait_until=hard-0.5)` with `remaining()`, `wait_remaining()`, `expired()` and `pg_timeout_ms(final=False)`. The timeout is never 0, because PostgreSQL reads 0 as "no timeout". The final phase leaves a 50 ms margin to answer.
- `trusted_budget(request)` is the FastAPI dependency. It verifies the budget signature against the exact method, path, body hash, caller, milliseconds and time. A route that identifies a user also depends on `verified_user` and checks `budget.caller == f"user:{user_id}"`.
- `BUDGETED_ROUTES` / `is_budgeted(method, path)` list the budgeted routes. Keep them in step with `BUDGETED_ROUTES` in `auth/src/server.ts`. Today they are `POST /api/prices/editions` and `GET /api/decks/{id}/cost`; 12 adds one line to each.

Read order in `private_edition_quotes(edition_ids, budget)`:

1. If the wait window is already spent, withhold everything (`deadline`) without touching PostgreSQL or the store.
2. One REPEATABLE READ transaction with `statement_timeout`/`lock_timeout` from the budget reads `catalog_edition.public_ref`, the descriptor and `edition_targets`, then commits. No connection or lock is held during store I/O.
3. `quote_states` reads verified Editions that have a `quote_lookup`, under the PostgreSQL revision, with `deadline=wait_until`. Failure after `wait_until` is `deadline`, otherwise `store_unavailable`.
4. Final validation re-reads `edition_targets` inside the reserve. A row whose state, revision or lookup changed is relabelled from the fresh state (or `not_cached` when only the revision moved). If PostgreSQL cannot answer, the quotes are withheld (`validation_unavailable`).
5. If the monotonic clock is past `hard`, every row becomes `deadline`.

PostgreSQL work runs in a worker thread that the request waits on with its own clock, because libpq raises any connect timeout below two seconds to two. An abandoned worker ends on its own statement and lock timeouts.

## Operational counters

`bounded_operational_counts` in `api/app/main.py` skips budgeted routes. Its post-handler write is a synchronous PostgreSQL connect on the event loop before the response is sent, which would spend the three seconds and make a read route write. The cost is that price requests are not counted in `operations_hour`. A later ticket can count them from the gateway or after the response.

## Gateway attachment pass-through

For any `/api/` response whose `content-disposition` starts with `attachment`, the gateway forwards that header, `content-type`, `x-robots-tag` and `cache-control: no-store`, and pipes the body with back-pressure instead of buffering it. A client disconnect cancels the upstream read, and a failure after the status line destroys the connection. This carries the Live and Mass Entry `.txt` downloads. All other responses are buffered as before and forward only `content-type` and `x-robots-tag`. Only budgeted routes carry an abort deadline, so downloads are not cut at three seconds.

## Refresh label (ticket 07)

`refresh` is an optional field beside `status`/`reason` (null when nothing was done), with `refresh_failed_at` (ISO time of the last failed attempt, only with `failed`). It never changes `status`, `reason`, `amount` or `checked_at`; the cached view is always returned (no 429/503).

| refresh      | meaning                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `background` | checked 1 h to under 24 h ago: returned now, a refresh is queued or already in flight                 |
| `refreshed`  | the row needed a refresh first (24 h or older, unknown, pending): the runner finished while it waited |
| `timeout`    | waited until the wait window (2.5 s from receipt) ended; the cached view is unchanged                 |
| `busy`       | not admitted: a cap, the ledger, no runner could be launched, or the store was busy                   |
| `backoff`    | not admitted: the Edition or the source is in backoff                                                 |
| `failed`     | the job left the queue without a result (see `refresh_failed_at`)                                     |

Age bands use `result.checked_at` and the module wall clock: under 1 h nothing happens; 1 h to under 24 h returns the cached view and admits in the background; 24 h or older, a missing, garbled or future (> 5 min) `checked_at`, and unknown/invalid/pending rows are admitted and the response waits for them. Joining a job already in flight never extends its 60 s lifetime and never re-queues it. Reloading never forces anything. Admission is `app.price_refresh.evaluate_and_admit`. The Deck cost route (09) calls it once per access over all Deck rows; 12 will do the same for Published Decks.

## Deck cost (ticket 09)

`GET /api/decks/{deck_id}/cost` (`app.deck_cost`) answers Estimated Deck Cost and Pricing Coverage for every copy of one private Deck. It is budgeted like the Edition route (same gateway signing, same three seconds from receipt) and takes no body and no options; query parameters and cache headers change nothing.

One access:

1. Captures the complete Deck with `decks.capture_deck_contents` under the budget (`statement_timeout`/`lock_timeout` from `pg_timeout_ms()`, run under `_bounded`). The capture locks the owner row like every inventory reader of record and commits before any store I/O, so no inventory lock or connection is held while prices are read or awaited.
2. Calls `private_edition_quotes` **once** with every distinct Edition in the Deck. That one call reads every cache row (in 128-key store batches), calls `evaluate_and_admit` once (at most 32 new jobs; the other rows are labelled and still counted), waits at most once until `wait_until`, and validates once. The Deck is never split into 64-id requests.
3. Folds the views with the captured quantities. Quantities are Python integers and amounts are integer micro-dollars, so the subtotal is exact for any bigint quantity; the only rounding is the final display (half-up to cents, `<$0.01` for a positive sub-cent subtotal).

Answer (`DeckCost`, `cache-control: no-store`; every count is a base-10 string):

| status       | when                                                                                                                                       | fields                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `empty`      | the Deck holds no copies (no store read, no admission)                                                                                     | `amount: "0"`, `display_amount: "$0.00"`, all counts `"0"`                                                           |
| `priced`     | every row was evaluated and at least one copy has a valid quote                                                                            | `amount`, `display_amount`, `priced_copies`, `total_copies`, `stale_copies`, `unknown_age_copies`, `fallback_copies` |
| `no_quotes`  | every row was evaluated and no copy has a valid quote                                                                                      | counts with `priced_copies: "0"`; no amount                                                                          |
| `incomplete` | a row failed with `deadline`, `store_unavailable` or `validation_unavailable`, or the capture failed (`inventory_unavailable`, `deadline`) | `reason` and `total_copies` (null when the capture itself failed); no amount and no coverage                         |

- Only `status: quote` rows count. Confirmed absence, quarantine, unverified, Unspecified Variant, `not_cached`, invalid and pending rows are evaluated but unpriced, so an absent or invalidated quote never enters the subtotal.
- `stale_copies` and `unknown_age_copies` count priced copies by provider age (strictly over 48 h, or unknown). `fallback_copies` counts copies whose refresh label is `timeout`, `busy`, `backoff` or `failed`: they are shown from the labelled cache and still counted.
- `owner_revision` is the captured inventory revision. The client discards an answer for any other revision; a newer one makes the page reload its checks and ask again.
- A Deck owned by someone else is 404 before any price work.

The client (`web/src/DeckCost.tsx`) asks once per Deck and inventory revision, gives up after about 3.5 s, and renders: `$1.61 · 5/6 cards priced · Incomplete subtotal: …`, the stale and unknown-age counts, `$0.00 · No cards`, `Price unavailable · 0/N cards priced`, or `Price unavailable; coverage unavailable; N cards total` (also for a client timeout or a 504). It always states that the estimate excludes shipping and taxes.

## Client

`EditionPrice` is mounted for rendered rows only: card detail Editions and catalog result rows, leaf and Deck Holdings rows (including pages added by "More cards"), and Collection rows. It batches the slots of one render into requests of at most 64 ids, shows "Checking prices…" only in the price slot, and gives up after about 3.5 s with a labelled fallback. It renders `display_amount` as given and never shows an amount for a non-quote status.

## Known limits

- API thread-pool queueing before the handler is not counted; the gateway abort is the hard gate.
- Clock skew between hosts is assumed negligible; headers carry remaining milliseconds.
- A malformed `result:`/`quote:` record fails only its own row (`invalid_quote`); a store outage still fails the read (`store_unavailable`).
- Prices are read when a slot mounts; an open page does not poll.
