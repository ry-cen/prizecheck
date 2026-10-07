# 16 — Backups, alerts, and owner status

**Label:** ready-for-agent

**Blocked by:** 15 — Choose deployment providers

**Status:** in-progress

**What to build:** The owner can see operational health and recover private data using the selected providers before trusting the app with production inventory.

- [ ] Daily logical PostgreSQL backups include user/auth, inventory, Deck, transfer, and publication data in private object storage, excluding rebuildable catalog and expired temporary payloads. Retain seven daily and four weekly copies; target a 24-hour recovery point.
- [ ] Restore a real backup into a disposable database monthly and verify row counts and key invariants. Document the restore procedure without relying on a production destructive test.
- [ ] An hourly watchdog independent of the backup scheduler flags a last-success marker older than 25 hours; an injected missed-backup condition reaches the owner panel and eligible email alert.
- [ ] The owner panel shows sign-in delivery/failures, authorization denials, API trends, catalog runs/review, backup age and restore result, public projection failures, and provider quota warnings. Logs omit OTPs, emails, tokens, private Location names, and card payloads.
- [ ] Warn at 70% of applicable provider allowances and show unavailable metrics as unverified. Job/release failures reach the owner through configured notifications or the panel before a verified sender domain exists.
- [ ] Integration tests cover backup creation, disposable restore, stale-marker detection, alert deduplication, panel authorization, and private/public storage separation.

## Local preparation — 2026-10-06

The owner confirmed local preparation only; production provisioning remains pending. [Local operations review and validation](../evidence/local-operations-review.md) records deployment topology, private snapshot/disposable restore tooling, and synthetic capacity measurements. These do not satisfy provider selection or production launch gates; acceptance checklists remain open.

## Revised implementation scope — 2026-10-06

Per owner instruction and [ADR 0004](../../../docs/adr/0004-provider-agnostic-completion.md), provider selection is no longer a blocking dependency. Complete executable vendor-neutral adapters and local acceptance evidence for this ticket. The original checklist above retains production requirements for historical traceability; those external acceptance gates are now tracked in [the launch checklist](../launch-checklist.md), not counted as local implementation evidence.

## Provider-independent completion criteria

- [ ] A configurable private-object adapter backs real logical snapshots, with seven daily/four weekly retention and durable success/failure state.
- [ ] Separate backup and watchdog commands demonstrate stale detection after 25 hours and deduplicated alerts without sharing a scheduler lifetime.
- [ ] Owner-only operational status reports sanitized delivery, denial/API, import/review, backup/restore and public-projection health; quotas warn at 70% or explicitly remain unverified.
- [ ] Disposable PostgreSQL/process/HTTP/storage tests demonstrate backup, restore, retention, stale alerts, authorization and storage separation.
