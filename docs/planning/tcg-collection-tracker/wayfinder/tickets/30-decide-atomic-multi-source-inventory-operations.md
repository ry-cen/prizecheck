# Decide atomic multi-source inventory operations

**Parent:** [Collector workspace UI redesign](../ui-redesign-map.md)

**Label:** wayfinder:grilling

**Status:** open

**Assignee:** unassigned

**Blocked by:** None — product direction is accepted; backend design is not.

## Question

What transaction, concurrency, response, and Undo contract can safely implement the owner-approved multi-source selection direction while retaining fungible Holding quantities?

## Accepted direction

[Collector workspace selection and presentation](../resolutions/29-decide-collector-workspace-selection-and-presentation.md) is the canonical product requirement. This ticket designs the backend contract needed to honor it.

## Current gap and boundaries

The current MVP specification and code use a singular source leaf: `web/src/moves_generated.ts` exposes `startMove(source_id)`, while `api/app/moves.py` and its Undo flow use `source_id`. This ticket does not authorize changing those contracts or the MVP specification.

Holdings remain quantities; no durable per-copy IDs or copy-specific metadata are proposed. Organizational Locations remain ineligible sources/destinations, while Decks remain ordinary physical Storage Leaf destinations. Dedicated deck-building UI is out of scope.

## Acceptance criteria

- A resolution specifies an atomic manifest/commit and Undo design for multiple source Leaves, including idempotency, stale/concurrency handling, response counts, and conflict recovery.
- It states how existing single-source operations and the current Undo queue coexist or migrate without weakening atomicity.
- It identifies required specification, API, persistence, and verification changes without implementing them.
- It preserves the established domain terms and does not introduce durable copy identities.

## Dependencies

- [Collector workspace selection and presentation](../resolutions/29-decide-collector-workspace-selection-and-presentation.md)
- [ADR 0005](../../../../docs/adr/0005-collector-workspace-multi-source-direction.md)
- Current [MVP specification](../../spec.md) and [core interaction contract](08-decide-core-interaction-contract.md)
