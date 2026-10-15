# Resolution — Want List page

**Owner confirmed:** 2026-10-14, after reviewing the prototype

**Ticket:** [Prototype the Want List page](https://github.com/ry-cen/prizecheck/issues/201)

**Prototype:** [Want List prototype](../prototypes/want-list/README.md)

## Decision

### Where it lives

- **A view inside Decks (variant B).** The Decks tab has a **My Decks / Want List** switch. The Want List gets no tab of its own, and the phone tab bar doesn't change.
- **Opening it from a Deck shows that Deck's needs only.** Each Deck card on My Decks has a "Want List: N cards · $X" button. It opens the Want List scoped to that Deck: the heading, the summary, the cost and the export all cover that Deck.
- **Deck chips.** Chips switch between **All Decks** and each Deck. The My Decks / Want List switch always opens **All Decks**.

### The page

- **Summary at the top.** It shows the cards to get and their estimated cost, with how many of those cards are priced. An unpriced card is reported separately and never counted as $0. Beside the summary are the counting setting and **Buy on TCGplayer**.
- **Counting setting.** The choices are **Every Deck built at once** (the default) and **One Deck at a time**, with a one-line explanation of the current choice. Switching recounts everything on the page.
- **One section per Deck.**
  - **Each line shows** the exact Card Edition, "N of M" still needed, where the counted copies are ("Have 1 in this Deck · 1 spare", and "1 in Gardevoir ex" under One Deck at a time), the line cost and the price of each copy.
  - **A line with no copies counted** says so: "Your 4 are counted for other Decks" when you own copies, or "None owned" when you don't.
  - **A Deck that needs nothing** collapses to "Nothing to get".
  - **Open Deck** goes to the deck builder.
- **Combined total.**
  - **Desktop:** a sticky right-hand column. Each card appears once, with a line naming the Decks that need it.
  - **Phone:** a collapsed row under the summary ("Combined total · 14 cards · $19.30") that opens the same list.
  - **Scoped to one Deck:** the total column isn't shown, because the summary already covers that Deck.

### Swap

- **When the hint appears.** A line shows "↻ You own a playable version (PAL 254) × 1" when you own a spare copy of another Edition in the same Reprint Group.
- **What Swap does.** **Swap** moves only as many copies as you own spare onto a line for that Edition in the same Deck List. The rest of the original line stays as it is. For example, 4 Iono PAL 185 with one spare PAL 254 becomes 3 PAL 185 and 1 PAL 254.
- **Undo.** Every count updates, and an Undo toast appears.

### Export

- **Buy on TCGplayer exports what the Want List is showing:**
  - under **All Decks**, the combined total;
  - with one Deck selected, that Deck's needs.
- **Counting.** The export always follows the current counting setting.
- **Dialog.** It uses the existing Mass Entry dialog's coverage wording.

### The deck builder agrees with the Want List

- **The builder now follows the counting setting.** The deck builder's "to complete" figure and its **Buy missing** default ("the cards you don't own") use the Want List's counting setting. A Deck card, the deck builder and that Deck's Want List section therefore always show the same number.
- **What this changes.** [Decide the Deck experience](../../../app-redesign/wayfinder/resolutions/decide-deck-experience.md) counted copies sleeved in other Decks as owned. That figure is now the **One Deck at a time** reading. Under the default, **Every Deck built at once**, a spare copy counts toward one Deck only.

## Variants not taken forward

- **A — Its own tab.** A Want List tab with a count badge. On phones, Catalog would move into More.
- **C — Reached from Decks and from each Deck.** A banner on the Decks index and a filtered page with a back link. Its per-Deck scoping carries over into B.

## Left to Decide the Want List contract

The prototype used placeholders for these, and [Decide the Want List contract](https://github.com/ry-cen/prizecheck/issues/204) settles them:

- Under **Every Deck built at once**, which Deck gets spare copies first. The prototype gives them to Decks in Decks-page order.
- Whether a copy sleeved in another Deck can trigger the Swap hint. The prototype shows the hint only for spare copies no Deck has counted.
- One allocation shared by the Want List, the deck builder's "to complete" and Buy missing, the Decks index and the exports.
