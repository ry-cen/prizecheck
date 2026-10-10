# Verification

Run `npm run verify` for the required application, recovery and release-runtime regression gate. Supply `TEST_ADMIN_DATABASE_URL` as a loopback PostgreSQL URI with permission to create/drop disposable databases. The runner copies the working tree, allocates its own databases, ports and private artifact directory, and removes its processes and databases after the run. Installed Node/Python dependencies are reused; build output and test fixtures belong to the copied workspace. Runs have separate build output and logs, but run one gate at a time on one host: a gate already uses most of the host's cores, and a second gate's load would reach the tests that must run alone. Keep the host awake for the whole run (on power, lid open): the runner holds off idle sleep with `caffeinate` where it exists, but a sleeping host stops the tests' processes while wall-clock time runs on, and Docker's database clock lags the host's after a wake. When that happens `verification.log` ends with a `== WARNING:` line and `result.json` records `host_suspended_seconds` and `database_clock_skew_seconds`; timing and approval-code expiry failures from such a run are not evidence, so rerun it.

The runner checks the current working-tree source, including staged changes. Git history is read only to build the historical runtime regression fixture; a fresh clone needs full history. The repository workflow checks this gate on pushes and pull requests. Making that job a protected-branch requirement remains repository-host configuration.

## Loops

| Command                                                       | Runs                                                                               | Enough for                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `npm run verify -- --suite api -- <pytest selectors>`         | the selected `api/tests` tests; without selectors all of `api/tests`, nothing else | iterating on API code and its tests           |
| `npm run verify -- --suite browser -- <Playwright selectors>` | the selected Playwright specs against fresh stacks                                 | reproducing a browser failure                 |
| `npm run verify -- --fast`                                    | the whole gate without `slow` pytest tests and `@slow` Playwright tests            | a worker's check before handing a change back |
| `npm run verify`                                              | everything                                                                         | acceptance; CI runs this                      |

```sh
npm run verify -- --suite api -- api/tests/test_prices.py -k stale
npm run verify -- --suite browser -- web/tests/moves.spec.ts
```

API selectors are pytest node ids, paths and options such as `-k`, `-x` or `--lf`; the runner sets `-m`, `-n`, `-p` and `--dist` itself. Browser selectors are spec files or `file:line` locations. `--fast` combines with `--suite api` and `--suite browser`. A bare `pytest <nodeid>` does not work for most API tests: they need the gate's migrated database and environment. `npm run test:fast` is unchanged: it is the guardrails-only check the pre-commit hook runs, not the fast tier.

The narrow and fast loops are for iteration. A ticket's final acceptance runs the full default gate once, and the ticket evidence quotes the counts from that run's `verification.log` summary.

## Parallelism and tiers

pytest runs in two passes. The first runs every test not marked `serial` with pytest-xdist, one worker per prepared database; `--dist loadfile` keeps each file's tests together and in order. Each worker has its own database, projection directory, runner lock directory, catalog fixture directory and mail file (`scripts/verify_resources.py`, applied by `api/tests/conftest.py`). The second pass runs the `serial` tests in one process with nothing else running.

- Mark a test `serial` when it asserts an upper bound on elapsed time or a latency percentile, or launches real runner processes. Tickets that add price or budget tests with elapsed-time bounds mark them `serial`.
- Mark a test `slow` when it launches real processes, waits out real wall-clock intervals, sleeps a second or more, or builds a capacity-sized data set.
- Both marks take a `reason`; a `slow` reason starts with `process:`, `wall-clock:`, `capacity:` or `sleep:`. `scripts/check_guardrails.py` checks the reasons and requires both marks on tests that use the `proc` runner fixture.

Playwright runs one application stack per worker: its own database, API, auth and web servers, mail file, projection, runner lock and catalog fixture directories. `web/tests/support/browser-stack.ts` points each worker at its stack, so specs in different workers never share data; the tests of one file still run in order in one worker. Tests tagged `@serial` run afterwards with one worker and say why in a comment; `price-refresh.spec.ts` is serial because its label depends on a real runner's deadline inside the server's wait window. Tests tagged `@slow` say their category in a comment.

Worker counts follow the host: pytest `min(6, max(2, cores / 2))`, browser stacks `min(4, max(2, cores / 3))`. `--pytest-workers N` and `--browser-workers N` override them; `1` runs that suite in one process as before.

Timing tests use real time only where they say why. The hard-stop and SIGSTOP runner scenarios scale the runner's contract constants through the test sitecustomize (see `docs/price-refresh.md`); the cold-start measurement and the idle-exit checks keep real time. Vitest (`auth/tests`) is not tiered: the fast tier still runs all of it.

## Artifacts

Each run prints its `.scratch/verification/<run>/` directory. It holds:

- `verification.log`, ending with a summary: phase seconds, pytest and Playwright totals over both passes, and the slowest tests;
- service logs: `api.log`, `auth.log` and `web.log` for the first stack, `stack-<n>/` for the others;
- `browser/parallel/` and `browser/serial/` (Playwright output), `playwright-parallel.json`, `playwright-serial.json`;
- `pytest-parallel.xml`, `pytest-serial.xml` (per-test times), `phases.tsv`, `timings.md`, `timings.json`;
- `result.json`: exit code, suite, selectors, `fast`, worker counts, databases, timings.

Read counts from `verification.log`, not from the exit code. Failed runs keep the same diagnostics. These logs contain synthetic fixture data. `--suite auth` and `--suite operations` isolate those checks for diagnosis.

The pre-commit hook runs staged Prettier, TypeScript/generated-contract checks and database-free privacy guardrails. Generated clients remain generator-owned and are excluded from formatting. The hook does not require a running database; the full gate belongs in CI.

Recovery, runtime readiness, activation/rollback/tamper, proxy-isolation, key-redaction and release-failure regressions run in the ordinary gate. Runtime fixtures are built in a temporary directory from repository history and current source. Their synthetic integrity receipts are test-only fixtures, not CI attestations or deployable releases. They never depend on artifacts left by an earlier agent session. The expensive exact-commit predecessor/successor release drill remains an explicit opt-in command documented in `docs/operations/release.md`; its skip is not a passing drill.

For changes to verification, also run `npm run guardrails`. Mechanical release-transport, exception-output, process-scope and test-tier rules live in `scripts/check_guardrails.py`; extending those rules requires positive and negative examples in `tests/tooling` rather than duplicating them in AGENTS.md. Harness logic has unit tests in `tests/tooling/test_verify_harness.py`.
