# Decide the Loan steps in detail

Resolves [Decide the Loan steps in detail](https://github.com/ry-cen/prizecheck/issues/237), grilled with the owner on 2026-10-15. It builds on [Decide the Loan inventory model](decide-loan-inventory-model.md) and amends that resolution's Write-off rule.

## States and confirmations

- A Loan is requested or offered, then accepted, then handed over, then returned. It can be written off from handover onwards.
- **Each side's confirmation changes only their own inventory.** When the lender confirms the handover, the copies leave the lender's Locations. When the borrower confirms it, the Borrowed Copies appear. Returns work the same way in reverse. A step is complete once both sides have confirmed it. Until then, the side that hasn't confirmed sees it under "waiting on you", and nothing confirms automatically.
- A one-sided confirmation is allowed only when the other side has deleted their account.

## Reservations

- Copies are reserved once the lender has said yes: when the lender accepts a Borrow Request, or when the lender sends a Lend Offer. Sending a Lend Offer also makes its Pick List.
- The borrower can accept part of a Lend Offer, and the rest is released. Withdrawing or declining it, or the friendship ending, releases all of it.
- Accepted Loans and unanswered Lend Offers never expire. After 14 days without a handover or an answer, both sides get one inbox nudge ("Still handing these over? Cancel to release them.").

## Cancelling and editing

- Before acceptance, the sender can withdraw and the recipient can decline. Nothing is reserved for a Borrow Request at this point.
- After acceptance, while nobody has confirmed the handover, either side can cancel. The reservation is released and the other side is notified.
- Once one side has confirmed the handover, nobody can cancel. The side that confirmed can take back their own confirmation until the other side confirms, which puts the Loan back to accepted.
- Once both sides have confirmed the handover, the Loan can only end as returned or written off.
- Lines and counts can't change after acceptance. Before handover, the collector cancels and uses **edit and resend**, which pre-fills a new request or offer. After handover, returning some copies early is a partial return, and borrowing more is a new Loan.

## Returns

- Partial returns are allowed: either side starts a return for some lines and counts, and each side confirms it for their own inventory. The Loan stays open, showing how many copies have come back, until every copy is returned or written off.

## Return-by date

- A Borrow Request or Lend Offer can suggest a date or leave it blank. When accepting a Borrow Request, the lender can keep, change or clear the date, and the borrower sees the final date before handover and can cancel. On a Lend Offer, the lender's date is part of what the borrower accepts.
- After that, the lender can extend or clear the date at any time, but can't bring it earlier after handover. The borrower can request an extension, which the lender approves with one tap.
- From the day after the date, the Loan shows "Overdue since …" on both sides, and each side gets one inbox item. There are no repeat reminders or penalties.

## Write-off

- Only the lender can write off, and only once the lender has confirmed the handover, even if the borrower never confirmed it. A Write-off can cover some or all of the copies still out. It is final, as decided in the inventory model.
- The lender's copies leave the lender's Collection. **Amends the inventory model:** the Borrowed Copies don't simply leave the borrower. The borrower chooses between *"I still have these: keep them in my Collection"*, which turns them into owned copies where they sit, and *"They're gone: remove them"*. Until the borrower chooses, the copies stay as Borrowed Copies marked written off. If the borrower never confirmed the handover, there is nothing on their side to resolve.
- This isn't a gift flow. The lender can't push cards onto anyone, and giving or trading cards stays out of scope.

## Blocks and account deletion

- A Block treats Loans the same way unfriending does. Requests, offers and accepted Loans not yet handed over are cancelled and their reservations released. Handed-over Loans stay open: both sides can still confirm returns, the lender can still write off, and the borrower can still request an extension. Nothing else is possible between them.
- If either side deletes their account, Loans not yet handed over are cancelled. Handed-over Loans stay open for the remaining side, showing "<Display Name> deleted their account". If the lender deleted theirs, the borrower confirms the return on their own once the cards are back, and the Borrowed Copies leave. There is no keep option, because the cards are still the lender's. If the borrower deleted theirs, the lender confirms the return on their own or writes off.
- The delete-account screen warns about open Loans but doesn't prevent deletion.

## Inbox

- **Waiting on you** (counts toward the badge, and clears itself once you act): received Friend Requests, Borrow Requests and Lend Offers; handovers and returns to confirm; extension requests (lender); a Write-off's keep-or-remove choice (borrower); out-of-date picks to re-confirm before handover (lender); Loans whose other side deleted their account.
- **Updates** (marked read when seen, and can be dismissed): your request or offer was accepted, partly accepted or declined; a Loan was cancelled; the return-by date changed; a Loan is overdue; the 14-day nudge.
- The inbox never reveals an unfriend or a Block. A Loan cancelled for either reason shows as "<Display Name> cancelled this Loan".
