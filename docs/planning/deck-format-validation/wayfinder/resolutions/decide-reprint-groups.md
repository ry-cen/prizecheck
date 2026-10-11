# Resolution: Decide which printings count as the same card for format legality

**Ticket:** [Decide which printings count as the same card for format legality](https://github.com/ry-cen/prizecheck/issues/73)

**Resolved:** 2026-10-10, grilled with the owner.

**Evidence:** [Standard and Expanded rules](../research/standard-and-expanded-rules.md) (reprint rule, section 4) and [TCGdex legality data](../research/tcgdex-legality-data.md) (reprint rule not modeled; at least 151 Standard and 315 Expanded printings misjudged).

## Decision

Format checks use two layers.

- **Card Identity** (by English name) limits copies: 4 per name in Standard and Expanded, 1 per name in GLC, with Basic Energy exempt. A parenthetical subtitle is not part of the name. "Professor's Research (Professor Juniper)" and "Professor's Research (Professor Magnolia)" therefore share one Card Identity. A maintainer may merge Card Identities for cases the rule misses.
- **Reprint Group** (a new term) covers the Card Printings within one Card Identity whose rules text is functionally identical. Format legality and bans apply to the group.

Copy limits never count by Reprint Group. Two Pikachu with different attacks are separate Reprint Groups but one Card Identity, and together they may not exceed 4.

## Building Reprint Groups

- **Automatic.** Printings in the same Card Identity whose text is exactly equal are grouped automatically. For Trainers and Energy that means the effect text. For Pokémon it means HP, type, attacks and abilities. Identical text is safely equivalent, so no review is needed.
- **Maintainer-reviewed.** A maintainer may merge printings whose wording differs but whose effect is the same, such as the handbook's Copycat example or errata'd cards. A maintainer may also split a wrong automatic group. These are reviewed records, like Catalog Overrides.
- **Manually approved Printings** have no source text, so they join a group only through maintainer review.

## Legality inheritance

- **Trainer and Energy printings** are legal in a format if any printing in their Reprint Group is legal there. For example, Rare Candy sv01-191 is Standard-legal because Rare Candy me01-125, which has the same text, is. Rare Candy sm1-129 is worded differently, so it forms its own group and becomes legal only through a reviewed Reprint Group merge ([ticket 14](https://github.com/ry-cen/prizecheck/issues/95)).
- **Pokémon printings** are grouped, so they share bans and appear as one card. They do not inherit legality: each Pokémon printing must be legal on its own mark or set. N's Zoroark ex from Journey Together and from Ascended Heroes are one Reprint Group, and both are legal on their own marks. Primary sources don't settle whether Pokémon may inherit. The owner judged the case rare, so allowing it later is a single rule change (see [Decide where format rules live and who updates them](https://github.com/ry-cen/prizecheck/issues/74)).

## Bans

A ban naming one printing applies to that printing's whole Reprint Group, so a banned card can't be played through an unlisted identical reprint. Printings with different text sit in different groups and are unaffected. For example, GLC's ban on Kyogre SHF 021 doesn't touch other Kyogre.

## Consequences for existing behavior

Stripping subtitles changes how Card Identity is derived. Today it uses the exact name, so the basic 4-copy check undercounts subtitled reprints. The spec must cover re-deriving existing Card Identities without breaking Holdings or Published Deck references.
