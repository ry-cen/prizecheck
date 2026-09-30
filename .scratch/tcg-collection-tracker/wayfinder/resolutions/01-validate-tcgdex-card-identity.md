# Resolution — Validate TCGdex card identity and variant coverage

The research in [TCGdex card identity and English/Japanese coverage](../research/tcgdex-card-identity.md) was reviewed and accepted.

## Findings

- TCGdex is suitable for language-specific source catalog records, descriptive metadata, and optional image URLs, but it is not a canonical identity or tournament-legality authority.
- A source card must be identified by provider, language, and provider card ID. TCGdex does not provide a universal language-neutral printing identity or a reliable English↔Japanese equivalence relationship.
- TCGdex `variantId` is not a stable physical-product identity. The application must preserve the raw source value while assigning its own normalized variant descriptor and deterministic key.
- TCGdex has no canonical gameplay identity that can safely group English and Japanese names for the four-copy rule. Exact-name checks may be definitive within one language; mixed-language checks require a reviewed application-owned mapping or an explicit unresolved result.
- Basic Energy classification is incomplete and has observable contract drift. Missing or unknown classifications require application-owned overrides or an unresolved result.
- Regulation marks and upstream legality fields are metadata only. The MVP must retain `STANDARD_NOT_EVALUATED`.
- English and especially Japanese records and images are incomplete. Search covers available source records and must handle missing data honestly.
- TCGdex has no authoritative delta or deletion feed. Synchronization must enumerate each supported language into a staging generation, promote only complete generations, and tombstone records that disappear from a successful enumeration.

## Consequences

- The current specification must stop claiming complete cross-language four-copy evaluation, complete Basic Energy exemption, stable provider-owned variant identity, or complete English/Japanese catalog coverage.
- The application may continue using TCGdex for the MVP if the next identity and catalog decisions establish application-owned identifiers, mappings, overrides, tombstones, and unresolved validation states.
