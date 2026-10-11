# Collector workspace prototype

Supports [Prototype collector workspace](https://github.com/ry-cen/prizecheck/issues/45). This is development-only design evidence, not production behavior or an accepted backend contract.

## Run

From the isolated UI worktree root on `feature/ui-workspace-redesign`:

```sh
npm run dev:web -- --port 5184 --strictPort
```

Open [the preferred prototype](http://127.0.0.1:5184/locations?prototype=collector&variant=A). The preview uses in-memory samples; it requires no backend or sign-in.

## Current direction

Variant A is the preferred direction. The owner approved individual small tiles for each quantity unit, replacing Variant B's vertical copy fan. The approved target interaction is recorded in [collector workspace selection and presentation](../../resolutions/29-decide-collector-workspace-selection-and-presentation.md), and is now demonstrated by Variant A with in-memory sample data. Historical B/C remain available through the prototype switcher.

The next confirmed refinement aligns the desktop toolbar while keeping the Location sidebar visible, moves mobile Location and Filters & display controls into left/right drawers, defaults card names off, and hides redundant source captions inside a physical Storage Leaf. It also adds root and child Location plus controls using the existing stocked-leaf conversion choices. Sort, filter values, card size, and name visibility are remembered locally by this prototype; account-bound preferences are deferred. This refinement is now implemented and checked with sample data (see below); owner review is pending.

## Try the refined gallery

1. Search for Charizard. Select any of the five binder copies, then Ctrl/Cmd-click the Trade box copy to build a group across sources. Shift-click selects a displayed range left to right, then top to bottom; drag from a grid gap to box-select visible tiles.
2. Open Actions → Move. Search or expand the destination tree, review the full path and actual moving count, then confirm. Copies already at the destination stay there; an all-no-op move cannot be confirmed.
3. Try Inventory Removal and its quantity/source confirmation, then Undo. Each sample group operation restores quantities to the original locations together.
4. Try independent Set, Category and Elemental type filters and the sort, card-size, and Names controls. Names are off by default. In All owned each tile keeps its source caption; open a Storage Leaf and the caption disappears. Sort, filter values, card size and Names persist across reloads; sample inventory, search, the viewed Location and selection do not. Clear filters resets filters only.
5. Use the plus beside LOCATIONS for a top-level Location, or hover/focus a non-Deck row and use its plus for a child. The form has Name and Parent location; choosing a stocked leaf such as 151 display binder offers "move into the new child", "separate Unsorted child", or Cancel. The new Location is selected and its ancestors expand. Use Reset to restore the sample tree.
6. On mobile, the left header control opens the Location drawer (plus controls always visible) and the right "Filters & display" control opens the filters, sort, card size and Names drawer. Changes apply immediately and remain after closing. Enable Select, tap copies across rows/locations, and use the compact Details/Actions strip. Details and Move open sheets.

## Current refinement verification — 2026-10-09

- Tested on the isolated `dev`-based UI branch with uncommitted prototype source. `npm run build` passed TypeScript, generated-client checks and Vite production build. Production assets contain no refined-prototype module/styles/preference key.
- Desktop checks covered Ctrl/Cmd selection across sources, sorting without losing selection, Shift selection across rows, two-tile native marquee, conditional hover inspection without an empty action bar, sole-copy deselection, all-already-destination disabled Move, and separate set/category/type filtering.
- Move picker transferred four copies from two sources to one destination; a separate mixed group kept copies already at the destination. Selection cleared on success. Group Move, Inventory Removal and Undo restored the expected source quantities.
- At 390×844, Select mode retained selections across offscreen rows, the grid had `touch-action: pan-y`, no horizontal overflow appeared, and detail/Move sheets plus a two-source Move/Undo were usable. Native touchscreen gestures were not available in the harness; actual touch scrolling remains a manual review item.
- Native HTML drag automation was inconclusive: temporary diagnostics observed drag-start and drag-end, but no target drag-over/drop events. Diagnostics were removed. The selected drag snapshot/count-badge/drop implementation passed static review; picker movement passed runtime checks. Do not count the native-drop attempt as passing.
- `npm run verify` could not start because `TEST_ADMIN_DATABASE_URL` was not configured. This is not a passing full regression run.
- A worker implemented the refinement; the primary integrated and checked it. Initial Laya routing failed; Laya later selected architect review. Two findings (mobile scrolling and an empty desktop hover bar) were fixed and the architect confirmed no remaining blockers.
- Screenshots: [Selected copies in the refined gallery](refined-gallery-desktop.png), [Mobile destination sheet](refined-gallery-mobile.png).
- The synthetic grid renders all 44 sample quantity tiles. Virtualization and production multi-source transactions remain future work; there are no real inventory writes, commits or pushes.

## Toolbar and Location refinement verification — 2026-10-09

The owner confirmed the toolbar, drawer, name-visibility, source-caption, and Location-creation refinement after the checks above. Codex implemented most of it in the uncommitted prototype source; Claude Code then reviewed it against [the resolution](../../resolutions/29-decide-collector-workspace-selection-and-presentation.md), closed three gaps, and ran the checks below. All checks used in-memory sample data on the Codex dev server (port 5184).

**Gaps closed in this pass**

- Filter values (Set, Category, Elemental type) now persist with sort, card size and name visibility. Previously only the desktop filter panel's open state persisted.
- The create form now mirrors the existing Name-and-parent flow with a Parent location select (Top level plus non-Deck Locations). The root plus leaves it at Top level; a row plus preselects that row. Changing the parent clears and re-evaluates the stocked-leaf choice.
- The create dialog focuses Location name on open, matching the existing flow's autofocus.

**Measured — passed**

- `npx tsc -p web/tsconfig.json --noEmit` and `npm run build` (TypeScript, generated-client checks, Vite production build) passed. `dist/` contains no prototype markers (`mw-root`, the preference key, `MinimalWorkspace`).
- Defaults after clearing localStorage: 0 card names, 44/44 source captions in All owned, root plus visible, child plus at opacity 0 until hover or keyboard focus (focus measured at opacity 1).
- Desktop toolbar at 800, 1024 and 1280 px: Search, Filters, Sort, Card size and Names share one row at 38 px; the right group ends flush with the toolbar edge; no horizontal overflow. The desktop Location sidebar has no fold control.
- Inside Trade box: 0 captions and 0 names; tiles show artwork only and keep accessible labels and hover titles with the full path, for example "Basic Fire Energy, copy 1, Storage / Trade box".
- Names toggles on (14 names in a leaf, 44 in All owned). A Pokémon category filter (33 tiles) survived a reload with its active-filter dot; Clear filters restored 44 tiles and left Names and sort unchanged.
- Location creation (desktop, scripted DOM events): child of 151 display binder with "move into named child" (Page 1 holds all 22 copies; binder becomes a folder); with "separate Unsorted child" (Holos empty, Unsorted holds 22); the Unsorted name collision is rejected; submit without a choice is rejected; Cancel leaves the tree unchanged; a root Location (Shelf); a child of an empty leaf, with no conversion fieldset. Each success selected the new Location and expanded its ancestors. Changing parent to Trade box surfaced its 14-card choice; changing back removed it. Deck rows expose no Add child.
- Mobile 375×812 (real clicks): header Location control on the left, search, "Filters & display" on the right; no horizontal overflow; desktop sidebar hidden. The Location drawer is anchored left (0–340 px, full height) with root and child plus controls always visible at 36×44. Creating Rares under Trade box from the drawer moved 14 copies and selected Rares. The Filters & display drawer is anchored right (35–375 px) with Set, Category, Elemental type, Clear filters, Sort, Card size and Names. Names applied while the drawer was open and remained after Escape; focus returned to the opener.
- Undo across Location conversion: after moving 2 copies into 151 display binder, converting the binder (named child) left the newest Undo disabled as "Undo unavailable"; activating it changed nothing. In a second run, a Crimson flight → Psychic current Move followed by a binder → Trade box Move and then binder conversion left the newest Undo unavailable. Dismiss Undo exposed the earlier eligible Undo, which restored Crimson flight 5 / Psychic current 3 without touching the converted tree.
- Regression spot check: Charizard search, click plus Ctrl-click across 151 display binder and Trade box gave "2 selected · 1 editions · 2 locations" with selection-led inspection.
- Screenshots: [desktop toolbar with cross-source selection](toolbar-refinement-desktop.jpg), [Add child form](add-child-location-desktop.jpg), [mobile Location drawer](mobile-location-drawer.jpg), [mobile Filters & display drawer](mobile-filters-display-drawer.jpg).

**Not verified in this pass**

- Native drag and drop and real touch gestures (same harness limits as before).
- `npm run verify` (still needs `TEST_ADMIN_DATABASE_URL`).
- Inventory Removal was not re-run; that code was not changed, and the baseline checks above stand.
- Screen-reader output, contrast and full keyboard-only traversal.

**Observations for owner review — fixed 2026-10-10**

- At 800 px the sidebar truncated long names such as "151 dis…". The desktop child plus now overlays the row end on hover or focus instead of reserving width. The sidebar is 212 px at every desktop width (it was 180 px at 1100 px and below), and each name has a hover title. No sample name truncates at 800 px.
- The mobile Location drawer repeated its title. The drawer now drops the "LOCATIONS" label and keeps the root plus right-aligned under the "Locations" heading.
- The mobile Locations header control measured 36 px wide. It is now 44×44 px.
- Counts read "1 editions". Counts now use singular forms in the heading, selection bar, drag badge, inspector, Move and Removal dialogs and result messages, for example "1 selected · 1 edition · 1 location".
- Checked with `npx tsc`, `npm run build` (no prototype markers in `dist/`) and the browser at 800 px and 375×812 with sample data.

## Drag handle in Manage locations — 2026-10-11

At the owner's request, each row in Manage locations has a ☰ drag handle, which replaces whole-row dragging and the Move text button.

- Dragging the handle onto another row nests the Location there. Dragging it onto Top level, now shown on mobile too, moves it to the top level. Every drop opens the existing confirmation. Sibling order stays natural A–Z; dropping between rows does not set a position.
- The drag uses pointer events, so it works with touch as well as a mouse. A floating label with the Location's name follows the pointer, the lifted row dims, valid targets are outlined, and invalid ones (itself, descendants, Decks, the current parent) are dimmed and refuse the drop. The panel scrolls when you drag near its top or bottom edge.
- Tapping the handle without dragging, or activating it with Enter or Space, opens the Move picker. That keeps a non-drag path on every device.
- The handle is 32×40 px on desktop and 44×44 px on mobile, with `touch-action: none` so dragging it doesn't scroll the page.

Checked at 1280×860 and 375×812:

- A real mouse drag of Bulk box 10's handle onto Decks opened the "Decks / Bulk box 10" confirmation. This is the first real-mouse drag the harness has completed in this prototype.
- Scripted pointer events checked the rest: a tap opened the picker, keyboard activation opened the picker, and a touch drag onto a Deck showed the label with the Deck dimmed and Top level valid. Releasing on the Deck changed nothing and removed the label. A touch drag onto Top level and one onto 151 display binder confirmed, the latter with the 22-copy Unsorted conversion.
- On mobile the handle is 44×44 px with no horizontal overflow. Real finger input wasn't available; the touch checks used synthetic `pointerType: touch` events.
- Screenshot: [mobile handle drag](manage-locations-handle-drag-mobile.jpg).

**Open for later (owner, 2026-10-11):** the "Move here" confirmation button looks a bit odd next to "Choose another". It's not blocking; revisit with the visual system in [#47](https://github.com/ry-cen/prizecheck/issues/47).

## Full-width gallery — 2026-10-11

The app-wide stylesheet caps every `main` element at 900 px and centres it. The prototype's gallery inherited that cap, so wide screens showed a narrow centred column (2 small tiles per row at 1920 px). The gallery now overrides the cap and fills the width beside the sidebar, and its side padding shrinks on large screens: 30 px up to 1549 px, 20 px from 1550 px, and 16 px from 2200 px. Cards per row follow the available width at the same tile sizes. Production work must not inherit the global cap either.

Measured with small cards and sample data, with no horizontal overflow at any size:

| Viewport | Side padding | Tiles per row |
| --- | --- | --- |
| 375×812 | 14 px | 3 |
| 1024×768 | 20 px | 4 |
| 1280×860 | 30 px | 6 |
| 1920×1080 | 20 px | 11 |
| 2560×1440 | 16 px | 16 |

Screenshot: [1920 px gallery](full-width-gallery-1920.jpg). Desktop checks recorded earlier in this README ran with the cap in place, so they measured a narrower gallery.

## Larger marquee area — 2026-10-11

At the owner's request, a marquee can start from any empty part of the gallery area, not only the gaps inside the grid: the side margins, the gap beside the inspector and the space below the tiles. The grid's minimum height grows to the viewport. Presses on tiles, controls, the heading, toolbar, filters, inspector, selection bar or toast don't start a marquee. Hit-testing is unchanged and measured against the grid.

Checked at 1280×860 with real mouse drags: a drag starting in the left margin selected 4 tiles across 3 locations, and a reverse drag starting in the gap beside the inspector selected 2 tiles. A press on the toolbar left the selection unchanged, and a plain click on an unselected tile still selected exactly one.

## Manage locations panel — 2026-10-10

Supports [Decide drag and Location ordering](https://github.com/ry-cen/prizecheck/issues/46). The owner asked to see this panel before the decision is accepted. **Owner review pending.**

**What it shows**

- A settings gear next to the root plus beside LOCATIONS opens **Manage locations**. It is a centred panel on desktop and a full-screen sheet on mobile, where the gear is also in the Location drawer at 44×44 px.
- The panel lists the full tree. Each row has Rename, Move, Add child (not on Decks) and Delete. Delete is enabled only for an empty location with no children and asks you to type its name.
- Reparenting on desktop: drag a row onto another row to nest it, or onto the Top level zone. Valid targets are outlined; itself, its descendants, Decks and its current parent are dimmed and refuse the drop. Every drop opens a confirmation with the new path. A stocked Storage Leaf target explains that its cards move into a new Unsorted child.
- Move is the non-drag path, on desktop and the only one on mobile. It lists valid parents by full path (Top level first), then shows the same confirmation.
- Decks can be renamed and moved but never become parents. Add child from the panel uses the existing create form with the parent preselected, and Cancel or Create returns to the panel.
- Siblings sort naturally A–Z everywhere (sample Bulk box 2 before Bulk box 10). There is no stored order.
- No Location Undo. Card Undo records invalidated by a conversion keep the existing "Undo unavailable" behaviour.

**Measured — passed** (sample data, scripted DOM events)

- `npx tsc` and `npm run build` passed; `dist/` contains no panel markers.
- Desktop 1280×860:
  - Move Trade box → 151 display binder confirmed the 22-copy conversion; the binder became a folder containing Trade box and Unsorted (22).
  - Rename to a case-insensitive sibling duplicate was rejected, then a rename succeeded.
  - Delete rejected a wrong typed name, then deleted an empty leaf. Delete was disabled on stocked and parent rows.
  - Dragging Bulk box 10 marked Decks and Top level valid and Crimson flight and itself invalid. A Deck refused dragover; a drop on Decks confirmed and moved it, and a drop on Top level showed the top-level path.
  - Crimson flight's Move targets excluded Decks.
- Mobile 375×812: the panel fills the screen with no horizontal overflow; the drag hint and Top level zone are hidden; all action buttons are at least 44 px tall. Move Crimson flight → Top level worked. Add child from the panel preselected its parent, and Cancel returned to the panel.
- Screenshots: [desktop panel](manage-locations-desktop.jpg), [Move confirmation with conversion](manage-locations-move-confirm.jpg), [mobile sheet](manage-locations-mobile.jpg).

**Not verified**: native drag with a real mouse (synthetic drag events only), stale-version recovery (the sample has no server), screen reader output.

## Historical evidence

Variants A, B, and C, including the vertical-fan screenshots and selection checks, remain useful historical evidence. The fan-based Variant B interaction is superseded. The prior checks used sample data only and did not validate a production multi-source transaction, persistence, or full accessibility.

### Historical verification and routing

- `npm run check` and a production Vite build passed for the prototype. The development-only lazy import excluded prototype JS/CSS from the production build.
- Browser checks at desktop and mobile sizes covered the original three variants, search, sample button Moves/Undo, and the vertical-fan selection refinement. The native deck-to-storage drag automation was inconclusive; the corresponding button Move passed.
- A scoped worker built the variants; the primary integrated and browser-checked them. Initial Laya routing failed, and a later architect review found no static blocker for the historical prototype. The prototype code remains uncommitted in the isolated UI worktree.
- Historical screenshots include [Variant A](variant-a.jpg), [Variant B fanned copies](variant-b-fanned.jpg), and [three selected Charizard copies](vertical-fan-selected.jpg).

- The full regression gate was attempted on the earlier prototype checkout but could not pass preflight without `TEST_ADMIN_DATABASE_URL`. Current refinement checks on the `dev`-based worktree are recorded above.

## Boundaries

The current artifact does not change the quantity-based Holding model, create copy identities, write inventory, or establish a backend contract. Multi-source atomic operations remain pending in [atomic multi-source inventory operations](https://github.com/ry-cen/prizecheck/issues/49).
