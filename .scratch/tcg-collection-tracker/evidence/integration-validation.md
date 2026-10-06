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

Pending implementation, full gate and independent Standards/Spec review. Baseline evidence does not close any remaining MVP ticket.

## Production gates

Provider selection/provisioning, real full English source import, provider-scale performance/capacity/cost measurements, private remote backup and disposable recovery, independent missed-backup notification, exact-release deployment/rollback, verified sending domain and real-recipient delivery, and the owner's desktop/mobile walkthrough remain pending. Public signup must remain closed until those gates are proved.
