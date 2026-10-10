# Mobile journey and release review validation

Date:2026-10-07. Local macOS/PostgreSQL16 development environment; synthetic catalog/private fixtures only. No provider was provisioned and no real sending-domain, recipient or owner walkthrough claim is made.

## Application journey

Procedure: `DATABASE_URL=postgresql://raian@127.0.0.1:55432/tcg_projection_adapter scripts/ci.sh` in the mobile-journey worktree, based on integration `067f292` with the added mobile test. Expected migrations/generated contracts/TypeScript/build and all API/auth/browser journeys pass. Actual:80 API tests passed (55.82s), one explicit capacity test skipped;14 auth tests passed (8.19s);21 Chromium journeys passed (57.1s). All build/contract checks passed and harness-owned processes were cleaned up. Suite durations are not performance criteria measurements.

The new390×844 Chromium mobile/touch journey passed in4.5s. It signs in, searches an exact Edition, Adds physical Holdings, chooses a Move destination without dragging, Undoes the Move, checks Deck counts, publishes an Unlisted snapshot, views it anonymously without private access, changes private Holdings, deliberately republishes, and permanently revokes. This is automated browser emulation; the actual owner's desktop/mobile walkthrough remains a separate launch check.

## Release privacy and failure visibility

Subsequent release-only review changes were checked at the CLI/PostgreSQL/real-HTTP seams, without repeating unrelated application journeys. A real local proxy trap reproduced control-key leakage before the fix. The shared direct HTTP transport now bypasses environment proxies for control, readiness, smoke and runtime auth forwarding and refuses redirects. Fixed operator errors and printable-ASCII key validation prevent malformed header values from reaching logs.

Procedure: `RELEASE_SECURITY_FIXTURE_STORE=/tmp/tcg-portable-releases-v2 RECOVERY_TEST_DATABASE_URL=postgresql://raian@127.0.0.1:55432/postgres .venv/bin/python -m unittest discover -s tests/operations -p test_release.py -v`. Four tests passed; the two larger explicit release drills were skipped here because their earlier successful evidence is already recorded in portable-release.md. The retained sealed baseline/successor artifacts were read through isolated private links, with a fresh disposable database and ephemeral real FastAPI/Better Auth/runtime ports. Proxy traps received neither control keys nor the runtime's synthetic cookie/OTP payloads. A malformed newline-containing key was rejected without its value appearing in CLI stderr; one durable release failure was recorded. An older schema lacking the status table reported recording as unavailable and retained the primary failure. All created processes/databases were cleaned up.

The focused owner HTTP-status regression also passed: a failed activation command increments the release-failure panel count exactly once. Credential-free gate failures do not connect to the deployment database for status recording. Production activation/rollback, provider transport and actual CI provenance remain separate acceptance checks.
