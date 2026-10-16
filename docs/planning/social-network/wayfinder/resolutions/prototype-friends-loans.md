# Resolution — Friends, inbox and Loan screens

**Owner confirmed:** 2026-10-15, after reviewing the prototype

**Ticket:** [Prototype the Friends, inbox and Loan screens](https://github.com/ry-cen/prizecheck/issues/240)

**Prototype:** [Friends and Loans prototype](../prototypes/friends-loans/README.md)

## Decision

The owner chose **variant E**, a streamlined version of D. D came out of the owner's reaction to B: they liked it but wanted Loans on a page of their own and asked where the Friends list lives. E was then refined twice: the wording was made clearer, and buttons were tried on list rows and then removed.

### Where things live

- **Loans tab.** A fourth tab, Loans, whose badge counts only Loans that need you. On a phone it takes the More slot.
- **Inbox:** a 🔔 bell in the header, with a badge, opens a drawer.
- **Friends:** a ☺ button beside the bell, with a badge for incoming Friend Requests, opens a Friends drawer.
- **Settings** keeps only a Privacy section: the Blocked list, your Display Name and Handle, and Hidden Locations.
- **Collection** keeps a **Lent out** entry in the Location tree. Borrowed Copies show in the Deck that holds them, tagged with the lender's Display Name. A Deck's lines read "2 yours · 1 from Ash K.", "2 reserved for Kim" or "3 lent to Sam".

### Loans list

- The sections are **Needs you**, **Out now** and **Pending**, with **History** folded away.
- Each row has the first card's image and a plain-language headline from your side, for example "Kim wants to borrow 3 cards", "Ash K. says they handed you 3 cards", "Sam has 3 cards of yours" or "Ash K. wrote off 1 card". Under it are the card names, then a due-back, overdue or "Waiting for …" line.
- **No buttons on rows.** A list that mixes Loans of different kinds at different steps made inline buttons confusing. Tapping a row opens the Loan.

### Loan screen

- The heading is the same headline, then "You're lending" or "You're borrowing", the Deck, and the due or overdue date.
- Each line shows the card image, name, set and count. While accepted, the lender's line also shows its pick ("From Binder 1"), or a warning when the pick is out of date. Returned and written-off copies are tagged.
- **One primary button**, which is the next step:
  - Accept, with Decline beside it;
  - Use suggested picks;
  - Mark as handed over, or Yes, I have them;
  - Record a return, or Give cards back;
  - Yes, they're back, or Yes, I gave them back;
  - I still have it, with It's gone beside it.

  When you're waiting on the other side, the button is replaced by "Waiting for Kim to confirm".
- When answering, a stepper on each line lets you accept part of a request or offer. A line set to 0 reads "Not lent".
- **Everything else is behind ⋯:** Withdraw, Take back my confirmation, Cancel Loan, Change return-by date, Write off… and Ask for more time. Each appears only when the Loan steps allow it.
- A one-line note appears only when something needs explaining, for example "A pick is out of date." or "Ash K. says they handed these over."
- No step tracker and no explanatory paragraphs.

### Friends drawer

- Incoming Friend Requests sit at the top, with Accept and Decline. The Friends list follows, then outgoing requests with Withdraw.
- **Add** opens a short Handle search and **Copy link** for the Invite Link.
- Each Friend's **⋯** holds Remove Friend and Block. A **Privacy and blocked** link goes to Settings.

### Inbox drawer

- One line per Loan that needs you, for example "Kim · Hand over". Then **Earlier** updates, with a single **Clear**.
- It never reveals an unfriend or a Block.

### Not taken forward

- **A**'s Friends tab, **B**'s Loans switch inside the Collection, **C**'s single Loans page with the inbox on top, and **D**'s unstreamlined screens, including the step tracker and the visible secondary buttons.

## Left for later

- **Settings on a phone.** Settings, and with it Privacy, has no phone entry point once Loans takes the More slot. The spec needs to place it, for example behind an avatar button in the phone header.
- **Prototype stand-ins:** the dates, the Invite Link and the Collection's own cards are placeholders. Editing the Display Name wasn't prototyped.
