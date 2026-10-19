# Trading — decision map

**Label:** wayfinder:map

**Status:** charting since 2026-10-17. No tickets opened yet.

## Destination

A handoff-ready spec at `docs/planning/trading/spec.md` for trading cards, built on the Loan steps, and a discovery page in the style of the Pokémon games' GTS: a collector says which cards they want and which they will trade, then finds collectors who match. The spec must settle the domain terms, the ownership transfer, the privacy rules and the stages well enough to be broken into implementation tickets. This effort resolves decisions only. The spec, implementation tickets and application code come after this map.

## Notes

- Owner request on 2026-10-17: a trading feature that builds on Loans, with a discovery page where a collector names the cards they want and a configurable set of cards they will trade (a Location or a list, still to be decided), and can search for collectors near their zip code who would trade.
- This effort reverses the "Trading and giving cards" exclusion in the [social network map](../../social-network/wayfinder/map.md). Stage 2 also reverses the rule that a Handle is not a public profile, and the exclusion of reporting and moderation, as far as open discovery needs them.
- **Stages (owner, 2026-10-17).** Stage 1 is trading between Friends: trade lists, wants, matching among Friends and a Trade that transfers ownership on both sides. Stage 2 opens discovery to collectors who are not Friends, found by distance from a zip code. Stage 2 must bring its own answers on what a non-Friend sees, how two strangers arrange a handover, and the safety pieces (reporting, blocking non-Friends, minors). Stage 1 must not depend on any of them.
- A Loan never transfers ownership. A Trade does: one side's copies leave their Collection and arrive in the other's. That write goes through the existing Move and `holding` writers so Undo and the triggers stay consistent, and two-owner steps lock owners in `user_id` order ([ADR 0014](../../../adr/0014-friend-reads-and-two-owner-loans.md)).
- `CONTEXT.md` lists "Trade" under the Loan entry's _Avoid_. New terms (Trade, and whatever names the trade list and wants) are defined through domain-modeling as they are resolved.
- The owner delegates technical plumbing (module boundary, data model, API contracts): decide and record it, and grill the owner only on collector-facing effects, one question per message.
- Follow AGENTS.md's UI copy rule in prototypes. Consult Laya before delegation. Ask before creating the `feature: trading` label or any GitHub issue. Commit and push only with owner approval; stage explicit paths.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- Stages (owner, 2026-10-17, before tickets): Friends-only trading first, then open zip-based discovery. See Notes.
- What a collector offers (owner, 2026-10-17, before tickets): a Location marked **For trade**. Its Holdings are the collector's trade list, so the list always matches what is in the binder. Others never see the Location's name, only cards and counts. Adding single cards outside a trade binder may come later. The detailed rules are settled below.
- What a collector wants (owner, 2026-10-17, before tickets): the Want List counts automatically, plus a hand-edited list of extra wants (working name Trade Wants) for cards no Deck names. Discovery marks each want as coming from a Deck or from the collector's own list.
- How specific a want is (owner, 2026-10-17, before tickets): a Trade Wants line is always an exact Card Edition. A want from the Want List has a per-line Will accept choice: this exact card (the default), any finish of the same Card Printing, or any card with the same name.
- Answering a proposal (owner, 2026-10-17, before tickets): the other side can Accept, Decline or Counter. Counter closes the proposal and opens a reply prefilled with the same cards, editable on both sides; each round is a new proposal accepted or declined whole, with no partial acceptance. (Cancelling is settled below.)
- Cash to make up the difference (owner, 2026-10-17, before tickets): a proposal may include a cash amount paid by one side. The app only records the agreed amount; it never processes, holds or verifies money, and is not liable for any money exchanged. The Trade screen shows a notice saying so (a legally required notice, so exempt from the UI copy rule). Currency and sales are settled below.
- When copies are held (owner, 2026-10-17, before tickets): sending a proposal, or a Counter, reserves the sender's offered copies; accepting reserves the other side's. A copy is never promised to two proposals or Loans at once, so to offer it elsewhere the collector cancels first. No expiry.
- Calling a Trade off (owner, 2026-10-17, before tickets): the cards change hands in one in-person swap, and each side's Confirm swap moves only their own inventory (their copies out, the other side's in), with no auto-confirm. Either side can cancel until either side confirms, releasing both sides' reserved copies. Unfriending or a Block cancels Trades nobody has confirmed. A Trade one side has confirmed stays open for the other to confirm alone, and never reveals a Block. There is no partial swap.
- Discovery layout (owner, 2026-10-17, before tickets): one row per collector, two-way matches first, then has-what-you-want, then wants-what-you-have. A row opens both sides, and Propose trade opens a draft prefilled with the matched cards. The card popup gains Ask to trade. Stage 2 reuses the same rows for non-Friends, adding a distance band and sorting by match then distance, and adds a card search ("who near me has this card") because a long list of strangers can't be scanned by person alone. A non-Friend row shows only the trade binder's cards and wants, never the rest of the Collection.
- Value cues (owner, 2026-10-17, before tickets): while building or reviewing a proposal, each side shows its estimated total. There is no suggested cash amount; collectors type any cash themselves. Discovery rows show no values, and no price source is ever named.
- Cards for cash (owner, 2026-10-17, before tickets): a Trade may have cards on one side and only cash on the other, so it can be a sale. Amounts are US dollars only. A one-way match on the discovery page is therefore a possible sale or purchase. Stage 2's safety decision must cover sales between strangers and to minors.
- Cash-only offers (owner, 2026-10-17, before tickets): a collector opts in with one Open to cash offers setting. Off, nobody can send them a proposal with only cash on one side (cash alongside cards is still allowed). On, their discovery row says so.
- For trade Location rules (owner, 2026-10-17, before tickets): the mark covers every child Location, including ones added later. A Deck cannot be marked. For trade and hidden are separate: a hidden For trade Location is still on the trade list, and its screen says so. Listing reserves nothing; a copy is reserved only when a proposal or Loan promises it, and promised copies leave the trade list until released. Borrowed Copies in a For trade Location never appear on the trade list.
- Plumbing (delegated, 2026-10-17): [decide-trading-plumbing](resolutions/decide-trading-plumbing.md) — Trades live in the social area, share the Loan promise invariant, and move ownership by each side's Confirm swap.
- Gifts (owner, 2026-10-19): a proposal may have cards on one side and nothing on the other, in either direction. A proposal with no cards at all is refused.
- Nine plumbing follow-ups (owner, 2026-10-19): the other eight defaults in the [plumbing resolution](resolutions/decide-trading-plumbing.md) are approved as written, except that question 4 (Trade Wants quantity) was refined by the owner.
- Trade Wants add to the Deck need (owner, 2026-10-19): a Trade Wants line adds to the Want List's need for the same Card Edition, and received copies fill the Deck needs first, so the line falls only by the copies left over.
- Gifts and cash (orchestrator, delegated plumbing, 2026-10-19): a gift plus cash is allowed, and one Edition on both sides of a proposal is refused.
- Hidden Decks' wants (orchestrator, 2026-10-19): a Friend's hidden Decks are allocated with every Deck and then dropped, so a visible Deck's need equals what the Friend sees on their own Want List.
- Deck-line switch (owner, 2026-10-19): when a received card arrived only through a widened Will accept rule for a Deck's want, Confirm swap offers (ticked, untickable) to switch the Deck's line to it; the Swap hint also suggests owned cards Will accept takes; until a switch is made, a collector's own spares of accepted cards reduce no need in discovery. Details in the [plumbing resolution](resolutions/decide-trading-plumbing.md).
- Independent review (2026-10-19): the independent review approved the design after revision.

## Candidate tickets

Stage 1:

- Decide the liability notice's wording (check with someone qualified before launch).
- Prototype the trade list, the discovery page and the Trade screen.

Stage 2:

- Research free US zip-code centroid data (US only, matching the US-dollar cash rule).
- Decide what location data is stored and what others see (a distance band, never the zip).
- Decide what a non-Friend sees and how a collector opts in to open discovery.
- Decide how strangers arrange a handover (messaging, a meetup step, or neither).
- Decide safety: reporting, blocking non-Friends, minors.

## Not yet specified

## Out of scope

- Processing, holding or verifying any payment. Cash in a Trade is a recorded agreement only.
- Shipping and mail trades.
