# Card prices and Deck exports launch checklist

**Status:** pending. No code, test, datastore, destination, walkthrough, deployment, or release approval is recorded here.

## Implementation evidence

- [ ] Run the full regression gate, including `npm run verify`, and record tested source, procedure, and environment.
- [ ] Verify exact Edition pricing, decimal arithmetic, full-quantity coverage beyond pagination, provider-age versus check-age, confirmed absence, failure fallback, and no quote resurrection.
- [ ] Verify automatic one-hour/24-hour/three-second behavior, no user force refresh, coalescing, admission, backoff, leases, fencing, overload labels, and complete-cache coverage behavior.
- [ ] Verify Live grouping/blocking and Mass Entry link/text/clipboard behavior for each supported matrix case, including empty, incomplete, non-60, oversized, manual, retired, and unsupported cases.
- [ ] Verify mapping invalidation/quarantine, reviewed correction ordering, independent Live eligibility, fixed Published Deck content, token/version/digest guards, revoke/republish/recovery, unchanged discovery, and anonymous cookie-bearing zero-database routing.
- [ ] Run public-adapter conformance against filesystem and HTTP adapters with multiple API/workers, compare-and-swap, crash recovery, delayed work, and source outage.
- [ ] Run capacity scenarios for 60-copy, 1,000-Edition, and 25,000-Edition Decks; 100 overlapping/disjoint callers; queues, lease expiry, invalidation, revoke, and republish. Record environment, source concurrency, dedupe, queue age, retries, storage, coverage, and latency.
- [ ] Demonstrate initial cached ordinary-price p95 under 500 ms and expired result/fallback within three seconds while non-price content stays available with blocked upstream.

## Target-datastore correction preflight

- [ ] Before selecting or executing any existing-Edition identity or compatibility correction—including descriptor cleanup, compatibility keys/aliases, collision resolution, or reference retargeting—complete a read-only actual-target-datastore preflight and reviewed correction plan. Synthetic fixtures and disposable databases do not satisfy this gate.
- [ ] Record affected Editions, possible correspondence/collisions, catalog generations, Holdings, reviewed overrides/reports, replacements/deprecations, pending moves/Undo, and Published Deck references without exposing private inventory or credentials.
- [ ] Preserve immutable IDs, references, reviewed overrides, and Undo. Do not select, authorize, or execute a correction until the reviewed preflight establishes it.

## Destination and physical-match gates

- [ ] For every case labeled supported, capture application-generated Live text and demonstrate a successful import into Pokémon TCG Live. Record a separate result for each supported category/rule case.
- [ ] For every offered Mass Entry case, demonstrate actual quantity/product results and complete text fallback. Ask the user to review finish and condition; do not purchase.
- [ ] Populate the Live derivation set table (`LiveRulesV1.SET_CODES` in `api/app/catalog_targets.py`, shipped empty) only with source-set → Live set-code entries backed by positive reviewed evidence, then activate the Live rule. Until then Live auto-qualification covers no Printings and Live eligibility comes only from maintainer `correct` decisions. Never guess `tcgOnline` codes.
- [ ] Review the marketplace finish → quote-variant table and activate the matching rule only after the exact physical Edition/quote-variant evidence below is established.
- [ ] Confirm against live TCGdex before enabling refresh: how a missing price is represented (the code treats only a matching block with null or missing `marketPrice` as confirmed absent), whether 429/503 responses carry Retry-After, whether `Content-Encoding` is ever sent, that `pricing.tcgplayer.updated` is timezone-aware ISO text, and that real `variants_detailed` entries still match the published Edition descriptors. Descriptors include `thirdParty` IDs (ADR 0007), so a newly added marketplace ID surfaces as `lookup_drift` until it is reviewed.
- [ ] Establish defensible exact physical Edition and quote-variant matching evidence before pricing a supported case.
- [ ] Keep unknown or unsupported cases unpriced, blocked, or on complete-text fallback. Do not claim universal coverage, untested destination acceptance, or a finish/condition purchase guarantee.

## Owner walkthrough and deployed observations

- [ ] Walk through card information, private and Published Deck pricing, exports, unknown/fallback states, republish, and revoke with the owner.
- [ ] Observe deployed total three-second budget, shared cache/coordination/backoff and workload bounds, anonymous cookie-bearing no-PostgreSQL/privacy behavior, cross-replica behavior, and recovery.
- [ ] Stage Live support only after verified derivation inputs/rules and actual Live acceptance; stage Mass Entry support after its product/text acceptance; enable prices only with exact physical Edition/quote-variant evidence. Keep these gates independent so an unavailable price does not disable an otherwise supported export.

## Sources

The authoritative behavior is the [feature specification](spec.md), completed Wayfinder resolutions 18–25, and ADRs 0002, 0003, 0005, and 0006. Deployed provider selection, remaining schema/reference encoding details, and evidence procedures remain implementation decisions; no completion is implied by this checklist.
