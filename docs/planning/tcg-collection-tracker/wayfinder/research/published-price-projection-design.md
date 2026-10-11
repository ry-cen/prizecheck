# Published price projection design

**Status:** accepted planning proposal; no implementation approved or performed.

**Ticket:** [Decide Published Deck prices and snapshot compatibility](https://github.com/ry-cen/prizecheck/issues/39).

**Latest review routing:** task `a514454542f348a28273eca75f185a03`; completed attempt `3c49162f1b73494d875bcc25628f54d2`.

**Scope:** records the current simplified proposal for stable Published Deck card references, shared quotes, and public refresh isolation. It selects no provider, schema, migration, endpoint, numeric workload limit, or application change.

## Established decisions

- A Published Deck is a sanitized snapshot rather than a live private Deck or Location. Published rows and quantities remain fixed until republish; current private Holdings never replace them ([context](../../../../../CONTEXT.md), [public snapshot resolution](../resolutions/09-decide-public-deck-contract.md)).
- Automatic price refresh is access-triggered: use cache under one hour; refresh in the background from one to 24 hours; at hard expiry, the whole price/Deck-cost interaction has a three-second maximum. No user can force a refresh ([ADR 0006](../../../../adr/0006-access-triggered-price-refresh.md), [refresh resolution](../resolutions/22-decide-price-refresh-boundary.md)).
- Latest verified metadata, mapping invalidation, and deterministic Live derivation rules apply automatically to the same fixed published Printing/Edition. A correction cannot substitute a different physical card ([export metadata resolution](../resolutions/24-decide-export-metadata-contract.md)).
- The owner accepted readable legacy pages and unchanged discovery: prices and exports stay on the selected Published Deck page; search does not fetch prices or add price/cost sorting or filtering.

The owner clarified that Published Decks should remain synchronized to their actual published Printings/Editions. Stable card association is therefore the normal publication path. Only legacy association gaps and genuinely uncertain target metadata are edge cases.

## Accepted planning boundary: use the shared Edition model

The existing domain already has one shared Card Edition linked to one Card Printing, and a Holding is a quantity of that Edition in an owner's storage leaf. The active proposal builds on those facts rather than duplicating an association per Deck:

| Concern | Proposed behavior |
| --- | --- |
| Published row | The immutable publication envelope carries a stable opaque **public Edition reference**, frozen quantity, and frozen display descriptor/name. The reference resolves a shared sanitized public catalog Printing/Edition record; it is not an internal UUID, owner linkage, private Holding, or catalog database lookup. Publish/republish records the reference before the envelope becomes active and includes it in normal durable outbox replay/recovery. |
| Shared catalog metadata | Public catalog projections expose only safe shared Printing/Edition and reviewed export-metadata facts needed to resolve a public reference. Current verified metadata/rules can change for that same Edition without changing frozen Published Deck display content, quantity, or visibility. Live remains deterministic derivation from canonical reviewed category/name/set/number and rule revision, not a stored per-card Live mapping. |
| Quotes and coordination | One shared logical quote/coordination store serves private and public views. Each quote/availability result is exact to an Edition plus mapping revision; there are no per-Deck quotes or persisted Deck totals. Bounded leases, backoff, and monotonic attempt fences are shared. Public reads use its public-safe projection and never PostgreSQL. |
| Totals and coverage | Compute the Published Deck total on read from every frozen published quantity and the eligible shared Edition quotes. Do not persist a total initially. Coverage retains the full frozen quantity denominator, even when only some Editions have quotes. |

Changed/conflicting marketplace mapping enters durable quarantine immediately: it blocks cached price and product-export use until an ordered, reviewed, recoverable correction restores eligibility. Live eligibility stays independent. A late worker can write only a result for its original Edition/mapping revision and current fence. It may never mutate a publication envelope, snapshot content, token, or visibility.

## Public read, refresh, and recovery rules

The anonymous price request accepts only an active token and, if useful for response coherence, an expected snapshot version. It cannot name an Edition, quantity, provider ID, or force refresh. The active public envelope derives the complete row set server-side. Before returning data, revalidate active token, version, frozen-content digest, public Edition reference, and current mapping eligibility; the UI discards a stale-version response.

All price work shares one absolute three-second deadline across public-envelope/catalog reads, coordination, provider work, revalidation, and total calculation. On timeout or failure, return the established labeled cached/unavailable state and leave non-price page content independent.

The public projection/enrichment store retains independent linearizable heads/CAS or equivalent serialization for active-content and shared quote changes. Price updates must not churn the snapshot/discovery manifest, whose revisions invalidate search cursors. Recovery replays the publication envelope with its public Edition references through the existing durable outbox. It must preserve invalidation order and attempt fences so delayed success, replay, or recovery cannot revive a revoked token, attach a quote to a republished row, or clear a newer quarantine state.

Anonymous routes read only public projections. Their gateway classification must explicitly cover nested public price URLs and cookie-bearing requests, so they never fall through to a session/database lookup. No refresh path writes a snapshot or changes visibility.

## Legacy rows

For legacy envelopes without a stable public Edition reference, establish one only from frozen row content and preserved reviewed catalog evidence. Name, image, marketplace product ID, or set/collector text alone is insufficient proof. Prove Printing independently from physical Edition: a proven Printing can support Live derivation when a historic finish is unknown, while quote/product export eligibility waits for a proven Edition/finish.

When association remains unproven, retain the readable page, omit prices, block the affected complete Live export, and retain complete Mass Entry text fallback. Never consult current private Holdings, guess, or rewrite frozen public descriptors. Republish captures the current Deck; it is not a transparent repair of an old snapshot.

## Earlier proposal, retired

The earlier architect review (task `ecef4cc84ace4b7783bf2b27c75b9618`, completed attempt `c367383e61684d29940db3cc8bc2ac17`) proposed separate immutable association sidecars keyed by token/version/digest/schema. It did not propose creating new catalog Edition identities per publication. The latest review found the separate association records unnecessary when references can reside in the publication envelope itself. It is retained only as historical reasoning and is not the active proposal or an approved implementation.

## Evidence and limitations

`catalog_edition` is a shared Edition linked to a Printing and uniquely keyed by its descriptor ([`migrations/003_catalog.sql:40`](../../../../../migrations/003_catalog.sql#L40)). Generation records reference those shared Editions ([`migrations/003_catalog.sql:75`](../../../../../migrations/003_catalog.sql#L75)). `holding` keys quantity by owner, storage leaf, and Edition, and holds are limited to storage leaves/decks ([`migrations/006_add_holdings.sql:3`](../../../../../migrations/006_add_holdings.sql#L3), [`migrations/006_add_holdings.sql:24`](../../../../../migrations/006_add_holdings.sql#L24)); additions increment that shared key ([`api/app/holdings.py:118`](../../../../../api/app/holdings.py#L118)).

Current publication code freezes display fields and quantity ([`api/app/publications.py:132`](../../../../../api/app/publications.py#L132)) and persists the active projection/content envelope through its durable outbox ([`api/app/publications.py:209`](../../../../../api/app/publications.py#L209)). Existing public tests prohibit internal UUID disclosure ([`api/tests/test_publications.py:50`](../../../../../api/tests/test_publications.py#L50)). The `thirdParty` nested-descriptor hazard belongs to the already accepted Edition-compatibility decision, not this shared-reference choice ([`api/app/catalog.py:45`](../../../../../api/app/catalog.py#L45)).

The architect performed a read-only review only: no code, tests, datastore census, external research, Live import, or exact physical marketplace-match proof was performed.

## Handoff requirements after the decision

A later implementation specification must choose the public-reference encoding and provider; numeric batching, concurrency, retry, quota, cache-capacity, and work-lifetime limits; public-schema/migration details; and tests for revocation/republish/visibility races, shared quote fencing, mapping invalidation versus late success, negative cache, outbox recovery, gateway database isolation, the absolute deadline, legacy collisions, and discovery stability. Actual datastore impact, Live acceptance, and exact physical-product matching remain unverified.

**Accepted decision:** the owner accepted this simpler shared-model boundary before moving to the next Wayfinder ticket. An immutable published row holds an opaque public Edition reference and frozen display/quantity; shared public catalog metadata and one Edition+mapping-revision quote/coordination store refresh mutable facts; publication/revoke alone control active content; and asynchronous enrichment never writes snapshots or visibility. It preserves zero anonymous PostgreSQL access and bounded automatic shared cache work. [The resolution](../resolutions/20-decide-published-price-contract.md) is the decision record; provider selection, numeric limits, migrations, implementation, and acceptance evidence remain later work.
