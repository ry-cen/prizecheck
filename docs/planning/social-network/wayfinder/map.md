# Social network — decision map

**Label:** wayfinder:map

**Status:** charted 2026-10-15.

## Destination

A handoff-ready spec at `docs/planning/social-network/spec.md` for Friends, Loans (lending, Borrow Requests and Lend Offers) and finding which Friends have the cards a collector needs. The spec must settle the domain terms, the new backend module's boundary and the privacy rules well enough to be broken into implementation tickets. This effort resolves decisions only. The spec, implementation tickets and application code come after this map.

## Notes

- Owner request on 2026-10-15: add a social network, starting with adding Friends, lending cards to Friends, requesting to borrow from Friends and seeing which Friends have the cards you're looking for.
- This effort reverses the "Sharing the Want List, or requesting cards from other collectors" exclusion in the [decklist import map](../../decklist-import/wayfinder/map.md).
- The behaviour settled while charting (friendship, visibility, matching, Loan steps, requests, notifications, unfriending) is recorded in [Decide the social network behaviour](resolutions/decide-social-behaviour.md). New terms are in `CONTEXT.md`: Friend, Friend Request, Handle, Display Name, Invite Link, Block, Hidden Location, Loan, Borrow Request, Lend Offer, Borrowed Copy, Write-off.
- Friends never see Location or Deck names. A Handle is not a public profile and never appears on Published Decks.
- The owner delegates technical plumbing (module boundary, data model, API contracts): decide and record it, and grill the owner only on collector-facing effects.
- Use grilling and domain-modeling for decision tickets, prototype for prototype tickets and research for research tickets. Use `CONTEXT.md` vocabulary and record new terms there as they're resolved. Follow AGENTS.md's UI copy rule in prototypes. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: social network`, blocked with GitHub's native dependencies and a "Blocked by" body line. Prototypes, research and resolutions live beside this map. Open tickets: [`feature: social network`](https://github.com/ry-cen/prizecheck/issues?q=label%3A%22feature%3A+social+network%22+is%3Aopen).

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- [Research how copy allocation, Spare Copies and the Want List work today](https://github.com/ry-cen/prizecheck/issues/242): a Holding has exactly one owner and SQL enforces it, nothing is reserved today, and Spare Copies are worked out fresh on every read from five copies of the same rule. Holding rows have no stable identity, locks and revisions are per owner, and there's no row-level security. Collection value isn't computed anywhere. Candidates: lender side L1 to L3, borrower side B1 or B2. [Findings](research/copy-allocation-and-loans.md)
- [Decide Handle and Invite Link rules](https://github.com/ry-cen/prizecheck/issues/238): every account gets a random, unguessable Handle and a Display Name, both changeable. Handles are 3–20 characters, unique ignoring case and changeable every 30 days. Each collector has one reusable, regenerable Invite Link that shows only their Display Name. [Resolution](resolutions/decide-handle-and-invite-link-rules.md)
- [Decide the Loan inventory model](https://github.com/ry-cen/prizecheck/issues/236): accepting promises a count and gives the lender a Pick List, and handover confirms it. Picks can go out of date and are re-picked; the promised total is protected. Lent copies sit in no Location and return to their source by default. The lender's Deck shows reserved or lent lines, never on the Want List. Borrowed Copies move like owned copies, fill or add Deck List lines and count toward deck cost, but are never spare, removable or owned. A Write-off is final. [Resolution](resolutions/decide-loan-inventory-model.md)
- [Decide the Loan steps in detail](https://github.com/ry-cen/prizecheck/issues/237): each side's confirmation moves only their own inventory, with no auto-confirm. Copies are reserved once the lender says yes, including on sending a Lend Offer. Either side can cancel until someone confirms the handover. There are no edits after acceptance (edit and resend instead), and partial returns are allowed. The lender sets and extends the return-by date. On a Write-off the borrower chooses to keep or remove the copies. Blocks work like unfriending, and account deletion leaves handed-over Loans for the other side to close alone. The inbox splits into "waiting on you" and "updates" and never reveals a Block. [Resolution](resolutions/decide-loan-steps.md)
- [Decide the social module boundary and privacy enforcement](https://github.com/ry-cen/prizecheck/issues/241): a new `social` API area. Lender-side Loan picks are kept per Edition outside `holding`, and Borrowed Copies go in their own table. The Spare Copy rule becomes one shared function. Every Friend read goes through one choke point that returns only per-Edition spare and in-Deck counts. Two-owner steps lock owners in `user_id` order. Friends see only lendable copies, hiding a Location covers everything inside it, and Handle lookup is limited to 30 per hour with no way to detect a Block. [Resolution](resolutions/decide-social-module-boundary.md), [ADR 0014](../../../adr/0014-friend-reads-and-two-owner-loans.md)
- [Prototype Friends' cards on the Want List and in card search](https://github.com/ry-cen/prizecheck/issues/239): the owner chose chips on each Want List line plus a Buy / Get from Friends switch whose view has one panel per needed card, image on the left. The card popup and a Friend's Collection also offer Ask to borrow, and each ask builds a per-Friend draft Borrow Request. [Resolution](resolutions/prototype-friends-cards.md)

## Not yet specified

- Email (or push) notifications for Loan steps, beyond the in-app inbox.
- Sending one Borrow Request to several Friends at once, split per Friend.
- A quick in-person handover that combines accepting with confirming the handover.
- Whether Friends see each other's Published Decks, or any profile beyond the Handle and Display Name.

## Out of scope

- Trading and giving cards, including one-sided gifts. A Loan never transfers ownership; that is a separate future feature.
- Following deck builders or any one-way follow.
- Messaging between collectors, activity feeds and groups.
- Reporting and moderation of collectors.
- Finding collectors by email address.
