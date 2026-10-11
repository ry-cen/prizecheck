# Resolution — Implementation acceptance and launch evidence

**Decision:** owner accepted all three questions with “yes to all” on 2026-10-08.

**Ticket:** [Decide implementation acceptance and launch evidence](https://github.com/ry-cen/tcg-tracker/issues/44).

## Implementation completion evidence

Implementation completion is distinct from launch. Implementation tickets must provide tested source, procedure, and environment evidence for the accepted contracts, including meaningful scenarios for:

- exact Edition quantities and full Deck pricing coverage despite UI pagination;
- unknown, confirmed-unavailable, and failed-price states; 48-hour provider quote age distinct from successful-check age;
- one-hour/24-hour/three-second automatic refresh thresholds, with no user force-refresh path;
- shared quotes, bounded/coalesced work, backoff, and fenced late writes;
- mapping invalidation with independent Live/marketplace eligibility;
- complete export grouping and fallbacks, unsupported blocking, empty/non-60/large Deck behavior, and honest clipboard-success reporting;
- fixed Published Deck contents, version/revoke/recovery behavior, gateway classification, and zero anonymous PostgreSQL access.

Run the full `npm run verify` regression gate as part of the later implementation work. It was not run or passed for this planning decision. Tests must identify the actual source, procedure, and environment; passing synthetic fixtures alone does not establish launch compatibility.

## Correction preflight

Before selecting or executing any Edition identity/compatibility correction, inspect the actual target datastore as required by the accepted compatibility policy. Synthetic databases and fixtures are not that preflight. Preserve immutable IDs, references, reviewed overrides, and Undo behavior. No correction has been selected, authorized, or executed by this decision.

## Launch gates

Before enabling each destination integration, verify the actual application-generated output in that destination. For Pokémon TCG Live, capture the exported text and demonstrate successful imports with examples covering the rule/category cases claimed as supported. For TCGplayer Mass Entry, demonstrate quantity/product results and text fallback for the offered cases. The two destinations have independent acceptance gates. Establish defensible exact physical Edition/quote-variant evidence before pricing a case, including evidence-backed matching rules under the accepted metadata contract. Do not claim universal coverage, destination acceptance for unsupported cases, or a finish/condition purchase guarantee; unknown or unsupported cases retain their accepted unpriced, blocked, or complete-text fallback.

Before launch, the owner walkthrough covers card information, private and Published Deck pricing, exports, unknown/fallback states, republish, and revoke. Deployed-environment observations must cover the total three-second price budget, cache/shared coordination/backoff and workload bounds, anonymous no-PostgreSQL/public privacy behavior, and recovery. Support labels are staged only when those corresponding proofs exist; they are not guessed from bounded fixtures or reference comparisons.

## Handoff boundary

Provider selection, numeric workload/coordination limits, schema/reference encoding, exact preflight procedure, and evidence execution belong to `/to-spec` and later implementation/launch work. Nothing in this resolution is passing implementation, datastore, destination, physical-match, walkthrough, or deployment evidence.

## Evidence

[Bounded fixture investigation](21-verify-price-and-export-fixtures.md), [published projection resolution](20-decide-published-price-contract.md), and the resolved price, refresh, compatibility, export, and metadata contracts referenced by the ticket. The prior fixture limits remain in force.
