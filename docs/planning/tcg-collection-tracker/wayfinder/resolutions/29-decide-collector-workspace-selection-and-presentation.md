# Resolution — Collector workspace selection and presentation

**Owner confirmed:** 2026-10-09

This records the owner-approved direction for a later collector-workspace redesign. It does not change the current MVP specification, backend contracts, or implementation.

## Established domain boundary

Visual tiles represent selectable units of a fungible [Holding](../../../../CONTEXT.md). They do not create durable physical-copy records or copy-specific fields. A Collection remains an aggregate; an Organizational Location cannot contain Holdings; a Deck remains a specialized Storage Leaf. Dedicated deck-building UI is deferred.

## Workspace and tiles

- Use the minimal gallery direction: small, non-overlapping visual tiles, one per quantity unit. Keep copies of a Card Edition adjacent and show every copy by scrolling; viewport virtualization is an implementation option, not an approved architecture.
- Do not use stacks, fans, copy overlays, collapsed copies, or an artificial visual-copy limit.
- Desktop uses an always-visible Location sidebar; it has no workspace drawer-fold control, though folder disclosures remain available. Align the toolbar at one shared control height: Search and Filters form the left group, while Sort, card size, and name visibility form the right group.
- On mobile, a left-header Location control opens the Location drawer and a right-header “Filters & display” control opens a drawer containing filters, sort, card size, and name visibility. Search remains accessible. These controls apply changes immediately, keep those changes when their drawer closes, and Clear filters resets filters only. Details and Move continue to use their established sheets.
- Card names are hidden by default. Remember sort, filters, card size, and name visibility between prototype visits; search text and selection reset. Card size and name visibility are explicitly deferred as future account-bound preferences rather than new backend settings in this work.
- Sort by Name (default A–Z), Set plus collector number, or Quantity, ascending/descending as applicable. Quantity is the Card Edition total in the current view; keep edition copies adjacent and order copies by source Location within each Card Edition.
- Filter separately by set, category (Pokémon, Trainer, Energy), and elemental type. Sorting preserves selection; changing search, filters, or location clears it.

## Selection, inspection, and actions

- A desktop click selects one tile; clicking the sole selected tile deselects it. Ctrl/Cmd-click toggles tiles. Shift-click selects the displayed range left-to-right, then top-to-bottom. Empty space and Escape clear selection.
- A marquee starts from empty grid space and replaces selection; Ctrl/Cmd-marquee adds intersecting tiles. A selected tile drag carries the entire selected group; an unselected tile starts a group containing only that tile. During drag, show a compact copy/Card Edition count rather than card imagery and highlight valid destinations.
- Selection may span source Locations. In All owned, retain each tile's source caption even when names are hidden; hover or inspection exposes the full path. Inside a physical Storage Leaf, omit the redundant source caption. With names hidden there, the tile presents artwork and selection state only while retaining an accessible label.
- Reserve desktop inspection space but leave it empty while idle. Hover previews only when no tile is selected. Selection takes precedence and inspects the last clicked selected Card Edition. A selection can be cleared.
- Show Actions whenever one or more tiles are selected: Move, Inventory Removal, and Clear. Move uses a searchable folder-style Location explorer: organizational Locations expand, eligible Storage Leaves (including Decks) are selectable, and the full destination path and actual moving count appear before confirmation. Disable Move confirmation when every selected quantity is already at the destination. Valid desktop drops remain immediate feedback/mutation paths under the current UI contract; the reviewed Move-picker confirmation is a proposed redesign override and requires later specification work.
- Inventory Removal confirms selected quantities and source Locations. Successful Move or Removal clears selection; a failure preserves it. Each successful group operation exposes Undo.

## Responsive behavior

- On mobile, normal tap opens inspection. A visible Select mode makes taps toggle tiles across Locations. Keep selected count and Actions reachable in a compact strip; show details on demand.
- Mobile and keyboard paths provide the same outcomes as desktop drag and hover; presentation may differ. Keyboard users can focus tiles, toggle them with Space in selection mode, and use Actions for a complete non-drag Move path. Mobile inspection details open in a sheet.

## Location creation refinement — 2026-10-09

- Show an always-visible, accessible plus button beside the Locations heading to create a root Location. It uses the existing creation flow with no parent preselected.
- Show a small accessible Add child plus button for eligible ordinary and Organizational Location rows. It appears on desktop hover or keyboard focus and is always visible on mobile. The existing Deck rule remains: a Deck cannot have children, so Deck rows do not expose this control.
- The child action preselects its parent in the existing Name-and-parent creation flow. If that parent is a stocked Storage Leaf, retain the established atomic choices: move its existing Holdings into the named child, create an Unsorted child for the existing Holdings plus the named child, or cancel.
- After a successful creation, select the named Location and expand its ancestor path. The prototype may simulate this with in-memory data only; this does not add a backend contract.

## Superseded presentation details

- Earlier language allowing a desktop workspace drawer to hide the Location sidebar is superseded. The sidebar remains visible on desktop; only the mobile Location drawer is toggled from the far-left header control.
- Earlier behavior that always showed card names and source captions is superseded by the name-visibility and context-specific source-caption rules above.

## Multi-source direction and recovery

The owner approved a future multi-source operation contract: a group Move targets one destination and succeeds wholly or fails without mutation; quantities already at the destination remain there and do not count as moved. The actual moving count is shown before confirmation and all-already-destination groups cannot be confirmed. Insufficient or stale quantity fails the entire operation, preserves selection, and identifies the affected source Location.

Inventory Removal across sources is atomic and confirmed as one operation. One Undo restores every moved or removed quantity to its original source atomically; failure must not partially undo. Keep the current newest-five, ten-minute Undo policy; an incompatible newest Undo remains dismissible so older eligible records can be reached.

Current MVP/backend contracts remain single-source, so this is a product requirement rather than an implementation claim. [ADR 0005](../../../../docs/adr/0005-collector-workspace-multi-source-direction.md) and [atomic multi-source inventory operations](../tickets/30-decide-atomic-multi-source-inventory-operations.md) record the required backend design work.

## Superseded proposal

Vertical fan-out, visible-copy caps, hover expansion, fan overlays, and hidden-copy selection are superseded. The earlier prototype evidence remains historical only.
