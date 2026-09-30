# Domain Docs

This repository uses a single-context domain-documentation layout.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant decisions under `docs/adr/` when that directory exists.
- If these files do not exist, proceed silently. The domain-modeling workflow creates them when terminology or architectural decisions are resolved.

## Layout

/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/

## Vocabulary

Use the terms defined in `CONTEXT.md` consistently in specifications, tickets, tests, implementation, and documentation. If a required concept is missing, record the gap for domain modeling rather than silently introducing competing terminology.

## Architectural decisions

If proposed work conflicts with an existing ADR, identify the conflict explicitly rather than silently overriding the decision.
