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

The bundled adapter binds only loopback, uses local HTTP/development cookies and serves a real FastAPI process, Better Auth gateway and built SPA. Run it in the foreground under a supervisor:

```sh
.venv/bin/python scripts/release_runtime.py \
  --store /private/release-store --runtime /private/installed-runtime --port 5173
```

It restores an existing active release on startup, verifies artifacts/dependencies and its configured database's applied migration names, binds RELEASE_COMMIT to the loaded commit, starts candidate auth/API processes before retiring the old processes, and stops children on termination. This local adapter is an executable test/development implementation, not an internet-facing TLS deployment. A production runtime adapter must preserve the protocol below and configure production origin/cookies/mail/process lifetime through its own provider-specific runtime implementation.

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
