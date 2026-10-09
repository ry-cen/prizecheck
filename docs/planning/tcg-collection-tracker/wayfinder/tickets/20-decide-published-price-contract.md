# Decide Published Deck prices and snapshot compatibility

**Parent:** [Card prices and Deck exports — decision map](../card-prices-and-deck-exports-map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** Codex primary

**Blocked by:** [Decide card-price presentation and Deck cost](18-decide-price-contract.md), [Decide Deck export precision and fallback behavior](19-decide-deck-export-contract.md), [Decide price refresh scope and workload bounds](22-decide-price-refresh-boundary.md), [Decide marketplace metadata separation and existing Edition compatibility](23-decide-marketplace-metadata-separation.md), [Decide export metadata provenance and correction](24-decide-export-metadata-contract.md).

## Question

For the owner's requested public prices and exports, should quotes freeze with the sanitized Published Deck or refresh for its published contents? Agree old-snapshot compatibility, missing new metadata, price timestamps/coverage, republish and revoke behavior, discovery scope, and how to retain public-only reads without exposing private Deck/Location information or waking the database. Published exports always follow published cards and quantities, never current private Holdings.

## Accepted boundary

The owner accepted the simplified public design. Quotes refresh for fixed published cards rather than freezing at publication; published cards and quantities stay fixed, and private edits do not affect the public export or quote calculation. The [accepted resolution](../resolutions/20-decide-published-price-contract.md) records the stable opaque public Edition reference in each frozen row, shared public metadata, and shared quote/coordination boundary. The later [access-triggered refresh contract](../resolutions/22-decide-price-refresh-boundary.md) selects the one-hour/24-hour/three-second behavior, includes anonymous Published Deck visitors, and removes all manual user refresh controls.

The accepted [Edition compatibility policy](../resolutions/23-decide-marketplace-metadata-separation.md) preserves immutable IDs, overrides, private references and frozen public descriptor contents. Changed/conflicting marketplace mappings become unverified and lose quote/product-ID export use until verified; old cached quotes cannot bypass that state. The resolution selects safe lookup/version behavior for legacy public descriptors without silently rewriting their contents or assuming metadata cleanup/private correction updates existing snapshots.

The owner has also accepted [export metadata provenance and correction](../resolutions/24-decide-export-metadata-contract.md): Live identifiers are derived from reviewed catalog inputs and deterministic rules rather than per-card stored mappings. Latest verified metadata/rule corrections apply automatically to the same fixed published cards without republishing; invalidation follows existing export fallbacks. Do not reopen those product choices.

The owner accepted the first-round recommendations, then clarified that a Published Deck should always stay synchronized to its actual published Card Printings and Card Editions. The active proposal uses the repository's shared Edition model: each immutable published row carries a stable, opaque public Edition reference plus its frozen quantity/display fields. Shared sanitized public catalog metadata and the one quote/coordination store resolve that reference. The compatibility uncertainty is limited to legacy snapshots that cannot defensibly establish a reference, or to genuinely uncertain target metadata; it is not a reason to use a current private Holding, guess an association, or rewrite frozen card content. Prices and exports remain on individual Published Deck pages; public discovery keeps its existing title/card-name summaries without price fetching, cost sorting, or cost filtering.

## Planning invariants to preserve

- Refresh uses only the currently published cards/quantities and resolves exact Edition+mapping-revision quotes against the corresponding snapshot version.
- Delayed refresh must not revive a revoked token, overwrite newer published contents/visibility, or attach a total to a different snapshot version.
- Revocation and republication retain their existing next-request behavior; a refresh failure does not expose private data or bypass revocation.
- Anonymous access uses only sanitized public snapshot/quote data with zero PostgreSQL wakeups and no private inventory reads. The main public page and non-price contents remain independent of TCGdex. Under the accepted access-triggered policy, its price display may wait up to three seconds for a validated refresh before labeled cached/unavailable fallback. Choose a bounded public-only coordination/storage mechanism and validate refresh eligibility from the active snapshot; do not enable arbitrary source-ID requests.

## Historical read criterion

Superseded only for the price display by [ADR: access-triggered refresh](../../../../docs/adr/0006-access-triggered-price-refresh.md): anonymous reads had no per-request TCGdex dependency. The owner has accepted a bounded price-only wait on hard expiry while retaining public-only data, zero PostgreSQL wakeups and independent non-price page loading. This is not permission to synchronously load private inventory or block the whole public page.

## Evidence

[Current public snapshot contract](../resolutions/09-decide-public-deck-contract.md), [repository boundaries](../research/pricing-and-export-code-boundaries.md).

## Comments

2026-10-08 — Claimed by Codex primary. Current `PublicEdition` stores frozen set/collector/variant/image/quantity fields, with no stable Printing/Edition association or new export inputs. Existing tests explicitly exclude the internal Edition UUID from public responses. A scoped read-only architect is inspecting public-only association, projection evolution and refresh/version/revocation races; this is preliminary design work, not an accepted resolution.

2026-10-08 — First owner round accepted. Legacy rows gain prices and precise exports only when a same-Printing/Edition association is proven from frozen published information and reviewed catalog evidence. Unresolved rows remain unpriced; unsupported Live rows block complete Live export; Mass Entry retains the complete text fallback. Republishing is an explicit owner option that captures the current Deck, not a transparent legacy repair. Discovery remains title/card-name search and summaries; it does not fetch prices or add cost sorting/filtering.

2026-10-08 — The owner clarified that normal Published Decks should stay associated with the actual Printings/Editions published. The active proposed design stores a stable opaque public Edition reference directly in each immutable published row, alongside its frozen display fields and quantity. Shared sanitized public catalog metadata, verified target metadata, and one shared Edition+mapping-revision quote/coordination store then follow that reference automatically. Refresh never changes a snapshot, visibility, or publication state. This is the expected path; legacy association uncertainty and genuinely uncertain metadata are the edge cases.

2026-10-08 — Architect task `ecef4cc84ace4b7783bf2b27c75b9618`, completed attempt `c367383e61684d29940db3cc8bc2ac17`, proposed a separate association-sidecar design. A fresh read-only architect review, task `a514454542f348a28273eca75f185a03`, completed attempt `3c49162f1b73494d875bcc25628f54d2`, confirmed the existing shared Printing/Edition and Holding model already meets the quantity requirement, and found separate publication association records unnecessary when the reference is stored in the publication envelope. The owner accepted the simplified shared-model boundary by moving to the next Wayfinder ticket. The sidecar proposal is historical. [Resolution](../resolutions/20-decide-published-price-contract.md) records the accepted planning boundary; it authorizes no code, migration, provider, numeric workload limit, or implementation evidence claim.

2026-10-08 — Laya routing task `175f8c3c53e844f69f79f175bf9e81b5` returned a low-confidence orchestrator recommendation; its logging encountered a permission error. The primary chose technical-writer work for these established planning artifacts and retained integration/validation. No escalation was requested.
