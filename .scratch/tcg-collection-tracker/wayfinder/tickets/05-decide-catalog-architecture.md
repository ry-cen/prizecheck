# Decide catalog ingestion and search architecture

**Parent:** [Decision-complete Pokémon TCG Collection Tracker MVP](../map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Blocked by:** [Validate TCGdex card identity and variant coverage](01-validate-tcgdex-card-identity.md); [Validate the sub-$10 AWS cost envelope](02-validate-aws-cost-envelope.md); [Decide Card Edition and Card Identity](04-decide-card-edition-identity.md).

## Question

Which concrete relational search/index strategy, cursor semantics, synchronization units, staging-and-promotion mechanism, failure recovery behavior, and freshness guarantees provide useful English catalog search within the cost and load envelope?

**Resolution:** [Manual catalog pull and PostgreSQL search contract](../resolutions/05-decide-catalog-architecture.md)
