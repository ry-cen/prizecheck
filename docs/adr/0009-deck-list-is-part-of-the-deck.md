# A Deck List is part of the Deck, not a separate object

**Status:** accepted; planning decision, not yet implemented.

Collectors need to build decks that include cards they don't own. A Deck therefore stays a special Storage Leaf and gains a Deck List: the Card Editions and quantities the collector intends it to contain, whether owned, stored elsewhere, or not owned. A Deck's physical Holdings and its Deck List are two parts of one object.

## Considered options

- **A separate list object linked to an optional physical Deck.** Rejected because a list and its Deck would appear as two entries in the collector's Collection.
- **Wanted lines mixed in among a Deck's Holdings.** Rejected because it blurs inventory with intent inside a Storage Leaf.

## Consequences

- A planned deck with no cards yet is still a Deck in the Location tree.
- Moving a card into a Deck adds it to the Deck List if no line covers it. Editing a Deck List never moves physical cards; a confirmed Pick List does, as ordinary Moves.
- Deleting a Deck moves its Holdings to Unsorted rather than refusing like other non-empty Locations. Cards never disappear with a Deck List.
- A Published Deck snapshots the Deck List, so it may show cards the owner doesn't own. It remains live after its Deck is deleted until the owner revokes it. The current non-cascading reference from a publication to its Deck must change.
- Deck List lines always name a Card Edition. Lines that accept any Edition or any printing are left to a future card-request feature.

See the [resolution](../planning/deck-format-validation/wayfinder/resolutions/decide-deck-list-model.md) and [Decide how a Deck holds cards the collector doesn't own](https://github.com/ry-cen/tcg-tracker/issues/72).
