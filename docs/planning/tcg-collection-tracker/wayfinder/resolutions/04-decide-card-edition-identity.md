# Resolution — Decide Card Edition and Card Identity

## Identity hierarchy

The catalog and inventory use the hierarchy **Card Identity → Card Printing → Card Edition**.

- **Card Identity** is an application-owned English rules-relevant name group used by deck copy-limit checks. All English cards with the same normalized name share the identity even when their artwork, attacks, abilities, or other text differ.
- **Card Printing** is one language-specific catalog release. It has an immutable application ID and a unique source reference consisting of provider, language, and provider card ID.
- **Card Edition** is one physically distinguishable variant of a Card Printing. It has an immutable application ID and is the identity referenced by Holdings.

The MVP ingests and exposes English records only. Language remains part of Card Printing so Japanese or other languages can be introduced later without changing existing Holding identity.

## English name grouping

Card Identity grouping normalizes Unicode and insignificant whitespace only. Capitalization, punctuation, possessives, owner or regional modifiers, and suffixes such as `ex`, `EX`, `GX`, and `V` remain significant. The MVP does not depend on Limitless or another external identity source for this grouping.

A source name change that would move an existing Printing between Card Identities is staged for maintainer review. It never silently changes deck-validation grouping.

## Variant identity

Card Editions use an application-owned, extensible Variant Descriptor rather than a closed enum or TCGdex `variantId`. Known physical facets such as finish, foil pattern, stamps, and size are normalized; unrecognized provider values and raw source data are preserved.

When no trustworthy variant information exists, the catalog exposes one explicitly labeled **Unspecified Variant** Edition. It does not imply Normal or non-foil. Newly discovered Editions may be added later, but existing Unspecified Holdings are never silently reassigned.

## Source changes and corrections

Source records and Editions referenced by Holdings are tombstoned or deprecated rather than retargeted. Replacement Editions are linked and collectors explicitly reassign affected quantities.

Global Catalog Overrides are versioned and maintainer-reviewed. They may correct Variant Descriptors, Basic Energy classification, or Card Identity relationships. Ordinary users may report catalog problems and reclassify their own Holdings but cannot redefine shared catalog identity.

The Basic Energy exemption is applied only when classification is supported by trusted source data or a reviewed Catalog Override. Missing classification produces an explicit unresolved construction issue rather than a false pass or failure.
