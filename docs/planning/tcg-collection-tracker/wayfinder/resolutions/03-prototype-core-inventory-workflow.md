# Resolution — Prototype the core physical-inventory workflow

Variant F was approved as the interaction model. The prototype evidence is preserved at [Core inventory workflow](../prototypes/core-inventory-workflow/README.md).

## Decision

- The authenticated application opens on a **Locations** view modeled after an OS file browser. A Location tree is always available beside the selected Location’s contents on desktop and through an equivalent navigable surface on mobile.
- **Collection** remains a separate top-level view. It aggregates Card Editions across all storage Locations and links back into the relevant Location browser.
- Ordinary Locations derive their role from the tree:
  - A Location with children is organizational and cannot hold cards.
  - A Location without children is a storage leaf and can hold cards.
  - Moving or deleting the final child makes its parent an empty storage leaf again.
  - A Deck is always a storage leaf, may have an ordinary parent, and can never have children.
- Adding the first child beneath a stocked storage leaf invokes a guided atomic conversion. The user may move all Holdings to the named new child, create an `Unsorted` child for existing Holdings while also creating the named child, or cancel. Parent conversion, child creation, and Holding movement succeed or fail together.
- A storage leaf displays a dense thumbnail grid rather than a wide card list. Each persisted Holding appears as a compact collapsed thumbnail stack with its quantity, including low quantities.
- Hover and keyboard focus expose the Card Edition’s full name, printing, language, variant, quantity, and Location without expanding the grid row width.
- **Fan out** creates temporary one-thumbnail-per-copy selection handles for a Holding. These handles are UI-only and never become persistent physical-copy identities; persistence remains one fungible quantity per Card Edition and storage leaf.
- Users may select a whole stack, arbitrary fanned-out copies, multiple Card Editions, or all Holdings in the leaf. The interface continuously reports selected copy and Card Edition counts.
- Selection is the card-and-quantity review. The **Move** action asks only for a destination storage leaf, regardless of whether the selection contains one copy or many Card Editions. Choosing **Move here** performs one unrestricted all-or-nothing transfer.
- On desktop, dragging the current selection onto a valid storage leaf executes the same atomic transfer immediately without opening a dialog. Dragging onto an organizational Location, the current Location, or an invalid target makes no change.
- Button-driven and drag-driven moves show a success summary with **Undo** for the most recent move. Undo performs an inverse all-or-nothing transfer; if destination quantities have since changed incompatibly, Undo fails without partial changes.
- A stale or otherwise invalid move changes no quantities and keeps the affected thumbnails selected and highlighted so the user can recover.
- Drag-and-drop is optional. Keyboard and mobile users can complete the entire selection, destination, move, and Undo workflow without it.

## Consequences

- Direct-versus-descendant Holding labels are unnecessary because organizational Locations never hold cards.
- Bulk movement has no product-level Card Edition limit and must remain one atomic operation, favoring a relational transactional store over DynamoDB’s bounded transaction action count.
- The earlier row-based and review-heavy prototype variants remain only as comparison evidence; they are not implementation requirements.
