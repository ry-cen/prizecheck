# 17 — Manual release and owner-only launch

**Label:** ready-for-agent

**Blocked by:** 02 — First English catalog pull; 03 — Collector catalog search; 04 — Add Holdings; 05 — Location tree; 06 — Safe Location conversion and deletion; 07 — Select and Move Holdings; 08 — Inventory Removal and Undo; 09 — Collection totals and distribution; 10 — Physical Decks and checks; 11 — Unlisted Deck publishing; 12 — Listed Deck discovery; 13 — Missing-card reports and approval; 14 — Safe catalog refresh and reconciliation; 15 — Choose deployment providers; 16 — Backups, alerts, and owner status

**Status:** ready-for-agent

**What to build:** The owner can manually release the completed MVP after CI passes, verify it in an owner-only production environment, and roll it back if needed.

- [ ] A credential-free gate verifies that the exact selected main commit passed required Python/TypeScript, browser/HTTP/PostgreSQL/job/object-storage, generated-contract, build, and migration-compatibility checks before a dependent secret-bearing deploy step runs.
- [ ] Releases serialize, apply backward-compatible migrations, deploy compatible auth/API/assets, smoke-test protected and public routes, and retain a previous compatible release for a tested rollback without destructive migration reversal.
- [ ] Owner-only account creation and real owner OTP delivery pass. Record first full English pull, privacy serialization, cross-owner not-found behavior, failed-transfer rollback, real disposable backup restore, missed-backup alert, and release rollback drills.
- [ ] At the agreed fixture (1,000 accounts, 200 monthly active users, full English catalog, one 25,000-Holding collector, five worst-case Undo payloads, and 10,000 public views/month), report cold/warm timings, query plans, transaction duration, database bytes, provider usage, and under-$10 idle-cost arithmetic.
- [ ] At fixture scale, 95% of warmed Collection/Location pages finish within two seconds and ordinary inventory actions within five seconds; a 25,000-Edition Move finishes within two minutes from pressing Move with progress and no partial change. Improve or upgrade constrained components rather than impose a count cap or weaken atomicity.
- [ ] Each proof records fixture, environment, procedure, expected/actual result, date, and sanitized artifact location. Privacy, authorization, atomicity, integrity, backup recovery, and required performance/capacity failures block launch.
