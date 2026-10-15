# Decide what the import accepts

**Ticket:** [Decide what the import accepts](https://github.com/ry-cen/prizecheck/issues/220)
**Resolved:** 2026-10-15, with the owner. It builds on [the export research](../research/tracker-export-formats.md).

## Owner decisions

- **Six presets and a loose fallback.** The import recognises the export headers of the TCGplayer app, Collectr (14 and 16 columns), PriceCharting, TCG Collector, Dragon Shield and Sorted. Any other CSV gets a loose fallback that looks for columns named like name, set, number, quantity and finish. When it can't find enough of them, the import says which tracker files it reads. There's no column-mapping screen.
- **Silent detection.** The source tracker is detected from the header and never named in the UI, and the collector picks nothing. The review shows only rows.
- **One paste box for rows or lines.**
  - If the first line is a recognised header (comma- or tab-separated, as copied from a spreadsheet), the paste is read like a file.
  - Otherwise each line is read with decklist import's line grammar (`3 Pikachu SVI 25`, `2x …`).
  - A line with only a name, or a name and set, goes to the name fallback, and lands in Needs you when it's unclear.
- **Groups the collector can leave out.** Collectr portfolios, PriceCharting folders and Sorted folders or lists are read as groups. The review lists a file's groups, all included by default, and the collector can leave any out. Every included copy still lands in the one chosen Storage Leaf, and groups never become Locations.
- **File types.** `.csv`, `.tsv` and `.txt`, and a `.zip` holding exactly one of those (PriceCharting emails its export zipped). No Excel files.

## Technical calls (delegated to Claude)

- A recognised header always wins over the loose fallback. Collectr's dated price column is matched by prefix, and a leading `"sep=,"` line is skipped.
- The loose fallback also recognises a Product ID column. That covers the TCGplayer previous-app `legacy_data.csv` until a real file confirms its header, at which point it gets a preset.
- TCGplayer's plain-text email export goes through the paste line reader, because its grammar is unconfirmed.
- Dex+ exports go through the loose fallback until their columns are confirmed.
- Text is decoded as UTF-8 (a BOM is dropped), falling back to Windows-1252 for files re-saved in Excel. Line endings and quoting follow standard CSV, and the decklist normalisation (NBSP, zero-width spaces, NFC, curly apostrophes) applies to every cell.

## Hand-offs

- [Prototype the collection import review](https://github.com/ry-cen/prizecheck/issues/223): how the list of groups to leave out looks, and how a paste that mixes readable and unreadable lines is shown.
- [Decide how imported rows match Card Editions](https://github.com/ry-cen/prizecheck/issues/221): what the loose fallback's columns feed into, and the name fallback for free-text lines.
- [Decide collection import limits](https://github.com/ry-cen/prizecheck/issues/222): size limits apply to the unzipped content.
