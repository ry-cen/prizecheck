# Trading screens prototype

This prototype supports [Trading: see and choose the Trade List, discovery and Trade screens before they are built](https://github.com/ry-cen/prizecheck/issues/266). It is design evidence only, not production code. It follows [the spec](../../../spec.md), [the decision map](../../map.md), [the plumbing resolution](../../resolutions/decide-trading-plumbing.md), [the Friends, inbox and Loan screens verdict](../../../../social-network/wayfinder/resolutions/prototype-friends-loans.md) and the Trading terms in [`CONTEXT.md`](../../../../../../CONTEXT.md).

## How to run it

The prototype is one self-contained page, [`index.html`](index.html), in vanilla HTML, CSS and JavaScript with in-memory data. It loads only the shared design tokens, and it saves and sends nothing. Serve the repository root:

```bash
python3 -m http.server 5197 --bind 127.0.0.1
```

Then open `http://127.0.0.1:5197/docs/planning/trading/wayfinder/prototypes/trade-screens/index.html?variant=A`.

- **Switcher (purple bar):** ‹ › or the ← and → keys cycle the variants. **Phone frame** shows the app in a 375 × 812 frame, with the phone layout. **Options** holds the three behaviour options and the mock-data mode. **Wording** lists every proposed message. **Reset** restores the mock data.
- **Dashed ⟲ buttons** play the other collector, for example "Ash K. accepts" or "A card moved meanwhile". They are prototype-only.
- **URL parameters**, all read on load and written on every render:
  - `variant` = `A`, `B` or `C`
  - `screen` = `home`, `trades`, `discovery`, `match`, `friendlist`, `mylist`, `draft`, `trade`, `wantlist`, `collection`, `settings` or `catalog`
  - `trade` = a Trade id, `friend` = a Friend id
  - `frame=phone`
  - `dest` = `unsorted`, `last` or `none`
  - `undo` = `none`, `toast` or `screen`
  - `draft` = `tray` or `one`
  - `data` = `usual`, `nofriends` or `emptylist`

  Loading a URL seeds fresh data. Nothing survives a reload.

## The question

- Where Trades are listed: a tab of their own, inside Loans, or elsewhere.
- The destination picker's default for received cards.
- Where Trade Wants and the Will accept choice sit on the Want List page.
- Where Open to cash offers lives.
- Whether and how the web offers an Undo of a Deck switch after Confirm swap.
- How a draft proposal is kept while the collector browses.
- Plus the layouts: discovery, your own Trade List, and the Trade screen, and the plain-language wording the ticket asks the owner to approve.

## Shared by every variant

- **UI copy rule:**
  - No data-source or provider name, no fetch or check time, no cache or refresh state, no internal reason or code, and no record id.
  - Discovery rows and the match page show no prices or values.
  - A Friend's view never shows a Location or Deck name: discovery, the match page, a Friend's Trade List and the catalog popup. Your own Trade List, your picks, Collection and Confirm swap may show your own names.
  - The liability notice is the only exemption.
- **Trading terms** follow the glossary: Trade, Trade Proposal, For trade, Trade List, Trade Wants, Will accept, Confirm swap and Open to cash offers.
- **Trade rules that differ from Loans:**
  - A proposal is accepted, declined or countered whole. There are no per-line steppers when answering, and Counter is the way to edit.
  - There is no take-back of a Confirm swap and no partial swap, and nobody can cancel once either side has confirmed.
  - Deck lines carry no "promised in a Trade" label.
  - A proposal needs at least one card on either side. Gifts are allowed.
  - A side that gives only cash needs the recipient to be Open to cash offers. A Counter is judged by its own recipient's setting.
  - The same card is never on both sides.
  - Your copies are promised when you send or when you accept. The other side's copies are promised by their send or accept.
- **Trades list** follows the Friends and Loans verdict: Needs you, To swap and Pending, then a folded History. Rows carry a plain-language headline from your side and no buttons.
- **Trade screen:**
  - The h1 is the headline. Under it come the person row (with the Counter tag and link, and the Open to cash offers badge), one note only when needed, the two sides with their `Estimated …` footers, the cash panel, the liability box and the actions.
  - A recipient answers with Accept, Counter (hidden when the sender gives only cash and isn't open) and Decline. A proposer has Use suggested picks when a pick is stale, and Withdraw behind ⋯.
  - An accepted Trade has one primary button, Confirm swap, or Use suggested picks first when a pick is stale. Cancel Trade sits behind ⋯ until either side confirms.
  - A closed Trade shows nothing to press.
- **Draft proposal (composer):**
  - Both sides, with steppers capped at what can be traded and a picker that groups Editions under their card name.
  - Cash with a payer: `No cash`, `You pay`, or `<Friend> pays`. No suggested amount anywhere.
  - Each side's estimated total, in its full, partial (`for 2 of 3 cards`) and none wordings.
  - The liability box under the cash row, and Send, disabled with a hint while both sides are empty.
  - Send checks, in order: the cash amount, cash-only to a Friend who isn't open, then lines over what can be traded.
- **Confirm swap:**
  - A dialog with what you give (and where from), what you get, the destination picker, the ticked-by-default Deck switch choice, the cash line, and "The swap can't be undone."
  - Dashed sims reproduce each refusal message.
- **Match page and a Friend's Trade List:** the match page lists every card on both sides with counts, accepts-as tags and want counts. A Friend's Trade List shows cards and counts only, grouped and searchable by card name.
- **Drawers:**
  - The bell opens the inbox: one line per waiting Trade or Loan, then Earlier updates with a single Clear.
  - ☺ opens Friends. Each Friend's ⋯ holds Remove Friend and Block, with an inline question that counts Loans and Trades together.
- **Collection:**
  - A tree of Locations with `For trade`, `🙈 Hidden` and `(Deck)` marks, and a Location panel with For trade and Hide from Friends switches.
  - A covered child explains why it is For trade. A Deck can't be marked For trade.
  - Remove 1 on a card with a valid pick shows the promised-to-a-Trade refusal.

## Variants

Placement and layout are bundled into three variants so the owner can compare whole shapes. The three behaviour questions are independent Options, so the owner can mix, for example A's placement with C's Will accept placement.

- **A, Trades tab.**
  - **Placement:** a fifth tab, `Trades` (phone: fifth slot), with a switch `Trades · Find trades · My Trade List`. The tab badge counts Trades in Needs you.
  - **Discovery:** an accordion. Each row is a header (initials, name, kind, badge, headline) that opens to two columns, with `Propose trade` and the link to the Friend's Trade List.
  - **Own Trade List:** the `My Trade List` view, one panel per For trade Location in tree order, with a tag on Spares box.
  - **Trade screen:** two columns, `You give` and `You get`, one column on a phone.
  - **Will accept and Trade Wants:** a `Will accept` select on every Want List line, and a `Trade Wants` panel after the Decks.
  - **Open to cash offers:** a switch at the top of My Trade List.
- **B, Inside Loans.**
  - **Placement:** the Loans tab becomes `Loans and Trades`, with a switch `All · Loans · Trades` and a `Find trades` button. Sections are Needs you (both), Out now, To swap, Pending (both) and History, and each row carries a `Loan` or `Trade` tag. The tab badge counts Loans and Trades in Needs you. The Loans tab is not renamed in the tab bar (see the open questions).
  - **Discovery:** a `Find trades` page of tiles. A tile shows the match and compact chips (`Iono ×1`), and opens the match page.
  - **Own Trade List:** a `Trade List` entry in the Collection tree, with filter chips and a flat list sorted by card name, each row with its Location.
  - **Trade screen:** the panels stacked, under a slim tracker of Proposed, Accepted and Swapped.
  - **Will accept and Trade Wants:** a tag only when widened, `Will accept…` behind each line's ⋯, and a `Trade Wants (3)` button that opens a dialog.
  - **Open to cash offers:** a `Trading` section in Settings.
- **C, Where the cards are.**
  - **Placement:** no new tab. A `Trades` page opens from the account menu or from the inbox's `All Trades ›`, and the Loans tab badge counts Loans only.
  - **Discovery:** the Want List page with a third switch, `Trade`. Every match is always open.
  - **Own Trade List:** a `Trade List` entry in the Collection tree, shown as a gallery of tiles.
  - **Trade screen:** two columns, as in A.
  - **Will accept and Trade Wants:** a tag button on every line with the current choice, opening a small menu. Trade Wants are a folded group on the `Trade` view.
  - **Open to cash offers:** a switch at the top of the Want List's `Trade` view.

## Options

Open the **Options** panel, or set the URL parameter.

- **Received cards go to** (`dest`): `Unsorted`, `Last place used` (Binder 1 to start, then whatever you chose last, marked `· last used`), or `No default (choose each time)`, where Confirm swap waits for a choice.
- **Undo of a Deck switch** (`undo`): `None`, `Undo in the toast` (8 seconds) or `Undo switch on the Trade screen`.
- **Drafts** (`draft`): `One per Friend, kept while you browse` (a tray above the tab bar) or `One draft at a time` (a pill in the header, and a question before replacing it).
- **Mock data** (`data`): `Usual`, `No Friends` (the needs-Friends empty state) or `Empty Trade List` (no For trade Locations).

## Decisions for the owner

Each row is independent of the others, so any combination is possible.

| Question | Options | Where you see them |
|---|---|---|
| Where Trades are listed | A: a `Trades` tab. B: inside Loans, as `Loans and Trades`. C: a page from the account menu and the inbox, no tab. | Variant A, B or C, then `Trades` |
| The destination default | Unsorted. Last place used. No default. | Options, `Received cards go to`; open Confirm swap on the accepted Trade with Ash K. (`Ready to swap with Ash K.`) |
| Trade Wants and Will accept on the Want List | A: select on each line, panel after the Decks. B: tag when widened, ⋯ then `Will accept…`, `Trade Wants (3)` dialog. C: tag button on each line, folded group on the `Trade` view. | Decks, then `Want List` (A and B), or `Want List`, `Trade` (C) |
| Where Open to cash offers lives | A: My Trade List. B: Settings, `Trading`. C: Want List, `Trade`. | Variant A `My Trade List`, B `Settings`, C `Want List` then `Trade` |
| Undo of a Deck switch | None. In the toast. On the Trade screen. | Options, `Undo of a Deck switch`; Confirm swap on the accepted Trade with Ash K., with the switch ticked |
| How a draft is kept | One per Friend with a tray. One at a time with a pill. | Options, `Drafts`; propose to Ash K., go back, then propose to Kim |
| The discovery layout | A: accordion. B: tiles that open a match page. C: always open, on the Want List. | Find trades, in each variant |
| The own Trade List layout | A: panel per Location. B: flat list with chips. C: gallery. | `My Trade List` (A), the `Trade List` entry in Collection (B, C) |
| The Trade screen layout | A and C: two columns. B: stacked, with a slim tracker. | Any Trade, in each variant |

## Proposed wording

For the owner to approve. All of it also appears in the **Wording** panel.

| Code | Wording | Where it shows |
|---|---|---|
| `PROMISED_TO_TRADE`, Removal | You promised copies of Pidgeot ex (OBF 164) to a Trade, so they can't all be removed. Nothing was removed. Remove fewer copies, or cancel the Trade first. | Collection: Remove 1 when it would leave a Location with fewer copies than are promised from it (for example Lost Vacuum in Binder 3 › Holos). The card named is the one you press it on |
| `PROMISED_TO_TRADE`, Undo of an add | Undo unavailable: you promised some of these copies to a Trade, so nothing was removed. | Wording panel only |
| `PROMISED_TO_TRADE`, Edition reassignment | You promised some of these copies to a Trade. Reassign fewer copies, or confirm the swap or cancel the Trade first. | Wording panel only |
| Remove Friend and Block counts | Remove Ash K. as a Friend? This cancels 1 open Loan that hasn't been handed over, 1 Trade Proposal and 1 Trade that hasn't been swapped. Block Kim? They won't be told. This cancels 1 open Loan that hasn't been handed over and 2 Trade Proposals. 1 Trade that one of you has confirmed stays open so it can finish. | Friends drawer, ⋯ |
| `NOT_TRADEABLE`, you give | You can trade only {n} {card} now. Lower it to {n}, then send again. With none: {card} isn't on your Trade List now. Remove it, then send again. | Draft, on Send |
| `NOT_TRADEABLE`, you get | {name} can trade only {n} {card} now. Lower it to {n}, then send again. With none: {name} doesn't have {card} on their Trade List now. Remove it, then send again. | Draft, after the sim `{name}'s copies changed` |
| `NOT_TRADEABLE`, at Accept | You can trade only {n} {card} now, so you can't accept this. Decline it, or send a Counter. With none: {card} isn't on your Trade List now, so you can't accept this. Decline it, or send a Counter. | Trade screen. To reproduce: propose to Ash K. from Find trades (it promises Charizard ex OBF 223), then open the proposal from Ash K. and Accept |
| `CASH_ONLY_NOT_OPEN`, their side | {name} isn't open to cash offers, so {name} can't give only cash. Add a card from {name}'s Trade List, or remove the cash. | Draft to Sam with `Sam pays` and no cards from Sam |
| `CASH_ONLY_NOT_OPEN`, your side | {name} isn't open to cash offers, so you can't give only cash. Add a card from your Trade List, or remove the cash. | Draft to Lee or Sam with `You pay` and no cards from you |
| `PICKS_OUT_OF_DATE` | A pick is out of date. Use the suggested picks first. | Confirm swap, after the sim `A card moved meanwhile`. The Trade screen shows the line warning and the note `A pick is out of date.` |
| `UNSORTED_UNAVAILABLE` | Your top-level Unsorted can't hold cards. Choose another place for the cards you get, or make Unsorted a Storage Leaf in Collection. | Confirm swap, after the sim `Unsorted can't hold cards`, with Unsorted chosen |
| `DECK_SWITCH_CHANGED` | Your Decks changed since you opened this, so nothing was swapped. Check the Deck switches and confirm again. | Confirm swap, after the sim `The Deck changed meanwhile`, with the switch ticked |

Also proposed, and shown in context:

- `DECK_NOT_FOR_TRADE`: A Deck can't be marked For trade.
- `LOCATION_FOR_TRADE_BY_PARENT`: Binder 3 › Holos is For trade because Binder 3 is. Change it on Binder 3.
- `INVALID_CASH`: Enter an amount from $0.01 to $999,999.99.
- `TRADE_HAS_NO_CARDS`: the Send button is disabled and the hint reads "Add at least one card to either side."
- Open to cash offers switch: "Let Friends send you Trade Proposals where one side gives only cash." Turning it on toasts "Friends can now send you Trade Proposals where one side gives only cash." and off toasts "Friends can't send you cash-only Trade Proposals now."

## Mock data

- **Friends:** Ash K. and Kim are Open to cash offers. Lee, Sam and Jo R. are not. Jo R. matches nothing, so Jo R. has no discovery row. Open to cash offers is seeded on for you although the default for a new collector is off, because the cash-only proposal from Sam needs it.
- **Trades:**

| Trade | You are | State | Shows |
|---|---|---|---|
| Ash K. · proposal to you with cash | recipient | proposed | Accept, Counter, Decline. Ash K. pays you $15.00. |
| Kim · a Counter to a proposal you sent | recipient | proposed | the Counter tag and `See what you sent`. You pay Kim $3.00. |
| Sam · cash-only proposal to you | recipient | proposed | you could sell. Counter is hidden because Sam isn't open. |
| Jo R. · gift to you | recipient | proposed | a gift received |
| Ash K. · cards for cards | proposer | accepted, nobody confirmed | Confirm swap with the Deck switch (Iono PAL 269 came through Will accept for Charizard Pidgeot) |
| Kim · you give 1, you get 2 | recipient | accepted, Kim confirmed | half-confirmed, your turn |
| Sam · gift from you | proposer | accepted, nobody confirmed | Confirm swap with no destination |
| Lee · cards for cards | proposer | accepted, you confirmed | half-confirmed, waiting for Lee |
| Lee · two cards from you | proposer | proposed | waiting for an answer, with a stale pick and Use suggested picks |
| Kim · cash-only proposal from you | proposer | proposed | you could buy. You pay Kim $8.00. |
| Kim · countered | proposer | closed, countered by Kim | the Trade the Counter answers |
| Ash K. · swapped | proposer | closed, swapped | swapped, 12 Oct |
| Sam · gift withdrawn | proposer | closed, withdrawn by you | withdrawn |
| Lee · declined | proposer | closed, declined by Lee | declined |
| Jo R. · cancelled after acceptance | recipient | closed, cancelled by Jo R. | cancelled |

- **Your Locations:** Binder 1, Binder 3 (For trade) with Holos and Full arts inside it, Spares box (hidden and For trade), the Decks Charizard Pidgeot, Gardevoir Control and Miraidon Box, and Unsorted.
- **Your Trade List after promises:** Charizard ex OBF 223 ×1, Pidgeot ex ×1 and Roaring Moon ex ×1 from Binder 3, and Electric Generator ×2, Boss's Orders ×2 and Nest Ball ×3 from Spares box. Lost Vacuum is not listed because both copies are promised.
- **Discovery rows:** Ash K. (two-way), Lee (two-way, 24 cards to get, so `4 more`), Kim (you could buy) and Sam (you could sell).
- **Static Loans:** Kim wants to borrow 3 cards, Sam has 3 of yours, and Ash K. hasn't answered. Opening one shows a placeholder.

## Placeholders, not decisions

- Dates and waiting times ("2 days", "12 Oct") are fixed text.
- Prices are made up.
- Discovery is static. It ignores Will accept, Trade Wants and new Trades.
- The Want List and Collection are abridged. Lee's 24 cards are not on the abridged Want List.
- Card names are real, while set numbers are plausible but not checked.
- The Loans are static, and opening one shows a placeholder.
- The Catalog is a stand-in with three cards, only to show the Friends who have a card and `Ask to trade`.

**The liability notice's wording is a placeholder. The final wording isn't decided, and someone qualified must check it before launch.**

## Open questions for the owner

- Whether "You could buy" or "You could sell" should show for a Friend who isn't Open to cash offers. The prototype shows it, as spec story 98 reads.
- Whether the liability notice shows on every Trade screen or only when there is cash.
- In B, whether the Loans tab should be renamed.
- Whether Counter should be hidden on a cash-only proposal from a Friend who isn't open, as the prototype does.
- `Undo switch on the Trade screen` needs the API to return the switch, because the Trade view carries no Deck.

## Checks — 2026-10-19

Run with a scripted browser (Chromium through Playwright) against the served page, per variant (A, B and C), at 1280 px, at a 375 px viewport and in the 375 × 812 phone frame. Every screen id, and every seeded Trade, was opened in each for the per-screen checks. The main-path walks ran at 1280 px and at the 375 px viewport. In the phone frame only the per-screen checks ran, and the walks were not repeated.

- **No element past the right edge:** nothing passed the right edge on any screen, at any width, in any variant. The prototype bar and its panels are excluded.
- **No console errors:** none on any screen, or during any walk.
- **UI copy:** no error code, record id, provider name, fetch or check time, or cache or refresh state in visible text, and none of the glossary's avoid words. No `$` and no Location or Deck name on discovery or the match page, and none on a Friend's Trade List.
- **Liability box:** present, and marked as a placeholder, on every Trade screen.
- **Main paths walked end to end** at desktop and at 375 px, in A, B and C:
  - propose with cash from discovery, then the Estimated totals and no suggested amount;
  - Counter a proposal and send it;
  - Confirm swap with the Deck switch, under each `dest` (`unsorted`, `last`, `none`) and each `undo` (`none`, `toast`, `screen`), then the other side confirming;
  - half-confirmed, with no Cancel Trade once the other side has confirmed;
  - gift received (asks where the cards go) and gift given (asks nothing);
  - stale pick, then Use suggested picks;
  - cash-only refusal when proposing to Sam, and no Counter on Sam's cash-only proposal;
  - Remove Friend and Block counts in the Friends drawer;
  - drafts, `tray` (one per Friend) and `one` (a question before replacing).
- **Also checked with a second scripted walk (desktop):** Accept refused after a proposal promised the same copies, each Confirm swap sim message, Undo in the toast and on the screen, Cancel Trade, the Options panel (including `No Friends`), Reset, the arrow keys, For trade on a Deck and on a covered child, the Remove 1 refusal, and Ask to trade from the Catalog.

**Not verified:** real touch, screen readers, and focus handling in dialogs.
