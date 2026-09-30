# Decide the core Collection, Location, and Deck interaction contract

**Parent:** [Decision-complete Pokémon TCG Collection Tracker MVP](../map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Prototype resolution:** [Approved file-browser interaction contract](../resolutions/03-prototype-core-inventory-workflow.md)

**Resolution:** [Core Collection, Location, and Deck interaction contract](../resolutions/08-decide-core-interaction-contract.md)

**Blocked by:** [Prototype the core physical-inventory workflow](03-prototype-core-inventory-workflow.md).

## Question

After reviewing the interactive prototype, which navigation model, primary screens, quantity-edit behavior, transfer flow, direct-versus-descendant presentation, mobile behavior, empty states, and destructive-action safeguards become binding UX requirements for the MVP?

## Decisions in progress

- Quantity changes use explicit physical-inventory actions rather than inline numeric editing. Add copies selects a Card Edition and positive quantity for the current storage leaf; Move transfers selected copies to another storage leaf; Inventory Removal takes selected copies out of the tracked Collection.
- Inventory Removal operates on selected stacks or fanned-out copies, shows a concise destructive confirmation, and offers Undo after success. Move remains destination-only with no confirmation and also offers Undo.
- Creating an account atomically creates one storage leaf named `Unsorted` and opens it in the Locations view. Its empty state offers Add cards, catalog search, and Rename this Location so a collector can begin without first designing a hierarchy.
- `Unsorted` is an ordinary user-owned Location after creation: it can be renamed, moved, or deleted once empty.
- Location deletion is non-recursive and allowed only when the Location has no Holdings and no children. A named confirmation is required. When deletion is blocked, the interface identifies whether Holdings or child Locations remain and links to the content that must be moved first.
- On mobile, the current Location appears as a breadcrumb with a Locations button that opens the tree in a full-screen drawer. Tapping a card stack normally opens details; a visible Select action enters selection mode, where taps select stacks or fanned-out copies. Move opens a destination picker as a bottom sheet. Hover and drag-and-drop are not required on touch devices, and every operation remains available through buttons.
- Authenticated navigation has three top-level views: Locations, Collection, and Decks. Locations is the default physical-storage browser; Collection aggregates every owned Card Edition; Decks indexes Deck Locations with card count, construction-check status, and sharing status. Opening a Deck uses the same thumbnail-based storage interface with deck validation and publishing controls added.
