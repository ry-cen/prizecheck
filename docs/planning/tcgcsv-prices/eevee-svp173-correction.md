# Eevee SVP 173 reviewed marketplace correction (#471)

Public evidence fetched 2026-10-31 (no production database access):

- https://api.tcgdex.net/v2/en/cards/svp-173 assigns plain holo → 610757 and Pokémon Center holo → 610758, both through variant `thirdParty.tcgplayer`; both TCGplayer pricing blocks are null.
- https://tcgcsv.com/tcgplayer/3/22872/products identifies 610757 as **Eevee - 173 (Pokemon Center Exclusive)** and 610758 as **Eevee - 173**. Both have Number 173.
- https://tcgcsv.com/tcgplayer/3/22872/prices has Holofoil market prices $72.13 and $8.90 respectively.

Raw responses are saved in the implementation worktree at `.scratch/471/{tcgdex-svp-173,groups,products,prices}.json`. Committed fixtures under `api/tests/fixtures/svp173/` retain the full card and both relevant products.

This is a swapped source mapping, rather than evidence of a borrowing bug. The V4 variant-ID path (inherited by V5/V6) verifies both wrong IDs. Neither variant borrows a card block here. V5's card-level fallback is not reached. The binding guard sees distinct products, so it cannot detect the swap. A global name restriction would risk valid mappings and is unnecessary for this correction.

## Owner production procedure after release

Run in the production API environment using an existing owner user ID. First import current TCGCSV products if necessary. The command validates both exact Edition descriptors and both imported product names before writing anything. It defaults to a dry run:

```sh
P=/opt/prizecheck-prod/bin/prizecheck-deploy.sh
sudo bash "$P" tool /app/scripts/correct_eevee_svp173.py --owner OWNER_USER_ID
sudo bash "$P" tool /app/scripts/correct_eevee_svp173.py --owner OWNER_USER_ID --apply
sudo bash "$P" tool /app/scripts/price_import_job.py --rebind-only
```

The apply command records two `correct` decisions via `metadata_reviews.decide`, using fresh evidence digests and public revisions, with null quote variants. It retains the owner audit trail and source rejections, increments mapping revisions, and rebinds/publishes. It never edits source records or matching rules. Verify plain → 610758 and stamped → 610757, both Holofoil. Owner decisions survive repetition of the reviewed source evidence, rule activation and rematching; materially changed source evidence can still require renewed review. **Rematching or rebinding alone cannot correct these source IDs.** No new matching version is needed.

Decisions commit separately. If interrupted after the first, repeat the command to finish; each invocation records another audited decision. A concurrent evidence change returns a conflict; inspect before retrying. Publication is best effort, so rerun the explicit rebind-only command and check public prices if publication failed. Changed TCGCSV names or Edition descriptors stop the repair for renewed review.

## Proposed follow-up

Keep “Matched by card number” faithful to its predicate. Add a separate owner review filter for verified promo mappings whose imported product name suggests a physical facet absent from the Edition (and the inverse). This would surface the swapped-ID case even though it never used card-number matching. Such a queue needs reviewed qualifier parsing and pagination/UI work; it is outside this correction.
