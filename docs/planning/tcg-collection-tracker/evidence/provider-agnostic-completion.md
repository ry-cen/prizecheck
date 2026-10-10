# Provider-agnostic MVP completion

Date: 2026-10-07. Integration branch: `codex/mvp-integration`. Final code integration: `bd33a95`. Starting application baseline: `a38c674`. Scope changed at the owner's explicit direction to remove provider selection as an implementation prerequisite (ADR 0004); no production services were provisioned.

## Implemented

Ticket 15 resolves the provider-neutral scope decision. Ticket 16 supplies private snapshot/object adapters, seven daily/four weekly retention, independent watchdog and restore commands, durable failure/alert state, sanitized owner health, and configurable 70% quota warnings. Ticket 17 supplies fixed credential-free exact-commit gating, sealed artifacts/runtime fingerprints, migration-prefix and previous-application compatibility, configured runtime activation, protected/public/assets smoke, failure recovery and compatible rollback. Ticket 18 supplies atomic account/Unsorted creation, real HTTP mail adapter, closed-by-default release-bound signup readiness and automated desktop/mobile journeys.

[Provider contracts](../../../provider-adapters.md) and configuration examples are committed. Switching provider adapters does not require edits to inventory/domain behavior. Generic relay contracts may need small translating adapters for a vendor's transport or consistency differences. Production launch is tracked in [the separate checklist](../launch-checklist.md).

## Validation

The combined application gate passed 80 API/PostgreSQL tests, 14 live authentication tests and 21 Chromium journeys, including a 390×844 mobile/touch journey; migrations, generated clients, TypeScript and build passed. One synthetic-capacity test is opt-in and was previously exercised separately. The full release drill passed exact gated candidate 77/13/20 plus operations checks and prior application 68/6/19 against the new schema, then real activation, injected smoke-failure recovery, rollback, retained private data and tamper rejection. Later isolated release-control changes passed four focused command/real-runtime checks; large already-proved drills were explicit skips. No blanket claim is made that the final merge SHA itself received a new full release attestation.

Detailed procedures, environment, expected/actual results and limitations: [mobile/release privacy](mobile-and-release-privacy.md), [portable release](portable-release.md), [earlier local recovery/capacity](local-operations-review.md), and [synthetic capacity](local-capacity.md). Tests use disposable local PostgreSQL and synthetic catalog/email fixtures. These are not full-English/provider performance or real-recipient proof.

## Standards

Three findings were resolved: local-public signup requires explicit development/test plus loopback origin; release-control/internal HTTP ignores environment proxies and refuses redirects; malformed control keys cannot appear in external exception logs. Independent focused re-review confirmed all resolutions. No actionable findings remain within the reviewed changes.

## Spec

Three findings were resolved: early backup/restore errors record durable owner-visible failure state; watchdog evaluation and backup completion share marker/state ownership; activation/rollback errors increment the release-failure panel count once. Independent re-review confirmed all resolutions. Automated mobile covers the revised ticket18 flow criterion; an actual owner walkthrough remains a launch task.

Six findings total (three per axis); all resolved. Original production acceptance checklists remain historical in tickets 16–18, while their revised provider-independent completion criteria are checked and statuses closed.
