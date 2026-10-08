# 18 — Public signup and owner walkthrough

**Label:** ready-for-agent

**Blocked by:** 17 — Manual release and owner-only launch

**Status:** complete

**What to build:** The owner can open registration to other collectors after verified email delivery and a successful desktop/mobile walkthrough of the owner-only app.

## Original production acceptance — moved to launch checklist

- [ ] Verify an owner-controlled sending domain with the chosen email provider and record real code delivery/sign-in for a recipient other than the owner before enabling public signup.
- [ ] Public signup atomically creates each account and Unsorted Storage Leaf; returning accounts use the same email-code flow. Preserve uniform code-request responses, durable rate limits, 30-day rolling sessions, and owner role binding to immutable ID.
- [ ] The owner completes desktop and mobile journeys for search, Add, Move, Undo, Deck check, publish, anonymous view, republish, and revoke; record outcomes and fix blocking mismatches.
- [ ] Re-run cross-owner privacy, public projection, sign-in burst, email failure, and release smoke checks against the public configuration. The owner panel stays unavailable to ordinary collectors.
- [ ] Record exact release commit, sender verification and real-recipient delivery, walkthrough, backup/restore freshness, load/cost evidence, and any explicitly accepted nonblocking deviations. Keep signup closed if a privacy, authorization, atomicity, integrity, recovery, or required performance/capacity gate fails.

## Revised implementation scope — 2026-10-06

Per owner instruction and [ADR 0004](../../../docs/adr/0004-provider-agnostic-completion.md), provider selection is no longer a blocking dependency. Complete executable vendor-neutral adapters and local acceptance evidence for this ticket. The original checklist above retains production requirements for historical traceability; those external acceptance gates are now tracked in [the launch checklist](../launch-checklist.md), not counted as local implementation evidence.

## Provider-independent completion criteria

- [x] A configurable real delivery adapter is exercised through HTTP/email protocol acceptance and failure tests without logging secrets or recipient payloads.
- [x] Explicit readiness configuration gates public signup closed by default; user/account, inventory owner and Unsorted creation are atomic.
- [x] Public-mode local regressions cover returning sessions, burst limits, delivery failures, cross-owner privacy and ordinary-user owner-panel denial.
- [x] Automated desktop/mobile journeys exercise the available application flows; actual owner walkthrough and real delivery remain separately tracked launch acceptance.

## Completion — 2026-10-07

Closed on `codex/mvp-integration` at application integration `bd33a95` under ADR 0004. [Completion and review evidence](../evidence/provider-agnostic-completion.md) records actual local checks and resolved findings. Provider adapters can be configured without changing domain logic. Production/public-launch evidence remains separately tracked and no production signup configuration was activated.
