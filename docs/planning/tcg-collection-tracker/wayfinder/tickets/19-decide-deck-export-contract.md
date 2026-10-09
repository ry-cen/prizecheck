# Decide Deck export precision and fallback behavior

**Parent:** [Card prices and Deck exports — decision map](../card-prices-and-deck-exports-map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Blocked by:** [Investigate Live clipboard and TCGplayer Mass Entry contracts](17-investigate-deck-export-formats.md).

**Resolution:** [Complete Deck exports with explicit fallbacks](../resolutions/19-decide-deck-export-contract.md).

## Question

Should the primary Copy Deck action produce Live-compatible text with a separate TCGplayer Mass Entry link? Agree how printings/variants collapse into game rows, exact versus less-specific Mass Entry matching, missing set-code or promo mappings, unsupported cards, empty/incomplete/very large Decks, clipboard/text fallbacks, and user-visible limits. Exports must contain the complete selected Deck or Published Deck snapshot rather than only loaded browser pages. Establish when to block an export instead of silently dropping or substituting cards.

## Evidence

[Export format investigation](../research/deck-export-formats.md), [repository boundaries](../research/pricing-and-export-code-boundaries.md). A website's rendered list is not proof of its clipboard grammar or Live importer acceptance.

## Comments

Claimed on 2026-10-08 after the owner requested the next decision. The price-presentation decision is closed; this ticket is the next unclaimed frontier ticket. The export investigation verified Limitless's actual first-party clipboard formatter and product-ID Mass Entry href. Actual importer/prefill compatibility remains a separate evidence task. Earlier unanswered export questions are still product choices, not accepted defaults.

The owner answered “yes to all” for Live as the default Copy Deck action with text fallback, grouping only by verified Live identifier and blocking unresolved cards, all-card product-ID links with full text fallback for missing mappings, and nonempty incomplete/oversized Deck exports without truncation. This closes the ticket; the preceding unanswered-default statement is historical. The linked resolution is the accepted contract. Metadata provenance/correction is now a concrete linked decision rather than residual fog.
