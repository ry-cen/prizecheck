# 18 — Public signup and owner walkthrough

**Label:** ready-for-agent

**Blocked by:** 17 — Manual release and owner-only launch

**Status:** ready-for-agent

**What to build:** The owner can open registration to other collectors after verified email delivery and a successful desktop/mobile walkthrough of the owner-only app.

- [ ] Verify an owner-controlled sending domain with the chosen email provider and record real code delivery/sign-in for a recipient other than the owner before enabling public signup.
- [ ] Public signup atomically creates each account and Unsorted Storage Leaf; returning accounts use the same email-code flow. Preserve uniform code-request responses, durable rate limits, 30-day rolling sessions, and owner role binding to immutable ID.
- [ ] The owner completes desktop and mobile journeys for search, Add, Move, Undo, Deck check, publish, anonymous view, republish, and revoke; record outcomes and fix blocking mismatches.
- [ ] Re-run cross-owner privacy, public projection, sign-in burst, email failure, and release smoke checks against the public configuration. The owner panel stays unavailable to ordinary collectors.
- [ ] Record exact release commit, sender verification and real-recipient delivery, walkthrough, backup/restore freshness, load/cost evidence, and any explicitly accepted nonblocking deviations. Keep signup closed if a privacy, authorization, atomicity, integrity, recovery, or required performance/capacity gate fails.
