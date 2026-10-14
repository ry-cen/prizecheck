# Research — Limitless deck builder

**For:** [Prototype the Deck experience](https://github.com/ry-cen/prizecheck/issues/125), at the owner's request (2026-10-12). It complements [the TCG Live research](ptcgl-deck-builder.md).

**Gathered:** 2026-10-12, by using [my.limitlesstcg.com/builder](https://my.limitlesstcg.com/builder) in a browser, signed out. I built an unsaved deck at 1280×800 and loaded the page again at 375×812. Nothing was saved or shared.

## What it does

**Layout (desktop)**
- The **deck is on the left and takes most of the width.** Card search is a narrower panel on the right, with Card Search and Favorites tabs and a game picker. This is the reverse of TCG Live, and it fixes that game's main layout complaint.
- The deck header shows the **card count and the deck's total price** ("3 cards $0.72"). Its controls are Save, Undo, Share, Tools and Playtest, plus sort and a **grid / list** switch.

**Search**
- Results are a **four-column grid of card images, one tile per print.** Searching "Iono" returned 24 cards, because the search matches text such as "Iono's Tadbulb" as well as names.
- Filter chips cover **formats (Standard, Expanded, GLC)** and **card types**: Pokémon, Trainer, Energy, Item, Supporter, Stadium, Tool, Basic Energy and Special Energy.
- **Advanced Search** is a large form:
  - **Gameplay:** card type; mechanic (ex, V, Radiant, ACE SPEC); label (Mega, Tera, Ancient, Future); energy type; stage; HP, attack cost and retreat cost with comparisons; and whether a card has an Ability, Rule Box, Weakness or Resistance.
  - **Collection:** set, series, artist, rarity, format (including past Worlds formats), regulation mark with comparisons, and TCGplayer price limits.

**Adding and removing**
- **Clicking a result** opens a card detail popup: the card image, set and number, **−1 / N in deck / +1**, arrows to step through the results, and a favourite button.
- **Dragging a result into the deck adds a copy**, and **dragging a deck card back to the search panel removes one.** I tested both with a real mouse drag.
- **Undo** appears after a change.

**Deck display**
- **Grid view:** one image per print, with a large **count badge** (a hexagon showing 3) instead of one tile per copy.
- **List view:** sections by card type, such as "Pokémon (3)", with a line like "3 Iono's Tadbulb" and **a price per line.**

**Tools and Share**
- **Tools:** Print Decklist, Statistics, **Apply Preferred Prints** (a set of print preferences applied to the whole deck), Proxy Printer, PNG image, and **TCGplayer Mass Entry**.
- **Share:** Copy Import Link, Copy as Text, Download Image.

**Phone (375 px)**
- **Bottom tabs switch between two full-screen views, Deck and Search.**
- The header keeps Save, Undo, Share and Tools. Playtest is hidden.

**Not seen** (signed out, or not explored)
- Deck validation messages. I only added a few cards.
- Any collection or ownership features: none appear in the builder.

## Compared with the Deck D prototype

| | Limitless | Deck D today |
| --- | --- | --- |
| Main area | The deck (left, wide) | The library (left); deck panel right, about 46% wide |
| Card source | Search across all prints, with format and type chips | Card Editions you own, plus an "All cards" toggle |
| Adding | Click opens a −1 / +1 popup; drag adds | Tap or drag adds one copy; there's no popup |
| Deck display | One tile per print with a count badge, or a list with prices | One tile per copy (Spread) or piles (Stacked) |
| Removing | −1 in the popup, or drag out | A copy's sheet, or drag out, or Delete |
| Phone | Deck and Search tabs, both full screen | Library full screen; deck in a bottom sheet |
| Ownership | None | Every copy shows in Deck, elsewhere, or not owned |

## Ideas worth taking

1. **Make the deck the main area.** Put the deck on the left at full width and the library in a narrower right panel. Limitless does this, and it answers TCG Live's biggest complaint.
2. **A card popup with −1 / N / +1 and arrows to step through results.** It's a faster and more accessible way to set quantities than repeated taps, it works the same on a phone, and the arrows let you browse without closing it. Tapping a library tile could open it, while dragging still adds directly.
3. **Format chips in the library filter** (Standard, Expanded, GLC), backed by our format checks, plus **Trainer subtype chips**.
4. **A grid / list switch for the deck,** with prices on each line in list view. Our copy-tile grid stays, and the list becomes the dense alternative. It could also carry each line's ownership marks.
5. **Deck and Library tabs on a phone,** instead of a bottom sheet over the library. Both views are full screen, which suits copy tiles better than a sheet.
6. **Undo after edits.** PrizeCheck already has the Undo toast pattern, so Deck List edits should use it too.
7. **Apply Preferred Prints** is similar to our per-copy Swap, but for the whole deck: for example, "use owned Editions where possible". It could be a later idea; it isn't needed now.

Limitless has no idea of ownership. Starting the library on owned cards, showing each copy's state, and Gather and Buy missing are what make PrizeCheck different, and they should stay.
