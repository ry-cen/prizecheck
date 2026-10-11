# Resolution: Decide where format rules live and who updates them

**Ticket:** [Decide where format rules live and who updates them](https://github.com/ry-cen/tcg-tracker/issues/74)

**Resolved:** 2026-10-10, grilled with the owner.

**Evidence:** [Standard and Expanded rules](../research/standard-and-expanded-rules.md), [Gym Leader Challenge rules](../research/gym-leader-challenge-rules.md), [TCGdex legality data](../research/tcgdex-legality-data.md).

## Decision

Format checks read two kinds of data, kept apart because they change at different rates and are corrected differently.

### Format Rules: a versioned rules file in the repository

Each format (Standard, Expanded, Gym Leader Challenge) has a rules file in the repository. It holds:
- the legal regulation marks;
- the card pool: sets, marks, and extras such as McDonald's and Trainer Kit products, with each set's legal-from date;
- the ban list, by printing;
- per-deck limits (ACE SPEC, Radiant, Prism Star);
- copy limits;
- format-specific rules: GLC's single type, its Rule Box and ACE SPEC exclusions, and its cross-name pairs {Boss's Orders, Lysandre} and {Professor's Research, Sycamore, Juniper};
- whether Pokémon may inherit legality from a Reprint Group (off, per [Reprint Groups](decide-reprint-groups.md)).

The owner updates rules by commit. Changes are reviewed, tested, and reach production on deploy. Rules change only a few times a year and the owner is the only maintainer.

TCGdex `legal` flags are not used: they ignore reprints and McDonald's and Trainer Kit cards, and contain 9 Expanded ban errors.

**Later:** database records with an owner API, so rules can change without a deploy. This is a future effort if someone other than the owner maintains rules.

### Card attributes: derived from TCGdex, corrected by review

Each printing needs a regulation mark, card kind, Basic Energy status, types, and Rule Box, ACE SPEC, Radiant and Prism Star status.

- **Derived** from TCGdex fields by derivation rules that also live in the repository. Examples: Rule Box from `suffix`, `stage` and the name; ACE SPEC from `rarity` plus a listed set of Black & White ACE SPECs. Fixing a misderived class of cards is a commit.
- **Corrected** one printing at a time by maintainer-reviewed records, following the existing reviewed-decision pattern: collector reports are unapproved input, and only the owner's decision changes data. Examples are the 14 Special Energies TCGdex labels Basic, and Pokémon missing `stage`.
- **Manually approved Printings** get attributes only through review.

## Dates

Every rule carries an effective date: a mark's legal window, a set's legal-from date (the second Friday after release), and each ban's start. A check is correct across rotations, bans and new-set releases without same-day edits. Whether the endpoint can check as of an arbitrary date is left to [Decide the format check result and endpoint contract](https://github.com/ry-cen/tcg-tracker/issues/75).

## When the rules don't know

A printing from a set with no recorded legal date, or with a regulation mark the rules have never seen, yields **unknown** with a reason naming the gap, such as "regulation mark K not in rules". It never yields not legal. An unknown signals stale rules, not a wrong deck.

## Gym Leader Challenge stays in the first phase

Most of what GLC needs is shared with Standard (ACE SPEC and Radiant status) or Expanded (the Black & White-onward pool). The only extra attribute is Pokémon type, which TCGdex lacks for just 9 Black & White-onward Pokémon. The rest is rules-file content.

## Upstream errors

Data errors are fixed locally by reviewed corrections. Reporting them to TCGdex is a courtesy outside this feature.

## Consequence for existing behavior

The existing Basic Energy exemption trusts the same TCGdex `energyType` field that mislabels 14 Special Energies as Basic. The spec should move that exemption onto reviewed card attributes too.
