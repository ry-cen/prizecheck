# Edition marketplace-metadata compatibility audit

Inspected on 2026-10-08 by a scoped read-only architect; findings integrated by the primary. Scope: [marketplace metadata separation and existing Edition compatibility](https://github.com/ry-cen/tcg-tracker/issues/42). No migration, application implementation, database write or server startup occurred.

## Persisted impact is unavailable

The configured local application connection was classified as a literal loopback, non-admin database. Initial sandbox access was denied before a query; the approved retry of the same connection returned connection refused. No connection or query succeeded. No alternate/admin/disposable database was substituted and no credentials or database URL are recorded here.

Affected persisted Editions, groups that collide after removing known metadata, and counts of referenced/unreferenced affected Editions are **unknown**, not zero. The actual datastore needs a read-only preflight before choosing or executing any data correction. A source fixture or an empty test database cannot satisfy that requirement.

## Code findings

- **Marketplace metadata enters descriptor keys.** [`variant_descriptors`](../../../../../api/app/catalog.py:45) excludes only top-level `variantId`, `pricing`, `cardmarket` and `tcgplayer`. `thirdParty` and other non-null unrecognized fields survive. [`catalog.py`](../../../../../api/app/catalog.py:289) serializes the descriptor into an Edition key, uniquely scoped to its Printing by [catalog schema](../../../../../migrations/003_catalog.sql:40). Marketplace corrections can therefore appear to change physical identity.
- **Price changes affect review fingerprints.** [`fingerprint`](../../../../../api/app/catalog.py:31) hashes the entire raw record, while [ambiguity reviews](../../../../../api/app/catalog.py:265) use that fingerprint. A price change can produce another review while a physical discrepancy is already pending. A changing quote alone does not create ambiguity when descriptors otherwise remain stable. Physical/reconciliation change detection should be separated from raw provenance and quote freshness in the later design.
- **Ordinary imports preserve existing Editions.** A [withdrawn descriptor](../../../../../api/app/catalog.py:257) marks a source record ambiguous. The importer [copies previous generation membership and clears candidate descriptors](../../../../../api/app/catalog.py:281). Removing `thirdParty` without compatibility handling would generally produce pending reviews, not automatically move Holdings or replace all Editions.
- **Unknown fields cannot all be discarded.** Saved fixtures retain physical `type`, `size`, `subtype` and singular `stamp`. Arbitrary non-null fields are otherwise retained. [Plural `stamps`](../../../../../api/app/catalog.py:49) is sorted; singular `stamp` is retained unchanged. Reviewed [manual descriptor validation](../../../../../api/app/missing_cards.py:86) also accepts arbitrary fields. Classification must preserve possible physical information and reviewed extensions.
- **References extend beyond Holdings.** [Reviewed overrides](../../../../../migrations/007_missing_card_reports.sql:26) have explicit Edition references and [survive imports](../../../../../api/app/catalog.py:295). [Deprecation/replacement](../../../../../api/app/catalog_reconciliation.py:103) and [collector reassignment](../../../../../api/app/catalog_reconciliation.py:170) are separate operations. Audit approved reports, overrides, replacements, generation membership, pending move manifests and Undo payloads before describing an Edition as unreferenced. [Move manifests](../../../../../migrations/011_move_holdings.sql:10) and [Undo payloads](../../../../../api/app/moves.py:229) contain Edition references without an Edition foreign key.
- **Public contents are already copied.** [Published snapshots](../../../../../api/app/publications.py:132) embed descriptor text in `variant` and omit private Edition IDs. A private metadata correction cannot be assumed to rewrite frozen public card contents. Public quote mapping must respect snapshot/version rules independently.

The primary spot-checked normalizer exclusions, withdrawn-descriptor preservation and the published snapshot path against the current working tree. No application code changed.

## Fixture and synthetic evidence

The architect normalized the saved [three-card excerpts](tcgdex-pricing-samples.json): seven descriptors, six containing `thirdParty`, and zero same-card collision groups after removing only `thirdParty`. This is a small source sample, not persisted counts or a full-catalog census.

In a synthetic in-memory example, two otherwise identical descriptors differing only by `thirdParty` are accepted by the current normalizer; removing that field produces `CatalogError` under its [collision check](../../../../../api/app/catalog.py:52). A synthetic quote mutation changes the raw fingerprint without changing descriptors. These illustrate failure modes, not evidence that stored collisions exist.

Saved source samples reuse product IDs across normal/reverse and stamped/unstamped shadowless variants. A shared product ID, same price or same card name is not evidence that physical Editions are interchangeable.

## Accepted choice and remaining choices

The owner accepted invalidating changed/conflicting marketplace mappings until catalog-maintainer verification, withdrawing their quote/product-ID export use while preserving Holdings and published quantities. This mapping maintenance does not provide manual price-refresh controls to users.

Physical-versus-marketplace field classification, preserved-ID compatibility, collision evidence and actual-datastore preflight remain owner choices in the ticket. Conservative options are one-to-one compatibility recognition with retained immutable IDs and explicit review for ambiguous collisions. The migration mechanism cannot be selected from unavailable persisted counts; `/to-spec` must retain that preflight prerequisite if the owner chooses a conditional compatibility policy.

## Routing and limits

Laya selected architect for this high-risk identity-boundary inspection. Task `35a7e34a984b4475b714a6117b33bc4b`, attempt `36146c1d21c74eeea03e63a8a50da5cf`. The child did not edit files or delegate; the primary owns note/ticket integration. Terminal outcome records completed read-only investigation, not a successful persisted-data audit or migration.

Database aggregates, data-correction behavior, runtime concurrency and full regression checks remain unverified. No new application test suite was run for these planning artifacts.
