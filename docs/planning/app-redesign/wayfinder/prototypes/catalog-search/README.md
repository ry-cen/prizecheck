# Catalog search prototype

This prototype supports [Prototype Catalog search in the shell](https://github.com/ry-cen/prizecheck/issues/126). It is design evidence for development only, not production code.

## Where the code is

The code lives in `web/src/prototypes/catalog-search/`, inside the shell prototype. It is committed on the throwaway branch `prototype/catalog-search`, cut on top of `prototype/deck-experience`. Run `npm run dev:web -- --port 5186 --strictPort`, open `/collection?prototype=deck&cat=D` (or `A`, `B` or `C`), and go to Catalog. While you're on Catalog, the switcher's arrows and its `catalog` menu cycle the variants.

- Data: in-memory sample data only (15 Printings). Every action is a stub that shows a toast.

## The question

How do Catalog's results look and behave in the shell: tiles or rows? How are results filtered? How does a collector add a card they found to a Location, and is Collection's Add cards dialog reused?

## What every variant keeps (today's Catalog features)

- **Search:** by name prefix, or by set plus collector number. The prototype uses **one smart search box**: "PAL 185" or "svi 191" searches by set and number, anything else by name. A hint shows which search is running.
- **Status:** the catalog's status line (TCGdex, last pull), "changed, refreshed" handling, and "unavailable until the first import".
- **Printing detail:**
  - the art, with an "Artwork unavailable" placeholder, and the note that artwork doesn't prove an Edition's finish;
  - set name, ID and number, and regulation mark;
  - the Card Identity when it differs from the name;
  - the source: TCGdex, or owner-reviewed manual with evidence.
- **Editions:** each Edition's Variant, a badge for owner-reviewed and unavailable Editions, and its price or "no price".
- **Reports:** Report a problem with an Edition, Report Printing metadata, Report a missing Edition, and My reports.

**New in every variant:**
- advisory legality pills for Standard, Expanded and GLC;
- how many copies you own and where;
- **Add to Collection** (Location and quantity) and **Add to Deck List**, right in the detail.

## Variants

- **A — Edition gallery.**
  - **Results:** one tile per Card Edition, the same tile as Collection and the deck builder's library, with an owned badge and price. Unowned Editions are darkened.
  - **Filters:** format and type chips above the results, a set picker, and "Only cards I own".
  - **Card popup:** tapping a tile opens it with Prev and Next (or ← and →), the Printing detail, the Edition picker, Add to Collection and Add to Deck List.
- **B — Printing rows with a detail panel.**
  - **Results:** one dense row per Printing, with its Editions as chips showing owned count and price.
  - **Filters:** in the shell's sidebar (the ☰ drawer on a phone).
  - **Detail:** picking a row opens a side panel. It floats as a panel below 1100 px and becomes a full-height sheet on a phone.
- **C — Add mode.**
  - **Target:** a sticky **"Adding to: [Location]"** bar with the search box.
  - **Results:** one compact row per Edition with a quick **+** that becomes a −/N/+ stepper, and ⓘ opens the full detail.
  - **Tray:** sticky, listing the queued cards, with Clear and **"Add N to Trade box"** to add them all at once. It's meant for entering a stack of physical cards.

- **D — Gallery plus add mode, also opened from Collection.** The owner asked for D on 2026-10-12: A's gallery with C's add mode, reachable from Collection as well.
  - **Catalog page.** A **Browse / Add to a Location** switch.
    - Browse is A: tapping a tile opens the card popup.
    - In Add mode, an **"Adding to [Location]"** bar appears and every tile gets a **+** that becomes a −/N/+ stepper. Queued tiles are outlined.
    - A tray lists the queued cards, with Clear and **"Add N to [Location]"**. Tapping a tile still opens the popup, and its Add to Collection starts on the target Location.
  - **Collection.** With a Location open, **Add cards** opens the same gallery over Collection, already in Add mode and set to that Location ("Add cards to Trade box"). Confirming the tray adds the cards, closes the dialog and leaves you in the Location with an Undo toast.
    - From "All owned" or a folder, it opens as **"Add cards"** with a Location picker.
    - On a phone it fills the screen, and the + and steppers are 36 px with 44 px tap areas.
  - **Cleanup (owner, 2026-10-12): controls where they belong, one size scale.**
    - **Page header:** the **Browse / Add to a Location** switch sits there, on the right, where the shell puts page actions.
    - **Above the gallery:** the search box takes its own full-width row. Below it, one filter row holds the format and type chips (a scrolling row that fades at its edge), a set picker styled as a chip, and an **Owned only** toggle chip in place of the checkbox.
    - **Add mode:** one bar, stuck to the top while you scroll, holds everything: **Adding to [Location]**, the queued cards, **Clear** and **Add N cards**. It replaces the floating tray, which covered the grid. On a phone, Clear and Add appear only once something is queued.
    - **Card popup:** "‹ 1 / 10 ›" sits beside ✕. The Add rows line up as Collection | Location | − N + | **Add N**, then Deck List | Deck | **Plan 1**. The report links are a quiet footer ("Report: this Edition · Printing metadata · a missing Edition").
    - **Sizes:** on desktop, controls are 30 px (search, pickers, steppers, buttons), chips 24 px, and the tile quick buttons 26 px. On a phone, controls are 44 px, and chips, the mode switch and quick buttons have tap areas of at least 44 px.
  - This **replaces Collection's separate Add cards dialog** (`web/src/workspace/AddCardsDialog.tsx` and its own search), so the app has one card search.

## Owner verdict — 2026-10-12

1. **Variant D**, after its cleanup: A's Edition gallery with C's add mode, a Browse / Add switch in the page header, and the same gallery opened in Add mode from Collection's **Add cards**.
2. **B and C are not taken forward.** C's add mode lives on inside D.
3. The full decision is in [the Catalog search resolution](../../resolutions/decide-catalog-search.md).

## Checks — 2026-10-12

- **Build.** `npx tsc -p web/tsconfig.json --noEmit` passed. `vite build` passed, and the output contains none of the prototype's markers.
- **Desktop, 1280×800.**
  - **A:** the gallery showed 10 Editions from "Iono", and the popup gave the Edition choice, ownership ("You own 3: Charizard ex (2), Bulk box A (1)") and both Add controls.
  - **B:** filters in the sidebar, and the panel opened beside the rows.
  - **C:** "SVI 191" switched to set-and-number search, and the tray held 4 cards for the Trade box.
- **Phone, 375×812.** No variant scrolls sideways, and A's popup and B's sheet don't either. The search box is 44 px.
- **Fixed during the checks:**
  - the search box collapsed to 19 px on a phone;
  - C's rows were 123 px tall on a phone and are now 60–69 px;
  - C's tray floated over the rows and is now fixed above the bottom tab bar.
- **D, at 375×812:**
  - Trade box → Add cards opened "Add cards to Trade box" full screen, set to Binders / Trade box. Queuing 2× Iono PAL 185 and 1× Iono PAL 237 Full Art and pressing "Add 3 to Trade box" closed the dialog, returned to Trade box and showed "Added 3 cards (2 Editions)…" with Undo.
  - From All owned, the dialog showed a Location picker.
  - The Catalog page's switch shows no + in Browse and puts + on all 21 tiles in Add mode.
  - Nothing scrolls sideways.
- **Fixed in D.** The Add cards dialog renders outside the shell's root, so the old `style.css` turned its buttons green. The `.cx` reset now uses `:is()`, which beats `style.css`'s plain `button` rule. A zero-specificity `:where()` reset didn't.
- **Not verified.** Real touch gestures, and focus return when a dialog closes.
