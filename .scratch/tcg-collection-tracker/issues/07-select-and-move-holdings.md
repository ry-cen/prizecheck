# 07 — Select and Move Holdings

**Label:** complete

**Blocked by:** 04 — Add Holdings; 05 — Location tree

**Status:** complete

**What to build:** A collector can select whole stacks, fanned copies, multiple Editions, or all Holdings in one leaf, then Move that physical selection to a different Storage Leaf as one all-or-nothing action.

- [x] The Locations view shows temporary copy handles, selected copy and Edition counts, a destination sheet, and visible keyboard/touch controls. Valid desktop drag performs the same Move; invalid targets never mutate inventory.
- [x] Stage large selections in bounded batches with one live manifest per owner, unique positive items, expected source versions, and one-hour expiry. The final set-based PostgreSQL transaction applies every quantity change or none, with no product-level Edition limit.
- [x] Reject stale versions, insufficient quantities, same-leaf destinations, invalid targets, and cross-owner references with stable recovery responses. Failure preserves the browser selection.
- [x] Serialize each owner's mutations, advance the owner revision, delete zero Holdings, and make uncertain retries safe with an item-free idempotency record.
- [x] Browser/API/PostgreSQL tests cover multi-Edition selection, drag/control parity, two-tab races, replay, crash/transaction rollback, and a failed 25,000-Edition Move without partial changes.

## Comments

- 2026-09-30: Added owner-scoped short-lived Move manifests, bounded staging batches, atomic set-based transfer, item-free replay records, and visible selection/destination/drag controls. Five focused PostgreSQL API tests passed, including a failed 25,000-Edition transaction with no partial changes. The focused browser test passed with keyboard/touch controls and desktop drag to the same destination. TypeScript and generated-client checks passed. The integrated CI gate and independent code review run with issue 06 are handled at the parent task.
- 2026-10-01: Review found that stale selections could not be refreshed and drag required opening the destination sheet. Added selection refresh with current source versions, direct drop on valid Location tree leaves, and progress while loading or staging large selections. The browser test now covers stale recovery and direct tree drag. The full gate passed: 32 API, 5 auth, and 9 browser tests. The two-minute 25,000-Edition throughput measurement remains in the owner-only launch gate (17).
