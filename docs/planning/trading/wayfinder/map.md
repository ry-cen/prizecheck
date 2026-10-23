# Trading — decision map

**Label:** wayfinder:map

**Status:** charting since 2026-10-17. No tickets opened yet.

## Destination

A handoff-ready spec at `docs/planning/trading/spec.md` for trading cards, built on the Loan steps, and a discovery page in the style of the Pokémon games' GTS: a collector says which cards they want and which they will trade, then finds collectors who match. The spec must settle the domain terms, the ownership transfer, the privacy rules and the stages well enough to be broken into implementation tickets. This effort resolves decisions only. The spec, implementation tickets and application code come after this map.

## Notes

- Owner request on 2026-10-17: a trading feature that builds on Loans, with a discovery page where a collector names the cards they want and a configurable set of cards they will trade (a Location or a list, still to be decided), and can search for collectors near their zip code who would trade.
- This effort reverses the "Trading and giving cards" exclusion in the [social network map](../../social-network/wayfinder/map.md). Stage 2 opens Trade Lists to opted-in strangers and introduces reporting and moderation. Handles stay private; discovery does not make a Handle a public profile.
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
- Discovery layout (owner, 2026-10-17, before tickets): one row per collector, two-way matches first, then has-what-you-want, then wants-what-you-have. A row opens both sides, showing only the matched cards: what the Friend has that the viewer wants, and what the Friend wants that the viewer has. Propose trade opens an empty draft with those matched cards listed as suggestions at the top, each added with one tap, so a proposal never starts as every matched card for every matched card (owner, 2026-10-19, from the prototype; the draft and its suggestions are superseded 2026-10-20, see Trade screen: the screen opens empty and the matches lead the card library instead). The card popup gains Ask to trade. Stage 2 reuses the same rows for non-Friends, adding a distance band and sorting by match then distance, and adds a card search ("who near me has this card") because a long list of strangers can't be scanned by person alone. A non-Friend row shows only the trade binder's cards and wants, never the rest of the Collection.
- Value cues (owner, 2026-10-17, before tickets): while building or reviewing a proposal, each side shows its estimated total. There is no suggested cash amount; collectors type any cash themselves. Discovery rows show no values, and no price source is ever named.
- Cards for cash (owner, 2026-10-17, before tickets): a Trade may have cards on one side and only cash on the other, so it can be a sale. Amounts are US dollars only. A one-way match on the discovery page is therefore a possible sale or purchase. Stage 2's safety decision must cover sales between strangers and to minors.
- Cash-only offers (owner, 2026-10-17, before tickets): a collector opts in with one Open to cash offers setting. Off, nobody can send them a proposal with only cash on one side (cash alongside cards is still allowed). On, their discovery row says so.
- For trade Location rules (owner, 2026-10-17, before tickets): the mark covers every child Location, including ones added later. A Deck cannot be marked. For trade and hidden are separate: a hidden For trade Location is still on the trade list, and its screen says so. Listing reserves nothing; a copy is reserved only when a proposal or Loan promises it, and promised copies leave the trade list until released. Borrowed Copies in a For trade Location never appear on the trade list.
- Plumbing (delegated, 2026-10-17): [decide-trading-plumbing](resolutions/decide-trading-plumbing.md) — Trades live in the social area, share the Loan promise invariant, and move ownership by each side's Confirm swap.
- Gifts (owner, 2026-10-19): a proposal may have cards on one side and nothing on the other, in either direction. A proposal with no cards at all is refused.
- Nine plumbing follow-ups (owner, 2026-10-19): the other eight defaults in the [plumbing resolution](resolutions/decide-trading-plumbing.md) are approved as written, except that question 4 (Trade Wants quantity) was refined by the owner.
- Trade Wants add to the Deck need (owner, 2026-10-19): in trading, a Trade Wants line adds to the Want List's need for the same Card Edition, and received copies fill the Deck needs first, so the line falls only by the copies left over. The Want List page's own counts, totals, cost and exports leave Trade Wants out and stay about what the Decks are missing (owner, 2026-10-20).
- Gifts and cash (orchestrator, delegated plumbing, 2026-10-19): a gift plus cash is allowed, and one Edition on both sides of a proposal is refused.
- Hidden Decks' wants (orchestrator, 2026-10-19): a Friend's hidden Decks are allocated with every Deck and then dropped, so a visible Deck's need equals what the Friend sees on their own Want List.
- Deck-line switch (owner, 2026-10-19): when a received card arrived only through a widened Will accept rule for a Deck's want, Confirm swap offers (ticked, untickable) to switch the Deck's line to it; the Swap hint also suggests owned cards Will accept takes; until a switch is made, a collector's own spares of accepted cards reduce no need in discovery. Details in the [plumbing resolution](resolutions/decide-trading-plumbing.md).
- Independent review (2026-10-19): the independent review approved the design after revision.
- Screens (owner, 2026-10-19, [prototype verdict](resolutions/prototype-trade-screens.md)): layout A, a Trades tab of its own. Propose trade from discovery starts empty with the matched cards as suggestions (see Discovery layout; the suggestions are superseded 2026-10-20, see Proposal builder). Received cards go to Unsorted by default, changeable on the confirm screen. A Deck switch made at Confirm swap is undone from the toast, like other Deck List changes. One draft at a time: it survives browsing, and starting a draft for someone else asks to discard it first; this scales to Stage 2, where a collector may ask several strangers about one card (superseded 2026-10-20: drafts are gone, see Proposal builder). A one-way discovery row says "You could sell" or "You could buy" only when that Friend is Open to cash offers; otherwise it says "<name> wants N of your cards" or "<name> has N cards you want". The liability notice shows only when a proposal (a draft, before 2026-10-20) or Trade includes cash (whoever checks its wording also confirms this placement is enough). A Counter answering a proposal that already had a cash-only side may itself have a cash-only side, whatever its recipient's setting: the collector who put cash on the table can be countered with cash (owner, 2026-10-19, reversing the earlier default).
- Reaching a Friend's Trade List (owner, 2026-10-20): from the link on that Friend's Collection page, and from Find trades once it exists. The Friends drawer gets no Trade List link; it stays about managing Friends, and the link can be added later if collectors look for it there. The Open to cash offers switch ships with the cash ticket ([#277](https://github.com/ry-cen/prizecheck/issues/277)), since its setting arrives with proposals ([#270](https://github.com/ry-cen/prizecheck/issues/270)).
- Confirmations (owner, 2026-10-20): withdrawing, declining and cancelling a Trade each ask first, as Loans do; accepting does not.
- Draft bar (owner, 2026-10-20; superseded the same day, see Proposal builder): the open draft shows as a bar fixed to the bottom of the screen with Review, like the Borrow tray, hidden while the draft is empty; the header has no room for the prototype's pill.
- Proposal builder (owner, 2026-10-20, [#284](https://github.com/ry-cen/prizecheck/issues/284), reversing the 2026-10-19 "One draft at a time" and matched-card suggestions in Screens and Discovery layout, and the 2026-10-20 Draft bar): drafts are gone. Trade requests aren't worked on slowly and usually hold only a few cards, so each proposal has one **proposal builder**, laid out like the Deck builder: the proposal (You get and You give with steppers, value totals, cash once [#277](https://github.com/ry-cen/prizecheck/issues/277) lands, Send) in the wide left column and a card library in the narrow right column. On phones a "Proposal / Cards" switch shows one pane at a time, as the Deck builder's "Deck / Library" switch does. Removed: the draft bar, keeping a proposal while browsing, the switch-Friend discard question, building one proposal from several popups, and the draft page's Suggested list. The library switches between **Their Trade List** (cards you can ask for) and **My Trade List** (cards you can give), each with search; tiles show copies available and a wanted mark when the card matches a want. Your side may hold only your own Trade List and their side only theirs, as before. The library lists the Find trades matches with that Friend first, then the rest of the list; matches are not added, and the proposal starts empty. One tap on a tile adds one copy straight away (unlike the Deck builder, whose tap opens a card popup), a small details button on each tile opens the card without adding it, and the proposal's stepper raises it. The value totals arrive with #277. Ask to trade in the card popup opens the proposal builder for that Friend with that card already in You get (one copy) and the library on Their Trade List; a Friend's Trade List page and Propose trade on Find trades open it empty. Leaving with cards added but not sent asks "Discard this proposal to <name>?" with Discard and Keep editing; it asks only when something was added, and discarded means gone. Server rules are unchanged. Reloading or closing the tab with cards added and not sent shows the browser's leave warning.
- #276 wording (owner, 2026-10-20, [#276](https://github.com/ry-cen/prizecheck/issues/276)): the owner's open questions are all kept as built. The no-Friends heading stays "Matching needs Friends". Ask to trade stays hidden in the popup when no Friend lists the card. The want wording stays "N wanted (M for Decks)" with the pills "For Decks", "For Trade Wants" and "For Decks and Trade Wants". Find trades shows no empty-Trade-List banner.
- Proposal builder details (owner, 2026-10-20, [#284](https://github.com/ry-cen/prizecheck/issues/284)): the card Ask to trade puts in does not count as a change, so leaving a builder nobody has touched asks nothing; the question and the browser's leave warning start once the collector adds, removes or changes a card. The back link returns to where the collector came from, "<name>'s Trade List" from a Friend's Trade List page and "Find trades" otherwise (and after a reload). Matched cards in the library say who wants them: "You want" on the Friend's list and "<name> wants" on the collector's own.
- Unchanged Counter (owner, 2026-10-20, [#278](https://github.com/ry-cen/prizecheck/issues/278)): Send Counter stays unavailable until the Counter's cards, quantities or cash differ from the proposal it answers, so nobody bounces the same terms back by mistake.
- Will accept wording (owner, 2026-10-20, #275): the three choices read "This exact card", "Any finish" and "Any card with the same name"; the card's name is already on the line, so the label stays the same length everywhere.
- Header at 761 px (owner, 2026-10-20, #273): the tabs use tighter padding at that width so both badges show full counts, rather than capping them at "9+".
- Ending a friendship with a confirmed Trade (owner, 2026-10-20, #274): the Remove Friend and Block questions keep the sentence that names Trades one side has confirmed, which stay open so they can finish.
- Inbox order (plumbing, 2026-10-20, #273): the drawer shows Trade lines before Loan lines, as in the prototype, rather than merging the two by time as the [plumbing resolution](resolutions/decide-trading-plumbing.md) first said: Loan lines are ordered by when they were made, not by when they started waiting, so a merge by time is not well defined. Earlier updates still merge by time.

### Stage 2 owner decisions — 2026-10-22

These record the owner's answers from the Stage 2 discussion, including approval of all seven defaults. They are turned into the [Stage 2 spec](../stage-2-spec.md).

- **Open discovery:** one collector-wide switch, off by default, requiring a zip code. Turning it off removes the collector from discovery immediately. Browsing and starting contact with strangers require the viewer's own switch to be on too.
- **Age:** no age rule or age confirmation. Sales between strangers and to minors are not restricted by an age rule. Record this choice for the existing liability-notice review before launch.
- **Identity:** strangers see Display Name, distance band, matched cards and wants, never the Handle. **Add as Friend** is offered on a Trade only after both sides confirm it; discovery itself offers no Friend Request button.
- **Find trades:** Friends first, then **Near you**, with a Friend appearing only under Friends. Near you sorts by match (two-way, has-what-you-want, wants-what-you-have), then distance. While open discovery is off, a prompt to turn it on replaces Near you.
- **Distance:** zip-centroid distances shown only as bands: Under 5 mi, 5–10 mi, 10–25 mi, 25–50 mi. Radius choices are 5, 10, 25 or 50 mi, defaulting to 25; nobody beyond 50 mi appears. Never show the zip itself.
- **Card search:** search by card name across Printings, optionally narrow by set or Printing. Show one row per holder, with Printings and available counts, Friends first and then Near you sorted by distance band (owner, 2026-10-23, mirroring Find trades), leading to Message or Propose trade. Reverse search for who wants a card is deferred.
- **Trade List access:** a stranger's full Trade List and the wants that match the viewer's Trade List (owner, 2026-10-23: "wants" means these matching wants, not their whole Want List) are reachable from their discovery row, search result or conversation, with a distance band. The rest of the Collection, Location names, promised copies and Borrowed Copies stay private or excluded under the existing Trade List rules.
- **Conversations:** one per pair of collectors, including Friends, with messaging available before any proposal from a discovery row or a card on the Trade List. Proposals, Counters and Trades appear inside that conversation. Discord is not required.
- **Messages:** plain text only, up to 1,000 characters; links remain plain text and are not clickable. No photos, read receipts or typing indicators.
- **Trades tab:** becomes the conversation list, showing the other collector, last message and open proposals or Trades. Its badge counts unread conversations as well as proposals waiting on the collector. Opening a conversation shows messages and proposal/Trade cards inline.
- **Meetups:** arranged in chat, with no separate structured meetup step. An accepted stranger Trade shows a short tip to meet in public, such as a local game store, and check the cards before swapping.
- **Notifications:** in-app only for now. An email nudge is a later option, not part of the approved current scope.
- **Cash:** the existing Open to cash offers switch covers Friends and strangers alike; no separate stranger setting.
- **Turning discovery off:** existing conversations, proposals and Trades continue normally, including messages and proposals within those conversations. It stops discovery and starting new stranger conversations, rather than ending existing relationships.
- **Block:** extend the existing Block to strangers, available from a conversation or discovery row. Neither collector sees the other in discovery; the conversation is read-only for both; no new messages or proposals; open proposals close. Apply the existing Trade rule: cancel unconfirmed Trades, but keep Trades either side has confirmed open so the other side can finish. Do not notify the blocked collector or reveal the Block.
- **Report:** available from a conversation, discovery row or Trade, with reasons scam or no-show, harassment, inappropriate content, or other, and an optional note. Reporting also Blocks. An owner review queue retains a snapshot of the full conversation and related Trades, even after account deletion. Owner actions are dismiss, remove from open discovery, or suspend the account; reports cause no automatic account penalty beyond the reporter's Block.
- **Track record:** rows, Trade Lists and conversations show a completed-trade count, counting each Trade both sides confirmed, including Friend Trades. Zero reads **New to trading**. No ratings, stars or reviews.

The seven defaults approved together:

1. **Zip changes:** enter a zip when enabling discovery and change it in Settings, at most three times a day. Refuse a fourth change with “You've changed your zip code 3 times in the last 24 hours. Try again in N hours.” (or “Try again later.”). The owner approved this rolling-window copy on 2026-10-23, replacing the original “You can change your zip code again tomorrow.”
2. **Hidden For trade Locations:** remain on the Trade List for strangers too. While discovery is on, the Location screen says it is visible to Friends and collectors near you.
3. **Message presence:** no read receipts or typing indicators.
4. **Archive:** a collector can archive a conversation, hiding it until a new message arrives. Neither participant can delete a conversation.
5. **Spam limit:** at most ten new stranger conversations per day. A conversation with someone the collector has traded with before does not count.
6. **Suspended or deleted collectors:** leave discovery immediately. Their conversations become read-only for the other side and show “This collector is no longer available”. Trades either side has confirmed stay open, following the Block rule.
7. **Completed-trade count:** includes Friend Trades, as above.

#### Owner answers to the plumbing questions — 2026-10-23

The seven questions in the [plumbing resolution](resolutions/decide-stage-2-plumbing.md) were answered on 2026-10-23:

1. **Suspension:** sign-in, own Collection, Decks, Want List and existing Loans continue; discovery, messages, Trade Proposals, Counters, accepts, Friend Requests, Borrow Requests and Lend Offers stop (differs from the recommendation, which allowed Lend Offers).
2. **Remove Friend:** the conversation stays open; only Block stops contact.
3. **Unrecognised zip:** refused, with “We couldn't find that zip code. Try the zip code where you'd meet.”
4. **A stranger's wants:** only the wants that match the viewer's Trade List.
5. **In-band order:** by Display Name, not exact distance.
6. **Band on a stranger's Trade List:** only while both collectors have discovery on.
7. **Card search:** Friends first, then Near you.

The copy table in the resolution (“Approved copy”) was approved on the same day.

## Candidate tickets

Stage 1:

- [#284](https://github.com/ry-cen/prizecheck/issues/284) Proposal builder (replaces drafts): blocked by #276 (done), blocks [#277](https://github.com/ry-cen/prizecheck/issues/277) and [#278](https://github.com/ry-cen/prizecheck/issues/278), since cash and Counters go on this screen.
- Decide the liability notice's wording (check with someone qualified before launch).
- Prototype the trade list, the discovery page and the Trade screen.

Stage 2:

- Research free US zip-code centroid data: done 2026-10-22, see [research](research/zip-centroid-data.md).
- Decide location storage and other technical plumbing: done 2026-10-22, see the [Stage 2 plumbing resolution](resolutions/decide-stage-2-plumbing.md).
- Owner questions and copy approved 2026-10-23. The [Stage 2 spec](../stage-2-spec.md) is [#296](https://github.com/ry-cen/prizecheck/issues/296); its tickets are [#297](https://github.com/ry-cen/prizecheck/issues/297)–[#305](https://github.com/ry-cen/prizecheck/issues/305), and the liability-notice and privacy review is [#306](https://github.com/ry-cen/prizecheck/issues/306), all filed 2026-10-23 with their dependencies linked.

## Not yet specified

## Out of scope

- Processing, holding or verifying any payment. Cash in a Trade is a recorded agreement only.
- Shipping and mail trades.
