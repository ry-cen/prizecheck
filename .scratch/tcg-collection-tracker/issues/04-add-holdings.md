# 04 — Add Holdings

**Label:** ready-for-agent

**Blocked by:** 01 — Owner sign-in and Unsorted; 03 — Collector catalog search

**Status:** complete

**What to build:** A collector can choose a Card Edition from search and Add a positive quantity to Unsorted or another owned Storage Leaf, then see one accurate Holding in that leaf.

- [x] Add accepts an active Edition, owned Storage Leaf, positive decimal-string 64-bit quantity, and idempotency key; repeated Adds increment one Holding rather than fragmenting quantities.
- [x] A zero result never persists, overflow and nonpositive quantities fail safely, and tombstoned Editions cannot receive a new Add. Cross-owner or nonexistent leaves disclose no private state.
- [x] The Locations view shows a dense thumbnail stack with quantity and accessible details for Printing, Edition, and Location. Keyboard and touch controls can Add without hover or drag.
- [x] Mutations lock the owner, advance the inventory revision, and retain an item-free request digest for uncertain retries. A replay never doubles inventory.
- [x] Browser/API/PostgreSQL tests cover duplicate Add, concurrent Adds, failure rollback, tombstones, quantity boundaries, and two-owner isolation.

## Comments

- Implemented with `006_add_holdings.sql`, `008_mutation_request_item_free.sql`, `009_add_response_cache.sql`, the Holdings API/read model, generated client, and Locations panel. A separate 24-hour numeric response cache preserves the original Add response across later mutations while the mutation-request record remains item-free. Integrated CI passed: 19 API, 5 auth, and 7 browser tests before the response-cache follow-up; focused Holdings PostgreSQL tests pass after it.
