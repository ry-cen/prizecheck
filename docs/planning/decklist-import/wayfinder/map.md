# Decklist import and Want List — decision map

**Label:** wayfinder:map

**Status:** charted 2026-10-14.

## Destination

An agreed plan, ready for owner-invoked `/to-spec` and `/to-ticket`, for pasting a decklist (or copying a Published Deck) into a Deck, and for a private Want List derived from a collector's Deck Lists. This effort resolves decisions only. The spec at `docs/planning/decklist-import/spec.md`, the implementation tickets and the application code come after this map.

## Notes

- Owner request on 2026-10-14: build decklist import and a Want List, the top two follow-ups after the app redesign.
- This effort reverses the "Pasted or imported decklists from outside the app" exclusion in the [Deck Lists and format validation spec](../../deck-format-validation/spec.md).
- **Deck List lines stay one Card Edition each** (ADR 0009). "Any printing" lines are not introduced: import and the Want List both resolve to Editions, and Reprint Groups supply "the same card" where it matters.
- Reuse what exists: add-by-Printing's cheapest-Edition rule, the Pick List, Gather, Surplus and Put away, the Missing cards report, Estimated Deck Cost and Mass Entry exports.
- Use grilling and domain-modeling for decision tickets, prototype for prototype tickets and research for research tickets. Use `CONTEXT.md` vocabulary (Deck, Deck List, Pick List, Reprint Group, Card Edition, Want List) and record new terms there as they are resolved. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: decklist import`, blocked with GitHub's native dependencies and a "Blocked by" body line. Prototypes, research and resolutions live beside this map.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- [Decide the import and Want List behaviour](https://github.com/ry-cen/prizecheck/issues/198): import creates a new Deck or replaces a Deck's list (drops go to Surplus) through a review step that must resolve every line; an **Exact printings** / **Use cards I own** setting decides whether owned copies in the Reprint Group are used first; Copy to my Decks reuses it for Published Decks. The Want List is derived only, grouped by Deck with a priced total, counts exact Editions with a Swap hint, and has an **Every Deck built at once** / **One Deck at a time** setting. [Resolution](resolutions/decide-import-and-want-list-behaviour.md)
- [Research decklist text formats](https://github.com/ry-cen/prizecheck/issues/199): TCG Live headers count lines and Limitless headers count cards, so the parser treats headers as section breaks only and counts lines itself. Limitless rewrites promos (`PR-SV`), galleries (`CRZ-GG 25`) and older Basic Energy (`Energy 31`). No paste carries a format marker, so a Target Format can only be inferred. Nine fixtures; Live's `PH`/`SVALT` and line endings are unconfirmed. [Findings](research/decklist-text-formats.md)
- [Research how set codes map to the catalog](https://github.com/ry-cen/prizecheck/issues/200): the catalog keeps only TCGdex set IDs and `localId`; today's search resolves 18,615 of 20,639 Limitless code and number pairs, and a checked-in import-alias table on top of `api/app/set_codes.tsv` would reach 3,031 of 3,037 non-Energy Standard Printings. ALT IDs, letter-suffix prints, unimported new cards and manual Printings still fail; a name alone picks one Reprint Group for every Standard Trainer but only half of Pokémon. [Findings](research/set-code-mapping.md)
- [Prototype the Want List page](https://github.com/ry-cen/prizecheck/issues/201): the Want List is a My Decks / Want List view inside Decks, and a Deck card opens it scoped to that Deck; **Buy on TCGplayer** exports what is showing under the counting setting; Swap splits a line; the deck builder's "to complete" and Buy missing now follow the counting setting. [Resolution](resolutions/prototype-want-list.md)
- [Decide the Want List contract](https://github.com/ry-cen/prizecheck/issues/204): spare copies are loose copies and Surplus; under **Every Deck built at once** each Deck counts its own copies, then spares go to the oldest Deck first, so the sections add up to the total. Every place that shows a Deck's need follows the counting setting, which moves to a new Settings page (replacing Sign-ins) and is stored on the account. One Want List read, a separate cost request under ADR 0006, a scoped Mass Entry export, and Swap as one Deck List changes batch. [Resolution](resolutions/decide-want-list-contract.md)

## Not yet specified

<!-- Nothing is waiting in the fog: every open question is a ticket. -->

## Out of scope

- Binder, set-completion or other wants that aren't for a Deck; the Want List is derived only.
- Sharing the Want List, or requesting cards from other collectors.
- Importing a whole collection, and export formats beyond the existing ones.
- Identity-level ("any printing") Deck List lines.
