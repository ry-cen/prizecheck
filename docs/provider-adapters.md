# Plugging in deployment providers

Provider selection is configuration and adapter work. Domain logic remains independent of vendors. The bundled filesystem/local-runtime adapters support development and portable drills; remote adapters must satisfy the same contracts before launch. No vendor is selected by this repository.

| Capability | Configuration / interface | Required behavior |
| --- | --- | --- |
| PostgreSQL | `DATABASE_URL` | PostgreSQL schema/transactions, constraints and advisory locks. Publication/import writer connections retain session ownership across commits; use session-capable connections for those jobs. |
| Sign-in email | `MAIL_MODE=http`, `MAIL_RELAY_URL`, `MAIL_RELAY_TOKEN`, `MAIL_FROM` | Authenticated relay accepts `{from,to,subject,text}` or translates it to the chosen provider. Errors/timeouts reject delivery, and recipient/code data stay out of logs. See [email/signup](signup-readiness.md). |
| Public projections | `PUBLIC_PROJECTION_ADAPTER=http`, `PUBLIC_PROJECTION_URL`, `PUBLIC_PROJECTION_TOKEN` | Linearizable manifest GET/conditional PUT with strong ETags, no cached anonymous reads, atomic visibility/revocation. See [projection contract](http-public-projection.md). |
| Private backups | `BACKUP_STORE_FACTORY=module:factory` or `BACKUP_PRIVATE_DIR` | Private atomic put/get/list/delete adapter, isolated from public storage, upload read-back verification. See [jobs/storage](operations/portable-jobs.md). |
| Scheduling | Invoke documented backup/watchdog/restore commands independently | Durable daily/hourly/monthly invocation; watchdog lifetime independent of backup scheduling. Record outcomes through the existing operations interface. |
| Quotas/usage | `operations_job.py quota` | Supply observed use and actual allowance; 70% warnings, missing/stale values unverified. |
| Imports | Exact-run process launcher | Detached child survives API restart, retains database ownership and exits after one requested run; translate process launching if the host requires managed jobs. |
| Runtime/releases | Release runtime adapter | Activate exact verified artifacts, report active revision, serve protected/public/assets smoke paths, restore a compatible prior release after failure. See release tooling documentation. |
| TLS/static/auth routing | Same-origin reverse proxy | Serve built assets and SPA routes; gateway owns auth/API ingress, FastAPI private, trusted proxy headers rewritten. See [topology](deployment-boundaries.md). |

Relay endpoints are explicit application protocols, not an assertion that every vendor's API has the same envelope or semantics. A translating adapter can supply the contract while credentials and provider-specific behavior stay outside domain modules. Do not point a public CDN at private backups or publication command history.

Connect one capability at a time, run its integration contracts against a disposable environment, then record deployment-specific evidence in [the launch checklist](../.scratch/tcg-collection-tracker/launch-checklist.md). Enabling production public signup requires a release-bound operator readiness attestation; code completion does not manufacture domain verification, real-recipient delivery, recovery, capacity, or owner walkthrough evidence.
