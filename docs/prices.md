# Cached exact-Edition prices

Ticket 06 shows cached USD TCGplayer market quotes (supplied through TCGdex) for one exact reviewed Edition, or an honest unavailable state. The route never writes PostgreSQL, never fetches a source in-request, and writes nothing at all for rows checked under one hour ago. Older rows are admitted for background refresh by ticket 07 (coordination records only; see `docs/price-refresh.md`). There is no refresh or force route.

**Launch gate.** Pricing stays closed for production. The launch checklist still requires exact physical Edition and quote-variant evidence and an activated matching rule before any price is enabled, and nothing writes quotes until ticket 08. Until then every production Edition reads as unavailable or "No cached price yet". Quotes are written by the price runner and, for Editions verified at import time, by the catalog import itself (ADR 0013). Tests seed `quote:` and `result:` records through the store.

**Matching rule versions.** TCGdex repeats a card's whole TCGplayer block (one entry per finish) inside every variant. Matching rule v1 refuses any block with more than one product. v2 reads only the entry the reviewed finish table names for the Edition's descriptor and then applies every v1 check to it; the price fetch (`tcgdex_record.select_quote`) likewise reads only the published variant's entry. Live TCGdex variants also list their `thirdParty` IDs, which reach the Edition descriptor; v1 and v2 read that key as an extra facet, so those Editions named no finish. v3 sets `thirdParty` aside before reading the finish and otherwise applies v2; the lookup's `thirdParty.tcgplayer` is still checked against the selected product. TCGdex also often keeps the TCGplayer block on the card instead of inside each variant: a variant with no block of its own borrows the card's block (`tcgdex_record.priced_variant`, decided by `MatchingRulesV3.borrowed_block` so v3's digest covers it), for both matching and the price fetch, only when it is a plain finish the reviewed finish table covers, the block has a product for that finish, and no sibling variant reads as the same finish once `thirdParty` is set aside. Stamped, subtype and special-foil variants, finishes the block does not list, and such contending siblings borrow nothing. The import applies this whichever matching rule is active; it changes the candidate a v1 or v2 activation reads as well, which is acceptable because only dev activates matching (automatically, always the newest rule). Activation re-evaluates unverified Editions, and also gives a matching-rule Edition verified without a quote variant the one the new rule names, when its accepted candidate is unchanged and the rule confirms the same product (`catalog_targets.complete_quote_variant`). Its state, product and basis stay as they are; its `matching_activation_id` becomes the activation that named the variant. With `MARKETPLACE_MATCHING=automatic` (set in `compose.deploy.yml` for dev), `ensure_matching_rule` keeps the newest version active without an owner approval: it records the activation for the bound owner at API startup and at every catalog promotion, and re-evaluates unverified Editions the same way a manual activation does. Without that setting, activation stays a reviewed owner action.

## What a price means

A quote is valid for an Edition only when all of these hold:

- PostgreSQL says the Edition is `verified` and publishes a `quote_lookup` (`{source:'tcgdex', card, variant}`). `edition_targets` sets it only when the source variant block's product matched the reviewed product.
- The keys are read under PostgreSQL's `mapping_revision` for that Edition (`quote:<public_ref>:<rev>`, `result:<public_ref>:<rev>`). Other revisions are never read. A revision is opaque and never reused.
- The payload's `card` and `variant` equal `quote_lookup` exactly, otherwise the row fails closed (`lookup_mismatch`).
- The amount matches `^(0|[1-9]\d{0,11})(\.\d{1,6})?$`, is held as a `Decimal`, and the payload says `USD` from `tcgdex`. A JSON float, exponent, sign, `NaN`, whitespace or a 13th digit fails only that row (`invalid_quote`). A validated zero amount is a real zero price and shows `$0.00`; missing, evicted or unknown data is never shown as zero.
- PostgreSQL is authoritative for state. The store's `quarantine:` record is never read. A PostgreSQL quarantine hides a price before any outbox delivery.
- `catalog_edition_metadata.quote_candidate` (the stored import snapshot) is never read as a price. A catalog import seeds the cache from the response it fetched instead, through the same selection and validation as the runner ([ADR 0013](adr/0013-import-pricing-seeds-the-price-cache.md); "Import seeding" in `docs/price-refresh.md`).

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
- A catalog import writes the same records for a successful check (ADR 0013): `checked_at` is when the import received the card, never the seeding time, and it never writes `absent`.

## HTTP

`POST /api/prices/editions` with `{"edition_ids": [uuid...]}` (1 to 64, de-duplicated in order, extra fields forbidden). It returns `{prices: [{edition_id, status, reason, amount, display_amount, currency, provider_updated_at, checked_at, age, stale}], withheld}` with `cache-control: no-store`.

- `force`, `source_url`, `target` and any unknown field give 422. There is no refresh or force route.
- A body over 16 KiB (measured in bytes) gives 413, in the gateway and in the API.
- A missing or forged budget gives 401. A gateway abort gives 504 `{detail:{code:'PRICE_DEADLINE'}}`.
- The route is synchronous on purpose: the HTTP record-store adapter refuses to run on an event loop.

## Budget (shared by tickets 07, 08, 09, 12)

The gateway takes a monotonic receipt time before it reads the body or looks up the session, and gives budgeted routes three seconds from there (it aborts at 2.9 s so the 504 is written by 3.0 s). The session lookup on a budgeted route runs on its own pool (four connections, with 3 s statement, lock and acquire timeouts; `auth/src/auth.ts`), so a lookup the gateway abandons at the deadline ends in PostgreSQL and never holds a connection that sign-in or another route needs. It signs what is left:

- `x-internal-budget-ms`: milliseconds left when sent. The API clamps it to 3000.
- `x-internal-budget-time`: epoch milliseconds when the gateway signed, 30 s replay window. The gateway aborts `x-internal-budget-ms` after this moment, so the API subtracts the time elapsed since it (transit, queueing, the body read) from the budget. The identity stamp `x-internal-time` stays in epoch seconds.
- `x-internal-caller`: `user:<id>`, or `anon:<keyed digest>` on public routes (ticket 12).
- `x-internal-budget-signature = HMAC(secret, "budget\n{method}\n{path}\n{bodyhash}\n{caller}\n{ms}\n{time}")`.

The existing `x-internal-*` identity message is unchanged. Client-supplied `x-internal-*` headers never reach the API (the gateway builds its upstream headers from scratch), and the API ignores any other deadline header.

`app.price_budget`:

- `Budget(hard, caller, wait_until=hard-0.5)` with `remaining()`, `wait_remaining()`, `expired()` and `pg_timeout_ms(final=False)`. The timeout is never 0, because PostgreSQL reads 0 as "no timeout". The final phase leaves a 50 ms margin to answer.
- `trusted_budget(request)` is the FastAPI dependency. It verifies the budget signature against the exact method, path, body hash, caller, milliseconds and time. A route that identifies a user also depends on `verified_user` and checks `budget.caller == f"user:{user_id}"`.
- `BUDGETED_ROUTES` / `is_budgeted(method, path)` list the budgeted routes. Keep them in step with `BUDGETED_ROUTES` in `auth/src/server.ts`. Today they are `POST /api/prices/editions`, `GET /api/decks/{id}/cost`, `GET /api/public/decks/{token}/versions/{version}/cost` and `GET /api/want-list/cost`.

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

For any `/api/` response whose `content-disposition` starts with `attachment`, the gateway forwards that header, `content-type`, `x-robots-tag` and `cache-control: no-store`, and pipes the body with back-pressure instead of buffering it. A client disconnect cancels the upstream read, and a failure after the status line destroys the connection. This carries the private and Published Deck Live and Mass Entry `.txt` downloads (the published ones are unbudgeted anonymous reads). All other responses are buffered as before and forward only `content-type` and `x-robots-tag`. Only budgeted routes carry an abort deadline, so downloads are not cut at three seconds.

## Private Deck exports read the Deck List (Deck Lists 08)

`GET /api/decks/{deck_id}/exports/live` and `GET /api/decks/{deck_id}/exports/tcgplayer` read the same capture as Deck cost (`capture_deck_list`), not the Deck's Holdings. Both views add `deck_list_revision`.

- **Pokémon TCG Live** exports the whole Deck List: every line at its full quantity, whether owned, elsewhere or not owned. Copies the Deck holds beyond its list are left out. `empty` (and 422 `DECK_EMPTY` from `live.txt`) means the Deck List has no lines.
- **TCGplayer Mass Entry** takes `?scope=not_owned` (the default) or `?scope=deck_list`; any other value is 422. `not_owned` (Buy missing) sends the copies each line still needs under the account's Want List counting setting (decklist import #208, `api/app/copy_allocation.py`), `deck_list` every line at its full quantity. The view echoes `scope`. From `tcgplayer.txt` an empty selection is 422 `DECK_EMPTY` for `deck_list` and 422 `NOTHING_NOT_OWNED` for `not_owned`. The generated client's `getMassEntryExport` and `massEntryDownloadHref` default to `not_owned`; a client exporting the whole Deck List passes `deck_list`.
- Both `.txt` downloads keep the required `owner_revision` (409 `INVENTORY_CHANGED`) and take an optional `deck_list_revision` (409 `DECK_LIST_CHANGED` on a mismatch); `tcgplayer.txt` takes the same `scope` as its view.
- The Mass Entry view also names `want_list_counting` and `settings_revision`. Changing the setting moves neither revision above, so `tcgplayer.txt` takes an optional `settings_revision` too: with `scope=not_owned`, a mismatch is 409 `SETTINGS_CHANGED`. `deck_list` ignores it.

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

Age bands use `result.checked_at` and the module wall clock: under 1 h nothing happens; 1 h to under 24 h returns the cached view and admits in the background; 24 h or older, a missing, garbled or future (> 5 min) `checked_at`, and unknown/invalid/pending rows are admitted and the response waits for them. Joining a job already in flight never extends its 60 s lifetime and never re-queues it. Reloading never forces anything. Admission is `app.price_refresh.evaluate_and_admit`. The Deck cost route (09) calls it once per access over all Deck rows; the Published Deck cost route (12) does the same for the frozen rows of a Published Deck.

## Deck cost (ticket 09)

`GET /api/decks/{deck_id}/cost` (`app.deck_cost`) answers Estimated Deck Cost and Pricing Coverage for every copy of one private Deck. It is budgeted like the Edition route (same gateway signing, same three seconds from receipt) and takes no body and no options; query parameters and cache headers change nothing.

One access:

1. Captures the complete Deck, its Holdings and its Deck List with each line's ownership states, with `deck_list_capture.capture_deck_list` under the budget (`statement_timeout`/`lock_timeout` from `pg_timeout_ms()`, run under `_bounded`). The capture locks the owner row like every inventory reader of record and commits before any store I/O, so no inventory lock or connection is held while prices are read or awaited.
2. Calls `private_edition_quotes` **once** with every distinct Edition the Deck holds or lists. That one call reads every cache row (in 128-key store batches), calls `evaluate_and_admit` once (at most 32 new jobs; the other rows are labelled and still counted), waits at most once until `wait_until`, and validates once. The Deck is never split into 64-id requests.
3. Folds the views with the captured quantities. Quantities are Python integers and amounts are integer micro-dollars, so the subtotal is exact for any bigint quantity; the only rounding is the final display (half-up to cents, `<$0.01` for a positive sub-cent subtotal).

Answer (`DeckCost`, `cache-control: no-store`; every count is a base-10 string):

| status       | when                                                                                                                                       | fields                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `empty`      | the Deck holds no copies (no store read, no admission)                                                                                     | `amount: "0"`, `display_amount: "$0.00"`, all counts `"0"`                                                           |
| `priced`     | every row was evaluated and at least one copy has a valid quote                                                                            | `amount`, `display_amount`, `priced_copies`, `total_copies`, `stale_copies`, `unknown_age_copies`, `fallback_copies` |
| `no_quotes`  | every row was evaluated and no copy has a valid quote                                                                                      | counts with `priced_copies: "0"`; no amount                                                                          |
| `incomplete` | a row failed with `deadline`, `store_unavailable` or `validation_unavailable`, or the capture failed (`inventory_unavailable`, `deadline`) | `reason` and `total_copies` (null when the capture itself failed); no amount and no coverage                         |

- Only `status: quote` rows count. Confirmed absence, quarantine, unverified, Unspecified Variant, `not_cached`, invalid and pending rows are evaluated but unpriced, so an absent or invalidated quote never enters the subtotal.
- `stale_copies` and `unknown_age_copies` count priced copies by provider age (strictly over 48 h, or unknown). `fallback_copies` counts priced copies (`status: quote`) whose refresh label is `timeout`, `busy`, `backoff` or `failed`: they are shown from the labelled cache. Copies with no cached quote are unpriced and are not counted here.
- `owner_revision` is the captured inventory revision. The client discards an answer for any other revision; a newer one makes the page reload its checks and ask again.
- A Deck owned by someone else is 404 once the capture runs; an exhausted budget or a failed capture answers `incomplete` without checking ownership.

### Deck List cost and cost to complete (Deck Lists 08)

The answer also carries `deck_list_revision`, `deck_list_cost` and `cost_to_complete`. The top-level fields above stay the Estimated Deck Cost of the Deck's Holdings, unchanged for today's client (its Deck cost summary pairs them with the Holdings-based `checks.total`); the planned UI overhaul moves to the new figures and retires them, as it does `checks` for `deck_list_checks`.

- `deck_list_cost` covers every Deck List line at its full quantity, owned or not.
- `cost_to_complete` covers only the copies each line still needs under the account's Want List counting setting (decklist import #208), exactly the Deck detail's `to_get` and the Buy missing export. Under **Every Deck built at once** (the default) each Deck counts the copies it holds for its line, then Spare Copies go to Decks oldest first (creation time, the Deck id breaking ties); copies another Deck holds for its own line are needed. Under **One Deck at a time** every copy outside the Deck counts, which is the Deck detail's `not_owned`. Copies the setting counts cost nothing here: they would be moved in rather than bought.
- The answer names `want_list_counting` and `settings_revision` (both null when nothing was captured). The setting moves neither `owner_revision` nor `deck_list_revision`, so the deck builder also discards an answer for another settings revision.
- Each is a `DeckCostFigures` object: `status, reason, total_copies, priced_copies, stale_copies, unknown_age_copies, fallback_copies, amount, display_amount, currency`, with the statuses, counts, labels and arithmetic of the table above (`deck_cost.summarize`). An unknown price is never $0: an unpriced not-owned copy leaves the cost to complete `no_quotes` or partly covered.
- `cost_to_complete` is `empty` (`$0.00`, every count `"0"`) when no copy needs buying, a real zero. `deck_list_cost` is `empty` when the Deck List has no lines.
- The three figures share the one quote read, admission and wait, and each is folded from its own rows only: a failed row makes incomplete only the figures that contain it.
- When nothing was captured (an exhausted budget or a failed capture), both objects are `incomplete` with the top-level reason and no total, and `deck_list_revision` is null.
- `deck_list_revision` is the captured Deck List revision. A Deck List edit does not move `owner_revision`, so a client showing the new figures discards an answer for another Deck List revision too.

The client (`web/src/DeckCost.tsx`) asks once per Deck and inventory revision, gives up after about 3.5 s, and renders: `$1.61 · 5/6 cards priced · Incomplete subtotal: …`, the stale and unknown-age counts, `$0.00 · No cards`, `Price unavailable · 0/N cards priced`, or `Price unavailable; coverage unavailable; N cards total` (also for a client timeout or a 504). It always states that the estimate excludes shipping and taxes.

## Want List cost and Buy on TCGplayer (decklist import #210)

`GET /api/want-list/cost` (`app.want_list_cost`, optional `deck=<id>`) prices what `GET /api/want-list` shows for the same scope. It is a separate request so the page draws before prices arrive, and it is budgeted like Deck cost (same gateway signing, same three seconds from receipt). The budget signs the path, not the query: `deck` is the caller's own scope, and a Deck that isn't one of theirs (or isn't a Deck) is 404 `DECK_NOT_FOUND` once the capture runs.

One access:

1. One Want List capture (`want_list.capture_want_list`) under the budget's statement and lock timeouts, run under `_bounded`. It holds the owner row lock and commits before any store I/O.
2. One `private_edition_quotes` call over every distinct Edition the scope still needs (need > 0): one read, one `evaluate_and_admit`, at most one wait and one validation. Editions the Collection already covers are not read. Nothing to get means no store read and no admission.
3. Each figure is `deck_cost.summarize` over its own copies (`DeckCostFigures`, with the statuses, counts and labels of Deck cost): `total` (the combined total, or the scoped Deck's needs), each section's `cost`, each section line's `cost` with `price_each` (the per-copy display price of a priced Edition, else null), and each combined row's `cost`. An unpriced copy is never $0, and a failed row makes only the figures containing it `incomplete`.

The answer names `want_list_counting`, `settings_revision`, `owner_revision` and `deck_lists_digest`, exactly as `GET /api/want-list` does (each section also carries its `deck_list_revision`). `deck_lists_digest` covers every Deck's id and Deck List revision, whatever the scope, because a Deck List edit moves neither other revision and an older Deck's list changes a newer Deck's need under Every Deck built at once. The client shows a cost only for the Want List answer with the same scope and those four values; when nothing was captured (an exhausted budget or a failed capture), all four are null, `total` is `incomplete` with the reason, and `sections` and `combined` are empty.

`GET /api/want-list/exports/tcgplayer` (`app.want_list_mass_entry`, optional `deck=<id>`) is the TCGplayer Mass Entry export of the same copies: the combined total with no `deck`, that Deck's needs with one. It reuses the private Deck export's rows, formatter and view (`deck_mass_entry.input_rows`, `formatted`, `view_fields`), so the link, text, coverage reason and less-specific rows are the Deck export's, and a scoped export equals that Deck's Buy missing. It names the same four values as the cost. `.../tcgplayer.txt` takes the required pins `owner_revision` (409 `INVENTORY_CHANGED`), `deck_lists` (the digest, 409 `DECK_LIST_CHANGED`) and `settings_revision` (409 `SETTINGS_CHANGED`), and answers 422 `NOTHING_NOT_OWNED` when nothing is needed. Neither export route reads a price or carries a budget, so a download is never cut at three seconds.

The Decks index's "Want List: N cards · $X" is each row's existing cost read (`cost_to_complete`, the same allocation): the index reads no Want List price.

## Published Deck cost (ticket 12)

`GET /api/public/decks/{token}/versions/{version}/cost` (`app.published_cost`) answers Estimated Deck Cost and Pricing Coverage for the active frozen snapshot of one Published Deck. It is budgeted (same gateway signing and three seconds from receipt) and anonymous: the gateway classifies every `/api/public/` path as anonymous, never looks up a session for it and signs the budget with `anon:<keyed digest>`. The API refuses any other caller (a `user:` caller or a malformed `anon:` caller is 401).

The only inputs are the token and the version in the path. The version sits in the path because the budget signature binds the path and not the query. Any query string, any non-zero `content-length` and any `transfer-encoding` header is 422 `INVALID_REQUEST`; the token must match the publication token syntax and the version `[1-9][0-9]{0,17}`, otherwise 404. Rows, references and quantities are derived server-side from the snapshot (`app.public_deck`); the request cannot name an Edition or a quantity.

| status | code                            | when                                                                                                                 |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 404    | `PUBLISHED_DECK_NOT_FOUND`      | bad syntax, token not active at entry, or token no longer active at the final check (a revoke during the wait)       |
| 409    | `PUBLISHED_DECK_CHANGED`        | the active version is not the requested one at entry or at the final check, or the frozen content changed in between |
| 503    | `PUBLIC_PROJECTION_UNAVAILABLE` | the manifest is unreadable or invalid at entry (including a malformed frozen quantity)                               |
| 422    | `INVALID_REQUEST`               | a query string or a body                                                                                             |
| 401    |                                 | missing or forged budget, `user:` caller, malformed `anon:` caller                                                   |

Every error body is `{"detail": {"code": ...}}` with `cache-control: no-store` and `x-robots-tag: noindex, nofollow`. POST is 405.

Answer (`PublishedDeckCost`): `version, digest, status, reason, total_copies, priced_copies, amount, display_amount, currency, editions`. `status`, `reason`, `total_copies`, `priced_copies`, `amount`, `display_amount` and the labels are those of the private Deck cost, but the public route leaves out its two price-age counts (`stale_copies`, `unknown_age_copies`) and its count of copies shown from the labelled cache (`fallback_copies`): no price age is sent. `deck_cost.summarize` is the one fold behind both routes (an empty snapshot is `$0.00` with every count `"0"`; `no_quotes` is `0/N`; `incomplete` carries a reason and no coverage).

`editions` (app redesign #183) lists each frozen Edition's own price for the Published Deck page: one `{edition_ref, amount}` per distinct public Edition reference, in snapshot order, where `amount` is the exact per-copy amount of a priced row (`status: quote`, stale quotes included) and null otherwise. It comes from the same views as the totals, so it adds no store read and no admission, and it carries no price age. Legacy rows have no reference and no entry. A withheld or `incomplete` answer has `editions: []`.

The pipeline for one access:

1. Read the snapshot (`public_deck.read_active`): the manifest only, bounded by the request's own clock (the projection adapter's five-second timeout never applies). Compute the digest.
2. `public_catalog.marketplace_states` over the distinct Edition references that can be proven, then one `price_refresh.evaluate_and_admit` over every price-eligible row (caller `anon:<digest>`, so the anonymous ledger applies), then at most one wait.
3. Inside the 0.5 s reserve: re-read eligibility (`marketplace_states` again; a row whose state, revision, lookup or Printing changed is unpriced) and revalidate the snapshot (token, version, digest). Only then is the answer built.

Withheld answers. If the entry deadline, the final-check deadline or the final manifest read fails, the answer is `incomplete` with `reason` (`deadline`, or `validation_unavailable`) and `digest`, `total_copies` and every count null: nothing unvalidated is returned. A store read failure with the snapshot revalidated is `incomplete` with the frozen `total_copies` and the digest, as for the private route.

The digest is `sha256(json.dumps(record['snapshot'], sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))` over the stored snapshot. It is computed per request, never stored (no migration), never a request input, and checked server-side only: the server refuses a digest change within one request (409). The client guards by version: it discards an answer for another version, and a 409 or 404 makes the page read its snapshot again and price the new version.

Reference proof. A row is price-eligible only if its `edition_ref` and `printing_ref` are both present, the store's `catalog:edition:<edition_ref>` record names the same `printing_ref`, and the Edition is verified, has a `quote_lookup` and passes the public catalog checks. Otherwise it is unpriced and still counts in `total_copies`. Legacy rows (no `edition_ref`) are unproven: readable, unpriced and counted in the total; no lookup by set, number or name is attempted, and a republish is the only way to capture references. A row whose reference resolves to another Printing, or is unknown to the public catalog, is treated the same way. Rows repeating one reference have their quantities summed; if they disagree on `printing_ref`, the Edition is unproven. A malformed frozen quantity makes the whole snapshot invalid (503 at entry, `validation_unavailable` at the final check); a row is never dropped silently.

Eligibility comes from the store's `catalog:edition` and `quarantine:edition` records, never from PostgreSQL. A quarantine committed in PostgreSQL hides private prices at once but reaches Published Deck pages only after outbox delivery (`catalog_outbox_pending` shows the lag).

Isolation. The route never touches a session, the gateway's auth database, the API's PostgreSQL or private inventory, and it writes no record: a per-Deck quote or total is never stored, and the record-store generation is unchanged by a cost access over fresh quotes. The tests prove it: `api/tests/test_published_cost.py` patches `psycopg.connect` to raise and sets an unreachable `DATABASE_URL` for every public call, and `auth/tests/published-cost.test.ts` runs an isolated gateway and API whose database URLs are counting listeners (absent, forged and valid cookies cause zero connections to either, with controls showing the counters are live).

Launch gate. Published Deck prices are behind the same physical Edition and quote-variant evidence gate as every other price. This ticket activates no rule and claims no deployed acceptance; the launch checklist stays open.

## Stored reads on write paths (Deck Lists 06)

`prices.stored_edition_quotes` reads what the cache holds now, for a write that chooses by price but displays none: adding a card to a Deck List by its Card Printing (`POST /api/decks/{deck_id}/deck-list/printings`, `app.deck_list_printing`). It labels and validates rows exactly as the Edition route does, but it never admits a refresh, waits for a runner or writes a record, whatever a row's check age: ADR 0006 counts only displayed prices and complete Deck costs as accesses. The route carries no gateway budget. The read bounds its own PostgreSQL and store work to `STORED_READ_SECONDS` (1 s) and runs before the command takes the owner lock, so no inventory lock is held while the store is read. It returns `None` when the reviewed state or the store could not be read; the command then answers 503 `PRICES_UNAVAILABLE` and writes nothing.

Every `status: quote` row is a price, whatever its provider or check age; everything else is unpriced. The command chooses the lowest amount (exact decimal comparison; ties go to catalog order, `descriptor_key, id`), or the first Edition in catalog order when none is priced, and says which in `chosen_by` (`cheapest_price` or `catalog_order`). The line stores only the Edition.

## Client

`EditionPrice` is mounted for rendered rows only: card detail Editions and catalog result rows, leaf and Deck Holdings rows (including pages added by "More cards"), and Collection rows. A slot asks for its price once, when it first comes within two viewport heights of the visible area (one shared `IntersectionObserver` with `rootMargin: 200% 0px`; where there is none, at mount). Slots that come near together are batched into requests of at most 64 ids, at most two in flight. It shows "Checking prices…" only in the price slot, and gives up after about 3.5 s with a labelled fallback. It renders `display_amount` as given and never shows an amount for a non-quote status.

## Known limits

- API thread-pool queueing before the handler is not counted; the gateway abort is the hard gate.
- Clock skew between hosts is assumed negligible; headers carry remaining milliseconds.
- A malformed `result:`/`quote:` record fails only its own row (`invalid_quote`); a store outage still fails the read (`store_unavailable`).
- Prices are read when a slot first comes near the viewport. An open page does not poll, and a slot that never comes near is never asked for.
