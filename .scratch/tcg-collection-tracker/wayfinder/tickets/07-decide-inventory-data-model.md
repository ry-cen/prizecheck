# Decide the relational transactional inventory model

**Parent:** [Decision-complete Pokémon TCG Collection Tracker MVP](../map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Blocked by:** [Decide Card Edition and Card Identity](04-decide-card-edition-identity.md); [Decide the runtime, authentication, and hosting topology](06-decide-aws-runtime-topology.md).

## Question

What relational schema, indexes, invariants, optimistic-concurrency contract, transaction shapes, pagination rules, hierarchy limits, aggregate queries, and failure responses support leaf-only storage Locations, Deck transfers, unrestricted atomic bulk transfers, and heavy collectors within the chosen platform’s limits?

**Resolution:** [Relational transactional inventory model](../resolutions/07-decide-inventory-data-model.md)
