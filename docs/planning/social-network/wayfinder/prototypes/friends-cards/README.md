# Friends' cards prototype

This prototype supports [Prototype Friends' cards on the Want List and in card search](https://github.com/ry-cen/prizecheck/issues/239). It is design evidence only, not production code. It follows [the social network behaviour](../../resolutions/decide-social-behaviour.md) and [the module boundary resolution](../../resolutions/decide-social-module-boundary.md).

## How to run it

The prototype is one self-contained page, [`index.html`](index.html). It uses vanilla JavaScript, keeps its data in memory and saves or sends nothing. Its styles reuse the [Want List prototype](../../../../decklist-import/wayfinder/prototypes/want-list/index.html)'s kit, and its colours come from `web/src/tokens.css`.

Serve the repository root so the link to `tokens.css` resolves:

```bash
python3 -m http.server 5194 --bind 127.0.0.1
```

Then open `http://127.0.0.1:5194/docs/planning/social-network/wayfinder/prototypes/friends-cards/index.html?variant=A`.

- **Switcher (purple bar):** ‹ › or the ← and → keys cycle the variants. **Phone frame** shows the phone layout in a 375 × 812 frame. **Other printings** switches whether Friends' copies of other Printings in the Reprint Group count, which stands in for the counting setting.
- **URL:** the page reads and writes `?variant=A|B|C|D`, `&frame=phone` and `&alt=off`.

## The question

- Where does "Friends who have this" show: on Want List lines, in the catalog card popup, on a separate Friends page, or a mix?
- How do spare and in-a-Deck copies read and rank, with no Location or Deck names?
- How does a collector build a multi-line Borrow Request for one Friend, optionally for a Deck?
- How does browsing one Friend's Collection work?

## What every variant shares

- **Friends' copies** are only the ones they could lend now. Each one reads "2 spare" or "1 in a Deck", and spares are listed first. A copy of another Printing carries a dashed tag with its set and number (for example "PAL 254"). Friends' Location and Deck names never appear.
- **The catalog card popup** (Catalog tab, or a card's name on the Want List) lists "Friends who have this", each with **Ask to borrow**.
- **A Friend's Collection** opens from their name anywhere. It's a gallery filtered to **On my Want List** by default, with **All cards** and a search. Each card has **Ask to borrow**, which turns into a stepper.
- **Borrow Request tray:** every "Ask to borrow" adds to a draft for that Friend, one draft per Friend. The tray shows each draft, and **Review** opens the composer. The composer has a stepper for each line (capped at what the Friend can lend), **For Deck** (or none, which goes to Unsorted), an optional **Return by** date, and **Send Borrow Request**.

## Variants: where Friends' cards show

- **A — On each Want List line.** Every line that a Friend can cover gets a "Friends:" row of chips: name plus spare and in-a-Deck tags. Tapping a chip adds one copy to that Friend's draft and ticks the chip.
- **B — A Get from Friends view.** The Want List gets a **Buy / Get from Friends** switch. Lines show only "2 Friends can lend this", which opens the view.
  - **Panels:** one per Friend, ranked by how many of your needed cards they can cover ("Can lend 7 of the 11 cards you need").
  - **Selecting:** a checkbox per card, and **Ask Ash for these** fills a draft with everything that Friend can cover.
- **D — Chips plus a per-card Get from Friends view.** Added at the owner's request. The Buy view has A's chips on each line, and the **Buy / Get from Friends** switch from B. The Get from Friends view has one panel per card you need instead of one per Friend.
  - **Panel heading:** the card, "You need 4 · Charizard ex · Gardevoir ex", and "3 of 4 asked".
  - **Rows:** one per Friend who can lend the card, spares first, each with **Ask** that turns into a stepper.
  - **Drafts:** asking across several Friends builds one draft per Friend, so the tray can hold several.
- **C — A Friends page.** A **Friends** tab lists Friends with "Has 7 cards you need". The Want List shows only a banner linking there. Borrowing starts from a Friend's Collection or the card popup.

## Mock data

Two Decks need 11 cards. Four Friends:

- **Ash:** covers 7, mixing spare and in-a-Deck copies.
- **Kim:** covers 4, including an Iono PAL 254 that counts for Iono PAL 185 only when **Other printings** is on.
- **Sam:** covers 3, all in a Deck.
- **Jo:** has nothing on your Want List.

## Placeholders, not decisions

- The Friends tab in variant C only stands in for wherever [#240](https://github.com/ry-cen/prizecheck/issues/240) puts Friends management.
- The combined need per card is a plain sum across Decks. The real figure follows the counting setting.
- Coverage ("can lend 7") counts every lendable copy, whether spare or in a Deck.

## Owner verdict — 2026-10-15

1. **Variant D:** chips on each Want List line, plus a per-card Get from Friends view.
2. **Card image** on the left of each card panel's heading, not above it. This was changed in the prototype.
3. The full decision is in [the Friends' cards resolution](../../resolutions/prototype-friends-cards.md).

## Checks — 2026-10-15

- **Desktop:**
  - Variant A: chips added Iono ×2 and Charizard ex to Ash's draft. The composer showed both, with steppers. Sending cleared the tray.
  - Variant B: panels ranked Ash 7, Kim 4, Sam 3. **Ask Kim for these** drafted 4 lines.
  - Variant C: Friends listed 7, 4, 3 and "Nothing on your Want List" for Jo. Sam's Collection showed only in-a-Deck copies.
  - The card popup for Iono PAL 185 listed Ash, then Sam, then Kim's PAL 254.
  - No console errors.
- **Phone, 375 × 812:** no horizontal scroll (scroll width 375), and the chips wrap. The tray sits above the tab bar. The toast moved to the top so it no longer covers the tray.
- **Variant D, desktop:** 14 chips on the Buy view and 7 card panels. On the Iono panel, Ash ×2 and Kim's PAL 254 ×1 read "3 of 4 asked" and made two drafts in the tray. No console errors.
- **Not verified:** real touch, screen readers, and focus handling in dialogs.
