# Eevee SVP 173 reviewed marketplace correction (#471)

Use the [shared Eevee/Charmander operator plan](reviewed-promo-corrections.md) for current preflight, separately authorized dev/production application, retries, verification and rollback. This page retains the original #471 evidence.

Historical public evidence fetched 2026-10-31 (no production database access; amounts are not current Nov 4 prices):

- https://api.tcgdex.net/v2/en/cards/svp-173 assigns plain holo → 610757 and Pokémon Center holo → 610758, both through variant `thirdParty.tcgplayer`; both TCGplayer pricing blocks are null.
- https://tcgcsv.com/tcgplayer/3/22872/products identifies 610757 as **Eevee - 173 (Pokemon Center Exclusive)** and 610758 as **Eevee - 173**. Both have Number 173.
- https://tcgcsv.com/tcgplayer/3/22872/prices has Holofoil market prices $72.13 and $8.90 respectively.

Raw responses are saved in the implementation worktree at `.scratch/471/{tcgdex-svp-173,groups,products,prices}.json`. Committed fixtures under `api/tests/fixtures/svp173/` retain the full card and both relevant products.

This is a swapped source mapping, rather than evidence of a borrowing bug. The V4 variant-ID path (inherited by V5/V6) verifies both wrong IDs. Neither variant borrows a card block here. V5's card-level fallback is not reached. The binding guard sees distinct products, so it cannot detect the swap. A global name restriction would risk valid mappings and is unnecessary for this correction.

## Current behavior

The command remains dry-run by default and uses the existing owner decision service. It validates catalog and imported product name/number/set/group plus exact descriptors, pins reviewed marketplace inputs, preflights all targets, serializes applies with each other and with the normal price importer, and skips accepted verified mappings already on the correct product. Later owner unmaps/rejections, different corrections and quarantines require renewed review. Only changed mappings receive new decisions. Decisions still commit separately; the script preserves revision/digest conflict checks. Its catalog-wide final rebind and price publication fail visibly, while catalog publication remains independently verifiable. **Rematching or rebinding alone cannot correct these source IDs.** No new matching version is needed.

## Proposed follow-up

Keep “Matched by card number” faithful to its predicate. Add a separate owner review filter for verified promo mappings whose imported product name suggests a physical facet absent from the Edition (and the inverse). This would surface the swapped-ID case even though it never used card-number matching. Such a queue needs reviewed qualifier parsing and pagination/UI work; it is outside this correction.
