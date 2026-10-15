# Decide Handle and Invite Link rules

Resolves [Decide Handle and Invite Link rules](https://github.com/ry-cen/prizecheck/issues/238), grilled with the owner on 2026-10-15. Before this, collectors had no name of any kind; accounts were only an email address or OAuth identity.

## Names

- Every collector has a **Handle**, used for exact-match lookup, and a **Display Name**, which is what Friends see.
- Both are generated when the account is created, and existing accounts get them too. A generated Handle is random and long enough that it can't be guessed, for example `collector-k7f3qz9m`, so nobody is findable until they share it or choose a readable Handle. A generated Display Name is a neutral placeholder.
- Someone who receives a Friend Request sees the sender's Display Name and Handle before accepting.
- Neither name appears on Published Decks.

## Handle rules

- 3–20 characters: letters, digits and underscores. Lookup ignores case; the Handle is shown in the case the owner typed.
- Unique across all collectors. A reserved list (such as `admin`, `support` and `prizecheck`) and an offensive-word filter apply.
- A collector can change it at most once every 30 days. A released Handle can't be claimed by anyone else for 30 days.
- Friendships, requests and Loans follow the collector, not the Handle.

## Display Name rules

- 1–40 characters of free text, not unique, changeable at any time, checked by the same offensive-word filter.

## Invite Links

- Each collector has one reusable Invite Link. It doesn't expire. Regenerating it stops the old link working.
- Anyone with the link, signed in or not, sees the inviter's Display Name ("Ash K. invited you to PrizeCheck"), never their Handle or Collection.
- Sending the Friend Request needs sign-in. After sign-in or sign-up, the person returns to the same page and taps **Send Friend Request**. Nothing is sent automatically. The request goes from the person who opened the link to the inviter, who accepts or declines.
- A collector the inviter has Blocked sees the same "this link no longer works" page as for a regenerated link.

## Left to the module boundary ticket

- Lookup rate limits, and making responses for blocked, unknown and generated Handles indistinguishable. Owned by [Decide the social module boundary and privacy enforcement](https://github.com/ry-cen/prizecheck/issues/241).
