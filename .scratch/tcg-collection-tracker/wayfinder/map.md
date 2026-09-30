# Pokémon TCG Collection Tracker MVP decisions

**Label:** wayfinder:map

## Destination

A technically validated MVP specification and tracer-bullet ticket set. Product, data, and interaction decisions are recorded; deployment provider selection is deferred until the application shell and workload evidence exist.

## Notes

- Preserve the approved product requirements, but revise implementation decisions when research or prototypes expose a problem.
- Produce a lightweight interactive prototype of the core Collection, Location, and Deck workflow before locking its interaction contract.
- Target less than $10/month in idle hosting cost, excluding the domain name and separately itemized request/email usage.
- AWS is a candidate, not a constraint; compare it with credible managed alternatives before choosing the hosting topology.
- Validate the architecture for 1,000 registered users, 200 monthly active users, 25,000 distinct Holdings for a heavy collector, and 10,000 public Deck views per month without re-architecture.
- Bulk transfer must support an unrestricted number of selected Card Editions as one all-or-nothing operation; this favors a relational transaction unless evidence supports an equally simple alternative.
- The MVP supports English catalog records, inventory, and deck checking only. Japanese and cross-language Card Identity mapping are deferred.
- Every session should consult the Wayfinder, grilling, and domain-modeling skills; research and prototype tickets must also consult their corresponding skills.
- The current source specification and implementation tickets live one directory above this map. They are inputs and may be replaced when the map reaches its destination.
- Planning only: this map resolves decisions and validates the spec; it does not implement the application.

## Decisions so far

Current deployment status: [ADR 0002](../../../docs/adr/0002-defer-deployment-provider-selection.md) defers provider selection. Earlier hosting entries below are historical; React/TypeScript/Vite, Python/FastAPI, PostgreSQL, and Better Auth remain the application stack.

<!-- Closed decision tickets are indexed here by linked name and one-line gist. -->

- [Prototype the core physical-inventory workflow](tickets/03-prototype-core-inventory-workflow.md) — Use the approved Variant F file-browser model: leaf-only quantity Holdings, thumbnail-stack selection, destination-only Move, immediate drag, and atomic Undo.
- [Validate TCGdex card identity and variant coverage](tickets/01-validate-tcgdex-card-identity.md) — Treat TCGdex as an incomplete language-specific catalog source; own Card Edition variant identity, preserve unresolved Basic Energy classifications, and synchronize through staged full generations.
- [Find an authoritative cross-language Card Identity source](tickets/12-find-cross-language-card-identity-source.md) — No complete authoritative low-cost English↔Japanese name map is available, so launch with English-only catalog and deck checking while retaining a future-compatible Card Identity hierarchy.
- [Decide Card Edition and Card Identity](tickets/04-decide-card-edition-identity.md) — Use Card Identity → language-specific Card Printing → variant-specific Card Edition; group English Printings by conservatively normalized exact name and protect Holdings through immutable application identities and reviewed overrides.
- [Assess Limitless TCG as a Card Identity and Printing source](tickets/13-assess-limitless-card-identity-source.md) — Limitless groups narrower same-card reprints and offers no documented card-data feed, so use it only as a manual research aid and derive English Card Identity from TCGdex names.
- [Validate the sub-$10 AWS cost envelope](tickets/02-validate-aws-cost-envelope.md) — AWS's non-database serverless services fit comfortably below $10, but the validated DynamoDB estimate is no longer selected and Aurora requires measured awake-time evidence before its relational topology can claim the same.
- [Compare sub-$10 relational hosting options](tickets/11-compare-relational-hosting-options.md) — Compared low-cost provider candidates; deployment selection is now deferred by ADR 0002.
- [Decide the core Collection, Location, and Deck interaction contract](tickets/08-decide-core-interaction-contract.md) — Use Locations, Collection, and Decks as the primary views; preserve the approved thumbnail-stack file browser, explicit Add/Move/Remove actions, `Unsorted` onboarding, mobile control parity, Undo, and non-recursive deletion safeguards.
- [Decide the public Deck snapshot and privacy contract](tickets/09-decide-public-deck-contract.md) — Publish sanitized current-version snapshots at revocable random URLs; support opt-in Listed discovery and default-Unlisted sharing while excluding all owner and Location data and clearly limiting MVP deck checks.
- [Decide catalog ingestion and search architecture](tickets/05-decide-catalog-architecture.md) — Use owner-initiated background English pulls, validated atomic PostgreSQL promotion with review of ambiguous changes, and indexed cursor search with images and a visible last-pull timestamp.
- [Decide fallback for missing English catalog records](tickets/14-decide-missing-english-catalog-fallback.md) — Allow owner-reviewed manual English Printings and Editions from private collector reports, publish approvals immediately, and preserve provenance, Holdings identity, and honest deck-check results.
- [Decide the runtime, authentication, and hosting topology](tickets/06-decide-aws-runtime-topology.md) — Historical Cloudflare topology superseded by ADR 0002; preserve owner-only launch, manual CI-checked releases, backups, and quota warnings across providers.
- [Decide the relational transactional inventory model](tickets/07-decide-inventory-data-model.md) — Use owner-serialized PostgreSQL mutations, leaf-only Holdings, atomic unrestricted bulk transfers, revision-bound pagination, derived Collection totals, and five ten-minute Undo actions with lazy cleanup.
- [Decide the evidence required for implementation readiness](tickets/10-decide-readiness-evidence.md) — Separate a complete implementation handoff from live launch proofs, with concrete correctness, privacy, recovery, scale, performance, cost, and owner walkthrough gates.
- [Revise the MVP spec and tracer-bullet tickets](tickets/15-revise-mvp-spec-and-tracer-tickets.md) — Published the glossary-aligned MVP spec; the implementation backlog was rebuilt as eighteen approved vertical slices, with provider selection deferred.

## Out of scope

- Implementing the web application or AWS stack during this Wayfinder effort.
- Full Pokémon Standard legality, Japanese or other additional languages, imports/exports, image recognition, valuation, grading, inventory history, collaboration, or native mobile applications.
