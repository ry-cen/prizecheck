# Collector workspace UI redesign — decision map

**Label:** wayfinder:map

**Status:** active planning

## Destination

An owner-agreed, spec-ready design direction for a polished collector workspace. It will define the visual style, key screens, and interaction behavior needed for a later UI redesign specification, grounded in a rough clickable prototype. This map does not deliver that full specification or application changes.

## Notes

- Owner brief, recorded 2026-10-09: explore a deckbuilder-style collector workspace with large card artwork, richer color, and compact controls. The prototype should offer useful interactivity, not animation alone.
- Begin with browsing owned cards and moving physical cards between Storage Leaves and into or out of physical Decks. The starting layout has a Locations/Decks sidebar, searchable card grid, and selected-card detail panel; mobile uses drawers.
- The visual direction is dark-first with restrained accents. A later light theme is expected, but its system is not defined yet.
- Preserve established domain and inventory behavior: the Collection is an aggregate, not a container; Decks are physical Storage Leaves; Moves are atomic; existing Undo and selection safeguards remain in force. [Current MVP specification](../spec.md) is the baseline for those contracts.
- A rough clickable prototype is the first artifact for owner reaction. Broader-screen rollout follows only after the core workspace feels right.
- Use Wayfinder, grilling, and domain-modeling for decision sessions, and prototype for the clickable workspace ticket. Preserve the authoritative existing maps and contracts.
- Include Location reordering, clear drop targets, immediate move feedback, Undo, and complete keyboard/tap alternatives alongside desktop and mobile drag exploration.
- Laya routing was unavailable: `route_task` returned an error. The primary selected the technical-writer route for this planning work.

## Decisions so far

<!-- Closed decision tickets are indexed here. The accepted initial brief is recorded in Notes; no tickets have been resolved. -->

None yet.

## Not yet specified

- How the approved core workspace should extend to catalog search, missing-card reporting, publishing/discovery, pricing/export presentation, and owner controls; the screen-specific changes and rollout boundaries will become clearer after prototype review.

## Out of scope

- Application implementation, production UI assets, a complete redesign specification, commits, pushes, deployment, and changing the existing MVP contract.
- Reopening resolved inventory, privacy, catalog, or Deck-domain decisions except where a new visual flow must faithfully present them.
- New external-reference research. No named reference product or site requires an evidence ticket yet.
