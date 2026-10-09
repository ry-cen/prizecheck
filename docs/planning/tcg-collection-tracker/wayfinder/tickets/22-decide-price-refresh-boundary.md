# Decide price refresh scope and workload bounds

**Parent:** [Card prices and Deck exports — decision map](../card-prices-and-deck-exports-map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Blocked by:** [Investigate TCGdex prices and Edition mapping](16-investigate-tcgdex-pricing.md), [Decide card-price presentation and Deck cost](18-decide-price-contract.md).

## Question

Given the owner's accepted access-triggered refresh and one-hour cache expiry, which views count as accessing card prices? Define eligibility for card information, rendered catalog/Holding rows, complete Deck cost and Published Deck views, including published cards no longer privately held. Set a second maximum acceptable cache age requiring a synchronous refresh attempt, the display that waits and its wait/failure limits. Record removal of all manual user refresh controls and agree shared request/workload and low-idle-cost limits, partial refresh/failure and confirmed-absence behavior, and separation from catalog-identity imports. Select the eventual mechanism in `/to-spec` after this boundary is agreed. [Marketplace metadata separation and existing Edition compatibility](23-decide-marketplace-metadata-separation.md) independently owns identity correction and price-mapping policy.

## Active completion criteria

Record the accepted [access-triggered scope](../../../../docs/adr/0006-access-triggered-price-refresh.md): under one hour use cache; one to under 24 hours show cache and refresh in background; at least 24 hours, unknown check age or no validated cache attempt refresh before showing prices. Only prices/complete Deck cost wait, at most three seconds total, then defensible cached fallback with explicit failure/age labels or unavailable if no quote exists. Include displayed card/catalog/Holding prices and complete private/Published Deck costs, including public visitors. No users have a manual price-refresh control, force-refresh action or cache-expiry override; automatic access and bounded internal retries respect expiry/backoff. Share/coalesce bounded work, apply partial successes, cache confirmed unavailable results for one hour, and retain defensible cached state after failed/ambiguous responses. No daily fallback or recurring updates for unaccessed cards. Preserve provider timestamp labels, fixed published contents, zero anonymous PostgreSQL wakeups, private-data boundaries and physical identity. Record the policy review and carry the unresolved public mechanism into its existing decision before closing this ticket.

## Historical question

Superseded by the active criteria above: decide a daily refresh universe of catalog, owned, Deck or bounded-combination Editions with owner refresh, including fixed Published Deck contents. Earlier daily and hourly-plus-daily proposals in Comments are historical proposals, not the active schedule.

## Concrete integration hazards

- The current catalog fingerprint includes the entire source response, including changing quotes. A price refresh must not silently change physical identity, quantities, deck construction or identity-review semantics.
- Refresh scope must include published cards even when they are no longer privately held, without querying the current private Deck to reconstruct public totals.
- Failed, partial or concurrent refreshes need explicit freshness/coverage behavior; one-hour cache expiry does not establish source freshness or a complete refresh SLA.

## Evidence

[Pricing investigation](../research/tcgdex-pricing-coverage.md), [repository boundary inspection](../research/pricing-and-export-code-boundaries.md). This ticket owns the previously loose refresh/cost/reconciliation question identified by architect review.

## Comments

Claimed by codex on 2026-10-08 after the owner requested the next Wayfinder ticket. Existing daily refresh, owner control, cached reads, provider-time freshness and retained-quote-on-failure decisions remain accepted. The following proposals await the owner's answers; they are not resolutions:

- Daily scope: all currently owned Editions plus Editions in active Published Deck snapshots, including cards no longer privately held. Other catalog cards use cached quotes; an authenticated card-detail visit may queue a bounded refresh for missing/old data, while catalog lists and anonymous views do not fan out into provider requests.
- Owner refresh: refresh the selected Deck's complete contents, including a Published Deck's fixed snapshot, with shared deduplication and a 15-minute per-Printing cooldown. Report queued/running/partial outcomes; opening a Deck stays cache-backed.
- Bounded work: share public marketplace quotes across collectors, fetch once per due source Printing for its mapped Editions, separate price work from identity imports, and process fair resumable batches under configurable request/time/retry caps. Attempt the due universe daily without promising complete source-fresh coverage every day; remaining work resumes on the next scheduled batch. The mechanism and measured cap values belong to `/to-spec`.
- Partial results: retain successful updates and cached defensible quotes after failures with their true age labels. A confirmed source withdrawal of the selected Edition's quote makes that Edition unavailable and lowers coverage; malformed/ambiguous responses are failures, not confirmed absence. A recent request cannot make old source quotes fresh.

The owner then asked how long fetching prices takes and suggested refreshing when prices are an hour stale before caching them. This is steering toward a one-hour cache-expiry rule, not an answer to all four original proposals. A bounded live latency check was requested. Distinguish elapsed time since a successful source check (cache expiry) from the provider quote's timestamp (price age): repeated responses with an unchanged source timestamp must not cause repeated fetches on every view or appear newly priced. The existing 48-hour source-age label remains accepted unless the owner explicitly changes it. Recommended addition under discussion: authenticated card/Deck views may queue due shared quotes after a one-hour cache expiry while immediately showing cached values; daily refresh remains a fallback for owned/published cards, and anonymous published reads retain their public-projection-only boundary.

[Price fetch latency and one-hour caching](../research/price-fetch-latency.md) records nine successful source requests: median 266 ms, range 244–290 ms, with unchanged previous-day provider timestamps. A 35-source-card serial refresh would be approximately 9.4 seconds by arithmetic, not a measured Deck latency. The revised one-hour cache proposal awaits the owner; remaining scope, manual-refresh, workload and partial-result choices have not been accepted implicitly.

The owner then accepted access-only refreshing: “lets only update cards that are accessed and have stale prices”. [ADR: access-triggered refresh](../../../../docs/adr/0006-access-triggered-price-refresh.md) records this as replacing daily refresh entirely, with the one-hour cache/source-age distinction established in the preceding exchange. This is a resolved schedule choice; remaining branches still require the owner's answers. No resolution of those branches is inferred from this instruction.

The owner subsequently requested a maximum acceptable age before synchronous refreshing. Accepted principle: two thresholds, with a refresh attempt required before presenting over-age accessed prices. Proposals awaiting answers: cache checks under one hour use the cache; checks from one hour up to 24 hours display cached values and refresh in the background; checks at least 24 hours old, unknown check age or no cached validated result wait for refresh. Only the price/cost display waits; other page content can load. Bound the entire price request to three seconds, then retain defensible cached quotes with an explicit refresh-failure/age explanation, or show unavailable when no quote exists. Coalesce requests and apply failure backoff so repeated visits cannot keep producing synchronous attempts. A successful check of unchanged old provider data resets cache-check age only, preserving source-age labels. These numeric/display/fallback choices are proposals, not resolutions.

The owner accepted this threshold/wait/fallback round with “yes lets go with that”. The three proposed answers immediately above are now accepted and recorded in the ADR and active criteria. Earlier proposals remain historical where inconsistent; additional access surfaces/public visitors, manual refresh eligibility, and confirmed-absence/negative-cache behavior still need answers. No daily fallback, link-wide prefetch or blanket catalog refresh is authorized.

The owner then accepted all three remaining choices with “yes to all” and asked whether owner meant the card/Deck owner or site owner. Clarification: the manual control belongs to the collector owning the selected Deck in their account, on its private or Published view. Other visitors receive automatic eligible refresh behavior, not that manual control. [Accepted refresh resolution](../resolutions/22-decide-price-refresh-boundary.md) records the complete contract; a bounded architect policy review precedes closure. The public refresh mechanism remains with the existing Published Deck decision rather than being selected here.

Closed on 2026-10-08 after the [architect policy review](../research/price-refresh-policy-review.md) reported no substantive findings or closure blockers. The accepted resolution satisfies the active product criteria. Local links and dependency cycles were checked; public mechanism, metadata validation and numeric workload/coordination limits retain their explicit later owners. No application implementation or tests are claimed.

Amended after closure on 2026-10-08: the owner explicitly directed that no users have manual price-refresh access. The earlier manual-button answer in Comments is historical and superseded. Active criteria, resolution, scope ADR, map and Published Deck cross-reference now specify automatic-only refresh with the accepted thresholds and backoff. The decision remains closed; no new unanswered product branch was introduced.
