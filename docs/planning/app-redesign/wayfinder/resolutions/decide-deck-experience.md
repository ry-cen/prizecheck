# Resolution — Deck experience

**Owner confirmed:** 2026-10-12

**Ticket:** [Prototype the Deck experience](https://github.com/ry-cen/prizecheck/issues/125)

**Evidence:**
- [Deck experience prototype notes](../prototypes/deck-experience/README.md). Variant D was chosen out of four, after three revisions with the owner.
- [Decks UI inventory](../research/decks-ui-inventory.md).
- Research on [TCG Live's deck builder](../research/ptcgl-deck-builder.md) and [Limitless's deck builder](../research/limitless-deck-builder.md).

> **Amended 2026-10-12** by [the Published Deck and Discover resolution](decide-published-deck-and-discover.md#target-format-and-the-publishing-gate) and [ADR 0011](../../../../adr/0011-publishing-needs-a-legal-target-format.md):
> - Every Deck has one **Target Format**.
> - The three format pills below become one **"Standard ▾ · ✓ Legal"** control.
> - The library's format chip starts on the Target Format.
> - **Publish is disabled** until the Target Format result is legal.
> - The Decks index shows one format pill per Deck.

## Decision

### Where Deck work lives

- **The Decks page owns building and managing a Deck.**
  - The Decks index lists every Deck with its in-Deck count, cost to complete and three format badges.
  - Opening a Deck shows the deck builder.
  - The page header holds **Export**, **Publish** and **Delete**.
- **Collection keeps the physical Deck.** Opening a Deck in the Location tree shows its Holdings in the gallery, with Move, Remove and Undo as today. A banner above them shows the cost and links to the Deck on Decks.

### The deck builder

**Layout**
- The **Deck List is the main area, on the left.**
- A narrower **card library** sits on the right and scrolls on its own.
- On a phone, **Deck and Library tabs** switch between two full-screen views. Library is the default, and the Deck tab shows the live count.

**Card library**
- **One tile per Card Edition, like Collection.** Each tile shows its set, number and Variant (Unspecified Variant included), copies free out of copies owned, and price.
- An **Owned / All** switch starts on Owned. Unowned Editions are darkened.
- There's a search box and two rows of chips:
  - **format:** Any, Standard, Expanded, GLC. These filter by advisory legality.
  - **type:** Pokémon, Supporter, Item, Tool, Stadium, Energy.

**Adding a card**
- **Dragging** a library tile into the deck adds one copy of exactly that Edition.
- **Tapping** a tile opens a **card popup**. It shows the card, its ownership, its price and its legality in each format, has **−1 / N on Deck List / +1**, and has **‹ ›** (or ← and →) to step through the current results.
- Adding a card never moves a physical card.

**The Deck List**
- Three views:
  - **Spread** (desktop default): one tile per copy.
  - **Stacked** (phone default): piles per Edition, each with a summary such as "×4 1↻ 1$".
  - **List:** −/+, the Edition, ownership counts and a price on each line.
- Every copy shows its own state:
  - **in this Deck** (solid);
  - **owned elsewhere**, and where (dashed, ↻);
  - **not owned** (ghost, $).
- Lines are grouped by evolution line, Trainer subtype and Energy.

**Changing a copy**
- Tapping a copy opens its sheet: what it is and where it is, ±1, Gather, and **Swap this copy for** another Edition of the same Card Identity.
- Dragging a copy onto the library removes it, and so do Delete or Backspace.
- **Every add, remove or swap shows an Undo toast.**

**Deck header**
- Row 1 has the count (N/60), "$deck · $to complete", **Gather N** and **Buy missing**.
- Row 2 has the format pills and the Spread / Stacked / List switch.
- Nothing is ever blocked. A Deck List can go over 60 cards, and format results stay advisory.

**Format results**
- The pills open a dialog with three parts:
  - an "as of" date that shows the future-rules note;
  - each format's deck-level and card-level issues, with plain-language reasons;
  - the rules version and the advisory disclaimer.
- A card-level issue highlights its lines in the deck.

**Gather (the Pick List)**
- **Gather N** opens the Pick List as a dialog, arranged by card. Each row has a source picker. Sources in another Deck carry a "leaves that Deck short" warning.
- **Confirm picked** and **Confirm all** both work.
- Confirming from more than five source Locations happens in batches of up to five, and the toast says so.

**Exports and buying**
- **Buy missing** opens the export dialog on TCGplayer Mass Entry, **defaulting to the cards you don't own**, with the whole Deck List as an option. The Live export uses the whole Deck List.
- Cost shows the Deck List cost and the cost to complete, each with how many copies have a price.

**Publish and Delete**
- **Publish** shows the snapshot's title, visibility and version, with Republish, List in Discover and Revoke.
- **Delete** asks for the Deck's name to be typed, says the cards go to Unsorted, and says any Published Deck stays live.
- A Published Deck whose Deck was deleted is listed under **Published Decks** on the Decks index, with Make Unlisted and Revoke. **This placement is a proposal.** [Decide the Published Deck and Discover pages](https://github.com/ry-cen/prizecheck/issues/127) has the final say.

**Dragging**
- Dragging uses **pointer events, the same pattern as Collection's tile drag** (`web/src/workspace/tileDrag.tsx`):
  - mouse and pen only;
  - a 6 px threshold before a press becomes a drag;
  - a badge follows the pointer and the drop target is highlighted;
  - Escape cancels, and the click after a drag is swallowed.
- **Touch taps instead of dragging.** A tap always works, which also meets WCAG 2.5.7 (Dragging Movements).

**Visuals**
- **Desktop:** controls are 30 px, pills and chips 24 px. Type is 13 px on controls, 12 px for details and 11 px for captions, on the shared design variables.
- **Phones:** buttons and search are 44 px, and compact chips and switches get an invisible extension that makes each tap area at least 44 px.
- Nothing scrolls sideways on a phone.

### Carried over from Variant A

The owner chose D without these being shown in it. The Deck List spec needs both, so the spec places them in D's deck:
- **Surplus:** copies physically in the Deck but cut from the list. They need their own state or group, with **Put away**, which is a Move to a Location the collector picks.
- **The competition warning:** shown when several Decks count the same spare copies.

## What the spec and backend need

- **Library data.**
  - The owned view needs every Edition the collector owns, with total copies, copies free outside this Deck, kind and subtype, filtered by format legality. Collection's per-Edition listing, `GET /api/collection`, is the closest existing route. **Keep it.** The audit had marked it as optional cleanup; this decision reverses that.
  - The **All** view needs a **catalog browse that returns Editions**, filtered by type and format, with owned counts merged in. `GET /api/catalog/search` can't do that: it returns Printings and needs a name prefix, or a set plus collector number.
- **Display data for Deck List lines.** Lines not owned have no route that returns their names or art. This is the inventory's first backend gap.
- **Format legality for library filtering.** The format chips need each Edition's advisory legality without running a whole-deck check per card.
- **Undo for Deck List edits.** Deck List commands are revision-checked and idempotent. Undo can send the opposite command, or a new "restore revision" command, which the spec decides.
