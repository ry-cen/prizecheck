# Research: ACE SPEC cards in Mega Evolution-era sets

**Researched:** 2026-10-11, for [Deck Lists 12: Check a Deck List against Standard](https://github.com/ry-cen/prizecheck/issues/93) and the card attribute rules of [Deck Lists 02](https://github.com/ry-cen/prizecheck/issues/83).

**Question:** Do the Mega Evolution-era English sets contain ACE SPEC cards? TCGdex marks ACE SPEC only through `rarity: "ACE SPEC Rare"`, and no Mega Evolution-era printing carries that rarity.

## Findings

- **No ACE SPEC printing was found in any released Mega Evolution-era set:**
  - me01 Mega Evolution, me02 Phantasmal Flames, me02.5 Ascended Heroes, me03 Perfect Order, me04 Chaos Rising, me05 Pitch Black;
  - mee (Basic Energy only);
  - the visible MEP Black Star Promos;
  - 30th Celebration and 30th Classic Collection.

  Each set's Trainer and Energy names were checked against the 42 known ACE SPEC names, and Scrydex's rarity and subtype filters were checked for the main sets. Confidence is medium-high: two independent sources agree, but no primary Pokémon source was readable.
- **Corrected claims from the search:**
  - Premium Power Pro (me01-124) is not an ACE SPEC. TCGdex and pkmncards list it as an Uncommon Item.
  - A claim that the Mega Evolution set has "new ACE SPEC trainers" is not supported by any card list.
- **The most recent ACE SPEC printings** are in Prismatic Evolutions (Scarlet & Violet, January 2025), per a secondary history of ACE SPEC cards. Its Scarlet & Violet count matches the 33 TCGdex printings tagged `ACE SPEC Rare`.
- **Black & White ACE SPECs carry no TCGdex marker.** For example, Computer Search bw7-137 has rarity "Rare" and no ACE text. Effect text never mentions ACE SPEC, even on Scarlet & Violet cards such as Prime Catcher sv05-157.
- **Mega Evolution ex Pokémon carry a Rule Box.** No new per-deck limit mechanic was found. This is a negative search, and the official rulebook PDF was blocked.
- **me06 Delta Reign** is announced for 2026-11-06 and isn't released, so its cards are unknown.

## Implications

- Trainers and Energy in me01–me05, mee, mep, 30th and 30th-c can derive `ace_spec = false` rather than unknown. Sets not yet checked, including me06, stay unknown.
- ACE SPEC detection should combine the `ACE SPEC Rare` rarity with an allowlist of ACE SPEC names, because ACE SPEC status follows the name across reprints and Black & White printings have no marker. Watch for near-miss names, such as Switch versus Scramble Switch.

## Open

- The official rulebook text (the ACE SPEC one-per-deck wording, and the Mega Evolution ex Prize count) wasn't read: pokemon.com blocks automated reads.
- MEP coverage is incomplete: TCGdex lists 89 entries and Scrydex 112.

## Sources

- TCGdex API: set lists for me01, me02, me02.5, me03, me04, me05, mee, mep, 30th and 30th-c, plus cards sv05-157, bw7-137, me01-124, me02.5-216 and me01-003 (read through a summarizing fetch tool).
- Scrydex set pages for me1, me2, me2pt5, me3, me4, me5 and mep (rarity and subtype filters).
- pkmncards, the Mega Evolution set and Premium Power Pro pages (secondary).
- Pooka, ACE SPEC card history (secondary): https://pooka.app/card-spotlights/ace-spec-cards-history
- Delta Reign release announcements, StarCityGames and pokemoncard.io (secondary).
