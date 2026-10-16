# Decide the Loan inventory model

Resolves [Decide the Loan inventory model](https://github.com/ry-cen/prizecheck/issues/236), grilled with the owner on 2026-10-15. It builds on [the copy allocation research](../research/copy-allocation-and-loans.md) and answers that research's nine questions.

## Lender's side

- **Accepting** a request promises a number of copies of each Card Edition line and produces a **Pick List**: a suggested source Location for each copy, spares first, which the lender can change.
- **Handover** confirms the Pick List. The picked copies leave those Locations at that moment.
- **Picks can go out of date.** Before handover, the lender can move or reorganise cards freely. A line whose source no longer has enough copies is flagged on the Loan ("Binder 2 has only 1 Iono now") with a suggested new source, which the lender confirms before handover. The app doesn't track which physical copy was picked.
- **The promised total is always protected.** Inventory Removal and inventory Undo are refused, with an explanation, if they would leave the lender owning fewer copies of an Edition than open Loans have promised.
- **While lent**, copies sit in no Location. They show on the Loan and in a Collection-wide lent view, and still count in the lender's Collection totals because the lender still owns them. The Loan remembers each copy's source Location.
- **On return**, the copies go back to their source Locations by default, and the lender can choose others.
- **The lender's Decks:** a Deck List line whose copies are reserved shows "reserved for Sam" (the copies are still in the Deck and playable until handover). A line whose copies are lent shows "lent to Sam". Lent lines count as not present for the Deck's completeness, but they're never on the Want List or its Buy export, because the lender owns them.
- **Estimated Deck Cost** leaves out lent copies, because they're in no Deck.

## Borrower's side

- **On handover**, Borrowed Copies land in the Deck the request named, or in Unsorted if none was named.
- They can be moved between any of the borrower's Locations like owned copies, always labelled with the lender's Display Name.
- Moving a Borrowed Copy into a Deck adds a Deck List line when there isn't one, exactly as an owned copy would. The line stays after the return, and the Deck then shows it as missing.
- Borrowed Copies count toward the Estimated Deck Cost of the Deck they're in, with no separate borrowed split.
- **Deleting a Deck** sends its Borrowed Copies to Unsorted, still borrowed.
- **On return**, the app knows where the Borrowed Copies are, so the borrower only confirms.

## Spare Copies and counting

- Reserved, lent and Borrowed Copies are never Spare Copies.
- Under either Want List counting setting, Borrowed Copies count only for the Deck they're physically in.
- Borrowed Copies are never used by "Use cards I own" in Decklist Import, by Swap hints, or as anything shown to Friends. They can't be removed through Inventory Removal, and Undo never touches them.

## Write-off

- A Write-off asks for confirmation once and is final. It can't be undone and takes no Undo slot. The lent copies leave the lender's Collection. Cards that turn up later are added back as new.
- *Amended by [Decide the Loan steps in detail](decide-loan-steps.md):* the borrower chooses whether to keep the written-off copies as owned copies or remove them. A Write-off no longer simply removes them.

## For the module boundary ticket

*Settled in [Decide the social module boundary and privacy enforcement](decide-social-module-boundary.md).*

- The research's constraints apply: Holdings have one owner and no stable identity, locks and revisions are per owner, and there's no row-level security. The lender-side "promised" count and stale picks suggest something like the research's L2 Loan-line table rather than freezing Holdings. Borrowed Copies need representing separately from owned Holdings, along the lines of the research's B1. Those choices, cross-owner locking and the shared Spare Copy rule (now written out in five places) belong to [Decide the social module boundary and privacy enforcement](https://github.com/ry-cen/prizecheck/issues/241).
