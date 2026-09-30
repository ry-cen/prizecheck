# 06 — Safe Location conversion and deletion

**Label:** ready-for-agent

**Blocked by:** 04 — Add Holdings; 05 — Location tree

**Status:** ready-for-agent

**What to build:** A collector can reorganize a stocked leaf without losing Holdings and can delete only an empty childless Location.

- [ ] When adding a first child beneath a stocked leaf, offer atomic choices to move its Holdings into the named child, create a separate Unsorted child for them, or cancel.
- [ ] When reparenting beneath a stocked destination leaf, offer an atomic Unsorted child for destination Holdings or cancel. Failed conversion leaves the original tree and Holdings intact.
- [ ] Reject Deck parents, cycles, depth overflow, duplicate sibling names, and cross-owner references in the same transaction as conversion. Removing the final child makes its former ordinary parent an empty Storage Leaf.
- [ ] Delete requires named confirmation and succeeds only for an empty childless Location; the Unsorted root may be renamed, moved, or deleted only when empty.
- [ ] Browser/API/PostgreSQL tests cover both stocked-leaf choices, cancel and injected failure, concurrent edits, nonrecursive deletion, and cross-owner isolation.
