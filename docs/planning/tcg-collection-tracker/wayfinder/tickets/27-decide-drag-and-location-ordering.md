# Decide drag and Location ordering

**Parent:** [Collector workspace UI redesign](../ui-redesign-map.md)

**Label:** wayfinder:grilling

**Status:** open

**Assignee:** unassigned

**Blocked by:** None — on the frontier.

## Question

How should the redesigned workspace apply the established physical-inventory Move contract to drag, keyboard, and touch interactions while defining only the new ordering and source-selection behavior that the current product contract leaves open?

## Established constraints

- A Collection is an aggregate view, not a card container. A Move starts from one physical Storage Leaf and ends at a distinct Storage Leaf; a Deck is a specialized physical Storage Leaf.
- Current selection can include whole stacks, arbitrary fanned copies, multiple Editions, or all Holdings in one leaf. Moves remain atomic, preserve selection on failure, and reject invalid destinations without mutating inventory.
- Existing Undo behavior remains the baseline: offer the newest of the last five Moves or Inventory Removals for ten minutes; an incompatible newest Undo can be dismissed to reach an older one. This ticket must not reduce that contract to a single most-recent action.
- Desktop drag, keyboard controls, and touch controls must reach equivalent Move outcomes. Inventory Removal retains its established confirmation behavior.

## Decisions to make

- Quantity and multi-selection: whether a drag starts from one card, a stack, a fanned subset, or an explicit selected set; how the UI makes that source and quantity unambiguous.
- Valid and invalid destinations: which sidebar/grid/detail affordances accept a Move, how they communicate validity before drop, and how the UI explains a rejected or stale action without losing selection.
- Location arrangement: how the requested reordering is distinguished from reparenting, and the precise meaning of a same-parent ordering operation versus moving a Location to a new parent.
- Persistence and recovery: what ordering state persists, how concurrent/stale ordering changes recover, and what Undo covers for any newly accepted reorder operation without weakening existing inventory Undo rules.
- Keyboard and touch behavior: a complete non-drag path for source selection, destination choice, feedback, recovery, and any accepted Location ordering.

## Acceptance criteria

- A recorded decision distinguishes card-Holding Moves from Location reordering and Location reparenting, including source, target, result, and persistence for each supported action.
- The accepted interaction describes quantity, multi-select, Deck, Storage Leaf, Collection, valid/invalid target, stale/failure, and Undo behavior without contradicting the current specification.
- A keyboard and touch user can perform every accepted operation without relying on hover or drag.
- The decision identifies which cues and feedback must be visible before drop, after success, and after failure.
- Any proposal that changes a durable inventory invariant is escalated as a separate product/architecture decision rather than silently assumed here.

## Dependencies and evidence

- Review the [MVP specification](../../spec.md) and completed [core interaction contract](08-decide-core-interaction-contract.md) as governing contracts.
- Use the [collector-workspace prototype](26-prototype-collector-workspace.md) as interaction evidence when available; this ticket is not blocked from framing the questions now.
- This ticket does not authorize changes to inventory semantics, database behavior, or the existing completed implementation tickets.

## Provenance

Created from the owner brief on 2026-10-09. Laya routing was unavailable (`route_task` returned an error); the primary selected the technical-writer route.
