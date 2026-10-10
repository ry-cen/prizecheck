# Local synthetic capacity evidence — 2026-10-06

This is preparation for tickets 15 and 17, not production launch evidence. Neither ticket is closed. The machine is macOS 15.0.1 arm64, Python 3.14.2, local PostgreSQL 16.15. Exact samples, database bytes, payload sizes and EXPLAIN ANALYZE/BUFFERS plans are in [the sanitized JSON](../validation/local-capacity.json). The UTC recording timestamp falls on 2026-10-07; the local date is 2026-10-06.

## Reproduce

From the integration checkout with Python dependencies installed and a local administrative PostgreSQL connection:

```sh
.venv/bin/python scripts/local_capacity.py \
  --admin-url postgresql://raian@127.0.0.1:55432/postgres \
  --report docs/planning/tcg-collection-tracker/validation/local-capacity.json
```

The command creates a fresh random `tcg_load_` database, applies migrations, runs the opt-in HTTP/PostgreSQL proof and existing failed-transfer boundaries, writes sanitized JSON, then drops only that database. It does not read the ambient DATABASE_URL or mutate an existing fixture database. Non-loopback connections are rejected. Use a disposable local server; the administrator needs database-create/drop permission. A failed command is not a passing proof.

## Fixture and measured results

The fixture has 1,000 synthetic registered auth users and 200 synthetic active session records. These are storage representatives, not a simulated monthly active-user workload. One collector initially has 25,000 Holdings, each quantity six. The catalog deliberately uses **one synthetic Printing with 25,000 synthetic Editions**, so this cannot establish full-English-catalog search performance, realistic joins or raw-import bytes. No real email, tokens or private data are recorded.

After one excluded warm-up, 20 signed FastAPI TestClient HTTP requests per route measured Collection first-page p95 **0.0682 s** and leaf first-page p95 **0.0398 s**. Each response had the correct bounded page count and a continuation cursor. These measurements include API contract parsing/serialization and local PostgreSQL, but exclude browser rendering, the auth gateway, real sockets, internet latency and cold starts. The two-second browser criterion remains unverified.

Five successful 25,000-Edition Moves each stage 50 batches of 500 Editions and then commit. Total measured HTTP staging-through-commit times were **3.031, 3.148, 3.496, 3.559 and 3.655 s**. Commit HTTP duration was **1.916–2.150 s**; this includes the transaction and response serialization and is not a separate transaction-only measurement. Exact source/destination count, minimum/maximum quantity and sum are checked after every Move. This demonstrates successful maximum-cardinality atomic transfers locally; pressing Move in a production browser, progress rendering and the two-minute end-to-end criterion remain unverified.

Five simultaneously retained Move inverse payloads each occupied **978,479 bytes** (`pg_column_size`), totaling **4,892,395 bytes**. These are full 25,000-Edition inverse payloads, not a proof of the largest possible encoded payload across maximum quantities/versions. Database size was **34,767,375 bytes** initially and **131,636,247 bytes** after five Moves. The final database includes 50,000 Holdings, live inverse/manifests/idempotency data, indexes and PostgreSQL physical overhead/dead tuples; it is not a steady-state provider-size estimate.

Three integration checks passed: the new capacity fixture, existing stale 25,000-Edition Move rejection with unchanged balances, and forced destination-write failure with rollback and successful retry. Ordinary inventory-action latency, browser timings and concurrent-load throughput are not measured by this run.

## Remaining evidence

A full English catalog/index/auth fixture, real monthly/concurrent activity, 10,000 public views/month and database-wakeup measurement, cold starts, real browser timings, separate transaction duration, runtime/job resources, provider quotas/storage/bandwidth/email/CI costs and idle-cost arithmetic remain pending. Database bytes here cannot be compared directly to a provider quota without those missing components. No providers or production resources were selected or provisioned.
