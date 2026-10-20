# Trading for PrizeCheck: Stage 1, trading between Friends

**Status:** drafted 2026-10-17, not yet implemented. Collector-facing details approved by the owner on 2026-10-19.

This spec turns the [Trading decision map](wayfinder/map.md) and the [plumbing resolution](wayfinder/resolutions/decide-trading-plumbing.md) into one implementation handoff for Stage 1: trade lists, wants, matching among Friends, and a Trade that transfers ownership on both sides. Stage 2 (open discovery for collectors who are not Friends) is a separate, later spec. Terms follow [`CONTEXT.md`](../../../CONTEXT.md). The cross-owner pattern is recorded in [ADR 0015](../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md), and the migration numbers are in the [Trading migrations note](migrations.md). The map is the authority on what collectors see; the resolution is the authority on plumbing. Nine collector-facing details were proposed as defaults; on 2026-10-19 the owner allowed gifts and approved the other eight. They are listed in Further Notes.

## Problem Statement

A collector who has spare cards and a collector who needs those cards have no way to find each other in PrizeCheck. The Want List says exactly which Card Editions a collector is missing, and the Collection says which copies they could part with, but nothing connects the two across collectors. Friends can already lend each other cards, and a Loan never changes who owns a copy. Real collectors also swap cards, sometimes with a little cash to even things out, and today they do it from memory and chat messages. That goes wrong in familiar ways:

- A collector promises the same copy to two people, or to a trade and a Loan, and finds out at the table.
- Neither side has a shared record of what was agreed, so the cards, the cash and what was already handed over are argued from memory.
- After a swap, each collector has to correct their own Collection by hand, and a card that arrived for a Deck does not raise the Deck's list.
- A collector cannot tell which of their Friends hold the cards they need and want the cards they have, short of asking each one.
- Moving a card for a trade out of a binder, or taking it out of the Collection, silently breaks what the other person was promised.

The product also has no concept of a card offered for trade, and no way to say which cards a collector wants beyond what their Decks name. A Loan is the wrong tool for any of this: a Loan returns, and a Trade does not.

## Solution

Add Trades to the `social` area of the API and the web app, on top of Friends, Loans, the Collection, Decks, the Want List and Undo. A Trade is an agreement between two Friends to swap copies in person, with an optional cash amount paid by one side. Each side then confirms the swap for their own inventory.

**What a collector offers.** A collector marks a Location **For trade**. Its Holdings, and those of every Location inside it, are their **Trade List**, so the list always matches what is in the binder. A Deck cannot be marked. For trade is separate from hidden, so a hidden For trade Location is still on the Trade List, and no one else ever sees the Location's name. Listing reserves nothing: a copy is promised only when a Trade Proposal or Loan promises it, and promised copies leave the Trade List until released. Borrowed Copies never appear on it.

**What a collector wants.** The Want List counts automatically. Beside it, **Trade Wants** is a short hand-edited list of exact Card Editions for cards no Deck names. Each Want List card also has a **Will accept** choice for trades: this exact card (the default), any finish of the same Card Printing, or any card with the same name. Discovery marks each want as coming from a Deck or from the collector's own list, and never names a Deck. A collector's own spare copies of a card their Will accept choice takes do not reduce the need shown in discovery until the Deck line is switched to that card, which the Want List's Swap hint offers for copies already owned and Confirm swap offers for copies just received.

**Finding matches.** A discovery page shows one row per Friend: two-way matches first, then Friends who have what the viewer wants, then Friends who want what the viewer has. A row shows only the matched cards on each side and a badge when the Friend is **Open to cash offers**, and shows no values. **Propose trade** opens the proposal builder for that Friend with an empty proposal, so a proposal never starts as every matched card for every matched card. The catalog card popup gains **Ask to trade**, which opens that screen for a Friend who lists the card with one copy of it already on the get side.

**Trade Proposals.** A proposal lists the cards each side gives and an optional US-dollar amount paid by one side. The sender's copies are promised the moment it is sent. The other side can Accept, Decline or Counter, always as a whole. Counter closes the proposal and opens a reply prefilled with the same cards, which either side can edit. Accepting promises the recipient's copies and makes it a Trade. While building or reviewing a proposal, each side shows its estimated total, and there is no suggested cash amount.

**Building a proposal.** Each proposal is built in its own proposal builder for one Friend (not the Trade screen, which shows a proposal already sent or a Trade), with no draft kept while the collector browses. Proposals are quick and usually hold a few cards. Beside the proposal is a card library with a switch between that Friend's Trade List (cards to ask for) and the collector's own Trade List (cards to give); the get side may hold only the Friend's Trade List and the give side only the collector's own. Both lists have search, and each card shows the copies available and a mark when it matches a want. The library lists the cards that match that Friend first, then the rest of the list. Matches are never added by themselves. One tap on a card adds one copy straight away, a details control on each card opens it without adding, and the proposal's quantity control raises it. Leaving the screen after adding cards without sending asks whether to discard the proposal; discarding removes it for good, and nothing is asked when no card was added.

**Cash.** A proposal may carry cash from either side, and a Trade may have cards on one side and only cash on the other, so it can be a sale. A side may also give nothing at all, so a proposal can be a gift; only a proposal with no cards on either side is refused. The app records the agreed amount but never processes, holds or verifies money, and the Trade screen shows a notice saying so. A collector who has not turned on Open to cash offers cannot be sent a proposal in which one side gives only cash.

**Swapping.** The cards change hands in one in-person swap. Each side presses **Confirm swap** for their own inventory: their copies leave their Collection and the other side's arrive as new Holdings, in a Location they choose. When a received card arrived only through a widened Will accept choice for a want that came from a Deck's list, Confirm swap offers, ticked by default, to switch that Deck's line to the received card. There is no auto-confirm, no take-back and no partial swap. Either side can cancel until either side has confirmed.

**Where it lives.** The Trade screens and discovery page are prototyped by the prototype ticket on the map. This spec fixes behaviour and contracts, not layout.

The design rests on a few rules, recorded in [ADR 0015](../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md):

- **One promise invariant.** Loans and Trades share the one definition of "reserved", so a copy can never be promised twice, in any combination.
- **Trades live in the `social` area and follow the Loan split.** Shared facts and steps that change no inventory are served under `/api/social`; steps that read or write one collector's own inventory are served under `/api/trades`.
- **One choke point for Friend reads.** All cross-collector reads of Trade Lists and wants stay in the `friend_copies` module and return only Edition-level facts.
- **A fixed lock order.** Owners in ascending `user_id`, then `loan` rows, then `trade` rows.
- **Ownership changes one side at a time.** Each Confirm swap runs under the confirmer's own lock and changes only their own inventory.
- **Privacy that cannot be probed.** Non-Friends see nothing, no Location or Deck name ever reaches a Friend, and the inbox never reveals an unfriend or a Block.

## User Stories

### For trade Locations and the Trade List

1. As a collector, I want to mark a Location as For trade, so that the cards in it become the cards I offer to trade.
2. As a collector, I want the mark to cover every Location inside the marked one, including ones I add later, so that I do not have to re-mark a binder when I add a page to it.
3. As a collector, I want my Trade List to always match what is physically in my For trade Locations, so that I never have to maintain a second list.
4. As a collector, I want to be unable to mark a Deck as For trade, so that a built Deck is never offered by accident.
5. As a collector, I want a Deck inside a For trade Location to stay off my Trade List, so that marking a box does not offer the Decks stored in it.
6. As a collector, I want to be told plainly that a Deck cannot be marked For trade, so that I understand why the mark was refused.
7. As a collector, I want to be unable to un-mark a Location that sits inside a marked one, and to be told which marked Location covers it, so that I know where to change it.
8. As a collector, I want For trade and hidden to be separate settings, so that I can keep a Location off my Friends' view of my Collection and still offer its cards.
9. As a collector, I want my screen to say so when a hidden Location is also For trade, so that I know its cards are still offered.
10. As a collector, I want Friends never to see the name of a For trade Location, so that how I organise my cards stays private.
11. As a collector, I want marking a Location For trade to reserve nothing, so that listing a card never stops me using it.
12. As a collector, I want a copy that a Trade Proposal or Loan promises to leave my Trade List straight away, so that nobody can ask for a copy I have already promised.
13. As a collector, I want a promised copy to come back onto my Trade List when the proposal is declined, withdrawn, countered or cancelled, so that releasing it needs no extra step.
14. As a collector, I want a copy that has left in a confirmed swap to disappear from my Trade List, so that the list stays true after the swap.
15. As a collector, I want Borrowed Copies in a For trade Location never to appear on my Trade List, so that I cannot offer cards I do not own.
16. As a collector, I want copies I have lent out, which sit in no Location, not to count on my Trade List, so that I do not offer cards that are out of my hands.
17. As a collector, I want to see my own Trade List with the Location each card sits in, so that I know where to find a card when a Trade is agreed.
18. As a collector, I want marking and un-marking a Location For trade to change my Location, not my inventory history, so that it never looks like a change to my Collection.
19. As a collector, I want a Move of a card between Locations to take effect on my Trade List immediately, so that moving a card into a binder offers it and moving it out withdraws it.
20. As a collector, I want deleting a Deck or converting a leaf to carry my Trade picks with it, so that a Trade I have agreed does not lose track of where its cards are.
21. As a Friend, I want to see which cards a Friend offers to trade and how many copies, so that I can decide whether to propose.
22. As a Friend, I want to see only counts and cards on a Friend's Trade List, never a Location or Deck name, so that nothing about their organisation leaks.

### Trade Wants and Will accept

23. As a collector, I want the Want List to count automatically as my wants for trading, so that I do not enter anything twice.
24. As a collector, I want to add a hand-edited line to my Trade Wants for a card no Deck names, so that I can ask for cards outside my Decks.
25. As a collector, I want each Trade Wants line to be one exact Card Edition with a quantity, so that I get the finish and printing I mean.
26. As a collector, I want to set a Trade Wants quantity to zero to remove the line, so that taking it off is one step.
27. As a collector, I want to be limited to 500 Trade Wants lines, so that the list stays usable.
28. As a collector, I want a Trade Wants line to go down at a confirmed swap only by the copies my Decks did not need, and to disappear at zero, so that the list does not keep asking for cards I already got and my Decks are filled first.
29. As a collector, I want to choose, for each Want List card, whether trades should match this exact card, any finish of the same Card Printing, or any card with the same name, so that I can accept a cheaper finish without changing my Deck.
30. As a collector, I want the default for every Want List card to be this exact card, so that nothing is widened without my choice.
31. As a collector, I want one Will accept choice per card, applying wherever that card appears on my Want List, so that I do not set it again for each Deck.
32. As a collector, I want my Will accept choice to be remembered if the card leaves my Want List and returns, so that I do not lose it.
33. As a collector, I want Will accept to change only trade matching, the Swap hint's suggestions and the switch offered at Confirm swap, and never my Want List's own counts, totals, exports or pinned figures, so that nothing else moves.
34. As a collector, I want "any card with the same name" to follow the catalog's Card Identity, including Printings the catalog links to the same identity in other languages, so that the name rule means what the catalog means.
35. As a collector, I want Trade Wants lines to always match the exact Edition, with no Will accept choice, so that a hand-entered want is never silently widened.
36. As a collector, I want to see the Will accept choice on my Want List page beside each card, so that I can set it where I see the need.
37. As a collector, I want my Trade Wants and Will accept choices to be deleted with my account, so that nothing of mine outlives it.

### Discovery among Friends

38. As a collector, I want a discovery page with one row per Friend who matches, so that I can scan by person.
39. As a collector, I want two-way matches first, then Friends who have what I want, then Friends who want what I have, so that the best trades are on top.
40. As a collector, I want ties in the order to break by Display Name and then Handle, so that the list is stable.
41. As a collector, I want each row to open both sides, the cards I would get and the cards I would give, so that I can see the whole trade before proposing.
42. As a collector, I want each card on a row to show how many copies are offered and how many are wanted in total, with the part Decks need shown beside it (for example "6 wanted (2 for Decks)"), so that I can judge the match.
43. As a collector, I want each card I would get to say whether it matches my want exactly, in any finish or by name, so that I know what I am accepting.
44. As a collector, I want each want to be marked as coming from a Deck, from my own list or from both, without the Deck being named, so that I know why a card is wanted and nothing private leaks.
45. As a collector, I want a Friend's row to show a badge when they are Open to cash offers, so that I know they can be sent a cash-only proposal.
46. As a collector, I want discovery rows to show no prices or values, so that matching stays about cards.
47. As a collector, I want a row to show at most 20 cards per side with a count of the rest, and to open a Friend's full lists on request, so that a large match stays readable.
48. As a collector, I want to browse a Friend's whole Trade List, so that I can add cards beyond the matches to a proposal.
49. As a collector, I want browsing a Friend's Trade List to be by Card Identity with a search box, so that I can find one card in a long list.
50. As a collector, I want a Handle that is not a Friend to answer exactly as an unknown Handle does when I ask for a Trade List, so that nobody can probe who exists.
51. As a collector with no Friends, I want the discovery page to say that matching needs Friends, so that I know what to do next.
52. As a collector, I want a Friend's need to follow their own counting setting, so that their Want List shows what they would truly need.
53. As a collector, I want a Friend's need to account for the copies they have already promised, borrowed or lent, so that I am not shown wants they have covered.
54. As a collector, I want a card to appear in "has what you want" only while my Friend's copy is not promised, so that I am not shown a copy they cannot give.
55. As a collector, I want the discovery page to load quickly even with hundreds of Friends and thousands of listable cards, so that I can use it daily.
56. As a collector, I want discovery to use my current Trade List and wants every time I open it, so that nothing is stale.
57. As a collector, I want Friends who do not match to be left out of the list, so that every row is worth opening.

### Card popup: Ask to trade

58. As a collector, I want an Ask to trade action in the catalog card popup, so that I can start a trade from any card I am looking at.
59. As a collector, I want the popup to list the Friends who have a copy on their Trade List, so that I know whom to ask.
60. As a collector, I want Ask to trade to open the proposal builder for that Friend with the card already on the get side, so that I can ask for it at once and add anything else before sending.
61. As a collector, I want Ask to trade to appear only for Friends with a listable copy, so that I never ask for a card that is not offered.
62. As a collector, I want the popup to show no Location or Deck name for the Friend's copy, so that nothing about their organisation leaks.

### Proposing a trade

63. As a proposer, I want Propose trade from a discovery row to open the proposal builder with an empty proposal and the matched cards listed first in the card library, so that I choose which cards to trade instead of starting with every match on both sides.
64. As a proposer, I want to edit the proposal before sending, adding a card with one tap, removing cards and changing quantities, so that the proposal says what I mean.
65. As a proposer, I want each proposal builder to cover one Friend, and to be asked before leaving it with cards added but not sent, so that a proposal is always between two collectors and I never lose cards by accident.
66. As a proposer, I want to be unable to propose a trade with myself, so that a proposal always has two sides.
67. As a proposer, I want to be unable to send a proposal to someone who is not my Friend, so that trading stays among Friends in Stage 1.
68. As a proposer, I want each side to have at most 50 lines, so that a proposal stays readable.
69. As a proposer, I want to be unable to offer more copies of a card than I can list, so that I cannot promise what I do not have.
70. As a proposer, I want to be unable to ask for more copies than my Friend lists, so that I do not ask for cards they are not offering.
71. As a proposer, I want to be told which card and how many copies are available when a line is too high, so that I can correct it.
72. As a proposer, I want to send a gift, with cards on my side and nothing on the other, so that I can give a Friend cards through the same steps as a trade.
73. As a proposer, I want a proposal with no cards on either side to be refused, so that a Trade is always about cards and never only money.
74. As a proposer, I want sending a Trade Proposal to promise the copies I give immediately, so that I cannot promise them again elsewhere while I wait.
75. As a proposer, I want my promised copies to stay promised with no expiry until the proposal is answered or I withdraw it, so that I know where my cards stand.
76. As a proposer, I want to withdraw a proposal before it is answered, so that I can take it back and free my copies.
77. As a proposer, I want sending to be safe to repeat, so that a double tap or a retry never creates two proposals.
78. As a proposer, I want to be limited to 120 trade commands per hour, with a message saying how long to wait, so that nobody can flood a Friend.
79. As a proposer, I want to be told when a proposal changed since I opened it, so that I never act on stale information.

### Value totals

80. As a collector building or reviewing a proposal, I want each side to show its estimated total, so that I can judge whether the trade is fair.
81. As a collector, I want the totals to say when they cover only some of the copies, so that I do not read a partial total as complete.
82. As a collector, I want the totals to work on an unsent proposal and on a Counter, so that I see them before I commit.
83. As a collector, I want no suggested cash amount, so that I type any amount I like.
84. As a collector, I want the totals never to name a price source or show when a price was fetched or refreshed, so that I see only what helps me decide.
85. As a collector, I want the totals to use the same estimate as my Deck costs, so that figures agree across the app.
86. As a collector, I want to be unable to put the same Edition twice on one side of a value request, so that a total is never double counted.
87. As a collector, I want a value request to be limited to 100 lines, so that one request stays bounded.
88. As a developer, I want the value route to be budgeted at the gateway like the other price routes, so that it cannot be used to run up price lookups.

### Cash

89. As a proposer, I want to add a cash amount in US dollars paid by either side, so that I can make up a difference in a trade.
90. As a proposer, I want to choose whether I pay or my Friend pays, so that the direction is explicit.
91. As a proposer, I want a cash amount to carry a payer and a payer to carry an amount, so that a proposal never has one without the other.
92. As a proposer, I want an out-of-range amount refused with a clear message, so that a typo cannot become a trade.
93. As a proposer, I want to send cash alongside cards to any Friend, whether or not they are Open to cash offers, so that evening up a trade is always possible.
94. As a proposer, I want to send a proposal in which one side gives only cash to a Friend who is Open to cash offers, so that I can buy or sell a card.
95. As a proposer, I want such a cash-only proposal refused when my Friend is not Open to cash offers, in either direction, so that no one is pressured into a sale.
96. As a collector, I want to turn Open to cash offers on or off with one setting, and to have it off by default, so that I choose whether to receive cash-only proposals.
97. As a collector, I want my discovery row to say I am Open to cash offers only while it is on, so that Friends know what I accept.
98. As a collector, I want a one-way match on the discovery page to read as a possible sale or purchase, so that I understand what cash would make it.
99. As a proposer who is not Open to cash offers and who sent "my $10 for your card", I want my Friend able to counter with "$15", so that a cash offer I started can be negotiated instead of only accepted or declined.
100. As a collector not Open to cash offers, I want a Counter with only cash on one side to be refused when the proposal it answers had no cash-only side, so that I am never sent a sale or purchase I did not start or opt in to.
101. As a collector, I want the app to record the agreed amount and never process, hold or verify money, so that the app is never a payment service.
102. As a collector, I want the Trade screen to show a notice that the app only records the amount and is not liable for any money exchanged, so that I understand the app's limits.
103. As a collector, I want cash to be handled between us, outside the app, at the in-person swap, so that no payment step is added to the app.
104. As a collector, I want cash to change nothing at Confirm swap beyond the recorded amount, so that confirming is only about cards.
105. As a collector, I want Stage 1 to be limited to my Friends, so that no stranger can send me a cash-only proposal; safety for sales between strangers and to minors is Stage 2's decision.

### Answering a proposal

106. As a recipient, I want to see a proposal waiting for me with both sides, any cash and the totals, so that I can decide.
107. As a recipient, I want to accept a proposal whole, so that there is no partial acceptance to argue about.
108. As a recipient, I want to decline a proposal whole, so that I can say no without a negotiation.
109. As a recipient, I want to counter a proposal, so that I can change the cards or cash and send it back.
110. As a recipient, I want a Counter to close the original proposal and open a reply prefilled with the same cards, so that I start from what was proposed.
111. As a recipient, I want to edit either side of the reply, so that I can ask for different cards or change what I give.
112. As a proposer, I want to see that a new Trade Proposal is a Counter of mine, so that I know it answers what I sent.
113. As a collector, I want each round of a negotiation to be a new proposal accepted or declined whole, so that I always know what exactly I agree to.
114. As a recipient, I want a Counter allowed only while the proposal is waiting for an answer, so that an accepted Trade is never reopened.
115. As a recipient, I want a Counter to promise my offered copies and release the sender's, so that exactly one proposal at a time promises the copies.
116. As a recipient, I want accepting to promise my side's copies immediately, so that they are promised for the swap.
117. As a recipient, I want accepting to be refused if I can no longer list enough copies, with the card and count shown, so that I never accept a trade I cannot honour.
118. As a recipient, I want accepting to check that we are still Friends, as accepting a Loan does, and declining to need no check beyond what the unfriend and Block steps already enforce, so that a Trade is never agreed outside a friendship.
119. As a recipient, I want a proposal that someone else has no right to see to behave as if it did not exist, so that Trade identifiers cannot be probed.
120. As a proposer, I want to be told when my proposal is accepted or declined, so that I do not have to look.
121. As a recipient, I want a countered proposal to leave my waiting list when I counter, so that only the live proposal needs me.

### Reservation

122. As a collector, I want a copy never to be promised to two proposals, two Trades or a Loan and a Trade at once, so that I can never promise the same card twice.
123. As a collector, I want to cancel first when I want to offer a promised copy elsewhere, so that the rule is simple and visible.
124. As a collector, I want a copy promised to a Loan to be unavailable to a Trade Proposal, and the other way round, so that the two features cannot clash.
125. As a collector, I want a Lend Offer or a Loan accept never to pick the copies a Trade covers, and a Trade never to pick copies a Loan covers, so that suggested sources are always real.
126. As a collector, I want two proposals sent at the same moment for the same copies to result in one success and one clear refusal, so that races never double-promise.
127. As a collector, I want a Trade Proposal to promise my copies by Card Edition, so that it does not matter which Location a copy sits in.
128. As a collector, I want to Move a promised copy between Locations freely, so that tidying up never needs a cancel.
129. As a collector, I want a Move of a picked copy to make that pick out of date rather than to refuse, so that I am asked to refresh it instead of being blocked.
130. As a collector, I want Inventory Removal of a copy that a Trade promises to be refused, with a message that a Trade promises it, so that I cannot remove what I owe.
131. As a collector, I want Undo of an add that would drop me below what a Trade promises to be refused, so that Undo cannot break a Trade.
132. As a collector, I want an Edition reassignment that would break a Trade promise to be refused until I swap or cancel, so that a catalog correction cannot break a Trade.
133. As a collector, I want a promised copy to stop counting as a Spare Copy, so that the Want List, Deck figures and Friend views agree with my promises.
134. As a collector, I want a Trade-promised copy to stop being lendable, so that I cannot lend a copy I owe a Trade.
135. As a collector, I want a Trade Pick List that suggests, for each promised copy, where it sits, For trade Locations first, so that I know where to take it from.
136. As a collector, I want an out-of-date pick shown with a new suggestion and a way to accept all suggestions in one action, so that fixing picks is quick.
137. As a collector, I want to be able to take suggested picks from any Location when my For trade Locations are not enough, so that a Move does not strand a Trade.
138. As a collector, I want a Trade-promised copy sitting in a Deck to be protected like any other promised copy, so that I cannot build around a card I owe.
139. As a collector, I want Deck lines to keep showing Loan reservations only in Stage 1, so that Deck screens stay unchanged until the prototype decides otherwise.

### Confirm swap

140. As a collector, I want to press Confirm swap once the in-person swap has happened, so that my Collection matches reality.
141. As a collector, I want Confirm swap to change only my own inventory, so that the other collector's confirmation is theirs alone.
142. As a collector, I want the copies I give to leave my Collection when I confirm, without appearing as an Inventory Removal or taking an Undo slot, so that a swap is not mistaken for a removal.
143. As a collector, I want the copies I give to leave their Deck lists unchanged, so that a Deck keeps asking for the card it still needs.
144. As a collector, I want the copies I get to arrive as new Holdings in a Location I choose, so that they land where I will keep them.
145. As a collector, I want received copies to default to Unsorted and to be refused if the chosen Location is not mine, so that a card never lands somewhere invalid.
146. As a collector, I want to choose a Deck as the destination, and to have that Deck's list rise as an add would, so that a card I got for a Deck counts toward it.
147. As a collector, I want the destination choice to be a Storage Leaf or a Deck, so that cards land in a place that can hold them.
148. As a collector, I want my totals to change only when I confirm, and not when the other side does, so that my Collection never moves without me.
149. As a collector, I want Confirm swap to ask me to refresh my picks first when any pick is out of date, so that I never give from a Location that no longer holds the card.
150. As a collector, I want Confirm swap to be final, with no take-back, so that a confirmed side is certain.
151. As a collector, I want a confirmed swap not to be undoable, and older Undo records to keep their usual checks, so that Undo stays predictable. The one exception is a Deck switch chosen at Confirm swap, which is a Deck List change and is undone by the Deck List changes batch's own Undo (story 232).
152. As a collector, I want copies I receive to fill my Decks' needs for that exact card first, and then lower my Trade Wants for it by the rest, so that I am not asked again for cards I got.
153. As a collector, I want a Trade to complete once both sides have confirmed, so that I can see it is done.
154. As a collector, I want to be told when the other side confirms first, so that I know it is my turn.
155. As a collector, I want to be told when the second side confirms, so that I know the Trade is complete.
156. As a collector, I want confirming twice, or retrying a confirm, to be safe, so that a retry never moves cards twice.

### Cancelling a Trade

157. As a proposer, I want to withdraw a proposal before it is answered, so that I can free my copies.
158. As a recipient, I want to decline or counter a proposal before accepting, so that I can answer without cancelling.
159. As a collector, I want either side to cancel an accepted Trade while neither side has confirmed, so that a swap that falls through frees both sides.
160. As a collector, I want cancelling to release both sides' promised copies at once, so that nothing stays promised.
161. As a collector, I want nobody to be able to cancel once either side has confirmed, so that a half-done swap cannot be undone by the other side.
162. As a collector, I want the remaining side of a half-confirmed Trade to be able only to Confirm swap, so that the Trade can finish.
163. As a collector, I want the other side told when a Trade is cancelled, without being told why, so that a Block or unfriend is never revealed.
164. As a collector, I want a withdrawal to read as withdrawn and a cancellation as cancelled, so that the history is accurate.

### Stale picks

165. As a collector, I want to be told when a pick on a Trade I have accepted is out of date, so that I can fix it before the swap.
166. As a collector, I want a Trade with an out-of-date pick to appear on my list of things waiting on me, so that I do not discover it at the table.
167. As a collector, I want using suggested picks to be refused with a clear message when nothing is out of date, so that I am not left wondering.
168. As a collector, I want fixing my picks to change only my side's picks, so that the other side is never affected.

### Unfriend, Block and half-confirmed Trades

169. As a collector, I want unfriending someone to cancel every Trade between us that nobody has confirmed, so that no promise outlives the friendship.
170. As a collector, I want a Block to do the same, so that blocking someone frees my copies.
171. As a collector, I want the Remove Friend and Block questions to count the Trade Proposals and Trades they will cancel, along with the Loans, so that I know what I am ending.
172. As a collector, I want a Trade that one side has confirmed to stay open after an unfriend or a Block, so that the remaining side can finish.
173. As the remaining side, I want to confirm a half-confirmed Trade alone, even after being Blocked, so that I am not left owed cards.
174. As the remaining side, I want the Block never to be revealed by anything I see, so that blocking stays private.
175. As a collector, I want the cancellation update after an unfriend and after a Block to be identical, and for an accepted Trade identical to a plain cancel too, so that nothing reveals which happened.
176. As a collector, I want the revision of every side whose copies were released to advance, so that my screens refresh.

### Account deletion

177. As a collector deleting my account, I want every Trade nobody has confirmed to be cancelled first, so that the other side is not left holding a promise.
178. As the remaining side of a Trade where only the deleting collector confirmed, I want to be able to confirm alone, so that I receive my copies.
179. As the remaining side of a Trade where only I confirmed, I want the Trade to close as swapped once the other account is gone, so that I am not left waiting for someone who cannot finish.
180. As the remaining side, I want the deleted collector's Display Name kept on the Trade, so that my history still reads correctly.
181. As a collector deleting my account, I want my Trade Wants, Will accept choices, picks and inbox updates removed with it, so that nothing of mine remains.

### Inbox

182. As a collector, I want a Trade Proposal waiting for my answer to appear in my inbox as waiting on me, so that I do not miss it.
183. As a collector, I want a Counter to appear as the same waiting step, labelled as a Counter, so that I know it answers mine.
184. As a collector, I want an accepted Trade with an out-of-date pick to appear as waiting on me, so that I fix it.
185. As a collector, I want a Trade the other side has confirmed and I have not to appear as waiting on me, so that I know it is my turn.
186. As a collector, I want an accepted Trade nobody has confirmed not to appear as waiting on either side, so that the list shows only what needs someone.
187. As a collector, I want each waiting line to say how long it has waited, so that I can see what is old.
188. As a collector, I want to be told in my inbox when my proposal is accepted, declined or cancelled, and when the other side confirms the swap, so that I do not have to look.
189. As a collector, I want a Counter to store no separate notice, because the new proposal is already my waiting step, so that I am not told twice.
190. As a collector, I want to read and clear Trade updates the same way as Loan updates, so that the inbox behaves consistently.
191. As a collector, I want old read Trade updates to be pruned after 90 days like the rest, so that the inbox does not grow forever.
192. As a collector, I want one waiting line per Trade, and the bell count to include Trades with Loans, so that the badge shows everything that needs me.
193. As a collector, I want my Loan inbox to look exactly as it does today when I have no Trades, so that nothing changes for people who never trade.

### Privacy

194. As a collector, I want non-Friends, collectors who have Blocked me or whom I have Blocked, and collectors with a pending request to see nothing of my Trade List or wants, so that only accepted Friends can see them.
195. As a collector, I want a Friend to see only Edition-level facts about my Trade List and wants, never a Location or Deck name, so that my organisation stays private.
196. As a collector, I want wants that come from a Deck in a Hidden Location to be left out of what Friends see, so that Friends cannot learn what a hidden Deck lacks.
197. As a collector, I want my own matching to still use every one of my wants, including those from hidden Decks, so that my own results are complete.
198. As a collector, I want a Friend's view of my wants to say whether each is from a Deck, from my own list or both, and how many of the copies my Decks need, without naming the Deck, so that the reason is clear and private.
199. As a collector, I want Friends to see only the copies I could trade now, so that promised and Borrowed Copies are never revealed.
200. As a collector, I want other Friends' proposals and Trades to be invisible to me, so that a proposal is seen only by its two sides.
201. As a collector, I want asking for a Trade I am not part of to answer as not found, so that identifiers cannot be probed.

### Developers

202. As a developer, I want the one definition of "reserved" to cover Loans and Trades, so that every inventory figure, trigger and guard follows without a parallel mechanism.
203. As a developer, I want a deferred database trigger that fails a commit when promises exceed owned copies, so that a bug in any writer cannot silently double-promise.
204. As a developer, I want a contract test that fails if any `/api/social` response exposes a Location or Deck field, so that the privacy rule is guarded against future edits.
205. As a developer, I want a contract test that fails if any module other than the choke point reads several collectors' inventory in one statement, so that cross-collector reads stay in one place.
206. As a developer, I want a contract test that the Trade Lists read never touches Borrowed Copies, so that they can never be offered.
207. As a developer, I want the allocation refactor to be figure-neutral and proven by the existing Want List, Deck cost and import tests passing unchanged, so that the redefinition of reserved is safe to land.
208. As a developer, I want the Friend Want List read to run in one snapshot with no locks and no per-Friend allocation, so that it scales to hundreds of Friends and never waits on a Friend's writes.
209. As a developer, I want a capacity test at 200 Friends, 2,000 listable Editions and 60 Decks with a time bound on the matches read, so that a regression is caught.
210. As a developer, I want every Trade step to write its `trade` row exactly once and to follow the lock order, so that opposite-direction races cannot deadlock.
211. As a developer, I want concurrency tests that run opposite steps at once against real PostgreSQL, so that races are found before users find them.
212. As a developer, I want the new error codes to be stable and documented, so that the web and tests can rely on them.
213. As a developer, I want the generated web clients checked in CI, so that API and web cannot drift.
214. As a developer, I want deploying migrations before the API to be safe, and an older API build to ignore Trade rows, so that deploys have no ordering trap.

### Added after review (2026-10-19)

215. As a collector, I want my Trade Wants for a card to add to what my Decks need of it, so that a card I want for a Deck and for my own list is wanted as the sum of both.
216. As a collector, I want only the exact card I receive to count against my Trade Wants, so that a different finish or printing received through Will accept never lowers a line I entered for another card.
217. As a recipient, I want to Counter a proposal and keep every card it asked of the sender, even when the sender listed exactly those copies, so that a Counter that changes only the cash or my side is never refused.
218. As a recipient, I want a refused Counter to leave the original proposal waiting as it was, so that I can still accept or decline it.
219. As a proposer, I want a proposal with the same card on both sides refused, so that a Trade never swaps a card for itself.
220. As a proposer, I want to be able to give cards and pay cash while my Friend gives nothing, so that a gift can include money.
221. As a proposer, I want to refresh my out-of-date picks while my proposal waits for an answer, so that my side is ready when it is accepted.
222. As a collector giving cards and receiving none, I want Confirm swap not to ask where to put received cards, so that confirming a gift is one step.
223. As a collector, I want to be told plainly when received cards cannot go to Unsorted because my Unsorted cannot hold cards, so that I can choose another destination.
224. As a collector, I want two Confirm swaps pressed at the same moment to finish the Trade, the second being told the Trade changed and finishing it on retry, so that a race never loses a swap.
225. As a developer, I want the pick order across Loans and Trades to leave every Loan pick result unchanged when no Trades exist, including an offered Lend Offer ordered after an accepted Loan, so that adding Trades changes nothing for Loans.
226. As a developer, I want a Friend's hidden Decks still allocated before their lines are dropped, so that the need a Friend sees for a visible Deck equals what they see on their own Want List.
227. As a developer, I want the listable rule written once, as one SQL function that the own and Friend reads both call, so that they can never disagree.
228. As a developer, I want every Trade step to lock owners only with the shared owner lock that foreign-key checks do not wait on, so that a Trade step never blocks the other collector's steps.
229. As a developer, I want every way a Trade closes to delete its picks through one helper, so that a closed Trade never leaves a pick that shrinks a Trade List.
230. As a collector who received a card through a widened Will accept choice for a want that came from a Deck's list, I want Confirm swap to offer, ticked by default, to use that card for the Deck instead of the card the Deck lists (`Use for <Deck> instead of <card>?`; owner, 2026-10-19), so that the Deck's list follows the card I now own.
231. As a collector, I want to untick an offered switch, so that a Deck keeps asking for the exact card I chose when I decide not to use the received one.
232. As a collector, I want a chosen switch to lower the Deck's line for the card it asked for and raise or add the line for the received card by as many, and to be undone by the Deck builder's own Undo like any Deck List change, so that it behaves like the Swap I already know.
233. As a collector, I want a switch never to move more copies than the Deck's line still needs, and to fill Decks oldest first, so that a Deck is never left asking for fewer cards than it holds and older Decks are served first.
234. As a collector, I want copies the Decks need of the received card itself, and then my Trade Wants line for it, to be filled first and never switched, so that a switch only uses copies that are otherwise spare.
235. As a collector, I want a switch that no longer matches my Decks to refuse the whole Confirm swap and change nothing, so that a stale offer never half-applies a swap.
236. As a collector, I want the Want List's Swap hint to suggest a card my Will accept choice takes when I already own a spare copy of it, so that I can make an owned spare count for a Deck without a trade.
237. As a collector who left Will accept at "this exact card", I want every Swap hint and every figure to be exactly what they are today, so that nothing changes for people who never widen it.
238. As a collector, I want my own spare copies of an accepted card not to reduce the need Friends see until I switch the line, so that what discovery shows is what my Deck Lists ask for.
239. As a developer, I want the switch candidates to be returned only from the collector's own side read and never in an `/api/social` response, so that no Deck name reaches a Friend.

## Implementation Decisions

### Terms used in this spec

Terms follow [`CONTEXT.md`](../../../CONTEXT.md) as amended by the resolution: **Trade**, **Trade Proposal**, **For trade Location**, **Trade List**, **Trade Wants**, **Will accept**, **Trade Pick List**, **Confirm swap** and **Open to cash offers**. The Spare Copy, Friend and Hidden Location entries are amended. The Loan entry is unchanged: a Loan is not a Trade. Use "Trade Proposal", never "offer"; "promised", never "held"; "Confirm swap", never "complete".

### Module boundary

Trading lives in the `social` area and follows the Loan split. The modules are:

- The social area's **trades module**, under `/api/social/trades`, owns the shared facts and the steps that change no inventory: the Trade view, listing and reading, decline, withdraw, cancel, ending Trades between two collectors, recording Trade updates, deriving the waiting step, the rule for which steps are allowed, and the Open to cash offers setting (served as `/api/social/trade-settings`).
- The social area's **trade matches module**, under `/api/social`, owns the discovery read, a Friend's whole Trade List and the card popup's Ask to trade read.
- The **`friend_copies` module** is extended and stays the only module that reads another collector's inventory. It gains the Trade List read (`friend_trade_copies`) and the Friend wants read (`friend_wants`).
- The **trade inventory module**, under `/api/trades`, owns the steps that read or write one collector's own inventory: send, Counter, Accept, Confirm swap, use suggested picks and the collector's own side view, which also returns the collector's Deck switch candidates.
- The **trade list module**, under `/api/trades`, owns the collector's own Trade List, including their own Location names, and the read of own listable copies that the trade inventory and trade matches modules share.
- The **trade picks module** computes Trade pick shortfalls, finds Trades with out-of-date picks and suggests picks from the collector's own Holdings.
- The **trade wants module**, under `/api/trade-wants`, owns the collector's own Trade Wants and Will accept choices and the read of their own wants that the trade matches module uses.
- The **trade value module**, under `/api/trades`, owns the budgeted value route.
- The **location tree module** is extended with a For trade setter and `for_trade` and `for_trade_by` on tree nodes.

Own-inventory steps and own Location names live outside `/api/social`, as with `/api/loans`. Own Trade Wants live outside the `social` area so a contract test can forbid reading them in every social module except the choke point. Stage 2 reuses these modules: non-Friend reads add a second filter beside the friendship filter in the choke point, not a new module. Detail is in the [resolution](wayfinder/resolutions/decide-trading-plumbing.md#module-boundary).

### Schema changes

All additions are in migrations 140 to 144 ([migrations note](migrations.md)). Every table is new apart from three columns.

- **For trade Location.** `location` gains `for_trade` (default false), an index on marked Locations per owner, and a constraint that a Deck is never marked. The SQL function `for_trade_locations` is the one definition of "effectively For trade": recursive over `location.parent_id` from each marked Location, mirroring the Hidden Locations function, and excluding Decks. Hidden and For trade are independent columns. The setter bumps the Location version and never the inventory revision.
- **`trade`** is one table for Trade Proposals and the Trades they become, as `loan` holds Borrow Requests, Lend Offers and Loans. The row that is accepted is the Trade. Columns are the state (`proposed`, `accepted`, `closed`), the closed reason (`declined`, `withdrawn`, `countered`, `cancelled`, `swapped`), proposer and recipient ids (nullable, `ON DELETE SET NULL`), both Display Names kept as copies and refreshed by a trigger on `collector_profile`, `countered_from` (the proposal this one answers), `cash_cents` and `cash_payer`, the creation, acceptance and closing times and who closed it, the per-side `proposer_swap_at` and `recipient_swap_at`, and a revision. Constraints require two different collectors, a reason exactly when closed, a payer exactly when there is cash, and no swap time before acceptance. Cash is integer US cents, capped at 99,999,999 as a sanity bound.
- **`trade_line`** holds the cards each side gives (keyed by Trade, side and Edition, with a required position and a required positive quantity). `side` is the giver. At most 50 lines per side (422 `TOO_MANY_LINES`), and an Edition is on at most one side (422 `SAME_CARD_BOTH_SIDES`).
- **`trade_pick`** is the Trade Pick List: owner, Edition, source Location (the one nullable column, set to NULL if the Location is deleted) and quantity, per line. Pick ids come from the `loan_pick` sequence, so a pick id is unique across both pick tables. Picks are made when a side's copies reserve and deleted at that side's Confirm swap, and every close deletes the row's picks through one helper, `close_trade`.
- **`trade_want`** holds the collector's Trade Wants: owner, Edition and a quantity from 1 to 9999. At most 500 lines per owner (422 `TOO_MANY_LINES`). A line adds to what the collector needs of that Edition in trading only (discovery matches and lowering at Confirm swap); the Want List's own counts, totals and exports never read it (Trading #275).
- **`trade_accept`** holds Will accept choices keyed by owner and Edition, with the rule `printing` or `identity`. A missing row means this exact Edition. Rows outlive a card leaving the Want List and apply again if it returns. The Want List response keeps its shape, counts, totals and exports; only a line's Swap hint differs when its Will accept is widened, and no revision pin or Mass Entry conflict covers the hint (checked in Trading #275), so widening Will accept moves no pin.
- **`collector_profile.open_to_cash_offers`** (default false).
- **`inbox_update`** gains `trade_id`, its `loan_id` becomes nullable, a constraint requires exactly one of the two, and the kind check is rebuilt as the union of the existing kinds and `swapped`. An older API build's join on `loan` skips Trade rows, so deploy order is safe.
- **State model.** `proposed` becomes `accepted` (recipient's Accept), or `closed` with `declined`, `withdrawn`, `countered` or `cancelled`. `accepted` becomes `closed` as `cancelled` (either side, while both swap times are empty) or as `swapped` once both are set, or as `swapped` when the side still to confirm has a deleted account and the other side has confirmed. A Counter closes the old row as `countered` and inserts a new `proposed` row with `countered_from` set, in one transaction. The two swap times are not states.

### The shared promise invariant

Migration 142 redefines `reserved_copies` as the union of the Loan part, unchanged, and a Trade part. The proposer's lines reserve while a proposal is proposed or accepted and the proposer has not confirmed. The recipient's lines reserve once accepted, until the recipient confirms. `check_loan_promises`, every deferred constraint trigger, `reserved_counts`, `reserved_by_owner` and every caller then cover Trades with no change. The check's message becomes "Open Loans and Trades promise ..." and keeps its constraint name and SQLSTATE. Deferred triggers on `trade` and `trade_line` call the same check, only for a side whose promise rises, as the Loan guard does: the proposer's lines when a row is inserted, the recipient's when it moves to accepted, and a line inserted or changed while its side reserves. The trigger on `trade` fires on a change of state, of either swap time or of either owner id, and checks a side when the new row reserves it and the row is new, the old row did not reserve it or that side's owner changed. Closing a row or confirming a swap leaves the side not reserving and checks nothing, but clearing a swap time directly, which re-reserves copies, is checked.

A new function, `reserving_picks`, returns the reserved Loan picks and Trade picks together with two sort keys: the acceptance time, then the creation time (the acceptance time again for a recipient's side). Picks sort by acceptance with unaccepted rows last, then by the second key, so with no Trades the order is exactly today's Loan order and an offered Lend Offer still sorts after every accepted Loan. Python reads it for one owner through one helper in the counts module. The three readers of reserved picks (the reserved-picks count, the pick shortfalls and the move-picks update) switch to it, so the Spare Copy rule places Trade-reserved copies at their picks, Lend Offers and Loan accepts never pick copies a Trade covers and the other way round, and Deck deletion and leaf conversion re-key `trade_pick` too.

**When copies reserve.** The sender's lines reserve on send and on Counter. The recipient's reserve on Accept. All are released by decline, withdraw, Counter (the old proposal's sender), cancel, unfriend, Block and account deletion. Each side's reservation also ends at its own Confirm swap. There is no expiry.

**What may be offered.** Every line a side gives is capped at that side's **listable** copies at the moment its copies reserve, else 409 `NOT_TRADEABLE` with the Edition, how many are available and which side (`you_give` or `you_get`). For the other side's lines on send or Counter, the cap is that Friend's listable copies through the choke point, read on the step's own connection. Nothing of the Friend's is reserved until they accept.

**Listable, one rule, for own and Friend reads**, written once as the SQL function `trade_listable` in migration 142, which both reads call. Per owner and Edition: copies held in For trade Locations, less the For trade copies that reserving picks cover, bounded by total held less reserved, and never below zero. Reserved copies picked from a Deck therefore do not shrink the Trade List, and stale picks can never over-list. Lent copies are not in `holding` and Borrowed Copies are in their own table, which is never read.

**Trade Pick List.** Picks are made at reservation, per Edition, For trade Locations first (largest Holding first, then name, then id), never from copies other reserving picks cover. The listable cap guarantees enough. "Use suggested picks" may draw on any Location, For trade first and then the Deck Pick List order. Stale picks are computed, not stored.

**Shapes of a proposal**, checked on send and Counter: at least one side gives at least one card, else 422 `TRADE_HAS_NO_CARDS`. A side may give nothing, so a proposal can be a gift either way (owner's choice, 2026-10-19). A side that gives only cash requires the recipient to be Open to cash offers, else 409 `CASH_ONLY_NOT_OPEN`, in both directions. A Counter is a proposal sent to its recipient, so the recipient's setting applies, except when the countered proposal already had a cash-only side: then the Counter may keep or change a cash-only side (owner, 2026-10-19). Cash is sent as an amount and a payer together, or not at all; an amount that is not a whole number of cents from 1 to 99,999,999 is 422 `INVALID_CASH`. Cash alongside cards is always allowed. "Gives only cash" means a side gives no cards and pays the cash, so a gift plus cash (one side gives cards and pays, the other gives nothing) needs no Open to cash offers check. One Edition on both sides is 422 `SAME_CARD_BOTH_SIDES`.

### Step contracts

The request bodies, the cash encoding, the Trade view and the table of allowed steps are fixed in the [resolution](wayfinder/resolutions/decide-trading-plumbing.md#step-contracts). In short:

- **Bodies.** Send takes the recipient, the `you_give` and `you_get` lines (Edition and a quantity string), optional cash (`cents` as a decimal string from 1 to 99,999,999 and `payer` `you` or `them`, relative to the sender) and an idempotency key. Counter takes the revision, the key and the same lines and cash. Accept, decline, withdraw, cancel and use suggested picks take the revision and the key. Confirm swap adds an optional destination, ignored when the confirmer receives no cards, and an optional list of chosen Deck switches, each a Deck, the Edition to lower, the Edition to raise and a count as a decimal string (counted in code, at most 50, else 422 `TOO_MANY_LINES`). An empty or missing list switches nothing. Line caps are counted in code so they answer `TOO_MANY_LINES`, and the gateway's 16 KiB body limit bounds every body.
- **Trade view.** The id, state, closed reason and who closed it, the reader's role, the other party (id, Display Name, Handle, Open to cash offers), what it counters, both sides' cards with copies, the cash, both swap confirmations, whether and why it waits on the reader, its section (`needs_you`, `to_swap`, `pending`, `history`), the allowed actions, the revision and the creation time. It never carries picks, a destination, a Location or a Deck.
- **Allowed steps.**
  - A proposed row allows the recipient to accept, decline or counter, and the proposer to withdraw or use suggested picks.
  - An accepted row nobody has confirmed allows either side to Confirm swap, use suggested picks or cancel.
  - Once only the other side has confirmed, the reader may Confirm swap or use suggested picks.
  - A side that has confirmed, and every closed row, allow nothing.
  - Use suggested picks is listed only for a side that gives cards, and answers `PICKS_UP_TO_DATE` when nothing is out of date.

### Confirm swap and ownership transfer

Confirm swap runs under the confirmer's own owner lock only, taken with the shared owner lock that foreign-key checks do not wait on, and changes only the confirmer's inventory, plus the Deck List lines of any Deck switch the collector chose. Before any write it reads the confirmer's revision and, when they receive cards, their Deck needs for the received Editions and the Deck switch candidates, with no `FOR UPDATE` lock:

1. If the confirmer gives cards and any of their picks is out of date, it answers 409 `PICKS_OUT_OF_DATE`, and use suggested picks fixes them (409 `PICKS_UP_TO_DATE` when nothing is out of date). This mirrors the Loan handover.
2. **Copies given** leave through the same inventory write as a Loan handover: Removal semantics, no Undo record, Deck List lines not lowered. The side's picks are deleted and its reservation ends in the same transaction, so Holdings and promises fall by the same count.
3. **Copies received** arrive as new Holdings in the chosen destination, which must be one of the confirmer's Storage Leaves or Decks and defaults to Unsorted (404 `LOCATION_NOT_FOUND` otherwise; 409 `UNSORTED_UNAVAILABLE` when the root named Unsorted cannot hold cards). When the confirmer receives no cards, the destination is ignored and Unsorted is not created. A new inventory write, `add_in`, adds them without the surplus setting that returns use, so copies arriving in a Deck raise its lines as an Add does. It writes no Undo record and sets the revision the give step returned, so a swap advances the confirmer's revision exactly once. It is a new writer, a delegated deviation from the map's "existing writers": the existing Holding upsert with the Deck List trigger left on. It does not depend on the other account still existing, because it reads only `trade_line`.
4. **Deck switches** (owner, 2026-10-19). When a copy the confirmer receives arrived only through a widened Will accept choice (any finish, or the same Card Identity) for a want that came from a Deck's list, Confirm swap offers to switch that Deck's line.
   - A switch lowers the line of the card the Deck listed by the copies and raises or adds the received card's line by as many, per Deck, oldest Deck first, never more than that line still needs. The copies the Decks need of the received card itself are used for that card first and never switched. Under counting one Deck at a time, the copies switched across all Decks total at most the copies received (an assumption to confirm).
   - The collector's own side read returns these candidates, so the web can show each ticked by default and let the collector untick it. Confirm swap takes the ones left ticked. The step checks each against the same computation, and a chosen switch that no longer matches (the Deck List or the Holdings changed, or the count is too high) refuses the whole step with 409 `DECK_SWITCH_CHANGED` and changes nothing.
   - Chosen switches are applied after the received copies are added, in the same transaction, under the confirmer's own lock, with the Deck List changes batch's own write logic (the batch route's lock cannot be used here, so its write part is shared). The batch takes new line totals, so a Deck's switches that share a card are folded into one set of totals first. Only the switched Decks' Deck List revisions advance; the inventory revision still advances exactly once. When the destination is the switched Deck, the received copies already raised its line, so the switch only lowers the other line (an assumption to confirm).
   - A switch is a Deck List change, not an inventory change: it writes no inventory Undo record, Undo of anything else does not undo it, and it follows the batch's own Undo rules, so its Undo is the inverse batch the Deck builder sends, refused as stale if the list changed since.
5. **Trade Wants.** Received copies of an Edition fill the confirmer's Deck needs for that Edition first, as read before any write. The Trade Wants line for that exact Edition then falls by the copies left over, and only copies left after both can be switched into another Deck's line, and is deleted when they cover it (owner's answer, 2026-10-19). Example: the Decks need 2, Trade Wants say 4, 3 arrive, and the line goes from 4 to 3. Copies received through a widened Will accept choice lower no other Edition's line and fill no Deck line that names another Edition, unless a chosen switch moved that line to the received Edition. The destination does not change these numbers.
6. The side's swap time is set. When the other side has already confirmed, the Trade closes as `swapped` and the other side gets a `swapped` update.
7. Cash changes nothing: the app never handles money.

A confirmed swap is not an Inventory Removal and takes no inventory Undo slot. It has no take-back and nothing reverses it; the only exception is a Deck switch, which has the Deck List changes batch's own Undo and never reverses the swap. Undo records older than the swap keep their usual checks, as after a Loan handover. A giver short at confirm cannot happen while the invariant holds; a failure there is a bug and rolls back.

### Locks, revisions, cancel and ending a friendship

**Lock order** extends ADR 0014: `inventory_owner` rows in ascending `user_id`, then `loan` rows in id order, then `trade` rows in id order. Each step writes its `trade` row exactly once. Row locks are `FOR NO KEY UPDATE`. A deadlock the database ends anyway answers 503 `INVENTORY_TEMPORARILY_UNAVAILABLE`. Commands take the per-collector advisory command lock, replay by idempotency key, then count a `trade_command` (120 per hour, 429 `TOO_MANY_CHANGES`). Every Trade step locks owner rows only with the shared owner lock (`FOR NO KEY UPDATE`), never the single-owner inventory lock or the Location tree read that takes `FOR UPDATE`, and reads Locations with plain selects, as Loan steps do.

| Step | Locks | Revisions advanced |
| --- | --- | --- |
| Send proposal | proposer | proposer |
| Counter | both | the proposal's sender (released) and the recipient (reserved) |
| Accept | recipient | recipient |
| Decline | both | proposer |
| Withdraw | proposer | proposer |
| Cancel an accepted Trade | both | both |
| Confirm swap | confirmer | confirmer, exactly once |
| Use suggested picks | that side | that side |
| Unfriend or Block | both (already locked) | each side whose reservation was released |
| Reads, inbox | none | none |

- **Counter order.** A Counter runs its own flow: lock both owners, then lock the old proposal and check its revision, the allowed steps, the friendship and the cash-only rule; close the old proposal as `countered` and delete its picks; only then read the caps on the same connection; then insert the new proposal, its lines and the Counter sender's picks; then advance both revisions. A refused cap rolls everything back and leaves the old proposal waiting with its picks. Each row is still written once.
- **Send, Counter and Accept** check friendship under the step's locks (409 `NOT_FRIENDS`); Accept's check is the same one as the Loan accept. Decline and cancel need no check beyond unfriend and Block, which close every unconfirmed Trade first and serialise on the owner locks.
- **Cancel rules.** Before acceptance the proposer withdraws and the recipient declines or counters. After acceptance either side cancels while both swap times are empty. Once either side has confirmed nobody cancels and the remaining side may only Confirm swap. A Counter is allowed only on a `proposed` row.
- **Unfriend and Block** call a new ending step after the Loan one, inside the Friend command that already locked both owners. It locks the pair's unconfirmed Trades in id order, closes each as `cancelled` through the one closing helper (which deletes its picks), records a `cancelled` update for the other side without a reason, and advances the revision of every side whose copies were released, once each. Unfriend and Block write the same update; for an accepted Trade it is the same as a plain cancel's, and for a proposed row it reads "cancelled" whichever ended the friendship. Trades with one confirmation stay open and the remaining side can still confirm after a Block, which reveals nothing. The Remove Friend and Block questions count Trades with Loans.
- **Account deletion** (the feature does not exist yet; these are requirements for it): lock the deleting collector and every counterparty of an open Loan or Trade in ascending `user_id`, in one call, then cancel every unconfirmed Trade as unfriend does; a Trade only the deleting side confirmed stays open for the other side to confirm alone; a Trade only the remaining side confirmed closes as `swapped`; the proposer and recipient ids go NULL and the names are kept; the deleter's inbox updates are deleted; `trade_want`, `trade_accept` and `trade_pick` cascade with the owner.
- **Edition reassignment does not carry Trades.** The existing promise check counts Trade promises, so a reassignment that would break one is refused with `PROMISED_TO_TRADE` and the collector swaps or cancels first. The reassignment's lock set is unchanged. Received copies of a deprecated Edition arrive as that Edition and the existing replacement prompt offers to reassign them. `trade_want` and `trade_accept` rows are not re-keyed.

### Matching reads and the choke point

All cross-collector Trade reads are in the `friend_copies` module, which ADR 0015 treats as one module rather than one function.

- **`friend_trade_copies`** is one statement that keeps only Friends with no Block either way and joins them to `trade_listable`, the one listable rule (For trade membership from `for_trade_locations` with no hidden filter, reservations from `reserved_copies` and placement from `reserving_picks`), per Friend and Edition. It returns no Location id, never reads Borrowed Copies, and returns only positive listable counts.
- **`friend_wants`** returns, per Friend and Edition, the Want List need, the Trade Wants quantity and the Will accept rule. The Want List part allocates over every Deck and Holding of the Friend, hidden Decks included, exactly as their own Want List would (their counting setting, Borrowed and lent copies), so an older hidden Deck still takes Spare Copies in the usual order. Then it drops the lines of Decks inside Hidden Locations, and only then combines per Edition by sum or maximum as their setting says. For each Deck outside a Hidden Location, the need is exactly what the Friend sees for that Deck on their own Want List. The Trade Wants part is their `trade_want` quantity for that exact Edition, always matched exactly. The two parts add. It never names a Deck: the field is `want_list_need`, not a Deck field, because the contract guard forbids the word.
- **The batched, lock-free allocation read.** First, a figure-neutral refactor splits `allocate` into a frozen set of input rows (`AllocationRows`), a single-owner reader (`read_allocation_rows`) and a pure `allocate_rows`. `allocate` becomes the composition with unchanged figures. No multi-owner reader is added to `copy_allocation`, `counts` or `borrowed_copies`. `friend_wants` builds one set of rows per prefiltered Friend from its own batched statements inside `friend_copies`, including which of their Decks sit in Hidden Locations, in one `REPEATABLE READ READ ONLY` transaction with no locks. It calls the pure function in memory over every Deck, then drops the hidden Decks' lines before combining. It is restricted to candidate Editions that could match the viewer's Trade List, by Card Identity and the widest Will accept, and Friends whose Deck Lists name none of them are skipped by a prefilter statement.
- **Expansion for Will accept** is a new function beside the existing reach function: `edition` gives the exact Edition, `printing` gives every Edition of its Card Printing, and `identity` gives every Edition of every Card Printing with the same Card Identity. It does not involve the counting setting. The Swap hint and the Deck switch candidates use it too, so it must be reachable from outside the social area (an open item).
- **Owned spares do not reduce the need** (owner, 2026-10-19). Until a Deck line is switched, the collector's own spare copies of Editions their Will accept rule accepts reduce no need in discovery, whether it is the viewer's own wants or a Friend's. The Swap hint is how the collector makes them count. Example: a Deck needs card A, Will accept is the same name, and the collector owns a spare copy of B. Discovery still shows A wanted, and taking the Swap hint switches the line to B and removes the want.
- **`GET /api/social/trade-matches`** reads the viewer's wants (the Want List under the viewer's own lock, plus Trade Wants) and the viewer's Trade List, then on a separate connection in one read-only repeatable-read transaction reads the Friends' listable copies and wants, and pairs them in memory. It answers `TradeMatches { has_friends, rows }`. Each row has the Friend's id, Handle and Display Name, `open_to_cash_offers`, the match kind (`two_way`, `has_what_you_want`, `wants_what_you_have`), up to 20 `you_get` and 20 `you_give` cards each with card facts, `copies`, `need` (wanted in total by the side that would receive it: the Want List part plus the Trade Wants quantity), `want_list_need` (the Deck part, shown as in "6 wanted (2 for Decks)"), `origin` (`want_list`, `trade_wants` or `both`) and, for cards the viewer would get, `accepts_as` (`exact`, `any_finish`, `same_name`, the narrowest match), and `more_you_get` and `more_you_give` counts. Rows sort by match kind, then Display Name, then Handle. A per-Friend route returns the full lists. There are no values in discovery. The opaque card descriptor is registered in the contract guard's allow-list.
- **`GET /api/social/trade-lists/{handle}`** is a Friend's whole Trade List, with the same 404 `FRIEND_NOT_FOUND` rule as a Friend's Collection, paging by Card Identity and a search parameter.
- **`GET /api/social/trade-card-matches?printing_id=`** backs Ask to trade: Friends with listable copies of the Printing's Editions.
- **Capacity target.** 200 Friends, 2,000 listable Editions and 60 Decks per collector, with `trade-matches` at a 95th percentile of at most 1.5 seconds on the verification host. Nothing in the repo states a Friend count, so this is a design target to confirm. Measured on 2026-10-20 (Trading #276, `test_trade_capacity.py`, every Friend matching both ways with more than 20 cards a side): a 95th percentile of 1.18 seconds.

### Value cues

`POST /api/trades/value` takes lines tagged `you_give` or `you_get` (at most 100, counted in code, else 422 `TOO_MANY_LINES`; 422 `DUPLICATE_EDITION` for a repeat on one side; 100 lines, about 9 KB, fit the gateway's 16,384-byte body limit), prices the Editions once through the existing private quote read, and folds each side with the shared Deck cost fold. It answers a status (`priced`, `empty`, `no_quotes`, `incomplete`), a display total and priced and total copy counts per side. No provider, check time, refresh state or source name ever appears in the response. It is a POST so unsent proposals and Counters can be valued, and cash is not part of it. It is a budgeted route, so it is added to both the API's budgeted-route list and the gateway's list, which must change together. The client never calls the Edition price route directly.

### Inbox integration

- **Waiting on you** is derived, with one line per Trade, in this order: `answer` (the reader is the recipient of a `proposed` row; a Counter is the same step and the view carries what it counters), `fix_picks` (accepted, the reader has not confirmed, their picks are out of date) and `confirm_swap` (accepted, the other side confirmed and the reader has not). An accepted Trade nobody has confirmed is waiting on neither side. The time waited is measured from when the Trade reached that step.
- **Stored updates:** `accepted` and `declined` go to the proposer; `cancelled` goes to the other side (read as `withdrawn` for a withdrawal); `swapped` goes to the side that confirmed first. A Counter stores none. There are no time-based Trade updates.
- **Response**, additive: the inbox view gains `trade_waiting` and `trade_updates`, newest first, at most 50. The existing `waiting` and `updates` fields are byte-identical, and their tests pass unchanged. Read and clear work unchanged, because Trade update ids are inbox update ids. The bell count is Loans waiting plus Trades waiting.
- `GET /api/social/trades` returns the Trades and which need the reader, for whichever screen lists them.

### Error codes

`PROMISED_TO_TRADE` (409, with the Edition and how many are promised) is raised by the shared promise check when a Trade promises the refused copies, and `PROMISED_TO_LOAN` otherwise, so every existing test and screen is unchanged. Callers that inherit it: Inventory Removal, Undo of an add and Edition reassignment. The web maps it wherever it maps `PROMISED_TO_LOAN` today.

New codes:

- `NOT_TRADEABLE` (409), with the Edition, how many are available and which side (`you_give` or `you_get`).
- `TRADE_NOT_FOUND` (404), also for non-parties.
- `TRADE_CHANGED` (409), on a stale revision.
- `TRADE_HAS_NO_CARDS` (422).
- `SAME_CARD_BOTH_SIDES` (422), one Edition on both sides of a proposal.
- `CASH_ONLY_NOT_OPEN` (409).
- `INVALID_CASH` (422), cents not a whole number from 1 to 99,999,999.
- `DECK_SWITCH_CHANGED` (409), a chosen Deck switch at Confirm swap that no longer matches the step's own computation; the whole step is refused and nothing changes.
- `DECK_NOT_FOR_TRADE` (409).
- `LOCATION_FOR_TRADE_BY_PARENT` (409), with the covering Location in `for_trade_by`.

Reused: `STEP_NOT_ALLOWED`, `NOT_FRIENDS`, `OWN_ACCOUNT`, `DUPLICATE_EDITION`, `TOO_MANY_LINES` (422 for every line cap), `INVALID_QUANTITY`, `PICKS_OUT_OF_DATE`, `PICKS_UP_TO_DATE`, `LOCATION_NOT_FOUND`, `UNSORTED_UNAVAILABLE` (409, Confirm swap into an Unsorted that cannot hold cards), `TOO_MANY_CHANGES` and `INVENTORY_TEMPORARILY_UNAVAILABLE`.

### Inventory touch-points

Moves are unchanged (a Location does not matter to a promise; moving a picked copy makes its pick out of date). Inventory Removal, Undo and Edition reassignment refuse through the shared check. Deck deletion and leaf conversion re-key Trade picks. Location deletion refuses Holdings as today, and a deleted pick source becomes NULL and its pick is out of date. Hide and show, Add, batch add, Collection Import and Decklist Import are unchanged. Confirm swap's received copies go through one new writer, `add_in`, a delegated deviation from the map's "existing writers" (see Confirm swap). Spare Copy figures, the Deck Pick List, Deck ownership, Use cards I own and the Want List follow `reserved_counts` and the reserved picks, so Trade-promised copies stop being Spare Copies exactly as Loan-promised ones do, with no code change. Swap hints follow the same reads but gain code: a line's hint also considers the Editions its Will accept rule accepts, with the same availability, one-pass and never-offered-twice rules and the same Deck List changes batch. The Want List keeps its shape, counts, totals and exports, and with Will accept left at "this exact card" every hint is unchanged. No revision pin or Mass Entry conflict covers the hint (checked in Trading #275). Chosen Deck switches at Confirm swap are written with the Deck List changes batch's write logic, which that batch's route and Confirm swap share. The Friend lend view and the Lend Offer caps see Trade promises through the same reads. Deck line labels for reservations stay Loan-only in Stage 1.

### Web

- Trade types for `/api/social/*` join the social generated client's component list. A new generated client covers `/api/trades*` and `/api/trade-wants*` and joins the client check.
- Where Trades are listed (a tab, or inside Loans), the destination picker's default and all copy are decided by the prototype ticket. The API supports a Trade page by identifier, as Loans have.
- The Trade screen shows the liability notice. It is a legally required notice and so exempt from the UI copy rule.
- All other screens follow the repository's UI copy rule: collectors see cards, counts, names of Friends, cash amounts and totals, and never a data-source name, a fetch or check time, a refresh state, an internal reason, or a record identifier. Discovery shows no values.

### Migrations

Trading takes migrations 140 to 179. Files 140 to 144 are fixed ([migrations note](migrations.md)); 145 to 179 are spare. All are re-runnable. Migration 142 redefines `reserved_copies` and `check_loan_promises` from migration 106 and adds `reserving_picks` and `trade_listable`. Whoever merges second makes the last definition applied the union. The same rule covers the two kind CHECKs Trading widens (`handle_lookup_event` in 141, `inbox_update` in 144): each is rebuilt from the union of every kind already allowed and the new one.

## Testing Decisions

A good test checks external behaviour only: what a signed request returns, what a collector's figures and lists become, and what a database refuses. It does not check which function was called, how a query is written or how rows are laid out beyond the contract. A refactor that keeps behaviour must not break a test.

Three seams exist already and are reused:

1. **The signed HTTP API against real PostgreSQL** is the primary seam. Tests send signed requests as two or more collectors and assert on responses and on later reads.
2. **The same API seam run concurrently** covers races, with opposite steps sent at the same moment.
3. **Playwright with two collector contexts** covers one end-to-end story and the browser-only behaviour.

Plus two guards: the allocation refactor is figure-neutral, and a capacity test bounds the matches read.

**Prior art, by test module.** The loan, Lend Offer, loan promises, ending friendship, Friend copies, inbox and social contract tests are the models. Write Trade tests beside them.

**Which modules get tested.**

- **Promise invariant (a trade promises test, real PostgreSQL).** Reserved counts sum Loan and Trade promises; a copy promised to a Loan cannot go in a proposal (`NOT_TRADEABLE`) and the other way round; Removal, add Undo and reassignment refuse with `PROMISED_TO_TRADE`, and still with `PROMISED_TO_LOAN` when only Loans promise; Moves are free and make picks out of date; a direct write that breaks the invariant fails at commit through the `trade` and `trade_line` triggers, including a direct write that clears the proposer's swap time on a Trade whose copies are gone; Deck deletion and leaf conversion carry `trade_pick`; Lend Offers never pick copies a Trade covers; with no Trades the pick order is today's, so an offered Lend Offer created before a later-accepted Loan is still the one whose pick goes stale when their shared source runs short (the stale Loans, the handover refusal, the suggested replacement and the covered copies all match today's); the listable function gives the same count to the own and Friend reads; two concurrent sends, or a send racing an accept, for the same copies leave one success and sums that hold.
- **Trade steps (a trades test).** Every state and closed reason; Counter closes, reopens prefilled, swaps the reserved side and sets `countered_from`; a Counter that keeps every card the sender listed exactly succeeds; a Counter refused with `NOT_TRADEABLE` leaves the original proposal waiting with its picks and reserved copies; the allowed-steps table row by row, including use suggested picks on a waiting proposal and `PICKS_UP_TO_DATE`; `SAME_CARD_BOTH_SIDES`; a gift plus cash accepted with the recipient not Open to cash offers; Accept refused with `NOT_FRIENDS` once the friendship is gone; accept and decline are whole only; cancel only while nobody has confirmed; a half-confirmed Trade allows only Confirm swap for the other side; `TRADE_CHANGED` on a stale revision; idempotent replay; the 120-per-hour limit; every shape rule (`TRADE_HAS_NO_CARDS`, and a gift with nothing on one side accepted; `CASH_ONLY_NOT_OPEN` in both directions and on a Counter whose recipient is not Open to cash offers; `INVALID_CASH`; cash alongside cards always allowed); lines capped at listable copies, with a hidden For trade Location counting, a Deck inside a For trade Location never counting and Borrowed Copies never counting. Marking a Deck, un-marking inside a marked ancestor, and For trade versus hidden independence belong with the Location tree tests.
- **Confirm swap (a trade swap test).** Given copies leave their picks with no Undo record and Deck List lines unchanged; received copies land in the destination, or Unsorted, and raise a Deck's line; totals change on each side only after that side's own confirm; out-of-date picks give `PICKS_OUT_OF_DATE`, then use suggested picks; Trade Wants fall only by the copies the Decks did not need (Decks need 2, Trade Wants 4, 3 arrive: the line goes to 3), are deleted when covered, and copies received through Will accept lower no line; the confirmer's revision advances exactly once; the destination is ignored when nothing is received; `UNSORTED_UNAVAILABLE` when Unsorted cannot hold cards; the second confirm closes the Trade as `swapped`; confirming alone after the other account is gone and after a Block; an older Undo record behaves as after a Loan handover. Deck switches: a ticked switch is applied at Confirm swap (the Deck's line moves to the received card and the need is gone); an unticked one leaves the Deck List alone; a stale or too-high switch answers `DECK_SWITCH_CHANGED` and changes nothing (no copy moves, no swap time is set, no Deck List changes, the inventory revision is unchanged); a switch never exceeds what the line still needs, fills Decks oldest first and never uses copies the Decks need of the received card itself; only the switched Decks' Deck List revisions advance and no inventory Undo record is written; the Deck builder's inverse batch undoes it; a destination that is the switched Deck is not counted twice.
- **Ending a friendship (extend the ending friendship test).** Remove Friend and Block cancel unconfirmed Trades and release both sides' reservations with the right revisions; half-confirmed Trades stay; the update reads cancelled with no reason; it is byte-identical between unfriend and Block, and for an accepted Trade also byte-identical to a plain cancel.
- **Privacy (a trade matches test, extend the social contract test).** Non-Friends, a Blocked collector either way and pending requests see no Trade List and no wants; promised copies leave the Trade List at once and come back when released; wants from Decks in Hidden Locations are absent, while an older hidden Deck still takes Spare Copies, so under Every Deck built at once a visible Deck's need is the one the Friend sees themselves; only the counts module and the choke point call `reserving_picks`, and only the trade list module and the choke point call `trade_listable` (these caller guards match string constants only, as the existing inventory read guard does, so no other string, such as an error message, may write the call form); no `/api/social` trade response has a Location or Deck field, and the Deck switch candidates appear only in the collector's own side read; in the social area, no social module calls `for_trade_locations`, and only the choke point calls `trade_listable` or reads `trade_want` or `trade_accept`; the Trade List statement never reads Borrowed Copies; and a new guard fails when any module outside the choke point filters several collectors' inventory.
- **Matching (the same trade matches test).** Two-way, has-what-you-want and wants-what-you-have ordering; each Will accept rule (exact only; any finish; same Card Identity including other Printings); Trade Wants always exact; `origin` is `want_list`, `trade_wants` or `both`, `need` adds the two parts and `want_list_need` is the Deck part; a Friend's need follows their counting setting; the 20-card cap with the `more_*` counts and the full per-Friend read; Open to cash offers on the row; no values in discovery; the collector's own spare copies of an accepted card reduce no need in discovery, for the viewer and for a Friend, until a switch is made. The Swap hint with Will accept widened suggests an owned spare of an accepted card, sends the same Deck List changes batch, offers a spare to one line only and lowers the need once taken; with Will accept left at "this exact card" every hint and figure is unchanged and the existing Swap hint tests pass unchanged.
- **Capacity (a slow, serial test).** 200 Friends, 2,000 listable Editions and 60 Decks; the matches read at a 95th percentile of at most 1.5 seconds. It is marked serial because it bounds time.
- **Allocation refactor guard.** Figure-neutral: the existing Want List, Deck counting, Deck cost and import test files pass unchanged against the split reader and the pure function. With no Trades present, every figure is identical after the `reserved_copies` redefinition.
- **Value (a trade value test).** Exact micro-dollar fold per side; statuses; the response schema has no provider, check-time, refresh or source name; the route is budgeted (401 without a budget, as for the Want List cost).
- **Inbox (extend the inbox test).** `answer`, `fix_picks` and `confirm_swap` and their time waited; the four stored kinds with `withdrawn` read from the closed reason; Trade updates clear and read through the existing routes and are pruned after 90 days; an old-style query that joins on `loan` ignores Trade rows; with no Trades, the `waiting` and `updates` fields are byte-identical to today's.
- **Concurrency (real PostgreSQL, opposite directions).** Counter versus withdraw; cancel versus Confirm swap; both Confirm swaps at once (one answers 200, the other 409 `TRADE_CHANGED`, and its retry closes the Trade as `swapped`); unfriend while an accept runs; Lend Offer versus Trade send for the same copies. None deadlocks and the right revisions move.
- **Browser (two collector contexts).** One end-to-end story: A marks a binder For trade; B sees a two-way row and proposes from it; A counters with cash; B accepts; each confirms the swap; ownership has moved on both sides. Plus: the card popup's Ask to trade; a cash-only proposal refused and then allowed once Open to cash offers is turned on; the Trade screen shows the liability notice; phone width; and the accessibility checks the social spec lists.

## Out of Scope

- **Stage 2:** discovery for collectors who are not Friends, zip codes, distance bands, sorting by distance, a card search ("who near me has this card"), messaging or a meetup step for strangers, reporting, blocking non-Friends, and safety for minors and for sales between strangers. Stage 1 must not depend on any of them.
- Processing, holding or verifying any payment. Cash is a recorded agreement only.
- Shipping and mail trades.
- Take-back of a Confirm swap.
- Proposal expiry. Reservations never expire.
- Partial swaps and partial acceptance of a proposal.
- Adding single cards to the Trade List outside a For trade Location.
- Email or push notifications.
- A suggested cash amount, and values on discovery rows.
- Nudges for unanswered proposals, Edit and resend for proposals, and Deck-line "promised in a Trade" labels.

## Further Notes

### Sources

- [Trading decision map](wayfinder/map.md), the authority on collector-facing behaviour.
- [Plumbing resolution](wayfinder/resolutions/decide-trading-plumbing.md) and [ADR 0015](../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md), the authority on plumbing.
- [Trading migrations note](migrations.md).
- [`CONTEXT.md`](../../../CONTEXT.md), as amended by the resolution.
- The [social network spec](../social-network/spec.md), the Friends and Loans spec Trading builds on, and [ADR 0014](../../adr/0014-friend-reads-and-two-owner-loans.md).

### The nine owner answers

These nine questions were put to the owner with a default each. On 2026-10-19 the owner allowed gifts (5) and approved the other eight as written.

1. **A Deck inside a For trade Location** is not on the Trade List; Decks never are. Alternative: they are, which removes the Deck exclusion from the For trade function.
2. **Wants from a Deck in a Hidden Location** are not shown to Friends in discovery. The collector's own matching uses every want.
3. **Will accept scope** is one choice per card, wherever it appears on the Want List, not per Deck.
4. **Trade Wants quantity** falls at Confirm swap and is deleted at zero. Refined by the owner on 2026-10-19: Trade Wants add to the Want List's need for the same Edition, received copies fill Deck needs first, and the line falls only by the rest; discovery shows the combined count with the Deck part, for example "6 wanted (2 for Decks)".
5. **Gifts** — answered by the owner on 2026-10-19: gifts are allowed. A proposal may have cards on one side and nothing on the other; only a proposal with no cards at all is refused.
6. **Counters and the cash-only rule:** a Counter is a proposal sent to its recipient, so their Open to cash offers setting applies, except when the countered proposal already had a cash-only side. A collector not Open to cash offers who sends a cash-only proposal can be countered with cash (the owner reversed the first default after the prototype, 2026-10-19).
7. **Out-of-date picks at Confirm swap** are refused and the collector uses suggested picks, as for Loans. Alternative: re-pick automatically at confirm.
8. **Take-back of a Confirm swap** is not allowed. Alternative: allow it before the other side confirms, which adds a step and an allowed-step entry.
9. **"Same name" across languages** uses Card Identity as defined, which may include Printings in other languages that the catalog links to the same identity.

### The Deck-line switch (owner, 2026-10-19)

The owner decided that a Deck line can be switched to a card Will accept takes, in two places, and that owned spares do not reduce the need until then.

1. **Copies just received:** Confirm swap offers each switch, ticked by default and untickable, per Deck oldest first, never more than the line still needs.
2. **Copies already owned:** the Want List's Swap hint also considers the cards the line's Will accept rule accepts.
3. **Matching:** until a switch is made, the collector's own spare copies of accepted cards reduce no need in discovery. This answers the independent review's F3 (a collector with a spare of an accepted card still appears to want the card the Deck lists); the Swap hint is how they make the spare count.

### Left to the prototype

- Where Trades are listed (a tab, or inside Loans).
- The destination picker's default for received copies.
- Wording of `PROMISED_TO_TRADE`, the Remove Friend and Block counts, and every error and count message.
- The liability notice's wording. It needs someone qualified to check it before launch, and is its own candidate ticket on the map.
- Whether and how the web offers an Undo of a Deck switch after Confirm swap. The Trade view carries no Deck.

### Risks and open items

- **Reservations never expire.** A half-confirmed Trade whose remaining side never confirms keeps that side's copies promised indefinitely. The only surface is the `confirm_swap` waiting line. This is an open item, not a decision: expiry is out of scope by the owner's choice, and the owner should know the consequence.
- **The `reserved_copies` redefinition is the riskiest change.** Every inventory figure reads it. The allocation refactor and the redefinition must land with figure-neutral tests.
- **Pick ids across two tables.** Sharing a sequence keeps ids unique. The reviewer should confirm no code assumes a pick id belongs to a Loan pick.
- **The Friend Want List read is the first cross-collector use of the allocation.** It must stay inside the choke point, lock-free and in one snapshot, and return only the Edition, the Want List need, the Trade Wants quantity and the rule.
- **Hidden Decks' wants.** The default is the privacy-safe one. Changing it exposes what hidden Decks lack.
- **Swap hint and Will accept.** The Swap hint is a Want List read that gains the Editions Will accept takes, so it is the one place Will accept touches a Want List figure's neighbour. It is figure-neutral with the exact card, and the existing Swap hint tests are the proof. No revision pin or Mass Entry conflict covers the hint (checked in Trading #275).
- **Deck switches need a shared batch writer.** Confirm swap cannot call the Deck List changes route, which takes the single-owner `FOR UPDATE` lock. Its write part is shared instead, which the figure-neutral tests of the existing batch must cover.
- **Switch details settled (delegated plumbing, 2026-10-19):** exact wants come first, so copies fill Deck lines of the received card, then its Trade Wants line, and only the rest can be switched; copies sent to a Deck are offered as switches for that Deck only; under counting one Deck at a time the total switched is at most the copies available for switching; the Will accept expansion moves to a module outside the social area; the cap is 50 chosen switches per step; the Swap hint applies to Will accept cards even when the line's Printing is in no Reprint Group; the implementation ticket checks whether any revision pin hashes the Swap hint (none does, Trading #275).
- **Liability and minors.** Cash is recorded only. Sales between strangers and to minors are Stage 2's decision.
- **Capacity target** is a design target; nothing in the repo states a Friend count.

### Deploy order

Migrations 140 to 144 keep an older API build working: it ignores Trade inbox rows and sees `reserved_copies` with no Trades. Deploy migrations first. The gateway's budgeted-route list must carry the value route in the same release as the API.

### Stages

The map's stages decision makes Stage 2 a separate, later spec. It reuses the same modules and rows, adds a second filter beside the friendship filter, a distance band and a card search, and must bring its own answers on what a non-Friend sees, how strangers arrange a handover and safety.

### Suggested ticket breakdown

1. The figure-neutral allocation refactor (split into rows, reader and pure function).
2. For trade Locations: migration 140, the setter and tree fields.
3. Trades tables, the promise redefinition, `reserving_picks`, `trade_listable` and the guard triggers (migrations 141 and 142), with the pick placement switch and its figure-neutral pick-order test.
4. Trade Wants and Will accept (migration 143), and Open to cash offers, with the Swap hint's Will accept suggestions.
5. Trade steps: send, Counter, Accept, decline, withdraw, cancel, and ending Trades with a friendship.
6. Confirm swap and use suggested picks, with the Deck switch candidates and the shared Deck List batch writer.
7. The choke point's Trade List and Friend wants reads, and the matches routes.
8. The value route, with the gateway list.
9. The inbox (migration 144).
10. The prototype: Trade List, discovery page, Trade screen and liability notice wording.
11. Web screens and the generated clients.
12. The browser story, capacity test and contract-guard changes.
