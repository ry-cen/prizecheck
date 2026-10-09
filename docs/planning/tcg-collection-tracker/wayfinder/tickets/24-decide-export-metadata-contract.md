# Decide export metadata provenance and correction

**Parent:** [Card prices and Deck exports — decision map](../card-prices-and-deck-exports-map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Blocked by:** [Decide Deck export precision and fallback behavior](19-decide-deck-export-contract.md), [Decide marketplace metadata separation and existing Edition compatibility](23-decide-marketplace-metadata-separation.md).

## Question

What makes a Live card identifier or TCGplayer product mapping verified, and how are missing or disputed mappings corrected? Decide provenance and review responsibility for card category, target set code, collector number, promo/subset/Energy transformations and marketplace products. Account for source-derived Printings, manual Catalog Overrides, retired source records and same-name/different-Printing cards. Decide how mappings remain usable for fixed Published Decks and how later source corrections are approved or invalidated without changing physical Holdings or public card content.

## Accepted boundary

[The export contract](../resolutions/19-decide-deck-export-contract.md) requires complete exports, verified Live grouping, blocking unresolved Live rows, and complete Mass Entry text instead of partial product-ID links. This ticket decides the product/data ownership and correction policy that supports those choices; `/to-spec` selects the mechanism afterward.

[Marketplace metadata separation and existing Edition compatibility](../resolutions/23-decide-marketplace-metadata-separation.md) additionally requires separate physical and mutable lookup data, retained immutable IDs, and invalidation of changed/conflicting marketplace mappings until catalog-maintainer verification. Its quote/product-ID export use stops during invalidation, with complete text fallback; a separately verified Live identifier remains independent. This ticket decides what verifies an initial/replacement mapping and how that evidence/correction is maintained, not whether to silently trust a changed product ID or rewrite Holdings.

## Evidence

[Export research](../research/deck-export-formats.md) contains observed Limitless transformations, not a complete TCGdex-to-Live crosswalk or successful destination test. [Repository inspection](../research/pricing-and-export-code-boundaries.md) records absent normalized category/Live-code fields and existing reviewed source-reference behavior. Look up source facts rather than asking the owner to invent technical identifiers.

[Export metadata provenance and correction paths](../research/export-metadata-provenance.md) distinguishes documented TCGdex category/name/local-number fields from destination-specific codes. `tcgOnline` is documented as an Online code, not a verified Live identifier. Existing owner-only catalog correction provides an authorization precedent but does not currently verify export mappings. Product-ID presence alone does not verify a physical Edition or quote finish.

## Comments

- 2026-10-08: At the owner's request, the architect review was retried and completed with no findings or policy-closure blockers. [Completed review](../research/export-metadata-policy-review.md) is recorded; the primary verified references, accepted-decision coverage and dependency consistency. Closed as a planning decision. Actual importer/product matching and the public-only version/propagation mechanism remain explicitly deferred, not validated by closure.
- 2026-10-08 recording completed at the owner's request. All five product decisions are accepted in the linked resolution; no further owner answer is pending. Primary checked local links, dependency cycles and consistency with the existing export/refresh/physical-identity contracts. The requested architect review did not execute because its agent hit a usage limit. Ticket closure remains pending that review; this is an unmet workflow check, not an unanswered product decision or a completed architecture validation. No implementation, commit or push occurred.
- 2026-10-08 owner accepted Q5 with “yes”: Published Decks automatically receive the latest verified export metadata/rules for their fixed published Printings/Editions without republishing. Cards and quantities stay frozen; invalidation follows existing blocking or complete-text fallback. All owner questions are answered. [Resolution](../resolutions/24-decide-export-metadata-contract.md) records the complete contract; policy consistency review is pending before closure.
- 2026-10-08 owner accepted Q4 with “yes”: reviewed corrections take precedence over source-derived values, retaining evidence, reviewer, date and rule/source version. New contradictory evidence suspends the affected marketplace mapping or Live derivation eligibility pending maintainer review; source disappearance alone does not invalidate an established correction. Live corrections concern catalog inputs and deterministic rules, not stored per-card Live IDs. Apply the policy equally to source-derived Printings, manual Catalog Overrides and retired records, independently for the two targets. Q5 remains pending.
- 2026-10-08 owner accepted Q3 with “yes”: signed-in collectors may report export metadata problems; only the site's catalog maintainer approves shared corrections to catalog data, Live derivation rules or marketplace mappings. Deck owners cannot enter personal export IDs. This grants nobody manual price refresh. Q4–Q5 remain pending.
- 2026-10-08 owner accepted Q2 with “yes”: initial marketplace mappings may qualify automatically under validated, maintainer-reviewed matching rules when evidence establishes the same English Printing and relevant physical finish/quote variant. Ambiguous matches require catalog-maintainer review. Changed/conflicting product IDs retain the previously accepted invalidation and replacement-review requirement. Product-ID presence alone is insufficient, and this grants no manual price-refresh control. Q3–Q5 remain pending.
- 2026-10-08: Claimed for the next Wayfinder decision. Bounded researcher inspection completed; no application, database, clipboard, or importer changes. Awaiting owner decisions on verification rules, correction ownership, precedence, and mappings for fixed Published Deck contents. No policy resolution or destination compatibility claim yet.
- 2026-10-08 owner correction to Q1: Live identifiers should be deduced by rules from a Card Edition and its Printing data, without storing a per-card Live mapping. Accepted as the planning direction; the earlier per-card crosswalk recommendation is superseded. A bounded formatter inspection is checking the required inputs and exception rules. This does not approve the pending marketplace-verification, correction-ownership, provenance/precedence or Published Deck questions, and does not claim actual Live importer acceptance.
- 2026-10-08 follow-up: The previously source-inspected Limitless helper derives ordinary and listed promo/subset/Energy cases from set code and collector number using rules/tables; see the dated [provenance research follow-up](../research/export-metadata-provenance.md). A fresh asset inspection and universal ALT derivation were not established. Q1 therefore uses a deterministic derivation contract, with incomplete or unsupported inputs following the existing blocked-export behavior. Pending correction/provenance questions apply to Live source metadata and derivation rules, rather than stored per-card Live IDs; marketplace product mappings remain a separate concern.
