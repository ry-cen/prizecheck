# Decide the social network behaviour

Settled with the owner on 2026-10-15, while charting the [social network map](../map.md). Terms are defined in [`CONTEXT.md`](../../../../../CONTEXT.md).

## Friends

- Friendship is mutual: a Friend Request must be accepted. There is no one-way follow.
- A collector finds another through an Invite Link shared outside the app, or by typing their exact Handle. Email lookup is ruled out because it would reveal whether an address has an account.
- Blocking is in scope. A Block ends any friendship and stops Handle lookup, Invite Link use and Friend Requests from the blocked collector. Reporting and moderation are out of scope.
- Either side can always end a friendship. Loans not yet handed over are cancelled and their reservations released. Handed-over Loans stay open on both sides until they're returned or written off.

## What Friends see

- Friends see each other's whole Collection by default. A collector can make a Location a Hidden Location.
- Friends never see Location or Deck names.

## Finding Friends' cards

- "Cards I'm looking for" means the existing Want List, plus ad-hoc search for any card. There is no new want concept.
- Every visible copy a Friend holds can match, labelled **spare** (a Spare Copy) or **in a Deck**, with spares listed first.
- Matching follows the borrower's Want List counting setting, so under Use cards I own a Friend's copy of another Printing in the Reprint Group counts.

## Loans

- A Loan shows on both sides. The lender's lent copies stay owned but are marked lent. The borrower gets Borrowed Copies that can sit in a Deck, fill its Deck List and clear the Want List, but they never count toward the borrower's Collection or its value.
- Steps: a Borrow Request or Lend Offer → accepted (the lender's copies are reserved, so they can't be promised twice) → handed over (both confirm) → returned (both confirm). Declining or cancelling before handover releases the reservation.
- A Borrow Request or Lend Offer covers many Card Edition lines from one Friend, can be accepted in part, and can name the borrower's Deck.
- A Loan may carry an optional return-by date that both sides agree on. After that date it shows as overdue, with no enforcement.
- The lender can write off a handed-over Loan that won't come back. Giving or trading cards is a separate future feature, not a Loan.

## Notifications

- In-app inbox only: requests, offers, confirmations waiting on you, and overdue Loans. Email is left in the fog.
