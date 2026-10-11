# Collector workspace — specification

**Status:** ready for implementation planning. Revised 2026-10-11 for prices, Deck cost and exports after they merged into `dev`. Revised again the same day for Location management from [Decide drag and Location ordering](https://github.com/ry-cen/prizecheck/issues/46).

**Sources:** [Collector workspace selection and presentation](../tcg-collection-tracker/wayfinder/resolutions/29-decide-collector-workspace-selection-and-presentation.md) (product rules, owner-confirmed 2026-10-09), [ADR 0005](../../adr/0005-collector-workspace-multi-source-direction.md) (multi-source direction), the [collector workspace prototype](../tcg-collection-tracker/wayfinder/prototypes/collector-workspace/README.md) (Variant A), the [UI redesign map](../tcg-collection-tracker/wayfinder/ui-redesign-map.md), and the [card prices and Deck exports spec](../card-prices-and-deck-exports/spec.md), whose pricing and export rules this workspace must keep. Location ordering and management follow [the drag and Location ordering resolution](../tcg-collection-tracker/wayfinder/resolutions/27-decide-drag-and-location-ordering.md). This spec resolves [Decide atomic multi-source inventory operations](https://github.com/ry-cen/prizecheck/issues/49).

## Problem Statement

My cards live in many physical places: binders, boxes, Decks. Today I manage them one Storage Leaf at a time, as rows of Holdings with quantities. I can't see my collection the way I see it on the table, as cards. When I want to gather copies from several places, for example every Charizard from my binder and my trade box, I have to repeat the same Move once per source. If I make a mistake, I have to undo each Move separately. Filtering by card category or elemental type isn't possible. On a phone, the workspace isn't built for picking several cards and acting on them together.

## Solution

A redesigned collector workspace shows the Collection as a gallery of small card tiles, one tile per copy. The desktop keeps the Location sidebar visible. Above the gallery, one aligned toolbar holds Search and Filters on the left and Sort, card size and name visibility on the right. I can select tiles across any number of Storage Leaves by click, Ctrl/Cmd-click, Shift-click, marquee or (on mobile) Select mode. Then I can Move them to one destination or remove them from the Collection in a single all-or-nothing operation that one Undo reverses. I can add Locations directly from the sidebar tree. On mobile, a left drawer holds the Location tree and a right drawer holds Filters & display. The inspector shows the inspected card's price, an opt-in Prices toggle adds prices under the tiles, and an open Deck shows its Estimated Deck Cost and Export menu in the heading.

Holdings stay fungible quantities. A tile is a selectable unit of a Holding's quantity, not a durable record of a physical copy.

## User Stories

### Browsing the gallery

1. As a collector, I want All owned to show my whole Collection as card tiles, one per copy, so that I see my cards the way I store them.
2. As a collector, I want copies of the same Card Edition kept next to each other, so that I can count and compare them at a glance.
3. As a collector, I want every copy shown by scrolling with no artificial cap, stack, fan or "+N" overlay, so that nothing is hidden from me.
4. As a collector, I want to open a Storage Leaf from the sidebar and see only its tiles, so that the gallery matches what is physically in that binder, box or Deck.
5. As a collector, I want each tile in All owned to show its source Location caption even when names are hidden, so that I know where every copy lives.
6. As a collector, I want the source caption omitted inside a Storage Leaf, so that tiles aren't cluttered with information I already know.
7. As a collector, I want card names hidden by default and switchable on, so that the gallery is artwork-first but I can read names when I need them.
8. As a collector, I want small and medium card sizes, so that I can trade density for detail.
9. As a collector, I want the heading to show copy and Card Edition counts with correct singular and plural forms, so that the totals read naturally.
10. As a collector with a 25,000-Holding Collection, I want the gallery to scroll smoothly, so that a large Collection stays usable.
11. As a collector, I want a tile's hover title and accessible label to include the card name, copy number and full Location path, so that I can identify any tile without names shown.

### Searching, filtering and sorting

12. As a collector, I want to search my cards by name from the toolbar, so that I can find a card quickly.
13. As a collector, I want to filter by set, so that I can focus on one release.
14. As a collector, I want to filter by category (Pokémon, Trainer, Energy), so that I can separate card kinds.
15. As a collector, I want to filter by elemental type, so that I can gather cards for a type-themed Deck.
16. As a collector, I want filters to combine independently, so that I can narrow by set, category and type together.
17. As a collector, I want Clear filters to reset filters only, leaving sort, card size and name visibility alone, so that I don't lose display choices.
18. As a collector, I want an indicator when filters are active, so that I know the gallery is narrowed.
19. As a collector, I want to sort by name (A–Z default), set plus collector number, or quantity, ascending or descending where applicable, so that I can order the gallery my way.
20. As a collector, I want quantity sort to use the Card Edition's total in the current view, so that the order reflects what I'm looking at.
21. As a collector, I want copies within a Card Edition ordered by source Location, so that the gallery is stable and predictable.
22. As a collector, I want sort, filters, card size and name visibility remembered between visits in this browser, so that the workspace opens the way I left it.
23. As a collector, I want search text and selection to reset between visits, so that I start each visit with a clean slate.

### Selecting

24. As a desktop collector, I want a click to select one tile, so that selection is quick.
25. As a desktop collector, I want clicking the only selected tile to deselect it, so that I can undo a stray click.
26. As a desktop collector, I want Ctrl/Cmd-click to toggle tiles, so that I can build a group across Locations.
27. As a desktop collector, I want Shift-click to select the displayed range left to right, then top to bottom, so that I can grab a run of tiles.
28. As a desktop collector, I want to drag a marquee from empty grid space to replace the selection, so that I can select an area.
29. As a desktop collector, I want Ctrl/Cmd-marquee to add to the selection, so that I can combine areas.
30. As a collector, I want clicking empty space or pressing Escape to clear the selection, so that deselecting is easy.
31. As a collector, I want a selection to span Storage Leaves, so that one action can gather copies from several places.
32. As a collector, I want sorting to keep my selection, so that I can reorder without losing work.
33. As a collector, I want changing search, filters or Location to clear my selection, so that I never act on tiles I can no longer see.
34. As a collector, I want a selection bar showing selected copies, Card Editions and Locations with correct plurals, so that I know what I'm about to act on.

### Inspecting

35. As a desktop collector, I want the inspection panel reserved but empty while idle, so that the layout doesn't jump.
36. As a desktop collector, I want hovering a tile to preview it only when nothing is selected, so that hover doesn't fight my selection.
37. As a collector, I want the inspector to show the last-clicked selected Card Edition, so that I can check a card while building a group.
38. As a collector, I want the inspector to show set, number, category, type, the copy's Location path, copies there and total owned, so that I have the facts I need.

### Moving and removing

39. As a collector, I want Actions (Move, Inventory Removal, Clear) whenever tiles are selected, so that every operation has a non-drag path.
40. As a collector, I want Move to open a searchable folder-style Location explorer, so that I can find the destination in a deep tree.
41. As a collector, I want Organizational Locations to expand in the explorer and only Storage Leaves (including Decks) to be selectable, so that I can't pick an invalid destination.
42. As a collector, I want the explorer to show the destination's full path and the number of copies that will actually move before I confirm, so that there are no surprises.
43. As a collector, I want copies already at the destination to stay put and not count as moved, so that a mixed group behaves sensibly.
44. As a collector, I want Move confirmation disabled when every selected copy is already at the destination, so that I can't submit a no-op.
45. As a desktop collector, I want to drag a selected tile to carry the whole selection, so that drag works on groups.
46. As a desktop collector, I want dragging an unselected tile to carry only that tile, so that a quick drag doesn't grab an old selection.
47. As a desktop collector, I want a compact copy and Card Edition count badge while dragging, plus highlighted valid destinations, so that I know what I'm carrying and where it can go.
48. As a desktop collector, I want dropping on a valid Storage Leaf to Move immediately, with Undo, so that drag stays fast.
49. As a collector, I want a group Move to succeed completely or change nothing, so that my inventory is never half-moved.
50. As a collector, I want a failed Move to keep my selection and name the affected source Location, so that I can fix the problem and retry.
51. As a collector, I want a successful Move or Removal to clear my selection, so that I'm ready for the next task.
52. As a collector, I want Inventory Removal to confirm each Card Edition, quantity and source Location, so that I know exactly what leaves my Collection.
53. As a collector, I want a multi-source Inventory Removal to be one atomic operation, so that it never partly applies.
54. As a collector moving thousands of copies, I want progress feedback while the selection is staged, so that I know the app is working.

### Undo

55. As a collector, I want one Undo for a group operation that restores every copy to its original source together, so that a mistake is one click to reverse.
56. As a collector, I want an Undo that can't apply cleanly to change nothing and say it's unavailable, so that recovery never makes things worse.
57. As a collector, I want to dismiss an unavailable newest Undo to reach older eligible ones, so that one blocked record doesn't trap the rest.
58. As a collector, I want the existing newest-five, ten-minute Undo policy kept, so that recovery behaves as it does today.

### Locations

59. As a collector, I want the desktop Location sidebar always visible, so that navigation and drop targets are always there.
60. As a collector, I want folder disclosures in the tree, so that I can collapse parts I'm not using.
61. As a collector, I want a plus beside the Locations heading to create a top-level Location, so that adding storage is one step.
62. As a desktop collector, I want an Add child plus on eligible rows on hover or keyboard focus, so that the tree stays clean until I need it.
63. As a mobile collector, I want Add child controls always visible at a full touch size, so that I can reach them without hover.
64. As a collector, I want Deck rows to have no Add child control, so that the rule that Decks have no children is clear.
65. As a collector, I want Add child to preselect its parent in the Name-and-parent form, so that I don't pick it twice.
66. As a collector adding a child to a stocked Storage Leaf, I want the choices to move its Holdings into the new child, create a separate Unsorted child, or cancel, so that my cards always stay in a Storage Leaf.
67. As a collector, I want the new Location selected and its ancestors expanded after creation, so that I can start using it at once.
68. As a collector, I want long Location names to stay readable in the sidebar, with the full name on hover, so that similar names don't blur together.

### Mobile

69. As a mobile collector, I want a left header control opening the Location drawer, so that navigation is one tap away.
70. As a mobile collector, I want a right "Filters & display" control opening filters, sort, card size and name visibility, so that the gallery has room.
71. As a mobile collector, I want drawer changes to apply immediately and stay after closing, so that the drawers feel direct.
72. As a mobile collector, I want search always reachable in the header, so that finding a card doesn't need a drawer.
73. As a mobile collector, I want a normal tap to open inspection in a sheet, so that browsing is simple.
74. As a mobile collector, I want a visible Select mode where taps toggle tiles across Locations, so that I can build groups by touch.
75. As a mobile collector, I want the selected count and Actions in a compact strip, with details on demand, so that the gallery stays visible.
76. As a mobile collector, I want vertical scrolling to keep working in Select mode, so that selection doesn't trap the page.
77. As a mobile collector, I want header controls at least 44×44 px, so that they're easy to tap.

### Keyboard and accessibility

78. As a keyboard user, I want to focus tiles and toggle them with Space in selection mode, so that I can select without a mouse.
79. As a keyboard user, I want a complete Move path through Actions, so that I never need drag.
80. As a screen reader user, I want every tile, control and dialog labelled, and focus returned to the opener when a drawer or dialog closes, so that I can follow the workspace.

### Consistency and safety

81. As a collector with two tabs open, I want an operation based on stale quantities to fail without changes, so that I never Move cards that already moved.
82. As a collector on a flaky connection, I want a retried commit to apply once, so that a retry never doubles a Move.
83. As a collector, I want existing single-source Move, Removal and Undo to keep working, so that nothing I rely on regresses.

### Prices, Deck cost and exports

84. As a collector, I want the inspector to show the exact Card Edition's USD price with its age, a stale label or an explicit unavailable state, so that I can judge the value without mistaking a missing quote for $0.
85. As a collector, I want a Prices display toggle, off by default, that shows each visible tile's Card Edition price under it, so that I can browse by value when I want to.
86. As a collector, I want prices loaded only for tiles on screen, so that browsing a large Collection doesn't fetch prices for cards I haven't looked at.
87. As a collector, I want the Prices toggle remembered with my other display preferences, so that the gallery opens the way I left it.
88. As a collector viewing a Deck, I want its Estimated Deck Cost with Pricing Coverage and stale and unknown-age counts in the heading, so that I see what the Deck is worth and how complete that figure is.
89. As a collector viewing a Deck, I want an Export menu with Pokémon TCG Live text and TCGplayer Mass Entry, so that I can export without leaving the gallery.
90. As a collector, I want Deck exports in the workspace to block, fall back and warn exactly as they do on the Decks page, so that no card is dropped or substituted.
91. As a collector on the Decks page, I want an Open in workspace link for each Deck, so that I can go from checks and publishing to the Deck's cards.
92. As a collector, I want a "Report a problem with this card's data" link in the inspector, so that I can report a wrong price mapping or export detail where I notice it.
93. As a collector on a large screen, I want the gallery to use the full width beside the sidebar, with more cards per row as the screen grows, so that space isn't wasted.

### Managing Locations

94. As a collector, I want sibling Locations sorted naturally A–Z, so that "Binder 2" comes before "Binder 10".
95. As a collector, I want a settings gear beside the Locations heading that opens Manage locations, so that all Location upkeep is in one place.
96. As a collector, I want Manage locations to list my whole tree with Rename, Add child and Delete on each row, so that I can edit any Location without opening it first.
97. As a collector, I want to drag a Location by its ☰ handle onto another Location to nest it there, so that reorganizing storage is direct.
98. As a collector, I want a Top level drop zone, so that I can move a Location out of every folder.
99. As a mobile collector, I want the handle drag to work with touch, so that I can reorganize on my phone.
100. As a collector, I want invalid targets (the Location itself, its descendants, Decks, its current parent, anything past 12 levels) dimmed and refusing the drop, so that I can't make an impossible move.
101. As a collector, I want every Location move confirmed with the new full path, so that a stray drop never reorganizes my storage.
102. As a collector moving a Location into a stocked Storage Leaf, I want the confirmation to explain that its cards move into a new Unsorted child, so that no card is left in a folder.
103. As a keyboard or touch user, I want tapping or activating the handle to open a Move picker of valid parents, so that I never need to drag.
104. As a collector, I want Rename to reject a name already used by a sibling, ignoring case, so that the tree stays unambiguous.
105. As a collector, I want Delete limited to empty Locations with no children and confirmed by typing the name, so that I can't lose cards or structure by accident.
106. As a collector, I want to rename a Deck and move it to another folder, so that its record follows the physical box.
107. As a collector, I want sidebar rows to accept only card drops, so that dragging cards never moves a Location by mistake.

## Implementation Decisions

### Domain boundary

- Holdings remain fungible quantities of one Card Edition in one Storage Leaf. No copy IDs, copy-specific fields, or per-copy persistence are added. A tile is identified on the client only by Storage Leaf, Card Edition and an ordinal within that Holding's quantity. Organizational Locations still can't hold Holdings. A Deck is still an ordinary Storage Leaf source and destination.
- Selection is held as a count per Holding (Storage Leaf + Card Edition → selected quantity), not as a list of tile identities. This keeps very large selections compact. It also maps directly onto manifest items.

### Multi-source Move, Removal and Undo (resolves #49)

The existing manifest flow is extended rather than replaced: start, stage in bounded batches, commit once. This keeps the existing atomicity, owner lock, staging limits and idempotency.

- **Manifest scope.** Starting a manifest no longer requires a source. An optional source is still accepted for compatibility: when present, items that omit a source default to it. One live manifest per owner, the one-hour staging expiry and the 500-item batch limit stay unchanged.
- **Manifest items.** Each staged item carries `source_id`, `edition_id`, `quantity` (decimal string) and `expected_version`. Items are unique per (source, Card Edition). Restaging an identical item is a no-op; restaging a conflicting one is rejected as a duplicate, as today.
- **Commit (Move).** One destination Storage Leaf. Items whose source is the destination are excluded as already there and don't count. If every item is excluded, the commit fails with a no-op error and changes nothing. All remaining items are validated together under the owner lock against one snapshot covering every involved source and the destination: each source must still be a Storage Leaf, each expected version must match, each source quantity must suffice, and the destination must not overflow. Any failure aborts the whole operation.
- **Commit (Inventory Removal).** No destination. The same all-or-nothing validation across sources.
- **Failure detail.** Conflict errors keep their existing codes (stale Holding, insufficient quantity, overflow, Location not found). The error body also names the affected source Storage Leaf and Card Edition, so the UI can say which Location to check. Selection is preserved on failure.
- **Result.** Move and Removal results report moved Card Edition count, moved copy count, source Location count, already-at-destination copy count and the new owner revision. The existing fields keep their meaning.
- **Idempotency.** Unchanged: the per-owner idempotency key with a command digest, and replay returns the original result.
- **Undo record.** The payload stores per-item source, Card Edition and quantity. The record's single-source field becomes optional; it is populated when one source was involved, so existing records and clients keep working. The Undo list adds a source Location count.
- **Undo apply.** All-or-nothing across every source. It's incompatible, and changes nothing, if any original source is no longer a Storage Leaf, the destination lacks the moved quantity, or any restore would overflow. The newest-only rule, newest-five retention, ten-minute expiry and dismiss-to-reach-older behaviour are unchanged.
- **Migration.** A schema migration adds the source to manifest items and Undo payload handling and relaxes the manifest's required source. Existing single-source Undo records are read as payload items whose source is the record's source. The generated TypeScript client is regenerated, and the generated-client check covers it.
- **Performance.** The existing budget holds: a 25,000-Edition Move, including staging, completes within two minutes with progress. Validation and transfer stay set-based in one transaction.

### Collection read for the gallery

- The gallery needs Holding-level rows (Storage Leaf + Card Edition + quantity + version + display data), not only per-Edition totals. The Collection read gains a Holding-level listing scoped to All owned or one Storage Leaf. It uses cursor pagination, name search, set, category and elemental type filters, and sorts by name, set plus collector number, or quantity (the Card Edition total within the current view). Rows are ordered by Card Edition, then source Location.
- Category (Pokémon, Trainer, Energy) and elemental type become stored, filterable catalog attributes of a Card Printing. The catalog import already reads category. Storing both requires a catalog migration and a re-import or backfill.
- Responses keep carrying the owner revision so the workspace can detect staleness and refetch.

### Workspace UI

- The workspace replaces the current Locations/Holdings management view as the signed-in collector's main inventory page. Catalog search for adding cards, Deck checks, publishing and operations pages are unchanged.
- **Rendering.** Tiles are expanded client-side from Holding quantities and rendered with viewport virtualization so a 25,000-Holding Collection stays responsive. Shift-range and marquee hit-testing are computed from the gallery's layout model (row, column, tile size), not from mounted DOM nodes, because offscreen tiles aren't mounted.
- **Interactions.** Every rule in [the workspace resolution](../tcg-collection-tracker/wayfinder/resolutions/29-decide-collector-workspace-selection-and-presentation.md) is normative for interactions: selection, inspection precedence, Actions, the Move explorer, drag, mobile drawers, Select mode, keyboard paths and Location creation.
- **Move paths.** A drag-drop onto a valid Storage Leaf commits immediately and offers Undo. Actions → Move goes through the explorer with a full path and actual moving count before confirmation. This adopts the reviewed picker confirmation that the resolution left to specification.
- **Location creation.** This reuses the existing Name-and-parent create contract, including the existing atomic stocked-leaf conversion choices. No backend change is needed.
- **Location order.** Every Location tree (sidebar, mobile drawer, Move explorer, Manage locations) sorts siblings in natural A–Z order, numeric-aware and case-insensitive. No order is stored.
- **Manage locations.** A gear beside the root + opens a centred panel on desktop and a full-screen sheet on mobile. Each row has a ☰ handle, Rename, Add child (not on Decks) and Delete. The panel's drag, confirmation and picker rules are those of [the drag and Location ordering resolution](../tcg-collection-tracker/wayfinder/resolutions/27-decide-drag-and-location-ordering.md). Reparenting uses the existing Location edit command, including its stale-version check and stocked-leaf Unsorted conversion. Rename and Delete use the existing commands and rules.
- **Handle drag.** The handle drag uses pointer events, not native HTML drag-and-drop, so the same code serves mouse and touch. A press that doesn't pass a small movement threshold is a tap and opens the Move picker; Enter and Space do the same. The handle sets `touch-action: none` and is at least 44×44 px on mobile.
- **Deck edit command.** Decks currently reject Location edits (`DECK_REQUIRES_DECK_COMMAND`). A Deck rename and move command is added with the same stale-version, sibling-name, depth and idempotency rules as Location edits. A Deck can't become a parent. Deck deletion is not part of this command.
- **No Location Undo.** Location changes have no Undo. Card Undo records that a Location change invalidates show "Undo unavailable" and can be dismissed, as today.
- **Preferences.** Sort, filters, card size and name visibility persist in browser storage per user on that device. Account-bound preferences are deferred. Search text and selection aren't persisted.
- **Sidebar sizing.** The desktop sidebar is 212 px at every desktop width, Add child overlays the row end rather than reserving width, and names carry a hover title. Mobile header controls and Add child controls are at least 44 px tall, and the mobile header Location control is 44×44 px.
- **Counts.** All copy, Card Edition, Location and selection counts use singular and plural forms.
- **Visuals.** The visual presentation follows prototype Variant A (dark theme). The final responsive visual system is tracked separately in [Decide responsive visual system](https://github.com/ry-cen/prizecheck/issues/47) and doesn't block this work.
- **Layout width.** The app-wide stylesheet caps `main` at 900 px and centres it. The workspace must not inherit that cap. The gallery fills the width beside the sidebar, side padding shrinks on large screens (30 px, then 20 px from 1550 px, then 16 px from 2200 px), and cards per row follow the available width at a fixed tile size.
- **Prototype code.** The development-only prototype modules are removed once the production workspace lands. The production build must not include prototype code or styles.

### Prices, Deck cost and exports

- The [card prices and Deck exports spec](../card-prices-and-deck-exports/spec.md) stays authoritative for every pricing and export rule. The workspace reuses its existing price, Deck cost, export and metadata-report components and contracts; it adds no new pricing or export API.
- **Inspector.** It shows the inspected Card Edition's price through the existing price component, with age, stale and unavailable labels.
- **Prices toggle.** A Prices display preference, off by default and stored with the other display preferences, adds the Card Edition price under each tile. Copies of the same Card Edition share one price. Only tiles mounted by the virtualized gallery render a price, so only those count as price access. The existing component's batching (at most 64 Editions per request, two requests in flight) is kept.
- **No price sort, filter or totals.** Each of these would need a price for every Card Edition in view, which the access-only refresh rule forbids. A selection subtotal with coverage is a possible follow-up that needs its own server endpoint.
- **Deck heading.** When the open Storage Leaf is a Deck, the heading shows the existing Estimated Deck Cost summary (subtotal, Pricing Coverage, stale and unknown-age counts) and an Export menu that opens the existing TCG Live and TCGplayer Mass Entry panels. Cost and exports use the server's complete Deck read, not the tiles currently loaded.
- **Decks page.** It keeps Deck checks, cost, exports and Publish, and adds an Open in workspace link per Deck.
- **Metadata reports.** The inspector links to the existing metadata report form, preset to the inspected Card Edition. The catalog search entry point is unchanged.

### Prototype-derived shapes

From the prototype, trimmed. The selection and operation shapes the UI sends:

```ts
// One selected group, as staged into a manifest item.
type SelectedGroup = { source_id: string; edition_id: string; quantity: string; expected_version: number };

// Move preview shown before confirmation.
type MovePreview = {
  destination_id: string;
  moving: number;          // copies whose source ≠ destination
  alreadyThere: number;    // copies whose source = destination; stay put, not counted
};                         // confirm disabled when moving === 0
```

## Testing Decisions

- **What a good test is.** Tests check external behaviour only. In the browser, that means what a collector sees and can do. At the API, it means HTTP responses and resulting Holding quantities. Tests never assert component internals, CSS class names, the selection data structure or SQL.
- **Seam 1 — browser.** Playwright page tests against the real local stack: auth, API, database. They cover the gallery, filters and sort, preference persistence, every selection gesture (including Shift-range and marquee across virtualized offscreen rows), inspection precedence, Move via Actions and via drag, multi-source Move and Removal, Undo, Location creation from the tree, mobile drawers and Select mode at 375×812, keyboard-only Move, and the singular-count copy. Prior art: `moves.spec.ts` (Move by drag and by control), `location-conversion.spec.ts`, `location-tree.spec.ts`, `mobile-journey.spec.ts`, `holdings.spec.ts` and `collection.spec.ts`.
- **Prices and Deck tools in the browser.** Playwright tests cover:
  - the inspector price with stale and unavailable states
  - the Prices toggle, its persistence, and that only on-screen tiles request prices
  - the Deck heading's cost and coverage
  - TCG Live and Mass Entry exports opened from the Deck heading, including a blocked export
  - Open in workspace from the Decks page
  - the inspector's metadata report link

  Prior art: `prices.spec.ts`, `price-refresh.spec.ts`, `live-export.spec.ts`, `mass-entry.spec.ts` and `metadata-review.spec.ts`. The existing API tests for prices and exports stay as they are, since no API changes.
- **Managing Locations in the browser.** Playwright tests cover:
  - natural sibling order
  - handle drag onto a row and onto Top level with a mouse, and with touch emulation at 375×812
  - invalid targets refusing a drop
  - the confirmation, including the stocked-leaf Unsorted conversion
  - a tap and a keypress opening the Move picker
  - Rename with a duplicate sibling name rejected
  - Delete with the typed-name confirmation
  - Deck rename and move
  - a stale edit from a second tab failing without changes

  Prior art: `location-tree.spec.ts` and `location-conversion.spec.ts`.
- **Seam 2 — HTTP API.** Pytest against the API covers the multi-source contract:
  - atomic success across three sources
  - already-at-destination exclusion and the all-no-op rejection
  - stale-version, insufficient-quantity, overflow and non-leaf failures with no mutation and the affected source named in the error
  - idempotent replay and key reuse
  - multi-source Removal
  - the Deck rename and move command: success, stale version, duplicate sibling name, Deck or descendant as the target parent, depth limit, stocked-leaf conversion and idempotent replay (prior art: `test_location_tree.py`, `test_location_conversion.py`, `test_decks.py`)
  - multi-source Undo, including incompatibility when one source became Organizational
  - coexistence with single-source manifests and pre-existing single-source Undo records after migration
  - the Holding-level Collection listing with category and elemental type filters and the specified sort order

  Prior art: `test_moves.py`, `test_inventory_undo.py`, `test_collection.py`, `test_holdings.py` and `test_location_conversion.py`.
- **Load proof.** The existing 25,000-Edition Move fixture and local-capacity validation are re-run with a selection spanning several sources, against the same two-minute budget.
- **No new seams.** Workspace state isn't split into a separately unit-tested module for this work.
- **Gates.** `npm run verify` is the full gate. Workers iterate on single tests and run the full gate once at the end.

## Out of Scope

- Durable per-copy records, copy IDs or copy-specific metadata.
- Dedicated deck-building UI.
- Account-bound display preferences (card size, name visibility, sort, filters persist only in the browser).
- A broad light theme, and the final responsive visual system ([Decide responsive visual system](https://github.com/ry-cen/prizecheck/issues/47)).
- Manual sibling ordering and drag-to-reorder. Order is natural A–Z.
- Undo for Location changes.
- Deleting Decks, including what happens to their Published Decks.
- Extending the workspace to catalog search, reporting, publishing and discovery, and owner controls.
- Price sorting, price filters, and value totals for a selection, a Location or the Collection.
- Changes to pricing, Deck cost or export rules, and Published Deck pricing and exports.
- Changes to Deck construction checks, Published Decks, or catalog import beyond storing category and elemental type.

## Further Notes

- Native HTML drag-and-drop and real touch gestures couldn't be automated in the prototype harness, so the browser tests must actually exercise drop and touch. Playwright drag and touch emulation are the minimum; record any remaining gap as a manual check in the launch checklist.
- Screen-reader output, contrast and full keyboard traversal weren't verified in the prototype. They are acceptance items here.
- The prototype's four owner-review observations (sidebar truncation, the duplicated mobile drawer title, the 36 px mobile control, and "1 editions") were fixed in the prototype on 2026-10-10. The corresponding rules are carried into the decisions above.
- **Revision 2026-10-11.** Prices, Deck cost and exports merged into `dev` in [ry-cen/prizecheck#78](https://github.com/ry-cen/prizecheck/pull/78). The owner chose: the inspector plus an opt-in Prices toggle for tiles, no price sort, filter or totals, Deck cost and Export in the Deck heading, the Decks page kept with an Open in workspace link, and a metadata report link in the inspector.
- The MVP specification's single-source Move/Removal/Undo text should be updated to point here when this spec is accepted. Per ADR 0005, the current single-source behavior stays authoritative until this work lands.
