# Social network — decision map

**Label:** wayfinder:map

**Status:** charted 2026-10-15.

## Destination

A handoff-ready spec at `docs/planning/social-network/spec.md` for Friends, Loans (lending, Borrow Requests and Lend Offers) and finding which Friends have the cards a collector needs. The spec must settle the domain terms, the new backend module's boundary and the privacy rules well enough to be broken into implementation tickets. This effort resolves decisions only. The spec, implementation tickets and application code come after this map.

## Notes

- Owner request on 2026-10-15: add a social network, starting with adding Friends, lending cards to Friends, requesting to borrow from Friends and seeing which Friends have the cards you're looking for.
- This effort reverses the "Sharing the Want List, or requesting cards from other collectors" exclusion in the [decklist import map](../../decklist-import/wayfinder/map.md).
- The behaviour settled while charting (friendship, visibility, matching, Loan steps, requests, notifications, unfriending) is recorded in [Decide the social network behaviour](resolutions/decide-social-behaviour.md). New terms are in `CONTEXT.md`: Friend, Friend Request, Handle, Invite Link, Block, Hidden Location, Loan, Borrow Request, Lend Offer, Borrowed Copy, Write-off.
- **Spare Copy** is not yet redefined for lent or reserved copies; [Decide the Loan inventory model](https://github.com/ry-cen/prizecheck/issues/236) owns that.
- Friends never see Location or Deck names. A Handle is not a public profile and never appears on Published Decks.
- The owner delegates technical plumbing (module boundary, data model, API contracts): decide and record it, and grill the owner only on collector-facing effects.
- Use grilling and domain-modeling for decision tickets, prototype for prototype tickets and research for research tickets. Use `CONTEXT.md` vocabulary and record new terms there as they're resolved. Follow AGENTS.md's UI copy rule in prototypes. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: social network`, blocked with GitHub's native dependencies and a "Blocked by" body line. Prototypes, research and resolutions live beside this map. Open tickets: [`feature: social network`](https://github.com/ry-cen/prizecheck/issues?q=label%3A%22feature%3A+social+network%22+is%3Aopen).

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- [Research how copy allocation, Spare Copies and the Want List work today](https://github.com/ry-cen/prizecheck/issues/242): a Holding has exactly one owner and SQL enforces it, nothing is reserved today, and Spare Copies are worked out fresh on every read from five copies of the same rule. Holding rows have no stable identity, locks and revisions are per owner, and there's no row-level security. Collection value isn't computed anywhere. Candidates: lender side L1 to L3, borrower side B1 or B2. [Findings](research/copy-allocation-and-loans.md)

## Not yet specified

- Email (or push) notifications for Loan steps, beyond the in-app inbox.
- Sending one Borrow Request to several Friends at once, split per Friend.
- A quick in-person handover that combines accepting with confirming the handover.
- Whether Friends see each other's Published Decks, or any profile beyond the Handle.

## Out of scope

- Trading and giving cards, including one-sided gifts. A Loan never transfers ownership; that is a separate future feature.
- Following deck builders or any one-way follow.
- Messaging between collectors, activity feeds and groups.
- Reporting and moderation of collectors.
- Finding collectors by email address.
