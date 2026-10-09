# Resolution — Complete Deck exports with explicit fallbacks

**Decision:** accepted by the owner on 2026-10-08 with “yes to all” for the four export-contract questions.

**Ticket:** [Decide Deck export precision and fallback behavior](../tickets/19-decide-deck-export-contract.md).

## Actions and exported contents

The default **Copy Deck** action produces Pokémon TCG Live text following the researched Limitless-style format. **Open in TCGplayer** is a separate action. Provide selectable complete text if clipboard access fails; report successful copying only when the clipboard write succeeds.

Both targets export every copy in the selected private Deck or fixed Published Deck snapshot. Browser pagination must not limit the export. Private edits cannot change a published export. Price availability or freshness does not determine export eligibility: pricing and target-specific card mappings are separate facts.

## Live precision

Combine quantities only when Editions share the same verified Live card identifier. Different Live identifiers remain separate rows even when the card names are equal. A physical finish can be absent from the game format without changing inventory or pricing identity. An Unspecified Variant may still export when its Printing has a defensible Live mapping; it remains unpriced under the accepted price contract.

If any included card lacks required Live metadata or has an unresolved/unsupported target mapping, block the Live export and identify all unresolved cards. Do not silently drop copies, replace a Printing, or offer a partial list as the full Deck.

The inspected Limitless formatter uses category-count headings, quantity/name/set/number rows, blank lines between groups, and no Total Cards footer. These observations establish a format reference, not proof that Live accepts every special promo/subset/Energy mapping. [Live price and export fixtures](../tickets/21-verify-price-and-export-fixtures.md) retains actual importer acceptance as open evidence.

## TCGplayer matching and fallback

Use the observed quantity/product-ID Mass Entry link when every included card has a verified product mapping. Combining quantities for one product must preserve the full number of requested copies. Product identity does not necessarily specify physical finish or condition; tell the buyer to review the resolved matches and preferences before purchasing.

When any exact product mapping is missing, provide a complete copyable Mass Entry text list instead of a partial product-ID link. Use name, verified TCGplayer set and collector number where known; fall back to the known name when greater specificity is unavailable. Identify less-specific rows and warn that they may resolve to different printings. Do not fabricate codes, product IDs or target names.

Copyable text is also available when a product-ID link is unusable or too large. A manually documented text-input grammar does not establish a text-prefill URL. No silent truncation, hidden omission or automatically submitted purchase is authorized.

## Empty, incomplete and large Decks

Allow nonempty Decks with fewer or more than 60 cards to export, displaying their existing construction warnings. The application does not claim tournament legality or override the destination's validation. Disable export for an empty Deck with a clear No cards explanation.

For unusually large Decks, preserve quantities and provide full text instead of an oversized purchase link. Destination limits and the usable link-length policy require verification in the later handoff; an unsupported target quantity must be explained rather than capped, split or substituted without agreement.

## Next decisions and evidence

The now-specific [export metadata provenance and correction decision](../tickets/24-decide-export-metadata-contract.md) owns Live categories/identifiers, promo and Energy crosswalks, verified marketplace references, and how missing mappings become available. [Published prices and snapshot compatibility](../tickets/20-decide-published-price-contract.md) owns old public snapshots and sanitized projection evolution.

The original [export research](../research/deck-export-formats.md) verified Limitless's first-party formatter and Mass Entry href, not successful Live import or Mass Entry destination prefill. Those evidence gaps remain open. This resolution records product choices only; it does not implement the serializer, grant mapping certainty, or complete the later specification.
