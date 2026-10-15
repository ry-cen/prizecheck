# Want List prototype

This prototype supports [Prototype the Want List page](https://github.com/ry-cen/prizecheck/issues/201). It is design evidence only, not production code. It follows the [import and Want List behaviour resolution](../../resolutions/decide-import-and-want-list-behaviour.md).

## How to run it

The prototype is one self-contained page, [`index.html`](index.html). It uses vanilla JavaScript, keeps its data in memory and saves nothing. Colours, spacing and radii come from `web/src/tokens.css` through a relative link. It copies the kit's sizes: 30 px controls, 24 px chips, 13, 12 and 11 px type, and 44 px controls on phones.

Serve the repository root so the link to `tokens.css` resolves:

```bash
python3 -m http.server 5191 --bind 127.0.0.1
```

Then open `http://127.0.0.1:5191/docs/planning/decklist-import/wayfinder/prototypes/want-list/index.html?variant=A`.

- **Switcher (purple bar):** ‹ › or the ← and → keys cycle the variants. **Phone frame** shows the phone layout in a 375 × 812 frame. **Export** turns the Mass Entry export on and off.
- **URL:** the page reads and writes `?variant=A|B|C`, `&mode=one`, `&frame=phone` and `&export=off`.
- **Layout:** it reacts to the app's width with a container query, so a real phone-width window gets the phone layout too.

## The question

How should the Want List page look and behave?

- How does it show each Deck's section and the combined total?
- How do the two counting settings read?
- How does the Swap hint read?
- Where does the page sit in navigation, and should it offer a Mass Entry export of the total?
- How do the phone and desktop layouts work?

## What the page shows (all variants)

- **Summary at the top.** It shows the cards to get, the estimated cost, and how many of those cards are priced. An unpriced card is reported separately and never counted as $0. Beside them are the counting setting and **Buy on TCGplayer**.
- **Counting setting.** **Every Deck built at once** is the default; **One Deck at a time** is the alternative. Switching recounts everything live:
  - Every Deck built at once: 14 cards, $19.30.
  - One Deck at a time: 6 cards, $16.40.
  
  An explainer line under the setting says what the current choice means.
- **One section per Deck,** in Decks-page order. Each line shows:
  - the card and its exact Card Edition;
  - **N of M** (what is still needed out of the Deck List quantity);
  - where the counted copies are: "Have 1 in this Deck · 1 spare", plus "1 in Gardevoir ex" when counting One Deck at a time;
  - the line cost, and the price of each copy.
  
  A Deck that needs nothing collapses to "✓ Nothing to get". An **Open Deck ›** link goes to the deck builder.
- **Combined total.** On desktop it is a sticky right-hand panel. On a phone it is a collapsed row under the summary. Each card appears once with its total, and a "Charizard ex 1 · Gardevoir ex 2" line shows which Decks need it.
- **Swap hint.** A line can say "↻ You own a playable version (PAL 254) × 1" with **Swap 1 into this Deck List**. Swap moves that many copies of the line onto a line for the owned Edition, in the same Deck List. Every count and the total update, and an Undo toast appears.
- **Builder difference note.** Under Every Deck built at once, a Deck's need can be larger than the deck builder's "to complete" figure. The builder counts copies sleeved in other Decks as yours. When the two differ, the section says so.
- **Export dialog.** **Buy on TCGplayer** opens a dialog that follows the current counting setting. It uses the existing Mass Entry coverage wording and has **Open TCGplayer Mass Entry** (a stub).

## Variants: where the Want List lives

- **A — Its own tab.**
  - **Desktop:** a **Want List** tab sits between Decks and Catalog, with a count badge.
  - **Phone:** Want List takes a bottom-bar slot, and Catalog moves into More.
- **B — A view inside Decks.** The Decks tab has a **My Decks / Want List** switch. Each Deck card on My Decks has a "Want List: 6 cards · $13.90" button that opens the Want List view.
- **C — Reached from Decks and from each Deck.**
  - **Decks index:** a gold banner ("Want List · 14 cards to get · $19.30 — Open Want List ›") opens the page.
  - **Each Deck:** the Deck card and the Deck's own page link to the page, filtered to that Deck.
  - **Navigation:** the page has a ‹ Decks back link and Deck filter chips. It has no tab of its own.

## Mock data

Three Standard Decks: Charizard ex, Gardevoir ex and a complete Miraidon ex. The data is built to show these cases:

- **The settings disagree on Iono PAL 185.**
  - **Every Deck built at once:** Charizard takes the single spare, so Charizard needs 2 and Gardevoir needs 2, for a total of 4.
  - **One Deck at a time:** the copy sleeved in Charizard also counts for Gardevoir. Gardevoir then needs 0, and the total is the larger need, 2.
- **Exact Editions:** a Boss's Orders PAL 172 Reverse Holo is owned but not counted toward a Normal line. It shows up as a Swap hint instead.
- **Swap:** a spare Iono PAL 254 triggers the hint on the Iono PAL 185 lines.
- **Pricing Coverage:** Professor Turo's Scenario PAR 171 has no price.

## Placeholders for "Decide the Want List contract"

These are prototype choices, marked in the UI, not decisions:

- Under Every Deck built at once, spare copies go to Decks in Decks-page order.
- A Swap hint appears only for spare copies that no Deck has counted, never for copies sleeved in another Deck.
- Swap moves only as many copies as are both needed and owned spare. It changes part of a line and does not re-point the whole line.

## Checks — 2026-10-14

- **Desktop, 1280×800:**
  - Variant A shows the tab with a count badge, the summary, the Deck sections and the sticky combined total.
  - Switching the counting setting changes 14 cards / $19.30 to 6 cards / $16.40.
  - Swap on Charizard's Iono gave 13 cards / $18.95, and Undo restored 14 / $19.30.
  - The export dialog follows the counting setting.
  - No console errors.
- **Phone, 375×812:**
  - Variants B and C have no horizontal scroll (scroll width 375) and nothing past the right edge.
  - The Deck header stacks.
  - Swap buttons are full width at 36 px.
  - The phone frame toggle renders the same layout inside a desktop window.
- **Not verified:** real touch, screen readers, and focus handling in the dialog.
