# Collector workspace UI redesign — decision map

**Label:** wayfinder:map

**Status:** active planning

## Destination

An owner-agreed, spec-ready collector-workspace direction. This map indexes decisions and open questions for later specification work; it does not deliver application changes.

## Notes

- Preserve the existing domain: a Collection is an aggregate, Holdings retain fungible quantities, organizational Locations cannot hold Holdings, and a Deck is a specialized Storage Leaf.
- The approved workspace direction is minimal: the desktop Location sidebar remains visible, while filters use the aligned toolbar and mobile controls use left/right drawers. Search remains accessible and dedicated deck-building UI is deferred.
- The approved UI rules, including the 2026-10-09 toolbar, mobile drawer, location-creation, and contextual tile-label refinement, are in [collector workspace selection and presentation](resolutions/29-decide-collector-workspace-selection-and-presentation.md). [ADR 0005](../../../docs/adr/0005-collector-workspace-multi-source-direction.md) records the accepted future multi-source direction without changing the MVP contract.
- The vertical copy-fan prototype is historical evidence and has been superseded by individual visual tiles.

## Decisions so far

- [Decide collector workspace selection and presentation](tickets/29-decide-collector-workspace-selection-and-presentation.md) — Use small, separate visual tiles for fungible quantities, an aligned desktop toolbar, mobile Location and Filters & display drawers, contextual location creation, and minimal inspection/action surfaces; no durable per-copy identity is introduced.

## Not yet specified

- How this workspace extends to catalog search, reporting, publishing/discovery, pricing/export presentation, and owner controls.

## Out of scope

- Application implementation, production UI assets, commits, pushes, deployment, or changing the current MVP contract before separate specification and backend design work.
- Dedicated deck-building UI, broad light-theme rollout, and persistent physical-copy records.
