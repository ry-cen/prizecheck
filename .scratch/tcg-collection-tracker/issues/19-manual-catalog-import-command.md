# 19 — Control-panel catalog imports on demand

**Label:** ready-for-agent

**Blocked by:** 02 — First English catalog pull (complete)

**Status:** in-progress

**What to build:** Keep the owner-panel Start full English pull flow and replace the continuously polling catalog worker with one background import process launched per explicit request. Each process executes its supplied run ID and exits; no catalog worker runs between imports.

**Detailed spec:** [Control-panel catalog imports on demand](../proposals/manual-catalog-import.md)

**Decision:** [ADR 0003](../../../docs/adr/0003-on-demand-catalog-imports.md)

- [ ] Keep owner-only POST dispatch, generated client, and panel controls; return the run promptly while the child continues independently of browser and HTTP-request lifetime.
- [ ] Provide a fixed-argument Python launcher and child entry point using a server-generated run ID, independent database connection, safe output handling, and child reaping. The child survives a local API restart and exits after processing exactly one run.
- [ ] Serialize dispatch across API instances, preserve one active run, and allow a two-minute startup window. Repeat/concurrent starts return the same healthy active run without extra launches.
- [ ] Preserve runner session-lock ownership through fetch and publication; an old heartbeat alone cannot authorize overlap. Duplicate/delayed children revalidate their exact run after acquiring the lock and exit safely when superseded.
- [ ] Record dispatch failures with stable `CATALOG_DISPATCH_FAILED` and `503`; recover abandoned reservations or interrupted runs only on a subsequent explicit Start, preserving prior run history and any committed success.
- [ ] Preserve importer validation, bounded fetch/retries, review records, stable identities, private raw-generation retention, atomic publication/revision/result, and collector reads.
- [ ] Keep progress/result/last-success/review UI, including stale-heartbeat recovery guidance. Closing the browser and restarting the local API do not stop an import.
- [ ] Remove the permanent catalog worker and its startup instructions. Document host process-launch requirements; add no polling daemon, scheduler, broker, or worker container.
- [ ] PostgreSQL/process/browser tests cover authorization, prompt dispatch, concurrency/startup grace, launch failure, orphan recovery, delayed children, API restart, process exit, importer rollback, and committed-success consistency. Existing contract tests and the full CI gate pass.

## Comments

- 2026-10-03: Initial terminal-only draft was replaced at the owner's direction. Imports continue to start from Owner controls; the API launches an import process only when requested. Specification changes are recorded; runtime implementation is pending.
