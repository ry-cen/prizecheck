# Card prices and Deck exports — decision map

**Label:** wayfinder:map

**Status:** complete planning; ready for owner-invoked `/to-spec`, then `/to-ticket`

## Destination

An agreed plan for displaying TCGdex-sourced card prices, estimating Deck cost, and exporting Decks to TCGplayer Mass Entry and Pokémon TCG Live. This effort resolves decisions only. The owner will invoke `/to-spec` and `/to-ticket` afterward; writing the feature spec, implementation tickets, or application code is outside this map.

## Notes

- Owner request and initial scope confirmed on 2026-10-08: price the exact Card Editions physically in the Deck using USD TCGplayer market prices obtained through TCGdex. Cheapest-playable-version estimates are outside this effort.
- Show pricing and both exports on private Decks and Published Decks. A Published Deck export uses the published cards and quantities, never the current private Deck.
- This is a new effort extending the [completed MVP map](map.md). Its historical exclusions for valuation and exports remain historical; this map does not reopen its completed implementation tickets.
- Use Wayfinder, grilling, and domain modeling for decision work, and research for factual investigation. Consult Laya before delegation/escalation and record outcomes. Keep uncommitted owner changes intact. Commit/push only with owner approval.
- Keep the existing English-only scope, Card Printing/Card Edition identity, physical Holding model, sanitized public projections, and provider-neutral runtime unless a specific new decision explicitly changes them.
- New artifacts remain in the existing authoritative Wayfinder directories. No older research, specification, completion evidence, or decisions are relocated or overwritten.
- [Repository boundary inspection](research/pricing-and-export-code-boundaries.md) identifies current integration seams; it is evidence, not an approved design.
- [Architect review and validation](research/card-prices-and-deck-exports-review.md) records agents, routing, incorporated findings and evidence limits.
- Owner confirmed priced subtotals with quantity-weighted coverage, locally stored prices and visible timestamps. Unknown quotes are not $0. The later [access-triggered refresh scope](../../../adr/0006-access-triggered-price-refresh.md) replaces the original daily refresh preference; its full contract is indexed below.
- Owner selected refreshed quotes for the fixed published cards. Published card content and quantities remain fixed until republish; prices and verified export metadata are mutable public facts for the same published Editions.
- Price presentation, refresh policy, physical identity compatibility, export defaults/fallbacks, metadata provenance, and public projection design are resolved below. Actual-datastore preflight remains a mandatory prerequisite for later correction work.

## Decisions so far

<!-- Only closed decision tickets are indexed here. Owner scope above is an instruction, not a completed feature contract. -->

- [Investigate TCGdex prices and Edition mapping](https://github.com/ry-cen/prizecheck/issues/35) — Bounded live samples confirm regular, reverse, holo and Basic Energy prices/product IDs; special/promo coverage and exact physical matching remain unverified, with marketplace metadata currently entering Edition identity.
- [Investigate Live clipboard and TCGplayer Mass Entry contracts](https://github.com/ry-cen/prizecheck/issues/36) — Verified Limitless's clipboard formatter and quantity/product-ID Mass Entry href; actual Live import and Mass Entry prefill remain compatibility proofs to obtain.
- [Decide card-price presentation and Deck cost](https://github.com/ry-cen/prizecheck/issues/37) — Show exact-Edition unit prices throughout card information and Holdings; use quantity-weighted subtotal/coverage, leave uncertain variants unpriced, and retain old quotes with 48-hour stale or unknown-age labels.
- [Decide Deck export precision and fallback behavior](https://github.com/ry-cen/prizecheck/issues/38) — Default to complete Live text with verified-identifier grouping; block unresolved Live cards and use complete Mass Entry text when an all-card product-ID link is unavailable.
- [Verify live price and export fixtures](https://github.com/ry-cen/prizecheck/issues/40) — Completed bounded price cases, similar Limitless Deck comparison and 35-row/60-copy Mass Entry prefill; clipboard bytes, actual Live import and exact physical matching remain unverified.
- [Decide price refresh scope and workload bounds](https://github.com/ry-cen/prizecheck/issues/41) — Automatic access-only refresh uses one-hour background/24-hour synchronous thresholds and a three-second price-only wait; public visitors are included, no users have manual refresh, and confirmed absence is cached for an hour.
- [Decide marketplace metadata separation and existing Edition compatibility](https://github.com/ry-cen/prizecheck/issues/42) — Separate physical identity from mutable lookup data, preserve IDs/references through proven correspondence, review collisions and invalidate changed mappings; actual-datastore preflight is required before any correction is selected.
- [Decide export metadata provenance and correction](https://github.com/ry-cen/prizecheck/issues/43) — Derive Live identifiers with validated rules, automatically accept evidence-backed initial marketplace matches, and apply maintainer-reviewed corrections to the same fixed published cards; architect policy review found no blockers.
- [Decide Published Deck prices and snapshot compatibility](https://github.com/ry-cen/prizecheck/issues/39) — Frozen published rows carry opaque public Edition references; shared sanitized metadata and Edition+mapping-revision quotes refresh without changing content or visibility, and anonymous public reads stay out of PostgreSQL.
- [Decide implementation acceptance and launch evidence](https://github.com/ry-cen/prizecheck/issues/44) — Separate implementation checks from target-datastore preflight and real destination, physical-match, owner-walkthrough, and deployed-behavior launch gates; no evidence is claimed complete.

## Not yet specified

No known policy or design uncertainty remains. The next steps are owner-invoked `/to-spec`, then `/to-ticket`; create another Wayfinder ticket only if a sharp new policy gap appears.

All policy, public-design, and acceptance/launch-gate decisions are resolved above. Numeric workload/coordination limits, correction procedures, schema/reference encoding, and evidence execution belong to the later specification and implementation/launch work; they are not completed proof.

## Out of scope

- Feature specification, implementation-ticket generation, application implementation, commits, pushes, deployment, and purchasing cards during this effort.
- Deck import, cheapest-playable-version substitution, historical price charts, purchase-price bookkeeping, card condition/grading, additional currencies, and non-English catalog support unless the owner expands scope.
- Full tournament legality or a guarantee that every physical Printing is supported by Pokémon TCG Live.
- Further native Live importer attempts during this planning investigation: the owner selected a similar Limitless Deck comparison. Actual import remains a later handoff check under the [planning evidence scope](../../../adr/0005-deck-export-planning-evidence.md), not a completed compatibility proof.
