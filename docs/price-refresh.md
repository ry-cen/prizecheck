# Price refresh: record contract (tickets 07 and 08)

Skeleton written in Slice 0. Admission (07) and the runners (08) fill in behaviour; the shapes and invariants below are the contract both sides code against. The code for every shape is `api/app/quote_contract.py` (builders and strict validators). The 06 quote/result contract stays in `docs/prices.md`.

Times are integer epoch milliseconds unless noted. `<ref>` is a Edition `public_ref`, `<rev>` its `mapping_revision`, and a job is identified by `<ref>:<rev>`. Every key below passes `key_family` and every coordination record is protected from eviction.

## Records

```
admission:price:scheduler = {
  v:1,
  bucket:{milli:8000, at_ms},
  interactive:{<request_id>:{caller, until_ms}},      // <=32, <=2 per caller, TTL-pruned
  jobs:{"<ref>:<rev>":{caller, card, admitted_ms, expires_ms /* admitted+60000, never extended */,
                       state:"queued"|"running", slot:null|0|1, owner:null|hex32, attempt:null|int}},  // <=256, <=32 per caller
  fifo:{<caller>:["<ref>:<rev>", ...]},               // exactly the queued jobs, per caller
  ring:[<caller>, ...], cursor:int,
  source:{<permit_id>:{caller, slot, owner, jobs:[...], started_ms}},   // <=8, <=2 per caller, <=4 per slot
  ledger:{interval:int, count:int},                   // <=10000 anonymous callers per interval
  stats:{admitted, joined, refused:{reason:n}, expired, fenced}
}
admission:price:ledger:<00..63> = {v:1, entries:{"anon:<digest>":{expires_ms}}}
lease:price:runner:<0|1> = null | {v:1, owner, state:"reserved"|"running"|"exiting", host, reserved_ms,
       launcher_pid, claimed_ms|null, supervisor_pid|null, worker_pid|null, lease_until_ms, hard_stop_ms|null}
backoff:price:source = {v:1, retry_ms, reason:"retry_after"|"rate_limited", set_ms}
backoff:price:edition:<ref>:<rev> = {v:1, failures, last_attempt_ms, retry_ms,
       reason:"timeout"|"transport"|"http_status"|"redirect"|"too_large"|"malformed"|"ambiguous"|"lookup_drift"}
work:<ref>:<rev>  = {v:1, edition_ref, mapping_revision, card, variant, product_id, caller, admitted_ms, expires_ms,
                     state:"queued"|"running", attempt:null|int, slot:null|int, owner:null|hex32}
fence:<ref>:<rev> = {v:1, attempt:int}
quote:<ref>:<rev>  = docs/prices.md
result:<ref>:<rev> = docs/prices.md; an `absent` result also carries `attempt`
```

Backoff schedule: failure k waits `min(60 * 2^(k-1), 900)` s times a jitter in 0.8..1.2, or a valid Retry-After when that is longer. A source-wide backoff is capped at 1 h.

## Invariants

1. Only the fence holder writes `result:`/`quote:`, and only under the job's revision.
2. `result.attempt == quote.attempt == fence.attempt`, as integers.
3. `checked_at` changes only on a validated write.
4. Absence is always `absent` plus `quote` deleted, written in one CAS.
5. The only result states the runner writes are `quote` and `absent`; it never writes `pending`.
6. No source I/O happens without a committed claim holding a token, a permit and an owned lease.
7. Runner and source permits are released only after a commit, a `waitpid`, or a lock-confirmed reclaim. Interactive permits are TTL-bound.
8. `expires_ms` is set exactly once.
9. Every cap holds at every committed scheduler version.
10. The runner has no `DATABASE_URL` and never imports psycopg.
11. Admission never writes PostgreSQL, and a read under 1 h writes and contacts nothing.

## Read isolation

`quote_states` returns a per-row `invalid` state for a malformed `result:`/`quote:` record. The 06 read maps it to `failed/invalid_quote`, so one bad row never blanks the batch. Store unavailability still raises.

## Test seams (CI only)

`api/tests/catalog_process_fixture/price_fixture.py`, loaded from `sitecustomize`:

- `PRICE_FIXTURE_SOURCE_ORIGIN` redirects `app.price_source.ORIGIN` to a loopback origin.
- `PRICE_FIXTURE_LAUNCHER=record|fail` (with `PRICE_FIXTURE_LAUNCH_LOG`) replaces `price_launcher.spawn`.
- A process that asks to import `app.price_runner` while `PRICE_RUNNER_LOCK_DIR` is set refuses non-loopback connects.

`PRICE_RUNNER_LOCK_DIR` is the host-local directory for runner lock files (default `.local/price-runners`, gitignored). CI points it at a private temporary directory.

## Admission (ticket 07)

`app.price_refresh.evaluate_and_admit(rows, caller, budget, store=None) -> Admission`. `rows` are `Row(key, edition_ref, mapping_revision, lookup, product_id, state)` with `state` from `quote_states`. It is PostgreSQL-free so ticket 12 can reuse it anonymously.

1. Classify each row by `result.checked_at` against `quote_contract.wall_ms()`: `< 1 h` fresh; `1 h .. < 24 h` soft; `>= 24 h`, missing/garbled/future (> 5 min) `checked_at`, unknown, invalid, pending: hard. All fresh: no store call at all.
2. Otherwise one snapshot read at the generation of the state read: scheduler, both runner leases, source backoff, the anonymous ledger shard, and the `result:` versions of the open rows. Candidates (not already in `scheduler.jobs`) are ordered least recent first; `work:` and `backoff:` are read in chunks of 64 rows (at most 4 chunks) until the room is filled.
3. Caps: source backoff blocks everything; room = min(32 new per access, 32 - the caller's outstanding jobs, 256 - all jobs); an interactive permit (32 global, 2 per caller, unexpired only) is required when anything is admitted or a hard row is awaited; the anonymous ledger (10000 new callers per hour) refuses only new digests. A refused permit or ledger refuses the whole request as `busy`. Joins (a queued unexpired job or any running job) are free: no write, no re-queue, no lifetime change. An expired queued job is pruned and re-admitted with a new lifetime.
4. One CAS (at most 2 tries, each with deadline `min(wait_until, now + 0.6 s)`, explicit operation id, `operation_status` after an interrupted commit): expects the scheduler, source backoff, both leases, the ledger shard and each new job's `work:`, `result:`, `backoff:` (at most 101 keys); writes the scheduler, new `work:` records, the ledger entry and a `reserved` lease. The second try re-reads the latest state and reclassifies. Every written scheduler passes `validate_scheduler`; a stored scheduler that fails it is never overwritten (rows are `busy`).
5. A slot is reserved when queued jobs exist, the source is not in backoff and no slot is usable (running with a live lease and `hard_stop_ms > now + 3 s`, or reserved less than 5 s ago); a second slot when more than 4 jobs are queued. Only a free slot or a reservation older than 5 s is taken; `running` and `exiting` slots are left to the 08 reclaim. After the commit `price_launcher.spawn(slot, owner)` is called; if it fails the slot is freed best effort and the jobs stay queued. If nothing is running or coming, rows answer `busy` (`launch_failed`) at once instead of waiting.
6. `Admission.wait()` polls every 100 ms until each awaited hard row's `result:` version changes or its job leaves `scheduler.jobs`, and never past `wait_until`. `Admission.release()` removes the interactive permit with its own 1 s deadline (route: `BackgroundTask`); the permit's `until_ms` is `now + budget.remaining() + 500 ms`, so a TTL reclaims it otherwise.

Writes happen only for new jobs, a hard wait (permit), or a needed runner reservation. Refusal reasons are exposed on `Admission.outcomes[key].reason` and `Admission.refused`, and are added to `stats.refused` only inside a CAS that is happening anyway. Pruned expired queued jobs leave their `work:` record behind; the next admission of that Edition overwrites it. Never user-forced: nothing in a request (route, field, header, role) changes the outcome.

## To be filled in by 08

Runner lifecycle, source client and recovery table. See the ticket plans.

## Runner (ticket 08-B)

Code: `api/app/price_runner.py` (supervisor and worker), `api/app/price_launcher.py` (spawn, reclaim, shared cleanup), `scripts/price_runners.py` (operator). Design rationale: [ADR 0008](adr/0008-price-runner-liveness.md). The runner never imports psycopg, `app.main`, `app.prices` or `app.public_catalog`, and its environment never contains `DATABASE_URL`, `INTERNAL_AUTH_SECRET` or `BETTER_AUTH_SECRET`.

### Launch

`price_launcher.spawn(slot, owner)` opens `$PRICE_RUNNER_LOCK_DIR/slot-<n>-<owner>.lock`, takes `flock(LOCK_EX|LOCK_NB)`, starts `python -m app.price_runner --slot n --owner <owner>` with `pass_fds`, `start_new_session`, null stdio, `cwd=api`, and closes the API's copy of the descriptor. A reaper thread waits on the child. The child environment is `PATH`, `LANG`, `NODE_ENV`, `PYTHONPATH`, `PUBLIC_PROJECTION_*` and the absolute `PRICE_RUNNER_LOCK_DIR`. A failed launch returns `False` and leaves no lock file. The lock directory (default `.local/price-runners`) must be host-local; `host-id` in it is created once, atomically.

### Slot lifecycle

1. The supervisor forks the worker (before any thread), then its first store action is the claim CAS: the lease must be `reserved`, owner-matched and at most 5 s old. It becomes `running` with both pids, `host`, `claimed_ms`, `lease_until_ms = now + 10 s` and `hard_stop_ms = claimed + 65 s`. A failed claim kills the parked worker and exits 0 with no source I/O.
2. A supervisor thread renews the lease every 3 s with a CAS on the slot key only (owner-fenced, not time-fenced).
3. The worker claims jobs, fetches, writes, and releases (below). After 2 s with nothing runnable and nothing in flight it sets the lease to `exiting` (a CAS that also expects the scheduler version) and exits.
4. When the worker exits, or is killed with SIGKILL at `hard_stop_ms`, the supervisor runs the cleanup CAS (release the owner's source permits, requeue unexpired running jobs, drop expired ones, rewrite their `work:` records, free the slot), retrying until `hard_stop + 60 s`. It then removes its lock file and, if runnable jobs remain and no other slot can serve them, reserves a slot and spawns a successor.

### Worker

- **Selection.** Walk `ring` from `cursor`; a caller with fewer than 2 source permits supplies its fifo head. All queued, unexpired jobs for that head's card (at most 16) are claimed together. Requirements: fewer than 8 source permits globally and 4 for this slot, no source backoff, at least 1 token (bucket refills 1/s, capacity 8), `now + 2 s <= expires_ms` and `now + 2.5 s <= hard_stop_ms`. Expired queued jobs and jobs that fail validation are cancelled (scheduler entry and `work:` removed) with no backoff and no check-age change.
- **Pre-validation.** `work:` must be `queued` and agree with the scheduler job; `catalog:edition` and `quarantine:edition` must pass the marketplace rules (verified, clear, same `mapping_revision`, `product_id` equal to the work copy compared as text, `quote_lookup` equal to the work's card/variant); the Edition must not be in per-Edition backoff.
- **Claim CAS.** Expects the scheduler, this slot's lease, `backoff:price:source` and, per Edition, `work:`, `fence:`, `result:`, `quote:`, `catalog:edition:`, `quarantine:edition:`. Takes a token, adds the source permit, marks jobs running with `attempt = fence.attempt + 1`, advances the cursor, bumps each fence and rewrites each `work:`. No source I/O happens before this commits.
- **Per-Edition write.** One CAS per Edition with `operation_id = price:<ref>:<rev>:<attempt>`, expecting `result:`, `quote:`, `fence:`, `work:`, `catalog:edition:`, `quarantine:edition:`, `backoff:price:edition:`. Quote: `result` and `quote` with the new attempt, `work:` and the backoff deleted (an unchanged price is rewritten the same way). Absent: `result` absent and `quote` deleted in the same CAS. Failure: only `backoff:price:edition:` is written and `work:` deleted; `result:` and `quote:` are never touched. A 429, or a valid Retry-After, additionally sets `backoff:price:source` in a separate CAS.
- **Conflicts.** The writer re-reads. If `work:` or `fence:` no longer shows this claim (owner, slot, attempt), or the Edition is no longer eligible, it abandons silently (counted in `stats.fenced`). If only `quote:` (an eviction) moved it retries, up to three tries. An unknown outcome is resolved with `operation_status`, then by re-reading.
- **Release.** After the writes, a scheduler CAS removes the permit and the claim's jobs. It is retried until the hard stop and never replaced by time.

### Reclaim and operator recovery

`price_launcher.reclaim_slot(store, slot)` returns `reclaimed`, `uncertain` or `not_applicable` as described in ADR 0008. Admission calls it only when no usable slot exists, as its own bounded step, and records `runner_uncertain` itself when it gets `uncertain`. `scripts/price_runners.py status` prints the leases and scheduler counts; `scripts/price_runners.py release --slot n --confirm-terminated` frees a slot without any liveness check, for another-host or lock-less cases.

### Source seam

The worker imports `app.price_source` and `app.tcgdex_record` lazily. It calls `price_source.fetch(card, may_retry)` (`may_retry` spends a bucket token in a small scheduler CAS) and maps `Fetched.status` 429, or 503 with a valid `retry_after`, to a source-wide backoff; every failure also writes the per-Edition backoff. `tcgdex_record.select_quote(record, descriptor, lookup, product_id)` returns `Quote`, `Absent` or `Failure(reason)`, each mapped to the per-Edition write above. The catalog `product_id` is an integer and the `work:` copy is text; they are compared as text.

### Recovery table

| Event                                        | Recovery                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| API dies after the reservation, before Popen | Reservation expires after 5 s and is replaced.                              |
| Spawn fails                                  | `spawn` returns `False`; admission frees the slot; jobs stay queued.        |
| Worker dies or hangs                         | Supervisor cleans up (SIGKILL at 65 s if hung).                             |
| Both processes die (SIGKILL)                 | Lock is free; same-host reclaim requeues the jobs; one extra fetch.         |
| Runner stopped (SIGSTOP)                     | Lock is held; reclaim returns `uncertain`; the runner resumes and finishes. |
| Another host dies                            | `uncertain`; operator release.                                              |
