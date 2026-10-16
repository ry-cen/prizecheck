# Friend reads go through one choke point, and Loans lock owners in a fixed order

**Status:** accepted on 2026-10-15. Claude decided it under the owner's delegation of technical plumbing ([#241](https://github.com/ry-cen/prizecheck/issues/241)).

Until now, every read and write in the API was scoped to one collector: `verified_user` plus `WHERE owner_id = %s`, under that owner's `inventory_owner` lock and revision. There's no row-level security behind those filters. The social network adds the first reads of another collector's inventory (Friends' copies) and the first steps that change two collectors' figures (a borrower cancelling an accepted Loan releases the lender's reservation).

**Decision.**

- All cross-collector inventory reads go through one function, `social.friend_copies`. It enforces an accepted friendship with no Block, Hidden Locations, and reserved copies, and returns only Edition, spare and in-Deck counts per Friend. No other module may query another collector's `holding`, `location` or `deck_list_line` rows. A contract test fails if any `/api/social` response schema exposes a Location or Deck field.
- Steps that change two collectors' figures lock both `inventory_owner` rows in ascending `user_id` order, then the `loan` row, and advance the revision of each collector whose figures changed. Each side's own handover and return confirmations change only their own inventory, so most steps lock one owner.
- Friend matches on the Want List are a separate, unpinned read, so a collector's pinned figures and exports never depend on other collectors' revisions.

**Rejected.**

- **PostgreSQL row-level security**: it would cover only one of the two rules, because friendship, Blocks and Hidden Locations still need application logic. It would also add a per-request role setting to every connection for the one module that needs it.
- **Copying Friends' counts into a shared table on every write**: this adds a write to every inventory change and a second source of truth for Spare Copies.

**Consequences.** Lent and reserved copies are kept outside `holding` (per-Edition Loan lines, and a separate `borrowed_holding` table), so existing single-owner reads stay correct unless they opt in. The Spare Copy rule becomes one shared function, which the Friend view and the existing five callers all use.
