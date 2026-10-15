# Resolution — Import review step

**Owner confirmed:** 2026-10-14, after reviewing the prototype

**Ticket:** [Prototype the import review step](https://github.com/ry-cen/prizecheck/issues/202)

**Prototype:** [Import review prototype](../prototypes/import-review/README.md)

**Builds on:** [the import and Want List behaviour](decide-import-and-want-list-behaviour.md).

## Decision

### Where the import starts

- **New Deck:** Decks has **Import a list** beside Create Deck.
- **Replace:** the deck builder's header has **Replace list…** beside Export, Publish and Delete.
- **Copy to my Decks:** a Published Deck's page has **Copy to my Decks**. It only creates a new Deck, named after the Published Deck, and the name can be edited. To replace one of your Decks' lists with a published list, paste the Published Deck's **Export** text into Replace list….

### The paste screen

- **What it holds:** the text box and the destination only:
  - **a new Deck:** its name (required) and Target Format;
  - **from the builder:** Replace this Deck's list.

  Copy to my Decks shows the snapshot instead of a text box.
- **The count:** a live count of card lines and cards, worked out from the lines. Header numbers are never shown or checked.
- **Ignored text:** lines without a leading quantity (prose, `Total Cards`, `******`) are ignored. The review lists them in a collapsed panel.

### The review: one list (variant A)

- **The list.** Pokémon, Trainer and Energy sections in paste order. Each line shows the matched card, the pasted text, and the Deck List lines it becomes, one Card Edition each. A pasted line can become several Deck List lines: "Used 1 Iono PAL 185 · Reverse Holo you own", "Used 1 Iono PAL 254 · Holo you own", then "1 PAL 185 · cheapest priced".
- **Filter chips.** **All / Needs you / Changed / Dropped**. The review opens on **Needs you** whenever there are lines to resolve.
- **Problems expand inline.** **Pick one**, **Not found** and **Can't read** each open a resolver:
  - a catalog search with candidates;
  - **Drop line**;
  - "Report … on Missing cards" for a card not in the catalog.

  Dropped lines can be restored.
- **Basic Energy** that names no catalog Printing is matched by type to a default Edition, with **Change**. Any resolved line's **Edition** opens its Editions with prices.
- **Copies another Deck covers.** A line notes them ("4 in Charizard ex stay there: they're that Deck's own"). Only Spare Copies and the replaced Deck's own copies are used.
- **The side column** is sticky on desktop and stacks above the list on phones. It holds:
  - the totals: cards (with "not 60" when it isn't), cards you own, and cards to get with their cost and unpriced count;
  - the owned-cards setting;
  - the destination;
  - for Replace, **Will become Surplus**.
- **No legality warnings.** The review shows only the card count. The format check stays in the builder.
- **Save.** **Create Deck** or **Replace Deck List** stays disabled, showing "N lines to resolve", until every flagged line is picked or dropped.

### The owned-cards setting

- **It lives in the review's side column only.** Switching it recounts every line and the Surplus preview live. The paste screen doesn't have it.
- **Use cards I own is the default** the first time. After that, each device remembers the choice, as the behaviour resolution set.
- **Exact printings never substitutes another Printing.** Copies of the named Printing that the replaced Deck already holds cover the line in their own Edition. Only the rest of the line gets the cheapest priced Edition. For example, a Deck holding 2 Arven SVI 166 Reverse Holo keeps them for a pasted `2 Arven SVI 166`. Copies of other Printings, and Spare Copies elsewhere, are used only under **Use cards I own**.

### Lines without a set code

A line with a quantity and a name but no set code (a hand-typed `4 Iono`) is **Can't read** until the collector picks a card or drops the line. It isn't matched by name automatically, even for a Trainer whose name names one card.

### After saving

Every flow (New, Replace and Copy) lands in the Deck's builder with an Undo toast. The next steps are already there: Gather, Buy missing, and Put away all for anything a Replace made Surplus. Undo removes a new Deck, or restores the replaced Deck List.

### Replace and Surplus

The review's **Will become Surplus** lists the Deck's held copies that the new list doesn't cover. They stay in the Deck as Surplus, and nothing moves on save. The builder's Surplus group and **Put away all** take over from there.

## Variants not taken forward

- **B — Paste beside the Deck List.** The pasted text and the resulting Deck List side by side, as tabs on phones. It showed line splits clearly but separated the two halves on phones.
- **C — Problems first.** A one-at-a-time stepper with everything else in collapsed groups. Its "problems first" carries over into A as the opening **Needs you** filter.

## Changes to earlier decisions

- **[The import and Want List behaviour](decide-import-and-want-list-behaviour.md).** Exact printings is sharpened: it keeps the replaced Deck's held copies of the named Printing in their own Edition, rather than always using the cheapest priced Edition.

## Left to Decide the import contract

The prototype used placeholders for these. [Decide the import contract](https://github.com/ry-cen/prizecheck/issues/203) settles them:

- **`PH`:** which Edition a `PH` line picks. The prototype picks Reverse Holo.
- **Target Format:** whether anything in a paste sets a new Deck's Target Format. The prototype defaults to Standard.
- **Matching order.** The prototype matches code and number first, then Basic Energy by type, then name when a code fails. Names are never used for lines without a code.
- **Use cards I own:** the allocation order, and which owned Edition wins when several are spare.
- **Exact printings on a new Deck:** whether it uses owned copies of the named Printing's Editions. The decision above covers a replaced Deck's own copies.
