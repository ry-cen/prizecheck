# Resolution — Bounded price fixtures and public export comparison

**Ticket:** [Verify live price and export fixtures](https://github.com/ry-cen/tcg-tracker/issues/40).

**Outcome:** planning investigation complete on 2026-10-08 under the [owner's amended evidence scope](../../../../adr/0005-deck-export-planning-evidence.md). This is not a successful Pokémon TCG Live compatibility check.

## Observations

The [initial fixtures](../research/tcgdex-pricing-samples.json) and [remaining price fixtures](../research/remaining-price-fixtures.md) cover normal/reverse, holo, special illustration rare, Basic Energy, promo and unavailable TCGplayer data. The additional Charizard ex special-art example has a USD market quote; the Pikachu promo has a marketplace product ID but an explicit null TCGplayer quote. Energy detailed variants demonstrate populated, null and omitted price states. Quote availability is marketplace/variant specific. These bounded examples are not a catalog coverage audit or exact physical matching proof.

The [browser comparison](../research/deck-export-browser-comparison.md) records two similar English Gholdengo lists, both 60 copies with 14/34/12 category totals. The observed names and Energy rows support complete source-reconstructed Limitless-style examples, including accents and punctuation. The approved reference Copy action showed **Copied!**, but browser clipboard reads returned no bytes; the saved examples are explicitly reconstructed, not captured clipboard text.

TCGplayer Mass Entry visibly prefilled all 35 reference quantity/product-ID rows totaling 60 copies, subsequently displaying readable names/set/number labels for all 35 rows with the same copy total. The saved href, DOM fixtures and screenshot establish current prefill behavior. No cart submission or purchase occurred. The link contract remains observed integration behavior rather than a documented stable API.

## Remaining limits and decisions

Native app access reported a locked Mac. The owner instructed comparison against a similar Limitless deck instead of opening Live. Actual game import, promos/ALT/subset acceptance, malformed/incomplete cases, manual Mass Entry matching, oversized links and exact physical finish/condition matching remain explicit handoff checks in the evidence note. There is no claim of game acceptance, universal price coverage or a successful exact-Edition cart.

The evidence informs [export metadata provenance and correction](https://github.com/ry-cen/tcg-tracker/issues/43), [marketplace metadata separation and existing Edition compatibility](https://github.com/ry-cen/tcg-tracker/issues/42) and [price refresh scope and workload bounds](https://github.com/ry-cen/tcg-tracker/issues/41). Those decisions remain open. No application code, feature spec or implementation tickets were written.

## Agent and verification

A scoped researcher gathered the two additional price fixtures; the primary performed browser comparison/prefill observation and integrated the artifacts. Laya advised orchestrator with low confidence; the primary chose the researcher for bounded external source work. Its terminal outcome was recorded. No new architecture or substantial implementation required an additional architect review.

The primary checked fixture JSON, reconstructed text quantities, Mass Entry segments, local artifact links and decision dependency cycles. Application tests are not applicable to these planning-only Markdown/JSON/text/screenshot additions. No commit or push occurred.
