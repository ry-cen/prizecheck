# Collection import — decision map

**Label:** wayfinder:map

**Status:** charted 2026-10-15; every ticket resolved 2026-10-15. The way is clear, ready for owner-invoked `/to-spec` and `/to-ticket`.

## Destination

An agreed plan, ready for owner-invoked `/to-spec` and `/to-ticket`, that lets a collector move in from another tracker by uploading that tracker's CSV export or pasting a text list, the way decklist import reads a paste. Every row is reviewed and saved as Holdings. This effort resolves decisions only. The spec at `docs/planning/collection-import/spec.md`, the implementation tickets and the code come after this map.

## Notes

- Owner request on 2026-10-15: collection import so people can move in from other trackers, which matters most once signup is public. It reverses the "Import/export" exclusion in the [MVP spec](../../tcg-collection-tracker/spec.md). The spec records that change in an ADR.
- **Not only CSV** (owner, 2026-10-15): pasted text is accepted too, read the same way decklist import reads a paste.
- **Additive move-in** (owner, charting): an import only adds copies. It never changes or removes existing Holdings, and it isn't a sync with the other tracker.
- **One landing leaf** (owner, charting): the collector picks one Storage Leaf for the whole import, Unsorted by default.
- **Build on decklist import** ([map](../../decklist-import/wayfinder/map.md) on `feature/decklist-import`): its parser, code-number-name matching, import-alias table and review step are the starting point. Don't redo [the set-code research](https://github.com/ry-cen/prizecheck/issues/200).
- Use grilling and domain-modeling for decision tickets, prototype for prototype tickets and research for research tickets. Use `CONTEXT.md` vocabulary (Collection Import, Holding, Card Edition, Variant Descriptor, Unspecified Variant, Storage Leaf, Unsorted) and record new terms there as they're resolved. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- **Trimmed** (owner, 2026-10-15): the review prototype shows one layout, built on decklist import's approved review. [Decide collection import limits](https://github.com/ry-cen/prizecheck/issues/222) is merged into [the contract](https://github.com/ry-cen/prizecheck/issues/224), which Claude settles, bringing the owner only collector-facing choices.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: collection import`, blocked with GitHub's native dependencies and a "Blocked by" body line. Research, prototypes and resolutions live beside this map. Work goes on `feature/collection-import`, cut from `dev`.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- [Research collection export formats from other trackers](https://github.com/ry-cen/prizecheck/issues/219): TCGplayer, Collectr (Pro), PriceCharting, TCG Collector (Premium), Dragon Shield and Sorted export CSVs. Dex+ columns are unconfirmed, and Pokellector has none. The shared key is set name plus number, with TCGplayer's Product ID as the strongest key for its own files. Naive set-name matching reaches 80–94% of rows. Files hold watchlist, sealed, other-game, Japanese and graded rows, and repeat copies. Real files run 92–3,178 rows, so decklist import's limits don't fit. [Findings](research/tracker-export-formats.md)
- [Decide what the import accepts](https://github.com/ry-cen/prizecheck/issues/220): header presets for the six exporting trackers plus a loose fallback for other CSVs, with no mapping screen and the source never named in the UI. One paste box reads a header as a file and anything else as decklist-style lines, then by name. File groups can be left out in the review but never become Locations. Uploads take CSV, TSV, TXT or a one-file zip. [Resolution](resolutions/decide-what-the-import-accepts.md)
- [Decide how imported rows match Card Editions](https://github.com/ry-cen/prizecheck/issues/221): Product ID, then set and number, then Basic Energy, then name within the set, through a new set-name alias table and a finish table per tracker. Non-card and non-English rows are left out with counts. Graded cards come in as ordinary copies. An unclear finish goes to the Unspecified Variant as Finish unknown, and name matches need one card in the row's set. Untracked columns are dropped quietly, and an import never starts a catalog pull. [Resolution](resolutions/decide-how-rows-match.md)
- [Prototype the collection import review](https://github.com/ry-cen/prizecheck/issues/223): decklist import's one-list review, opening on Needs you, with bulk finish and skip, the file's groups to leave out, left-out counts and downloads, and Save waiting only on Needs you. It starts from **Import…** in the Collection header or an empty Collection, and lands on the chosen Location. **No undo:** the review is the safety net. [Resolution](resolutions/prototype-collection-import-review.md)
- [Decide the collection import contract](https://github.com/ry-cen/prizecheck/issues/224) (with [limits](https://github.com/ry-cen/prizecheck/issues/222) merged in): one import holds at most 10,000 rows and 5 MB (owner). A server-held draft, one per collector for 24 hours, with paged rows, a batched changes call and downloads in the file's own columns. Saving is one idempotent transaction into the landing leaf. The 5 MB route is the only one above the gateway's normal limits, with zip-bomb guards and 20 drafts a day. The review is not a price access. The scope change is recorded in [ADR 0014](../../../adr/0014-collection-import-in-scope.md). [Resolution](resolutions/decide-collection-import-contract.md)

## Not yet specified

<!-- Nothing is waiting in the fog. The per-tracker how-to-export help and the launch evidence (which real exports prove the import before public signup) go straight into the spec, as the owner decided on 2026-10-15. -->

## Out of scope

- Exporting the Collection as CSV or text (owner, charting: import only).
- Ongoing sync or reconciling with another tracker.
- Importing Decks or Deck Lists from tracker files; decklist import covers Decks.
- Tracking condition, grading or purchase history (MVP exclusion stands).
- **Selection subtotal with coverage** is a separate effort, shelved during charting on 2026-10-15, and not part of this one.
