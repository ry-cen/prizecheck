# 08 — Inventory Removal and Undo

**Label:** ready-for-agent

**Blocked by:** 07 — Select and Move Holdings

**Status:** complete

**What to build:** A collector can explicitly remove selected copies from tracked inventory and undo a recent Move or Inventory Removal from a short-lived list.

- [x] Inventory Removal uses the same atomic staged selection and source-version checks as Move, with a concise confirmation and clear destination-free wording.
- [x] Show the newest five eligible Moves or Removals. Each inverse payload expires exactly ten minutes after its action; expired payloads are removed on the next inventory action or daily maintenance, with no permanent movement ledger.
- [x] Undo validates current quantities and Location state, applies its inverse atomically, advances the owner revision, and fails without overwriting incompatible later edits. An incompatible newest entry can be dismissed to reach an older one.
- [x] Expired-but-present Undo returns the agreed expired state; physically deleted Undo is not found. Retries use idempotency keys without duplicating inventory changes.
- [x] Browser/API/PostgreSQL tests cover Remove confirmation, multi-step Undo, exact expiry, incompatibility, zero balance deletion, concurrency, and worst-case payload storage.

## Implementation evidence

Implemented on `codex/mvp-08`: destination-free atomic Removal shares Move staging and source-version checks; bounded newest-five ten-minute inverse payloads, newest-first Undo, dismissal, compatible fungible Adds, owner lock, and idempotent replay. Migration `012_inventory_undo.sql` deletes expired payloads on revision changes. Daily maintenance should additionally delete expired inventory_undo rows.

Signed HTTP/PostgreSQL tests cover multi-step restore, zero balance deletion, replay/concurrency, newest eligibility, conflict/dismissal, cross-owner privacy, exact expiry and deletion distinction, and 25,000-Edition payload under 2 MB per inverse (under 10 MB for five). Web TypeScript passes. Removal confirmation/cancellation and visible Undo assertions are added to the existing Move browser test; browser gate remains pending integration validation.

## Final integration validation — 2026-10-06

Closed on `codex/mvp-integration` after the combined gate at `859f2aa`: 68 API/PostgreSQL tests, six live authentication tests, and 19 Chromium browser tests passed, along with migrations, generated contracts, TypeScript and build. Independent Standards/Spec review findings are resolved. See [integration evidence](../evidence/integration-validation.md) and [review resolutions](../evidence/code-review.md). Production provider, capacity and launch proof remains tracked by tickets 15–18; this closure records application implementation and local validation.
