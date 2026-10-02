# 06 — Safe Location conversion and deletion

**Label:** ready-for-agent

**Blocked by:** 04 — Add Holdings; 05 — Location tree

**Status:** complete

**What to build:** A collector can reorganize a stocked leaf without losing Holdings and can delete only an empty childless Location.

- [x] When adding a first child beneath a stocked leaf, offer atomic choices to move its Holdings into the named child, create a separate Unsorted child for them, or cancel.
- [x] When reparenting beneath a stocked destination leaf, offer an atomic Unsorted child for destination Holdings or cancel. Failed conversion leaves the original tree and Holdings intact.
- [x] Reject Deck parents, cycles, depth overflow, duplicate sibling names, and cross-owner references in the same transaction as conversion. Removing the final child makes its former ordinary parent an empty Storage Leaf.
- [x] Delete requires named confirmation and succeeds only for an empty childless Location; the Unsorted root may be renamed, moved, or deleted only when empty.
- [x] Browser/API/PostgreSQL tests cover both stocked-leaf choices, cancel and injected failure, concurrent edits, nonrecursive deletion, and cross-owner isolation.

## Implementation notes

Conversion and deletion use the owner inventory lock, displayed Location versions, and one transaction. A conversion updates the moved Holdings' versions and advances the owner inventory revision. An empty Unsorted root stays deleted after later reads. Verified by the integrated CI run: 32 API tests and the Location conversion Chromium journey passed. Focused Location and onboarding tests passed (12), and `npm run check` passed.
