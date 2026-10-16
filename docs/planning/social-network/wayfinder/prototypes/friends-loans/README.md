# Friends, inbox and Loan screens prototype

This prototype supports [Prototype the Friends, inbox and Loan screens](https://github.com/ry-cen/prizecheck/issues/240). It is design evidence only, not production code. It follows [the Loan steps](../../resolutions/decide-loan-steps.md), [the Loan inventory model](../../resolutions/decide-loan-inventory-model.md), [the module boundary](../../resolutions/decide-social-module-boundary.md) and [the Friends' cards verdict](../../resolutions/prototype-friends-cards.md).

## How to run it

The prototype is one self-contained page, [`index.html`](index.html), in vanilla JavaScript with in-memory data. It saves and sends nothing. Serve the repository root:

```bash
python3 -m http.server 5194 --bind 127.0.0.1
```

Then open `http://127.0.0.1:5194/docs/planning/social-network/wayfinder/prototypes/friends-loans/index.html?variant=A`.

- **Switcher (purple bar):** ‹ › or the ← and → keys cycle the variants. **Phone frame** shows the phone layout. **Reset** puts every Loan back to its starting step.
- **Dashed ⟲ buttons** play the other collector, for example "Kim confirms handover". They're prototype-only.

## The question

- What the inbox lists, and where it lives.
- Accepting part of a request, confirming handover and return, writing off and cancelling.
- Where lent and Borrowed Copies show in the Collection, Decks and the Want List.
- Managing Friends, Blocks, the Handle, the Invite Link and Hidden Locations.

## Shared by every variant

- **Inbox:**
  - **Waiting on you:** Friend Requests (Accept or Decline inline) and every Loan that needs your step.
  - **Updates:** dismissible.
  - The badge counts only "waiting on you". A cancel reads "Jo R. cancelled this Loan" and never gives a reason.
- **Loan screen:**
  - **Heading:** "Lending to Kim" or "Borrowing from Ash K.", the return-by date and an overdue tag. A status callout, then four steps: Requested or Offered, Accepted, Handed over, Returned. While a handover is half-confirmed, the Handed over step shows each side's tick.
  - **Lines table:** each line has the card image on the left, then copies plus returned, written-off and "out" tags. The lender also sees the Pick List ("Take from: Charizard ex (Deck)"), and a stale pick is flagged ("Binder 2 has none now · use Unsorted") with **Use suggested picks**.
  - **Answering a request or offer:** a stepper on each line accepts part of it. A line set to 0 shows "Not lent".
  - **Accepted:** **I handed these to Kim** or **I have these cards**. **Take back my confirmation** is available until the other side confirms. **Cancel Loan** is available only before anyone confirms.
  - **Handed over:** **Record a return** or **Give cards back**, which can be partial. The lender also has **Change return-by date** (later or cleared, never earlier) and **Write off…** (partial, with a can't-undo warning). The borrower has **Ask for more time**.
  - **Write-off choice for the borrower:** **I still have it: keep in my Collection** or **It's gone: remove it**.
- **Collection:**
  - **Lent out:** a virtual entry in the Location tree, with a count, that lists lent copies ("Lent to Sam · from Miraidon ex (Deck) · overdue").
  - **Borrowed Copies** show in the Deck that holds them, tagged "from Ash K.".
  - **Hiding:** each Location has **Hide from Friends**. A hidden Location and everything inside it show "🙈 Hidden from Friends". A child of a hidden Location says "Hidden because Trade Binders is hidden" and can't be shown on its own.
- **Deck view:** lines read "2 yours · 1 from Ash K.", "4 yours · 2 reserved for Kim" or "1 yours · 3 lent to Sam".
- **Friends management:**
  - Add by Handle, with each lookup result: try `misty_w`, `pat_trades` (someone you blocked), a Friend's Handle, or anything else.
  - The Invite Link, with **Copy** and **New link**.
  - The Friends list with **Remove** and **Block**, and outgoing requests with **Withdraw**.
  - The Blocked list with **Unblock**.
  - Your Display Name and Handle, showing the 30-day wait.
  - A summary of what's hidden from Friends.

## Variants: where it lives

- **A — A Friends tab.** A fourth tab, with a badge, holds an **Inbox · Loans · Friends** switch. On a phone, Friends takes the fourth tab-bar slot.
- **B — Spread across existing places.**
  - **Inbox:** a 🔔 bell with a badge in the header opens a drawer.
  - **Loans:** a **Locations · Loans** switch on the Collection page.
  - **Friends management:** a "Friends and privacy" section on the Settings page. There's no new tab.
- **C — One Loans page.** A **Loans** tab puts "Waiting on you" and Updates first, then every Loan grouped (Lent out, Borrowed, Ready to hand over, Requests and offers, Closed). Friends management is one tap away, under **☺ Friends**.

- **D — B with Loans as a tab of its own.** Added at the owner's request. The inbox stays a 🔔 bell drawer, and Friends management stays in Settings, as in B. A **Loans** tab, whose badge counts only Loans that need you, holds every Loan grouped as in C, but without the inbox list. The Collection keeps the **Lent out** entry in its Location tree and loses B's Locations · Loans switch. On a phone, Loans takes the More slot.
  - **Friends drawer:** added after the owner asked where the Friends list lives. A ☺ button beside the bell, with a badge for incoming Friend Requests, opens a drawer like the inbox. It holds incoming Friend Requests (Accept or Decline), adding by Handle, the Invite Link, the Friends list with Remove and Block, and outgoing requests.
  - **Settings:** keeps only a Privacy section (Blocked, your names, Hidden Locations), linked from the bottom of the drawer.

- **E — Streamlined D.** Added at the owner's request ("very streamlined"). Same places as D: a Loans tab, the 🔔 inbox drawer, the ☺ Friends drawer and Privacy in Settings. What changes:
  - **Loans page:** no intro text or callout. The sections are **Needs you**, **Out now** and **Pending**, with **History** folded away. Each row's headline reads from your side ("Kim wants to borrow 3 cards", "Ash K. says they handed you 3 cards", "Sam has 3 cards of yours", "Ash K. wrote off 1 card"), above the card names and a due or overdue line.
  - **No buttons on the rows:** buttons were tried and then removed at the owner's request, because a list mixing different kinds of Loans at different steps made them confusing. The rows keep the plain-language headlines, and every action is on the Loan screen.
  - **Loan screen:** the step tracker and explanatory paragraphs are gone. The heading reads "Sam · You're lending · Overdue (10 Oct)". Each line shows its image, name and count. The heading is the same plain-language headline as the row. There's **one primary button**, the next step, with Decline or "It's gone" beside it only when the choice is binary. Everything else sits behind **⋯**: Withdraw, Take back my confirmation, Cancel Loan, Change return-by date, Write off… and Ask for more time. A one-line note appears only when something needs explaining ("A pick is out of date.", "Ash K. says they handed these over.").
  - **Friends drawer:** the list comes first, with incoming requests at the top. **Add** opens a short Handle search and **Copy link** for the Invite Link. Each Friend's **⋯** holds Remove Friend and Block, and a **Privacy and blocked** link leads to Settings.
  - **Inbox drawer:** one line per Loan, "Kim · Hand over", then **Earlier** updates with a single **Clear**.

## Owner verdict — 2026-10-15

1. **Variant E.** Loans get their own tab, with the inbox and Friends as header drawers and Privacy in Settings.
2. **Wording:** the plain-language headlines on rows and on the Loan screen.
3. **No buttons on list rows,** because mixed kinds and steps made them confusing.
4. The full decision is in [the Friends, inbox and Loan screens resolution](../../resolutions/prototype-friends-loans.md).

## Mock Loans

| Loan | You are | Starts at | Shows |
|---|---|---|---|
| Kim · 2 Rare Candy, 1 Arven | lender | Borrow Request to answer | partial accept, Pick List, a stale pick |
| Ash K. · 2 Iono, 1 Charizard ex | borrower | accepted, Ash confirmed handover | your half of the handover, Borrowed Copies in Charizard ex |
| Sam · 3 Electric Generator | lender | handed over, overdue | partial return, write-off, extending the date |
| Kim · 1 Pidgeot ex | borrower | Kim started a return | confirming a return |
| Jo R. · 2 Nest Ball | borrower | Lend Offer to answer | accepting an offer |
| Ash K. · 2 Boss's Orders | borrower | Ash wrote off 1 | the keep-or-remove choice |

## Placeholders, not decisions

- Dates, "5 days ago" and the Invite Link are fixed text.
- Editing the Display Name and the Collection's own cards aren't prototyped.
- The Want List isn't shown. Borrowed Copies clear its lines as decided, and lent lines never appear on it.

## Checks — 2026-10-15

- **Variant A, desktop:**
  - Kim's request was accepted with Arven set to 0, which then read "Not lent". After **Use suggested picks**, confirming the handover showed "Waiting for Kim to confirm the handover… You can take back your confirmation". The simulated confirmation moved it to "Lent to Kim".
  - Sam's Loan: writing off 1 Electric Generator, then a return of 2 that both sides confirmed, closed the Loan as Returned.
  - The inbox count went from 6 to 5 as items were handled.
- **Variant B:**
  - The bell drawer listed 6 items.
  - **Keep** on Ash's write-off cleared the choice.
  - **Lent out** listed Sam's 3 Electric Generator. Trade Binder A showed "Hidden because Trade Binders is hidden", and hiding Binder 2 marked it.
  - Settings held Friends and privacy. Looking up `pat_trades` offered Unblock, and an unknown Handle showed "No collector has that Handle."
  - Charizard ex showed "1 yours · 1 from Kim".
- **Variant C:** the Loans page led with "Waiting on you".
- **Phone, 375 × 812:** no horizontal scroll on the Loan screen, and the action buttons stack. No console errors.
- **Variant D:** the Loans tab badge showed 5 and the bell drawer 9 items. Confirming Ash's handover from the drawer moved the Loan to "Borrowed from Ash K.". Settings held Friends and privacy, and the Collection showed Lent out with no Loans switch. No horizontal scroll at 375 px.
- **Variant D Friends drawer:** looking up `misty_w` found Misty W., and accepting Lee's request added them to the list. Settings then showed only Privacy. Nothing past the edge at 375 px.
- **Variant E:** each Needs you row showed its next step. On Sam's Loan, ⋯ offered Change return-by date and Write off…. Kim's request went from Accept to Use suggested picks to Handed to Kim. The Friends ⋯ offered Remove Friend and Block, and Add found Misty W. No element past the edge at 375 px, and no console errors.
- **Variant E row buttons (since removed):** **Yes, I have them** on Ash's Loan moved it to Out now as "You have 3 cards of Ash K.'s". **Yes, I gave them back** closed Kim's Pidgeot ex Loan. **Record a return** on Sam's opened the return dialog, and the row then read "Waiting for Sam to confirm the return". Tapping a row's text opened the Loan.
- **Overflow fix:** a duplicated `<style>` tag had cancelled the box-sizing reset in this prototype and in the Friends' cards one. With it removed, no element goes past the right edge at 375 px.
- **Not verified:** real touch, screen readers, and focus handling in dialogs.
