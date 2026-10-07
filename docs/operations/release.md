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

Inject DATABASE_URL, INTERNAL_AUTH_SECRET, BETTER_AUTH_SECRET, OWNER_EMAIL, MAIL_MODE/MAIL_FILE or the mail adapter configuration, PUBLIC_PROJECTION_DIR, and a private RELEASE_CONTROL_KEY of at least 32 characters. Initialize the projection store explicitly with `scripts/init_public_projection.py`. Dependencies must match the gated fingerprint; changing the runtime requires a fresh gate in that environment.

The bundled adapter binds only loopback, uses local HTTP/development cookies and serves a real FastAPI process, Better Auth gateway and built SPA. Run it in the foreground under a supervisor:

```sh
.venv/bin/python scripts/release_runtime.py \
  --store /private/release-store --runtime /private/installed-runtime --port 5173
```

It restores an existing active release on startup, verifies artifacts/dependencies, starts candidate auth/API processes before retiring the old processes, and stops children on termination. This local adapter is an executable test/development implementation, not an internet-facing TLS deployment. A production runtime adapter must preserve the protocol below and configure production origin/cookies/mail/process lifetime through its own provider-specific runtime implementation.

```sh
.venv/bin/python scripts/release.py activate \
  --store /private/release-store --runtime /private/installed-runtime \
  --runtime-url http://127.0.0.1:5173 --commit FULL_GATED_COMMIT
.venv/bin/python scripts/release.py rollback \
  --store /private/release-store --runtime /private/installed-runtime \
  --runtime-url http://127.0.0.1:5173
```

The coordinator takes an exclusive filesystem lock, checks receipt/current/previous relationships and runtime identity, applies forward migrations, asks the adapter to activate, and checks health, unauthenticated protected rejection, unknown public not-found, exact HTML and referenced asset bytes. Only then does it atomically update the active symlink and retain the compatible previous release. A failed candidate smoke asks the adapter to restore the prior runtime, rechecks it and leaves the active record unchanged. An initial failed activation clears the runtime. Rollback loads previous auth/API/assets against the current schema, without reverse migrations. Missing configuration, altered artifacts, runtime mismatch or stale release relationships fail closed. A failed adapter recovery requires operator attention; no successful release is reported.

## Adapter contract

The configured origin can be HTTPS or loopback HTTP; control redirects are refused so the private key is not forwarded elsewhere. The coordinator never executes arbitrary provider shell callbacks. Implement these authenticated HTTP endpoints using `x-release-key`:

- `GET /__release/status`: return `commit` (null initially) and `runtime_fingerprint` matching the gated installed runtime.
- `POST /__release/apply`, JSON `{"commit":"FULL_SHA"}`: verify the sealed artifact, actually load that auth/API/assets release, and return its commit only after readiness. Preserve and stop old processes safely.
- `POST /__release/clear`, JSON `{}`: stop an unsuccessful initial runtime and return a null commit.
- Normal `/`, built asset, `/auth/*`, and `/api/*` routes must reflect the current runtime and preserve public privacy/cache headers.

Keep control endpoints private and authenticated; prevent unauthorized callers and serialize provider-side changes. Configure its artifact resolver to the same immutable store (or a verified equivalent object/image store). Supply a service-specific filesystem lock/shared release coordinator when more than one deploy host exists. TLS ingress, remote artifact distribution, provider credentials and actual CI attestation are adapter responsibilities, not domain-code changes.

## Local drill

After gating a baseline and advancing the selected integration branch, the opt-in command uses a newly created disposable database and real local adapter. It gates the successor, exercises old-application compatibility, actual activation, injected smoke-failure recovery, successful successor activation, rollback, preserved private data and artifact-tamper rejection. Standard operation tests also check missing-gate and wrong-main refusal.

```sh
RELEASE_DRILL_STORE=/private/disposable-release-store \
RELEASE_DRILL_FIRST=FULL_GATED_BASELINE_COMMIT \
RELEASE_DRILL_RUNTIME=/private/installed-runtime \
RECOVERY_TEST_DATABASE_URL=postgresql://LOCAL_TEST_ROLE@127.0.0.1:5432/postgres \
RELEASE_DRILL_REPORT=/private/sanitized-release-report.json \
.venv/bin/python -m unittest discover -s tests/operations -p test_release.py -v
```

The reproducible proof fixture uses branch `codex/manual-release` as the selected ref; production configuration uses its own authoritative protected main ref. Fixed application CI reserves ports 8000/3001/5173. Runtime smoke uses separate ephemeral ports. The disposable database and runtime processes are cleaned up; sealed local artifacts remain for inspection. Full-English capacity, real OTP delivery, production ingress/recovery/rollback and provider-resource measurements remain external launch checks. Synthetic capacity evidence remains explicitly synthetic.
