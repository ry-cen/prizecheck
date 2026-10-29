# Pokémon TCG Collection Tracking

This context describes the physical cards a collector owns, where those cards are stored, and how stored cards form decks.

## Language

**Card Printing**:
A particular set-and-collector-number release of a card in one language. Printings in different languages are distinct even when they depict equivalent cards.
_Avoid_: Card, language-neutral printing

**Card Edition**:
A physically distinguishable variant of one Card Printing that is tracked as a single inventory kind.
_Avoid_: Copy, printing variant

**Variant Descriptor**:
The extensible description of the physical characteristics that distinguish a Card Edition from other editions of the same Card Printing, such as finish, foil pattern, stamp, or size.
_Avoid_: Variant enum, provider variant ID

**Unspecified Variant**:
A Card Edition used when the physical variant of a Card Printing is not known or cannot be represented reliably by the available catalog information. It does not imply the card has a normal or non-foil finish.
_Avoid_: Normal, default variant

**Catalog Override**:
A maintainer-reviewed correction or relationship that supplements catalog-source data for every collector. Personal inventory choices and unreviewed user suggestions are not Catalog Overrides.
_Avoid_: User override, custom card

**Card Identity**:
The application-owned English card-name concept under which Card Printings count together for deck-construction limits. It groups the same rules-relevant English name even when the cards have different artwork, attacks, abilities, or other text. A parenthetical subtitle, such as "(Professor Juniper)" in "Professor's Research (Professor Juniper)", is not part of the name.
_Avoid_: Gameplay Identity, identical card, translated printing

**Format**:
A named set of deck-construction rules, such as Standard, Expanded, or Gym Leader Challenge, that a Deck List can be checked against. A format check is advisory: it never blocks editing or moving cards, and its only gate is that publishing needs a legal result in the Deck's Target Format.
_Avoid_: Mode, ruleset, legality

**Reprint Group**:
The Card Printings within one Card Identity whose rules text is functionally identical. Format legality and bans apply to the whole group; copy limits still count by Card Identity.
_Avoid_: Gameplay Identity, reprint set, equivalent card

**Format Standing**:
Whether one Card Printing is in a Format's card pool on a given day: legal, not legal, or unknown when a rule or card fact is missing. It follows the card's Reprint Group and bans, but says nothing about copy limits or deck size; those belong to a Deck List's format result. A Card Edition has its Card Printing's Format Standing.
_Avoid_: Card legality, deck result

**Trainer Type**:
The kind of a Trainer card: Supporter, Item, Pokémon Tool or Stadium. Unknown for a Trainer whose source gives none, as for many printed before Black & White.
_Avoid_: Trainer subtype, card category

**Holding**:
The current fungible quantity of one Card Edition in one storage leaf.
_Avoid_: Copy record, individual card instance

**Collection**:
The aggregate view of all Holdings owned by one collector. It is not a container and cannot directly hold cards.
_Avoid_: Location, collection folder

**Location**:
A collector-defined node representing where cards are physically organized or stored.
_Avoid_: Collection, tag

**Storage Leaf**:
A Location with no child Locations that may contain Holdings. A Deck is a specialized Storage Leaf.
_Avoid_: Folder, organizational Location

**Organizational Location**:
A Location with child Locations that cannot directly contain Holdings.
_Avoid_: Storage Leaf, mixed-content Location

**Deck**:
A specialized Storage Leaf with two parts: its Holdings, the cards physically in it, and its Deck List, the cards the collector intends it to contain. A Deck may hold no cards yet. Deleting a Deck returns its Holdings to Unsorted.
_Avoid_: Virtual deck, linked deck

**Deck List**:
The part of a Deck that names its intended Card Editions and quantities, whether the collector owns them, stores them elsewhere, or does not own them. It is not a separate object and never counts toward the Collection.
_Avoid_: Deck Plan, wishlist, standalone list

**Target Format**:
The one Format a Deck is being built for; every Deck has one, Standard unless the collector chooses another. The Deck's advisory format check is against its Target Format alone, and changing the Target Format is how a collector checks another Format.
_Avoid_: Main format, selected format, default format

**Decklist Import**:
Creating a Deck, or replacing a Deck's Deck List, from a pasted decklist or a Published Deck, through a review in which every line is matched to Card Editions or dropped before anything is saved. Owned copies are used first as the collector's counting setting allows: of the named Card Printing only, or of any Card Printing in its Reprint Group.
_Avoid_: Deck upload, list merge, sync

**Deck Pick List**:
The cards in a Deck's Deck List that are stored elsewhere in the Collection, each with a suggested source Location. Confirming a pick moves those copies into the Deck. Where no Loan is involved it is simply the Pick List.
_Avoid_: Pull list, retrieval list

**Loan Pick List**:
The suggested source Location for each copy a Loan promises, Spare Copies first. A pick whose source no longer holds enough copies is out of date and is shown with a new suggestion.
_Avoid_: Deck Pick List, pull list

**Want List**:
The Card Editions a collector's Decks name in their Deck Lists but can't get from the Collection, grouped by Deck with a combined total. It is derived from Deck Lists and is never edited directly. The collector's counting setting decides whether Decks are counted as all built at once (spare copies go to the oldest Deck first) or one at a time.
_Avoid_: Wishlist, shopping list, standalone list

**Spare Copy**:
An owned copy that isn't covering any Deck's own Deck List line and isn't promised to a Loan or a Trade: a loose copy outside every Deck, or a copy a Deck holds beyond its own Deck List line. Reserved, lent and Borrowed Copies are never Spare Copies.
_Avoid_: Free copy, unused copy

**Unsorted**:
The collector's root Storage Leaf that receives cards without a chosen Location. It always exists and cannot be renamed or moved.
_Avoid_: Inbox, default Location

**Published Deck**:
A sanitized public snapshot intentionally created from a Deck's Deck List and Target Format. It is not a live view of the private Deck or its Location, does not depend on the Deck's physical cards, and outlives deletion of the Deck until its owner revokes it.
_Avoid_: Shared Deck, public Location, live deck

**Listed Published Deck**:
A Published Deck included in public discovery and search.
_Avoid_: Public account, owner profile

**Unlisted Published Deck**:
A Published Deck excluded from public discovery and reachable only through its unguessable URL. Unlisted does not mean private because anyone with the URL can view it.
_Avoid_: Private Deck, secret Deck

**Collection Import**:
Adding copies to the Collection from another tracker's export file or a pasted list, through a review in which every row is matched to a Card Edition or skipped before anything is saved. It only adds Holdings, all into one chosen Storage Leaf, and never changes or removes existing ones.
_Avoid_: Catalog import, Decklist Import, sync, restore

**Card Scan**:
Adding copies to the Collection by showing cards to the device's camera, one at a time, through a Scan Tray that the collector confirms before anything is saved. Like Collection Import, it only adds Holdings, all into one chosen Storage Leaf that is not a Deck; it is a sibling of Collection Import, not a kind of it.
_Avoid_: Camera import, photo upload, scan session

**Scan Tray**:
The Card Editions and counts a Card Scan has gathered and the collector has not yet confirmed, kept on one device for one account until it is confirmed or cleared. It holds no photos, and it is not an import draft: starting a Card Scan never replaces one.
_Avoid_: Scan session, import draft, cart

**Scan Suggestion**:
A card the scanner matched by its artwork alone, offered as up to 8 versions (the top match, its look-alikes, then the other candidates); it enters the Scan Tray only when the collector picks one or finds the card by search. A card whose printed number agrees enters the Scan Tray without asking which card; it still asks for the finish when it has more than one.
_Avoid_: Guess, unconfirmed lock

**Look-alike Printings**:
Card Printings in one Reprint Group whose artwork the scanner cannot tell apart; the collector picks among them when one is scanned.
_Avoid_: Twins, shared-art group

**Scan Choice**:
The scanner's question when a scanned card needs the collector to pick its version or finish; a Scan Suggestion is a Scan Choice for a card matched by artwork alone.

**Inventory Removal**:
An explicit decrease that takes selected copies out of the tracked Collection without moving them to another Location.
_Avoid_: Move, delete card

**Estimated Deck Cost**:
The sum of available unit market-price estimates multiplied by the quantities of the physical Card Editions in a Deck. It may cover only part of the Deck and excludes shipping and taxes.
_Avoid_: Purchase price, checkout total, guaranteed value

**Pricing Coverage**:
The number of copies in a Deck with an included price estimate compared with the Deck's total number of copies. It describes completeness, not the freshness or certainty of a quote.
_Avoid_: Priced Editions count, price accuracy

**Marketplace Mapping**:
A proposed or verified correspondence between a Card Edition and a marketplace product, including the relevant physical finish. It supports pricing and marketplace exports without defining the Card Edition's physical identity.
_Avoid_: Card Edition ID, physical equivalence

**Friend**:
Another collector with whom a collector has a mutual, accepted friendship. Friends can see each other's Collection, apart from Hidden Locations, and each other's Trade Lists, and can lend each other cards. Friends can trade, as can any two collectors who can reach each other, but only Friends see each other's Collection and Handle. Either side can end the friendship at any time, which does not by itself end a Conversation.
_Avoid_: Follower, contact, connection

**Friend Request**:
One collector's invitation to another to become Friends. The friendship starts only when the other collector accepts. Besides a Handle or an Invite Link, two collectors who both confirmed a Trade can send each other one from it (Add as Friend); the sender does not see the other's Handle until it is accepted.
_Avoid_: Follow, add

**Handle**:
The unique name another collector types, exactly, to send a Friend Request. Every collector has one: it starts as a random, unguessable Handle and can be changed to a chosen one. It is not a public profile: it is not searchable by partial match and does not appear on Published Decks.
_Avoid_: Username, profile

**Display Name**:
The free-text name a collector's Friends, nearby collectors while both have Open discovery on, anyone they share a Conversation with, and anyone they send a Friend Request or Invite Link to, see for them. It need not be unique and does not appear on Published Decks.
_Avoid_: Handle, nickname, profile name

**Invite Link**:
A collector's one reusable personal link, shared outside the app, through which someone can send them a Friend Request without knowing their Handle. Regenerating it stops the old link working.
_Avoid_: Referral link, share link

**Block**:
A collector's choice to end any friendship with another collector, Friend or not, and stop that collector from finding them by Handle, using their Invite Link or sending them Friend Requests. Neither then sees the other in Near you, card search or Trade Lists, the Conversation becomes read-only for both, new Messages and Trade Proposals are refused and open Trade Proposals close. Unconfirmed Trades are cancelled; a Trade either side confirmed stays open so the other side can finish. The Blocked collector is never told, and sees what they would see if the blocker were suspended. Unblocking reopens the Conversation. The Blocked list in Settings shows a Block's Display Name and shows a Handle only where the blocker already knew it, which for a Block placed from a Conversation, a Near you row or a Trade means only a former Friend; a Block cannot be used to learn a Handle.
_Avoid_: Mute, Suspension

**Hidden Location**:
A Location whose Holdings a collector's Friends cannot see, together with every Location inside it. A hidden For trade Location's copies still appear on its owner's Trade List, though never its name. Friends never see Location or Deck names, hidden or not, and never see reserved, lent or Borrowed Copies.
_Avoid_: Private Location, locked binder

**Loan**:
An agreement for one collector, the lender, to let a Friend, the borrower, have some of the lender's copies. A Loan is accepted, which promises a number of the lender's copies and gives the lender a Loan Pick List of where to take them from; then handed over, when the copies leave the lender's Locations; then returned, when they go back. Each side confirms the handover and the return for their own inventory, and a step is complete once both have. Copies are reserved once the lender has said yes: on accepting a Borrow Request or on sending a Lend Offer. While lent, copies sit in no Location; the Loan remembers where they came from. It may carry a return-by date and is overdue after it. The lender still owns lent copies. A Loan never transfers ownership; giving or trading cards is not a Loan.
_Avoid_: Trade, gift, transfer

**Borrow Request**:
A borrower's proposal of a Loan: one or more Card Edition lines with quantities, from one Friend, optionally for one of the borrower's Decks. The lender may accept some lines and decline others.
_Avoid_: Card request, ask

**Lend Offer**:
A lender's proposal of a Loan to a Friend, with the same lines a Borrow Request would have. The borrower accepts or declines it.
_Avoid_: Loan offer, gift

**Borrowed Copy**:
A copy, held by the borrower, that a Friend has lent and handed over. It sits in any of the borrower's Locations and can be moved like an owned copy; in a Deck it fills, or adds, a Deck List line and counts toward that Deck's Estimated Deck Cost. It is never part of the borrower's Collection, never a Spare Copy and never removable, and leaves when the Loan is returned or written off.
_Avoid_: Owned copy, temporary Holding

**Write-off**:
The lender closing a handed-over Loan as not coming back. The lent copies leave the lender's Collection as an Inventory Removal. The borrower then chooses to keep the Borrowed Copies as owned copies, when they still have the cards, or to remove them.
_Avoid_: Lost card, gift

**Trade**:
An agreement between two collectors who can reach each other (Friends, collectors who share a Conversation, or nearby collectors with Open discovery on) to swap copies in person, and optionally an agreed cash amount paid by one side, that transfers ownership both ways. It is a Trade Proposal one side accepted; from then both sides' copies are promised until each side's Confirm swap. Copies a collector gives leave their Collection, and copies they get become their own. The app records an agreed cash amount but never handles, holds or verifies money. A Trade with cards on one side and only cash, or nothing, on the other is still a Trade; one with nothing on one side is a gift. A Trade always has at least one card.
_Avoid_: Loan, sale, deal, exchange

**Trade Proposal**:
One collector's offer of a Trade to another collector who can reach them: the cards each side would give and any cash. The other side accepts or declines it whole, or counters, which closes it and sends back a new Trade Proposal prefilled with the same cards. Sending a Trade Proposal promises the sender's copies; accepting promises the other side's and makes it a Trade.
_Avoid_: Offer, trade request, bid, Lend Offer

**For trade Location**:
A Location the collector marks as holding cards they will trade, together with every Location inside it, including ones added later, except Decks. A Deck can't be marked. For trade is separate from hidden: a hidden For trade Location's cards are still on the Trade List, and no one else ever sees its name.
_Avoid_: Trade binder, trade folder, Hidden Location

**Trade List**:
The copies a collector offers to trade: their owned copies in For trade Locations that no Loan or Trade promises. It always matches what is in those Locations and is never edited directly. Borrowed Copies are never on it. Anyone who can reach the collector can read it, Friend or not, except that Friends cannot read a suspended collector's.
_Avoid_: Haves, trade binder, Collection

**Trade Wants**:
The Card Editions and quantities a collector lists by hand as wanted in trades, beside their Want List, usually for cards no Deck names. Each line is one exact Card Edition. A line adds to any Deck need for the same Card Edition.
_Avoid_: Wishlist, Want List, wants list

**Will accept**:
A Want List card's choice of which cards count for it in trades: this exact Card Edition (the default), any Card Edition of the same Card Printing, or any card with the same Card Identity. It changes trade matching and the Swap hint's suggestions, never the Want List's own counts. A received card taken through a widened rule can switch the Deck line, offered at Confirm swap.
_Avoid_: Match rule, flexibility, substitute

**Trade Pick List**:
The suggested source Location for each copy a Trade promises from one side, For trade Locations first. A pick whose source no longer holds enough copies is out of date and is shown with a new suggestion.
_Avoid_: Loan Pick List, Deck Pick List, pull list

**Confirm swap**:
One side's confirmation that the in-person swap happened, which changes only their own inventory: the copies they give leave their Collection and the copies they get arrive as new Holdings. It is not an Inventory Removal, and it can't be undone. Nobody can cancel a Trade once either side has confirmed, and it is complete once both have.
_Avoid_: Handover, accept

**Open to cash offers**:
A collector's setting that lets anyone who can send them a Trade Proposal, Friend or not, send one in which one side gives only cash. It is off until the collector turns it on; one setting covers everyone. Cash alongside cards is always allowed, and a collector who sends a cash-only proposal can be countered with cash whatever their setting.
_Avoid_: For sale, selling, cash mode

**Conversation**:
The one thread between two collectors, Friends or not, holding their Messages and, as cards, their Trade Proposals, counters and Trades. It is created by the first Message or Trade Proposal. Each side can archive it from their own list, where it returns on newer activity; it is never deleted, and it stays after a Friend is removed, Open discovery is turned off or either collector moves. A Block, a Suspension or a deleted account makes it read-only.
_Avoid_: Chat, inbox thread, DM

**Message**:
One plain-text note in a Conversation, up to 1,000 characters.
_Avoid_: DM, post

**Open discovery**:
A collector's switch, off by default and needing a zip, that lets collectors who also have it on find each other when they are within the searcher's chosen radius, up to 50 mi. A collector can be removed from Open discovery by the owner, after which they cannot switch it on again until restored; a suspended collector cannot switch it on either.
_Avoid_: Public profile, nearby mode

**Near you**:
The Find trades section listing nearby collectors who are not Friends, ordered by match kind, then Distance band, then Display Name.
_Avoid_: Nearby, strangers

**Distance band**:
One of Under 5 mi, 5–10 mi, 10–25 mi or 25–50 mi, the only form in which distance is ever shown.
_Avoid_: Distance, miles away

**Report**:
A collector's account of a problem with another collector, made from a Conversation, a Near you row or a Trade, with one reason and an optional note. It also Blocks the reported collector, who is never told, and goes to the owner's review queue with a snapshot of the pair's Messages and Trades. The owner can dismiss it, remove the collector from Open discovery or suspend them, and can later reverse a removal or Suspension. Nothing else happens to the reported collector automatically.
_Avoid_: Flag, complaint

**Suspension**:
The owner's action that removes a collector from Open discovery and stops them messaging, proposing, countering, accepting, switching Open discovery on and sending Friend Requests, Borrow Requests or Lend Offers. Their unconfirmed Trades are cancelled, as for a Block; a Trade either side confirmed stays open. Their other Friends cannot see their Trade List. Their own Collection, Decks, friendships and existing Loans continue, and the owner can lift it. Lifting it does not switch Open discovery back on.
_Avoid_: Ban

**Completed trade**:
A Trade both sides have confirmed. The count of a collector's Completed trades, Friend Trades included, is shown on rows, Trade Lists and Conversations, and reads as new to trading at zero. There are no ratings or reviews.
_Avoid_: Deal, sale
