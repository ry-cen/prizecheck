# Deck experience prototype

This prototype supports [Prototype the Deck experience](https://github.com/ry-cen/prizecheck/issues/125). It is design evidence for development only, not production code. It draws on [the Decks UI inventory](../../research/decks-ui-inventory.md).

## Where the code is

The code lives on the throwaway branch `prototype/deck-experience`, which was cut from `prototype/app-shell`. It runs inside the chosen shell (Variant A). To run it, check out that branch, run `npm run dev:web -- --port 5186 --strictPort`, and open `/collection?prototype=deck&deck=A` (or `B`, `C` or `D`). Open the Charizard ex Deck from Decks or from the Location tree.

- Code: `web/src/prototypes/deck-experience/`. Shell hooks are in `web/src/prototypes/app-shell/AppShellPrototype.tsx`.
- Data: in-memory sample data only. Every action is a stub that updates memory and shows the Undo toast.
- The switcher's arrows and its `deck` menu cycle the Deck variants.

## The question

Where does Deck work live in the new shell: a Decks page, a Deck view inside Collection, or both? How do Deck List editing, ownership, the Pick List, format results, cost, exports and publishing read on desktop and mobile?

## Variants

- **A — Decks page owns it.** The whole Deck sits on the Decks tab:
  - format chips, both cost figures and an ownership summary;
  - a "Gather N cards I own" button that opens the Pick List, arranged by card with a source picker on each row;
  - the Deck List grouped by Pokémon, Trainer and Energy, each line with an ownership bar and a quantity stepper;
  - surplus with Put away;
  - a format-checks column. On a phone it stacks below the list.

  Export, Publish and Delete sit in the page header. In Collection, a Deck shows only its cost and a link to Decks.
- **B — Inside Collection.** Opening a Deck in the Location tree shows three views beside the Location tree:
  - **Cards in Deck:** today's gallery.
  - **Deck List:** tiles with ×quantity, here, elsewhere and to-buy counts, and a stepper. Cards you don't own are dashed ghosts.
  - **Gather:** tiles labelled with their source Location. You select them, then use "Move into Deck" in the Actions strip.

  The Decks tab is reduced to an index with format badges, plus Published Decks.
- **C — Split by job.** The Decks page is for planning: a three-column format board with an "as of" date, then the Deck List with compact ownership bars, cost and Add card. Opening the Deck in Collection adds a Gather panel above the gallery. It's a numbered route of stops by Location, with loose storage first and other Decks last. Each stop has a "Got these" button, and surplus Put away sits there too.

- **D — Deck builder (TCG Live and Limitless ideas).** The owner asked for D on 2026-10-12 and revised it three times that day. It draws on [the TCG Live research](../../research/ptcgl-deck-builder.md) and [the Limitless research](../../research/limitless-deck-builder.md).
  - **Layout.** The **deck is the main area, on the left.** The **card library is a narrower panel on the right** that scrolls on its own.
  - **Library: one tile per Card Edition, like Collection.**
    - Search, an **Owned / All cards** toggle (starting on Owned), **format chips** (Any, Standard, Expanded, GLC) and **type chips** (Pokémon, Supporter, Item, Tool, Stadium, Energy).
    - Unowned Editions are darkened. Each tile shows its set, number and Variant, copies free out of copies owned, and price.
  - **Adding.**
    - **Dragging** a library tile into the deck adds one copy of exactly that Edition.
    - **Tapping** a tile opens a **card popup**: the card, its ownership, its price and its legality in each format, **−1 / N on Deck List / +1**, and **‹ › arrows** (or ← and →) to step through the current results.
  - **Deck views:**
    - **Spread:** one tile per copy, each showing its own state: solid in this Deck, dashed with ↻ elsewhere, ghost with $ not owned.
    - **Stacked:** piles per Edition with a summary such as "×4 1↻ 1$".
    - **List:** lines grouped by evolution line, Trainer subtype and Energy, each with −/+, Edition, ownership counts and the line's price. Tapping a line's name opens the card popup.
  - **Deck header.** The count pops when it changes. It also shows Deck List cost, cost to complete, the format results, "Gather N I own" and "Buy missing".
  - **Removing.** Tapping a copy opens its sheet: what that copy is and where, ±1, Gather, and swapping it for another Edition. Dragging a copy onto the library also removes it, and so do Delete or Backspace.
  - **Undo.** Every add, remove or swap shows an Undo toast, and Undo restores the previous Deck List.
  - **Drag uses pointer events, the same pattern as Collection's tile drag (`web/src/workspace/tileDrag.tsx`):**
    - mouse and pen only;
    - a 6 px threshold before a press becomes a drag;
    - a badge follows the pointer and the drop target is highlighted;
    - Escape cancels, and the click after a drag is swallowed.

    Touch taps instead. The first version used native HTML5 drag-and-drop. It doesn't work on touch, and a real mouse drag in the test browser never delivered its drop.
  - **Visual cleanup (owner, 2026-10-12).**
    - **Sizes:** desktop controls are 30 px (buttons and search), with 24 px format pills and chips. Type is 13 px on controls, 12 px for details and 11 px for captions, with quiet borders.
    - **Deck header:** two rows. Row 1 has the count, "$deck · $to complete", Gather and Buy missing. Row 2 has the format pills and a Spread / Stacked / List switch.
    - **Library:** chips run in one scrolling row, tiles are smaller with one-line captions, and the copy key moves to a footer line.
    - **Phones:** buttons and search go back to 44 px, and the compact chips, pills and switches get an invisible extension that makes each tap area at least 44 px.
  - **Phone.** **Deck and Library tabs** switch between two full-screen views, Limitless-style. The library is the default tab, and the Deck tab shows the live count. The deck opens on Stacked.

**Shared by all four:**
- Format results never disable anything. Each issue shows its plain-language reason, and a card issue highlights its lines.
- The "as of" date can show the note about future rules.
- Mass Entry defaults to the cards you don't own.
- Deleting a Deck asks for the typed name and says the cards go to Unsorted.
- Publications whose Deck was deleted appear under Published Decks on the Decks index. This placement is a proposal. [Decide the Published Deck and Discover pages](https://github.com/ry-cen/prizecheck/issues/127) has the final say.
- Confirming more than five source Locations happens in batches of up to five, and the toast says so.

**Assumption:** cards you don't own have names and art. The API doesn't provide them yet; see the inventory's "Backend gaps".

## Owner verdict — 2026-10-12

1. **Variant D**, the deck builder, after its revisions:
   - library tiles are Card Editions, not Identities;
   - Limitless's layout, card popup, chips, list view, phone tabs and Undo;
   - pointer-event drag;
   - the visual cleanup.
2. Variants A–C are not taken forward. Surplus with Put away, and the competition warning, carry over from A into D's deck.
3. The full decision is in [the Deck experience resolution](../../resolutions/decide-deck-experience.md).

## Checks — 2026-10-12

- **Build.** `npx tsc -p web/tsconfig.json --noEmit` passed. `vite build` passed, and the output contains none of the prototype's markers (`proto-switcher`, `dx-gather`, `dx-libcard`, `DeckBuilder`, `DeckExperience`, `AppShellPrototype`).
- **Desktop.** Each variant's Decks page, its Collection Deck view and the Pick List were viewed at 800×600.
- **Mobile.** At 375×812, no element passed the right edge of the viewport in any variant. That covers the Decks index, the Deck page, Collection's Deck view, B's Gather view, and the Export, Publish, Delete and Gather dialogs. The Publish dialog's buttons overflowed until they were made to wrap. The Pick List table is excluded from the check because it turns into stacked rows on a phone.
- **D, at about 1260×625 with no emulation:**
  - **Real mouse drags** (the browser tool's left-click drag) work both ways. A library tile dragged into the deck added an Arven copy (61/60), and a Charmander copy dragged onto the library removed one (60/60). Neither drag opened the popup or the copy sheet afterwards.
- **D, at 1280×800:**
  - The deck is on the left (600 px) and the library on the right (377 px).
  - The GLC chip hid every ex card, and the Supporter chip listed only Supporters.
  - The popup's +1 added Iono PAL 237 Full Art, and › stepped to the next result.
  - Undo took 61/60 back to 60/60.
  - List view showed quantities, ownership counts and line prices.
- **D, at 375×812:**
  - The Library tab is the default. The popup's +1 worked, and the Deck tab showed 61/60 in Stacked.
  - The page never scrolls sideways (scroll width 375). In List view, long Edition names end in an ellipsis inside their row.
- **Bug fixed.** An Edition you own but have no spare copy of was labelled "not owned". It now says there's no spare copy.
- **Not verified.** Real touch gestures, and focus return when a dialog closes.
