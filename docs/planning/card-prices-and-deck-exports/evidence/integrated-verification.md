# Card prices and Deck exports: integrated verification evidence

Ticket 15, [#64](https://github.com/ry-cen/tcg-tracker/issues/64). Recorded 2026-10-11 (UTC).

**Status:** implementation evidence only. This is not launch acceptance. Every item in the [launch checklist](../launch-checklist.md) stays pending. The fixtures are synthetic: no real catalog, provider, destination, deployment or owner walkthrough is involved.

## Tested source

- Branch `feature/card-prices-and-deck-exports`, commit `826cf66ce2abf74ff6be225e0587696bbe57f8c8`, with a clean working tree when the gate ran.
- Full gate run `20261011T033001Z-77f500fa` (`npm run verify`, every suite, not `--fast`).

## Procedure

From the integration checkout, with Node and Python dependencies installed and `TEST_ADMIN_DATABASE_URL` set to a loopback PostgreSQL administrative URI:

```sh
npm run verify
```

The gate copies the working tree, creates and drops its own databases, ports and directories, and writes its artifacts to `.scratch/verification/20261011T033001Z-77f500fa/`.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 15.0.1 (arm64), 12 logical CPUs |
| Node | v26.11.1 |
| Python | 3.14.8 |
| PostgreSQL | 16.15 (loopback, disposable databases) |
| Gate workers | pytest 6, browser stacks 4 (from `result.json`) |
| Host sleep / clock skew | `host_suspended_seconds` 0.0, `database_clock_skew_seconds` start 0.009, end 0.009; clock warnings: none |

## Gate result

From the `verification.log` summary of `20261011T033001Z-77f500fa`:

- pytest: 893 passed, 0 failed, 0 errors, 9 skipped (both passes). The brief predicted 892 passed; the extra test is `test_an_unspecified_variant_never_gets_a_product_even_when_its_edition_is_verified`, added by the ticket-13/14 review fix `93c371d`
- vitest: 75 passed, 0 failed, 0 errors, 0 skipped
- Playwright: 58 passed, 0 failed, 0 flaky, 0 skipped (both passes)
- operations: Ran 11 tests in 40.348s, OK (skipped=1; the skipped test is the opt-in disposable-runtime release drill). No `== WARNING:` line
- phase seconds: setup 17, pytest 158, vitest 50, browser 98, operations 40

The one skipped pytest test added at this commit was a 25,000-Edition measurement, removed afterwards (see owner decision Q1).

## Recorded measurements

Every value below is copied from a log line or JSON field named in the Source column. Times are measured with real monotonic clocks (`performance.now()` or `time.monotonic()`), outside the gateway where the Source says so.

| Field | Value | Source |
| --- | --- | --- |
| Source concurrency | `caps: admission rounds=5 busy answers=15 processes {"s":2,"w":2,"samples":141} fetches all=8 slot=[["0",4],["1",4]] caller=[2,2,2,1,1]` | `price-runners-metrics.log`, line starting `caps:` (`price-runners.test.ts` › "30 jobs from five users never exceed two runners, eight fetches, four per slot or two per caller") |
| Source rate | `empty-bucket gaps ms: 1016, 971, 1017 (first after 1031)` | `price-runners-metrics.log`, line starting `empty-bucket gaps ms:` |
| Dedupe | `jobs 5 for 67 accesses` and `launches 2 (cap 2)` | `published-cost-metrics.log`, line starting `100 simultaneous callers, 5 shared day-old Editions:` (jobs versus accesses, launches) |
| Queue age | `oldest queued job 2401 ms` (`waited 14 (cap 32)`; `p50 239 ms, p95 2428 ms, max 2431 ms`; `stats {"admitted":5,"expired":0,"fenced":0,"joined":65,"refused":{}}`) | same line, `oldest queued job` |
| Retries | `5xx: failed after 1358 ms (bound 3000), retry gap 826 ms [450, 1600), backoff answer 163 ms (bound 1500)`; `malformed: failed after 279 ms (must beat the ~2500 ms wait)` | `price-runners-metrics.log`, lines starting `5xx:` and `malformed:` |
| Storage, 1,000 Editions | `"bytes": {"live_text": 29907, "manifest": 395325, "mass_entry_text": 21999, "records_directory": 8262728}` | `deck-capacity-metrics.log`, `bytes` (records directory, manifest, Live and Mass Entry text) |
| Full coverage, 1,000 Editions | 2,000 copies, 1,800 priced. `"private_cost": [["priced", null, 0.28]]`, `"public_cost": [["priced", null, 0.116]]` (status, reason, seconds) | `deck-capacity-metrics.log`, `private_cost` and `public_cost` |
| Full coverage, 100 callers | every one of 200 answers had the exact frozen total, priced copies and amount (assertion in the test) | `published-cost.test.ts` › "keeps cached prices under 500 ms p95 …" |
| Cached ordinary-price p95 | `edition route p95 32 ms (bound 500); published cost p95 6 ms` | `published-cost-metrics.log`, line starting `cached prices one at a time:` (through gateway G0; bound 500 ms) |
| 100 simultaneous callers | `100 simultaneous callers, cached: p50 227 ms, p95 240 ms, max 243 ms (bound 3500)`; `100 simultaneous callers, 5 shared day-old Editions: jobs 5 for 67 accesses; waited 14 (cap 32); launches 2 (cap 2); oldest queued job 2401 ms; p50 239 ms, p95 2428 ms, max 2431 ms; stats {"admitted":5,"expired":0,"fenced":0,"joined":65,"refused":{}}` | `published-cost-metrics.log`, both `100 simultaneous callers` lines |
| Private hard expiry | `deck hard expiry, 34 Editions, hanging source: 2502 ms (bound 3000); checks 63 ms, inventory write 45 ms (bound 1000)` | `price-runners-metrics.log`, line starting `deck hard expiry, 34 Editions` |
| Public hard expiry | `published cost hard row: 2381 ms (gate abort 3000); snapshot meanwhile: 3 ms (bound 1500)` | `published-cost-metrics.log`, line starting `published cost hard row:` |
| Slow relay | `deck outage: 1267 ms; stalled store writes: 729 ms (bound 3000)` | `price-runners-metrics.log`, line starting `deck outage:` |
| Large-Deck latency | 1,000 Editions: `"seconds": {"build": 1.884, "deliver": 1.765, "private_live": 0.068, "private_mass_entry": 0.067, "public_live": 0.045, "public_mass_entry": 0.069, "publish": 0.128, "seed_quotes": 0.784}``| `deck-capacity-metrics.log` `seconds` |

## Criterion coverage

Each row is a clause of #64, the tests that prove it (`file` › test name), and its status. Statuses:

- **Covered:** proven at the real gateway, the browser or the signed-HTTP API seam, by tests already in the gate.
- **Partial (accepted):** proven at the signed-HTTP or admission seam, but not through the gateway. Each such row gives its reason. No test is added for these rows.
- **New:** closed by this ticket's tests.

Earlier slices' gate runs, cited in their completion comments:

| Tickets | Issue | Gate run |
| --- | --- | --- |
| 07 | #56 | `20261010T061420Z-4cad3c77` |
| 08 | #57 | `20261010T074009Z-081825fc` |
| 09 | #58 | `20261010T193543Z-7149cba9` |
| 12 | #61 | `20261010T235053Z-f6bbd927` |
| 13 and 14 | #62, #63 | `20261011T022637Z-1884a46f` |

The bodies of #58, #61, #62 and #63 still show unchecked boxes, so cite their completion comments, not the boxes.

### C1. Each slice has external checks at the real seam

| Clause | Tests | Status |
| --- | --- | --- |
| Card surfaces (browser and HTTP) | `web/tests/prices.spec.ts` › "card information shows each Edition's own price with age, stale and finish labels, and PostgreSQL state wins", "Deck, leaf and Collection rows price their exact Edition, including after More cards", "following a link does not prefetch prices for unrendered cards"; `auth/tests/prices.test.ts` › "stamps a signed budget for this caller and request, and discards client-supplied internal headers"; `api/tests/test_prices.py` (HTTP section) | Covered |
| Complete private costs | `web/tests/deck-cost.spec.ts` (6 tests); `auth/tests/deck-cost.test.ts` (5 tests); `api/tests/test_deck_cost.py` | Covered |
| Complete public costs | `web/tests/published-cost.spec.ts` (2 tests); `auth/tests/published-cost.test.ts` (tests 1–3); `api/tests/test_published_cost.py` | Covered |
| Reports and review | `web/tests/metadata-review.spec.ts` (6 tests, from "collector reports an Edition mapping, nothing changes until the maintainer approves it" to "a request for information round-trips through the collector back to the maintainer queue"); `auth/tests/http.test.ts` › "issues metadata approval codes only to the owner for existing, well-formed targets, and a code spends end to end"; `api/tests/test_metadata_reviews.py` | Covered |
| Publication | `web/tests/publications.spec.ts` › "Unlisted snapshot is anonymous, escaped, intentional, and permanently revocable"; `web/tests/discovery.spec.ts` (2 tests); `api/tests/test_publications.py` | Covered |
| Both exports, private | `web/tests/live-export.spec.ts` (7 tests); `web/tests/mass-entry.spec.ts` (5 tests); `api/tests/test_deck_live_export.py`; `api/tests/test_deck_mass_entry.py` | Covered |
| Both exports, public | `web/tests/published-live-export.spec.ts`; `web/tests/published-mass-entry.spec.ts`; `auth/tests/published-cost.test.ts` › "serves both exports of every frozen copy without waking either database for absent, forged or valid cookies, and follows republish and revoke without moving the manifest or discovery" | Covered |
| HTTP contracts and races | `auth/tests/price-refresh.test.ts` (13 tests); `auth/tests/price-runners.test.ts` (14 tests); the `auth/tests/published-cost.test.ts` 409/404 race test; `api/tests/test_published_*` › "republish_rewrite_revoke_and_replay…" | Covered |
| No helper-only substitutes | The pure-function tests (`test_quote_contract.py`, the formatter section of `test_deck_live_export.py`) supplement the seam tests and replace none of them | Covered |

### C2. Conformance suite: multi-process CAS and crash recovery on both adapters, with at least two API processes or workers

| Clause | Tests | Status |
| --- | --- | --- |
| One focused suite, both adapters | `api/tests/test_public_records.py`. Its `adapter` fixture is parametrized `filesystem`/`http`; the HTTP variant starts two independent relay processes over one store | Covered |
| Multi-process CAS | `test_more_than_two_independent_contenders_have_exactly_one_cas_winner` (4 spawned processes across both relays); `test_conditional_commit_failure_through_an_independent_process_or_relay` | Covered |
| Crash recovery and interrupted commit | `test_process_crash_keeps_pending_or_committed_absence_never_old_result[before/after]`; `test_http_lost_response_can_resolve_commit_without_reapplying`; `test_failed_cas_publishes_nothing`; `test_corrupt_authoritative_pointer_never_falls_back` | Covered |
| At least two API processes or workers per adapter | HTTP relay: `auth/tests/price-refresh.test.ts` and `price-runners.test.ts` (2 gateways, 2 APIs); filesystem: `auth/tests/published-cost.test.ts` (2 gateways, 2 APIs); `api/tests/test_price_runner.py::test_two_runner_processes_respect_slot_caller_and_global_caps` (two real runner processes on the filesystem store) | Covered |

### C3. Capacity

| Clause | Tests | Status |
| --- | --- | --- |
| 60-copy Deck | `auth/tests/published-cost.test.ts` › new fifth test, Deck A (exactly 60 copies) | New |
| 1,000-distinct-Edition Deck | `api/tests/test_deck_capacity.py::test_a_1000_edition_deck_is_priced_and_exported_completely_privately_and_publicly`: private cost through the HTTP relay, both private exports, publish, public cost and both public exports, all asserting every copy | New |
| 25,000-distinct-Edition Deck | Not tested: a Deck holds at most 60 cards in play, so the owner dropped this case (owner decision Q1). The 1,000-Edition test above is the large-Deck check | Dropped by the owner |
| 100 simultaneous callers, overlapping and disjoint Decks, across replicas | `auth/tests/published-cost.test.ts` › new fifth test (100 `x-real-ip` callers, alternating G0/G1, Decks A/B overlapping and C disjoint, cached and day-old phases) | New |
| Complete cache coverage and quantity behavior preserved | Each new test asserts exact `total_copies`, `priced_copies` and `amount` for every answer. See also `api/tests/test_deck_cost.py::test_every_copy_of_a_large_deck_is_evaluated_with_one_admission_and_one_budget` (70 Editions, more than 128 keys) and `::test_bounded_admission_never_drops_copies_on_a_later_access` | Covered and New |

### C4. Failure and recovery scenarios; nothing superseded reappears

| Clause | Tests | Status |
| --- | --- | --- |
| Full queue | `auth/tests/price-refresh.test.ts` › "refuses everything when the global queue holds 256 jobs and writes no job; at 255 it admits one of two" | Covered |
| Full ledger | `auth/tests/published-cost.test.ts` › "… and a full anonymous ledger refuses a new caller without waiting"; `test_price_refresh.py::test_the_anonymous_ledger_caps_new_digests_and_keeps_existing_ones` | Covered |
| Full storage | `test_public_records.py::test_absence_during_full_storage_fails_closed_never_old_quote`, `::test_protected_absence_survives_full_payload_capacity`, `::test_byte_capacity_eviction_never_falls_back_and_protected_state_is_independent`; `test_price_runner.py::test_a_store_at_capacity_keeps_the_absent_result_the_runner_wrote` | Covered |
| Provider outage | `auth/tests/deck-cost.test.ts` › "keeps cached quotes and numeric coverage through a source outage, and answers a slow store inside the budget"; `price-runners.test.ts` › "failure (5xx): two attempts, a per-Edition backoff, and the cached quote untouched" | Covered |
| Partial success and confirmed absence | `price-runners.test.ts` › "partial success: one Edition written, its sibling on the same card unchanged and backed off"; `deck-cost.test.ts` › "prices the six-copy example as $1.61 and 5/6 … and a confirmed absence replaces an old quote"; `test_price_runner.py::test_absent_is_written_atomically_and_a_later_failure_keeps_it` | Covered |
| Delayed and fenced writers | `test_price_runner.py::test_reclaim_mid_fetch_fences_the_stale_writer`, `::test_quarantine_mid_fetch_writes_nothing`, `::test_revision_bump_mid_fetch_writes_under_neither_revision`; `test_catalog_outbox.py::test_stalled_drainer_cannot_overwrite_a_newer_invalidation`, `::test_backfill_cannot_write_stale_verified_state_over_a_delivered_contradiction` | Covered |
| Invalidation | `price-refresh.test.ts` › the three "mapping invalidation mid-wait" tests; `test_published_cost.py::test_an_answer_is_withheld_when_the_snapshot_or_eligibility_changes_during_the_wait[quarantine]`; `test_prices.py::test_a_postgres_quarantine_hides_the_price_before_any_outbox_delivery` | Covered |
| Lease expiry | `price-runners.test.ts` › "pause (SIGSTOP): the slot is not replaced, the row answers busy at once, and after SIGCONT the work completes"; `test_price_runner.py::test_sigstopped_runner_is_not_replaced_and_completes_after_sigcont`, `::test_a_stopped_runner_with_an_expired_lease_is_uncertain_at_once_and_recorded`, `::test_lost_lease_stops_claims` | Covered |
| Revoke and republish | `published-cost.test.ts` › "answers a republished version with 409 and a revoked token with 404, even when the refresh lands after the revoke, and moves no manifest or discovery revision" and the exports test; `web/tests/published-cost.spec.ts` › "a cost answer held across a republish is discarded and the page prices the new snapshot"; `published-live-export.spec.ts`; `published-mass-entry.spec.ts` | Covered |
| Interrupted commits | `test_public_records.py::test_process_crash_keeps_pending_or_committed_absence_never_old_result`; `test_price_runner.py::test_unknown_commit_outcome_is_resolved_by_operation_status`; `test_publications.py::test_failed_object_write_preserves_whole_snapshot_and_retry_recovers`; `test_discovery.py::test_failed_visibility_object_write_is_atomic_and_idempotently_recoverable` | Covered |
| Recovery | `test_catalog_outbox.py::test_r1_a_reinitialized_empty_store_is_rebuilt_from_postgres`, `::test_r2_…`, `::test_r3_…`; `auth/tests/public-reads.test.ts` › "restores lost records from PostgreSQL without touching discovery or waking a database for anonymous reads"; `tests/operations/test_recovery.py` | Covered |
| No superseded quote reappears | `test_price_runner.py::test_a_runner_killed_before_its_write_and_reclaimed_never_resurrects_the_old_quote`; `test_public_records.py::test_quote_state_never_falls_back_to_an_older_mapping_revision_or_attempt`; `test_catalog_outbox.py::test_r3_never_reuses_a_mapping_revision_the_lost_timeline_already_wrote_quotes_under` | Covered |
| No revoked token reappears | `test_publications.py::test_failed_republish_replay_cannot_revive_a_revoked_token_or_erase_the_invalidation`; `test_published_cost.py::test_a_replayed_stale_republish_cannot_restore_the_cost_of_a_revoked_token` | Covered |
| No old eligibility reappears | `test_catalog_targets.py::test_changed_mapping_quarantines_immediately_and_never_auto_reverifies`; `test_catalog_outbox.py::test_stalled_drainer_cannot_overwrite_a_newer_invalidation` | Covered |

### C5. Caps, fairness and refusal across replicas

| Clause | Tests | Status |
| --- | --- | --- |
| One caller alternating replicas; two-active-request cap | `price-refresh.test.ts` › "admits exactly two of four concurrent hard requests from one user alternating between replicas, even when commits are slow", "refuses further requests while two are held, adds no commit for them, and admits again once the permits are released" | Covered |
| 32-outstanding-job cap shared | `price-refresh.test.ts` › "holds the per-user 32 job cap whichever replica asks"; `test_deck_cost.py::test_bounded_admission_never_drops_copies_on_a_later_access` | Covered |
| Fairness beyond the first 32 jobs | `test_price_refresh.py::test_sixty_four_hard_rows_admit_the_32_least_recent_and_a_follow_up_admits_none`, `::test_one_hundred_rows_progress_over_four_accesses`; round-robin in `price-runners.test.ts` › "30 jobs from five users …". Not through the gateway: least-recent selection and round-robin live entirely in the PostgreSQL-free `evaluate_and_admit` and the runner; the gateway only signs the caller, which C5 rows 1–2 prove | Partial (accepted) |
| Dedupe | `price-refresh.test.ts` › "coalesces the same Edition across replicas and duplicates in a body into one job with an unchanged lifetime, and counts the permits per user across replicas"; new fifth test in `published-cost.test.ts` (the metric line reads 5 jobs for 67 accesses, but only 14 accesses waited and reached admission; the test does not assert that admitted callers came through both replicas, which the existing price-refresh test covers) | Covered |
| Rate limits | `price-runners.test.ts` › "with an empty bucket, fetches are about one second apart" | Covered |
| Queue limits | as the C4 "full queue" row; `price-refresh.test.ts` › "every committed scheduler version … respected every cap" | Covered |
| Global interactive cap | `price-refresh.test.ts` › "refuses the 33rd global permit …"; new fifth test (14 callers waited, against a cap of 32, so the test never makes the cap bind; `admitted 5 + joined 65 = 70` is 14 accesses of 5 rows each); the cap itself rests on the existing price-refresh test | Covered |
| Uncertain-liveness refusal | `price-runners.test.ts` › "pause (SIGSTOP) …" (`busy`/`runner_uncertain` at once); `test_price_refresh.py::test_an_uncertain_dead_slot_answers_busy_at_once_and_is_recorded_in_stats` | Covered |

### C6. Runner lifecycle, with actual processes and outbound requests

| Clause | Tests | Status |
| --- | --- | --- |
| Failed launch | `price-runners.test.ts` › "failed launch: nothing starts and the jobs stay queued; the next access launches and completes them (AC1)"; `test_price_refresh.py::test_a_failed_launch_frees_the_slot_keeps_the_jobs_and_answers_at_once` | Covered |
| Crash | `price-runners.test.ts` › "crash (SIGKILL): the next access reclaims the slot through the lock and costs exactly one extra fetch"; `test_price_runner.py::test_a_crashed_worker_leaves_its_jobs_queued_and_hands_off_to_nobody` | Covered |
| Pause | `price-runners.test.ts` › "pause (SIGSTOP) …" | Covered |
| Cancellation | `price-runners.test.ts` › "cancellation: a job that expires before it is claimed is never fetched" | Covered |
| Restart | `price-runners.test.ts` › "restart: a worker killed mid-fetch is cleaned up by its supervisor and a new runner picks up the requeued job" | Covered |
| Idle exit | `test_price_runner.py::test_launched_runner_serves_a_job_with_a_clean_environment_and_exits_when_idle` (a real process), `::test_idle_exit_follows_two_seconds_of_nothing` | Covered |
| Forced lifetime termination | `test_price_runner.py::test_hanging_worker_is_killed_at_the_sixty_five_second_hard_stop` (a real supervisor; the hard stop is scaled to 5 s through the test sitecustomize, and the test asserts the production constant is 65 s) | Covered |
| Actual processes and outbound requests recorded | `price-runners.test.ts` › "30 jobs from five users never exceed two runners, eight fetches, four per slot or two per caller" (metric line `caps: … processes {"s":2,"w":2,…} fetches all=8 …`), "no launched runner connected to the fake PostgreSQL port, or to anything but the record store and the source"; `test_price_runner.py::test_two_runner_processes_respect_slot_caller_and_global_caps` | Covered |

### C7. Latency through the real gateway

| Clause | Tests | Status |
| --- | --- | --- |
| Cached ordinary-price p95 under 500 ms | New fifth test in `published-cost.test.ts` (20 sequential `POST /api/prices/editions` through G0 after a warm-up; asserts p95 < 500 ms). Store-level support: `test_public_records.py::test_cached_reads_at_10k_records_are_well_under_the_500ms_budget` | New |
| Private hard expiry within 3 s | `deck-cost.test.ts` › "gives a whole Deck of hard rows one three-second budget against a hanging source, keeps checks and inventory writes responsive, and names the captured revision"; `price-runners.test.ts` › the two "timeout (AC9)" tests; `prices.test.ts` › "answers 504 PRICE_DEADLINE inside three seconds when the API hangs", "answers 504 when the API stalls mid-body, before any status line is sent" | Covered |
| Public hard expiry within 3 s | `published-cost.test.ts` › "answers a hard row inside the 3 s budget measured outside the gateway while the snapshot stays fast …" | Covered |
| Slow relay reads | `deck-cost.test.ts` › "… answers a slow store inside the budget"; `test_prices.py::test_a_relay_that_stalls_cannot_hold_the_answer_past_three_seconds`; `test_price_refresh.py::test_a_slow_relay_bounds_admission_and_labels_rows_busy` | Covered |
| Final authority validation | `test_prices.py::test_a_stalled_final_validation_withholds_the_quote_inside_the_budget`; `test_published_cost.py::test_a_stalled_snapshot_read_answers_inside_the_budget`; `prices.test.ts` › "takes the receipt time before a slow session lookup, so the API sees only what is left", "gives up with 504 when the session lookup alone spends the budget". The final validation itself is stalled only at the signed-HTTP seam. That is the owner-approved test split from #61 (stalled-read bound at signed HTTP); the gateway's 2.9 s abort is proven separately | Partial (accepted) |
| A blocked source does not block non-price content | `web/tests/price-refresh.spec.ts` › "the page renders at once, price slots show their pending text, then the server's labelled fallback"; `prices.spec.ts` › "a slow price route never blocks the rest of the page, then falls back to a labelled message"; `deck-cost.test.ts` (checks and inventory write under 1 s during the wait); `published-cost.test.ts` (snapshot 4 ms during a hard row); `deck-cost.spec.ts` › "a deadline answer or a stalled request shows no numeric coverage, only the total, and the page stays usable" | Covered |

### C8. External boundaries only; real clocks; zero wakeups

| Clause | Tests | Status |
| --- | --- | --- |
| Controlled source replies | `FakeSource` in `auth/tests/price-runners-harness.ts`; `test_price_source.py` fake server | Covered |
| Injected eligibility clock | Seeded `checked_at` at the store boundary (`price-refresh.test.ts` › "seeded eligibility times"); `quote_contract.wall_ms` is the module clock, patched only in pytest (`test_prices.py::test_staleness_uses_the_module_clock_and_a_fresh_check_does_not_clear_it`) | Covered |
| Injected runtime launcher | `PRICE_FIXTURE_LAUNCHER=record|fail` (`api/tests/catalog_process_fixture/price_fixture.py`) | Covered |
| Real monotonic clocks for elapsed time | Every elapsed bound uses `performance.now()` or `time.monotonic()` | Covered |
| Absent, forged and valid cookies, with gateway and API connections instrumented, give zero wakeups | `auth/tests/http.test.ts` › "serves Published Deck reads with no, forged and valid cookies without waking either database"; `published-cost.test.ts` › test 1 (cost) and test 4 (exports), each with live-counter controls; the new fifth test (only G1 and A1 are instrumented; the wakeup counters stay unchanged across the anonymous calls that went through them, none carrying a cookie) | Covered and New |

### C9. Functional examples

| Clause | Tests | Status |
| --- | --- | --- |
| $1.61 / 5-of-6 | `web/tests/deck-cost.spec.ts` › "three $0.25 copies, two stale $0.43 copies and one unpriced copy show $1.61 and 5/6 priced"; `published-cost.spec.ts` › "an anonymous visitor sees $1.61 and 5/6 …"; `deck-cost.test.ts` test 1; `published-cost.test.ts` test 1 | Covered |
| Multi-page reads | `deck-cost.spec.ts` › "a Deck spread over several Holding pages is priced in full before More cards is pressed"; `live-export.spec.ts` › "every Edition is exported across Holdings pages"; `mass-entry.spec.ts` › "every page of a large Deck is exported and an inventory change discards the result" | Covered |
| Concurrent-inventory reads | `deck-cost.spec.ts` › "a cost for an older inventory revision is discarded and a concurrent change is priced from the new revision"; `live-export.spec.ts` › "an inventory change discards the export"; `test_deck_live_export.py::test_a_concurrent_add_yields_one_consistent_revision_and_quantity`; `test_deck_mass_entry.py::test_concurrent_inventory_changes_always_yield_one_consistent_revision` | Covered |
| Empty, no price, incomplete coverage | `deck-cost.spec.ts` › "an empty Deck is $0.00 with No cards, and a Deck with no eligible quote is 0/N priced", "an incomplete 200 answer without a total falls back to the checks total …"; `deck-cost.test.ts` › "reports an incomplete scan …"; `test_published_cost.py::test_published_cost_labels_empty_unpriced_and_unreadable_snapshots` | Covered |
| Stale and unknown age | `prices.spec.ts` › "card information shows each Edition's own price with age, stale and finish labels …"; `test_deck_cost.py::test_unknown_provider_age_is_counted_by_copy_and_never_called_fresh_or_stale`; `test_prices.py::test_staleness_is_strictly_over_48_hours_of_provider_age` | Covered |
| Exact physical mapping | `prices.spec.ts` (same test); `test_catalog_targets.py::test_active_rule_verifies_only_an_exact_variant_and_names_the_quote_variant`, `::test_unspecified_variants_never_verify_under_either_descriptor_shape`; `test_published_mass_entry.py::test_an_unspecified_variant_never_gets_a_product_even_when_its_edition_is_verified` | Covered |
| Quarantine | `metadata-review.spec.ts` › "a maintainer-cleared quarantine is visible in the public record after delivery"; `mass-entry.spec.ts` › "a missing or quarantined mapping gives complete labelled text …"; `published-mass-entry.spec.ts` | Covered |
| Independent targets | `metadata-review.spec.ts` › "quarantining the Edition mapping leaves a reviewed Live identity eligible"; `test_catalog_targets.py::test_a_rule_input_change_suspends_only_the_affected_printing_and_its_marketplace_state_is_untouched` | Covered |
| Complete exports | `live-export.spec.ts` › "Copy reports success only after the clipboard write resolves, with exact text and non-60 warnings"; `mass-entry.spec.ts` › "an all-mapped Deck opens TCGplayer only after the explanation …"; the published specs; new `test_deck_capacity.py` (1,000 rows) | Covered and New |
| Clipboard failure | `live-export.spec.ts` › "a denied clipboard shows the failure and the complete selectable text"; `mass-entry.spec.ts` (denial keeps selectable text); `published-live-export.spec.ts`; `published-mass-entry.spec.ts` (`stubClipboard(visitor, "reject")`) | Covered |
| Oversized fallback | `live-export.spec.ts` › "output beyond 256 KiB is not shown inline and downloads complete"; `mass-entry.spec.ts` › "a link over 2,000 bytes is withheld and the complete text is offered"; new 1,000 test (`encoded_length`) | Covered |
| Legacy proof | `test_published_cost.py::test_legacy_and_unproven_rows_stay_readable_and_unpriced_until_a_republish_captures_them`; `test_published_live_export.py::test_legacy_and_unresolved_printings_block_the_complete_live_export_while_the_snapshot_stays_readable`; `test_published_mass_entry.py::test_legacy_and_unproven_rows_keep_complete_name_text_and_never_get_a_product`; `published-cost.test.ts` test 1 (legacy through the gateway) | Covered |
| Claimed supported rule cases | `test_deck_live_export.py::test_complete_text_covers_every_claimed_rule_case_and_groups_by_identity_only` (ordinary, promo, Trainer, Special Energy, Basic Energy, subset, manual, retired); `::test_blocked_deck_lists_every_blocker_and_withholds_all_text` (ALT unsupported); `live-export.spec.ts` › "blocked Decks list every blocker and offer no text" | Covered |

### C10. Record and gate

| Clause | Where | Status |
| --- | --- | --- |
| Evidence fields recorded | `evidence/integrated-verification.md` (WP-C) | New |
| Full regression gate with `npm run verify` | one orchestrator run (step O3) | New |

### C11. Launch gates stay pending

| Clause | Where | Status |
| --- | --- | --- |
| Datastore preflight, destination, physical match, walkthrough, deployed observations and staged enablement stay pending | `launch-checklist.md` untouched (AC7); the evidence doc says so | Covered |

## Findings and limits

- **F1-F3. Removed.** They recorded a 25,000-Edition measurement that the owner later dropped (owner decision Q1).
- **F4. Storage.** The records directory takes 8,262,728 bytes at 1,000 Editions (about 8.3 KB per Edition), mostly retained generations and per-record files. Catalog delivery took 1.765 s and quote seeding 0.784 s. These figures are synthetic and local, not a provider estimate.
- **F5. `busy` refusals are invisible in stats.** In the 100-caller day-old burst, `stats.refused` stayed `{}` (`stats {"admitted":5,"expired":0,"fenced":0,"joined":65,"refused":{}}`) even though admission CAS contention answers some accesses `busy` without recording a reason. This is the known follow-up from #56 and #57. The same line records `waited 14 (cap 32)`: `admitted 5 + joined 65 = 70` is 14 accesses of 5 rows each, so 53 of the 67 A/B accesses (67 minus 14) answered without waiting. The `published-cost-metrics.log` and `verification.log` both record 14.
- **F6. Two clauses are proven below the gateway.** Fairness beyond 32 jobs and stalled final validation are proven at the admission and signed-HTTP seams, not through the gateway (C5 and C7, Partial (accepted)).
- **F7. The new vitest bounds run under parallel load, and the day-old margin is thin.** The p95 < 500 ms and <= 3,500 ms bounds run alongside the other vitest files, because #68 (a vitest serial pass) is still open. Recorded: Edition-route p95 32 ms against 500 ms (about 15 times); cached burst max 243 ms against 3,500 ms (about 14 times). The day-old burst is the real exposure: its max was 2,431 ms, but a slow answer there fails at the gateway abort, `BUDGET_MS - RESPONSE_MARGIN_MS` = 2.9 s (`auth/src/server.ts`), which returns 504 and fails `expect(status).toBe(200)` before the 3,500 ms bound can be reached. The margin is therefore 2,431 ms against 2,900 ms, about 1.2 times. The API's wait is relative to the signed budget (`wait_until = hard - 0.5 s`, `api/app/price_budget.py`), so each waiter has about 0.5 s after its wait to finish its reads and respond, and about 14 waiters finish their waits together in each API process. Under load from other vitest files this can fail; #68 is the remedy. The bound is not loosened.
- **F8. Gate time grew more than budgeted; the diff explains little of it.** The brief budgeted about +1 to +5 s on the 328 s baseline (`20261011T022637Z-1884a46f`: setup 15, pytest 142, vitest 47, browser 86, operations 38). This run took 363 s (setup 17, pytest 158, vitest 50, browser 98, operations 40). Parallel pytest: `827 passed, 5 skipped ... in 62.73s` (baseline `verification.log:174`) to `829 passed, 6 skipped ... in 75.63s` (this run `verification.log:174`), +12.9 s against a budget of +0 to +4 s. Serial pytest: 77.63 s to 77.74 s (`verification.log:225`), flat, with the same 67 tests. Per-test attribution, method: summed `time` attributes of the testcases present in both runs from `pytest-parallel.xml`, `pytest-serial.xml` and `vitest.xml`, and summed result durations of the specs present in both runs from `playwright-parallel.json`.
  - Pre-existing parallel pytest tests: 331.9 to 377.2 summed test-seconds (+45 s, +14%), spread across many files; the largest increases are `test_metadata_reviews` +5.0, `test_catalog_outbox` +4.5 and `test_public_records` +4.0. The new 1,000-Edition test adds 5.6 test-seconds.
  - Serial pytest pass: 77.1 to 77.2 summed test-seconds.
  - Browser: 54 of 57 parallel tests are slower, 241.9 to 284.8 summed seconds (+18%), with no new browser work.
  - Vitest: pre-existing tests 134.7 to 143.0 summed test-seconds (about +8 s); the new fifth test adds 4.5; the phase grew 47 to 50 s.
  - Judgement: the change can add at most about +8.6 s and most likely about +4 s, so at least about 26 s of the +35 s cannot come from the diff. The slowdown is spread evenly across pre-existing tests in every parallel phase while the single-process serial pass is flat, which points to reduced host parallel capacity, not a regression. No other verify overlapped the gate (the preceding verifies ended at 03:29:13Z and 03:29:33Z; the gate started at 03:30:01Z). No second gate was run, so this is an inference and the +1 to +5 s budget is not demonstrated.

### Owner decisions (2026-10-10)

The owner answered the open questions as follows.

- **Q1.** A Deck holds at most 60 cards in play, so the 25,000-distinct-Edition case is out of scope. The opt-in 25,000 test, its script and its recorded JSON were measured once at `826cf66` and then removed; no performance follow-up is opened for it. The gate keeps the 1,000-Edition test as headroom far beyond a playable Deck.
- **Q2, Q2a and Q3.** Withdrawn with Q1: they asked whether the 25,000-Edition `incomplete` answers, the API's narrow deadline overrun at that size and the resulting 9.9 MB manifest were acceptable.
- **Q4.** The two "Partial (accepted)" clauses (fairness beyond 32 jobs; stalled final validation) are accepted without gateway duplicates.

## Launch gates

Nothing here changes the [launch checklist](../launch-checklist.md). These all stay pending until their real evidence passes:

- the actual-target-datastore correction preflight;
- destination imports and resolved product behavior;
- physical-match proof;
- the owner walkthrough;
- deployed observations;
- staged target enablement.

Synthetic fixtures and reference comparisons do not establish launch acceptance.
