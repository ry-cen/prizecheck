# 08 — Inventory Removal and Undo

**Label:** ready-for-agent

**Blocked by:** 07 — Select and Move Holdings

**Status:** in-progress

**What to build:** A collector can explicitly remove selected copies from tracked inventory and undo a recent Move or Inventory Removal from a short-lived list.

- [ ] Inventory Removal uses the same atomic staged selection and source-version checks as Move, with a concise confirmation and clear destination-free wording.
- [ ] Show the newest five eligible Moves or Removals. Each inverse payload expires exactly ten minutes after its action; expired payloads are removed on the next inventory action or daily maintenance, with no permanent movement ledger.
- [ ] Undo validates current quantities and Location state, applies its inverse atomically, advances the owner revision, and fails without overwriting incompatible later edits. An incompatible newest entry can be dismissed to reach an older one.
- [ ] Expired-but-present Undo returns the agreed expired state; physically deleted Undo is not found. Retries use idempotency keys without duplicating inventory changes.
- [ ] Browser/API/PostgreSQL tests cover Remove confirmation, multi-step Undo, exact expiry, incompatibility, zero balance deletion, concurrency, and worst-case payload storage.

## Implementation evidence

Implemented on `codex/mvp-08`: destination-free atomic Removal shares Move staging and source-version checks; bounded newest-five ten-minute inverse payloads, newest-first Undo, dismissal, compatible fungible Adds, owner lock, and idempotent replay. Migration `012_inventory_undo.sql` deletes expired payloads on revision changes. Daily maintenance should additionally delete expired inventory_undo rows.

Signed HTTP/PostgreSQL tests cover multi-step restore, zero balance deletion, replay/concurrency, newest eligibility, conflict/dismissal, cross-owner privacy, exact expiry and deletion distinction, and 25,000-Edition payload under 2 MB per inverse (under 10 MB for five). Web TypeScript passes. Removal confirmation/cancellation and visible Undo assertions are added to the existing Move browser test; browser gate remains pending integration validation.
