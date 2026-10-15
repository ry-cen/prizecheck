# Import review prototype

This prototype supports [Prototype the import review step](https://github.com/ry-cen/prizecheck/issues/202). It is design evidence only, not production code. It follows the [import and Want List behaviour resolution](../../resolutions/decide-import-and-want-list-behaviour.md), the [Want List contract](../../resolutions/decide-want-list-contract.md) (Spare Copies) and the closed research on [text formats](../../research/decklist-text-formats.md) and [set codes](../../research/set-code-mapping.md).

## How to run it

The prototype is one self-contained page, [`index.html`](index.html). It uses vanilla JavaScript, keeps its data in memory and saves nothing. Colours, spacing and radii come from `web/src/tokens.css` through a relative link. It copies the kit's sizes: 30 px controls, 24 px chips, 13, 12 and 11 px type, and 44 px controls on phones.

Serve the repository root so the link to `tokens.css` resolves:

```bash
python3 -m http.server 5192 --bind 127.0.0.1
```

Then open `http://127.0.0.1:5192/docs/planning/decklist-import/wayfinder/prototypes/import-review/index.html?variant=A&flow=new`.

- **Switcher (purple bar):** ‹ › or the ← and → keys cycle the review layouts. **New**, **Replace** and **Copy** restart the prototype at each entry point. **Phone frame** shows the phone layout in a 375 × 812 frame.
- **URL:** the page reads and writes `?variant=A|B|C`, `&flow=new|replace|copy` and `&frame=phone`. `&screen=review` jumps straight to the review with a fixture loaded (the Limitless list for New, the TCG Live list for Replace).
- **Layout:** it reacts to the app's width with a container query, so a real phone-width window gets the phone layout too.

## The question

How should the import review step look and behave, from paste to saved Deck List?

## The flows (all layouts)

- **New:** Decks → **Import a list** (beside Create Deck) → paste → review → **Create Deck**. The new Deck appears on Decks; Undo removes it.
- **Replace:** Gardevoir ex's deck builder → **Replace list…** (beside Export, Publish and Delete) → paste → review → **Replace Deck List**. The review shows **Will become Surplus**; after saving, the builder shows those cards in its Surplus group with **Put away all**, and an Undo toast restores the old list.
- **Copy:** a Published Deck → **Copy to my Decks** → the same paste screen, showing the snapshot instead of a text box → the same review. A snapshot is already Card Editions, so nothing is unmatched; only substitutions appear under **Use cards I own**.

## The paste screen

- A text box with **TCG Live list** (fixture F1) and **Limitless list** (fixture F3) presets, copied verbatim from the research.
- A live count: card lines and cards, worked out from the lines. Header numbers are never shown or checked, because TCG Live headers count lines and Limitless headers count cards.
- Lines that don't start with a quantity (prose, `Total Cards: 60`, `******`) are ignored and counted as "other lines". A line that starts with a quantity but has no set code and number is **Can't read** and must be fixed or dropped.
- **Put it in:** A new Deck (name required, Target Format) or, from the builder, **Replace this Deck's list**.
- **Owned cards:** **Exact printings** / **Use cards I own**, with an explainer. The setting can also be switched in the review, which recounts live.

## The review (all layouts)

- **Each line** shows its quantity, the matched card, the pasted text in monospace, and the Deck List lines it becomes (one Card Edition each, ADR 0009):
  - Exact printings: "3 PAL 185 · cheapest priced · $0.35 each".
  - Use cards I own: "Used 1 Iono PAL 185 · Reverse Holo you own · Binder", "Used 1 Iono PAL 254 · Holo you own · Binder", then "1 PAL 185 · cheapest priced". One pasted line can become several Deck List lines.
  - "4 in Charizard ex stay there: they're that Deck's own" when copies cover another Deck's line. Only Spare Copies (loose copies and other Decks' Surplus) are used.
  - Replace: copies the Deck already holds are used first and read "already in this Deck".
- **Basic Energy** that names no catalog Printing (`SVALT 135`, Limitless `MEE 10`) is matched by type to a default Edition (SVE 9–16), with **Change** to pick another.
- **Problems:** **Pick one** (ambiguous), **Not found** and **Can't read**. Each opens a resolver with a catalog search, candidates, **Drop line**, and "Report … on Missing cards ›" (a stub). Dropped lines can be restored.
- **Edition** on any resolved line opens its Editions with prices.
- **Totals:** cards (with "not 60" when it isn't), cards you own, and cards to get with their cost and unpriced count.
- **Save** stays `aria-disabled` with "N lines to resolve" until every flagged line is picked or dropped.

## Variants: the review layout

- **A — One list.** Pokémon, Trainer and Energy sections in paste order, with **All / Needs you / Changed / Dropped** filter chips. Problems expand inline. A sticky side column holds the totals, the setting, the destination and **Will become Surplus**. On phones the side column stacks above the list.
- **B — Paste beside the Deck List.** The left pane is the pasted text, line-numbered, each line marked ✓, ◆ (uses cards you own), ⚡ (Energy default), ! (needs you) or – (dropped); ignored lines stay visible but greyed. Selecting a line shows its match and resolver on the right, above the **Deck List after saving**, one row per Card Edition with the paste lines it came from, highlighted. On phones the panes become **Your paste · N to fix** and **Deck List · 60** tabs, and the resolver opens under the selected line.
- **C — Problems first.** A step card works through the lines that need you, one at a time, with a progress bar. Everything else sits below in collapsed groups: **Uses cards you own**, **Basic Energy, default Edition**, **Fixed by you**, **Matched as listed**, and the ignored lines. Once nothing is left the groups open and the page says "Every line is resolved."

## Mock data

- **Catalog:** any code and number resolves to a made-up Printing with made-up prices, except:
  - `Budew ASC 16`: the number finds nothing and the name finds two different Budew cards (`PRE 4`, `SSP 5`), standing in for the research's half of Pokémon whose name names several Reprint Groups;
  - `Meowth ex POR 62`: not in the catalog (newer than the last import);
  - `MEE 10`, `MEE 13`, `MEE 15`: not in the catalog, so Basic Energy by type;
  - `SVALT 135`, `SVALT 137`: TCG Live-only codes, so Basic Energy by type.
- **Reprint Groups:** Iono PAL 185 / 254 / 269, Boss's Orders PAL 172 / MEG 114, Ultra Ball SVI 196 / MEG 131, Buddy-Buddy Poffin TEF 144 / PRE 101, Counter Catcher CIN 91 / PAR 160, and each Basic Energy type.
- **Spare Copies:** Iono PAL 185 Reverse Holo and PAL 254 in a Binder, 2 Boss's Orders PAL 172 and 3 Ultra Ball SVI 196 in Unsorted, 1 Buddy-Buddy Poffin PRE 101 in Miraidon ex's Surplus, 2 Munkidori TWM 95 in a Binder.
- **Not spare:** 4 Iono PAL 185 and 4 Rare Candy in Charizard ex, covering its own lines.
- **Gardevoir ex holds** its old list: Gardevoir ex, Kirlia, Ralts, 2 Arven SVI 166 **Reverse Holo**, 2 Counter Catcher **PAR 160**, Lost Vacuum, Brute Bonnet and 8 Basic Psychic Energy **SVE 5**. Replacing with F1:
  - **Exact printings:** 14 cards become Surplus, including the Reverse Holo Arvens (F1 names Arven SVI 166, whose cheapest Edition is Normal), Counter Catcher PAR 160 (F1 names CIN 91) and all 8 SVE 5 Energy (F1 names SVE 13).
  - **Use cards I own:** 3 become Surplus (Lost Vacuum, Brute Bonnet, 1 Energy).
- **Published Deck:** "Dragapult ex — Regionals top 8", the F3 list as a snapshot of Card Editions.

## Placeholders for "Decide the import contract"

These are prototype choices, marked in the UI with dashed notes, not decisions:

- `PH` picks the Reverse Holo Edition.
- A new Deck's Target Format defaults to Standard; nothing in the paste sets it.
- Under Use cards I own, the order is this Deck's copies of the exact Printing, this Deck's other Printings, Spare Copies of the exact Printing, then Spare Copies of other Printings. Among several spare Editions, holding order wins.
- Matching order: code and number, then Basic Energy by type, then name.

## Owner verdict — 2026-10-14

1. **Variant A.** One list, opening on **Needs you** when there are lines to resolve.
2. **Exact printings** keeps the replaced Deck's held copies of the named Printing in their own Edition; only the rest gets the cheapest priced Edition.
3. **Use cards I own** is the default the first time; each device remembers the choice after that.
4. **The setting** lives in the review's side column only; the paste screen holds the text and destination.
5. **After saving,** every flow lands in the Deck's builder with an Undo toast. The review shows only the card count; format checks stay in the builder.
6. **Copy to my Decks** only creates a new Deck, named after the Published Deck.
7. **A line without a set code** stays **Can't read** until the collector picks a card or drops it.
8. **Not taken forward:** variants B and C. The full decision is in [the import review resolution](../../resolutions/prototype-import-review.md).

## Checks — 2026-10-14

- **Desktop (pane width):**
  - New, variant C: the Budew step offered PRE 4 and SSP 5; picking PRE 4 moved to Meowth ex (Not found, with the Missing cards link); Drop line enabled **Create Deck** ("Ready · 59 cards · 23 Deck List lines"); saving added the Deck to Decks with an Undo toast.
  - Replace, variant A: Exact printings showed 14 cards becoming Surplus; Use cards I own showed 3 and the Iono line split into 1 PAL 185 Reverse Holo + 1 PAL 254 (owned) + 1 PAL 185 cheapest, with "4 in Charizard ex stay there".
  - Copy, variant B with Use cards I own: Boss's Orders MEG 114 × 3 became "Used 2 Boss's Orders PAL 172 you own" + 1 MEG 114; 8 cards owned; "All matched".
  - No console errors.
- **Phone, 375 × 812:** variants A, B and C have no horizontal scroll (scroll width 375). The save bar sits above the tab bar; B's panes become tabs; A's resolver buttons are full width.
- **Not verified:** real touch, screen readers, focus order in the resolver.
