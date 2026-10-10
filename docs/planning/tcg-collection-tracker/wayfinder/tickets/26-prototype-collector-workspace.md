# Prototype collector workspace

**Parent:** [Collector workspace UI redesign](../ui-redesign-map.md)

**Label:** wayfinder:prototype

**Status:** in progress

**Assignee:** Codex primary

**Blocked by:** None — prototype refinement is on the frontier.

**Prototype:** [Collector workspace variants](../prototypes/collector-workspace/README.md)

## Question

Can a development-only prototype demonstrate the owner-approved minimal individual-tile workspace before a redesign specification is written?

## Active scope and criteria

- Refine the preferred gallery direction (Variant A) into small, non-overlapping visual quantity tiles grouped by Card Edition, with no fan, overlay, hidden selection, or durable copy identity.
- Demonstrate the approved desktop and mobile selection, inspection, search/sort/filter, Location navigation, selected-group Action, toolbar/drawer, name-visibility, and contextual location-creation rules from [the canonical resolution](../resolutions/29-decide-collector-workspace-selection-and-presentation.md). The desktop Location sidebar remains visible; on mobile, Location and Filters & display use the established left/right drawers.
- Demonstrate drag count feedback and destination cues, but do not claim a real multi-source mutation until the pending backend contract is designed.
- Keep the artifact development-only and in memory. Its notes must distinguish tested prototype evidence, accepted product direction, and unresolved backend work.

## Historical evidence — superseded

Variant B's vertical temporary copy fan, exposed-handle marquee, and related checks are historical evidence only. The owner replaced that interaction with individual visible tiles on 2026-10-09.

## Dependencies

- The current [MVP specification](../../spec.md) and [core interaction contract](08-decide-core-interaction-contract.md) remain authoritative until separately revised.
- [Atomic multi-source inventory operations](30-decide-atomic-multi-source-inventory-operations.md) owns the pending backend contract.

## Comments

2026-10-09 — Claimed by Codex primary. Three development-only variants were created for owner review.

2026-10-09 — The owner approved the individual-tile replacement. Refinement was subsequently implemented; owner review remains pending.

2026-10-09 — Refined Variant A now demonstrates the confirmed individual-tile design with minimal controls, conditional inspection, cross-source sample groups, selected-only Actions, destination explorer and mobile sheets. TypeScript/generated clients and production build passed; primary desktop/mobile checks and architect follow-up are recorded in the [prototype notes](../prototypes/collector-workspace/README.md#current-refinement-verification--2026-10-09). Native drop automation remains inconclusive and the full regression preflight lacks a database URI. This ticket remains in progress pending owner reaction; no production backend support or final prototype acceptance is claimed.

2026-10-09 — The owner confirmed a further refinement: align the desktop toolbar; retain a desktop Location sidebar without a fold control; use left Location and right Filters & display drawers on mobile; default card names off; condition source captions by view; and add root/child Location plus controls using the established stocked-leaf conversion choices. Implementation and measured verification for this refinement remain pending; account-bound persistence for card size and name visibility is deferred.

2026-10-09 — Claude Code picked up the toolbar/drawer/name-visibility/source-caption/Location-creation refinement from Codex's uncommitted source. Most of it was already implemented. Three gaps against the resolution were closed: filter values now persist, the create form gains a Parent location select that mirrors the existing Name-and-parent flow, and the form autofocuses Location name. Typecheck and production build passed, and the prototype stays out of `dist/`. Desktop (800–1280 px) and mobile (375×812) checks are recorded in the [prototype notes](../prototypes/collector-workspace/README.md#toolbar-and-location-refinement-verification--2026-10-09). Native drag/touch and `npm run verify` remain unverified. Ticket remains in progress pending owner review.
