# 17 — Manual release and owner-only launch

**Label:** ready-for-agent

**Blocked by:** 02 — First English catalog pull; 03 — Collector catalog search; 04 — Add Holdings; 05 — Location tree; 06 — Safe Location conversion and deletion; 07 — Select and Move Holdings; 08 — Inventory Removal and Undo; 09 — Collection totals and distribution; 10 — Physical Decks and checks; 11 — Unlisted Deck publishing; 12 — Listed Deck discovery; 13 — Missing-card reports and approval; 14 — Safe catalog refresh and reconciliation; 15 — Choose deployment providers; 16 — Backups, alerts, and owner status

**Status:** complete

**What to build:** The owner can manually release the completed MVP after CI passes, verify it in an owner-only production environment, and roll it back if needed.

## Original production acceptance — moved to launch checklist

- [ ] A credential-free gate verifies that the exact selected main commit passed required Python/TypeScript, browser/HTTP/PostgreSQL/job/object-storage, generated-contract, build, and migration-compatibility checks before a dependent secret-bearing deploy step runs.
- [ ] Releases serialize, apply backward-compatible migrations, deploy compatible auth/API/assets, smoke-test protected and public routes, and retain a previous compatible release for a tested rollback without destructive migration reversal.
- [ ] Owner-only account creation and real owner OTP delivery pass. Record first full English pull, privacy serialization, cross-owner not-found behavior, failed-transfer rollback, real disposable backup restore, missed-backup alert, and release rollback drills.
- [ ] At the agreed fixture (1,000 accounts, 200 monthly active users, full English catalog, one 25,000-Holding collector, five worst-case Undo payloads, and 10,000 public views/month), report cold/warm timings, query plans, transaction duration, database bytes, provider usage, and under-$10 idle-cost arithmetic.
- [ ] At fixture scale, 95% of warmed Collection/Location pages finish within two seconds and ordinary inventory actions within five seconds; a 25,000-Edition Move finishes within two minutes from pressing Move with progress and no partial change. Improve or upgrade constrained components rather than impose a count cap or weaken atomicity.
- [ ] Each proof records fixture, environment, procedure, expected/actual result, date, and sanitized artifact location. Privacy, authorization, atomicity, integrity, backup recovery, and required performance/capacity failures block launch.

## Local preparation — 2026-10-06

The owner confirmed local preparation only; production provisioning remains pending. [Local operations review and validation](../evidence/local-operations-review.md) records deployment topology, private snapshot/disposable restore tooling, and synthetic capacity measurements. These do not satisfy provider selection or production launch gates; acceptance checklists remain open.

## Revised implementation scope — 2026-10-06

Per owner instruction and [ADR 0004](../../../docs/adr/0004-provider-agnostic-completion.md), provider selection is no longer a blocking dependency. Complete executable vendor-neutral adapters and local acceptance evidence for this ticket. The original checklist above retains production requirements for historical traceability; those external acceptance gates are now tracked in [the launch checklist](../launch-checklist.md), not counted as local implementation evidence.

## Provider-independent completion criteria

- [x] A fixed credential-free gate builds and checks an immutable exact-main commit, seals artifacts and rejects altered artifacts or caller-supplied success.
- [x] A configurable runtime adapter participates in serialized activation, protected/public/assets smoke, and compatible previous-release rollback. Missing configuration fails closed.
- [x] Migration prefix and previous-application compatibility are exercised against candidate schema without destructive migration reversal.
- [x] Local release and rollback drills record actual fixture, procedure, expected/actual outcome and gaps; representative load evidence remains labeled synthetic.

## Completion — 2026-10-07

Closed on `codex/mvp-integration` at application integration `bd33a95` under ADR 0004. [Completion and review evidence](../evidence/provider-agnostic-completion.md) records actual local checks and resolved findings. Provider adapters can be configured without changing domain logic. Production/public-launch evidence remains separately tracked and no production signup configuration was activated.
