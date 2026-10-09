# Decide marketplace metadata separation and existing Edition compatibility

**Parent:** [Card prices and Deck exports — decision map](../card-prices-and-deck-exports-map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Blocked by:** [Investigate TCGdex prices and Edition mapping](16-investigate-tcgdex-pricing.md).

## Question

Which source fields represent physical characteristics and which are mutable marketplace references? Decide an explicit correction/compatibility policy for existing Editions whose descriptors may include `thirdParty`, preserving immutable identity, Holdings, reviewed overrides and published card contents. If metadata removal makes multiple descriptors equivalent, what evidence permits treating them as one physical Edition? How are changed marketplace mappings reviewed or invalidated so a quote cannot silently move to an unrelated Edition? Record the owner's conditional compatibility plan and require an actual-datastore preflight before selecting or executing any correction.

## Active completion criteria

Record the accepted physical/lookup separation, one-to-one preserved-ID compatibility, maintainer review for ambiguous collisions, mapping invalidation and explicit collector reassignment safeguards. Preserve unknown source data and classified physical facets, published contents and all references. Document that persisted impact remains unknown and that an actual-datastore read-only preflight/reviewed plan is mandatory before a correction is selected or executed. Obtain architect policy review, retain metadata verification/public storage mechanisms with their existing decisions, and close only the planning policy. No migration or data cleanup is selected by this ticket.

## Historical preflight criterion

The original question required establishing affected persisted records before selecting a migration. The configured application connection refused the read-only attempt. The owner explicitly accepted carrying actual-datastore preflight into the later handoff while selecting conditional compatibility rules now, as recorded in [ADR: preserve physical Edition identity](../../../../docs/adr/0007-edition-marketplace-metadata-boundary.md). Persisted impact remains unknown; no migration is selected or approved. The active criteria above replace that prerequisite for closing this planning decision, not for carrying out a data correction.

## Evidence and invariant

Live [pricing samples](../research/tcgdex-pricing-samples.json) include `variants_detailed[].thirdParty`. [`variant_descriptors`](../../../../api/app/catalog.py) retains it and the serialized descriptor participates in the Edition key. Existing withdrawn-descriptor handling preserves Editions pending review, so observed code establishes contaminated keys/spurious review risk, not automatic movement of Holdings. A shared product ID or repeated finish map does not establish a finish-specific SKU or physical equivalence.

Price changes and marketplace corrections must not redefine physical Edition identity. This decision is separate from refresh workload scope and must precede accepting price mapping or the public-price design. Architect review identified this boundary; implementation and any data correction belong to the later handoff.

## Comments

Claimed by codex after the owner requested the next Wayfinder decision. A scoped read-only architect is inspecting normalizer/reconciliation behavior and whether an existing loopback application database can supply aggregate persisted-record evidence. No migration or application implementation is authorized by this planning task.

First independent choice awaiting the owner: changed/conflicting marketplace product IDs invalidate the affected quote/product-ID export mapping until a catalog maintainer verifies its replacement, preserving immutable Edition identity, Holdings and published quantities. Export fallback behavior remains the accepted contract rather than silently dropping cards. This is a proposed policy, not a resolution; existing-record correction choices depend on the pending audit evidence.

The owner answered “Yes, invalidate and verify the replacement”. That mapping-invalidation policy is now accepted; the earlier proposed wording is historical. A stale cached quote cannot remain usable merely because it was fetched before the physical marketplace match became unverified. Mapping verification is catalog maintenance, separate from the prohibited user-facing manual price refresh. Compatibility/collision choices remain pending the audit.

The [read-only compatibility audit](../research/edition-marketplace-compatibility-audit.md) confirmed thirdParty enters keys and full raw fingerprints can multiply reviews during an existing ambiguity. Imports preserve previous Edition membership when a descriptor is withdrawn; they do not automatically move Holdings. The configured loopback application connection refused the approved read-only attempt, so all persisted affected/collision/reference counts remain unknown. Saved source excerpts and synthetic examples are expressly not persisted evidence.

Three additional proposals await the owner: separate classified physical facets from mutable lookup metadata while retaining unknown source information for review; preserve legacy IDs/references and use only proven one-to-one physical correspondence, with ambiguous collisions held for maintainer review and no automatic quantity moves; require an actual-datastore read-only preflight before selecting or executing any data correction. That conditional compatibility plan would not claim a migration is selected or safe from the small source sample. No application state was changed.

The owner accepted all three proposals with “yes to all”. The [compatibility resolution](../resolutions/23-decide-marketplace-metadata-separation.md) and scope ADR now record the accepted policy. Final architect review is pending before closure; no database correction has been selected or executed.

Closed on 2026-10-08 after the [final architect policy review](../research/edition-compatibility-policy-review.md) found no findings or policy-closure blockers. The active planning criteria are satisfied by the owner's conditional compatibility plan, not by a completed persisted-data audit. The actual-datastore preflight remains mandatory before any correction selection/execution. Artifact links and dependency cycles were checked; no application or database state changed.
