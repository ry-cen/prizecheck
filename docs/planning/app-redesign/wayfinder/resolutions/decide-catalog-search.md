# Resolution — Catalog search and adding cards

**Owner confirmed:** 2026-10-12

**Ticket:** [Prototype Catalog search in the shell](https://github.com/ry-cen/prizecheck/issues/126)

**Evidence:** [Catalog search prototype notes](../prototypes/catalog-search/README.md). Variant D was chosen out of four, after one cleanup pass.

## Decision

### Catalog page

- **An Edition gallery.** Results are one tile per Card Edition, the same tile as Collection and the deck builder's library. Each tile shows its set, number, Variant, price and an owned badge. Unowned Editions are darkened, and "Artwork unavailable" stands in for missing art.
- **Search: one smart box.** "PAL 185" or "svi 191" searches by set and collector number. Anything else is a name-prefix search. A hint shows which search is running.
- **Filters: one row under the search box.**
  - Format chips (Any, Standard, Expanded, GLC) and type chips (Pokémon, Supporter, Item, Tool, Stadium, Energy) share one scrolling row that fades at its edge.
  - Next to them sit a set picker styled as a chip, and an **Owned only** toggle chip.
  - Catalog has no sidebar.
- **Status line.** "N Printings · English catalog from TCGdex, last pulled …", plus today's "changed, refreshed" and "unavailable until the first import" handling.
- **Page header.** A **Browse / Add to a Location** switch sits on the right, where the shell puts page actions.

### Card popup (Browse)

- Tapping a tile opens the card popup. **‹ N / M ›** (or ← and →) steps through the results.
- **What it shows:**
  - the art, with the note that artwork doesn't prove an Edition's finish;
  - set name, ID and number, and regulation mark;
  - the Card Identity, when it differs from the name;
  - the source (TCGdex, or owner-reviewed with evidence);
  - advisory legality pills for each format;
  - the Printing's **Editions** as a picker, each with its Variant, owned count and price, plus badges for owner-reviewed and unavailable Editions;
  - **where your copies are**.
- **Add rows:**
  - **Collection** | Location | − N + | **Add N**
  - **Deck List** | Deck | **Plan 1** (a Deck List line, no physical move)
- **Reports** sit in a quiet footer: this Edition, Printing metadata, a missing Edition. **My reports** sits at the foot of the page.

### Add mode

- Switching to **Add to a Location** shows one bar that **stays at the top while you scroll**. It holds:
  - **Adding to [Location]**;
  - the queued cards;
  - **Clear** and **Add N cards**.
- Every tile gets a **+** that becomes a **−/N/+** stepper. Queued tiles are outlined.
- **Add N cards** adds the whole queue to the Location at once, with an Undo toast. The card popup still opens, and its Add row starts on the target Location.

### Adding cards from Collection

- With a Location open, **Add cards** in Collection opens the **same gallery in Add mode over Collection**, already set to that Location ("Add cards to Trade box").
- Confirming adds the cards, closes the dialog and leaves you in the Location with an Undo toast.
- From All owned or a folder, it opens as "Add cards" with a Location picker.
- This **replaces Collection's current Add cards dialog** (`web/src/workspace/AddCardsDialog.tsx` and its separate search in `AddCardsForm.tsx`), so the app has one card search.

### Sizes and phones

- **Desktop:**
  - search, pickers, steppers and buttons are 30 px;
  - chips and pills are 24 px;
  - a tile's quick + is 26 px.
- **Phones:**
  - controls are 44 px, and chips, the mode switch and the quick buttons have tap areas of at least 44 px;
  - the Add cards dialog fills the screen, and the card popup becomes a bottom sheet;
  - in Add mode, Clear and Add appear only once something is queued.
- Nothing scrolls sideways on a phone.

### Not taken forward

- **Printing rows with a detail panel (B):** dense rows, sidebar filters.
- **Pure add mode (C):** its add mode lives on inside D.

## What the spec and backend need

- **One catalog browse route, shared with the deck builder** (the map's "Deck builder data" fog). It returns Card Editions:
  - filtered by type, format legality, set and "owned only";
  - with owned counts and where the copies are merged in;
  - with an empty query allowed.

  `GET /api/catalog/search` can't do this: it returns Printings and needs a name prefix, or a set plus collector number.
- **Batch add to one Location.** Add mode adds several Editions at once. Today `POST /api/holdings` adds one Edition per call. The spec chooses between a batch command and sequential calls with one Undo.
- **Per-Edition advisory legality,** for the format chips and the popup's pills. This is the same need as the deck builder's.
