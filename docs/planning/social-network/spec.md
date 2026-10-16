# Social network for PrizeCheck: Friends and Loans

**Status:** published 2026-10-15, not yet implemented.

This spec turns the resolutions, prototype verdicts and research of the [social network decision map](wayfinder/map.md) into one implementation handoff for Friends, Loans (Borrow Requests and Lend Offers) and finding which Friends have the cards a collector needs. Details that no source settled are listed under "Details settled at publication" in Further Notes, and the questions that remain open are listed after them. Terms follow [`CONTEXT.md`](../../../CONTEXT.md).

## Problem Statement

A collector who needs a card for a Deck has one option today: buy it. PrizeCheck's Want List says exactly which Card Editions they are missing, but it cannot tell them that someone they know already owns a spare copy. Real collectors lend cards to each other all the time, and they keep track of it in their heads or in chat messages. That goes wrong in familiar ways:

- The lender forgets which copies are out, promises the same copy twice, or sells a card that is on loan.
- The borrower cannot show a Deck as built while a borrowed card sits in it, and the Want List keeps telling them to buy a card they are holding.
- Neither side has a shared record of what was handed over, what has come back and what is overdue.
- A collector has no way to find out which of their friends has the card they need without asking each one.

The product also has no concept of another collector. Accounts are an email address or an OAuth identity, with no name of any kind, so there is nothing to add, find or block. Every read and write in the API is scoped to one collector under that collector's lock, with no row-level security behind the filters. Showing a Friend's cards would be the first read of another collector's inventory, and a Loan changes two collectors' figures at once.

## Solution

Add Friends and Loans as a new `social` area of the API and the web app, on top of the existing Collection, Decks, Want List and Undo.

**Friends.** Friendship is mutual: a Friend Request must be accepted, and either side can end it at any time. A collector finds another through an Invite Link shared outside the app, or by typing their exact Handle. Every account gets a random, unguessable Handle and a Display Name, both changeable. A Block ends any friendship and stops the blocked collector finding them or sending requests.

**What Friends see.** Friends see each other's Collection, but only the copies the collector could lend now, with no Location or Deck names. A collector can hide any Location, and hiding covers everything inside it.

**Finding cards.** There is no new "wanted" concept. The Want List shows a row of Friend chips on each line a Friend can cover, and a Buy / Get from Friends switch whose second view has one panel per needed card. The catalog card popup and a Friend's Collection also offer **Ask to borrow**. Each ask adds to a draft Borrow Request for that Friend.

**Loans.** A Borrow Request or Lend Offer covers one or more Card Edition lines from one Friend and can name the borrower's Deck. The steps are requested or offered, accepted, handed over and returned. Copies are reserved the moment the lender says yes, so they cannot be promised twice. Each side's confirmation changes only that side's inventory. Lent copies leave the lender's Locations at handover and come back on return, and the lender still owns them. The borrower's Borrowed Copies live in their own table, act like owned copies inside Decks and are never part of the borrower's Collection. A lender can write off a Loan that is not coming back, and the borrower then chooses to keep or remove the copies.

**Where it lives.** A Loans tab, a bell drawer for the inbox and a Friends drawer in the header, and a Privacy section in Settings ([the Friends, inbox and Loan screens verdict](wayfinder/resolutions/prototype-friends-loans.md)).

The design rests on a few rules:

- **One choke point for Friend reads.** `friend_copies` is the only code that reads another collector's inventory. It returns per-Edition spare and in-Deck counts and nothing else.
- **One Spare Copy rule.** The rule written out in five places becomes one function before any Loan code lands.
- **Lent and reserved copies stay out of `holding`.** Loan lines and picks sit in their own tables, and Borrowed Copies sit in `borrowed_holding`. Existing single-owner reads stay correct unless they opt in.
- **A fixed lock order.** Steps that touch two collectors lock `inventory_owner` rows in ascending `user_id`, then the `loan` row. Most steps touch one owner.
- **A database invariant.** The copies promised to open Loans never exceed what the lender owns, enforced by a deferred constraint trigger.
- **Privacy that cannot be probed.** Handle lookup is rate limited and gives one identical answer for an unknown Handle and for someone who has Blocked you. The inbox never reveals an unfriend or a Block.

## User Stories

### Friends and finding collectors

1. As a collector, I want to find another collector by typing their exact Handle, so that I can send them a Friend Request without knowing their email address.
2. As a collector, I want Handle lookup to be exact-match only, so that nobody can browse or search for collectors.
3. As a collector, I want a Friend Request to start a friendship only when the other collector accepts, so that nobody can become my Friend without my say.
4. As a collector receiving a Friend Request, I want to see the sender's Display Name and Handle before I accept, so that I know who is asking.
5. As a collector, I want to withdraw a Friend Request I sent, so that I can take it back.
6. As a collector, I want to remove a Friend at any time, so that I decide who I share with.
7. As a collector, I want a lookup result to tell me when we are already Friends or a request is pending, so that I do not send a duplicate.
8. As a collector, I want a lookup miss to say "No collector has that Handle.", so that I know to check the spelling.
9. As a collector, I want a Handle lookup to give the same answer for an unknown Handle and for someone who has Blocked me, so that nobody can tell they were Blocked.
10. As a collector, I want lookups limited to 30 per hour with a message saying how long to wait, so that nobody can scan for Handles. Friend commands are limited too, to 120 per hour (see Rate limit).
11. As a collector, I want a Friends drawer in the header, opened by a button beside the bell, with a badge for incoming Friend Requests, so that I can manage Friends from anywhere.
12. As a collector, I want the Friends drawer to show incoming requests first with Accept and Decline, then my Friends, then my outgoing requests with Withdraw, so that what needs me comes first.
13. As a collector, I want an Add button in the drawer that opens a short Handle search and a Copy link button for my Invite Link, so that I can find people either way.
14. As a collector, I want each Friend's overflow menu to hold Remove Friend and Block, and each received Friend Request's overflow menu to hold Block, so that destructive actions are not one tap away.

### Handles, Display Names and Invite Links

15. As a collector, I want every account, including existing ones, to have a random Handle and a neutral placeholder Display Name from the start, so that nobody is findable until I choose to share my Handle.
16. As a collector, I want my Handle to be 3 to 20 letters, digits or underscores, so that it is easy to type and share.
17. As a collector, I want Handle lookup to ignore case while my Handle is shown in the case I typed, so that "Ash_K" and "ash_k" find the same person.
18. As a collector, I want my Handle to be unique across all collectors, so that a lookup finds one person.
19. As a collector, I want reserved words and offensive words refused in Handles and Display Names, so that nobody can pose as PrizeCheck or use abusive names.
20. As a collector, I want to change my Handle at most once every 30 days, so that others cannot dodge a Block or confuse me by changing names often.
21. As a collector, I want my old Handle held for 30 days after I change it, so that nobody else can claim it and pose as me.
22. As a collector, I want my friendships, requests and Loans to follow me, not my Handle, so that changing it breaks nothing.
23. As a collector, I want a Display Name of 1 to 40 characters that I can change at any time and that need not be unique, so that Friends see a name I recognise.
24. As a collector, I want neither my Handle nor my Display Name to appear on a Published Deck, so that publishing a Deck does not reveal who I am.
25. As a collector, I want one reusable Invite Link that does not expire, so that I can share it in a chat or a post.
26. As a collector, I want to regenerate my Invite Link and have the old one stop working, so that I can cut off a link that spread too far.
27. As anyone with an Invite Link, signed in or not, I want to see only the inviter's Display Name, as in "Ash K. invited you to PrizeCheck", so that I know whose link it is without seeing their Handle or Collection.
28. As a visitor who is not signed in, I want to sign in or sign up and return to the same Invite Link page, so that I can finish.
29. As a visitor, I want to send the Friend Request myself by tapping **Send Friend Request**, so that nothing is sent on my behalf automatically.
30. As a collector who is already Friends with the inviter, or has a request pending with them, I want the Invite Link page to say so instead of offering the button again, so that I do not duplicate a request.
31. As a collector the inviter has Blocked, I want the same "this link no longer works" page as for a regenerated link, so that I cannot tell I was Blocked.

### Blocks and Hidden Locations

32. As a collector, I want to Block another collector, so that they can no longer find me by Handle, use my Invite Link or send me Friend Requests.
33. As a collector, I want a Block to end any friendship straight away, so that the person loses sight of my cards.
34. As a collector, I want a collector I have Blocked shown in lookup with **Unblock**, so that I can reverse the choice.
35. As a collector, I want a Blocked list in Settings under Privacy, so that I can review and undo Blocks.
36. As a collector, I want to hide any Location from Friends, whether it is an organization Location, a Storage Leaf, a Deck or Unsorted, so that I control what they see.
37. As a collector, I want hiding a Location to cover everything inside it, including Locations I add later, so that I never have to remember to hide a new sub-binder.
38. As a collector, I want a Location inside a hidden one to be impossible to un-hide on its own, with the reason shown, so that I can see why it is hidden.
39. As a collector, I want moving cards into or out of a hidden Location to change what Friends see straight away, so that hiding is never out of date.
40. As a collector, I want my own screens to mark a hidden Location "Hidden from Friends", so that I can see what is private.
41. As a collector, I want hiding a Location never to affect a Loan already accepted, so that changing my mind about a binder does not break a promise I made.

### Friends' cards on the Want List and in search

42. As a collector, I want each Want List line that a Friend can cover to show a "Friends:" row of chips, one per Friend with their spare and in-Deck counts, so that I see who can help at a glance.
43. As a collector, I want tapping a chip to add one copy to that Friend's draft Borrow Request and tick the chip, so that asking is one tap.
44. As a collector, I want a Buy / Get from Friends switch in the Want List summary, so that I can look at the list as a shopping list or as a borrowing list.
45. As a collector, I want the Get from Friends view to show one panel per card I need that at least one Friend can lend, with the card image on the left, so that I can ask card by card.
46. As a collector, I want each panel to show what I need, which Decks need it and how many I have asked for, so that I know when I have enough.
47. As a collector, I want one row per Friend in each panel with their Display Name, Handle, spare and in-Deck counts and an **Ask** button that becomes a stepper, so that I can choose how many from whom.
48. As a collector, I want cards no Friend can lend summed up in one line under the panels, so that I know what still needs buying.
49. As a collector, I want a Friend's spare copies listed before their in-Deck copies, so that I ask for the copies that cost them nothing first.
50. As a collector, I want a Friend's copy of another Printing in the Reprint Group to count only when my counting setting allows it, and to be labelled with its set and number, so that matches follow the same rule as my own Want List.
51. As a collector, I want the catalog card popup to list "Friends who have this" with **Ask to borrow**, so that I can ask from a card I am looking at, including a card that is not on my Want List.
52. As a collector, I want to open a Friend's Collection from their name, filtered to **On my Want List** by default, with **All cards** and a search, and **Ask to borrow** on each card, so that I can browse what they could lend.
53. As a collector, I want asking in any place to add to the same per-Friend draft, so that I build one Borrow Request per Friend however I find the cards.
54. As a collector, I want a tray listing my drafts with a **Review** button that opens the composer, so that I can check them before sending.
55. As a collector, I want the composer to have a stepper per line capped at what the Friend can lend, a **For Deck** choice (or none, which goes to Unsorted), an optional **Return by** date and **Send Borrow Request**, so that the Friend gets a complete request.
56. As a collector, I want Friends' Location and Deck names never to appear anywhere, so that my Friends' organisation stays theirs.
57. As a collector, I want Friend matches to load separately from the Want List itself, so that my Want List and its Mass Entry export never go stale because another collector changed their cards.

### Borrow Requests and Lend Offers

58. As a collector, I want to send a Borrow Request for several Card Edition lines from one Friend, so that one conversation covers what I need.
59. As a collector, I want to name one of my Decks on a Borrow Request, so that the cards land in that Deck when I receive them.
60. As a collector, I want a request with no Deck to land in Unsorted, so that I can still borrow without picking one.
61. As a lender, I want to accept a Borrow Request in part, setting a line to 0 to leave it out, so that I lend only what I can.
62. As a lender, I want accepting to promise a number of copies per line and make a Loan Pick List with a suggested source Location per copy, spares first, so that I know where to take the cards from.
63. As a lender, I want to change a suggested source before handover, so that the list matches how I actually keep my cards.
64. As a lender, I want to select cards in my Collection and choose **Lend to a Friend…** to send a Lend Offer with the same kind of lines, so that I can offer cards I'm looking at without waiting to be asked.
65. As a lender, I want a Lend Offer to reserve its copies as soon as I send it, so that I cannot promise them twice.
66. As a borrower, I want to accept part of a Lend Offer and have the rest released, so that I take only what I need.
67. As a borrower, I want to decline a Lend Offer, and as a lender I want to withdraw one, so that either of us can say no before anything is handed over.
68. As a lender, I want to decline a Borrow Request, and as a borrower I want to withdraw one, so that a request can end without a Loan.
69. As a collector, I want nothing reserved for a Borrow Request until the lender accepts it, so that an unanswered request does not tie up the lender's cards.
70. As a collector, I want **edit and resend** on a Borrow Request or Lend Offer, which pre-fills a new one, so that changing my mind is easy.
71. As a collector, I want lines and counts not to change after acceptance, so that both of us know exactly what was promised.
72. As a collector, I want a Loan to survive the lender's cards moving around, so that I can reorganise my Collection freely before handover.

### Loan steps: accept, handover, return, partial, cancel, take back

73. As a lender, I want my handover confirmation to remove the picked copies from my Locations at that moment, and nothing else to move them, so that my Collection matches what is physically on the table.
74. As a borrower, I want my handover confirmation to make the Borrowed Copies appear in my Collection's Decks, so that I only record what I received.
75. As a collector, I want a step to be complete only when both sides have confirmed it, with nothing confirming automatically, so that neither of us is marked as having handed over or received cards we did not.
76. As a collector whose Friend has confirmed a step, I want to see it under "Needs you" until I confirm, so that I know it is waiting on me.
77. As a collector who has confirmed a step, I want to see "Waiting for Kim to confirm" in place of the button, so that I know the other side is next.
78. As a collector who confirmed a handover or return, I want to take back my confirmation until the other side confirms, which puts the Loan back to accepted, so that I can fix a tap made by mistake.
79. As a collector, I want either side to be able to cancel an accepted Loan until anyone confirms the handover, which releases the reservation and notifies the other side, so that plans can change before cards move.
80. As a collector, I want nobody to be able to cancel once one side has confirmed the handover, so that a Loan cannot vanish after one side's cards moved.
81. As a lender, I want a pick that has gone out of date flagged on the Loan with a suggested new source, and handover refused until I confirm one, so that I never lose track of where the cards are.
82. As a lender, I want a one-tap **Use suggested picks** for all stale picks, so that fixing them is quick.
83. As a collector, I want to return some copies early as a partial return that either side can start, so that I can give back cards I no longer need.
84. As a collector, I want a partial return to move only my own inventory when I confirm it, and the Loan to show how many copies have come back, so that nothing is lost track of.
85. As a lender, I want returned copies to go back to their source Locations by default, with the option to choose others, so that cards return to where they belong.
86. As a borrower, I want a return to need only my confirmation, because the app knows where the Borrowed Copies are, so that I do not have to pick them again.
87. As a collector, I want borrowing more cards to be a new Loan after handover, so that every Loan stays a clear record.
88. As a collector, I want a Loan closed once every copy is returned or written off, so that finished Loans leave my list of Loans that need me.
89. As a collector, I want unanswered Borrow Requests, Lend Offers and accepted Loans never to expire, and to get one gentle reminder after 14 days saying "Still handing these over? Cancel to release them.", so that stuck reservations come to my attention without cancelling by themselves.
90. As a collector, I want a Loan with a Friend to be cancelled if either of us ends the friendship or Blocks the other before handover, so that nothing stays reserved between people who are no longer connected.
91. As a collector, I want a Loan already handed over to stay open after an unfriend or a Block, with both of us still able to confirm returns, so that cards that changed hands are still accounted for.
92. As a collector, I want nothing else possible between us after a Block, so that it stays a Block.

### Return-by date and overdue

93. As a collector, I want to suggest a return-by date on a request or offer or leave it blank, so that I can set expectations or not.
94. As a lender accepting a Borrow Request, I want to keep, change or clear the date, so that the date is mine to set.
95. As a borrower, I want to see the final return-by date before handover and be able to cancel if I do not accept it, so that I never end up with a date I did not agree to.
96. As a lender, I want to extend or clear the date at any time, but not move it earlier after handover, so that I cannot shorten a deadline the borrower has already planned around.
97. As a borrower, I want to ask for more time, and as a lender I want to approve with one tap, so that extensions are quick.
98. As a collector, I want a Loan to show "Overdue since …" on both sides from the day after the date, so that we both see it.
99. As a collector, I want one inbox item when a Loan becomes overdue and no repeat reminders or penalties, so that I am told once without being nagged.

### Write-off

100. As a lender, I want to write off some or all of the copies still out once I have confirmed the handover, so that I can close a Loan that will not come back, even if the borrower never confirmed.
101. As a lender, I want a Write-off to ask for confirmation once and be final, with no Undo, so that I understand it cannot be reversed.
102. As a lender, I want the written-off copies to leave my Collection, and cards that turn up later to be added back as new, so that my Collection matches what I own.
103. As a borrower, I want to choose **I still have these: keep them in my Collection** or **They're gone: remove them** for written-off copies, so that the app matches reality.
104. As a borrower, I want the copies to stay as Borrowed Copies marked written off until I choose, so that nothing changes without my say.
105. As a borrower who never confirmed the handover, I want nothing to resolve on my side after a Write-off, so that I am not asked about cards I never received.
106. As a collector, I want a Write-off not to be a way to give cards, so that the lender cannot push cards onto anyone.

### Collection, Decks and Want List effects

107. As a lender, I want cards promised to a Loan to be protected, with a plain explanation, when an Inventory Removal, Undo or Edition reassignment would leave me owning fewer than the open Loans promised, so that I cannot undo my way out of a promise.
108. As a lender, I want my lent copies to sit in no Location, show on the Loan and in a **Lent out** entry in the Location tree, and still count in my Collection totals, so that I still own them and can see where they are.
109. As a lender, I want a Deck line whose copies are reserved to read "reserved for Sam" while the copies are still in the Deck, and "lent to Sam" once handed over, so that my Decks tell the truth.
110. As a lender, I want lent lines to count as not present for the Deck's completeness but never appear on my Want List or its Buy export, so that I am not told to buy a card I own.
111. As a lender, I want my Estimated Deck Cost to leave out lent copies, because they are in no Deck.
112. As a lender, I want reserved, lent and Borrowed Copies never to be Spare Copies, so that nothing I have promised is offered again.
113. As a borrower, I want Borrowed Copies to land in the Deck the request named or in Unsorted, labelled with the lender's Display Name, so that I always know whose they are.
114. As a borrower, I want to move a Borrowed Copy between my Locations like an owned copy, so that I can organise it.
115. As a borrower, I want moving a Borrowed Copy into a Deck to add a Deck List line when there is none, exactly as an owned copy would, so that the Deck accepts it. The line stays after the return, and the Deck then shows the card as missing.
116. As a borrower, I want Borrowed Copies to fill Deck List lines and clear the Want List for the Deck they are in, under either counting setting, so that I am not told to buy cards I am holding.
117. As a borrower, I want Borrowed Copies to count toward the Estimated Deck Cost of the Deck they are in, with no separate split, so that the cost shows what the Deck is made of.
118. As a borrower, I want deleting a Deck to send its Borrowed Copies to Unsorted, still borrowed, so that I never lose track of whose they are.
119. As a borrower, I want Borrowed Copies never to count toward my Collection or its value, and never to be removable, a Spare Copy, a Swap hint, offered by "Use cards I own" in Decklist Import or shown to Friends, so that they are never mistaken for mine.
120. As a borrower, I want Undo never to touch Borrowed Copies, so that an Undo cannot undo a Loan.
121. As a Deck's owner, I want a Deck's lines to read "2 yours · 1 from Ash K.", "2 reserved for Kim" or "3 lent to Sam", so that I can see each line's source.

### Inbox

122. As a collector, I want a Loans tab, with a badge counting only Loans that need me, so that I see what to do next.
123. As a collector, I want the Loans list divided into **Needs you**, **Out now** and **Pending**, with **History** folded away, so that I read it in order of urgency.
124. As a collector, I want each Loan row to have the first card's image and a plain-language headline from my side, such as "Kim wants to borrow 3 cards", followed by card names and a due, overdue or "Waiting for …" line, so that I understand a Loan at a glance.
125. As a collector, I want no buttons on list rows, with a tap opening the Loan, so that a list mixing Loans at different steps is not confusing.
126. As a collector, I want each Loan screen to have one primary next step, with the rest behind an overflow menu that shows only what the Loan steps allow, so that I am never offered an action that cannot work.
127. As a collector, I want a one-line note on the Loan screen only when something needs explaining, so that the screen stays clean.
128. As a collector, I want a bell in the header whose drawer lists one line per Loan that needs me, then earlier updates with a single **Clear**, so that I can catch up from anywhere.
129. As a collector, I want the bell badge to count only items waiting on me, not updates, and to clear itself when I act, so that the number means something.
130. As a collector, I want updates for accepted, partly accepted, declined or cancelled requests, changed return-by dates, overdue Loans and the 14-day reminder, marked read when seen and dismissible, so that I hear about what changed.
131. As a collector, I want an update for a Loan cancelled for any reason to read "Ash K. cancelled this Loan", so that I am never told an unfriend or a Block was the reason.
132. As a lender, I want to see a request for more time and an out-of-date pick as items waiting on me, and as a borrower I want a Write-off's keep-or-remove choice as one, so that every step that needs me is listed.

### Account deletion

No account deletion feature exists yet, and the [OAuth sign-in spec](../oauth-sign-in/spec.md) keeps it out of scope. These stories are requirements on that future feature.

133. As a collector deleting my account, I want a warning about my open Loans that does not stop me deleting, so that I know what the other side will see.
134. As a collector deleting my account, I want Borrow Requests, Lend Offers and accepted Loans not yet handed over to be cancelled, with reservations released and the other side told, so that nothing stays promised to a ghost.
135. As a collector whose Friend deleted their account, I want a handed-over Loan to stay open showing "<Display Name> deleted their account", so that I can still close it.
136. As a borrower whose lender deleted their account, I want to confirm the return on my own once the cards are back, with no keep option, so that the Borrowed Copies leave and the cards are not mine to keep.
137. As a lender whose borrower deleted their account, I want to confirm the return on my own or write the Loan off, so that I can close it.
138. As a collector, I want deleted collectors' names to stay on Loans as the name they had, so that history is readable.

### Privacy guarantees

139. As a collector, I want Friends to see only copies I could lend now, so that reserved, lent and Borrowed Copies never leak. Their counts can be lower than my own Collection total.
140. As a collector, I want Friends never to see a Location or Deck name or id, so that my organisation stays private.
141. As a collector, I want every Friend read to check for an accepted friendship with no Block in either direction, so that the rule cannot be bypassed by a single forgotten filter.
142. As a developer, I want a contract test that fails if any `/api/social` response exposes a Location or Deck field, so that future edits cannot break the privacy rule.
143. As a collector, I want an Invite Link page for a signed-out visitor to be served without waking the database, so that the open internet cannot load the database through it.
144. As a collector, I want the app to show no data-source names, fetch times, record IDs or internal reasons on any Friends or Loans screen, so that the screens show only what helps me decide or act.

## Implementation Decisions

Sources: the [map](wayfinder/map.md); the resolutions [social behaviour](wayfinder/resolutions/decide-social-behaviour.md), [Handle and Invite Link rules](wayfinder/resolutions/decide-handle-and-invite-link-rules.md), [Loan inventory model](wayfinder/resolutions/decide-loan-inventory-model.md), [Loan steps](wayfinder/resolutions/decide-loan-steps.md) and [module boundary](wayfinder/resolutions/decide-social-module-boundary.md); the [Friends' cards](wayfinder/resolutions/prototype-friends-cards.md) and [Friends, inbox and Loan screens](wayfinder/resolutions/prototype-friends-loans.md) verdicts; the [copy allocation research](wayfinder/research/copy-allocation-and-loans.md); and [ADR 0014](../../adr/0014-friend-reads-and-two-owner-loans.md). The module-boundary resolution marks which choices were the owner's. Where a later source amends an earlier one, the amendment is noted.

### Terms used in this spec

- **Deck Pick List** is the existing Pick List: the cards in a Deck's Deck List that are stored elsewhere, each with a suggested source Location. **Loan Pick List** is the Pick List a Loan gives the lender: the suggested source Location for each promised copy. The glossary's "Pick List" entry covers the Deck one, and the Loan entry reuses the word. This spec says "Deck Pick List" and "Loan Pick List" to keep them apart (see Details settled at publication).
- **Lendable copies** are the copies a collector could lend now: owned, outside every Hidden Location, not reserved, not lent. Borrowed Copies are never lendable.
- **Needs you** (the Loans tab) and **waiting on you** (the inbox) mean the same set of items.

### Amendments between sources

Where two sources differ, the later one is followed. All are listed here so that implementers do not re-open them.

1. **Write-off.** The [Loan inventory model](wayfinder/resolutions/decide-loan-inventory-model.md) says a Write-off removes the lent copies from the borrower. [Loan steps](wayfinder/resolutions/decide-loan-steps.md) amends it: the borrower chooses to keep or remove them.
2. **Write-off timing.** Charting says a Write-off applies to "a handed-over Loan". Loan steps allow it once the lender has confirmed the handover, which can still be state `accepted` with `lender_handover_at` set.
3. **Return-by date.** Charting says the date is one "both sides agree on". Loan steps replace that: the lender sets, extends and clears it, and the borrower's veto is cancelling before handover. The borrower can request an extension.
4. **What Friends see.** Charting says Friends see the "whole Collection". The module boundary (the owner's choice) narrows it to lendable copies.
5. **Friend Requests in the inbox.** Loan steps list received Friend Requests under "waiting on you". The Friends' verdict (variant E) shows them in the Friends drawer instead, with a badge of their own. See "Badges" below.
6. **Placement.** The prototype verdicts refine where screens live. The prototypes' stand-ins (the Friends tab of variant C, the Loans switch inside the Collection, the Settings "Friends and privacy" section) are not taken forward.
7. **Generated Handle format.** The Handle rules' example, `collector-k7f3qz9m`, contains a hyphen, which the 3 to 20 character letters, digits and underscores rule does not allow. This spec generates `collector_` followed by 8 random lower-case letters and digits, 18 characters in all, so one validation rule holds for every Handle.

### Module boundary

- A new `social` area (`api/app/social/`) owns Friends, Friend Requests, Handles and Display Names, Invite Links, Blocks, Hidden Locations, Loans and the inbox. Routes live under `/api/social/...` (Friend reads, Loans, inbox) and `/api/profile` (Handle, Display Name, Invite Link). All its tables are new. The only existing table it changes is `location`, which gains a hidden flag.
- Inventory code never imports Loan logic. It calls three narrow functions the `social` area exports:
  - `reserved_counts(conn, owner_id, edition_ids)`: copies reserved by the lender and not yet handed over, per Edition. It covers sent Lend Offers and accepted Borrow Requests.
  - `lent_counts(conn, owner_id, edition_ids)`: copies the lender has handed over and not had back or written off, per Edition.
  - `borrowed_in(conn, owner_id, location_ids)`: Borrowed Copies in those Locations, for every read that means "the physical Deck".
- The `social` area calls into inventory only through existing functions: the owner lock, the Spare Copy rule and Location lookups. It writes `holding` rows only through the functions Moves already use, so Undo and the Deck List trigger stay consistent.
- The [OAuth sign-in spec](../oauth-sign-in/spec.md)'s `/auth/*` gateway routes are unchanged. Everything here is behind the FastAPI `verified_user` dependency, except the signed-out Invite Link page (see "Handles, Invite Links and lookup").

### The Spare Copy rule moves into one function

- The rule is written out in five places today (`copy_allocation.py:147-149` and `:254`, `deck_ownership.py:94-98` and `:173`, `swap_hints.py:144`, `deck_pick_list.py:169`). Before any Loan code lands, it becomes one function in `copy_allocation`. It takes the Holdings, Deck List lines and `reserved_counts`, and returns spare and per-Deck own copies. The five callers use it, and the Friend view is the sixth.
- This is its own ticket and must not change any figure. It stays figure-neutral because `reserved_counts` is zero for every collector until Loans land.
- **Reserved copies come out of spare first, then out of copies a Deck holds.** This follows the Loan Pick List, which takes spares first. For one owner and Edition, with `total` copies, `own` the sum of the Decks' own copies and `reserved` from `reserved_counts`:
  - the Spare Copies are `max(0, total − own − reserved)`;
  - the lendable copies are `total − reserved`, and the in-Deck lendable copies are the lendable copies minus the spare ones;
  - copies a Deck holds stay in the Deck and playable until handover. The collector's own Deck figures do not drop because of a reservation. The rule exposes how many of a Deck's copies are reserved so the Deck can say "reserved for Sam".
- Lent copies are not in `holding`, so they are already absent from every owner-scoped read.

### Lender-side data: Loan lines and picks

- `loan_line(loan_id, edition_id, requested, promised, written_off)` holds what was asked, what the lender promised or offered, and how many copies have been written off.
- `loan_pick(loan_id, edition_id, source_location_id, quantity, state)` is the Loan Pick List and remembers each copy's source. `source_location_id` is a nullable FK to the lender's Location with `ON DELETE SET NULL`. A deleted source returns copies to Unsorted by default.
- **The invariant is per Edition, not per Location**, because lent copies sit in no Location. For each lender and Edition: the sum of `loan_line.promised` over Loans that are `offered` or `accepted` and not yet handed over by the lender must not exceed the sum of `holding.quantity`. A deferred constraint trigger on `holding`, `loan` and `loan_line`, in the style of `holding_leaf_guard`, enforces it. Picks are left out on purpose, because they may go stale.
- **Writers check first**, so a collector gets a clear 409 instead of a failed commit. Inventory Removal, inventory Undo and Edition reassignment refuse with `PROMISED_TO_LOAN` when they would break the invariant. The collector sees a plain sentence naming the card and how many copies are promised, never the code. Moves are fine, because Location does not matter to the invariant.
- **Stale picks are computed, not stored.** A pick whose source Location now holds fewer copies of that Edition than the picks claim is flagged when read, with a suggested new source from the same suggestion order as the Loan Pick List. The lender confirms the new source before handover (the Loan screen's **Use suggested picks**). Handover confirmation is refused while any pick is stale.
- **Per-Location figures** for the lender's own screens ("reserved for Sam" and "lent to Sam" on a Deck's lines, the **Lent out** view, keeping lent lines off the Want List) come from `loan_pick.source_location_id` and `loan_pick.quantity`, joined to the Location tree. `reserved_counts` and `lent_counts` stay per Edition; no new table is added.
- **Handover and return writes.** Lender handover confirmation removes the picked copies from their Holdings in one statement through the Moves path, with no destination and no Undo record. Return confirmation inserts them at each pick's source, or at the chosen Locations, also with no Undo record. `lent_counts` then covers the copies while they are out.
- **Totals.** Collection totals and the Location tree's figures add `lent_counts` back as a lent line, because the lender still owns those copies. The catalog's "owned" filter counts them as owned.
- **Relocation.** Deck deletion and leaf conversion re-key `loan_pick.source_location_id` in the same transaction as they move Holdings. Location deletion already refuses a Location with Holdings. A lent source with no Holdings left may be deleted, and its picks then point to Unsorted.

### Borrower-side data: a separate table

- `borrowed_holding(id, loan_id, borrower_id, location_id, edition_id, quantity)` has a composite FK `(borrower_id, location_id)` to the borrower's Location. It never appears in `holding`, so the Collection, Location tree, catalog, Removal and Undo stay correct without change.
- **Reads that union `borrowed_in`** (anything that means "the physical Deck"): `allocate` and `deck_lines` (Borrowed Copies count as `held` only for the Deck they are in), `read_ownership`, the Deck index, `basic_checks`, `deck_contents`, `deck_list_capture` and the Estimated Deck Cost.
- **Reads that never see Borrowed Copies:** Spare Copies, Surplus, `available_to` (Use cards I own), Swap hints, Removal, Undo, Collection totals and every Friend view.
- **Deck List growth.** A trigger on `borrowed_holding` calls the same rule as the `holding` trigger of migration 047, through one shared SQL function, so a Borrowed Copy entering a Deck adds or raises a Deck List line exactly as an owned copy does.
- **Moving a Borrowed Copy** is a dedicated `social` route, not a general Move, because it carries `loan_id` and must never mix with owned copies. Deck deletion moves the Deck's `borrowed_holding` rows to the borrower's Unsorted.
- **Write-off** is lender-only and lender-locked. It raises `loan_line.written_off` and never touches the borrower's rows, so it can cover part of a line even when the Borrowed Copies are spread over several Decks. The borrower's keep-or-remove choice is a borrower-locked step in which the borrower picks which `borrowed_holding` rows make up the written-off count.
  - *Keep* deletes those rows and inserts owned Holdings at the same Locations through the Add path, with an Undo record.
  - *Remove* deletes them.
  - Until the borrower chooses, the Loan shows those copies as written off and awaiting their choice. The count awaiting a choice is derived: the Borrowed Copies the borrower holds for the Loan minus the copies still out, so no extra column is needed.

### Loans, requests and the state model

- `loan(id, kind, state, lender_id, borrower_id, lender_name, borrower_name, deck_id, return_by, lender_handover_at, borrower_handover_at, created_at, revision)` is one table for Borrow Requests, Lend Offers and the Loans they become.
  - `kind` is `borrow_request` or `lend_offer`.
  - `lender_id` and `borrower_id` are nullable FKs with `ON DELETE SET NULL`. `lender_name` and `borrower_name` keep a copy of each Display Name, so "<Display Name> deleted their account" can still be shown. The copy is refreshed whenever a Display Name changes.
  - `deck_id` is the borrower's Deck, `ON DELETE SET NULL`.
  - `state` is `requested`, `offered`, `accepted`, `handed_over` or `closed`, with `closed_reason` set to `declined`, `withdrawn`, `cancelled`, `returned` or `written_off`. The one-sided handover confirmations are the two timestamps, not extra states.
- **State model.**
  - `requested` (Borrow Request) or `offered` (Lend Offer) becomes `accepted` when the lender accepts a request, or the borrower accepts an offer, in whole or in part.
  - `accepted` becomes `handed_over` when both `lender_handover_at` and `borrower_handover_at` are set. Taking back a confirmation clears that side's timestamp, which is allowed only while the other side's is NULL.
  - **A Write-off needs `lender_handover_at` to be set.** That makes it possible while the state is still `accepted` (the borrower never confirmed) as well as in `handed_over`. In the `accepted` case the written-off copies reduce what the borrower can still confirm.
  - **Take-back is unavailable once any copy on the Loan is written off**, because a Write-off is final and a take-back would put the copies back (Details settled at publication, item 17).
  - `closed` follows a decline, withdrawal or cancellation, or the moment every copy is returned or written off.
- **Closing.** A Loan closes with `returned` when every copy came back and nothing was written off, and with `written_off` when at least one copy was written off, even if the rest came back. A Loan with written-off copies awaiting the borrower's keep-or-remove choice stays open (`handed_over`) until the borrower chooses, so the choice stays under "waiting on you". If the borrower never confirmed the handover, or no longer exists, the Loan closes as soon as the lender side is settled.
- `loan_return(id, loan_id, lender_confirmed_at, borrower_confirmed_at)` and `loan_return_line(return_id, edition_id, quantity, destination_location_id)` carry partial returns. A one-sided confirmation is accepted only when the counterparty column is NULL.
- **Reservations.** Copies are reserved once the lender says yes: on accepting a Borrow Request or on sending a Lend Offer. Sending a Lend Offer also makes its Loan Pick List. When the borrower accepts part of a Lend Offer, the Loan Pick List is cut down to the new promised count, removing the quantity from the last picks in suggestion order, and the released copies stop being reserved.
- **Cancel rules.**
  - Before acceptance, the sender withdraws and the recipient declines. Nothing is reserved for a Borrow Request at this point.
  - After acceptance, while nobody has confirmed the handover, either side can cancel. The reservation is released and the other side is told.
  - Once one side has confirmed, nobody can cancel. The side that confirmed can take back their own confirmation until the other side confirms.
  - Once both have confirmed, the Loan can only end as returned or written off.
  - Lines and counts do not change after acceptance. Collectors use **edit and resend**, which pre-fills a new request or offer.
- **Return-by date.** Optional on a request or offer. On accepting a Borrow Request the lender keeps, changes or clears it. On a Lend Offer the lender's date is part of what the borrower accepts. The lender can extend or clear it at any time and cannot bring it earlier after handover; a Loan with no date once a handover is confirmed gets none, since any date would bring it earlier (wave E review). A borrower's extension request is approved by the lender with one tap. From the day after the date, the Loan is overdue.
- **Friendship and Block.** `friendship(user_low, user_high, state, requested_by, created_at)` stores each pair once, in `user_id` order. `block(blocker_id, blocked_id)` stores Blocks. A Block removes any friendship row. Unfriending and Blocking cancel Loans not yet handed over and release their reservations. Handed-over Loans stay open: both sides can still confirm returns, the lender can still write off and the borrower can still request an extension. Nothing else is possible between the two.
- **Half-confirmed handovers.** **Owner's choice (2026-10-15):** a Loan where either side has confirmed the handover counts as handed over for unfriend, Block and account deletion, so it stays open. The unconfirmed side may still confirm and the confirmed side may still take back its own confirmation, even after a Block. Nothing reverses a side's confirmed inventory write automatically. See item 14 of Details settled at publication.

### Locks and revisions

- **Global lock order:** `inventory_owner` rows in ascending `user_id`, then the `loan` row. Every route that touches two owners locks both owner rows in that order before reading anything.
- Most steps touch one owner, because each side's confirmation changes only its own inventory:

| Step | Locks | Revisions advanced |
|---|---|---|
| Lender accepts a Borrow Request, or sends a Lend Offer | lender | lender |
| Lender confirms handover or return, or writes off | lender | lender |
| Borrower confirms handover or return, moves Borrowed Copies, or chooses keep or remove | borrower | borrower |
| Borrower cancels an accepted Loan, declines a Lend Offer, or accepts part of one | both | lender (released reservation) |
| Lender cancels, declines or withdraws before handover | lender | lender |
| Unfriend or Block cancels Loans not yet handed over | both | lender of each cancelled Loan |
| Date changes, extension requests, inbox reads | `loan` row only | none |
| Borrower accepts a Lend Offer in full | `loan` row only | none (the reservation already exists) |
| Borrower withdraws a Borrow Request | `loan` row only | none (nothing was reserved) |

- The first four rows and the date row are the module-boundary resolution's table. The last two rows are not in it; they follow from the same rules and are settled at publication (item 5).
- Two acceptances racing for the same copies both need the lender's owner lock, so they run one after the other, and the second sees the first's reservation. The deferred trigger is the backstop.
- Taking back a one-sided confirmation reverses only that side's inventory write, under that side's lock.

### Friend-facing reads: one choke point

- Every Friend-facing read goes through `friend_copies(conn, viewer_id, friend_ids, edition_ids=None)`. It is the only code in the API that reads another collector's inventory. In one statement it:
  - keeps only Friends with an accepted friendship and no Block in either direction;
  - drops Holdings in hidden Locations, worked out with a recursive CTE over `location.parent_id`;
  - subtracts `reserved_counts`. Lent copies are already absent from `holding`, and Borrowed Copies live in another table;
  - applies the shared Spare Copy rule and returns only `(friend_id, edition_id, spare, in_deck)`.

  It never returns a Location or Deck name or id.
- It is batched across all of the viewer's Friends and requested Editions. The `holding` primary key already leads with `owner_id`, so the read is one index range per Friend, paired in memory. It does not run `allocate` once per Friend.
- **Friend matches** are a separate, unpinned read. `/api/social/want-list-matches` takes the viewer's Want List Editions and expands them by the viewer's counting setting (other Printings in the Reprint Group under Use cards I own). The Want List response, its revision pin and its Mass Entry 409 do not depend on other collectors' revisions. The chips and the Get from Friends view read it.
- A Friend's Collection view uses the same function with `edition_ids=None` and pages by Card Identity. Card search (the catalog card popup, and ad-hoc search for any card) uses it for that card's Editions, expanded by the counting setting in the same way.
- **Contract test.** A test walks the generated OpenAPI schema for every `/api/social` response and fails on any field named for a Location or Deck.

### Handles, Invite Links and lookup

- `collector_profile(user_id, handle, handle_key, display_name, handle_changed_at)` lives in the API database. `user_id` is the PK and an FK to `inventory_owner` with `ON DELETE CASCADE`, and `handle_key` (the lower-cased Handle) is unique. A Handle and Display Name are generated when the `inventory_owner` row is created. A migration backfills existing accounts.
- `released_handle(handle_key, released_at)` holds a changed Handle for 30 days. The 30-day change limit uses `handle_changed_at`.
- `invite_link(user_id, token_hash, created_at)` keeps one row per collector. Regenerating replaces the hash.
- **The signed-out Invite Link page** follows the Published Deck rule that anonymous reads never wake PostgreSQL. The public projection gains an `invites` map from token hash to Display Name. Creating or regenerating a link and changing a Display Name write it, and account deletion removes the entry. The gateway serves it under the existing `PublicReadLimiter`. Signed in, the page uses an authenticated route that also applies Blocks ("this link no longer works"), and shows the Handle lookup's result states when the two are already Friends or a request is pending.
- **Lookup limit.** `handle_lookup_event(user_id, created_at)` counts lookups, and old rows are pruned when one is written, as `auth_rate_event` is. Each account gets 30 per hour and then sees "Too many searches. Try again in N minutes." Unknown and blocked-you lookups run the same single query and return the same 404 body, so the two cannot be told apart. A generated Handle is looked up like any other, since it is too long to guess.
- **Lookup results.** A hit shows the Display Name and Handle with **Send Friend Request**, or says the two are already Friends or a request is pending. A collector you have Blocked is shown with **Unblock**. A miss says "No collector has that Handle."

### Inbox derivation

- **Waiting on you** is derived on each read from Friend Request, Loan, return and Write-off state. Nothing about it is stored, so it cannot drift. It lists: received Borrow Requests and Lend Offers; handovers and returns to confirm; extension requests (lender); a Write-off's keep-or-remove choice (borrower); out-of-date picks to re-confirm before handover (lender); Loans whose other side deleted their account; and received Friend Requests.
- **Updates** are stored events: a request or offer accepted, partly accepted or declined; a Loan cancelled; the return-by date changed. Time-based updates (overdue, and the 14-day nudge) are derived on read, because the app has no scheduler, from `return_by` and the Loan's timestamps. `loan_notice_seen(loan_id, user_id, kind)` makes each appear only once. Its kinds are `overdue`, `nudge_answer` (a request or offer nobody answered) and `nudge_handover` (an accepted Loan nobody confirmed a handover for), so seeing the first nudge never hides the second.
- `inbox_update(id, recipient_id, kind, loan_id, other_name, created_at, read_at, dismissed_at)` stores event updates. A cancel update records only that the Loan was cancelled and by whom, never why, so a Block or unfriend is never shown. Read and dismissed updates are deleted lazily 90 days after they were read.
- **Badges.** The three surfaces count different things so that no item is counted twice within one badge:
  - the **Loans tab** badge counts Loans that need the collector (one per Loan, however many steps wait on it);
  - the **bell** badge counts Loans that need the collector, one per Loan like the drawer's lines, and never updates or Friend Requests;
  - the **Friends button** badge counts received Friend Requests.

  The bell drawer lists one line per Loan that needs the collector, then **Earlier** updates with one **Clear**. Friend Requests are answered in the Friends drawer, not the bell drawer. The Loans tab badge and the bell badge therefore show the same figure by construction (see Details settled at publication).

### Web screens

The owner chose [variant E](wayfinder/resolutions/prototype-friends-loans.md) for placement and [variant D](wayfinder/resolutions/prototype-friends-cards.md) for Friends' cards.

- **Header.** A bell button with a badge opens the inbox drawer. A Friends button (a smiling-face icon in the prototype) beside it, with a badge for incoming requests, opens the Friends drawer. Both are named buttons with accessible labels.
- **Loans tab.** A fourth tab. On a phone it takes the More slot.
- **Phone header avatar.** **Owner's choice (2026-10-15):** an avatar button in the phone header, to the right of 🔔 and ☺, opens the sheet the More slot used to open: Settings (with Privacy), Sign-ins, Owner controls for the owner, and Sign out. This amends the [OAuth sign-in spec](../oauth-sign-in/spec.md)'s More sheet placement. Desktop keeps its existing avatar.
- **Starting a Lend Offer.** **Owner's choice (2026-10-15):** from the Collection. The collector selects cards with the existing selection bar and chooses **Lend to a Friend…**, picks a Friend, and the composer opens pre-filled. The Loan Pick List is the selected copies' own Locations. There is no other entry point for now. Sections are **Needs you**, **Out now** and **Pending**, with **History** folded away. A row has the first card's image and a headline from the collector's side ("Kim wants to borrow 3 cards", "Ash K. says they handed you 3 cards", "Sam has 3 cards of yours", "Ash K. wrote off 1 card"), then card names, then a due, overdue or "Waiting for …" line. Rows carry no buttons.
- **Loan screen.** The heading is the same headline, then "You're lending" or "You're borrowing", the Deck, and the due or overdue date. Each line shows the card image, name, set and count. While accepted, the lender's line also shows its pick ("From Binder 1") or a warning when the pick is out of date. Returned and written-off copies are tagged. When answering a request or offer, a stepper on each line accepts part of it, and a line set to 0 reads "Not lent". There is no step tracker and no explanatory paragraphs.
- **One primary button** is the next step: Accept (with Decline beside it); Use suggested picks; Mark as handed over, or Yes, I have them; Record a return, or Give cards back; Yes, they're back, or Yes, I gave them back; I still have it (with It's gone beside it). When the collector is waiting on the other side the button is replaced by "Waiting for Kim to confirm".
- **Behind the overflow menu:** Withdraw, Take back my confirmation, Cancel Loan, Change return-by date, Write off… and Ask for more time. Each appears only when the Loan steps allow it.
- **Friends drawer.** Incoming requests with Accept and Decline, then the Friends list, then outgoing requests with Withdraw. **Add** opens a short Handle search. **Copy link** copies the Invite Link. Each Friend's overflow menu holds Remove Friend and Block, and each received request's holds Block. Both ask first ("Block Kim? They won't be told."). A received request shows the sender's Display Name and Handle. A **Privacy and blocked** link leads to Settings.
- **Settings** keeps only a Privacy section: the Blocked list, the collector's Display Name and Handle (with the 30-day wait shown when it applies), and Hidden Locations. A Hide from Friends control is on each Location in the Collection.
- **Collection.** A **Lent out** entry in the Location tree lists lent copies. Borrowed Copies show in the Deck that holds them, tagged with the lender's Display Name. A Deck's lines read "2 yours · 1 from Ash K.", "2 reserved for Kim" or "3 lent to Sam". A Location hidden because an ancestor is hidden says so ("Hidden because Trade Binders is hidden").
- **Want List.** Chips on each line, the Buy / Get from Friends switch, and the Get from Friends view (one panel per needed card, image on the left of the heading, one row per Friend, **Ask** that turns into a stepper). Cards no Friend can lend are summed in one line under the panels.
- **Drafts.** Drafts are client-only state, one per Friend, with no API table. The tray stacks one bar per Friend (see the open item on crowding on phones). The composer is as in the Friends' cards verdict.
- **UI copy.** Collectors see names, counts and plain sentences. Screens never show data-source or provenance names, fetch or check times, cache state, internal reasons, record IDs or confirmation timestamps, per [AGENTS.md](../../../AGENTS.md). A collector's own Location names appear on their own screens only, never in anything a Friend sees.

### Inventory touch-points

Each site that assumes a Holding belongs to one collector, from the [research](wayfinder/research/copy-allocation-and-loans.md), with the treatment the sources give it. Rows marked **No source** are not covered by any resolution, and a proposal is made in Details settled at publication.

| Site | Treatment |
|---|---|
| `holding` owner = Location owner, `holding_leaf_guard`, Deck List keys | Unchanged. Lent copies are not in `holding`. Borrowed Copies are in their own table with a composite FK to the borrower's Location. |
| Deck List trigger (migration 047) | One shared SQL function, called from the `holding` trigger and a new trigger on `borrowed_holding`. |
| `allocate`, `deck_lines` | Through the one Spare Copy rule. Reserved copies are not spare. Borrowed Copies count as `held` for the Deck they are in only. |
| `available_to` (Use cards I own, Replace, Copy to my Decks) | Uses the shared rule, so reserved copies are not offered. Never uses Borrowed Copies. |
| Swap hint (`swap_hints.py`) | Uses the shared rule. Never offers Borrowed Copies. |
| Want List and Mass Entry export | Borrowed Copies clear lines for the Deck they are in under either counting setting. Lent copies are never on it, because the lender owns them. |
| `read_ownership`, Deck index, `basic_checks`, `deck_contents`, `deck_list_capture` | Union `borrowed_in` where "physical Deck" is meant. |
| Surplus (`beyond_list`), competition spare | Through the shared rule. Borrowed Copies are never Surplus. |
| Deck Pick List (`committed`, sources, confirm) | `committed` uses the shared rule. Lent copies are not in `holding`. Reserved copies stay in their Locations and can still be gathered or moved before handover. |
| Estimated Deck Cost, `cost_to_complete`, Mass Entry `not_owned` | Borrowed Copies in a Deck count toward its cost. Lent copies are in no Deck and are left out. Needs follow `allocate`. |
| Collection listing and totals, Location tree counts, catalog "owned" | Add `lent_counts` back as a lent line. Borrowed Copies never count. |
| Moves | Allowed. Location does not matter to the invariant. |
| Inventory Removal, inventory Undo | Refuse with `PROMISED_TO_LOAN` when they would break the invariant. Never touch Borrowed Copies. |
| Add and batch add | Unchanged. |
| Edition reassignment of owned copies | Carries the collector's open Loans that name the Edition to its replacement (Details item 15). Refuses with `PROMISED_TO_LOAN` when the copies left in the old Edition would no longer cover what stays promised in it. |
| Deck deletion, leaf conversion | Re-key `loan_pick.source_location_id` in the same transaction. Deck deletion moves the Deck's `borrowed_holding` rows to Unsorted. |
| Location deletion, Unsorted rules | A Location with Holdings is refused as today. A lent source with no Holdings left may be deleted, and its picks point to Unsorted. A Location that holds only Borrowed Copies: **No source** (see Details). |
| Published Deck snapshot, published cost, Live export | Unaffected. They read Deck List lines or the frozen snapshot. |
| Replace's Surplus preview (`import_replace.read_replaced`) | **No source.** |
| Catalog `in_deck` count (`catalog_browse.py`) | **No source.** |
| Edition reassignment of handed-over lines (`loan_line.edition_id`, `borrowed_holding.edition_id`) | Follow the reassignment, with the Loan's picks and return lines (Details item 15). |

### Account deletion requirements

No deletion feature exists. When it is built, it must first cancel Loans not yet handed over (releasing reservations and sending updates), and leave handed-over Loans to the other side through `ON DELETE SET NULL`. Only then is the `inventory_owner` row deleted, which cascades the collector's own rows, including `collector_profile`, `invite_link` and the `invites` entry in the public projection. `inbox_update.recipient_id` has no foreign key on purpose (migration 130), so deletion must also run `DELETE FROM inbox_update WHERE recipient_id = <id>` itself. The other side's `borrowed_holding` and the Loan rows survive, because they belong to the remaining collector or to the Loan. The delete-account screen warns about open Loans but does not prevent deletion.

### Rate limit

Handle lookup: 30 per account per hour, using `handle_lookup_event`. Invite Link page visits do not count toward it (Details settled at publication, item 18).

Friend commands (send, accept, decline, withdraw, remove, Block and Unblock): 120 per account per hour, counted in `handle_lookup_event` under the kind `friend_command` and checked before any other collector's row is locked. A command replayed by its idempotency key is not counted again. Over the limit the answer is "Too many changes. Try again in N minutes." (Details settled at publication, item 20).

Wait after a decline: a collector whose Friend Request was declined cannot send that collector another for 7 days, and sees "You can send another request later." It is cleared when the decliner sends them a request, when their next request goes through after the 7 days, or when the decliner lifts a Block of them (Details settled at publication, item 21).

### Migrations

All migrations are additive and backward compatible, and apply before the new API build deploys. They create the tables named above (`collector_profile`, `released_handle`, `invite_link`, `handle_lookup_event`, `friendship`, `block`, `loan`, `loan_line`, `loan_pick`, `loan_return`, `loan_return_line`, `borrowed_holding`, `loan_notice_seen`, `inbox_update`), add a hidden flag to `location`, install the deferred invariant trigger and the shared Deck List SQL function, and backfill a random Handle and placeholder Display Name for every existing account. The shared Spare Copy rule has no migration. No column is added to `holding`. One new constraint trigger goes on it, and its existing Deck List trigger (migration 047) is rewired to call the shared SQL function with unchanged behaviour.

## Testing Decisions

A good test checks behaviour that a collector or a caller can observe: a status code, a response body, a row's presence or absence, a page's visible text, roles and focus. It does not assert module names, SQL spelling or component structure. Tests go through the highest seam that shows the behaviour, following the [Decklist import spec](../decklist-import/spec.md): signed HTTP against PostgreSQL, then browser journeys on per-worker stacks. The owner has not been asked to confirm these seams; they follow the existing specs.

### 1. The HTTP API (pytest, signed HTTP against PostgreSQL)

Prior art: `test_deck_surplus.py`, `test_deck_cost.py`, `test_publications.py`, `test_missing_cards.py`, `test_want_list.py` and `test_deck_counting.py`.

- **Spare Copy rule consolidation.** For a fixed set of Collections and Decks under both counting settings, the Want List, the Deck index, Surplus, Swap hints, the Deck Pick List and Decklist Import's owned pool return exactly the figures they returned before the refactor.
- **Friends, Blocks and lookup.**
  - Friend Request, accept, decline, withdraw, unfriend, and a request in each direction.
  - Block ends a friendship, stops Handle lookup, Invite Link use and requests, and Unblock reverses it.
  - An unknown Handle and a Handle of someone who Blocked the caller return byte-identical bodies and status codes.
  - Case-insensitive lookup, and the 30-per-hour limit with its message.
  - A request to a signed-out Invite Link page never touches the database.
- **Handles and Display Names.** Length and character rules, reserved and offensive words, uniqueness ignoring case, the 30-day change limit, the 30-day hold on a released Handle, generated Handles of the specified format, and the backfill for existing accounts.
- **Privacy (the Friend read).**
  - A Friend sees spare and in-Deck counts per Edition and nothing else.
  - A non-Friend, a Blocked collector and a pending request see nothing.
  - Hidden Locations, including a Location added inside a hidden one and a Deck inside a hidden organization Location, are left out, and moving cards in or out changes the result immediately.
  - Reserved and lent copies are left out, and Borrowed Copies never appear.
  - Reserved copies come out of spare first and then out of in-Deck copies.
  - A Friend's other-Printing copy is returned or left out according to the viewer's counting setting.
- **The OpenAPI schema guard.** A test that walks the generated schema of every `/api/social` response and fails on any field named for a Location or Deck. This is the guard behind the privacy rule against future edits.
- **Loans (HTTP).** Every state in the state model, including Write-off while the state is still `accepted`; partial accept and the Loan Pick List cut for a Lend Offer; partial returns; take-back of a confirmation; cancel before and after one side confirms; return-by rules (earlier refused after handover); closing as `returned` versus `written_off`; the keep and remove choices and their Undo behaviour; deleted Decks and Borrowed Copies; the 14-day nudge and overdue derived on read; and `PROMISED_TO_LOAN` from Removal, Undo and reassignment.
- **Inventory effects.** Collection totals add lent copies, Borrowed Copies never count, Borrowed Copies fill and extend Deck List lines, Estimated Deck Cost and the Want List follow the rules above under both counting settings, and Undo never touches Borrowed Copies.
- **Inbox.** Waiting on you versus updates, each item clearing when the collector acts, the three badge counts, a Block or unfriend producing a cancel update that does not reveal why, and lazy pruning after 90 days.

### 2. A real PostgreSQL seam for the invariant and for two-owner races

The deferred constraint trigger and the two-owner locking are database behaviour, so tests run against real PostgreSQL with concurrent connections, in the style of the existing pytest PostgreSQL tests.

- Two concurrent acceptances for the same copies: one succeeds, the other is refused, and the sums respect the invariant.
- A direct SQL write that would break the invariant fails at commit, even though application code checks first.
- A Removal racing a Lend Offer send never leaves a lender owning fewer copies than are promised.
- Steps that lock two owners (a borrower cancelling an accepted Loan, an unfriend that cancels several Loans) run concurrently in opposite directions without deadlock, and advance the right revisions.
- The shared Deck List SQL function behaves the same from both the `holding` and `borrowed_holding` triggers.

### 3. The browser (Playwright specs on per-worker stacks)

Prior art: `deck-builder.spec.ts`, `deck-surplus.spec.ts`, `deck-gather.spec.ts`, `mass-entry.spec.ts` and `mobile-journey.spec.ts`. Journeys with two collectors use two browser contexts.

- **Loan flow end to end.** One collector sends a Borrow Request from the Want List's Get from Friends view. The other accepts part of it, uses the suggested picks and confirms the handover. The first confirms receipt and sees a Borrowed Copy in the named Deck with the Want List cleared. A partial return follows, then the final return. A second journey covers a Write-off and the borrower's keep choice, and a third covers a Lend Offer, a cancel and take back.
- **Friends.** Add by Handle, accept in the Friends drawer, add by Invite Link while signed out then signed in, and Block.
- **Want List.** The chips, the Buy / Get from Friends switch and the panels, and a draft from several Friends.
- **Hidden Locations and privacy.** Hiding a Location changes a Friend's view, the Friend never sees a Location or Deck name, and a child of a hidden Location cannot be un-hidden.
- **Phone width.** The Loans tab, the Loan screen, the drawers, the Want List chips and the tray have no horizontal scroll, controls are 44 px, and the tray sits above the tab bar.
- **Accessibility.** The bell and Friends buttons, drawers, badges, overflow menus and the disabled states have names a screen reader announces, and focus moves into and out of drawers and dialogs.

## Out of Scope

From the [map](wayfinder/map.md):

- Trading and giving cards, including one-sided gifts. A Loan never transfers ownership. That is a separate future feature.
- Following deck builders or any one-way follow.
- Messaging between collectors, activity feeds and groups.
- Reporting and moderation of collectors.
- Finding collectors by email address.

Also not in this effort (the map's "Not yet specified" items are kept apart, under open items in Further Notes):

- Account deletion itself. This spec only lists what it must do for Loans.
- Collection value, which does not exist today. The requirement that Borrowed Copies never count toward it is a constraint on future work.

## Further Notes

### Sources

- [Social network decision map](wayfinder/map.md)
- Resolutions: [Decide the social network behaviour](wayfinder/resolutions/decide-social-behaviour.md), [Decide Handle and Invite Link rules](wayfinder/resolutions/decide-handle-and-invite-link-rules.md), [Decide the Loan inventory model](wayfinder/resolutions/decide-loan-inventory-model.md), [Decide the Loan steps in detail](wayfinder/resolutions/decide-loan-steps.md), [Decide the social module boundary and privacy enforcement](wayfinder/resolutions/decide-social-module-boundary.md), [Friends' cards on the Want List and in card search](wayfinder/resolutions/prototype-friends-cards.md), [Friends, inbox and Loan screens](wayfinder/resolutions/prototype-friends-loans.md)
- Research: [Copy allocation, Spare Copies and the Want List, and where Loans plug in](wayfinder/research/copy-allocation-and-loans.md)
- [ADR 0014](../../adr/0014-friend-reads-and-two-owner-loans.md)
- Prototypes, as design evidence only: [Friends' cards](wayfinder/prototypes/friends-cards/README.md), [Friends and Loans](wayfinder/prototypes/friends-loans/README.md)

### Decision traceability

| Source | Spec sections |
|---|---|
| Social behaviour | Solution, stories 1 to 14 and 58 to 132, Loans, requests and the state model |
| Handle and Invite Link rules | Stories 15 to 31, Handles, Invite Links and lookup |
| Loan inventory model | Stories 107 to 121, Lender-side and Borrower-side data, Inventory touch-points |
| Loan steps | Stories 73 to 106 and 133 to 138, the state model, Locks and revisions, Inbox derivation |
| Module boundary and ADR 0014 | Module boundary, Spare Copy rule, Locks, Friend-facing reads, Privacy stories |
| Friends' cards verdict | Stories 42 to 57, Web screens |
| Friends, inbox and Loan screens verdict | Stories 11 to 14 and 122 to 132, Web screens |
| Copy allocation research | Inventory touch-points |

### Details settled at publication

The owner delegated technical choices. These gaps were left by the sources and are settled here. Each is minimal. Items marked **proposal** need the primary's or the owner's confirmation before they are built.

1. **Generated Handle format.** `collector_` plus 8 random lower-case letters and digits. The resolution's example used a hyphen, which its own character rule forbids. `CONTEXT.md` is unchanged.
2. **Loan Pick List versus Deck Pick List.** The two uses of "Pick List" are named apart in this spec. **Proposal:** update the `CONTEXT.md` Loan and Pick List entries to match; this spec does not edit it.
3. **Reserved copies and "spare" versus "in a Deck".** Reservations consume spare copies first and then copies a Deck holds (the arithmetic is under "The Spare Copy rule moves into one function"). This applies to the Friend view and to the lender's own figures. The consolidation ticket is figure-neutral because reservations are zero until Loans land.
4. **Per-Location Loan figures.** "Reserved for Sam", "lent to Sam" and the **Lent out** view come from `loan_pick`. No new table.
5. **Lock-table rows added.** The module-boundary table omits two steps. A borrower accepting a Lend Offer in full needs only the `loan` row, because the reservation already exists. A borrower withdrawing a Borrow Request needs only the `loan` row, because nothing was reserved.
6. **Pick List after a partial accept.** The Loan Pick List is cut down to the new promised count by removing the quantity from the last picks in suggestion order.
7. **How a Loan closes.** `returned` when nothing was written off, `written_off` otherwise. A Loan stays open while the borrower still has to choose keep or remove. The count awaiting the choice is derived (borrower's Borrowed Copies for the Loan minus copies still out), so no column is added.
8. **A borrower confirming after a Write-off.** Once copies are written off before the borrower confirmed, the borrower's confirmation brings in only the copies not written off.
9. **Friend Request and Block state.** `friendship.state` is `pending` or `accepted`. Declining or withdrawing a request deletes the row. A Block deletes the friendship row. A repeat request while one is pending is refused with the "pending" lookup result.
10. **The Invite Link page for a signed-in visitor.** It reuses the lookup's result states (already Friends, pending, Blocked-you gives the "no longer works" page). Opening your own link shows a short note that it is your link.
11. **Drafts are client-only.** A draft Borrow Request is browser state with no API table. Persistence across a reload is left to the ticket.
12. **Badges.** The Loans tab badge and the bell badge both count Loans needing the collector, one per Loan; the Friends badge counts received Friend Requests. The Loans tab and bell figures therefore coincide. **Proposal** if the owner wants them to differ: the bell could also count unread updates, which the verdict does not say.
13. **Waiting-on-you list.** Received Friend Requests stay in the derived waiting-on-you set (as Loan steps say) and are answered from the Friends drawer, per variant E.
14. **Half-confirmed handovers when the friendship ends** (Unfriend, Block, account deletion). **Owner's choice (2026-10-15):** a Loan where either side has confirmed the handover counts as handed over, so it stays open. This fits the rule that nobody can cancel once one side has confirmed, and avoids reversing a side's inventory write that the other side did not agree to. The unconfirmed side may still confirm, the confirmed side may still take back its own confirmation, and the Loan is otherwise treated as the handed-over Loan the sources describe. **This widens the Block rule**, whose source says "nothing else is possible between them" beyond returns, Write-off and extensions: here a handover confirmation and its take-back stay possible after a Block. Rejected alternative: force-cancel and reverse the confirmed side's write as a take-back does.
15. **Sites no source covers.** Proposals: Replace's Surplus preview excludes Borrowed Copies (as for Surplus); the catalog's `in_deck` count includes Borrowed Copies in a Deck, since it means "physical Deck" but the "owned" count does not; a Location that holds only Borrowed Copies cannot be deleted. These three need confirmation. **Edition reassignment, owner's decision (2026-10-16):** the catalog's replacement link is global, so a Loan follows it. A collector's reassignment of copies of an Edition to its replacement moves their open Loans that name the Edition onto the replacement: `loan_line`, `loan_pick`, `loan_return_line` and `borrowed_holding` rows, merged with any the Loan already has for the replacement. Before the lender confirms the handover, only the lender's own reassignment moves a Loan, because the promise is on the lender's copies; a Loan that reserves copies (a sent Lend Offer, an accepted Loan) moves only when the lender's copies of the replacement then cover everything promised in it, and those Loans move together or not at all, so a reassignment of only some copies may leave them on the old Edition until more are reassigned. After the lender's handover, either side's reassignment moves the Loan, so copies returned later come back as the replacement. The reassignment locks every collector involved in ascending `user_id`, then the Loan rows; each Loan moved gets a new revision and each other collector's inventory revision moves. A Deck's line for the replacement rises as Borrowed Copies arrive as the replacement; the old Edition's line stays, as for owned copies. Nothing about either side's Locations or Decks reaches the other.
16. **Lazy pruning** of read and dismissed updates after 90 days is used as the module boundary states it. No scheduler is added.
17. **No take-back after a Write-off.** The Loan steps let a lender write off once they have confirmed the handover, and let a confirmer take back until the other side confirms. Together they would let a lender write copies off and then take back their handover, re-inserting copies the Write-off said were gone. The rule: take-back is unavailable once any copy on the Loan is written off.
18. **Lookup limit scope.** Only Handle lookups count toward the 30 per hour. Invite Link page visits do not. Friend commands have their own limit (item 20).
19. **Pending-choice count during a partial return.** The derived count of written-off copies awaiting the borrower's choice counts "still out" from the borrower's own confirmed returns, so a return only one side has confirmed does not distort it.
20. **Friend command limit.** Decided during implementation on 2026-10-16. Friend commands are limited to 120 per account per hour, so a collector cannot use them to hammer another collector's data. Over the limit the collector sees "Too many changes. Try again in N minutes." Lookups keep their own limit of 30. The signed-in Invite Link read is not counted and no longer returns the Handle, so the link shows only the Display Name (story 27).
21. **Wait after a decline.** Decided during implementation on 2026-10-16. A collector whose Friend Request was declined cannot send that collector another for 7 days, and sees "You can send another request later." without being told it was declined. The wait ends after 7 days, or sooner when the decliner sends the collector a request or lifts a Block of the collector. While the decliner's Block stands, the collector's send gets the unknown-collector answer, not this one.
22. **Block from a received request.** Decided during implementation on 2026-10-16. A received Friend Request has an overflow menu with Block and the same inline confirmation as a Friend's. Blocking deletes the pending request, and the blocked collector is not told.
23. **Follow-ups to the inbox and ending a friendship.** Owner's decisions (2026-10-16). Edit and resend is offered only while the lender is still the borrower's Friend, so a request cancelled by Remove Friend or a Block no longer offers it. A withdrawn Borrow Request or Lend Offer reads "<Name> withdrew their request" or "<Name> withdrew their offer" in the inbox, not "cancelled this Loan"; it is stored as a cancel update and read as withdrawn from the Loan's `closed_reason`, which only a withdraw sets. A withdrawn Lend Offer's headline names the offer too. Each inbox update says when it happened: "just now", "N minutes ago", "N hours ago" or "N days ago" under a week, then the day in the collector's locale ("Oct 3"), with the year when it isn't the current one. A time-based update happened when it began to apply: the start of the day after the return-by date, or 14 days after the request or offer was sent or accepted. This is the collector's own event time, which the owner asked for, so the UI-copy rule allows it. Waiting on you lines carry no time. The Remove Friend and Block questions say how many open Loans nobody handed over they cancel ("This cancels 2 open Loans that haven't been handed over."), counted from the collector's own Loans list, and say nothing for none.

### Open questions and items not yet specified

- **The Friends' draft tray on a phone.** Several drafts stack one bar per Friend, which can crowd a phone screen. The verdict deferred it to the Loan screens work, which did not design the drafts or composer in full.
- **Editing the Display Name.** Not prototyped. The rules are settled; the screen is not.
- **The Want List's per-card need** in the Get from Friends view must use the counting setting and its Deck scoping; the prototype used a plain sum.
- **From the map's "Not yet specified":** email or push notifications for Loan steps; one Borrow Request to several Friends at once; a quick in-person handover; Friends seeing each other's Published Decks or any profile beyond the Handle and Display Name.

### Source conflicts found

See "Amendments between sources" for the seven that change behaviour. One more comes from two source rules interacting: Write-off from the lender's confirmation, and take-back, which item 17 resolves. Two further inconsistencies were resolved without changing behaviour: the "Pick List" term (item 2) and the badge scheme (item 12).

### Suggested ticket breakdown

An ordered list. Each ticket depends on the earlier ones it names.

1. **Spare Copy rule consolidation.** One shared function taking `reserved_counts` (zero until Loans land). No figure changes. Blocks everything that reads Spare Copies.
2. **Profile: Handles, Display Names and the Invite Link.** `collector_profile`, `released_handle`, `invite_link`, backfill, `/api/profile`, the public projection `invites`, and the Settings Privacy fields. Independent of 1.
3. **Friends, Friend Requests and Blocks.** `friendship`, `block`, Handle lookup with the rate limit and the identical-response rule, the Invite Link page, and the Friends drawer. Depends on 2.
4. **Hidden Locations.** The `location` flag, the recursive effective-hidden rule, the Collection controls and Privacy listing. Depends on none, but its effect is only visible after 5.
5. **Friend reads.** `friend_copies`, `/api/social/want-list-matches`, a Friend's Collection view, the card popup list and the OpenAPI schema guard test. Depends on 1, 3 and 4.
6. **Loans data and the invariant.** The Loan tables, `reserved_counts`, `lent_counts`, `borrowed_in`, the deferred trigger and the writer checks (Removal, Undo, reassignment), the shared Deck List SQL function and the `borrowed_holding` trigger. Depends on 1.
7. **Loan steps.** Requests, offers, accept, cancel, handover, return, partial return, take-back, return-by date, Write-off with the keep-or-remove choice, Block and unfriend cascades, and the two-owner locking tests. Depends on 3 and 6.
8. **Inventory effects of Loans.** The touch-point table: totals with lent copies, Deck reads that union Borrowed Copies, Deck deletion, cost, and the Want List. Depends on 6.
9. **Inbox.** The derived waiting-on-you list, stored and derived updates, the badges, and pruning. Depends on 3 and 7.
10. **UI: Friends' cards.** The chips, the Buy / Get from Friends switch, the panels, Ask to borrow in the card popup and Friend's Collection, the drafts and the composer. Depends on 5 and 7.
11. **UI: Loans, inbox and Friends screens.** The Loans tab, the Loan screen, the bell drawer, the Friends drawer, the Deck line labels and the **Lent out** entry. Depends on 3, 7, 8 and 9.
12. **Browser journeys and the phone layout.** Depends on 10 and 11. Includes the phone header avatar sheet.
13. **Account deletion hooks.** When the future deletion feature exists. Depends on 7.
