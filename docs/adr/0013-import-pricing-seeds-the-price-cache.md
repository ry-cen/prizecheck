# Catalog imports seed the price cache

**Status:** accepted — owner decision, 2026-10-12. Superseded in part by [ADR 0019](0019-tcgcsv-daily-prices.md): catalog imports no longer seed prices. Its viewport rule (a price slot asks only when it comes near the viewport) still applies.

Catalog pages showed "No cached price yet · Refresh timed out" for rows further down the page. Every uncached row asked for a refresh at once, and the runner's TCGdex token bucket (8 tokens, refilling one per second) answers about ten cards inside the 2.5 s wait. Meanwhile a full pull already receives every card's TCGdex pricing, and `docs/prices.md` said that snapshot never seeds a price. The owner decided: "we really should not be discarding the information only to pull again".

**Decision.** After a catalog import commits and delivers its catalog records, it writes the records a successful runner check writes (`quote:`, `result:` and `fence:`). It does so for each Edition that PostgreSQL and the shared catalog records both show as verified with a published quote lookup, at the same mapping revision. The quote is chosen by the runner's own selection (`tcgdex_record.select_quote`) from the card's response parsed again with exact decimal text, as the runner parses it, so it passes the same checks. `checked_at` is when the import received the card, and `provider_updated_at` is TCGdex's own pricing time.

- A seed never replaces a check that is as new or newer, a pending or unreadable result, or an Edition with a refresh queued or running. It advances the fence in the same compare-and-swap, so it cannot interleave with a runner.
- An Edition whose TCGplayer entry has no market price is not recorded as confirmed absence. Absence deletes a cached quote and is never resurrected, and one bulk pull should not do that to every such Edition at once. The runner still confirms absence on access.
- Seeding is best effort. A store outage or error ends it without affecting the committed import. It changes no Edition identity, fingerprint, metadata row or mapping revision ([ADR 0007](0007-edition-marketplace-metadata-boundary.md)).

The stored `catalog_edition_metadata.quote_candidate` is still never read as a price. It keeps no fetch time and holds JSON floats rather than the source text. An Edition verified later, by a maintainer or by a rule activation outside an import, is priced by the next import or by the runner on first access.

**Price requests follow the viewport.** A price slot now asks for its price once it comes within two viewport heights of the visible area, instead of when it mounts, so a long page no longer queues a refresh for every row. This refines [ADR 0006](0006-access-triggered-price-refresh.md): a rendered row counts as an access when it comes near the viewport.

**Consequences.** Seeded prices enter the ADR 0006 age bands from the import's fetch time. Under an hour they are fresh. Under 24 hours they are shown and refreshed in the background. Older ones wait for a refresh but keep showing the seeded price as a labelled fallback. The pricing launch gate is unchanged: without an activated matching rule no Edition is verified, so nothing is seeded. A pull requested while the previous run is still seeding is ignored, because the importer's lock is held until seeding ends, and must be started again after that run finishes.
