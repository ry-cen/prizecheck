# Resolution: Decide how a Deck holds cards the collector doesn't own

**Ticket:** [Decide how a Deck holds cards the collector doesn't own](https://github.com/ry-cen/prizecheck/issues/72)

**Resolved:** 2026-10-10, grilled with the owner.

## Decision

A Deck stays a special kind of Location (a Storage Leaf) and gains a **Deck List**. The two are one object, not two linked ones.

- **Holdings** are the cards physically in the Deck, unchanged from today.
- **Deck List** is the part of the Deck that names its intended cards and quantities. Its lines may be owned, stored elsewhere, or not owned at all. It never counts toward the Collection.
- A planned deck that holds no cards is a Deck with empty Holdings. It appears once in the Location tree, like any Deck. There is never a separate list object beside a Deck Location.

The owner rejected a separate "Deck Plan" object and a link between a list and a Deck, because a list and a Deck must not appear as two things in the Collection.

## Deck List lines

- Every line names one Card Edition and a quantity. "Any Edition of this Printing" is not allowed now; a future request network may add it.
- **Cheapest-Edition default.** If a card is added by Card Printing alone, the app chooses the Printing's cheapest priced Edition at that moment and stores it. The choice is never re-resolved when prices change.
  - If no Edition has a price, it falls back to the first Edition in catalog order.
  - A Printing with only an Unspecified Variant Edition uses that Edition.
  - The response says which rule chose the Edition. That isn't stored.
- **Ownership states.** Each line shows three states, computed from Holdings and never stored:
  - *in this Deck*: present in the Deck's Holdings;
  - *elsewhere*: in another Location of the Collection, named;
  - *not owned*.

  Several Decks may want the same spare copies. The app warns about the competition. Nothing is reserved.

## Keeping Holdings and Deck List in step

- Moving a card into a Deck adds it to the Deck List if no line covers it. A later cut can leave surplus copies; see [the migration resolution](decide-deck-list-migration.md).
- Moving a card out leaves its line, which then shows *elsewhere* or *not owned*.
- Editing a Deck List never moves physical cards on its own.
- **Pick List.** For a Deck, this is the cards in its Deck List that are elsewhere in the Collection, each with a suggested source Location.
  - Suggestions take loose storage (non-Deck Storage Leaves) first, using the fewest Locations.
  - Copies in other Decks are suggested only when loose storage runs out, with a warning that taking them leaves that Deck short.
  - The collector can change any suggested source.
  - Confirming one row, a selection, or all rows performs normal Moves into the Deck.

## Deletion and publishing

- Deleting a Deck moves all its Holdings to Unsorted and discards its Deck List. Today a non-empty Location cannot be deleted, so this is a new behavior for Decks.
- A **Published Deck** is a snapshot of a Deck's Deck List, so it can include cards the owner doesn't own. It does not depend on the Deck's physical cards.
  - Deleting the source Deck leaves an active Published Deck live, and the owner can revoke it later.
  - Today `deck_publication.deck_id` references the Location with no deletion rule, so the spec must change that relationship.
- Existing Published Deck snapshots remain valid; their rows are frozen.

## Scope

The map's destination widens to **Deck Lists and format validation**, one spec. Format checks run on a Deck List's lines, using each line's Edition's Printing. A follow-up ticket covers converting existing Decks, and how construction checks, Deck cost and exports read Deck Lists.

A social request network built on *not owned* lines is a future effort, out of scope for this map. The design above must not rule it out.
