# Resolution — Published Deck price projection and compatibility

**Decision:** owner accepted the simplified shared-model planning boundary on 2026-10-08 by moving to the next Wayfinder ticket after the architect review.

**Ticket:** [Decide Published Deck prices and snapshot compatibility](https://github.com/ry-cen/tcg-tracker/issues/39).

## Published rows and shared facts

A Published Deck remains a sanitized, frozen snapshot. Each immutable published row carries an opaque public Edition reference with its frozen quantity and display descriptor/name. The reference resolves shared sanitized public Card Printing/Card Edition metadata; it is not an internal UUID, private Holding, owner linkage, or anonymous database lookup. Publish and republish record the reference together with frozen content in the durable publication envelope before that envelope becomes active. Recovery replays both.

The repository's shared Edition model remains the source of the physical association: one Edition belongs to one Printing, while a Holding counts that Edition in an owner's storage leaf. Private Deck edits never replace a Published Deck's rows or quantities. The previously proposed per-snapshot association sidecar is historical and is not part of the accepted boundary.

One shared logical quote/coordination store serves private and public views. Quotes and confirmed unavailability are exact to an Edition plus mapping revision. There are no per-Deck quote records or stored Deck aggregates. Compute Published Deck totals and coverage on read from every frozen quantity and the eligible shared quotes.

## Mutable metadata, refresh, and public safety

Latest verified target-specific metadata and deterministic Live rules apply automatically to the same fixed published Edition. Changed or conflicting marketplace mappings immediately quarantine cached quote/product-export use; only an ordered reviewed correction can restore it. Live eligibility remains independent. A refresh may write only its original Edition/mapping-revision result under bounded leases, backoff, and monotonic attempt fences. It never writes publication content, token state, or visibility.

The active token/version/frozen-content digest, public Edition reference, and current eligibility are revalidated before a public response. The UI discards a stale-version result. Revocation, republish, delayed work, replay, and recovery cannot revive a token, attach data to newer frozen content, or clear a newer invalidation.

Anonymous reads use only public projections, with zero PostgreSQL wakeups and no private inventory/session access. Nested public price routes require explicit gateway handling, including cookie-bearing requests. The public price path shares one total three-second deadline for all reads, coordination, provider work, revalidation, and aggregate calculation. Non-price page content remains independent. Quote updates do not churn the snapshot/discovery manifest or its cursor revision. Discovery remains its existing title/card-name summary search without price fetching, filtering, or sorting.

## Legacy snapshots and exports

For a legacy row without a public Edition reference, prove the association only from frozen row content and preserved reviewed evidence. Prove Printing independently from Edition: a proven Printing can support Live derivation where historic finish remains unknown; quote and product-export eligibility still require a proven Edition/finish. If it cannot be proven, keep the page readable, omit its price, block the affected complete Live export, and retain complete Mass Entry text fallback. Never use a current private Holding, guess, or rewrite frozen public descriptors. Republish captures a current Deck; it does not silently repair a legacy snapshot.

## Evidence and handoff

The completed read-only architect review (task `a514454542f348a28273eca75f185a03`, attempt `3c49162f1b73494d875bcc25628f54d2`) found that the existing shared Printing/Edition/Holding model supports this simpler boundary. [The design note](../research/published-price-projection-design.md) records source evidence and retains the retired sidecar proposal as history.

No provider, numeric workload limit, public-reference encoding, schema/migration, application code, or implementation evidence was selected or performed. Actual datastore correction preflight, destination acceptance, exact physical matching, and owner walkthrough evidence remain the next handoff decision.
