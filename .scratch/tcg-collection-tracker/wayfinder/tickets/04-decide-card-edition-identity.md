# Decide Card Edition and Card Identity

**Parent:** [Decision-complete Pokémon TCG Collection Tracker MVP](../map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Blocked by:** [Validate TCGdex card identity and variant coverage](01-validate-tcgdex-card-identity.md); [Find an authoritative cross-language Card Identity source](12-find-cross-language-card-identity-source.md).

**Resolution:** [Application-owned English Card Identity and Card Edition model](../resolutions/04-decide-card-edition-identity.md)

## Question

Given the catalog evidence, what exact identifiers, canonical relationships, variant vocabulary, missing-data behavior, and manual-override policy will define a Card Identity, Card Printing, and Card Edition across English and Japanese while supporting inventory equality and the four-copy rule?

## Decisions in progress

- A Card Printing is one language-specific catalog release. The application assigns it an immutable opaque ID and uniquely associates a source record by provider, language, and provider card ID.
- A Card Edition is one physically distinguishable variant of one Card Printing. The application assigns it an immutable opaque ID, and Holdings reference that ID rather than a raw provider identifier.
- English and Japanese records are distinct Card Printings connected through an application-owned Card Identity above them. Language remains a field of Card Printing.
- A source record that changes or disappears is tombstoned rather than retargeting an existing Card Printing or Card Edition used by Holdings.
- The model follows the TCGdex boundary: one language-specific TCGdex card record maps to one Card Printing, while each physical variant nested under that record maps to a Card Edition.
- Card Edition identity uses an application-owned, extensible Variant Descriptor rather than a closed variant enum or TCGdex `variantId`. Known physical facets are normalized, unrecognized source values are preserved, and a deterministic descriptor key supports source reconciliation without becoming the Edition's public identity.
- When no trustworthy source or reviewed override can distinguish a physical variant, the catalog exposes one explicitly labeled Unspecified Variant Card Edition so inventory entry remains possible. Unspecified never implies Normal or non-foil.
- Newly discovered variants are added as separate Card Editions. Existing Holdings assigned to Unspecified Variant are never silently reclassified; their owners may explicitly move those quantities to a more precise Edition.
- Catalog Overrides are global, versioned, maintainer-reviewed data. They may add or correct Variant Descriptors, Basic Energy classification, and Card Identity relationships; ordinary users may report catalog problems but cannot redefine shared identity.
- An override never changes the identity of a Card Edition already referenced by Holdings. An incorrect Edition is deprecated, its replacement is linked, and each owner explicitly reassigns affected quantities.
- The hierarchy is Card Identity → Card Printing → Card Edition. Deck copy-limit checks roll Holdings up to Card Identity, while inventory equality remains exact at Card Edition.
- Card Identity represents rules-relevant card-name equivalence, not identical mechanics or translated printings. Different Pokémon cards with the same card name share one Card Identity even when their artwork, attacks, abilities, or text differ; suffixes that are part of the rules-relevant name remain distinct.
- The MVP ingests and exposes English Card Printings only. Japanese catalog support and cross-language Card Identity mapping are deferred, but language remains part of Card Printing so later expansion does not change existing identity.
- The MVP creates Card Identities from exact English names after Unicode and insignificant-whitespace normalization only. Capitalization, punctuation, possessives, owner or regional modifiers, and suffixes such as `ex`, `EX`, `GX`, and `V` remain significant.
- All English Printings with the same normalized name attach to the same Card Identity even when their artwork, attacks, abilities, or other text differ. Neither Limitless nor another external identity source is required for this MVP grouping.
- A source name change that would relink an existing Printing to a different Card Identity is staged for maintainer review rather than applied silently.
