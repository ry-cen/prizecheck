# Resolution — Friends' cards on the Want List and in card search

**Owner confirmed:** 2026-10-15, after reviewing the prototype

**Ticket:** [Prototype Friends' cards on the Want List and in card search](https://github.com/ry-cen/prizecheck/issues/239)

**Prototype:** [Friends' cards prototype](../prototypes/friends-cards/README.md)

## Decision

The owner chose **variant D**, which was added at their request after A to C: chips on each Want List line, plus a **Get from Friends** view with one panel per card. They asked for the card image to sit to the left of each panel's heading.

### On the Want List

- **Chips on each line.** A line that a Friend can cover shows a "Friends:" row of chips, one per Friend, for example "Ash K. · 2 spare · 1 in a Deck". Tapping a chip adds one copy to that Friend's draft Borrow Request and ticks the chip.
- **A Buy / Get from Friends switch** sits in the Want List summary. **Buy** is today's Want List, with the chips added.

### The Get from Friends view

- **One panel per card you need** that at least one Friend can lend. The heading has the card image on the left, then the card and its Card Edition, "You need 4", the Decks that need it, and "3 of 4 asked".
- **One row per Friend who can lend it**, with their Display Name and Handle, spare and in-a-Deck counts, spares first, and **Ask**, which turns into a stepper.
- Cards no Friend can lend are summed up in one line under the panels.
- Asking several Friends for one card builds one draft per Friend.

### Shared by every entry point

- **Friends' copies** are only the ones they could lend now. They read "N spare" or "N in a Deck", with spares first. A copy of another Printing in the Reprint Group carries its set and number and counts only when the counting setting allows it. Friends' Location and Deck names never appear.
- **The catalog card popup** lists "Friends who have this", each with **Ask to borrow**.
- **A Friend's Collection** opens from their name. It's a gallery filtered to **On my Want List** by default, with **All cards** and a search, and **Ask to borrow** on each card.
- **Drafts and the composer:** "Ask" anywhere adds to that Friend's draft. A tray lists the drafts, and **Review** opens the composer. The composer has a stepper per line, capped at what the Friend can lend, **For Deck** (or none, which goes to Unsorted), an optional **Return by** date, and **Send Borrow Request**.

### Not taken forward

- **A** on its own, **B**'s panel per Friend, and **C**'s Friends page as the way into Friends' cards.
- Where Friends are managed, and what the Friends list looks like, belong to [#240](https://github.com/ry-cen/prizecheck/issues/240).

## Left for later

- The prototype's need per card is a plain sum. The real view uses the Want List's counting setting and its Deck scoping.
- When several drafts are open, the tray stacks one bar per Friend, which can crowd a phone screen. [#240](https://github.com/ry-cen/prizecheck/issues/240) designs the drafts and the composer in full.
