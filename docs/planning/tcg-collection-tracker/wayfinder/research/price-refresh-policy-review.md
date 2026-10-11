# Access-triggered price policy review

Reviewed on 2026-10-08 by a scoped architect agent; integrated by the primary. Scope: the accepted [refresh product contract](../resolutions/22-decide-price-refresh-boundary.md), its ticket, [scope ADR](../../../../adr/0006-access-triggered-price-refresh.md) and the outstanding Published Deck decision. Document-only review, not implementation, capacity or security test evidence.

After this review, the owner removed the manual price-refresh control for all users. The primary updated active planning criteria and checked their links/consistency. That narrower amendment did not select a new architecture and was not separately reviewed by the architect; earlier manual-control wording in historical discussions is superseded by the active resolution.

## Outcome

No substantive findings or closure blockers. The refresh decision can close once this review is recorded. The reviewer confirmed separate cache-check/source-age rules, a three-second entire-display budget, independent successful results, a negative cache that cannot resurrect superseded quotes, bounded/coalesced retries, public-only inputs and publication/version constraints. The revised public criterion supersedes the previous provider-independent-read requirement only for the price display.

A minor stale cross-reference in the earlier price resolution was identified; the primary had already updated it to the accepted refresh contract during integration. No application files changed.

## Deferred requirements with explicit owners

- [Published Deck prices and snapshot compatibility](https://github.com/ry-cen/prizecheck/issues/39): concrete public storage/coordination, old snapshots, snapshot-specific totals, revocation/version correctness and architect review of that design. The policy does not prove an eventual public architecture satisfies zero PostgreSQL wakeups.
- `/to-spec`: numeric request/concurrency/backoff limits, queue lifetime, in-flight coordination, and protection against late/out-of-order shared-cache writes. The three-second display limit is not a provider execution or throughput guarantee.
- [Marketplace metadata separation and existing Edition compatibility](https://github.com/ry-cen/prizecheck/issues/42): exact mapping and validation that distinguishes confirmed source absence from malformed/ambiguous responses.

These are later design/implementation prerequisites, not unanswered product choices in the refresh decision. No runtime, provider, capacity, privacy/race or destination tests were performed by this review. The earlier latency sample measures only nine source requests.

## Routing and primary verification

Laya selected architect for high-risk policy review; the primary followed that route. Task `36ff89ce051b4f37b0664f02ca68d50d`, attempt `f766f177682944e093acc4dd85081aa9`. The lifecycle was recorded with terminal success and validation not applicable for this read-only review. The child did not delegate or edit files.

The primary checked local links and the decision dependency graph. No application tests apply to these planning-only Markdown changes. No commit or push occurred.
