# Resolution — Drag and Location ordering

**Owner confirmed:** 2026-10-11

**Ticket:** [Decide drag and Location ordering](https://github.com/ry-cen/prizecheck/issues/46)

This resolution decides how the collector workspace orders, reparents, renames and deletes Locations. It keeps the card-selection rules in [collector workspace selection and presentation](29-decide-collector-workspace-selection-and-presentation.md) unchanged. The [collector workspace spec](../../../collector-workspace/spec.md) carries these decisions into implementation.

## Order

- Siblings sort automatically in natural A–Z order, so "Binder 2" comes before "Binder 10", case-insensitively. This applies everywhere a Location tree appears: the sidebar, the mobile Location drawer, the Move explorer and Manage locations.
- No order is stored and there are no reorder controls. Collectors who want a physical order can name Locations accordingly.
- Manual ordering was considered. It would need a stored sibling position, a reorder command with stale-anchor handling, and keyboard and touch alternatives. It can be added later on top of this without undoing anything.

## Where Location actions live

- A settings gear sits beside the root + next to the LOCATIONS heading, in the desktop sidebar and the mobile Location drawer. It opens **Manage locations**: a centred panel on desktop and a full-screen sheet on mobile.
- The panel lists the full tree. Each row shows the Location's name, its kind (Folder, Deck or copy count), and these actions: a ☰ drag handle, Rename, Add child (not on Decks) and Delete.
- The sidebar keeps the approved root + and per-row Add child + controls. Sidebar rows accept card drops only, never Location drags, so each surface has one drag meaning.
- There is no right-click menu and no Location menu in the gallery heading.

## Reparenting

- **Handle drag.** Drag a row by its ☰ handle onto another row to nest it there, or onto the Top level zone to move it to the top level. The drag works with mouse and touch. A floating label follows the pointer and the lifted row dims. Valid targets are outlined. The Location itself, its descendants, Decks, its current parent, and any target that would exceed 12 levels are dimmed and refuse the drop. The panel scrolls when dragging near its edges.
- **Non-drag path.** Tapping or clicking the handle without dragging, or activating it with Enter or Space, opens the Move picker. The picker lists valid parents by full path, Top level first.
- **Confirmation.** Every drop and every picker choice opens a confirmation showing the new full path. Nothing moves without it. If the target is a stocked Storage Leaf, the confirmation explains that its cards move into a new Unsorted child, which is the existing atomic conversion. Cancel and Choose another leave the tree unchanged.
- Dropping between rows does not set a position, because order is A–Z.

## Rename and delete

- Rename keeps the existing rules: 1–120 characters with no control characters, and unique among siblings after trimming and ignoring case.
- Delete keeps the existing rules: only an empty Location with no children, confirmed by typing its name. Removing the last child turns the former parent into an empty Storage Leaf.

## Decks

- Decks can be renamed and moved through Manage locations. They still can't have children or be a parent, and Deck checks are unaffected.
- This needs a backend change, because Decks currently reject Location edits with `DECK_REQUIRES_DECK_COMMAND`. The Deck command must keep the existing stale-version, name, depth and idempotency rules.
- Deleting a Deck was not decided here. The current API rejects it the same way, and a Deck may have Published Decks. Deck deletion stays out of scope until it is decided separately.
- The Decks page is unchanged apart from the Open in workspace link from the [prices revision](../../../collector-workspace/spec.md).

## Recovery

- There is no Undo for Location changes. A plain reparent is reversed by moving it back. Moves into a stocked leaf are already guarded by the confirmation.
- A stale version fails without changes, reloads the tree and shows a message. This is the existing behaviour.
- A Location change that invalidates a card Undo record keeps the existing "Undo unavailable" behaviour. Dismissing that record reaches older eligible records.

## Evidence

The [Manage locations prototype](../prototypes/collector-workspace/README.md#manage-locations-panel--2026-10-10) and its [drag-handle refinement](../prototypes/collector-workspace/README.md#drag-handle-in-manage-locations--2026-10-11) demonstrate these rules with sample data. The owner noted that the "Move here" confirmation button looks a bit odd; that is left for [Decide responsive visual system](https://github.com/ry-cen/prizecheck/issues/47).
