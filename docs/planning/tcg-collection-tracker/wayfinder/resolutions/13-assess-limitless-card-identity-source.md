# Resolution — Assess Limitless TCG as a Card Identity and Printing source

The research in [Limitless TCG as a Card Identity source](../research/limitless-card-identity-source.md) was reviewed and accepted.

## Findings

- Limitless groups reprints and alternate arts of a particular card, not every mechanically different card sharing the same rules-relevant name. Separate `Pikachu ex` pages demonstrate that its relation is narrower than Card Identity.
- Its documented developer API covers tournament data, not the card catalog. No published bulk card dataset, stable card API, change feed, reuse grant, or catalog service contract was found.
- Public card pages are useful human evidence for investigating reprints, translations, and source discrepancies, but website scraping would be an unsupported and brittle MVP dependency.
- For English Card Identity, exact normalized TCGdex names already provide the required grouping and cover mechanically different same-name cards more correctly than Limitless's reprint relation.

## Decision

The MVP does not ingest or depend on Limitless. Maintainers may use its public card pages as a manual research aid, recording and independently reviewing any correction before adding a Catalog Override. A future integration requires a documented, licensed, stable card-data feed.
