# Revise the MVP spec and tracer-bullet tickets

**Parent:** [Decision-complete Pokémon TCG Collection Tracker MVP](../map.md)

**Label:** wayfinder:task

**Status:** closed

**Assignee:** codex

**Blocked by:** [Decide the evidence required for implementation readiness](10-decide-readiness-evidence.md).

## Task

Rewrite the existing [MVP spec](../../spec.md) and implementation tickets under `issues/` into a coherent, dependency-ordered implementation handoff using all closed Wayfinder decisions. The current spec and tickets still describe superseded AWS/DynamoDB, English/Japanese, mixed-content Location, and scheduled catalog behavior; they are source material, not implementation-ready instructions.

## Completion criteria

- Reconcile every approved Wayfinder decision by linked name; remove contradictory old requirements and retain the agreed English-only MVP scope.
- State domain terms, product flows, API and error contracts, relational invariants, hosting/operations, privacy boundaries, and the owner-only-to-public signup sequence without leaving an implementation agent to choose between alternatives.
- Create dependency-ordered tracer-bullet tickets with testable acceptance criteria. Include the two gates and evidence matrix from [Decide the evidence required for implementation readiness](../resolutions/10-decide-readiness-evidence.md); specify how launch results are recorded later, rather than claiming those results already exist.
- Cover the approved prototype interactions, manual TCGdex pull and owner review control panel, missing-English-card reports and approval, 25,000-Holding and bulk-Move load cases, public Deck projection, backup restore, manual release, and owner desktop/mobile walkthrough.
- Verify local links, ticket dependencies, traceability, and absence of stale provider or product instructions. This task edits planning artifacts only; application implementation remains outside the Wayfinder map.

**Resolution:** [Revised MVP spec and tracer-bullet tickets](../resolutions/15-revise-mvp-spec-and-tracer-tickets.md)
