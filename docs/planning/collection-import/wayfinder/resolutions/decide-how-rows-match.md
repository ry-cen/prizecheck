# Decide how imported rows match Card Editions

**Ticket:** [Decide how imported rows match Card Editions](https://github.com/ry-cen/prizecheck/issues/221)
**Resolved:** 2026-10-15, with the owner. It builds on [the export research](../research/tracker-export-formats.md), [what the import accepts](decide-what-the-import-accepts.md) and decklist import's [import contract](../../../decklist-import/wayfinder/resolutions/decide-import-contract.md) on `feature/decklist-import`.

## Owner decisions

- **Rows we can't hold are left out, with counts.** Watchlist rows, sealed product, other games and non-English cards never reach Needs you. The review shows one summary of what was left out and why (for example "9 on a watchlist, 3 sealed products, 12 from other games, 40 non-English cards"), and those rows can be viewed or downloaded. Nothing is lost silently.
- **Graded cards come in as ordinary copies.** A graded row imports as a copy of its Card Edition, and the grade is dropped.
- **An unclear finish doesn't block saving.** When the card is clear but the finish word is blank or unknown and the card has more than one Edition, the row matches the card's Unspecified Variant and is marked **Finish unknown**. The collector can pick the finish in the review, or later. When the card has only one Edition, that Edition is used.
- **A name match must be one card in the row's set.** If the number fails but the row's set holds exactly one card with that name, the row is **Matched by name** and doesn't block saving. Without a set, or with several candidates, it goes to Needs you with the choices. A Printing is never guessed across sets, unlike decklist import's newest-Printing rule.
- **Columns we don't track are dropped quietly.** Condition, price paid, purchase date and notes are ignored. The upload page says what PrizeCheck keeps (the card, its finish and the quantity), and nothing is said per row.

## Technical calls (delegated to Claude)

### Matching order

The first step that answers wins.

1. **TCGplayer Product ID**, when the row has one. The Product ID resolves to a Printing through a verified Marketplace Mapping, or else through TCGdex's TCGplayer ID kept in the catalog generation. The `Printing` column then picks the Edition through the finish table.
2. **Set and number.**
   - **The set** resolves through the new collection set-name alias table, keyed by tracker and set name. Dragon Shield and Sorted codes try `set_codes.tsv` first.
   - **The number** loses any denominator (`042/102`, `TG01/TG30`, `SV032/SV122`, `040 / 096`). It then gets the alias table's number rules (`037/DP-P`, `012VL`, PriceCharting's `#SWSH138`) and is compared with `NUMBER_KEY`.
3. **Basic Energy by type,** for Energy rows with no usable number, as in decklist import.
4. **Name within the row's set,** with decklist import's name normalisation and optional parenthetical subtitles. One candidate gives **Matched by name**. Several, or no set, give Needs you.
5. Otherwise the row is **Not found** and waits in Needs you, with a catalog search to pick the card or skip the row. **An import never starts a catalog pull**, because pulls stay owner-only ([ADR 0003](../../../../adr/0003-on-demand-catalog-imports.md)).

### Tables and rules

- **The collection set-name alias table** is a new checked-in table, separate from decklist import's `import_aliases.tsv`. It maps (tracker, set name) to a TCGdex set ID, and each row cites the export or source that shows it. Naive normalisation goes first (lowercase, punctuation stripped, prefixes like `SV01:` and `SM -` removed), and the table holds only what that misses: promo, catch-all and Energy sets.
- **The finish table** is one table per tracker. It maps finish columns (`Printing`, `Variance`, `Card variant`, PriceCharting's `[Variant]`) and name tags (`(Cosmos Holo)`, `(Poke Ball Pattern)`, stamps, `1st Edition`) to a Variant Descriptor. Anything it doesn't cover goes to Finish unknown.
- **The filters** report every row they leave out:
  - **watchlist:** Collectr's `Watchlist = true`;
  - **sealed:** a blank number together with a blank rarity, or a sealed product name;
  - **other games:** Collectr's `Category`, PriceCharting's `console-name` and Sorted's `Collection`;
  - **non-English:** a language column, the `(JP)` and `(CN)` tags, a Japanese or Chinese PriceCharting `console-name`, and Dragon Shield sets that exist only in Japan.

  Graded rows are kept.
- **Quantities:**
  - a blank quantity counts as 1 on a non-watchlist row;
  - a zero or non-integer quantity is **Can't read**;
  - rows that resolve to the same Edition, after a fix in the review, are added together into one Holding increment in the landing leaf.

## Hand-offs

- [Prototype the collection import review](https://github.com/ry-cen/prizecheck/issues/223): the left-out summary; the Finish unknown marking and how a finish is picked, one row at a time or in bulk; Matched by name; and Not found with its catalog search.
- [Decide collection import limits](https://github.com/ry-cen/prizecheck/issues/222): imports never start catalog pulls, so no limit on pulls is needed.
