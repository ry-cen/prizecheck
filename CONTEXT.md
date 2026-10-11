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
A named set of deck-construction rules, such as Standard, Expanded, or Gym Leader Challenge, that a Deck List can be checked against. A format check is advisory and never blocks the collector.
_Avoid_: Mode, ruleset, legality

**Reprint Group**:
The Card Printings within one Card Identity whose rules text is functionally identical. Format legality and bans apply to the whole group; copy limits still count by Card Identity.
_Avoid_: Gameplay Identity, reprint set, equivalent card

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

**Pick List**:
The cards in a Deck's Deck List that are stored elsewhere in the Collection, each with a suggested source Location. Confirming a pick moves those copies into the Deck.
_Avoid_: Pull list, retrieval list

**Unsorted**:
The collector's root Storage Leaf that receives cards without a chosen Location. It always exists and cannot be renamed or moved.
_Avoid_: Inbox, default Location

**Published Deck**:
A sanitized public snapshot intentionally created from a Deck's Deck List. It is not a live view of the private Deck or its Location, does not depend on the Deck's physical cards, and outlives deletion of the Deck until its owner revokes it.
_Avoid_: Shared Deck, public Location, live deck

**Listed Published Deck**:
A Published Deck included in public discovery and search.
_Avoid_: Public account, owner profile

**Unlisted Published Deck**:
A Published Deck excluded from public discovery and reachable only through its unguessable URL. Unlisted does not mean private because anyone with the URL can view it.
_Avoid_: Private Deck, secret Deck

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
