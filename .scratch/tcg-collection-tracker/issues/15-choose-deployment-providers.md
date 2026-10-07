# 15 — Choose deployment providers

**Label:** needs-info

**Blocked by:** 01 — Owner sign-in and Unsorted

**Status:** complete

**What to decide:** Select hosting and service providers after the application shell can be measured. The app remains deployable through replaceable HTTP, PostgreSQL, email, job, object-storage, and logging boundaries until this decision is made.

- [ ] Compare viable hosting, managed PostgreSQL, object storage, email delivery, background job, CI, and domain arrangements against measured startup, request resources, catalog-job runtime, public projection delivery, backup recovery, and the agreed load fixture.
- [ ] Show a same-origin secure-cookie path for React, Python/FastAPI, and Better Auth with an internal authenticated session-validation boundary.
- [ ] Show independent backup-age monitoring, private backups, public Deck projections without database wakeups, manual release after CI, compatible rollback, and owner-visible alerts.
- [ ] Record idle cost against the under-$10 target where feasible, expected variable costs, provider limits and 70% warning points, operational risks, and the owner's final provider decision before production provisioning.

## Local preparation — 2026-10-06

The owner confirmed local preparation only; production provisioning remains pending. [Local operations review and validation](../evidence/local-operations-review.md) records deployment topology, private snapshot/disposable restore tooling, and synthetic capacity measurements. These do not satisfy provider selection or production launch gates; acceptance checklists remain open.

## Owner scope decision — 2026-10-06

The owner directed provider-agnostic implementation and removal of provider selection as a blocker. Resolved by [ADR 0004](../../../docs/adr/0004-provider-agnostic-completion.md). The original provider comparison checklist is historical and does not represent completed provisioning or production proof. Production acceptance is tracked in [the launch checklist](../launch-checklist.md).
