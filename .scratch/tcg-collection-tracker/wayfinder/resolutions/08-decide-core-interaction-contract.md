# Resolution — Core Collection, Location, and Deck interaction contract

The approved [file-browser prototype resolution](03-prototype-core-inventory-workflow.md) is binding, with the additions below.

## Navigation and screens

- Authenticated navigation has three top-level views: **Locations**, **Collection**, and **Decks**.
- Locations is the default view and behaves like an OS file browser. Desktop keeps the Location tree beside the selected Location's contents.
- Collection aggregates each owned Card Edition across all storage leaves and links to the Locations containing its copies. Collection is a view, not a container.
- Decks indexes Deck Locations and shows each Deck's card count, construction-check status, and sharing status. Opening a Deck uses the normal storage-leaf thumbnail interface with validation and publishing controls added.

## Location and Holding presentation

- An ordinary Location with children is organizational and cannot contain Holdings. An ordinary Location without children is a storage leaf and may contain Holdings. A Deck is always a storage leaf and cannot have children.
- Adding the first child beneath a stocked storage leaf uses the prototype's guided atomic conversion: move Holdings to the named child, create an `Unsorted` child for existing Holdings plus the named child, or cancel.
- Storage leaves use a dense thumbnail grid. Each Holding is a collapsed thumbnail stack with a visible quantity, including low quantities. Hover, keyboard focus, or card details show the name, Printing, variant, quantity, and Location.
- Fan out creates temporary one-thumbnail-per-copy selection handles without creating persistent copy identities.

## Selection, movement, and quantity changes

- Users may select stacks, arbitrary fanned-out copies, multiple Card Editions, or all Holdings in a storage leaf. The interface reports selected copy and Edition counts.
- Move asks only for a destination storage leaf and performs one unrestricted all-or-nothing transfer. Desktop drag to a valid destination performs the same transfer immediately without a dialog; invalid targets make no change.
- Add copies selects a Card Edition and positive quantity for the current storage leaf.
- Inventory Removal takes selected copies out of the tracked Collection. It is distinct from Move, requires a concise destructive confirmation, and offers Undo.
- Move and Inventory Removal show a success summary with Undo. A failed or stale operation changes nothing and retains the affected selection for recovery.
- Inline numeric quantity editing is not part of the MVP.

## Onboarding and empty states

- Account creation atomically creates one ordinary storage leaf named `Unsorted` and opens it in Locations.
- Its empty state offers Add cards, catalog search, and Rename this Location. `Unsorted` may later be renamed, moved, or deleted once empty.
- Empty storage leaves direct the user to add cards or create a child. Empty Collection directs the user to `Unsorted` and catalog search. An empty Decks index offers Create Deck.

## Mobile and accessibility

- Mobile shows the current Location as a breadcrumb and opens the tree from a Locations button in a full-screen drawer.
- Tapping a stack normally opens details. A visible Select action enters selection mode; taps then select stacks or fanned-out copies. Move uses a destination bottom sheet.
- Drag-and-drop and hover are optional enhancements. Every workflow is available through visible controls, keyboard interaction, and touch.

## Destructive safeguards

- Location deletion is non-recursive and allowed only when the Location has no Holdings and no children. A named confirmation is required.
- When deletion is blocked, the interface identifies Holdings or child Locations and links to what must be moved first.
- Deleting or moving the final child converts its parent into an empty storage leaf. No recursive card or Location deletion exists in the MVP.
