# Trading for PrizeCheck: Stage 2, open discovery, conversations and safety

**Status:** ready for tickets; not yet implemented. Drafted 2026-10-22 and revised to match the reviewed plumbing resolution. Collector-facing details approved by the owner on 2026-10-22 (the decisions and seven defaults on the map); the seven plumbing questions answered and all proposed copy approved on 2026-10-23 (see "The owner's answers (2026-10-23)" and "Approved copy"). Q1 differs from the recommendation: a suspended collector also cannot send Lend Offers.

This spec turns the map's [Stage 2 owner decisions](wayfinder/map.md#stage-2-owner-decisions--2026-10-22), the [Stage 2 plumbing resolution](wayfinder/resolutions/decide-stage-2-plumbing.md) and the [zip-centroid research](wayfinder/research/zip-centroid-data.md) into one implementation handoff. It builds on the [Stage 1 spec](spec.md), which is assumed built: Trade Lists, wants, matching among Friends, and Trades that transfer ownership. Stage 2 opens trading to collectors who are not Friends, found by distance from a zip code, and adds conversations, Block for strangers, Reports and an owner review queue. Terms follow [`CONTEXT.md`](../../../CONTEXT.md) with the additions proposed below. The map is the authority on what collectors see; the resolution is the authority on plumbing; this spec links to the resolution for code-level detail rather than repeating it. The cross-owner pattern extends [ADR 0014](../../adr/0014-friend-reads-and-two-owner-loans.md) and [ADR 0015](../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md), and the reach rule and trader ids are recorded in [ADR 0016](../../adr/0016-trading-beyond-friends-uses-one-reach-rule-and-trader-ids.md).

## Problem Statement

Stage 1 lets a collector trade only with Friends. A collector with a small circle, or whose Friends do not collect the same cards, finds nothing to trade, and the only way to reach a stranger who has the card they need is to leave the app. That goes wrong in familiar ways:

- A collector cannot ask "who near me has this card?", so they post in chat groups and wait.
- Two strangers who agree on a trade have no shared record of it. Cards, cash and what was handed over are argued from memory, and the copies are not promised, so one side offers the same card twice.
- Strangers have to swap contact details outside the app just to arrange a meeting, which also exposes more about each person than a trade needs.
- Nothing stops a collector who scams, never shows up or sends abuse from contacting the next person, and a collector has no way to cut off someone they have only just met.
- Real distance matters (cards change hands in person), but showing exact distances or zip codes would let anyone work out where another collector lives.

Opening trading to strangers is only acceptable if collectors can control who finds them, can leave a conversation for good, and can report a problem to a person who can act on it.

## Solution

Add **Open discovery**, **conversations** and **safety** on top of Stage 1, reusing its Trade Lists, wants, matching, Trades and Confirm swap unchanged.

**Open discovery.** One collector-wide switch, off by default, that needs a zip code. While it is on, the collector appears to other collectors who have it on and are within 50 miles, and can find them. Turning it off removes the collector from discovery at once. A collector who has it off cannot browse Near you or start contact with strangers either. Distance is shown only as a band (**Under 5 mi**, **5–10 mi**, **10–25 mi**, **25–50 mi**), never as miles, and a zip code is never shown to anyone but its owner. A radius choice of 5, 10, 25 or 50 mi (default 25), made on Near you, filters by band.

**Find trades.** The page keeps Stage 1's rows and gains a second section. **Friends** come first, as today. **Near you** follows, listing nearby collectors who are not Friends, sorted by match (two-way, then has-what-you-want, then wants-what-you-have), then by distance band, then by Display Name. A Friend appears only under Friends. While open discovery is off, a prompt to turn it on replaces Near you. A stranger's row shows Display Name, distance band, completed-trade count, an Open to cash offers badge, and only the matched cards and wants. It never shows a Handle, and discovery has no Friend Request button.

**Card search.** A collector searches by card name across Printings, optionally narrowing by set or Printing, and sees one row per holder with the Printings they list and the available counts: Friends first, then nearby collectors by distance band. Friends are answered even while the collector's own discovery is off. Each row leads to **Message** or **Propose trade**. Reverse search (who wants this card) is deferred.

**A stranger's Trade List.** From a discovery row, a card search result or a conversation, a collector can open the other's Trade List. It shows the full Trade List and the wants that match the viewer's own Trade List, exactly as a Friend's row does (owner's answer Q4, 2026-10-23: the map's "wants" means the matching wants). A distance band shows only while both collectors have discovery on. The rest of the Collection, Location names, promised copies and Borrowed Copies stay private under Stage 1's rules.

**Conversations.** Every pair of collectors, Friends included, has at most one **conversation**. A collector can message a stranger from a discovery row or a card before any proposal exists. Trade Proposals, Counters and Trades appear inside the conversation as cards. Messages are plain text up to 1,000 characters; links are not clickable; there are no photos, read receipts or typing indicators. A collector can archive a conversation (it returns when anything new arrives) and nobody can delete one. Meetups are arranged in the conversation. An accepted stranger Trade shows a short tip to meet in a public place, such as a local game store, and to check the cards before swapping. Notifications are in-app only.

**The Trades tab** becomes the conversation list: the other collector, the last message and the open proposals and Trades. Its badge counts unread conversations plus Trades waiting on the collector.

**Safety.**

- **Block** extends to strangers, from a conversation or a discovery row. Neither collector sees the other in discovery, the conversation becomes read-only, new messages and proposals are refused, open proposals close and unconfirmed Trades are cancelled. Trades either side confirmed stay open so the other can finish. The blocked collector is never told, and sees what a suspended collector's counterpart sees.
- **Report** is available from a conversation, a discovery row or a Trade, with a reason (scam or no-show, harassment, inappropriate content, other) and an optional note. A Report also Blocks, and it still works after the reported collector has blocked the reporter. The owner gets a review queue that keeps a snapshot of the whole conversation and the pair's Trades, even after either account is deleted, and can dismiss, remove the collector from open discovery, or suspend the account. Nothing happens to a reported collector automatically.
- **Track record.** Rows, Trade Lists and conversations show a completed-trade count: the Trades both sides confirmed, Friend Trades included. Zero reads **New to trading**. There are no ratings or reviews.
- **Add as Friend** is offered on a Trade only after both sides have confirmed it. Until it is accepted, neither side learns the other's Handle.
- **No age rule.** The owner chose not to add an age rule or age confirmation. Sales between strangers and to minors are therefore not restricted by the app. This is recorded for the liability-notice review (Risks and open items).

The design rests on a few rules, recorded in [ADR 0016](../../adr/0016-trading-beyond-friends-uses-one-reach-rule-and-trader-ids.md):

- **One reach rule.** Every cross-collector Trade read and every contact step asks one SQL function whether two collectors may trade or talk now: Friends, a pair with a conversation, or two open-discovery collectors within 50 mi; never across a Block or a suspension. Collection reads stay Friends-only.
- **Strangers are addressed by a random `trader_id`** and never receive a user id or a Handle. No route keyed by a user id or Handle ever answers a non-Friend's `trader_id`.
- **Distance leaves the database only as a band.** Nothing stores or ranks by exact distance, and candidate caps never rank by distance.
- **Freshness is polled** through one cheap read, not pushed.

## User Stories

### Open discovery and zip codes

1. As a collector, I want Open discovery to be one switch that is off by default, so that nobody can find me until I choose.
2. As a collector, I want to enter a zip code when I turn discovery on, and to be unable to turn it on without one, so that distance has something to measure from.
3. As a collector, I want to change my zip code in Settings, so that I can move or correct it.
4. As a collector, I want zip changes limited to three in any 24 hours, so that nobody can probe where others live by moving around.
5. As a collector, I want a refused fourth change to tell me when to come back without promising a calendar day ("You've changed your zip code 3 times in the last 24 hours. Try again in N hours.", or "Try again later." where the wait is unknown), so that the message is true however the window falls.
6. As a collector, I want my first zip not to count as a change, and entering the same zip again, or switching discovery on or off, not to count either, so that the limit only bites on moving.
7. As a collector, I want a zip code we cannot place refused with "We couldn't find that zip code. Try the zip code where you'd meet.", so that I am never silently invisible.
8. As a collector, I want turning discovery off to remove me from discovery immediately, so that I can step out at once.
9. As a collector, I want my zip to be remembered while discovery is off, so that switching back on is one tap and does not reset the change limit.
10. As a collector, I want to choose a radius of 5, 10, 25 or 50 mi on Near you, defaulting to 25, so that I can narrow who I see where I am looking.
11. As a collector, I want nobody beyond 50 mi to appear, whatever radius I choose, so that trading stays local.
12. As a collector, I want to be shown another collector's distance only as a band (Under 5 mi, 5–10 mi, 10–25 mi, 25–50 mi), so that nobody can work out where I live.
13. As a collector, I want my zip code, coordinates and exact distance never to be shown to anyone else, so that my location stays private.
14. As a collector with discovery off, I want to be unable to browse Near you or start a conversation with a stranger, so that being private does not leave me free to approach others. Card search still answers my Friends, because that needs no one else's discovery.
15. As a collector with discovery off, I want to see "Turn on open discovery to find collectors near you who want your cards or have cards you want." with a Turn on button in place of Near you, so that I know why it is empty.
16. As a collector, I want my existing conversations, proposals and Trades to carry on normally when I turn discovery off, so that a deal in progress is not broken.
17. As a collector, I want the screens for For trade Locations to say, while anyone beyond my Friends can reach my Trade List (discovery on, or a non-Friend I am in a conversation with), that collectors near me or in my conversations can trade for those cards, and a hidden For trade Location to say its cards are still offered to them, so that I know who can see what.
18. As a collector, I want Settings to show where the zip data comes from in the one credit line the data licence requires, so that the licence is honoured without cluttering trade screens.
19. As a collector whose discovery the owner has removed, or whose account is suspended, I want Settings to say so plainly and refuse the switch, so that I know why I am not in discovery.

### Find trades: Near you

20. As a collector, I want Find trades to show Friends first and Near you second, so that people I know come first.
21. As a collector, I want a Friend to appear only under Friends, never also under Near you, so that no one is listed twice.
22. As a collector, I want Near you sorted two-way matches first, then has-what-you-want, then wants-what-you-have, so that the best trades are on top.
23. As a collector, I want ties in Near you broken by distance band and then Display Name, so that closer collectors come first and the order is stable.
24. As a collector, I want the order inside a band never to rank collectors by exact distance, so that the order cannot reveal more than the band.
25. As a collector, I want each Near you row to show Display Name, distance band, completed-trade count and an Open to cash offers badge, so that I can judge who to approach.
26. As a collector, I want a stranger's row to show only the cards that match, up to 20 a side with a count of the rest, so that nothing beyond the match is exposed.
27. As a collector, I want rows to use the same wants wording and marks as Friends' rows ("N wanted (M for Decks)"), so that the page reads consistently.
28. As a collector, I want a stranger's row never to show a Handle or a Friend Request button, so that contact starts only through messages and Trades.
29. As a collector, I want Near you rows to offer Message, Trade List and Propose trade, with Block and Report behind a menu, so that I can act on a row without leaving it.
30. As a collector, I want a one-way match to read "You could sell" or "You could buy" only when that collector is Open to cash offers, so that the page never suggests a sale they have not opted into.
31. As a collector, I want the page to say when nobody near me matches, so that an empty list is explained.
32. As a collector in a dense area, I want the nearby candidates considered to be chosen without regard to distance, with each viewer getting an independent cut, so that who appears says nothing finer than the band. A viewer's cut is stable, so in a dense area they may never see a particular collector.

### Card search

33. As a collector, I want to search for a card by name across all its Printings, so that I find holders whichever Printing they list.
34. As a collector, I want to narrow a search to a set or one Printing, so that I can look for the exact card.
35. As a collector, I want one row per holder with the Printings they list and how many are available, so that I can compare holders quickly.
36. As a collector, I want Friends who have the card first, then nearby collectors sorted by distance band and then Display Name, so that the search mirrors Find trades.
37. As a collector, I want each result to lead to Message or Propose trade, so that I can act at once.
38. As a collector, I want a card search to list only cards that are on a Trade List now, not promised and not borrowed, so that I am never pointed at a card nobody can give.
39. As a collector, I want a card the catalog does not know to give an empty result, not an error, so that a stale link is harmless.
40. As a collector, I want to be unable to search for who wants a card, so that nobody's wants can be scanned across the area (deferred by the owner).

### A stranger's Trade List and header

41. As a collector, I want to open a stranger's Trade List from their row, a search result or our conversation, so that I can see what else they offer before I write.
42. As a collector, I want the page to show their Display Name, completed-trade count and, while both of us have discovery on, their distance band, so that I know who I am looking at without a band that is out of date.
43. As a collector, I want the page to show their full Trade List with search, so that I can add cards beyond the matches to a proposal.
44. As a collector, I want the wants shown on a stranger's page to be only those that match my own Trade List, so that their whole Want List is never exposed.
45. As a collector, I want a stranger's Trade List never to show Location names, Deck names, promised copies or Borrowed Copies, so that Stage 1's privacy rules hold for strangers too.
46. As a collector, I want wants from Decks in Hidden Locations to stay out of what strangers see, so that strangers cannot learn what a hidden Deck lacks.
47. As a collector, I want a Trade List of someone I cannot reach (blocked, suspended, unknown, out of range with no conversation) to answer "not found" in the same way every time, so that nobody can probe who exists.
48. As a collector who has removed a Friend but kept our conversation, I want to understand that we can still read each other's Trade List and matching wants through it, with no band, while neither Collection is open, so that I am not surprised by what remains.

### Conversations and messages

49. As a collector, I want one conversation per pair of collectors, including Friends, so that everything between us is in one place.
50. As a collector, I want to message a stranger from a discovery row or a card on their Trade List before any proposal exists, so that I can ask a question first.
51. As a collector, I want the message box to be prefilled when I tap Message on a card (for example "Is your <card> still available?"), so that I can send it as it stands or change it.
52. As a collector, I want messages to be plain text up to 1,000 characters, so that they stay simple.
53. As a collector, I want a message that is empty, or too long after tidying, refused with a clear message, so that nothing is sent by mistake.
54. As a collector, I want links in messages to appear as plain text and not be clickable, so that nobody can lure me off the app with a tap.
55. As a collector, I want no photos, read receipts or typing indicators, so that the chat reveals no more than the words.
56. As a collector, I want sending to be safe to repeat, so that a double tap never posts twice.
57. As a collector, I want to be limited to 120 messages an hour, with chat-appropriate wording saying how long to wait, so that nobody can flood a conversation.
58. As a collector, I want to start at most ten new conversations with strangers in any 24 hours, with a clear message when I hit it, so that nobody can message the whole area.
59. As a collector, I want a conversation with a Friend, and one with a collector I have a Trade with that both sides confirmed, not to count toward that limit, so that regular trading partners are never blocked. A Trade only one side confirmed does not qualify. An old closed Trade both sides confirmed also opens the conversation again without counting.
60. As a collector, I want an unread conversation to be marked unread until I open it, so that I can see what needs me.
61. As a collector, I want to archive a conversation so that it leaves my list until a new message, proposal or Counter arrives, so that I can tidy up without losing anything.
62. As a collector, I want nobody to be able to delete a conversation or a message, so that a record always exists if there is a problem.
63. As a collector, I want to open a conversation and see messages and Trade cards in time order, with older ones loading on request, so that I can follow the whole deal.
64. As a collector, I want a conversation to stay open after I turn discovery off, after either of us moves, or after we stop being Friends, until a Block, suspension or deletion closes it, so that arrangements are not cut off.
65. As a collector, I want new messages to appear within about 15 seconds while a conversation is open and within a minute otherwise, with nothing polling while the page is hidden, so that chat feels live.
66. As a collector who was a Friend in Stage 1 and whose only Trades are closed, I want no conversation created for us at launch, so that removing a Friend before launch still ends contact.

### Trades tab and badge

67. As a collector, I want the Trades tab to list my conversations, showing the other collector, the last message and the open proposals and Trades, so that one list covers talking and trading.
68. As a collector, I want conversations ordered by latest activity, with those waiting on me marked, so that the live ones come first.
69. As a collector, I want the Trades badge to count unread conversations plus Trades waiting on me, so that one number says how much needs me.
70. As a collector, I want the bell to count Loans and Trades waiting as before, so that the bell does not change meaning.
71. As a collector, I want old Trade links (`/trades/<id>`, Counter links, links by Handle) to keep working and to lead into the conversation or the proposal builder, so that nothing already shared breaks. A closed Trade whose pair has no conversation stays readable on its own page.

### Proposals to strangers

72. As a collector, I want to send a Trade Proposal to a stranger who is near me or in a conversation with me, from the conversation, a row or a card, so that I can trade without becoming Friends.
73. As a collector, I want the proposal builder, Counters, cash, value totals and Confirm swap to work for a stranger exactly as for a Friend, so that I learn one flow.
74. As a collector, I want sending a proposal to a stranger to open our conversation if none exists, so that the proposal has somewhere to live.
75. As a collector, I want each proposal, Counter and Trade to appear as a card in the conversation showing its current state, so that I see how the deal stands.
76. As a collector, I want a proposal or Counter to bring an archived conversation back, so that I never miss an answer.
77. As a collector, I want the one Open to cash offers setting to cover Friends and strangers alike, so that I do not manage two settings.
78. As a collector, I want a proposal to someone I can no longer reach refused with "This collector is no longer available", whatever the cause, so that a Block is never revealed.
79. As a collector, I want to Counter and accept a stranger's proposal after either of us turns discovery off, so that a deal in progress can finish.
80. As a collector, I want an accepted stranger Trade to show the tip "Meet somewhere public, like a local game store, and check the cards before you swap.", so that I am reminded how to stay safe.
81. As a collector, I want the tip shown on stranger Trades only, so that it is not noise between people who know each other.
82. As a collector, I want to arrange where and when to meet by chat, with no separate meetup step, so that the flow stays light.
83. As a collector, I want a proposal addressed by a user id (as old Friend links do) to work only for a Friend, so that looking up a Handle can never lead me to a stranger's discovery identity.

### Track record and Add as Friend

84. As a collector, I want a completed-trade count on rows, Trade Lists and conversations, so that I can tell an experienced trader from a new one.
85. As a collector, I want the count to include only Trades both sides confirmed, Friend Trades included, so that it reflects swaps that happened.
86. As a collector, I want a Trade closed because one side's account was deleted, with one confirmation, not to count, so that the count cannot be inflated; a both-confirmed Trade still counts for the remaining side.
87. As a collector, I want a count of zero to read "New to trading", so that a newcomer is not shown as a number.
88. As a collector, I want no ratings, stars or reviews, so that nobody can be mass-reviewed or retaliated against.
89. As a collector, I want Add as Friend offered on a Trade only after both sides confirmed it, so that I can keep trading with someone I trusted.
90. As a collector, I want Add as Friend never to show me the other's Handle or user id before they accept, so that offering it reveals nothing.
91. As a collector who receives an Add as Friend request, I want to see it in my Friend requests with the sender's Handle and accept it there or on the Trade, so that it works like any request.
92. As a collector, I want to withdraw my Add as Friend request, so that I can change my mind.
93. As a collector, I want Add as Friend refused, in the same words as for any unreachable collector, when we are Blocked, suspended or deleted, so that it cannot be used to get around a Block or reveal one.

### Block

94. As a collector, I want to Block any collector I can see, from a conversation or a discovery row, so that I can cut contact the moment I need to.
95. As a collector, I want to Block or Unblock any collector who exists, even one I could no longer reach, so that I can always act on a trader I have met.
96. As a collector, I want neither of us to see the other in discovery, search or Trade Lists after a Block, so that the Block is complete.
97. As a collector, I want the conversation to become read-only for both of us, so that nothing more can be written.
98. As a collector, I want messages and proposals between us refused after a Block, and open proposals closed, so that no promise outlives it.
99. As a collector, I want unconfirmed Trades cancelled by a Block, and Trades either side confirmed kept open so the remaining side can finish, so that nobody is left owed cards.
100. As the blocked collector, I want the conversation to read "This collector is no longer available", exactly as for a suspended collector, so that a Block is never revealed to me.
101. As the blocker, I want the conversation to say I blocked them, with a way to unblock, so that I know where I stand.
102. As a collector, I want to Unblock from my Blocked list in Settings, so that a mistake is reversible, and I want unblocking to reopen the conversation.
103. As a collector, I want a Block never to notify the other collector beyond the reason-free cancellation Stage 1 already sends, so that blocking stays private.
104. As a collector, I want the Blocked list to show a Handle only where I already knew it, and to be unable to learn one by blocking, so that blocking cannot be used to look a Handle up.

### Report and the owner queue

105. As a collector, I want to Report a collector from a conversation, a discovery row or a Trade, so that I can raise a problem where it happens.
106. As a collector, I want to choose a reason (Scam or no-show, Harassment, Inappropriate content, Other) and add an optional note of up to 1,000 characters, so that the owner knows what happened.
107. As a collector, I want a Report to Block the reported collector at once, so that I am protected while the owner looks.
108. As a collector, I want to Report someone who has already blocked me, or who is suspended, and to get the same answer as for anyone else, so that the Report button works in every conversation and reveals nothing.
109. As a collector, I want the reported collector never to be told, so that reporting is safe.
110. As the owner, I want a queue of open Reports with a count in the owner navigation, so that I see what needs me.
111. As the owner, I want each Report to show the reporter, the reported collector, the reason and note, and a snapshot of the whole conversation and the pair's Trades as they were at the Report, so that I can judge without asking for evidence.
112. As the owner, I want the screen to show only the snapshot, never the live conversation, so that what I judge is what the reporter saw.
113. As the owner, I want the snapshot to survive the deletion of either account, so that a collector cannot delete their way out of a Report.
114. As the owner, I want to see the reported collector's earlier Reports and moderation actions, so that I can spot a pattern.
115. As the owner, I want to dismiss a Report, remove the collector from open discovery, or suspend the account, so that I can respond in proportion.
116. As the owner, I want a record of every decision, kept even after deletion, so that there is an audit trail.
117. As the owner, I want to restore a collector to discovery or lift a suspension, and to be told plainly when there is nothing to restore, so that a mistake is reversible.
118. As the owner, I want Reports to cause no automatic penalty beyond the reporter's Block, so that Reports cannot be used as a weapon.
119. As a collector removed from open discovery, I want to switch it on again myself only after the owner restores me, so that removal means something.

### Suspension and deletion

120. As a suspended collector, I want to be refused when I message, propose, Counter, accept, switch discovery on, or send a Friend Request (by Handle, Invite Link or Add as Friend), a Borrow Request or a Lend Offer, so that a suspension stops contact everywhere.
121. As a suspended collector, I want to keep signing in and using my own Collection, Decks and Want List, and to carry my existing Loans through handover and return (owner's answer Q1), so that a suspension does not hold my data hostage.
122. As a collector, I want a suspended or deleted collector to leave discovery at once and their conversation to become read-only with "This collector is no longer available", so that I am not left writing to nobody.
123. As a collector, I want unconfirmed Trades with a suspended collector cancelled, with the reason-free cancellation sent to me, and confirmed ones kept open so I can finish, following the Block rule, so that I am not left owed cards.
124. As the owner, I want a suspension to apply in one step, so that it cannot be left half done.
125. As a suspended collector, I want Settings and the Trades tab to say my account can't trade or message right now, so that I understand what I am seeing.
126. As a collector, I want my conversations, messages and Trade history to remain for the other side after I delete my account, with my Display Name kept, so that their record stays readable.

### Privacy

127. As a collector, I want no stranger-facing response to contain a user id, Handle, zip code, coordinate or distance in miles, so that nothing identifies or locates me.
128. As a collector, I want an unknown collector and an unreachable collector to look identical to anyone who asks, so that nobody can probe who exists or who has blocked them.
129. As a collector, I want a Block to look to the other side like a suspension, byte for byte apart from names, so that the cause cannot be inferred.
130. As a collector, I want looking someone up by Handle or Invite Link never to reveal their discovery identity, so that a Handle cannot be tied to a row and a band.
131. As a collector, I want nothing in the app to show when another collector was last seen, or when data was fetched or refreshed, so that the interface stays about cards.

### Owner and Developers

132. As the owner, I want the zip data credit, the no-age-rule choice, strangers' sales and free-text messages recorded for the liability-notice review before launch, so that the legal check covers what Stage 2 introduces.
133. As a developer, I want one SQL function to define "may trade or talk now", used by every cross-collector Trade read and every contact step, so that rules cannot drift.
134. As a developer, I want contract tests that confine the reach function, the zip tables and the message tables to their modules, so that guarded reads cannot spread.
135. As a developer, I want every stranger-facing route addressed by `trader_id`, with a schema check naming which models may carry a user id and which a `trader_id`, so that the privacy rule is mechanical.
136. As a developer, I want the zip dataset loaded by a migration generated by a committed script with pinned hashes, so that deploys need no extra step.
137. As a developer, I want a distance function that returns only a band, so that nothing downstream can leak finer distance.
138. As a developer, I want the lock order extended to conversations, including the triggers that rename a collector in them, and covered by concurrency tests, so that opposite-direction steps cannot deadlock or double-spend a daily limit.
139. As a developer, I want deploying migrations before the API to be safe, and an older API build to keep working, so that deploys have no ordering trap.
140. As a developer, I want the new error codes to be stable and documented, so that the web and tests can rely on them.
141. As a developer, I want the generated web clients checked in CI, so that API and web cannot drift.

## Implementation Decisions

### Terms used in this spec

Terms follow [`CONTEXT.md`](../../../CONTEXT.md) as amended by Stage 1: **Trade**, **Trade Proposal**, **Counter**, **Trade List**, **Display Name**, **Handle**, **Block**, **Friend**, **Friend Request**, **Open to cash offers**, **Hidden Location**, **For trade Location**, **Confirm swap**. In this spec "Location" always means a storage Location; a collector's place in the world is called their **zip** or **area**.

Proposed new terms (for the spec writer to add to `CONTEXT.md` after owner agreement; this spec does not edit it):

- **Conversation**: the one thread between two collectors, Friends or not, holding their messages and, as cards, their Trade Proposals, Counters and Trades. Created by the first message or proposal. It can be archived and never deleted. _Avoid_: chat, inbox thread, DM.
- **Message**: one plain-text note in a Conversation, up to 1,000 characters. _Avoid_: DM, post.
- **Open discovery**: a collector's switch, off by default and needing a zip, that lets collectors within 50 mi who also have it on find each other. _Avoid_: public profile, nearby mode.
- **Near you**: the Find trades section listing nearby collectors who are not Friends. _Avoid_: Nearby, strangers.
- **Distance band**: one of Under 5 mi, 5–10 mi, 10–25 mi or 25–50 mi, the only form in which distance is ever shown. _Avoid_: distance, miles away.
- **Report**: a collector's account of a problem with another collector, which also Blocks them and goes to the owner's queue. _Avoid_: flag, complaint.
- **Suspension**: the owner's action that removes a collector from open discovery and stops them messaging, proposing, countering, accepting, and sending Friend Requests, Borrow Requests or Lend Offers. Their own Collection, Decks and existing Loans continue. _Avoid_: ban.
- **Completed trade**: a Trade both sides have confirmed. _Avoid_: deal, sale.

Amendments the glossary needs:

- **Trade** and **Trade Proposal** become "between two collectors" rather than two Friends.
- **Open to cash offers** becomes "anyone who can send them a proposal".
- **Block** extends to strangers and to Reports, and gains read-only conversations. Its _Avoid_ line currently lists "report"; with Report now a defined term that line must change.
- **Display Name** and **Friend** say Friends see a Display Name; Stage 2 lets nearby collectors with discovery on see it too.

### Changes to Stage 1

These behaviours of the built Stage 1 change. Each needs a named test update.

1. **`NOT_FRIENDS` becomes `COLLECTOR_UNAVAILABLE` for Trades.** Trade send, Counter and Accept check reach, not friendship, and refuse with 409 `COLLECTOR_UNAVAILABLE`. An unknown `trader_id` gets the same answer. `NOT_FRIENDS` stays for Loans only. Stage 1 tests that assert `NOT_FRIENDS` on Trades are updated. The accept-after-unfriend test needs a pair with no conversation (the backfill guarantees this for ex-Friends with no open Trade) or a Block.
2. **Removing a Friend no longer stops an accept** while the pair has a conversation (owner's answer Q2). Remove Friend still cancels unconfirmed Trades. Ex-Friends keep reading each other's Trade List and matching wants through the conversation, with no band; their Collections stay closed. Only Block, suspension or deletion stops contact.
3. **The backfill is narrow.** Migration 147 creates a conversation only for a pair with a Trade who are Friends at deploy time or still have a Trade `proposed` or `accepted`. Stage 1 ex-Friends with only closed Trades get none and do not regain reach. Their closed Trades keep no conversation, stay readable at `/trades/<id>` and through the inbox, and attach if the pair ever opens one.
4. **The Trades tab becomes the conversation list.** `/trades` no longer lists Trades; the Trade and Counter pages stay and link to the conversation. The Trades badge becomes Trades waiting plus unread conversations. The bell is unchanged.
5. **Send locks both owners.** Stage 1's send locked only the sender. Stage 2 locks sender and recipient in `user_id` order. This briefly holds off the recipient's inventory commands, as a Counter already does.
6. **The meaning of a null `collector_id` changes.** In Stage 1, `TradeParty.collector_id` null meant a deleted account. In Stage 2 it also means "not a Friend". `collector_id` and `handle` are set only while the two are Friends. The web must use `trader_id` and `available` instead (`CounterPage.tsx:58-62`, `TradeScreen.tsx:563`; grep the web before merging).
7. **Sends take `recipient_trader_id`.** `recipient_id` becomes optional; exactly one is required, else 422 `RECIPIENT_REQUIRED`. A send by `recipient_id` (a user id) is accepted only when the other is a Friend, else 409 `COLLECTOR_UNAVAILABLE`. The web always sends `trader_id`. `/trades/new/<Handle>` stays for Friends' old links, resolves through `FriendTradeList` (which gains `trader_id`) and redirects to `/trades/new/<trader_id>`.
8. **Friends' rows gain `trader_id` and `completed_trades`**, and `FriendTradeList` shows `completed_trades`. A suspended Friend drops out of Friends' Find trades, because the choke point now filters Friends through the reach rule too.
9. **Freshness is now polled.** Stage 1's inbox said nothing polls. Stage 2 adds a pulse read polled by the web.
10. **Block gains rows with an id and a source.** Each Block has a `block_id` and a `via` (`collector` or `trader`). The Blocked list answers `BlockedCollector` and unblocks by `block_id`; the old `POST /blocks` and `/blocks/{collector_id}/unblock` stay. This closes an existing leak: blocking an Invite Link holder by the id the link page returned revealed their Handle.
11. **`GET /friends` leaves Add-as-Friend requests out of the requester's `sent` list**, so requesting never reveals a Handle.
12. **Suspension reaches Loans' neighbours.** Borrow Request sends, Lend Offer sends and Friend Requests (Handle, Invite Link, Add as Friend) refuse a suspended actor with 403 `ACCOUNT_SUSPENDED`. Existing Loans continue to handover and return.
13. **Stage 1 stories superseded:**

    | Stage 1 story | What changes |
    | --- | --- |
    | 50 | A non-Friend Handle still answers as unknown on Friend routes. |
    | 67 | Sending only to Friends: now anyone in reach (a Friend, a conversation, or nearby). |
    | 105 | "Stage 1 limited to Friends" no longer holds. |
    | 118 | Accept checks reach (Friend, conversation or nearby), not friendship. |
    | 194 | Non-Friends in reach see the Trade List and matching wants. Blocked collectors, either way, still see nothing. |

14. **Hidden For trade Locations** keep their Stage 1 behaviour; only the screen wording changes (below).
15. **Account deletion requirements** grow (see Account deletion).

### Module boundary

Stage 1 promised non-Friend reads would add "a second filter beside `friends_of`, not a new module". Stage 2 keeps that. The detail is in the [resolution](wayfinder/resolutions/decide-stage-2-plumbing.md#module-boundary); in short:

- **`friend_copies`** (extended): the Trade List and wants statements filter through the one SQL function `trade_reach`. The Collection read stays Friends-only.
- **`discovery`** (new, `/api/social/discovery`): the collector's own settings, the zip-change limit, and every call to `trade_reach` and `nearby_collectors` outside the choke point. The only module that names the zip tables and `open_discovery`.
- **`conversations`** (new): conversation list, timeline, messages, read, archive and the pulse.
- **`trade_matches`** (extended): Near you, card search and the trader reads.
- **`friends`** (extended): Block and Unblock by `trader_id` and `block_id`, Add as Friend, and the Friend command generalised so Report can answer its own result.
- **`trades`** (extended): the party fields, `completed_trades` and the inline Trade views.
- **`reports`** (new): Reports, snapshots, the owner queue, removal and suspension, the audit trail. It never writes discovery tables; it calls `discovery` helpers.
- **`trade_inventory`** (changed): send, Counter and accept check reach in place of friendship.
- **`loans`** (two lines): Borrow Request sends and Lend Offer sends refuse a suspended actor.

### The reach rule

`trade_reach(viewer, others)` (migration 148) is the one definition of "may trade or talk with now". It has three branches: **friend** (a Friend), **conversation** (a conversation row exists for the pair) and **near** (both collectors in open discovery and within 50 mi). It never applies across a Block either way, to a suspended viewer or other, to oneself, or to a deleted other. Its `band` is set only when neither is a Friend and both are in open discovery (Q6). The SQL, the choke-point changes and the Python wrappers `reach_one` and `reach` are in the [resolution](wayfinder/resolutions/decide-stage-2-plumbing.md#the-reach-rule-the-second-filter). Switching discovery off, moving, or going out of range removes the `near` branch only, so existing conversations keep working.

### Identity: trader ids, Handles and user ids

The rule: **no stranger-facing response carries a user id or a Handle, and no route that takes a user id or a Handle ever answers a non-Friend's `trader_id`.** Otherwise anyone who knows a Handle could tie it to a discovery row and its band.

- `collector_profile.trader_id` is a random, stable, unique uuid (migration 145), never shown. Stranger-facing routes address collectors only by it. An unknown and an unreachable `trader_id` answer byte-identically wherever reach decides.
- **Which models carry which id** (the OpenAPI walk asserts this):

  | Id | Carried by | Never by |
  | --- | --- | --- |
  | `trader_id` | `NearbyMatchRow`, `CardHolder`, `TraderView`, `TraderTradeList`, `ConversationParty`, `TradeParty`; the Friend-only `TradeMatchRow` and `FriendTradeList`; `BlockedCollector`, only for Blocks placed through a trader route | `Collector`, `CollectorLookup`, `InviteCollector`, `FriendsView`, Loan views |
  | user id (`collector_id`) | Friend-only models: `Collector`, `CollectorLookup`, `InviteCollector`, `FriendsView`, `TradeMatchRow`, `FriendTradeList`, `TradeCardOffer`, Loan views; `TradeParty` only while Friends | `NearbyMatchRow`, `CardHolder`, `TraderView`, `TraderTradeList`, `ConversationParty`, `BlockedCollector` |
  | `conversation_id` | `TraderView`, `ConversationView`, `ConversationSummary` | |
  | `block_id` | `BlockedCollector` | |
  | report ids | owner routes only | |

- `TradeParty` becomes `{collector_id|None, handle|None, trader_id|None, display_name, open_to_cash_offers, friend, available, completed_trades|None}`. `collector_id` and `handle` are set only for Friends; `trader_id` is None once the account is deleted; `available` means reach holds; `completed_trades` is None when not available.
- **Block rows** (migration 148) gain `id`, `via` (`collector` default, `trader` set by the trader routes and Report) and `handle_shown` (default false; the migration sets existing rows true so today's Blocked lists are unchanged). Every Block path sets `handle_shown` true only when, at the Block, the two were Friends, or the blocker had received a pending Friend Request from the other, or had sent one that is not an Add-as-Friend request.
- **Blocked list.** `GET /api/social/blocks` answers `BlockedCollector {block_id, display_name, handle|None, trader_id|None}`: `handle` only when `handle_shown`, `trader_id` only when `via = 'trader'`, no user id. Unblock from Settings is `POST /api/social/blocked/{block_id}/unblock`; an unknown or someone else's `block_id` is 404 `BLOCK_NOT_FOUND`.

### Zip codes and distance

- **Data.** Census 2026 ZCTA Gazetteer first, then GeoNames `US.zip` for 5-digit codes the Census file lacks (GeoNames accuracy-1 rows dropped). Loaded by migration 146, generated by a committed script that downloads both files, checks pinned sha256 values and writes batched upserts (about 1.3 MB; the header records URLs, date, hashes and row counts). Yearly refresh is a new migration.
- **Tables.** `zip_centroid(zip, lat, lon, source)` (146). `discovery_setting` per collector (145) holds `enabled`, the zip, a copied-in centroid, `radius_mi` (5, 10, 25, 50; default 25) and `removed_at`; enabled needs a zip and centroid, and enabled and removed cannot both hold. The `open_discovery` view (also 145) is enabled, not removed, not suspended.
- **Bands.** `distance_band` (145) computes a haversine and answers 1 (under 5 mi), 2 (under 10), 3 (under 25), 4 (50 or less) or NULL. The API exposes `band: 'under_5' | '5_to_10' | '10_to_25' | '25_to_50'`, worded in the web as "Under 5 mi", "5–10 mi", "10–25 mi" and "25–50 mi". **No response ever carries miles, a zip (other than the collector's own in their settings), a latitude or a longitude.**
- **Radius** filters by band: 5 mi shows Under 5 mi; 10 adds 5–10; 25 adds 10–25; 50 adds 25–50. It is chosen on Near you, not in Settings, and stored with the discovery setting.
- **Order inside Near you** is band, then Display Name (case ignored), then `trader_id`. The server never ranks by exact distance (Q5).
- **`nearby_collectors`** (148) prefilters by bounding box, then by band, excludes the viewer, Friends, Blocks and anyone outside open discovery, and returns nothing when the viewer is not in open discovery. Before the row cap it orders by band, then a per-viewer hash of the viewer and the candidate's `trader_id`, so the cap never ranks by distance and each viewer gets an independent cut. A viewer's cut is stable, so in a dense area they may never see a given collector. Known gap: collectors across the antimeridian (the Aleutians) do not see each other.
- **Anti-trilateration.** The research says band edges are not a control. The controls are: only collectors with discovery on can query; the probe point is the viewer's own zip centroid, not a free coordinate; zip changes are limited; output is bands only; and the target is itself a centroid, so the most a patient attacker learns is a zip, never an address.
- **Zip-change limit.** A write that changes a stored zip to a different zip counts. Setting a zip when none is stored does not; nor do same-value writes or switching on or off. The fourth counted change in a rolling 24 hours is 429 `ZIP_CHANGE_LIMIT` with `retry_after_minutes`. Because the window rolls, the approved sentence "You can change your zip code again tomorrow." would sometimes be untrue; the owner approved replacement copy (Approved copy).

### Open discovery switch

- `GET /api/social/discovery` returns `{status: off|on|removed|suspended, zip, radius_mi, zip_changes_left, visible_beyond_friends}`. This is the one place a zip leaves the API, and only to its owner. `visible_beyond_friends` is true when `status` is `on`, or when a non-Friend in a conversation can read the collector's Trade List now. The web keys the For trade Location wording on it.
- `PUT /api/social/discovery {enabled, zip, radius_mi}` is idempotent by value. Checks in order: switching on while removed or suspended is 409 `DISCOVERY_UNAVAILABLE`; a malformed zip is 422 `INVALID_ZIP` (5 digits, optional `-4` dropped); a zip not in the data is 422 `UNKNOWN_ZIP` (Q3); a counted change is 429 `ZIP_CHANGE_LIMIT`; enabling with no zip is 422 `ZIP_REQUIRED`.
- **Reciprocity.** The `near` branch needs both collectors on. A viewer who is off gets `status: 'off'` and an empty `near` list from Near you and card search; card search's `friends` list is still answered. Off also stops new stranger conversations.
- **Owner removal** sets `removed_at` and `enabled = false`; suspension switches discovery off through the same module. Restoring clears `removed_at` only; the collector switches on again themselves.

### Find trades: Near you and card search

- The Friends section is `GET /api/social/trade-matches`, unchanged apart from `trader_id` and `completed_trades` on rows.
- `GET /api/social/trade-matches/near` returns `{status, radius_mi, rows}`. Each `NearbyMatchRow` carries `trader_id`, `display_name`, `band`, `completed_trades`, `open_to_cash_offers`, the match kind, up to 20 cards a side and the `more_*` counts, and no Handle or user id. Candidates come from `nearby` (cap 500) and are read in the same read-only repeatable-read transaction as the Friends' copies. Rows sort by match kind, band, Display Name and `trader_id`; at most 100 rows. It is a separate route so the Friends section's latency is unchanged.
- `GET /api/social/traders/{trader_id}/matches` is the full row for one trader; 404 `COLLECTOR_NOT_FOUND` unless reach holds.
- `GET /api/social/trade-card-search?printing_id=&scope=name|set|printing` returns `{status, friends, near}` holders. Scope `name` takes every Edition of every Printing sharing the picked Printing's Card Identity; `set` takes the picked Printing's set; `printing` takes that Printing. An unknown `printing_id` is 200 with empty lists. `friends` is answered whatever the discovery status; `near` covers up to 1,000 candidates. Each list holds at most 50 holders and 20 cards each; `near` is sorted by band then Display Name.

### A stranger's Trade List and trader header

- `GET /api/social/traders/{trader_id}` returns `{trader_id, display_name, friend, band|None, completed_trades|None, open_to_cash_offers, status: open|unavailable|you_blocked, conversation_id|None, add_friend: offer|sent|received|None}`. It answers when reach holds or the pair share a conversation, else 404. `unavailable` (the other is suspended or has blocked the viewer) carries nulls and `open_to_cash_offers` false, so the causes are byte-identical. A deleted collector has no `trader_id`; the remaining side reaches them only through the conversation.
- `GET /api/social/traders/{trader_id}/trade-list?q=&page=` returns the other's Trade List through `friend_trade_copies(..., among='reach')`, with the wants that match the viewer's own Trade List (Q4). It needs reach, else 404. `band` is null unless both have discovery on (Q6).
- Excluded, as in Stage 1: the rest of the Collection, Location names, promised copies, Borrowed Copies and wants from Decks in Hidden Locations.
- The proposal builder and Counter page are keyed by `trader_id` and read `/traders/{id}/trade-list` and `/traders/{id}/matches`.

### Conversations and messages

The schema (migration 147) is in the [resolution](wayfinder/resolutions/decide-stage-2-plumbing.md#conversations-and-messages): `conversation` (one row per unordered pair, ids ON DELETE SET NULL with names kept), `conversation_member` (read and archive markers), `message` (with `from_low` rather than a sender key, unique per `(conversation, side, client_key)`), and `trade.conversation_id`.

- **Triggers.** A `BEFORE INSERT` trigger on `trade` gives a Trade inserted without a conversation the pair's conversation and both member rows, so an older API build still works. An `AFTER INSERT OR UPDATE OF revision` trigger records activity, so a rename's name-only update never locks a conversation through `trade`. Names follow `collector_profile` through `trade_names_follow_profile_conversations`; PostgreSQL fires same-event triggers in name order, and this name sorts after the Trade one, so a rename locks `trade` rows before `conversation` rows, the same order as every Trade step. A name sorting earlier could deadlock against an accept; a test reads the order from `pg_trigger`.
- **Backfill.** See Changes to Stage 1, item 3. Both member rows are inserted, and every Trade of a covered pair gets its `conversation_id`.
- **Opening and counting.** `open_conversation` finds or creates the pair's row, both member rows and the pair's earlier unattached Trades. When it creates the row it counts a `new_conversation` (10 per rolling 24 hours, else 429 `TOO_MANY_NEW_CONVERSATIONS` with `retry_after_minutes`), unless the other is a Friend or the pair has a Trade that both sides confirmed ("traded with before"; a Trade with one confirmation does not qualify). The caller takes the advisory lock before the owner locks, so a message and a proposal racing cannot both pass at nine. A refused step rolls back its count.
- **Sending.** `POST /api/social/traders/{trader_id}/messages` and `POST /api/social/conversations/{id}/messages` take `{body, idempotency_key}` and answer 201 `Message`. A replay answers the stored message. Over 120 an hour is 429 `MESSAGE_RATE_LIMITED` with `retry_after_minutes`.
- **Text rules** (`normalize_text`, shared with the Report note), in order: line endings to LF; Unicode NFC; drop control characters except LF and TAB, and the bidi override and isolate controls; trim; empty is 422 `EMPTY_MESSAGE`; over 1,000 code points is 422 `MESSAGE_TOO_LONG`. The web renders text with no link detection.
- **Timeline.** `GET /api/social/conversations/{id}?before=` returns `{id, other, status, can_message, can_propose, can_report, items, next_before}`. Items are messages and Trade rows (one card per round, at the row's creation time, showing current state), newest first, 50 a page, with an opaque cursor; a malformed cursor is 422 `INVALID_CURSOR`. `status` is `open`, `you_blocked`, or `unavailable` (the other blocked the viewer, is suspended or is deleted; the three are byte-identical apart from names and ids). `can_message` and `can_propose` mean `status == 'open'` and the viewer is not suspended; `can_report` is true unless the other is deleted, so Report stays available in the read-only states. A non-member or unknown id is 404 `CONVERSATION_NOT_FOUND`.
- **List, read, archive.** `GET /api/social/conversations?archived=&before=` returns summaries ordered by latest activity, 50 a page. An archived conversation is visible again when its last activity is newer than the archive time (a message from either side, a proposal or a Counter). Unread means the other side's last message is newer than the collector's read marker. `POST .../read` (a malformed cursor is `INVALID_CURSOR`), `.../archive` and `.../unarchive`. Nobody can delete a conversation or a message.
- **Freshness.** No realtime path: the gateway proxies buffered requests and the deployment provider is deferred ([ADR 0002](../../adr/0002-defer-deployment-provider-selection.md)). `GET /api/social/conversations/pulse` returns `{unread_conversations, watermark}` from two indexed statements. The web polls it every 15 s while a conversation is open and the page is visible, every 60 s while visible otherwise, never while hidden, and at once on focus. A changed watermark re-reads the inbox, the conversation list and the open conversation's newest page.

### Proposals to strangers

Send runs, in order: begin the command; refuse a suspended sender (403 `ACCOUNT_SUSPENDED`); resolve the recipient (an unknown `trader_id`, or a `recipient_id` that is not a Friend, is 409 `COLLECTOR_UNAVAILABLE`); take the new-conversation advisory lock; lock both owners; check reach (409 `COLLECTOR_UNAVAILABLE`), and for a send by `recipient_id` re-check, after the locks, that the two are still Friends; open the conversation (which may count, 429); run Stage 1's checks (`CASH_ONLY_NOT_OPEN`, `NOT_TRADEABLE`, now through `among='reach'`); insert with the conversation id.

- **Counter** checks reach in place of friendship and already locks both sides.
- **Accept** refuses a suspended actor, then checks reach, locking the recipient only as in Stage 1. A suspension of the proposer locks every counterparty of the proposer's unconfirmed Trades, so the two serialise.
- **Decline, withdraw, cancel and Confirm swap** need no reach check. Confirm swap after a Block, suspension or deletion still works.
- **Open to cash offers** applies to everyone; `CASH_ONLY_NOT_OPEN` and the Counter exception are unchanged.
- **The meetup tip** shows on an accepted Trade whose other party is not a Friend. It is web-only copy.

### Block extended

`POST /api/social/traders/{trader_id}/block` and `/unblock {idempotency_key}` run the existing Block command and effects with `via = 'trader'` and `handle_shown`. **Any existing `trader_id`** can be blocked or unblocked, whatever the reach; only an unknown one is 404 `COLLECTOR_NOT_FOUND`. An Unblock with no Block changes nothing and answers the current relation. **The user-id and trader unblock routes each lift only Blocks of their own kind:** `POST /blocks/{collector_id}/unblock` lifts `via = 'collector'` Blocks and the trader route lifts `via = 'trader'` Blocks; asked about the other kind, each answers as if no Block existed. The `block_id` route lifts either kind, because it is the only way to undo a Block whose Handle is not shown, and its opaque id links nothing. The Stage 1 effects apply: unconfirmed Loans and Trades are cancelled with a reason-free `cancelled` update, the friendship is deleted and the `block` row inserted; Trades either side confirmed stay open and confirmable. Derived results need no new writes: both sides leave each other's discovery, search and trader reads; the conversation is `you_blocked` for the blocker and `unavailable` for the blocked side; messages and proposals are refused with `COLLECTOR_UNAVAILABLE`. Nothing is stored for the blocked side beyond Stage 1's cancel update. Unblocking reopens the conversation.

### Reports and the owner review queue

Tables (migration 149): `trade_report`, `trade_report_message`, `trade_report_trade` and the append-only `moderation_event`, none with foreign keys to users that would block deletion (report parties are `ON DELETE SET NULL` with names and Handles kept; owner screens are exempt from the UI copy rule). Field-level detail is in the [resolution](wayfinder/resolutions/decide-stage-2-plumbing.md#reports-and-the-owner-review-queue).

- **Snapshot, not retention.** The Report copies the whole conversation and every Trade of the pair into report-owned rows, as they stand at that moment. A later Unblock's messages or later Trade steps are not added. The copies reference no user or message rows, so they outlive either account. **The owner screen shows the snapshot only**, never the live conversation.
- **Collector route.** `POST /api/social/reports {trader_id, reason, note?, source, trade_id?, idempotency_key}` answers 201 `{reported: true}`.
  1. **Before the Friend command**, the route settles the allowance. An unknown `trader_id` is 404 `COLLECTOR_NOT_FOUND`. Otherwise the Report is allowed when reach holds, or the two share a conversation, or (source `trade`) the `trade_id` is a Trade between them. A `trade_id` that is not theirs is 404 `TRADE_NOT_FOUND`; none of these is 404 `COLLECTOR_NOT_FOUND`. A conversation or Trade never disappears, so the allowance cannot be lost before the command.
  2. **Then** one Friend command (both owners locked, the `friend_command` count, replay by key) whose action Blocks (`via = 'trader'`, `handle_shown`), inserts the report and copies the snapshot. The command generalises to return its own result instead of a relation.
  3. **The answer is the same whatever the state.** Reporting a collector who already blocked the reporter, who is suspended, or who is open gives the same 201 body, and Report stays offered in the read-only conversation states.
  4. The reported collector is never told.
- **Owner routes** (`require_owner`): list and count; detail with the snapshot and the reported collector's other reports and events; `POST .../decision {action: dismiss | remove_from_discovery | suspend, note?}` (404 `REPORT_NOT_FOUND`, 409 `REPORT_DECIDED`, 409 `REPORTED_ACCOUNT_GONE` for the two actions on a deleted account); and `POST /api/admin/collectors/{user_id}/restore {what: discovery | suspension, note?}` (404 `COLLECTOR_NOT_FOUND`, 409 `NOTHING_TO_RESTORE` when the collector is not removed or not suspended). Every decision and restore writes a `moderation_event`.
- **Suspension** is one transaction. It reads the account's counterparties, locks them with the account in one ascending call, re-reads and retries (at most 3, else 503 `INVENTORY_TEMPORARILY_UNAVAILABLE`) if a new one appeared, then sets the flag, switches discovery off and cancels unconfirmed Trades with each counterparty, **the suspended account being the actor**, so the reason-free `cancelled` update goes to each counterparty. A Trade one side confirmed stays open. A suspended actor gets 403 `ACCOUNT_SUSPENDED` from every contact step, from switching discovery on, from Friend Requests by Handle, Invite Link or Add as Friend, and from Borrow Request and Lend Offer sends. Existing Loans continue to handover and return; friendships, Collections, sign-in and their own reads are untouched (owner's answer Q1).
- **Removal** is the discovery helper plus the event, in one transaction.

### Add as Friend

`POST /api/social/trades/{trade_id}/add-friend {idempotency_key}` and `.../add-friend/withdraw`. **Before the Friend command:** 403 `ACCOUNT_SUSPENDED` for a suspended actor; 404 `TRADE_NOT_FOUND` for a non-party; 409 `TRADE_NOT_SWAPPED` unless both swap times are set; 409 `COLLECTOR_UNAVAILABLE` unless reach holds (deleted, blocked either way and suspended alike). The command re-checks reach under its locks. If a request from the other is pending it is accepted; otherwise a pending friendship is inserted marked as from a Trade, under the normal Friend Request rules (a decline cool-off gives `TRY_LATER`). `GET /friends` leaves such requests out of the requester's `sent`, so the requester follows it through `TraderView.add_friend = 'sent'` and never receives the other's user id or Handle before acceptance. The recipient sees it in `received` with the requester's Handle (the requester's own consent).

### Completed-trade count

A Trade counts for each party when both swap times are set, Friend Trades included. A Trade closed as `swapped` because the other account was deleted, with one confirmation, does not count; a both-confirmed Trade still counts for the remaining side. The count is one `UNION ALL` over two partial indexes (migration 147), with no counter column. It is exposed as `completed_trades` on `TradeMatchRow`, `NearbyMatchRow`, `CardHolder`, `TraderView`, `TraderTradeList`, `FriendTradeList`, `ConversationParty` and `TradeParty`, and is null where the party is unavailable. The web words zero as "New to trading" and one as "1 completed trade".

### Account deletion

Deletion is not built. Stage 2 makes it possible without building it: `conversation` user columns are `SET NULL` with names kept, so the remaining side reads "This collector is no longer available"; `conversation_member`, `discovery_setting` and `block` cascade; command-limit rows (`handle_lookup_event`) already cascade and need no step; messages have no user key; report and audit rows have no user foreign keys. Add to the deletion requirements: cancel unconfirmed Trades (Stage 1); keep the conversation and messages for the remaining side; never delete `trade_report*` or `moderation_event` rows.

### Hidden For trade Locations

There is no API change beyond `visible_beyond_friends`. Stranger reads go through the listable rule, which already lists hidden For trade Locations. The wording keys on `visible_beyond_friends` in two places (`web/src/workspace/LocationSettings.tsx`, the For trade and hidden lines; `web/src/settings/ForTradeLocationsSection.tsx`); while it is false, Stage 1's copy stays. The copy is under Approved copy.

### Locks and concurrency

The lock order extends Stage 1: advisory command locks (the step's own, then `new_conversation`), `inventory_owner` rows ascending, `loan`, `trade`, then `conversation` rows; every trigger respects it. Messages in an existing conversation lock the sender; anything that may open a conversation, and sends, Block, Report and Add as Friend, lock both; discovery changes and owner removal lock the collector alone. A Display Name change locks its own owner row, the profile, then `loan` and `trade` names, then `conversation` names. A message racing the recipient's suspension may land just after it; this is accepted because the conversation is read-only from then on. The full table is in the [resolution](wayfinder/resolutions/decide-stage-2-plumbing.md#locks-and-concurrency).

### Error codes

New: `COLLECTOR_UNAVAILABLE` (409; any contact step outside reach, including an unknown `trader_id` or a send by a non-Friend `recipient_id`), `BLOCK_NOT_FOUND` (404), `ACCOUNT_SUSPENDED` (403; any contact step, discovery on, Friend Request, Borrow Request, or a Lend Offer from a suspended collector), `RECIPIENT_REQUIRED` (422), `INVALID_ZIP`, `UNKNOWN_ZIP`, `ZIP_REQUIRED` (422), `ZIP_CHANGE_LIMIT` (429, `retry_after_minutes`), `DISCOVERY_UNAVAILABLE` (409), `EMPTY_MESSAGE` and `MESSAGE_TOO_LONG` (422), `MESSAGE_RATE_LIMITED` (429, `retry_after_minutes`), `TOO_MANY_NEW_CONVERSATIONS` (429, `retry_after_minutes`), `CONVERSATION_NOT_FOUND` (404), `INVALID_CURSOR` (422), `TRADE_NOT_SWAPPED` (409), `REPORT_NOT_FOUND` (404), `REPORT_DECIDED` and `REPORTED_ACCOUNT_GONE` (409), `NOTHING_TO_RESTORE` (409). `COLLECTOR_NOT_FOUND` (404, existing): trader reads and Report, unknown or unreachable, byte-identical; trader Block and Unblock and owner restore, unknown only. Reused: `INVENTORY_TEMPORARILY_UNAVAILABLE` (503: a deadlock, or suspension's retries exhausted), `TRADE_NOT_FOUND`, `OWN_ACCOUNT`, `TRY_LATER`, `TOO_MANY_CHANGES` (Friend and Trade commands, unchanged). `NOT_FRIENDS` stays for Loans only.

### Web

- **Routes.** `/trades` is the conversation list. New lazy pages: `/trades/with/<trader_id>` (a conversation, with an empty composer before the first message), `/trades/trader/<trader_id>` (a stranger's Trade List), and `/trades/new/<trader_id>` (the proposal builder; a Handle resolves and redirects). `/trades/<id>` and `/counter` are kept and link to the conversation.
- **Find trades:** Friends, then Near you with the radius choice or the prompt while discovery is off, and card search (Friends first). Rows show the band and the track record, with Message, Trade List and Propose trade, and Block and Report behind a menu.
- **Conversation:** the header holds the name, band, track record, a link to their Trade List, and Block and Report behind a menu (Report stays in the read-only states); Trade cards appear inline; read-only states read "This collector is no longer available" and "You blocked <name>." (linking to Settings). Add as Friend shows on a Trade with both confirmations.
- **Trade screen:** Report behind a menu; the meetup tip on accepted stranger Trades.
- **Settings:** an Open discovery section with the switch, zip, changes left, the removed and suspended states and the credit line (the radius is not here); the Blocked section lists `BlockedCollector` entries with Unblock by `block_id`.
- **Shell:** a pulse hook; the Trades badge sums waiting Trades and unread conversations.
- **Owner:** a Trade reports section in the owner queue, in the style of the missing-cards queue, showing the snapshot only.
- **UI copy (AGENTS.md).** Collectors never see another collector's zip, coordinates, miles or Handle. They never see a data-source name, except the one legally required credit in Settings, Open discovery: "Zip code locations include data from GeoNames (geonames.org), CC BY 4.0." No "last seen", polling, refresh or fetch times (message send times are content and may show). Owner report screens are exempt. All wording is under Approved copy.
- **Generated clients.** The new `/api/social` components join the social client generator; `/api/trades` changes regenerate the trades client.

### Migrations

Trading migrations 145 to 149; 150 to 179 stay spare. All are re-runnable under the [migrations note](migrations.md), which gains these rows.

| File | Contents |
| --- | --- |
| `145_open_discovery.sql` | `trader_id`, `suspended_at`, `discovery_setting` and its index, the `open_discovery` view, `distance_band`, the command-kind check widened (`zip_change`, `new_conversation`, `message`) |
| `146_zip_centroids.sql` | `zip_centroid` and its generated data |
| `147_conversations.sql` | conversation tables, the names trigger, `trade.conversation_id` with its two triggers, the narrow backfill, completed-trade indexes |
| `148_trade_reach.sql` | `trade_reach`, `nearby_collectors`, `block.id`, `via` and `handle_shown` (existing rows set true), the Add-as-Friend marker on friendships |
| `149_trade_reports.sql` | report, snapshot and moderation tables |

Not purely additive: 145 widens a CHECK; 147 adds triggers to `trade` and `collector_profile` and backfills; 148 sets existing Block rows. An older API build keeps working: it never reads the new columns, the trigger gives its Trades a conversation and both member rows, a Block it inserts gets `handle_shown = false` (conservative), and nothing it calls changed signature. Deploy migrations first.

## Testing Decisions

Good tests check external behaviour only, as in Stage 1: what a signed request returns, what a collector sees, what the database refuses. The seams are the same: signed HTTP against real PostgreSQL, the same API run concurrently, and Playwright with collector contexts. A `discoverable(user, zip)` helper seeds a few fixed `zip_centroid` rows and switches discovery on; tests never depend on the full dataset.

1. **Zip and distance (`test_open_discovery.py`).** Band boundaries at 0, 4.99, 5, 9.99, 10, 24.99, 25, 50 and 50.01 mi; the bounding box never drops a collector the exact distance keeps, at latitudes 25° and 65°; the `PUT` refusals in order; `test_a_first_zip_is_not_a_change`; `test_a_fourth_zip_change_in_24_hours_is_refused` (three changes, then 429 with `retry_after_minutes`, and the same zip again not counted); switching off keeps the zip; the radius filters by band.
2. **Reach and privacy (`test_trade_reach.py`, `test_stranger_privacy.py`).**
   - Each branch and exclusion of the reach rule (Block either way, suspension of either side, one side off, beyond 50 mi); the conversation branch surviving switch-off and a move; Friends never in Near you.
   - `test_no_stranger_response_carries_a_zip_coordinate_distance_handle_or_user_id` walks the JSON of every stranger-facing route (the other side's `/discovery`, `near`, card search, `/traders/*`, `/conversations*`, a stranger `TradeView`, the inbox, the pulse, and `GET /blocks` and `GET /friends`). It fails on the stranger's zip, user id or Handle, a coordinate to two decimals, or any key named miles, distance, lat, lon or zip outside the viewer's own settings.
   - `test_a_handle_lookup_never_leads_to_a_trader_id`: look up B by Handle, block B by user id, and the Blocked list shows no `trader_id`; look up again and send by `recipient_id`, and get 409 `COLLECTOR_UNAVAILABLE` with nothing created; send Add as Friend, then block, and no Handle shows.
   - `test_unknown_and_unreachable_trader_ids_answer_byte_identical_404s` for the trader header, Trade List, matches and Report.
   - `test_a_block_reads_like_a_suspension_to_the_blocked_side`: `TraderView` and `ConversationView` byte-identical apart from names and ids.
   - `test_no_band_while_either_side_has_discovery_off`, on the trader header, the Trade List and the conversation.
   - `test_in_band_order_is_by_name_and_the_cap_is_per_viewer`: two viewers in one band with three candidates and a cap of two can get different subsets, and the visible order is by name.
   - The OpenAPI walk asserts the table in Identity: `NearbyMatchRow`, `CardHolder`, `TraderView`, `TraderTradeList`, `ConversationParty` and `BlockedCollector` declare no `collector_id`; `Collector`, `CollectorLookup`, `InviteCollector` and `FriendsView` declare no `trader_id`.
3. **Contract guards.** The reach call, zip tables (including `open_discovery`) and message tables appear only in their allowed modules; the Trade List and wants statements name the reach function and the Collection read does not; `trade_inventory` no longer imports the Friend id helper; `reports.py` names no discovery table; `ALLOWED_IMPORTS` entries for the new modules; the names triggers on `collector_profile` fire in the order `loan`, `trade`, `trade_names_follow_profile_conversations` (read from `pg_trigger`).
4. **Find trades (`test_trade_matches.py`).** Near you order (kind, band, name); the caps (100 rows, 20 cards a side, 50 holders and 20 cards in card search); card search scopes `name`, `set` and `printing`, with `friends` before `near`; with discovery off, `status: 'off'`, an empty `near` and `friends` still answered; an unknown `printing_id` answers empty; the old `/trades/new/<Handle>` resolves through `FriendTradeList.trader_id`; a closed Trade whose pair has no conversation still opens at `/trades/<id>`; each unblock route lifts only Blocks of its own `via`; a send by `recipient_id` is refused if the friendship ended between resolution and the locks.
5. **Conversations (`test_conversations.py`).** One per pair whoever starts; Friends uncounted; `test_the_eleventh_new_stranger_conversation_in_a_day_is_refused`; a pair with a both-confirmed Trade but no conversation (ex-Friends) opens one uncounted and its earlier Trades attach; the backfill covers Friends-now and open-Trade pairs only; the `BEFORE INSERT` trigger creates both member rows for a Trade inserted without a conversation; every `normalize_text` rule; replay by key; `MESSAGE_RATE_LIMITED` at 121 messages in an hour; the timeline mixes rounds and messages across pages, and `INVALID_CURSOR` on a bad cursor; unread, read and archive (a new message or proposal unarchives); the read-only states, with `can_report`; the pulse moves on a message, a Trade step and an inbox update, and not on a rename.
6. **Strangers' Trades (extend `test_trades.py`).** Send, Counter and accept between nearby strangers with caps on the stranger's list; the `COLLECTOR_UNAVAILABLE` cases; switch-off mid-deal still allows Counter and accept; `CASH_ONLY_NOT_OPEN` for strangers; the Stage 1 `NOT_FRIENDS` Trade tests updated as described.
7. **Block, Report, suspension (`test_stranger_blocks.py`, `test_trade_reports.py`).**
   - Block: the Block rule on stranger Trades; any existing `trader_id` can be blocked and unblocked and an unknown one is 404; `handle_shown` and `via` in every case, including Invite Link and an Add-as-Friend request; Unblock by `block_id`, and `BLOCK_NOT_FOUND` for someone else's.
   - Report: `test_report_after_being_blocked_matches_report_of_suspended` (byte-identical 201s); a Report blocks and snapshots, the snapshot is unchanged by later messages after an Unblock and survives `DELETE FROM inventory_owner` of either side; `test_the_reported_collector_is_never_told` (their inbox, pulse, `TraderView` and conversation unchanged apart from the Block's effects); the owner detail answers the snapshot only.
   - Owner routes: 403 for non-owners; each decision writes an event; restore of discovery and suspension, with `NOTHING_TO_RESTORE`.
   - Suspension: its cancellations have the suspended account as the actor and the updates go to the counterparties; a send committed between suspension's read and its locks makes it retry; `test_a_suspended_collector_keeps_their_own_data` (Collection, Decks, Want List and existing Loan steps answer; Friend Requests by Handle, Invite Link and Add as Friend, Borrow Requests and Lend Offers are 403 `ACCOUNT_SUSPENDED`).
8. **Concurrency (real PostgreSQL, opposite directions).** Block against message and against stranger send; switch-off against first-contact send and first message; suspension against send, accept and Confirm swap; simultaneous first messages A to B and B to A (one conversation); two first contacts at a count of nine (one refused); `test_a_rename_racing_an_accept_does_not_deadlock`; a rename against a message. None deadlocks.
9. **Capacity (`slow`, `capacity:`, `serial`).** The Stage 1 200-Friend target (p95 1.5 s) still holds with the reach rule in the Trade List statement; Near you with 500 candidates, 200 of them with matching Deck Lists, at p95 of at most 2.0 s; card search over 1,000 nearby candidates with 2,000 listable Editions each at p95 of at most 1.0 s. These are design targets to confirm.
10. **Add as Friend and the count.** Refused before both confirmations; `COLLECTOR_UNAVAILABLE` when the other has blocked the requester, byte-identical to a suspended other; never in the requester's `sent`; both tapping makes Friends; `completed_trades` counts both-confirmed Trades, Friend Trades included, and still counts after the other account is deleted, while a `swapped` close after a deletion with one confirmation does not.
11. **Browser (`trade-strangers-story.spec.ts`).** A and B, strangers 3 mi apart, switch discovery on; B sees A under Near you with "Under 5 mi" and "New to trading", opens A's Trade List and messages A; A's Trades badge counts it after focus and A replies; B proposes; A accepts and sees the meetup tip; both confirm and see "1 completed trade" and Add as Friend; B adds A and A accepts in the Friends drawer. Second story: C, whom A has blocked, reports A from the read-only conversation; the owner suspends A from the queue, seeing only the snapshot; B's conversation with A reads "This collector is no longer available"; A still opens their Collection. Also phone width, accessibility checks, and that no page text on B's or C's screens contains A's zip or Handle.

## Out of Scope

- **Email notifications.** Notifications are in-app only. An email nudge (for example for an unread message after a delay) is a later option, not part of the approved scope.
- Reverse card search (who wants a card).
- An age rule, age confirmation, or any restriction on sales between strangers or to minors (the owner's decision; see Risks).
- Photos, attachments, clickable links, read receipts, typing indicators and voice in messages.
- Deleting a conversation or a message.
- Ratings, stars, reviews and any public profile; a Handle is never shown to a stranger.
- A structured meetup step, map, or venue list. Meetups are arranged in chat.
- Automatic penalties for Reports, automated content moderation and appeals.
- Sign-in lockout for suspended accounts (the owner chose to keep sign-in, Q1).
- Keeping a Block's discovery effect for 24 hours after an Unblock (considered to slow the Block-and-diff probe; see Risks).
- A Discord or other external messaging requirement.
- Processing, holding or verifying payments; shipping and mail trades; the other Stage 1 exclusions.
- Realtime push (WebSockets, server-sent events) and PostGIS.
- The account deletion feature itself (only its requirements grow).

## Further Notes

### Sources

- [Trading decision map](wayfinder/map.md), section "Stage 2 owner decisions — 2026-10-22", the authority on collector-facing behaviour.
- [Stage 2 plumbing resolution](wayfinder/resolutions/decide-stage-2-plumbing.md) (revised 2026-10-22 after an independent review), the authority on plumbing; it extends the [Stage 1 plumbing resolution](wayfinder/resolutions/decide-trading-plumbing.md).
- [Zip-centroid research](wayfinder/research/zip-centroid-data.md).
- The [Stage 1 spec](spec.md), [ADR 0014](../../adr/0014-friend-reads-and-two-owner-loans.md), [ADR 0015](../../adr/0015-trades-share-the-promise-invariant-and-friend-reads.md) and the [migrations note](migrations.md).
- [`CONTEXT.md`](../../../CONTEXT.md).

### The owner's answers (2026-10-22)

The owner decided: Open discovery as one switch needing a zip, off by default; no age rule; strangers see Display Name, band, matched cards and wants but never the Handle, and Add as Friend only after both confirm; Find trades with Friends then Near you; bands and radius choices; card search by name; conversations for every pair; plain-text messages up to 1,000 characters; the Trades tab as the conversation list; meetups in chat with a public-place tip; in-app notifications only; one Open to cash offers setting; Block extended to strangers; Reports with an owner queue and snapshot; and a completed-trade count with no ratings. The owner also approved seven defaults together:

1. **Zip changes:** at most three a day, the fourth refused with a quoted message (the plumbing proposes new wording, see below).
2. **Hidden For trade Locations** remain on the Trade List for strangers, and the Location screen says so while discovery is on.
3. **Message presence:** no read receipts or typing indicators.
4. **Archive:** a collector can archive a conversation until a new message arrives; nobody can delete one.
5. **Spam limit:** ten new stranger conversations a day; a pair who traded before does not count.
6. **Suspended or deleted collectors** leave discovery at once; their conversations become read-only with "This collector is no longer available"; confirmed Trades stay open.
7. **Completed-trade count** includes Friend Trades.

### The owner's answers (2026-10-23)

The owner answered the plumbing resolution's six questions, and the spec's seventh (card search order), on 2026-10-23. Only Q1 differs from the recommendation.

1. **Suspension.** A suspended collector can still sign in and use their own Collection, Decks and Want List; their existing Loans continue to handover and return; their Friends can still see their Collection. Everywhere, Friends included, they leave open discovery and cannot message, send Trade Proposals, Counter or accept, send Friend Requests (by Handle, Invite Link or Add as Friend), send Borrow Requests, or send Lend Offers. *Why:* suspension is an app-level flag; sign-in lockout would need the auth gateway and an answer on data export.
2. **Remove Friend and the conversation.** The conversation stays open, so ex-Friends can still message and propose; only Block stops contact; Remove Friend still cancels unconfirmed Trades. Ex-Friends keep reading each other's Trade List and matching wants through the conversation, with no distance band; their Collections stay closed. Stage 1 ex-Friends do not regain this, because the backfill covers only Friends-now and open-Trade pairs. *Why:* making reach depend on how a conversation began would be fragile.
3. **Unrecognised zip codes.** Refuse, with "We couldn't find that zip code. Try the zip code where you'd meet." *Why:* a collector placed nowhere would be silently invisible.
4. **A stranger's wants.** A stranger's Trade List page shows their full Trade List plus only the wants that match the viewer's Trade List, as a Friend's row does. This settles the map: its "wants" means the matching wants. *Why:* Friends do not see a whole Want List either, and it would be the costliest read in the app.
5. **In-band order.** Inside a band the order is by Display Name, not exact distance. *Why:* an exact order would leak finer distance than the band.
6. **Band on a stranger's Trade List.** The band shows only while both collectors have discovery on; otherwise none shows. *Why:* it is the only time both sides have a known position.
7. **Card search order.** Friends who have the card first, then Near you, mirroring Find trades. *Why:* the same order everywhere on the page.

### Approved copy (owner, 2026-10-23)

The owner approved all of the copy below on 2026-10-23, including a replacement for the sentence approved on 2026-10-22 for the zip-change limit ("You can change your zip code again tomorrow."), which a rolling window makes untrue. The stories and screens use these strings exactly.

| Where | Approved copy |
| --- | --- |
| `ZIP_CHANGE_LIMIT` | "You've changed your zip code 3 times in the last 24 hours. Try again in N hours." (N from `retry_after_minutes`; where unavailable, "Try again later.") |
| `UNKNOWN_ZIP` | "We couldn't find that zip code. Try the zip code where you'd meet." |
| `MESSAGE_RATE_LIMITED` | "You're sending messages quickly. Try again in a few minutes." |
| `TOO_MANY_NEW_CONVERSATIONS` | "You've started 10 new conversations in the last 24 hours. Try again in N hours." |
| Near you while discovery is off | "Turn on open discovery to find collectors near you who want your cards or have cards you want." with a **Turn on** button |
| Accepted stranger Trade tip | "Meet somewhere public, like a local game store, and check the cards before you swap." |
| Conversation, other side blocked, suspended or deleted | "This collector is no longer available" |
| Conversation, blocker's side | "You blocked <name>." linking to Settings |
| Report reasons | Scam or no-show / Harassment / Inappropriate content / Other |
| Track record | "New to trading" / "1 completed trade" / "N completed trades" |
| Discovery removed by the owner | "Open discovery isn't available for your account." |
| Suspended (Trades tab and Settings) | "Your account can't trade or message right now." |
| For trade Locations while `visible_beyond_friends` (Settings) | "Friends, and collectors near you or in your conversations, can trade for the cards in these Locations and everything inside them." |
| A hidden For trade Location while `visible_beyond_friends` (Location settings) | "<path> is hidden from Friends, but its cards are still on your Trade List for Friends and for collectors near you or in your conversations." |
| Credit (Settings, Open discovery; legally required) | "Zip code locations include data from GeoNames (geonames.org), CC BY 4.0." |

### Risks and open items

- **No age rule and strangers' messages.** The owner chose no age rule or age confirmation. Sales between strangers, including to minors, are therefore not restricted by the app, and free-text messages between strangers are unmoderated until reported. **Flag for the liability-notice review before launch**, together with the need for a message content policy, which is not plumbing. The Stage 1 liability notice's placement was written for Friend Trades; whoever checks its wording should confirm it is enough for strangers.
- **Block-then-diff oracle (residual, accepted).** Someone who knows a Handle can look the collector up, block them by user id, and watch which Near you row disappears, which links the Handle to a band. The gain is small (the lookup already shows the Display Name), it needs the prober's own discovery on within 50 mi, and it is bounded by the 120-per-hour Friend command limit. The probe has other doors: after a trader-route Block, a Handle lookup, an Invite Link or a Friend Request by user id answers relation `blocked` for that Handle, at a limit of 30 an hour, which also links a Handle to a band. That is the same outcome already accepted. Keeping a Block's discovery effect for 24 hours after an Unblock was considered and not adopted. Record it for the privacy review.
- **Location inference.** One patient account learns at most a target's zip over days of moves; many accounts multiply that. Signup caps and the opt-in limit it. Record it for the privacy review.
- **The zip data migration** is about 1.3 MB and immutable once applied. Pin the source hashes. The Census licence wording is unconfirmed (research, Unresolved); confirm before launch. Large rural zips widen band error.
- **Near you candidate cap (500, per viewer).** In a dense area some matching collectors in a band are not shown. Revisit with real numbers.
- **Reach replaces `friends_of` in Stage 1's measured statements.** Re-run the 200-Friend capacity test. If it fails, keep `friends_of` for Friends and add only the suspension join.
- **Sends now lock the recipient's owner row**, with the same cost as a Counter today.
- **Command replays** answer the response stored when the command first ran. A stranger's stored response never held a Handle or user id.
- **Polling load** grows with open tabs. The pulse can later answer 304 on an unchanged watermark.
- **Stage 1 meaning change:** a null `TradeParty.collector_id` no longer means deleted. Grep the web before merging ticket 3.
- **Capacity numbers and the antimeridian gap** are design targets and known limits.
- **Glossary** changes are listed under Terms used in this spec; `CONTEXT.md` is not edited here.

### Deploy order

Migrations 145 to 149 keep an older API build working (see Migrations). Deploy migrations first. The generated clients and the guard changes ship with the API. **`GET /blocks` changes shape** (`BlockedCollector`), so the API and the web ship in the same release.

### Suggested ticket breakdown

Tickets follow the resolution's vertical slices; each lists what blocks it.

1. **Open discovery settings and zip data** (migrations 145, 146): the build script, the Settings section and the credit line. Blocked by nothing.
2. **Conversations** (147): Friends-only messaging, the conversation list, inline Trades, read and archive, pulse polling, the badge, and the completed-trade count. Blocked by 1 (`trader_id`).
3. **The reach rule and stranger Trades** (148): reach in the choke point, trader reads and the Trade List page, steps on reach, `TradeParty`, builder and Counter keyed by `trader_id`, guards and the privacy sweep. Blocked by 1 and 2.
4. **Near you and card search**, with the capacity tests and the For trade Location wording. Blocked by 3.
5. **Messaging strangers:** first contact, the spam limit, Message from rows and cards, the meetup tip. Blocked by 3.
6. **Block for strangers:** trader and block-id routes, `via`, `handle_shown`, the Blocked list, read-only states. Blocked by 3.
7. **Reports, owner queue, removal and suspension** (149), including the suspended-actor checks in Friend Requests, Borrow Requests and Lend Offers. Blocked by 6.
8. **Add as Friend.** Blocked by 3.
9. **Story specs, quiet full gate and burn-in.** Blocked by all.

Tickets 4, 5, 6 and 8 can run in parallel once 3 lands. A separate ticket, not on this chain, covers the liability-notice review of the no-age-rule choice, and should finish before launch.
