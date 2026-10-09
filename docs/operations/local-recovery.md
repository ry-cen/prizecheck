# Local private backup and disposable restore

This low-level recovery CLI underpins the provider-independent [portable operational jobs](portable-jobs.md), which add retention, verified private object upload, success markers, independent watchdog, eligible alert relay and owner status. This document describes snapshot and disposable restore mechanics. Scheduler installation, remote storage configuration and production recovery proof remain deployment checks.

Use the repository Python environment, PostgreSQL `pg_dump` and `psql` matching the server version, and a role allowed to read all public-schema tables plus SELECT or USAGE on every public-schema sequence. Backup refuses a role whose sequence high-water marks would be hidden. Supply the source connection through `DATABASE_URL`, with credentials injected privately rather than typed into shell history. `PUBLIC_PROJECTION_DIR` identifies the public store; when absent, the CLI uses the application default `.local/public-projections` relative to the working directory. Backups within either store are rejected. An explicitly empty or whitespace-only public-store configuration fails before any backup is created. Run the CLI from the same application working directory when using that default. Keep the backup path outside all web-served directories, even when the public store is not running.

```sh
.venv/bin/python scripts/recovery.py backup /private/backup/location/new-snapshot
```

The directory must not exist. The CLI creates it with mode 0700, files with mode 0600, and prints only a bounded success/failure result. Failure removes its incomplete directory. Protect its filesystem, transfer transport, and eventual remote object bucket as private data: auth emails, hashed codes, sessions, private inventory, and public tokens are included. Environment-based PostgreSQL credentials are never arguments to the PostgreSQL tools or log output.

Schema and data share one exported repeatable-read PostgreSQL snapshot. Expiry filters share the snapshot timestamp. The backup preserves application-owned identities, Printing/Edition IDs, immutable displays, manual Catalog Overrides, reviewed references/replacement maps, inventory, Decks, transfers, live Undo, burned publication tokens, and pending publication commands. Only rebuildable generation payload/rows and catalog run state are omitted. Expired Undo, Move manifests/items, mutation requests/responses, approval codes, auth sessions and verifications are excluded. Sequence high-water marks may be ahead of the row snapshot and prevent reuse after restoration.

A SHA256 manifest records each file, retained table row counts and the snapshot timestamp. Checksums detect accidental corruption; they are not an authenticity signature. Restore only backups from a trusted private source: schema files contain executable SQL. The tool currently handles the application's `public` schema; future schemas require explicit support.

For the disposable drill, supply an administrative `DATABASE_URL` with permission to create databases. The target must begin `tcg_recovery_` and must not exist, including as an empty database.

```sh
.venv/bin/python scripts/recovery.py restore /private/backup/location/new-snapshot tcg_recovery_monthly_drill
```

The CLI verifies checksums before creation, creates a fresh database, restores schema/data/sequence values, applies foreign keys/checks/unique indexes/triggers, and checks retained row counts. An unsuccessful restore removes only the new database created by that invocation. An existing target is never overwritten or dropped. Keep the restored database private and delete it after the drill. Success prints a sanitized verification result; it does not change the running application.

Recovered catalog search remains unavailable until a successful full source reimport: `active_generation` and `last_success` are reset, while immutable catalog identities/displays and manual corrections survive. A restored private database must not be connected to an independently restored, older public projection store: revoked tokens could otherwise reappear. Public catalog records are rebuilt from the restored database with `scripts/backfill_public_catalog.py` (recovery cases R1–R3 in `docs/public-projections.md`); publication projection reconciliation and provider-specific cutover remain a separate required recovery procedure. Do not use this disposable drill as a production cutover command.

## Rebuilding public catalog records

The public catalog records in `PUBLIC_PROJECTION_DIR/records` are derived from PostgreSQL. Rebuild them with one command; it needs the same `DATABASE_URL` and `PUBLIC_PROJECTION_DIR` as the API:

```sh
.venv/bin/python scripts/init_public_records.py      # only if the records store must exist
.venv/bin/python scripts/backfill_public_catalog.py  # the rebuild
```

The rebuild reads every key it knows from PostgreSQL, so it works from three starting states. It prints written and unchanged counts, recovery conflicts and the highest stored revision. It exits 1, with a fixed message, when the store or database is unreachable or delivery cannot finish. It never creates the store, never touches Published Decks or the discovery revision and cursor, and is safe to repeat: a second run writes nothing. Anonymous Deck and discovery reads do not depend on the records store and keep working throughout.

**R1: the records store was lost or re-initialized empty.** Run `init_public_records.py`, then the rebuild. It re-enqueues every Printing and Edition and writes them all. Until it finishes, readers of catalog eligibility find no record and treat every Edition and Printing as ineligible (fail closed).

**R2: the records store was restored from an older copy.** Run the rebuild. Every restored record has a lower revision than PostgreSQL, so each is overwritten with the current value. Stale clears cannot survive: only revisions newer than the stored one are written.

**R3: PostgreSQL was restored to a point older than the records store** (for example `scripts/recovery.py restore`, which restores sequences but not the store). Run the rebuild; do not first reset the store.

1. The rebuild scans the store for its highest revision (`store_max`) and for records PostgreSQL does not explain: a stored revision above PostgreSQL's, or the same revision with different content.
2. In one transaction it advances the revision clock to `greatest(revision, store_max)` so no later correction can fall below the store.
3. It marks each unexplained Edition `quarantined` and each unexplained Printing `suspended`, both with reason `recovery_conflict`, at a revision above `store_max`. This closes marketplace and Live eligibility for those targets until a maintainer reviews them.
4. It delivers everything. The fail-closed conflict values replace the foreign records.

Review each `recovery_conflict` target in the maintainer queue; there is no bulk tool. A target that exists only in the newer store and not in the restored PostgreSQL cannot be found by the scan, because the store has no key listing; it is unreachable for readers because no PostgreSQL reference points at it.

Check progress with the owner operations status: `catalog_outbox_pending` returns to 0 and `catalog_outbox_oldest_seconds` is empty when delivery is complete. A row stuck with `StoreAhead` or `RevisionValueMismatch` means the store holds a record PostgreSQL does not explain; run the rebuild.

## Local proof

2026-10-06, local PostgreSQL on port 55432, deterministic small private fixture, disposable `tcg_recovery_*` databases. Run with an administrative connection injected as `RECOVERY_TEST_DATABASE_URL`:

```sh
.venv/bin/python -m unittest discover -s tests/operations -v
```

The real PostgreSQL boundary test verifies exact manual Printing/Edition IDs and Holding quantity/version, approved override relationships, a burned token and pending publication command, live versus expired Undo, sequence continuation, catalog readiness reset, directory privacy, row counts/constraints, existing-target refusal, corruption rejection before database creation, default-public-store exclusion without configuration, and rejection of a real table-read-only role whose sequence state is masked. Both used and unused sequence continuation are checked. This is a small local recovery proof, not a full English catalog or selected-provider restore measurement.
