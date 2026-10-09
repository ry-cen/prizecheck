# Existing boundaries for card prices and Deck exports

Inspected: 2026-10-08, current working tree on `dev`. This is repository inspection, not a feature decision or implementation result. Existing uncommitted changes to `AGENTS.md`, `README.md`, and `tcgplayer-pricing-api.md` were left intact.

## Catalog

- [`normalize`](../../../../api/app/catalog.py) currently retains Printing identifiers, set/name/collector number, image, Basic Energy classification, variant descriptors, and a fingerprint. It does not project prices, Pokémon/Trainer/Energy category, or Live set abbreviations into searchable metadata.
- [`variant_descriptors`](../../../../api/app/catalog.py) deliberately excludes provider variant IDs and pricing from physical Edition identity, but does not exclude a nested `thirdParty` field. Live Furret data observed by the primary on 2026-10-08 contains `thirdParty` marketplace IDs in detailed variants; those IDs can enter current physical descriptors despite the exclusion comment. Preserve existing immutable identity while deciding a safe separation; simply stripping this field during the next pull could create replacement Editions and ambiguity rather than a clean price refresh.
- Catalog generations retain compressed raw card records in [`catalog_generation`](../../../../migrations/003_catalog.sql), so a successful full pull can contain additional source data even though normalized read contracts discard it. Raw retention is not an efficient read API or proof that all required fields are present.
- The fingerprint currently covers the entire raw card record, including any prices. Separating price refresh from identity reconciliation needs an explicit design decision; changing prices should not continually create new physical-identity review candidates.
- Reviewed Printing display/reference data and raw source references may diverge while a catalog correction is pending. Export and price mapping must respect reviewed identity rather than blindly using a recycled source reference. See [`execute_run`](../../../../api/app/catalog.py) and [`catalog_source_reference`](../../../../migrations/016_catalog_reconciliation.sql).
- Catalog fetches run during owner-requested imports. [On-demand catalog imports](../../../../docs/adr/0003-on-demand-catalog-imports.md) and the [MVP scope](../../spec.md) govern the existing model; user reads currently do not query TCGdex. A dedicated refresh policy is unresolved.

## Private Decks

- [`deck_detail`](../../../../api/app/decks.py) returns count/construction checks grouped by Card Identity, with inventory and catalog revisions. It does not return an unpaginated full Edition list or price aggregate.
- [`Decks`](../../../../web/src/Decks.tsx) renders checks and the paginated Holdings UI. Exporting only loaded Holding pages would silently omit cards; the future export contract must read a consistent complete Deck independently of browser pagination.
- Quantities are stored as integers and serialized as decimal strings. Export grammar and external destination limits must be considered for incomplete, empty, and unusually large physical Decks as well as ordinary 60-card Decks.

## Published Decks

- [`snapshot`](../../../../api/app/publications.py) already includes every published Edition's quantity, variant, set and collector reference under Card Identity groups. It excludes private IDs and Locations, and currently has no price, category, or Live set-code fields.
- [`PublicSnapshot`](../../../../api/app/publications.py) is a strict allowlist. Extending publication requires updating validation, generated contracts, public-object projections, and privacy assertions together.
- [`PublishedDeck`](../../../../web/src/PublishedDeck.tsx) consumes that sanitized object. Published reads must continue to use only public projections without waking PostgreSQL or retrieving the owner's current Deck. Old snapshot compatibility and missing new metadata need a defined policy.
- Existing publication intentionally freezes content until explicit republish; private edits cannot change an export from the public URL. Whether quoted prices also freeze or use a separately refreshed public price projection remains a product/design question.

## Planning boundaries

The [completed MVP map](../map.md) and [specification](../../spec.md) excluded valuation and import/export. This new request is an extension, not evidence that the prior implementation is incomplete. Keep the original completion evidence historical and create the new effort's acceptance criteria after its decisions are agreed. Application regression gates belong to implementation; this inspection changes Markdown only.
