# Resolution — Collection import review

**Owner confirmed:** 2026-10-15, after reviewing the prototype

**Ticket:** [Prototype the collection import review](https://github.com/ry-cen/prizecheck/issues/223)

**Prototype:** [Collection import review prototype](../prototypes/import-review/README.md)

**Builds on:** [what the import accepts](decide-what-the-import-accepts.md), [how rows match](decide-how-rows-match.md), and decklist import's approved review.

## Decision

### Where the import starts and ends

- **Start:** the Collection header has **Import…** beside Add cards. An empty Collection offers **Import from another tracker**.
- **The import screen:**
  - **Upload a file** or **Paste**;
  - **Put cards in**, one Storage Leaf, Unsorted by default;
  - a line saying what PrizeCheck keeps (each card, its finish and how many; not condition, prices paid or notes);
  - a collapsed **How do I export from my tracker?** whose per-tracker steps come from the spec.

  The source tracker is never named.
- **After saving:** the collector lands on the chosen Location, with a toast saying how many cards were added.

### The review: one list

- **The list.** One list, with the chips **Needs you / Finish unknown / Matched by name / All / Skipped**. It opens on **Needs you** while any row needs you, and long lists load in pages.
- **Each row** shows the quantity, the matched card, its group, how many copies are already in the Collection, the source row, and a finish picker.
- **Problems expand inline.** **Pick one**, **Not found** and **Can't read** each open a resolver with candidates, a catalog search and **Skip row**. Skipped rows can be restored.
- **Bulk.** Rows can be selected one at a time, or all in the current filter, then given a finish or skipped. **Skip all N** sits on Needs you.
- **The side column** is sticky on desktop and stacks above the list on phones. It holds:
  - **Put cards in**;
  - **In this file**: the file's groups, all ticked, where unticking one leaves it out;
  - **Left out**: counts by reason, with View and Download;
  - a note on how many incoming cards are already in the Collection, which importing adds to.
- **Save.** **Add N cards to <Location>** stays disabled, showing "N rows need you", until every such row is fixed or skipped. Finish unknown never blocks it. **Download skipped rows** appears once any are skipped, and returns them in the file's own columns.

### No undo

The owner chose no undo. The review is the safety net, and once saved the imported copies are ordinary Holdings, changed card by card like any other. The toast only confirms. Since a mistaken double submit can't be undone, the contract must make saving the same review twice impossible.

## Hand-offs

- [Decide the collection import contract](https://github.com/ry-cen/prizecheck/issues/224):
  - saving is idempotent with no undo;
  - **Download skipped rows** and the left-out **Download** return rows in the file's own columns, so the source rows must survive until saving;
  - the review loads in pages;
  - the "already in your Collection" count;
  - the finish picker lists the card's Editions.
