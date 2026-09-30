# 07 — Select and Move Holdings

**Label:** ready-for-agent

**Blocked by:** 04 — Add Holdings; 05 — Location tree

**Status:** ready-for-agent

**What to build:** A collector can select whole stacks, fanned copies, multiple Editions, or all Holdings in one leaf, then Move that physical selection to a different Storage Leaf as one all-or-nothing action.

- [ ] The Locations view shows temporary copy handles, selected copy and Edition counts, a destination sheet, and visible keyboard/touch controls. Valid desktop drag performs the same Move; invalid targets never mutate inventory.
- [ ] Stage large selections in bounded batches with one live manifest per owner, unique positive items, expected source versions, and one-hour expiry. The final set-based PostgreSQL transaction applies every quantity change or none, with no product-level Edition limit.
- [ ] Reject stale versions, insufficient quantities, same-leaf destinations, invalid targets, and cross-owner references with stable recovery responses. Failure preserves the browser selection.
- [ ] Serialize each owner's mutations, advance the owner revision, delete zero Holdings, and make uncertain retries safe with an item-free idempotency record.
- [ ] Browser/API/PostgreSQL tests cover multi-Edition selection, drag/control parity, two-tab races, replay, crash/transaction rollback, and a failed 25,000-Edition Move without partial changes.
