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

## To be filled in by 07 and 08

Admission algorithm, classification bands, runner lifecycle, source client and recovery table. See the ticket plans.
