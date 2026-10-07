# Local private backup and disposable restore

This prepares ticket 16; it does not prove production recovery. Providers and provisioning remain pending. No scheduler, retention policy enforcement, last-success marker, independent watchdog, notification delivery, owner status panel, remote private object adapter, or monthly restore schedule is implemented here. Seven daily/four weekly copies and the 24-hour recovery target remain acceptance work.

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

Recovered catalog search remains unavailable until a successful full source reimport: `active_generation` and `last_success` are reset, while immutable catalog identities/displays and manual corrections survive. A restored private database must not be connected to an independently restored, older public projection store: revoked tokens could otherwise reappear. Public projection reconciliation/rebuild and provider-specific cutover remain a separate required recovery procedure. Do not use this disposable drill as a production cutover command.

## Local proof

2026-10-06, local PostgreSQL on port 55432, deterministic small private fixture, disposable `tcg_recovery_*` databases. Run with an administrative connection injected as `RECOVERY_TEST_DATABASE_URL`:

```sh
.venv/bin/python -m unittest discover -s tests/operations -v
```

The real PostgreSQL boundary test verifies exact manual Printing/Edition IDs and Holding quantity/version, approved override relationships, a burned token and pending publication command, live versus expired Undo, sequence continuation, catalog readiness reset, directory privacy, row counts/constraints, existing-target refusal, corruption rejection before database creation, default-public-store exclusion without configuration, and rejection of a real table-read-only role whose sequence state is masked. Both used and unused sequence continuation are checked. This is a small local recovery proof, not a full English catalog or selected-provider restore measurement.
