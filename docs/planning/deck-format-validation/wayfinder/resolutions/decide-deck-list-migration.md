# Resolution: Decide how existing Decks and Deck features move onto Deck Lists

**Ticket:** [Decide how existing Decks and Deck features move onto Deck Lists](https://github.com/ry-cen/tcg-tracker/issues/76)

**Resolved:** 2026-10-10, grilled with the owner.

**Builds on:** [Deck List model](decide-deck-list-model.md), [ADR 0009](../../../../adr/0009-deck-list-is-part-of-the-deck.md).

Today every Deck feature (construction checks, private Deck cost, both exports, publishing) reads the Deck's Holdings through one capture. Each feature now reads the Deck List as described below.

## Existing Decks

A one-time conversion gives each existing Deck one Deck List line per Card Edition it holds, with the held quantity. A Holding of an Unspecified Variant Edition becomes a line naming that same Edition. After conversion every line is *in this Deck*.

## Construction and format checks

The 60-card and copy-limit checks read the Deck List, like format checks. Checks describe the intended deck; ownership states and the Pick List describe whether the collector physically has it.

## Cutting a card that is still in the Deck

A collector may lower or remove a Deck List line below the copies the Deck holds. The surplus copies show a fourth state, *in Deck but not on the list*, with a suggestion to put them away. Putting them away is a Move to a Location the collector chooses, the reverse of the Pick List.

Moving a card into a Deck still extends the Deck List. This amends the [Deck List model](decide-deck-list-model.md): the Deck List covers what is moved in, but a later cut can leave surplus.

## Private Deck cost

Two figures, both using the existing quantity-weighted coverage, with unknown prices never counted as $0:
- **Deck List cost:** every line.
- **Cost to complete:** *not owned* lines only. Copies *elsewhere* cost nothing, since they would be moved in rather than bought.

## Exports

- **Pokémon TCG Live** exports the whole Deck List.
- **TCGplayer Mass Entry** offers the *not owned* lines (the default) or the whole Deck List.

## Published Decks

- Publishing snapshots the Deck List. Existing snapshots are already Card Edition and quantity rows and stay valid unchanged.
- While its Deck exists, a Deck keeps at most one active publication.
- When the Deck is deleted, the publication keeps its owner and drops its link to the Deck. It stays live and is managed through an owner route keyed by its public token, for revoking it or changing its visibility. It cannot be republished, because no Deck List remains to snapshot.
- Today `deck_publication.deck_id` is required and revoke and visibility routes are keyed by Deck, so both must change.
