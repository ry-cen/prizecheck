# Resolution — Import and Want List behaviour

**Owner confirmed:** 2026-10-14, while charting the map

**Ticket:** [Decide the import and Want List behaviour](https://github.com/ry-cen/prizecheck/issues/198)

## Decision

### Decklist import

- **Destinations.** A pasted list either creates a new Deck or replaces an existing Deck's Deck List from that Deck's builder. When a replace drops cards the Deck holds, they become Surplus and use the existing Put away flow. There is no "add to list" merge; batch add covers adding a few cards.
- **Owned cards setting.** The import has a setting with two choices:
  - **Exact printings:** each line becomes the Printing it names, with the cheapest priced Edition chosen as add-by-Printing already does.
  - **Use cards I own:** copies you own are used first, starting with Editions of the exact Printing, then other Printings in the same Reprint Group. Only the remainder gets the cheapest Edition of the named Printing. For example, `4 Iono PAL 185` with 2 reverse-holo PAL 185 and 1 PAL 254 owned becomes 2 + 1 owned and 1 cheapest.
  
  Deck List lines stay one Card Edition each, so the Deck List model doesn't change.
- **Review before saving.** Every line is shown with its match and any substitution ("Used 1 Iono PAL 254 you own"). Unmatched or ambiguous lines are flagged, each with a search picker and Drop line. Basic Energy gets a default Edition you can change. A card missing from the catalog links to the Missing cards report. Save stays disabled until every line is resolved or dropped.
- **Copy to my Decks.** A Published Deck can be copied into your Decks through the same review step and setting, with its snapshot as the input instead of pasted text.

### Want List

- **Derived only.** The Want List is the Deck List lines a collector's Decks can't get from the Collection. You can't add to it directly; putting a card in a Deck is the only way. Binder and set-completion wants are out of scope.
- **Grouped by Deck, with a total.** Each Deck has a section of what it still needs. A combined total at the top, with its cost, is the shopping list.
- **Counting setting:**
  - **Every Deck built at once** (default): needs add together, and a spare copy counts toward one Deck at most.
  - **One Deck at a time:** each Deck counts every copy as available, including copies sleeved in other Decks, and the total takes the largest need per card.
- **Exact Editions, with a Swap hint.** Lines count by exact Card Edition, so the Want List agrees with the Pick List and Gather. When you own a spare playable version in the same Reprint Group, the line says so and offers Swap, which changes that Deck List line's Edition.

## Left to later tickets

How each part works under the hood (parsing, matching order, allocation, pricing) belongs to [Decide the import contract](https://github.com/ry-cen/prizecheck/issues/203) and [Decide the Want List contract](https://github.com/ry-cen/prizecheck/issues/204). The two settings are remembered per device, like the other display preferences, unless a later ticket finds a reason to tie them to the account.

*Amended by [the Want List contract](decide-want-list-contract.md):* the Want List counting setting lives on the Settings page and is stored on the account.

*Amended by [the import review step](prototype-import-review.md):* under **Exact printings**, copies of the named Printing that a replaced Deck already holds cover the line in their own Edition; only the rest gets the cheapest priced Edition. **Use cards I own** is the default the first time.

*Amended by [the import contract](decide-import-contract.md):* both settings use owned copies first, from the copies the Want List counting setting makes available: **Exact printings** copies of the named Printing in any Edition, **Use cards I own** copies of any Printing in its Reprint Group.
