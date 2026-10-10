# Resolution — Decide fallback for missing English catalog records

The owner confirmed a reviewed, shared fallback for an English Card Printing absent from TCGdex and for a physically distinguishable Card Edition that TCGdex cannot represent reliably.

## Reports and approval

- Signed-in collectors may submit missing Printing or Edition reports in the app. A report is visible to its reporter and the owner/operator, but is not a shared or searchable catalog record. The reporter can see its review state.
- The owner reviews reports in the owner-only control panel and may approve, reject, or request more information. The owner may also begin an entry directly. Only the owner can approve a shared catalog entry.
- Approval of a missing Printing requires a verified set, collector number, exact English name, and evidence link. The approved Printing gets an immutable application ID and `manual` provenance, without a fabricated TCGdex provider ID. Its reviewed English name determines its Card Identity under the existing conservative normalization rule.
- Approval of a missing Edition requires an evidenced physical Variant Descriptor and an immutable Card Edition ID. If the variant cannot be distinguished reliably, collectors use the existing Unspecified Variant. Descriptor collisions require review rather than automatic merging.
- Each approval is a versioned Catalog Override recording the reviewer, time, evidence, and reason. Evidence is kept as a reference URL and review note. The fallback does not copy external card text or images and does not require a second automatic data feed. Missing images use the agreed placeholder.

## Publication and later source changes

- An approval commits the catalog entry and incremented catalog revision in one PostgreSQL transaction. The entry becomes searchable immediately after commit, without waiting for another manual TCGdex pull. The existing rule still applies: catalog search as a whole opens only after the first successful full pull.
- Approved manual entries show maintainer-reviewed provenance and their evidence link. The last successful pull timestamp describes TCGdex synchronization, not the freshness of manual entries. Changed revisions invalidate existing search cursors under the search contract.
- Before approval, check possible duplicates by language, set, collector number, and known source reference. Ambiguous set names or numbering go to review. A full TCGdex pull does not tombstone a manual entry merely because TCGdex still lacks it.
- If TCGdex later supplies a possible match, queue reconciliation for owner review. Link a TCGdex source reference to an existing application identity only after confirming the same physical Printing or Edition. A pull never silently replaces, removes, or merges a manual entry.
- Corrections do not repoint existing Holdings. Deprecate an incorrect Printing or Edition, link its replacement, and let each collector explicitly reassign affected quantities, following the existing identity resolution.

## Deck-check boundary

A verified English name supports the ordinary four-copy Card Identity grouping. The Basic Energy exemption requires supported classification; missing classification creates an explicit unresolved issue. Manual entry does not assert Standard legality or full card-specific rule coverage.

TCGdex's [Card reference](https://tcgdex.dev/reference/card) documents the set, local ID, and name fields while treating the image as optional. The [earlier source investigation](../research/tcgdex-card-identity.md) established that TCGdex variant coverage is incomplete. Those findings support a minimal reviewed entry, an image placeholder, and explicit provenance rather than fabricated source data.
