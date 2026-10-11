# Launch catalog import processes on demand

**Status:** accepted; implemented and locally integration-validated; production validation pending.

The owner retains Start full English pull in the control panel. An authenticated API request reserves one durable catalog run and launches one detached Python process for that run ID. The process saves progress and outcome, performs the existing validated atomic import, and exits. There is no continuously running catalog worker polling for jobs.

PostgreSQL serializes dispatch and runner ownership. Repeated requests return the active run. Abandoned runs recover on the next explicit owner request after the startup window and exclusive-ownership checks; stale heartbeats alone do not permit overlapping imports.

This refines the execution behavior of ticket 02 and preserves the owner-panel and browser-independent import requirements. It replaces the terminal-only proposal. It does not alter catalog identity, review, retention, or publication safeguards.

Local execution requires a host that supports detached Python subprocesses independent of the API request and process lifetime. Eventual hosting must provide that capability or an equivalent on-demand job launcher. [ADR 0002](0002-defer-deployment-provider-selection.md) continues to defer provider selection.

See the [detailed spec](../planning/tcg-collection-tracker/proposals/manual-catalog-import.md) and [ticket 19](https://github.com/ry-cen/prizecheck/issues/34).
