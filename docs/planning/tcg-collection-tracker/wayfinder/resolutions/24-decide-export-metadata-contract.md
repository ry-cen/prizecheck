# Resolution — Derive Live identifiers and review shared export corrections

**Decision:** owner accepted Q1 by directing rule-based derivation without per-card stored Live mappings, then accepted Q2–Q5 individually with “yes” on 2026-10-08.

**Ticket:** [Decide export metadata provenance and correction](../tickets/24-decide-export-metadata-contract.md).

## Live derivation

Derive Live identifiers from the selected Card Edition's linked Printing metadata and validated deterministic formatting rules. Do not persist a separate per-card Live mapping as the source of truth. Category, effective English name, set metadata and collector number supply the row inputs; physical finish remains Edition information and may not be represented by the game format. Combine quantities only when the derived verified target identifiers agree, never by name alone.

Rules may contain set-specific transformations and numbering tables. The prior-inspected Limitless helper provides ordinary rows and listed promo/subset/Energy examples, not a complete, importer-tested rule set. A nullable legacy `tcgOnline` field or a guessed abbreviation alone does not establish Live compatibility. Validate required inputs and rule coverage; an unknown, contradictory or unsupported case blocks the complete Live export and identifies the affected cards under the existing export contract. Do not substitute another Printing, drop copies, or create an arbitrary per-card target ID to bypass that boundary.

Live corrections therefore concern catalog inputs and derivation rules. Reviewed rule/input provenance must be available even though each card's resulting identifier is calculated. Missing rule coverage, especially game-only ALT identifiers, and actual importer acceptance remain later specification/launch evidence, not facts established by this decision.

## Marketplace verification

Initial TCGplayer mappings may qualify automatically under validated, catalog-maintainer-reviewed matching rules when evidence establishes the same English Printing and relevant physical finish/quote variant. Inspect evidence for set, collector number, identity and applicable physical attributes; a resolving product ID, equal price or shared card name is insufficient. Product identity and the source quote's finish association are distinct checks: a product may cover multiple finishes, while an Edition's price must use its defensible matching variant. Mass Entry product links do not guarantee finish or condition; the buyer still reviews resolved selections.

Ambiguous initial matches remain unverified and require maintainer review. Changed or conflicting product IDs immediately follow the previously accepted invalidation policy: stop using the affected quote and product-ID export mapping, including cached quotes, until the maintainer verifies the replacement. A separately valid Live derivation remains independent. Missing marketplace mappings use the complete Mass Entry text fallback; unresolved Editions remain unpriced, never $0.

## Correction responsibility and provenance

Signed-in collectors may report missing or incorrect export metadata. Only the site's catalog maintainer approves shared corrections to catalog data, Live derivation rules or marketplace mappings. Reports do not themselves approve data or grant Deck owners personal export-ID overrides. Reuse the existing report/review approach with a distinct export-metadata purpose; no specific endpoint, schema or implementation is selected here.

Retain correction evidence, reviewer, date and relevant source/rule version. Reviewed corrections take precedence over source-derived values. Repetition of a previously rejected source value does not silently overwrite the approved correction. New contradictory evidence suspends the affected target's eligibility pending review; Live and marketplace eligibility are evaluated independently. How a contradiction is detected and propagated is a later mechanism, not permission to trust a changed product ID.

Apply this policy to source-derived Printings, manual Catalog Overrides and retired source records. Source disappearance alone does not invalidate an established correction or justify fabricating a TCGdex ID; defensible identity and evidence remain necessary. Retaining a mapping does not guarantee that a current quote or game-supported representation exists. Corrections never redefine physical Edition identity, merge Holdings, reassign inventory or change published card contents. Nobody receives manual price-refresh access, including maintainers.

## Published Decks

Published Decks automatically use the latest verified export metadata and Live derivation rules applicable to their fixed published Printings/Editions, without owner republishing. Published names/card identity, physical descriptors and quantities remain frozen; private Deck edits cannot supply replacement export inputs. A correction must still represent the same published physical card. This does not authorize silently rewriting the snapshot to a different Printing or Edition.

Invalidated or unsupported target information follows the existing blocked Live export or complete Mass Entry text fallback. Old cached eligibility cannot bypass invalidation. The public-only lookup/projection, legacy snapshots, propagation/version correctness and zero anonymous PostgreSQL wakeups remain with [Published Deck prices and snapshot compatibility](../tickets/20-decide-published-price-contract.md); this decision selects behavior, not storage architecture.

## Active completion criteria and remaining evidence

This planning decision resolves derivation versus per-card Live mapping, evidence-based initial marketplace acceptance, correction responsibility, reviewed precedence and automatic corrections for fixed Published Decks. The owner answered every question; no implementation or universal compatibility is claimed.

The [completed architect policy review](../research/export-metadata-policy-review.md) found no findings or closure blockers. The ticket is closed with the evidence obligations below retained for the handoff.

The handoff must specify concrete rule coverage and tests for ordinary, promo, subset, Energy, ALT, same-name/different-Printing, manual and retired records; validate marketplace matching with physical attributes and quote variants; distinguish reported issues from approved corrections; and test invalidation and correction behavior on public versions. Actual Live imports and exact physical-product matching remain unverified. The actual-datastore preflight required before selecting any identity correction remains outstanding and is not replaced by this metadata decision.

**Superseded proposal:** the initial Q1 recommendation to maintain per-card Live crosswalks was rejected by the owner in favor of deterministic derivation. Marketplace product correspondence remains separate; no blanket claim that product IDs can also be derived is made.

## Evidence

[Export metadata provenance and formatter follow-up](../research/export-metadata-provenance.md), [export format research](../research/deck-export-formats.md), [export behavior contract](19-decide-deck-export-contract.md), and [Edition compatibility contract](23-decide-marketplace-metadata-separation.md). Fresh retrieval of the known formatter asset failed during the follow-up; recorded special rules rely on the prior first-party source inspection. No actual Live import was attempted.
