# Prototype collector workspace

**Parent:** [Collector workspace UI redesign](../ui-redesign-map.md)

**Label:** wayfinder:prototype

**Status:** in progress

**Assignee:** Codex primary

**Blocked by:** None — on the frontier.

## Question

What rough clickable desktop-and-mobile workspace gives a collector a clear, polished way to browse owned cards and move physical cards among Storage Leaves and Decks before a redesign specification is written?

## Scope

- Prototype the initial workspace: a Locations/Decks sidebar, searchable owned-card grid, selected-card detail panel, and mobile drawer equivalents.
- Make the core behavior reactable: select a destination, inspect card details, and move a physical card into or out of a selected Deck or Storage Leaf using the proposed interaction.
- Explore how the selected destination, card-grid focus, and detail panel compete for attention without assuming a final screen architecture.
- Present the owner brief's dark-first, deckbuilder-style direction: large card artwork, richer yet restrained accents, and compact controls.

## Acceptance criteria

- The prototype can show an owned-card browsing flow from sidebar destination selection through grid search/filtering to selected-card detail.
- It demonstrates a physical-card Move into a Deck and a Move back to a Storage Leaf, making the destination visible before the action and preserving immediate valid desktop drops without an extra confirmation dialog.
- Desktop and mobile views expose equivalent core outcomes, with mobile navigation and details available through drawers or sheets rather than hover-only behavior.
- The owner can identify candidate primary actions, valid destination feedback, and the unresolved detail-panel/selection tradeoff from the artifact itself.
- Prototype notes distinguish established inventory invariants from visual or interaction choices proposed for review.

## Dependencies and evidence

- Existing physical-inventory behavior is defined by the [MVP specification](../../spec.md), especially its Locations, Move, selection, and Undo rules, and by the completed [core interaction contract](08-decide-core-interaction-contract.md).
- This ticket produces an owner-review artifact only. It does not resolve drag ordering, the full responsive visual system, or broader-screen rollout.

## Open questions for review

- Does a selected destination belong primarily in the sidebar, a persistent workspace header, or the detail panel?
- When a card is selected, how much grid context should remain visible beside its details?
- Which first-pass search, filter, and destination cues make owned-card browsing feel immediate without turning the prototype into an implementation specification?

## Provenance

Created from the owner brief on 2026-10-09. Laya routing was unavailable (`route_task` returned an error); the primary selected the technical-writer route.
