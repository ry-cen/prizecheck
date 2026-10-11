# Resolution — Physical Edition identity and mutable marketplace references

**Ticket:** [Decide marketplace metadata separation and existing Edition compatibility](https://github.com/ry-cen/tcg-tracker/issues/42).

**Decision:** accepted by the owner on 2026-10-08. The owner answered “Yes, invalidate and verify the replacement” for changed marketplace mappings, then “yes to all” for metadata separation, preserved-ID compatibility and actual-datastore preflight.

**Review:** [Final architect policy review](../research/edition-compatibility-policy-review.md) found no findings or policy-closure blockers and was recorded before ticket closure. This is a conditional compatibility contract, not a selected migration or proof that persisted records can be corrected safely.

## Physical and lookup data

Card Edition identity represents classified physical characteristics of its Card Printing: finish, foil pattern, stamps, size and other reviewed physical facets. Provider variant IDs, marketplace product IDs including `thirdParty`, price values and timestamps are separate mutable lookup/provenance/quote information; they do not redefine physical identity. Retain original source information and reviewed extensions for diagnosis and classification. Do not discard every unknown field or automatically admit unknown source keys into physical identity.

Separate physical/catalog reconciliation change detection from raw payload provenance and quote freshness. Preserve raw source evidence independently. Price-only changes must not create or duplicate physical identity-review items, including while a separate physical discrepancy is already pending. Mapping changes have their own verification state rather than pretending a changed product ID proves a new physical Edition. Reviewed Card Identity, Printing references, catalog classification and overrides retain their existing review safeguards.

No price refresh may create replacement physical Editions, change Holdings or quantities, move cards, rewrite reviewed overrides, or change fixed Published Deck contents. The accepted [automatic access-refresh contract](22-decide-price-refresh-boundary.md) remains in force, with no manual user price-refresh access.

## Existing IDs and compatibility

Preserve existing immutable application Card Edition IDs and their references. If cleanup of known marketplace metadata yields proven one-to-one physical correspondence within the same reviewed Card Printing, recognize the existing Edition rather than manufacturing a replacement solely because its old descriptor contained a product ID. The later spec selects the compatibility-key/alias representation and evidence records; no schema or rewrite algorithm is selected here.

Correspondence must preserve language, Printing identity, every classified physical facet and reviewed override meaning. Similar names, identical prices, shared marketplace IDs or removal of arbitrary unknown fields do not establish equivalence. A genuinely changed physical variant follows the existing catalog correction/deprecation policy; it is not metadata-only compatibility cleanup. Unspecified Variant Holdings remain unspecified and never become a chosen finish automatically.

If several old Editions or source variants collapse to the same cleaned descriptor, preserve the records and quantities and hold the ambiguous case for catalog-maintainer review. Keep their current effective catalog state until that review establishes an appropriate correction. Do not automatically pick one ID, merge Holdings, retarget Edition references or lose source variants to make a uniqueness constraint pass. Any subsequent quantity reassignment remains an explicit version-checked collector operation under the [existing identity contract](04-decide-card-edition-identity.md).

Versioned reviewed Catalog Overrides, replacements/deprecations, pending move data and Undo semantics must survive compatibility handling. Published snapshots already embed descriptor text and omit private Edition IDs: private metadata cleanup must not silently rewrite their cards, quantities or descriptor contents. Public quote/reference coordination is separately owned by [Published Deck prices and snapshot compatibility](https://github.com/ry-cen/tcg-tracker/issues/39).

## Mapping changes and current quotes

When a marketplace product mapping changes or conflicts with its known physical Edition, mark that mapping unverified and stop using both its quote and product-ID export mapping until a catalog maintainer verifies the replacement. Cached prices cannot bypass invalidation: the accepted retained-quote fallback applies only while the physical match remains defensible. A mapping-invalidated Edition becomes unpriced and lowers copy-weighted Pricing Coverage without implying a $0 value.

Use the accepted complete TCGplayer text fallback when any required product mapping is unavailable; do not generate a partial product-ID link or omit copies. Marketplace invalidation does not itself invalidate a separately verified Pokémon TCG Live identifier. Pricing, marketplace products and Live mapping are separate facts. Holdings, Edition identity and published card quantities remain intact.

Catalog-maintainer mapping review is catalog correction, not a manual price-refresh feature for ordinary users or site operators. Price acquisition continues through the accepted automatic access policy. [Export metadata provenance and correction](https://github.com/ry-cen/tcg-tracker/issues/43) will decide verification evidence, initial mapping provenance, reviewer responsibility, corrections and how approved mappings remain usable for published snapshots. It must respect the invalidation behavior selected here.

## Required actual-datastore preflight

The [read-only audit](../research/edition-marketplace-compatibility-audit.md) could not connect to the configured loopback application database. No query succeeded; affected Edition counts, physical-descriptor collision groups and referenced/unreferenced counts are unknown. Three source fixtures and synthetic in-memory examples are not persisted impact evidence.

The owner accepted a conditional plan: before selecting or executing any data correction, run a read-only preflight against the actual target datastore and produce a reviewed correction plan. Do not use an empty, newly created, administrative or disposable test database as evidence about the application datastore. This prerequisite travels into `/to-spec` and `/to-ticket`; closing this decision does not complete it or authorize a migration.

Preflight must cover affected Editions, candidate physical correspondences and collisions; current and retained catalog generations; Holdings; reviewed reports/overrides; replacements/deprecations; pending move manifests and Undo payloads; and published snapshots. Absence of Holdings or foreign-key references alone is not proof that an Edition is unused. Preserve raw/source provenance, approved physical extensions and published snapshot versions. Record aggregate impact and uncertainty without exposing private inventory or credentials in planning artifacts.

Retain current effective records if correspondence is ambiguous or the preflight cannot establish compatibility. No blanket descriptor stripping, bulk ID regeneration, reference retargeting or merging is selected. Implementation must validate the chosen conditional correction against actual data, preserve atomicity and recoverability, and test reference/quantity integrity before rollout.

## Handoff examples and limits

- A source quote changes while physical descriptors stay identical: update eligible quote cache state without a new physical identity review or Edition ID.
- A known product-ID field is removed from a descriptor with one proven existing physical match: preserve that Edition ID, Holdings and override references using the reviewed compatibility mechanism.
- Two existing Editions become descriptor-equal after removing known metadata: preserve both and stage review; shared product ID is insufficient to merge them or reassign any copies.
- A provider introduces an unfamiliar field or changes a stamp: preserve the raw information and classify/review it; do not call it disposable marketplace metadata or silently collapse physically different variants.
- A marketplace mapping changes: invalidate the quote/product-ID link, lower price coverage and apply the full text fallback. Reverification does not rewrite Holdings or automatically fetch fresh prices.
- A legacy Edition exists only in retained generation data, a move/Undo payload or a published snapshot: preflight still accounts for it; absence from current Holdings does not authorize deletion or silent retargeting.

The later implementation requires actual-datastore and regression evidence. This decision does not claim a completed census, migration, exact physical marketplace coverage or production behavior. No application code, feature spec, implementation tickets, database changes, commit or push is produced here.

## Planning verification

The primary checked local artifact links and the decision dependency graph. Laya selected the architect for both the read-only audit and final policy review; both outcomes are recorded separately. The final review identified no blockers to closing this conditional policy. The refused datastore connection remains an explicit evidence limitation, and no application or migration test pass is claimed.
