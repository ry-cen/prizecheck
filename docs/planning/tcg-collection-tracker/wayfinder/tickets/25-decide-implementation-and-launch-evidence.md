# Decide implementation acceptance and launch evidence

**Parent:** [Card prices and Deck exports — decision map](../card-prices-and-deck-exports-map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** Codex primary

**Blocked by:** [Decide card-price presentation and Deck cost](18-decide-price-contract.md), [Decide Deck export precision and fallback behavior](19-decide-deck-export-contract.md), [Decide Published Deck prices and snapshot compatibility](20-decide-published-price-contract.md), [Verify live price and export fixtures](21-verify-price-and-export-fixtures.md), [Decide price refresh scope and workload bounds](22-decide-price-refresh-boundary.md), [Decide marketplace metadata separation and existing Edition compatibility](23-decide-marketplace-metadata-separation.md), [Decide export metadata provenance and correction](24-decide-export-metadata-contract.md).

## Question

Before `/to-spec` and `/to-ticket`, which acceptance scenarios and evidence belong to implementation checks; which target-datastore correction preflight must occur before selecting or executing corrections; and which real destination, physical-compatibility, and owner-walkthrough proofs are launch gates? Agree honest supported-case labels and launch gates that preserve the known limits of the bounded price/export fixtures.

## Scope

Convert the resolved product and public-design decisions into verifiable acceptance and launch evidence without writing a feature specification, implementation tickets, code, tests, migrations, provider selection, or numeric workload limits. Preserve the distinctions between:

- automated implementation checks for pricing, coverage, refresh, mapping invalidation, public projection/version/revocation behavior, exports, and privacy;
- mandatory target-datastore inspection before an Edition identity/compatibility correction is selected or executed, under the accepted compatibility contract;
- launch evidence for actual Live and Mass Entry destination behavior, exact physical/product matching, provider behavior, and an owner walkthrough.

This ticket must label supported cases only where evidence warrants it. Bounded fixtures inform scenarios but do not prove universal catalog coverage, exact physical matching, successful Live import, or production capacity.

## Accepted boundary

The owner accepted all three recommendations on 2026-10-08 with “yes to all.” [The resolution](../resolutions/25-decide-implementation-and-launch-evidence.md) separates automated implementation completion, mandatory target-datastore correction preflight, and launch gates. It does not select a provider, numeric workload limit, schema, reference encoding, preflight procedure, implementation, or passing evidence.

## Evidence

[Bounded fixture investigation](../resolutions/21-verify-price-and-export-fixtures.md), [Published Deck projection resolution](../resolutions/20-decide-published-price-contract.md), and the resolved price, refresh, compatibility, export, and metadata contracts listed in **Blocked by**.

## Comments

2026-10-08 — Created as the final Wayfinder planning decision before `/to-spec` and `/to-ticket`, unless new policy uncertainty appears. No implementation, evidence check, provider selection, or numeric capacity decision is authorized by its creation.

2026-10-08 — Claimed by Codex primary at the owner's request. Implementation checks, correction-preflight gates and destination/launch evidence remain decisions to agree; claiming the ticket does not mark those checks complete.

## Historical first owner round

1. Implementation tickets may close once the required automated regression gate and feature checks pass with tested-code/environment evidence: exact Edition quantities/pricing, full Deck coverage, unknown/absence/failure states, refresh thresholds and total deadline, export completeness/fallbacks, shared state, mapping invalidation, frozen public versions/revocation/recovery, and anonymous database isolation. Real destination and production proofs stay visibly pending in the launch checklist. The accepted target-datastore preflight remains mandatory before selecting or executing any Edition compatibility correction; test databases cannot satisfy it.
2. Before enabling a destination integration for users, require actual application-generated exports to succeed in that destination for the cases claimed as supported. Verify Live imports and special-case rules actually offered; verify Mass Entry quantities/product matches and text fallback. Establish exact physical Edition/quote-variant evidence for priced cases; do not imply Mass Entry guarantees finish or condition. Reference comparisons and mocked provider responses alone do not satisfy these proofs. Unknown/unsupported cases retain existing unpriced/blocked/full-text behavior; universal catalog coverage is not a launch requirement.
3. Require an owner walkthrough of the feature's card-price/private-Deck/Published-Deck/export/fallback/republish/revoke workflows before launch, plus deployed-environment evidence for the accepted automatic-refresh performance, shared workload limits and anonymous privacy behavior. Numeric limits and the measured procedure are selected in the later specification; this discussion does not claim that any gate has passed.

2026-10-08 — Owner accepted all three recommendations with “yes to all.” They are recorded in the linked resolution. No implementation check, target-datastore preflight, destination proof, walkthrough, deployment observation, provider selection, or workload/capacity limit has passed or been selected by this closure.

2026-10-08 — Laya routing task `5cdb4b3842bf469b8942f02217bf5d80` recommended technical-writer work but selected low-confidence orchestrator; logging encountered a permission error. The primary used the technical-writer role for established prose and retained integration/validation. No escalation was requested.
