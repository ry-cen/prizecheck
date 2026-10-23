# Trading beyond Friends uses one reach rule, and strangers are addressed by trader ids

**Status:** accepted on 2026-10-22. Claude decided it under the owner's delegation of technical plumbing for the [Trading map](../planning/trading/wayfinder/map.md); the owner answered the collector-facing questions on 2026-10-23. It extends [ADR 0014](0014-friend-reads-and-two-owner-loans.md) and [ADR 0015](0015-trades-share-the-promise-invariant-and-friend-reads.md). The full reasoning is in [the Stage 2 plumbing resolution](../planning/trading/wayfinder/resolutions/decide-stage-2-plumbing.md).

Stage 1 let only Friends trade, so every cross-collector read could ask one question, "is this a Friend?", and every collector was addressed by a user id or Handle that the other side already held. Stage 2 lets collectors who are not Friends find each other by distance, message each other and trade. That needs a wider answer to "may these two trade or talk now?", and it must not let a stranger learn who another collector is or where they live. Friend commands accept a user id, and Friends' lists show Handles, so a stranger who held either could link a discovery row to a person.

**Decision.**

- **One reach rule.** Every cross-collector Trade read and every contact step asks one SQL function, `trade_reach` (migration 148), whether two collectors may trade or talk now. The answer is yes for Friends, for a pair with a conversation, or for two open-discovery collectors within 50 mi of each other's zip centroids. It is never yes across a Block, for a suspended collector, for oneself or for a deleted collector. Python reaches it only through `discovery.reach` and `discovery.reach_one`, taken after the step's locks. A conversation, once started, keeps working after discovery is switched off or either side moves; it ends only with a Block, suspension or deletion.
- **In the choke point.** `social.friend_copies` filters its Trade List and wants statements through `trade_reach`, beside `friends_of`, as ADR 0015 promised, so Stage 2 adds a second filter and not a new module. The Collection read stays Friends-only on `friends_of`, so a stranger never reaches a Collection. Contract tests confine `trade_reach(` and `nearby_collectors(` to `friend_copies` and `discovery`, and the zip and message tables to their own modules.
- **Trader ids.** Strangers are addressed by a random, stable `collector_profile.trader_id`. They never receive a user id or a Handle, and no route keyed by a user id or Handle ever answers a non-Friend's `trader_id`. Each response schema is allowed one kind of id, and an OpenAPI test checks the table. An unknown `trader_id` and an unreachable one answer byte-identically, and a Block reads to the blocked side like a suspension.
- **Distance leaves the database only as a band.** `distance_band` answers one of four bands or nothing beyond 50 mi, and no response carries miles, a coordinate or another collector's zip. Candidate caps and in-band order never rank by distance: the cap orders by band and then a per-viewer hash, and the visible order inside a band is by Display Name. Zip centroids come from a data migration with pinned source hashes. Zip changes are limited to three in a rolling 24 hours.
- **Freshness is polled** through one cheap pulse read, not pushed, until the deployment can carry streaming connections.
- **Lock order.** Advisory command locks, then `inventory_owner` rows in ascending `user_id`, then `loan`, `trade` and finally `conversation` rows. Sends now lock both owners, and the name-following triggers fire in an order that respects it.

**Rejected.**

- **A stranger module parallel to the choke point.** It would be a second place that reads another collector's Trade List and wants, which ADR 0015 forbids, and the Friend and stranger filters would drift.
- **Exposing user ids to strangers.** Friend commands accept a user id, so holding one would let a stranger send a Friend Request and read the target's Handle.
- **Storing distances or ranks.** A stored or ranked distance is finer than the band the product shows and would leak through ordering or caps.
- **PostGIS.** The distance is a haversine between two stored points, and a bounding-box prefilter over about 33,000 zips is enough in plain SQL.
- **WebSockets or server-sent events now.** The gateway proxies buffered, signed requests and the deployment provider is deferred ([ADR 0002](0002-defer-deployment-provider-selection.md)), so streaming is not available.

**Consequences.**

- `trade_reach` replaces `friends_of` in Stage 1's measured statements. The 200-Friend capacity test must pass again, and if it does not, `friends_of` stays for Friends and only the suspension join is added.
- A null `TradeParty.collector_id` no longer means a deleted account. It also means "not a Friend", and the web uses `trader_id` and `available`.
- Band edges are not a privacy control. The controls are that only opted-in collectors can query, the probe point is the viewer's own zip centroid, zip changes are limited and output is bands only. A patient attacker with one account learns at most a target's zip, and many accounts multiply that. This is recorded for the privacy review.
- Looking someone up by Handle and blocking them can still link a Handle to a band through the Blocked relation. The owner accepted it as a small residual, bounded by the command limits and recorded in the resolution.
- Sends lock the recipient's owner row, which briefly holds off the recipient's inventory commands, the same cost as a Counter today.
- Polling load grows with open tabs. The pulse can later answer 304 on an unchanged watermark.
- Migrations 145 to 149 are not purely additive: 145 widens a CHECK, 147 adds triggers and backfills, and 148 sets existing Block rows. An older API build keeps working, and migrations deploy first.
- There is no age rule, so sales between strangers and to minors are not restricted. This is recorded for the liability-notice review and is not a plumbing decision.
