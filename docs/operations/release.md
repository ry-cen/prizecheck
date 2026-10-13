# Portable manual release and runtime adapter

`release.py` gates a specific commit, seals source/auth/API/build assets, and coordinates an actual configured runtime. `release_runtime.py` supplies a runnable foreground local adapter. No provider account or vendor command is embedded. ADR 0004 separates this implementation from real deployment and launch checks.

## Gate without deployment credentials

Run from the authoritative repository with installed `.venv` and `node_modules`. Select the protected main ref explicitly when the repository uses a different name; local implementation proof uses `refs/heads/codex/manual-release`, not a rewrite of the owner's branches.

```sh
.venv/bin/python scripts/release.py gate \
  --commit FULL_SELECTED_COMMIT \
  --main-ref refs/heads/main \
  --store /private/release-store \
  --runtime /private/installed-runtime \
  --admin-url postgresql://LOCAL_TEST_ROLE@127.0.0.1:5432/postgres
```

The commit must equal that ref at gate entry. The gate uses `git archive`, never the mutable checkout. It creates/drops a new disposable `tcg_release_*` database. Its subprocess environment contains only PATH, temporary HOME, the disposable test connection, test-recovery connection and browser-cache location. Deployment/auth/email/storage secrets are not inherited. Fixed commands run generated-contract/TypeScript/build checks, API/job/PostgreSQL/object-projection tests, live auth and browsers through `scripts/ci.sh`, plus operations seam tests. No callback, supplied success flag or external receipt can substitute for those checks.

On every successor, unchanged previous migration files are required and the previous application's fixed CI runs against the candidate schema in a separate fresh disposable database, avoiding contamination from candidate test fixtures. This tests compatibility using actual old application HTTP/browser/job behavior; it cannot prove every possible production-data state. No destructive migration reversal is supported. Initial releases explicitly have no prior compatibility evidence.

A private SHA256 receipt binds the exact commit, selected ref, files, previous commit and installed Python/Node dependency/binary fingerprint. Source/assets are read-only and a commit directory is never overwritten. Build artifacts contain no deployment environment files. CI diagnostics remain in the private store; fixtures and logs must remain synthetic. Protect that directory from writes by untrusted actors. Local receipts provide integrity under this filesystem trust model, not authenticated results from an external CI provider. A hosted gate must enforce its main-ref and job identity through the provider's protected workflow and trust boundary.

## Runtime configuration and real activation

Inject DATABASE_URL, INTERNAL_AUTH_SECRET, BETTER_AUTH_SECRET, OWNER_EMAIL, MAIL_MODE/MAIL_FILE or the mail adapter configuration, PUBLIC_PROJECTION_DIR, and a private RELEASE_CONTROL_KEY of at least 32 characters. Initialize the projection store explicitly with `scripts/init_public_projection.py`, which also initializes the shared public records store. For an install that already has a publication store but no shared records, run only `scripts/init_public_records.py`. It leaves the publication/discovery manifest untouched, is idempotent, and exits 1 without changes if established records are missing or corrupt or a legacy records store holds data (restore from backup). With `PUBLIC_PROJECTION_ADAPTER=http` both scripts call the relay's `initialize` action, so the deployment-owned relay defines its own upgrade behavior (see `docs/http-public-projection.md`). After initializing records on an existing install, run `scripts/backfill_public_catalog.py` once; catalog imports and approvals publish their catalog records best effort, and rerunning the backfill repairs any missed writes (it exits 1 when the store or database is unreachable, and 3 when another drain still holds the delivery lock; retry in the second case). Dependencies must match the gated fingerprint; changing the runtime requires a fresh gate in that environment.

Card attributes (migration 030) have no fallback to the old source energy type: a Printing has a Basic Energy status only once its attributes are derived from its stored catalog source record. Every catalog import derives them, but a catalog imported before 030 has none. When activating the first release that contains `migrations/030_card_attributes.sql`, run the candidate's scripts with the gated runtime's Python and the runtime's `DATABASE_URL` first, then activate:

```sh
cd /private/release-store/FULL_GATED_COMMIT
/private/installed-runtime/.venv/bin/python scripts/migrate.py
/private/installed-runtime/.venv/bin/python scripts/derive_card_attributes.py
cd - && .venv/bin/python scripts/release.py activate \
  --store /private/release-store --runtime /private/installed-runtime \
  --runtime-url http://127.0.0.1:5173 --commit FULL_GATED_COMMIT
```

The previous release keeps serving meanwhile; it ignores the new tables, and `activate` then finds no migration left to apply. The derivation fetches nothing and takes a few seconds for the whole catalog. It exits 3 without changes while a catalog import is running (retry when the import has finished) and 1 when the database is unreachable; rerunning it changes nothing. Skipping it leaves every existing Printing's attributes unknown until the next catalog import: Deck checks report the Basic Energy exemption as unresolved for every card, and a Deck published during that gap freezes those unresolved checks into its Published Deck until the owner republishes it.

Run the same script, the same way, when activating the first release that contains `migrations/035_reprint_groups.sql`: a catalog imported before 035 has no Reprint Groups, so until the script or the next catalog import runs, format checks judge every old Trainer and Energy printing on its own mark and set and call it not legal where an identical legal reprint would make it legal.

Published Deck format results (migration 036, Deck Lists 18) read each Printing's public format facts (`catalog:format:<ref>` in the shared records store) and never PostgreSQL. A store written by an earlier release has none, so when activating the first release that contains `migrations/036_public_format_facts.sql`, run its migration and derivation as above, activate, and then publish the facts for the existing catalog once with the candidate's script. With `PUBLIC_PROJECTION_ADAPTER=http`, the records relay must first accept `catalog:format:<48 hex>` as a protected, non-evictable key family: a format record shares its Printing's compare-and-swap, so a relay that rejects the family fails every Printing delivery as unavailable.

```sh
/private/installed-runtime/.venv/bin/python scripts/backfill_public_catalog.py
```

It writes one format record per Printing next to its unchanged catalog record (nothing is a recovery conflict: a missing record counts as older), exits 3 while another drain holds the delivery lock (retry) and 1 when the store or database is unreachable, and a second run writes nothing. Until it finishes, Published Deck format results report every card as `card_data_unavailable` (unknown, never legal). The first drain after activation may also notice the missing records on its own and re-enqueue the whole catalog, which only repeats this backfill's work. `scripts/derive_card_attributes.py` now takes longer for a catalog whose attributes or Reprint Groups change, because each changed Printing, and every Printing of a Reprint Group whose membership changed, is re-stamped and enqueued; the first run after migration 035 forms every group, so it re-stamps most of the catalog once. It also holds the public catalog clock for its whole transaction, so while it runs, attribute and metadata decisions answer 409 `CATALOG_BUSY` and missing-card approvals wait; run it in a quiet window. After a rollback below this release, do not run `scripts/derive_card_attributes.py`: the older runtime does not take the clock first, so it can deadlock with a decision against migration 036's triggers (PostgreSQL aborts one side with a retryable error). Also after such a rollback, the database triggers keep re-stamping Printings whose attributes or Reprint Groups change, but the older runtime publishes only their catalog records; run the backfill again after rolling forward.

Basic Pokémon status (migration 038, Deck Lists 20) is a derived card attribute and a public format fact. When activating the first release that contains `migrations/038_basic_pokemon.sql`, run its migration and `scripts/derive_card_attributes.py` as above (the derivation rules are now version 2, so it rewrites every TCGdex Printing's derived row once and re-stamps each Printing whose Basic Pokémon status became known), activate, and then run `scripts/backfill_public_catalog.py` once with the candidate's script. Until the derivation runs, every Printing's Basic Pokémon status is unknown, so private format checks report "Basic Pokémon status unknown" for any deck without a corrected Basic Pokémon (unknown, never legal). Format records written before 038 lack `basic_pokemon`, and the strict public reader treats them as malformed: Published Deck format results report those cards as `card_data_unavailable` (unknown, never legal) until their Printing is re-stamped by the derivation or rewritten by the backfill. The backfill rewrites the rest (manual Printings, and Printings whose status stays unknown) at their current revision without calling them recovery conflicts, and a second run writes nothing. It only rewrites a record's shape: a manual Printing has no derived row, so its Basic Pokémon status stays unknown (never legal) until a maintainer adds `basic_pokemon` to its correction. Between the derivation and activation, the previous release's public reader refuses the new ten-attribute records in the same way, so run the three steps in one quiet window. After a rollback below this release, the database keeps the column and its triggers; the older runtime ignores it, and its reader refuses the newer records until you roll forward and run the backfill again.

The bundled adapter binds only loopback, uses local HTTP/development cookies and serves a real FastAPI process, Better Auth gateway and built SPA. Run it in the foreground under a supervisor:

```sh
.venv/bin/python scripts/release_runtime.py \
  --store /private/release-store --runtime /private/installed-runtime --port 5173
```

It restores an existing active release on startup, verifies artifacts/dependencies and its configured database's applied migration names, binds RELEASE_COMMIT to the loaded commit, starts candidate auth/API processes before retiring the old processes, and stops children on termination. The local runtime signs in by email code and defaults `EMAIL_SIGN_IN` to `on`; if `.env` is sourced first, `.env.example` now sets `EMAIL_SIGN_IN=off`, so keep `EMAIL_SIGN_IN=on` (or configure a provider) or the auth process refuses to start. This local adapter is an executable test/development implementation, not an internet-facing TLS deployment. A production runtime adapter must preserve the protocol below and configure production origin/cookies/mail/process lifetime through its own provider-specific runtime implementation.

```sh
.venv/bin/python scripts/release.py activate \
  --store /private/release-store --runtime /private/installed-runtime \
  --runtime-url http://127.0.0.1:5173 --commit FULL_GATED_COMMIT
.venv/bin/python scripts/release.py rollback \
  --store /private/release-store --runtime /private/installed-runtime \
  --runtime-url http://127.0.0.1:5173
```

The coordinator takes an exclusive filesystem lock, checks receipt/current/previous relationships and runtime identity, applies forward migrations, asks the adapter to activate, and checks health, unauthenticated protected rejection, unknown public not-found, exact HTML and referenced asset bytes. Only then does it atomically update the active symlink and retain the compatible previous release. A failed candidate smoke asks the adapter to restore the prior runtime, rechecks it and leaves the active record unchanged. An initial failed activation clears the runtime. Rollback loads previous auth/API/assets against the current schema, without reverse migrations. Missing configuration, altered artifacts, runtime mismatch or stale release relationships fail closed. A failed adapter recovery requires operator attention; no successful release is reported.

After rolling back past migration 026, or for any backup taken while a pre-026 release is serving, the old `scripts/recovery.py` copies `move_manifest_entry` without filtering but drops expired `move_manifest` parents, so restoring that backup fails on the foreign key. Take such backups with a `scripts/recovery.py` from migration 026 or later, or run `DELETE FROM move_manifest WHERE expires_at <= now() + interval '5 minutes'` immediately before the backup; if a restore still fails on `move_manifest_entry`, repeat the delete and take the backup again.

Don't run `scripts/recovery.py backup` while a release is applying migrations. Migration 026 locks the move tables in a different order from the backup's reads, so the two can deadlock; PostgreSQL aborts one of them, and the aborted backup or release can be retried.

Migration 026 mirrors staged Move items one way only: items the previous application stages reach the new `move_manifest_entry` table, but items the new application stages never reach the old `move_manifest_item` table. So while old API processes are still serving during an activation overlap, or after a rollback past 026, a Move or Inventory Removal staged by the new application and committed by a previous-release process fails with nothing changed. A workspace selection's manifest has no source: a Move fails with `404 LOCATION_NOT_FOUND` and an Inventory Removal with `409 SAME_LOCATION`. A single-source manifest (the Decks page's Holdings panel) fails with `422 EMPTY_MOVE_SELECTION`. The collector selects the cards again and retries. This residual was accepted in [#106](https://github.com/ry-cen/prizecheck/issues/106).

## Adapter contract

The configured origin can be HTTPS or loopback HTTP; control redirects are refused so the private key is not forwarded elsewhere. The coordinator never executes arbitrary provider shell callbacks. Implement these authenticated HTTP endpoints using `x-release-key`:

- `GET /__release/status`: return `commit` (null initially) and `runtime_fingerprint` matching the gated installed runtime.
- `POST /__release/apply`, JSON `{"commit":"FULL_SHA"}`: verify the sealed artifact and database readiness, set RELEASE_COMMIT to the loaded commit (never an inherited stale value), actually load that auth/API/assets release, and return its commit only after readiness. Preserve and stop old processes safely.
- `POST /__release/clear`, JSON `{}`: stop an unsuccessful initial runtime and return a null commit.
- Normal `/`, built asset, `/auth/*`, and `/api/*` routes must reflect the current runtime and preserve public privacy/cache headers.

Keep control endpoints private and authenticated; prevent unauthorized callers and serialize provider-side changes. Configure its artifact resolver to the same immutable store (or a verified equivalent object/image store). Supply a service-specific filesystem lock/shared release coordinator when more than one deploy host exists. TLS ingress, remote artifact distribution, provider credentials and actual CI attestation are adapter responsibilities, not domain-code changes.

## Local drill

After gating a baseline and advancing the selected integration branch, the opt-in command uses a newly created disposable database and real local adapter. It gates the successor, exercises old-application compatibility, actual activation, injected smoke-failure recovery, successful successor activation, rollback, preserved private data and artifact-tamper rejection. Standard operation tests also check missing-gate and wrong-main refusal.

```sh
RELEASE_DRILL_MAIN_REF=refs/heads/codex/manual-release \
RELEASE_DRILL_STORE=/private/disposable-release-store \
RELEASE_DRILL_FIRST=FULL_GATED_BASELINE_COMMIT \
RELEASE_DRILL_RUNTIME=/private/installed-runtime \
RECOVERY_TEST_DATABASE_URL=postgresql://LOCAL_TEST_ROLE@127.0.0.1:5432/postgres \
RELEASE_DRILL_REPORT=/private/sanitized-release-report.json \
.venv/bin/python -m unittest discover -s tests/operations -p test_release.py -v
```

Set RELEASE_DRILL_MAIN_REF to the checked-out authoritative branch. The recorded proof fixture used branch `codex/manual-release` as the selected ref; production configuration uses its own authoritative protected main ref. Fixed application CI reserves ports 8000/3001/5173. Runtime smoke uses separate ephemeral ports. The disposable database and runtime processes are cleaned up; sealed local artifacts remain for inspection. Full-English capacity, real OTP delivery, production ingress/recovery/rollback and provider-resource measurements remain external launch checks. Synthetic capacity evidence remains explicitly synthetic.

Release control, runtime loopback forwarding, readiness and smoke HTTP requests explicitly bypass environment proxies and refuse redirects. Control keys must contain at least 32 printable ASCII characters with no whitespace/control characters. Only fixed operator diagnostics are printed; underlying transport/database ValueErrors can contain credentials and remain sanitized. Failed activation/rollback attempts increment the owner panel's durable release-failure counter once whenever the database and operations schema are available. The credential-free gate never writes production status. An older schema or database outage reports status recording as unavailable while preserving the primary failure.

## Reproducible regression fixtures

The ordinary verification gate now builds disposable runtime fixtures itself and runs proxy/key/readiness regressions without a retained `/tmp` store. These synthetic fixture receipts prove runtime behavior only; they are not exact-commit CI attestations. The explicit full release drill above still requires actual gated artifacts and records their provenance separately.
