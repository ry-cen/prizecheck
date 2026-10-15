# Collection import review prototype

This prototype supports [Prototype the collection import review](https://github.com/ry-cen/prizecheck/issues/223). It's design evidence only, not production code. It follows [what the import accepts](../../resolutions/decide-what-the-import-accepts.md) and [how rows match](../../resolutions/decide-how-rows-match.md). It has one layout, because the owner trimmed the map to one. That layout is decklist import's approved review (variant A of its [import review prototype](../../../../decklist-import/wayfinder/prototypes/import-review/README.md) on `feature/decklist-import`), adapted for files of thousands of rows.

## How to run it

The prototype is one self-contained page, [`index.html`](index.html). It uses vanilla JavaScript, keeps its data in memory and saves nothing, and takes its colours and spacing from `web/src/tokens.css`. Serve the repository root:

```bash
python3 -m http.server 5193 --bind 127.0.0.1
```

Then open `http://127.0.0.1:5193/docs/planning/collection-import/wayfinder/prototypes/import-review/index.html`.

- **The purple bar** jumps between screens (Collection, Import, Review, After saving).
- **Empty Collection** shows the first-time Collection.
- **Phone frame** shows the phone layout.
- **The URL** reads and writes `?screen=start|import|review|done`, `&empty=1` and `&frame=phone`.

## The flow

1. **Collection:** the header has **Import…** beside Add cards. An empty Collection offers **Import from another tracker**.
2. **Import:**
   - **Upload a file** (CSV, TSV or TXT, or a zip holding one) or **Paste**.
   - **Put cards in:** one Storage Leaf, Unsorted by default.
   - A line saying what PrizeCheck keeps (each card, its finish and how many), and a collapsed **How do I export from my tracker?**
   - The source tracker is never named.
3. **Review:**
   - **Stats:** cards to add, Needs you, Finish unknown and Skipped.
   - **The list:** one list with the chips **Needs you / Finish unknown / Matched by name / All / Skipped**. It opens on Needs you while any row needs you, and shows 100 rows at a time.
   - **Each row:** the quantity, the matched card, its group, how many are already in the Collection, the source row in monospace, and a finish picker.
   - **Fixing rows:** a row that needs you expands a resolver with candidates, a catalog search and **Skip row**. Skipped rows can be restored.
   - **Bulk:** select rows (or **Select all** in the current filter), then **Set finish…** or **Skip**. **Skip all N** sits on the Needs you filter.
   - **The side column:**
     - **Put cards in**;
     - **In this file**: the file's groups, which can be unticked to leave them out;
     - **Left out**: counts by reason, with View and Download;
     - "N of these cards are already in your Collection. Importing adds to them."
   - **Save** stays disabled ("N rows need you") until every such row is fixed or skipped. Finish unknown never blocks it. **Download skipped rows** appears once any are skipped.
4. **After saving:** the collector lands on the chosen Location, with a toast saying how many cards were added.

## Mock data

There are 1,308 generated rows: 1,244 cards in three groups (Main 1,050, Binder 2 130, Sold 64), plus 64 left out (9 watchlist, 3 sealed, 12 other games, 40 non-English). Statuses are spread on purpose: Pick one, Not found, Can't read, Matched by name, Finish unknown and matched. A quarter of the rows are already in the Collection.

## Owner verdict — 2026-10-15

1. **The shape works:** one list that opens on Needs you, bulk select, and the side column.
2. **No undo.** The review is the safety net. Once saved, the imported cards are ordinary Holdings, and the toast only confirms. The prototype's toast no longer offers Undo.

## Checks — 2026-10-15

- **Desktop:** the review opened on Needs you (27 rows). **Skip all 27** enabled **Add 1,702 cards to Unsorted**. Saving landed on Unsorted with the toast. No console errors.
- **Phone, 375 × 812:** the review has no horizontal scroll (scroll width 375), and the side column stacks above the list.
- **Not verified:** real touch, screen readers, or performance with a real 3,000-row list (the prototype shows 100 rows at a time).
