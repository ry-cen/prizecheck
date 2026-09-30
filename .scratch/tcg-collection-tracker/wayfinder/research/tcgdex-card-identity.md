# TCGdex card identity and English/Japanese coverage

Research performed 2026-08-05 against the live TCGdex v2 API and the official `tcgdex/cards-database` repository at commit [`cddde0c`](https://github.com/tcgdex/cards-database/tree/cddde0c92df70e3a70301685c2751e1e3440cfef).

## Decision summary

TCGdex is suitable as a source of language-specific catalog records, set/collector-number printing identifiers, descriptive card metadata, and optional image bases. It is **not** sufficient by itself to establish English/Japanese equivalence, the canonical gameplay name needed to apply the four-copy rule across languages, complete variant/product identity, or tournament legality.

For the MVP, use a language-qualified source identity for every catalog card and an application-owned identity for each selectable edition:

- `sourceCardKey = tcgdex:<language>:<card.id>`
- `card.id` is currently compiled as `<set.id>-<localId>`; retain `set.id` and `localId` separately as source data.
- `cardEditionKey = <sourceCardKey>:<applicationVariantKey>`, where the application variant key is derived from a normalized descriptor, not trusted directly from TCGdex's `variantId`.
- Preserve the raw source fields and source update timestamp. Never silently retarget an existing Holding if upstream data disappears or changes; tombstone the catalog record instead.

The deck checker may group editions by exact normalized name **within one language**. It must return an unresolved cross-language copy-limit result when a Deck contains more than one language until the application owns a reviewed gameplay-equivalence map. It must not infer English/Japanese equivalence from species, illustration, collector number, or translated text.

## What TCGdex actually identifies

### A language-specific card printing

The v2 Card response documents `id` as the unique card identifier and `localId` as the number inside its set. In the official compiler, the API `id` is constructed as `${card.set.id}-${localId}`. The response itself does not contain a provider version, global language-neutral printing ID, or a list of equivalent records in other languages. ([Card reference](https://tcgdex.dev/reference/card); [compiler source](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/server/compiler/utils/cardUtil.ts))

Language must be part of the application's key. The REST URL is language-scoped, and a source card can carry localized names for several languages while the API emits only the requested localization. The repository deliberately stores international and Asian releases in separate trees, selected by language in the compiler. ([REST card endpoint](https://tcgdex.dev/rest/card); [language routing source](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/server/compiler/utils/util.ts); [source language schema](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/interfaces.d.ts))

The identifier is useful as a provider key, but TCGdex does not publish an immutability or non-reuse guarantee. The application therefore should not call it a universal or permanent Pokémon printing ID. Qualifying it with provider and language prevents collisions and leaves room for replacement data sources.

### English/Japanese localized equivalents

English and Japanese releases are generally modeled as separate sets and cards, not translations of one shared printing. For example, the English 151 Bulbasaur is [`sv03.5-001`](https://api.tcgdex.net/v2/en/cards/sv03.5-001), while the Japanese card with the same Pokémon, artwork, attacks, and regulation mark is [`SV2a-001`](https://api.tcgdex.net/v2/ja/cards/SV2a-001). Their sets also have separate source definitions and release dates. ([English 151 source](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/data/Scarlet%20%26%20Violet/151.ts); [Japanese 151 source](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/data-asia/SV/SV2a.ts))

Neither record points to the other. Matching by `localId` happens to work for that example but is not a general relationship: international sets combine and reorganize Japanese releases, secret-card numbering and promo releases differ, and the two 151 API sets currently report different total record counts. Illustration is also not an identity because artwork can be reused for distinct printings or variants.

Where the same source object contains several language values, querying the same set/card ID in those languages can expose localized counterparts. That is a relationship implicit in repository structure, not an API field or a general English/Japanese bridge. It should not be extrapolated across independently modeled sets.

### Gameplay-name equivalence

TCGdex supplies only the localized `name`; its source schema describes that name as including a suffix when it appears next to the card name. It has no canonical gameplay-name ID, translation-group ID, reprint-equivalence ID, or rule-box identity. `dexId` identifies Pokémon species only and is unavailable for Trainers and Energy; it also cannot distinguish mechanically important suffixes or different cards of the same species. ([card source interface](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/interfaces.d.ts); [Card reference](https://tcgdex.dev/reference/card))

Consequences for the four-copy check:

- Within one language, group by a conservative normalized source name: Unicode normalization and whitespace normalization, preserving punctuation and suffix distinctions. Keep the original name for display.
- Across English and Japanese, do not machine-translate, match on `dexId`, or compare attacks/effects. All can create false equivalences.
- A mixed-language Deck requires either an application-owned, reviewed `gameplayIdentityId` mapping or an explicit `COPY_LIMIT_NOT_EVALUATED_ACROSS_LANGUAGES` result. TCGdex alone cannot satisfy the approved requirement to count equivalent names across English and Japanese.

## Basic Energy classification

The source model distinguishes `category: "Energy"` and an optional `energyType` whose internal values are `Normal` or `Special`. The live API currently returns `energyType: "Normal"` for [`col1-93` Fighting Energy](https://api.tcgdex.net/v2/en/cards/col1-93), although the current public reference calls the corresponding value `Basic`. This is observable contract drift between official documentation and production. ([source interface](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/interfaces.d.ts); [Energy reference](https://tcgdex.dev/reference/card#energy-cards))

The adapter should classify Basic Energy only when `category` is Energy and `energyType` is either the observed `Normal` or documented `Basic` value. It should preserve the raw value and classify missing/unknown values as unresolved. Name matching is unsafe across languages.

This field is not complete. An audit of the pinned source found 1,063 Energy card files: 539 explicitly `Normal`, 462 explicitly `Special`, and 62 with no `energyType`. At least some omissions are obvious Basic Energy printings, such as Lightning Energy in an SM Trainer Kit. ([representative omitted classification](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/data/Trainer%20kits/SM%20trainer%20Kit%20%28Alolan%20Raichu%29/1.ts))

Therefore TCGdex can positively identify many Basic Energy cards but cannot support a complete Basic Energy exemption without an application-owned override table or unresolved validation results for missing classifications.

## Variants and edition identity

TCGdex currently exposes two variant representations:

- Legacy booleans (`normal`, `reverse`, `holo`, `firstEdition`, and `wPromo`).
- `variants_detailed`, with type, subtype, size, stamps, foil, third-party IDs, and `variantId`.

The source schema contains a much richer and evolving vocabulary for errors, stamps, foil patterns, sizes, and language availability. It also says that absent variant language restrictions mean availability in all languages. ([variant source schema](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/interfaces.d.ts))

`variantId` must not be treated as an authoritative provider SKU. The compiler hashes selected descriptor fields and warns that changing the included fields breaks identifiers. For legacy boolean data it synthesizes detailed variants whose identifier is literally `generated`, so multiple variants are not uniquely identified by that value. ([variant identifier source](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/server/compiler/utils/variantUtil.ts); [legacy conversion source](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/server/compiler/utils/cardUtil.ts))

Variant coverage is actively being backfilled and corrected; recent official releases explicitly describe moves to the new variant shape and missing-variant fixes. ([cards-database releases](https://github.com/tcgdex/cards-database/releases)) The live English 151 Bulbasaur reports normal, reverse, set-logo-stamped, and cosmos-reverse variants, while Japanese 151 Bulbasaur currently reports only a generated normal variant. That discrepancy is not evidence that the Japanese physical card has no other finishes; it demonstrates that source completeness differs.

Recommended adapter behavior:

- Convert both representations into an application descriptor containing normalized `type`, `subtype`, `size`, sorted stamps, foil, and language.
- Generate an application-owned deterministic key from that descriptor and keep `sourceVariantId` only as metadata.
- Preserve unrecognized values and raw source JSON so an expanded enum does not destroy identity.
- If two upstream entries collapse to the same descriptor, mark them ambiguous rather than inventing a stable physical-product distinction.
- Do not promise exhaustive errors, stamps, packaged-product variants, or marketplace SKUs in the MVP.

## Regulation marks and legality

`regulationMark` is optional and the source notes it was added from Sword & Shield onward. It is useful display/filter metadata for marked cards, but absence is expected for older cards and may also represent incomplete data. ([source interface](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/interfaces.d.ts))

The API's `legal.standard` and `legal.expanded` values are compiler outputs from a project-maintained allow/exclude configuration, including special handling for Basic Energy. They are not provenance-rich official rulings and do not encode deck-level rules, reprint equivalence, card-specific copy limits, or all regional differences. ([legality configuration](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/meta/legals.ts); [legality compiler](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/server/compiler/utils/util.ts))

Keep the approved `STANDARD_NOT_EVALUATED` behavior. Store regulation mark and upstream legality only as source metadata; do not convert either into an application claim that a Deck is legal.

## Images

`image` is optional. When present, it is a base URL rather than a complete asset URL. The documented card asset suffix is `/{quality}.{extension}`, with `high` or `low` quality and PNG, WebP, or JPEG formats; WebP is the recommended web format. ([asset documentation](https://tcgdex.dev/assets); [Card reference](https://tcgdex.dev/reference/card))

Store the source base URL and derive a requested display URL at render time. The frontend must have a missing-image fallback and should not infer an image URL for records where the API omits it. Do not copy the images into application storage for this MVP.

## Update detection and completeness

The full Card object documents an `updated` ISO timestamp that excludes pricing changes. The official compiler derives it from the last Git edit of the card's source file; if no edit is found, its fallback is the current compilation time. The list endpoint returns only brief records and does not include `updated`. ([Card reference](https://tcgdex.dev/reference/card); [list endpoint](https://tcgdex.dev/rest/cards); [update compiler](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/server/compiler/utils/cardUtil.ts); [timestamp fallback](https://github.com/tcgdex/cards-database/blob/cddde0c92df70e3a70301685c2751e1e3440cfef/server/compiler/utils/util.ts))

There is no documented API change feed, deletion feed, catalog generation/version, or webhook. `updated` is useful as a hint after fetching a full record but cannot reveal removed IDs, and the list endpoint cannot support timestamp-only incremental discovery. A correct synchronization should therefore:

1. Enumerate the complete brief ID set separately for each supported language.
2. Fetch full records into a staging generation, normalize them, and fingerprint the source fields the application consumes.
3. Treat absent cards and failed fetches as errors during staging, not immediate deletions from the active generation.
4. Promote only a completed generation, then tombstone records absent from that successful enumeration.
5. Record sync time, language, observed counts, and a content fingerprint. Do not present those as a TCGdex-provided version.

Completeness is a hard constraint, not an edge case. At the time of research, the official live status reported:

| Language | Card data | Card images |
|---|---:|---:|
| English | 23,444 / 23,746 (98.73%) | 21,828 / 23,746 (91.92%) |
| Japanese | 8,159 / 16,192 (50.39%) | 3,297 / 16,192 (20.36%) |

TCGdex itself says completion varies by language and translation resources. These percentages are moving operational observations, not service-level guarantees. ([live TCGdex status](https://api.tcgdex.net/status); [status documentation](https://tcgdex.dev/status))

The MVP can offer English and Japanese search over **available** records, but it must show source incompleteness honestly. A placeholder can cover missing optional metadata on an existing record; it cannot make a missing Japanese card selectable.

## Requirements unsupported or unreliable from TCGdex alone

The following must not be claimed from TCGdex alone:

- A universal, language-neutral Pokémon card printing identifier.
- Reliable English↔Japanese localized-printing equivalence.
- Canonical gameplay-name equivalence across English and Japanese.
- Complete four-copy validation for mixed-language Decks.
- Complete Basic Energy exemption without overrides for missing `energyType` values.
- Exhaustive variant/product coverage or a permanently stable upstream variant identifier.
- Complete card-image coverage, especially for Japanese cards.
- Tournament-legal Standard Decks, including rotation, reprint equivalence, banned cards, regional rules, and card-specific construction limits.
- A transactional delta feed or authoritative catalog generation for synchronization.
- Completeness or freshness guarantees comparable to an SLA.

## Recommended product boundary

Retain TCGdex for the catalog MVP, but revise the earlier specification in three places:

1. Define Card Edition identity as provider + language + provider card ID + application variant key, with source records tombstoned rather than retargeted.
2. Make exact-name copy checks language-local. Mixed-language copy-limit validation remains explicitly unresolved until a reviewed application-owned gameplay identity map exists.
3. Treat Japanese support as best-effort search over available TCGdex records with prominent missing-data/image handling; do not describe it as complete catalog support.

These boundaries preserve accurate inventory tracking while preventing the catalog's missing relationships from becoming false deck-legality claims.
