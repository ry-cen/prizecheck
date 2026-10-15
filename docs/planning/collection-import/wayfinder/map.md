# Collection import — decision map

**Label:** wayfinder:map

**Status:** charted 2026-10-15.

## Destination

An agreed plan, ready for owner-invoked `/to-spec` and `/to-ticket`, that lets a collector move in from another tracker by uploading that tracker's CSV export or pasting a text list, the way decklist import reads a paste. Every row is reviewed and saved as Holdings. This effort resolves decisions only. The spec at `docs/planning/collection-import/spec.md`, the implementation tickets and the code come after this map.

## Notes

- Owner request on 2026-10-15: collection import so people can move in from other trackers, which matters most once signup is public. It reverses the "Import/export" exclusion in the [MVP spec](../../tcg-collection-tracker/spec.md). The spec records that change in an ADR.
- **Not only CSV** (owner, 2026-10-15): pasted text is accepted too, read the same way decklist import reads a paste.
- **Additive move-in** (owner, charting): an import only adds copies. It never changes or removes existing Holdings, and it isn't a sync with the other tracker.
- **One landing leaf** (owner, charting): the collector picks one Storage Leaf for the whole import, Unsorted by default.
- **Build on decklist import** ([map](../../decklist-import/wayfinder/map.md) on `feature/decklist-import`): its parser, code-number-name matching, import-alias table and review step are the starting point. Don't redo [the set-code research](https://github.com/ry-cen/prizecheck/issues/200).
- Use grilling and domain-modeling for decision tickets, prototype for prototype tickets and research for research tickets. Use `CONTEXT.md` vocabulary (Collection Import, Holding, Card Edition, Variant Descriptor, Unspecified Variant, Storage Leaf, Unsorted) and record new terms there as they're resolved. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: collection import`, blocked with GitHub's native dependencies and a "Blocked by" body line. Research, prototypes and resolutions live beside this map. Work goes on `feature/collection-import`, cut from `dev`.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- [Research collection export formats from other trackers](https://github.com/ry-cen/prizecheck/issues/219): TCGplayer, Collectr (Pro), PriceCharting, TCG Collector (Premium), Dragon Shield and Sorted export CSVs. Dex+ columns are unconfirmed, and Pokellector has none. The shared key is set name plus number, with TCGplayer's Product ID as the strongest key for its own files. Naive set-name matching reaches 80–94% of rows. Files hold watchlist, sealed, other-game, Japanese and graded rows, and repeat copies. Real files run 92–3,178 rows, so decklist import's limits don't fit. [Findings](research/tracker-export-formats.md)

## Not yet specified

- Condition, grade and price-paid columns: whether any of them ever becomes something we track, beyond being dropped. This waits on [what the import accepts](https://github.com/ry-cen/prizecheck/issues/220) and [how rows match](https://github.com/ry-cen/prizecheck/issues/221).
- Collector-facing help: how-to-export instructions per tracker, and where they live.
- Launch evidence: which real exports prove the import before public signup.

## Out of scope

- Exporting the Collection as CSV or text (owner, charting: import only).
- Ongoing sync or reconciling with another tracker.
- Importing Decks or Deck Lists from tracker files; decklist import covers Decks.
- Tracking condition, grading or purchase history (MVP exclusion stands).
- **Selection subtotal with coverage** is a separate effort, shelved during charting on 2026-10-15, and not part of this one.
