# Collector workspace UI redesign — decision map

**Label:** wayfinder:map

**Status:** active planning

## Destination

An owner-agreed, spec-ready collector-workspace direction. This map indexes decisions and open questions for later specification work; it does not deliver application changes.

## Notes

- The working app name is **PrizeCheck** (owner, 2026-10-11), replacing the earlier working name Starbirth. "Prize check" is the player habit of working out which cards are in your Prize cards, which fits a tool for knowing what you own and where. The visual theme is input to [Decide responsive visual system](https://github.com/ry-cen/prizecheck/issues/47).
- Preserve the existing domain: a Collection is an aggregate, Holdings retain fungible quantities, organizational Locations cannot hold Holdings, and a Deck is a specialized Storage Leaf.
- The approved workspace direction is minimal: the desktop Location sidebar remains visible, while filters use the aligned toolbar and mobile controls use left/right drawers. Search remains accessible and dedicated deck-building UI is deferred.
- The approved UI rules, including the 2026-10-09 toolbar, mobile drawer, location-creation, and contextual tile-label refinement, are in [collector workspace selection and presentation](resolutions/29-decide-collector-workspace-selection-and-presentation.md). [ADR 0005](../../../adr/0005-collector-workspace-multi-source-direction.md) records the multi-source direction, which the [collector workspace spec](../../collector-workspace/spec.md) defined and the workspace now implements.
- The vertical copy-fan prototype is historical evidence and has been superseded by individual visual tiles.

## Decisions so far

- [Decide collector workspace selection and presentation](https://github.com/ry-cen/prizecheck/issues/48) — Use small, separate visual tiles for fungible quantities, an aligned desktop toolbar, mobile Location and Filters & display drawers, contextual location creation, and minimal inspection/action surfaces; no durable per-copy identity is introduced.

- [Decide atomic multi-source inventory operations](https://github.com/ry-cen/prizecheck/issues/49) — Resolved by the [collector workspace spec](../../collector-workspace/spec.md) ([issue](https://github.com/ry-cen/prizecheck/issues/79)): extend the existing manifest flow with a per-item source Storage Leaf, commit all-or-nothing to one destination, exclude copies already there, and restore every source with one atomic Undo.
- [Decide drag and Location ordering](https://github.com/ry-cen/prizecheck/issues/46) — [Resolution](resolutions/27-decide-drag-and-location-ordering.md): natural A–Z sibling order with nothing stored; a gear opens Manage locations, where a ☰ handle drags a Location onto another (mouse or touch) or a tap opens a Move picker, always with a confirmation; sidebar rows take card drops only; no Location Undo; Decks can be renamed and moved.
- [Decide responsive visual system](https://github.com/ry-cen/prizecheck/issues/47) — [Resolution](resolutions/28-decide-responsive-visual-system.md): one shared set of design variables, adopted by the workspace first; dark only, with Prize gold as the default theme and energy-type preset themes planned for later; system font with tabular numerals; a WCAG 2.2 AA, focus, target-size and reduced-motion baseline; gap-ring selected tiles; set and number on the Names line; placeholder, inline-error, stale-banner and toast states.

## Specification

- [Collector workspace spec](../../collector-workspace/spec.md) ([Spec: Collector workspace](https://github.com/ry-cen/prizecheck/issues/79)), ready for implementation planning.

## Not yet specified

- How this workspace extends to catalog search, reporting, publishing/discovery, pricing/export presentation, and owner controls.

## Out of scope

- Application implementation, production UI assets, commits, pushes, deployment, or changing the current MVP contract before separate specification and backend design work.
- Dedicated deck-building UI, broad light-theme rollout, and persistent physical-copy records.
