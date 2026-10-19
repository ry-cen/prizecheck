# Resolution — Trade List, discovery and Trade screens

**Owner confirmed:** 2026-10-19, after reviewing the prototype

**Ticket:** [Prototype the Trade List, discovery and Trade screens](https://github.com/ry-cen/prizecheck/issues/266)

**Prototype:** [Trade screens prototype](../prototypes/trade-screens/README.md)

## Decision

The owner chose **variant A**, with one change to discovery.

### Where things live

- **Trades tab.** A fifth tab, `Trades`, with a switch `Trades · Find trades · My Trade List`. Its badge counts Trades that need you.
- **My Trade List** shows one panel per For trade Location in tree order, and holds the **Open to cash offers** switch at the top.
- **Will accept** is a select on every Want List line, and **Trade Wants** is a panel after the Decks on the Want List.

### Discovery (changed from the prototype)

- An accordion: one row per Friend, opening to two columns.
- A row shows **only the matched cards**: what the Friend has that you want, and what they want that you have.
- **Propose trade opens an empty draft.** The matched cards are listed as suggestions at the top of each side, each added with one tap. The owner's reason: a draft prefilled with every match on both sides reads as offering all of your cards for all of theirs.
- A one-way row says "You could sell" or "You could buy" only when that Friend is Open to cash offers. Otherwise it says "<name> wants N of your cards" or "<name> has N cards you want".

### Trade screen

- Two columns, `You give` and `You get`, one column on a phone.
- **Received cards go to Unsorted** by default, changeable on the confirm screen.
- **A Deck switch made at Confirm swap is undone from the toast**, like other Deck List changes.
- **The liability notice shows only when a draft or Trade includes cash.** Whoever checks its wording also confirms this placement is enough. Its wording is still a placeholder.

### Drafts

- **One draft at a time.** It survives browsing. Starting a draft for someone else first asks "Discard your draft for <name>?", and cancelling keeps it. A draft never promises cards.
- The owner's reason: it scales to Stage 2, where a collector may ask several strangers about one card, and keeps them on one deal at a time.

### Countering a cash offer

- **A collector who sends a cash-only proposal can be countered with cash**, whatever their own Open to cash offers setting. The check is skipped on a Counter when the proposal it answers already had a cash-only side. This reverses the earlier default (plumbing resolution, question 6).
- A Counter that introduces a cash-only side to a collector not Open to cash offers is still refused.

## Not decided here

- The prototype's **Proposed wording** stays proposed. Tickets use it unless the owner changes it during implementation.
- The liability notice's wording (needs someone qualified before launch).

## Where this landed

- The [map](../map.md), the [spec](../../spec.md) (Finding matches, stories 63, 99 and 100, the shapes of a proposal), the [plumbing resolution](decide-trading-plumbing.md) (question 6) and `CONTEXT.md` (Open to cash offers).
- Tickets [#270](https://github.com/ry-cen/prizecheck/issues/270) (one draft at a time), [#276](https://github.com/ry-cen/prizecheck/issues/276) (empty draft with suggestions), [#277](https://github.com/ry-cen/prizecheck/issues/277) (notice only with cash) and [#278](https://github.com/ry-cen/prizecheck/issues/278) (cash Counters).
