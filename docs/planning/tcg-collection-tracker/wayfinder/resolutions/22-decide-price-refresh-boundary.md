# Resolution — Access-triggered prices with bounded refresh

**Ticket:** [Decide price refresh scope and workload bounds](https://github.com/ry-cen/tcg-tracker/issues/41).

**Decision:** the owner selected access-only refresh, accepted the one-hour/24-hour/three-second policy with “yes lets go with that”, and accepted the remaining access/absence choices with “yes to all”. Recorded on 2026-10-08. The owner then explicitly removed manual price refreshing for every user; this supersedes the earlier manual-control answer.

**Review:** [Architect policy review](../research/price-refresh-policy-review.md) found no substantive findings or closure blockers before ticket closure. The later removal of the manual control was integrated and checked by the primary; no additional architecture was selected or reviewed. This is an accepted product contract, not a selected public refresh architecture or implemented feature.

## Access and expiry

Refresh prices only for accessed cards. Displaying card prices in card information or currently rendered catalog/Holding rows counts as access. A private or Published Deck view accesses every included card needed for its complete Estimated Deck Cost, independent of row pagination. A link to another card or Deck alone does not count: do not refresh every linked destination or automatically prefetch it. Owning, publishing or previously accessing a card does not authorize recurring refresh; there is no daily fallback or whole-catalog price sweep.

Use elapsed time since the last successful validated source check:

| Cache-check age | Display and refresh |
| --- | --- |
| Under one hour | Use the cached result. |
| At least one hour but under 24 hours | Show cached prices; refresh eligible accessed cards in the background. |
| At least 24 hours, unknown check age, or no validated cached result | Attempt refresh before presenting the accessed prices. |

Only the price and Deck cost displays wait, showing Checking prices while the rest of the page loads. The entire interactive price request has a **three-second** wait budget, not three seconds per card or retry. On timeout or failure, display defensible cached quotes with an explicit refresh-failure/age explanation. If no defensible quote exists, show unavailable, not zero. Successful results can replace cached values independently; any total must still include all Deck quantities in its coverage denominator and label its actual mixed quote ages.

A confirmed unavailable result is a validated cache result, not an uninitialized cache. Cache that absence for one hour; show the Edition as unpriced and exclude it from the subtotal while retaining its copies in the Pricing Coverage denominator. After expiry, access makes it eligible for another attempt. Once confirmed unavailable, a later failure must not revive an older quote that was superseded by that result. An absent field, malformed response or uncertain mapping is not automatically a confirmed absence; validation/mapping rules belong to the separate metadata decision.

## Source age and exact Editions

Fetching unchanged prices successfully resets cache-check age, not provider quote age. Continue using the provider pricing timestamp for per-card and aggregate freshness: more than 48 hours is stale; absent/unusable source time is Age unknown. These quote states and defensible retained quotes remain included in the priced subtotal and coverage under the accepted [card-price contract](18-decide-price-contract.md). A failed attempt never becomes a successful check.

Unspecified Variants and uncertain marketplace matches remain unpriced. Cache freshness or another Edition's quote cannot validate a physical match. Price refresh must not change Variant Descriptors, Card Edition identity, Holdings, quantities, reviewed corrections or Deck construction. It is separate from catalog identity import/reconciliation scheduling. [Marketplace metadata separation and existing Edition compatibility](https://github.com/ry-cen/tcg-tracker/issues/42) owns that correction/mapping contract.

## Shared and bounded work

Share public marketplace quote results across collectors and deduplicate concurrent work by the reviewed source Printing/reference so multiple copies, Editions and Decks can share a fetch where their source response is the same. Select each exact Edition's quote independently from that response. Sharing quotes does not share private Deck contents or owner inventory metadata.

Apply bounded batches, concurrency, request/time limits, fairness and retry backoff. Coalesce duplicate automatic access requests. An expired cache does not permit a new synchronous attempt on every visit during an outage; backoff/in-flight state must serve the labeled fallback without repeatedly consuming the three-second wait. Do not represent failed attempts as fresh source checks to achieve this. Work already requested by access may finish or retry within its bounds after the display's wait ends; this does not create a periodic sweep of unaccessed cards.

`/to-spec` selects the mechanism, numeric workload/retry limits, queue lifetime/in-flight coordination, protection against late/out-of-order cache writes and measured capacity. The three-second interactive wait is a product budget, not a claim every Deck can fully refresh within it. The [nine-request latency sample](../research/price-fetch-latency.md) measured source fetches only, not a production Deck endpoint or sustained workload.

## Automatic refresh and public visitors

No users, including Deck owners and site administrators, have a manual Refresh prices control or user-callable force-refresh action. All feature refreshes are automatically triggered by access under the accepted cache eligibility and backoff rules, including bounded internal retries. Reloading or revisiting a page must not override a fresh cache or failure backoff. Explain cached/in-progress/backoff status instead of implying a fresh provider quote was obtained.

Published Deck visitors can trigger the same automatic access policy. Use only the active published snapshot's sanitized cards and quantities and a public quote projection/cache, with **zero PostgreSQL wakeups and no private inventory reads** for anonymous access. The public page and non-price contents remain available independently of TCGdex; its price display may wait up to the accepted three seconds before fallback. Anonymous refresh eligibility must be validated and rate-limited; it is not an arbitrary card-fetch endpoint or a manual-force refresh control.

The owner has selected this public behavior, not its mechanism. [Published Deck prices and snapshot compatibility](https://github.com/ry-cen/tcg-tracker/issues/39) remains responsible for public-only coordination/storage, safe old snapshots, privacy, revocation and publication-version correctness, and architect review of the concrete design. Delayed results must not resurrect revoked publications, overwrite newer content/visibility or attach a total to the wrong snapshot. A global per-card quote and a snapshot-specific aggregate are different data needs.

## Later handoff acceptance examples

- At 59 minutes since a successful check, viewing either one copy or several copies of the same Printing uses cache. At one hour, access queues one shared eligible fetch and shows cached prices.
- At exactly 24 hours, only the price/cost display waits. After three seconds, the request shows any successful updates and labeled defensible fallback for failed/pending entries, with complete copy coverage and true source ages; the rest of the page has already loaded.
- A source quote timestamp remains old across a successful fetch: update cache-check age and preserve the original quote age. The next visit within an hour does not fetch it again solely because the provider timestamp is old.
- A validated unavailable Edition remains unpriced through failed retries; other successfully priced Editions can update. Negative cache prevents repeated unavailable fetches for one hour.
- Several visitors viewing the same Deck or overlapping Decks share eligible fetch work; a provider outage uses backoff rather than repeated blocking requests.
- A Published Deck contains cards no longer privately held: visitor pricing still uses the snapshot, with no private database access. Republish/revoke during refresh cannot attach an obsolete public total or recreate a revoked public projection.
- Neither Deck owners, other collectors, anonymous visitors nor site administrators have a manual price-refresh control. Eligible automatic access refresh works under the same cache/backoff rules; page reloads and concurrent views do not bypass them.

These are criteria for the later spec and tests, not passing implementation evidence. No application code, feature spec, implementation tickets, commit or push is produced by this resolution.

## Planning verification

The primary checked artifact links and the decision dependency graph. The scoped architect reviewed policy consistency and identified no blockers; concrete public architecture and capacity/race tests remain later requirements with the explicit owners above. No further provider calls or application tests were needed to record the final owner decisions.

## Historical manual-control answer

The earlier accepted round and closure clarified the proposed manual button as belonging to the collector owning the Deck. The owner's subsequent explicit instruction removed it for all users. [The amended scope ADR](../../../../adr/0006-access-triggered-price-refresh.md) and the active sections above hold the current behavior; this historical answer does not authorize a manual refresh feature.
