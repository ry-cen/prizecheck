# Decide responsive visual system

**Parent:** [Collector workspace UI redesign](../ui-redesign-map.md)

**Label:** wayfinder:grilling

**Status:** open

**Assignee:** unassigned

**Blocked by:** [Prototype collector workspace](26-prototype-collector-workspace.md), [Decide drag and Location ordering](27-decide-drag-and-location-ordering.md).

## Question

After the core workspace and movement behavior are reviewed, what visual system keeps the collector workspace coherent across remaining screens and viewport sizes while preserving practical accessibility and full mobile capability?

## Scope

- Define the dark-first visual direction's color roles, typography, spacing, card-art treatment, control density, and restrained use of accent and motion.
- Define the intended light-theme counterpart without assuming its final token values before review.
- Decide desktop/mobile parity for navigation, search, selection, details, destination choice, feedback, and any accepted ordering behavior.
- Cover empty, loading, error, stale/conflict, success, and Undo states for the workspace surfaces that follow the core prototype.
- Set accessibility expectations for contrast, visible focus, keyboard operation, target size, screen-reader labeling, and reduced motion.

## Acceptance criteria

- The resolution names the reusable visual roles and responsive rules that a later specification can apply to Locations, Collection, Decks, card details, and related states.
- It defines which interactions must have the same outcome on desktop and mobile, plus any explicitly justified presentation differences.
- It supplies readable requirements for dark and eventual light themes, density tiers, focus/contrast, reduced motion, and non-happy-path states.
- It keeps large artwork and richer color subordinate to card identity, quantity, physical Location, Deck status, and action feedback.
- It identifies any remaining broader-screen uncertainty as future work instead of claiming a complete redesign specification.

## Dependencies and evidence

- Requires owner review of the [collector-workspace prototype](26-prototype-collector-workspace.md) and the interaction decisions in [drag and Location ordering](27-decide-drag-and-location-ordering.md).
- The [MVP specification](../../spec.md) remains the source for existing desktop/mobile operation parity and inventory behavior.

## Provenance

Created from the owner brief on 2026-10-09. Laya routing was unavailable (`route_task` returned an error); the primary selected the technical-writer route.
