# Verification

Run `npm run verify` for the required application, recovery and release-runtime regression gate. Supply `TEST_ADMIN_DATABASE_URL` as a loopback PostgreSQL URI with permission to create/drop disposable databases. The runner allocates its own database, six ports, copied workspace and private artifact directory; it removes its processes/database after the run. Installed Node/Python dependencies are reused; build output and test fixtures belong to the copied workspace. Concurrent runs have separate build output and logs.

The runner checks the current working-tree source, including staged changes. Git history is read only to build the historical runtime regression fixture; a fresh clone needs full history. The repository workflow checks this gate on pushes and pull requests. Making that job a protected-branch requirement remains repository-host configuration.

For a browser failure, rerun the same gate with the Playwright selector:

```sh
npm run verify -- --suite browser -- web/tests/moves.spec.ts
```

Each run prints its `.scratch/verification/<run>/` directory. `verification.log`, service logs, browser output and `result.json` stay there; failed runs retain the same diagnostics. These logs contain synthetic fixture data. The browser suite gives a shorter reproduction loop with its own services and build. Use the default full suite for acceptance; `--suite auth` and `--suite operations` isolate those checks for diagnosis.

The pre-commit hook runs staged Prettier, TypeScript/generated-contract checks and database-free privacy guardrails. Generated clients remain generator-owned and are excluded from formatting. The hook does not require a running database; the full gate belongs in CI.

Recovery, runtime readiness, activation/rollback/tamper, proxy-isolation, key-redaction and release-failure regressions run in the ordinary gate. Runtime fixtures are built in a temporary directory from repository history and current source. Their synthetic integrity receipts are test-only fixtures, not CI attestations or deployable releases. They never depend on artifacts left by an earlier agent session. The expensive exact-commit predecessor/successor release drill remains an explicit opt-in command documented in `docs/operations/release.md`; its skip is not a passing drill.

For changes to verification, also run `npm run guardrails`. Mechanical release-transport and exception-output rules live in `scripts/check_guardrails.py`; extending those rules requires positive and negative examples in `tests/tooling` rather than duplicating them in AGENTS.md.
