# Decide drag and Location ordering

**Parent:** [Collector workspace UI redesign](../ui-redesign-map.md)

**Label:** wayfinder:grilling

**Status:** open

**Assignee:** unassigned

**Blocked by:** None — on the frontier.

## Question

How should the workspace define Location reordering and reparenting, including persistence, stale recovery, Undo, and non-drag alternatives, while faithfully presenting the accepted card-selection rules?

## Established constraints

- A Collection is an aggregate; organizational Locations cannot contain Holdings; a Deck is a Storage Leaf.
- The accepted tile/selection interaction is in [collector workspace selection and presentation](../resolutions/29-decide-collector-workspace-selection-and-presentation.md) and is not reopened here.
- Current backend contracts are single-source. The approved future multi-source direction belongs to [atomic multi-source inventory operations](30-decide-atomic-multi-source-inventory-operations.md), not this ticket.
- The existing Undo policy remains the baseline: newest five Moves or Inventory Removals for ten minutes, with dismissible incompatible newest Undo.

## Decisions to make

- Distinguish same-parent ordering from reparenting, including source, target, resulting tree order, persistence, stale recovery, and Undo.
- Define keyboard and touch paths for each accepted Location action.
- Define tree drag/drop cues and invalid-target feedback without altering card-selection semantics.

## Acceptance criteria

- A resolution distinguishes card Move, Location ordering, and reparenting behavior, including stale recovery and Undo.
- It refers to the accepted UI resolution and separate multi-source contract work without claiming backend implementation.
- Every accepted Location action is available without hover or drag.

## Dependencies

- [MVP specification](../../spec.md) and [core interaction contract](08-decide-core-interaction-contract.md)
- [Collector workspace prototype](26-prototype-collector-workspace.md) as interaction evidence only
