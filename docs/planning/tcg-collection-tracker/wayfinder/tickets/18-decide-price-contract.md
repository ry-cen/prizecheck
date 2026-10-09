# Decide card-price presentation and Deck cost

**Parent:** [Card prices and Deck exports — decision map](../card-prices-and-deck-exports-map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Blocked by:** [Investigate TCGdex prices and Edition mapping](16-investigate-tcgdex-pricing.md).

**Resolution:** [Card-price presentation and Estimated Deck Cost](../resolutions/18-decide-price-contract.md).

## Question

Given the owner's exact-Edition USD market-price scope, where should per-card information appear, and what constitutes a defensible Deck estimate? Agree missing/ambiguous/Unspecified Variant behavior, subtotal and quantity-weighted coverage, stale/unknown timestamps, price-age thresholds and refresh cadence/control. Preserve exact physical identity and do not silently substitute a cheaper Printing or treat unavailable prices as zero.

## Evidence

[Pricing coverage](../research/tcgdex-pricing-coverage.md), [repository boundaries](../research/pricing-and-export-code-boundaries.md).

## Comments

Claimed on 2026-10-08 after the owner requested the next Wayfinder ticket. This is the first open, unblocked ticket in the new effort. Existing choices remain accepted: exact-Edition USD market estimates, priced subtotal and copy coverage, daily locally stored quotes plus owner refresh, and private/public support. The remaining product frontier is information surfaces, uncertain variant/mapping behavior, and stale/unknown-age quote presentation. Export choices and public projection design remain in their separate tickets.

The owner answered “yes to all” on the price-contract round: prices in catalog/card information and alongside Holdings, uncertain/Unspecified Variants unpriced, and last-known quotes included with stale labeling after 48 hours or Age unknown when no source timestamp is usable. The linked resolution records the accepted contract and closes this ticket. The prior frontier above is historical. Export questions remain unanswered and are not accepted by this reply.
