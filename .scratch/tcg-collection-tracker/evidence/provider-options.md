# Deployment evidence — provider decision pending

Date: 2026-10-05. The owner requested application implementation and evidence preparation while keeping production provisioning pending. Ticket 15 remains needs-info until measured application evidence and the owner's final provider choice are recorded. No production services were provisioned.

## Runtime constraint

ADR 0003 requires an on-demand process/job that survives API-process restart. A small Linux host supports detached Python children, FastAPI, Better Auth, and a same-origin reverse proxy directly. An edge-only deployment needs an equivalent external job launcher and validated Python/runtime compatibility; the earlier Workers topology is superseded by ADR 0002.

## Initial options and costs

These are candidate arrangements, not selected providers or a proven launch budget. Quotes checked against primary sources on the date above; taxes, domain registration, IPv4, backups outside allowances, and variable usage require separate accounting.

| Boundary | Candidate and primary source | Evidence / decision still required |
| --- | --- | --- |
| Runtime | [Hetzner pricing adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) quotes EU CX23 at $6.49/month excluding IPv4 and VAT | Availability, region latency, startup/resources, administration and patching; this is a runtime base cost only |
| PostgreSQL | [Neon Free storage announcement](https://neon.com/blog/neon-free-plan-1-gb-per-project) states 1 GB/project; [usage pricing](https://neon.com/blog/new-usage-based-pricing) describes scale-to-zero and 50 CU-hours Free allowance | Full catalog + five extreme Undo payloads + indexes/auth must fit; measure cold/warm latency, egress and monthly active compute |
| Objects | [R2 Standard pricing](https://developers.cloudflare.com/r2/pricing/) includes 10 GB-month, 1 million Class A and 10 million Class B requests/month and free internet egress | Validate private backups, atomic public projections/revoke/discovery and provider consistency; warning thresholds 7 GB, 700k A, 7m B |
| Email | [Resend Free tier](https://resend.com/blog/new-free-tier) describes 3,000/month and 100/day | Sending-domain verification, real owner and non-owner delivery, failure alerts; warnings at 2,100/month and 70/day; configure send cap below actual allowance |
| CI / domain / logs | Unselected | CI exact-commit credential-free gate, domain ownership/TLS, log retention, sanitized operational alerts and allowance metrics |

The runtime + within-allowance managed database/object/email candidates suggest a base below $10/month, but do not establish total cost or launch readiness. Compare actual measured workload with current provider allowances before the owner's decision. A self-hosted PostgreSQL alternative avoids managed-compute billing but adds database operations and recovery responsibilities; it does not satisfy the ticket's managed-PostgreSQL comparison without a recorded decision.

## Evidence required before closing ticket 15

Record full English source generation size, 1,000-account fixture, 200 monthly active users, one 25,000-Holding collector, five worst-case Undo payloads, and 10,000 monthly anonymous views. Measure request resources, catalog job runtime, cold/warm timings, query plans, database bytes, public reads without PostgreSQL, disposable restores, independent backup watchdog, and compatible rollback. Local timings do not prove provider performance or cost. Missing provider metrics remain unverified.
