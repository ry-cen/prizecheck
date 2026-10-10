# MVP integration validation

Date: 2026-10-05. Integration branch: `codex/mvp-integration`. Starting application commit: `a38c674`.

## Baseline

Environment: macOS local development host, PostgreSQL 16 service at loopback port 55432; new disposable database `tcg_mvp`; existing repository Node/Python dependencies. No production data or services involved.

Procedure: `DATABASE_URL=postgresql://raian@127.0.0.1:55432/tcg_mvp scripts/ci.sh`.

Expected: migration/generated-contract/TypeScript/build gates and all existing API, auth and browser tests pass.

Actual: passed; 32 API/PostgreSQL tests, five Better Auth tests, nine Chromium browser tests. API suite 15.42s, auth suite 4.94s, browser suite 17.6s. These are suite durations, not product latency measurements. Vite build succeeded. Existing FastAPI TestClient emits a Starlette/httpx deprecation warning.

## Intermediate integration — inventory and Unlisted publishing

At integration d133845 plus navigation/client/gate wiring, the same disposable-database gate passed 48 API/PostgreSQL tests, five auth tests, and all 12 Chromium journeys (25.1s). TypeScript, generated clients and build passed. Browser verification includes Collection totals/distribution, Deck counts and physical moves, Removal confirmation/cancellation/Undo, and anonymous snapshot/republish/revoke. A failed gate exposed optional undefined filter serialization and ambiguous test selectors; these were fixed before the passing rerun. Test services now run as directly owned processes with explicit port/start checks and cleanup, and API access logs are disabled to keep published tokens out of logs.

## Final integration

Date: 2026-10-06. Tested code commit: `859f2aa` on `codex/mvp-integration`. The procedure above passed migrations through 018, every generated-client check, TypeScript and Vite build, 68 API/PostgreSQL tests (29.93s), six live Better Auth tests (5.46s), and all 19 Chromium browser tests (45.6s). Suite durations are not product latency measurements. Deterministic catalog fixtures exercise real detached import processes; this is not evidence of a full live English catalog import or provider object-storage deployment.

Independent Standards and Spec reviews against `a38c674` identified five findings; all were fixed and independently rechecked. See [review resolutions](code-review.md). Application tickets 08–12, 14 and 19 are closed; production tickets 15–18 remain pending by owner instruction. Test services were cleaned up, and task-created implementation worktrees were removed. The existing PostgreSQL service was preserved.

## Production gates

Provider selection/provisioning, real full English source import, provider-scale performance/capacity/cost measurements, private remote backup and disposable recovery, independent missed-backup notification, exact-release deployment/rollback, verified sending domain and real-recipient delivery, and the owner's desktop/mobile walkthrough remain pending. Public signup must remain closed until those gates are proved.
