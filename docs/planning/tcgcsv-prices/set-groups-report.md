# Matching rule v6: proposed TCGdex set to TCGCSV group table

Written by `scripts/propose_set_groups.py` (ticket P12, #378). It lists the main-set cards that have no TCGdex TCGplayer id, neither on a variant nor on the card, and for each set proposes the TCGCSV group(s) the rule searches. The rule's table contains only the sets the owner accepted.

## Owner review

Decided by the owner on 2026-10-27; final.

- Accepted all 50 proposed sets below, with the group(s) listed for each (`bw11`: 1409 and 1465; `g1`: 1728 and 1729). The
  14 sets with no proposal stay out of the table.
- Accepted all four name equivalences: `delta`, `hyphen-suffix`, `apostrophe` and `accent`. Nothing else is folded.
- Apostrophe-like characters ’ ‘ ʼ ` fold to ', decided by the orchestrator under the owner's delegation, 2026-10-28.
- Matching rule v6 (`MatchingRulesV6.TCGPLAYER_SET_GROUPS` in `api/app/catalog_targets.py`) holds exactly these sets; a test
  keeps the table equal to the Summary below.

Proposed 50 sets. They would gain **434 cards** (457 Editions) out of 697 cards with no id in 64 sets. With only the two reviewed equivalences (`delta`, `hyphen-suffix`) the gain is **333 cards** (337 Editions) in 18 sets; the rest comes from the further equivalences proposed below (`apostrophe`, `accent`), which the owner accepted too.

## Summary

| Set | Name | Group(s) | TCGdex cards | No id | Would gain | Of those, reviewed equivalences only | Editions | Special only | Doubtful |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `sma` | Hidden Fates Shiny Vault | 2594 Hidden Fates: Shiny Vault | 94 | 94 | 94 | 94 | 94 | 0 |  |
| `ex15` | Dragon Frontiers | 1411 EX Dragon Frontiers | 101 | 80 | 67 | 67 | 67 | 0 |  |
| `ex13` | Holon Phantoms | 1379 EX Holon Phantoms | 111 | 51 | 41 | 41 | 43 | 0 |  |
| `bw11` | Legendary Treasures | 1409 Legendary Treasures; 1465 Legendary Treasures: Radiant Collection | 140 | 37 | 31 | 31 | 31 | 0 | several groups |
| `g1` | Generations | 1728 Generations; 1729 Generations: Radiant Collection | 117 | 37 | 30 | 26 | 30 | 0 | several groups |
| `ex11` | Delta Species | 1429 EX Delta Species | 114 | 35 | 24 | 24 | 24 | 0 |  |
| `sm115` | Hidden Fates | 2480 Hidden Fates | 69 | 16 | 15 | 0 | 15 | 0 | name twin rejected |
| `ex14` | Crystal Guardians | 1395 EX Crystal Guardians | 100 | 14 | 14 | 12 | 14 | 0 |  |
| `bw7` | Boundaries Crossed | 1408 Boundaries Crossed | 153 | 14 | 8 | 6 | 8 | 0 |  |
| `bw4` | Next Destinies | 1412 Next Destinies | 103 | 13 | 7 | 6 | 7 | 0 |  |
| `sm12` | Cosmic Eclipse | 2534 SM - Cosmic Eclipse | 271 | 12 | 7 | 0 | 7 | 0 |  |
| `bw5` | Dark Explorers | 1386 Dark Explorers | 111 | 13 | 6 | 6 | 6 | 0 | low match rate |
| `bw6` | Dragons Exalted | 1394 Dragons Exalted | 128 | 14 | 6 | 6 | 6 | 0 | low match rate |
| `sm10` | Unbroken Bonds | 2420 SM - Unbroken Bonds | 234 | 11 | 6 | 0 | 6 | 0 |  |
| `sm9` | Team Up | 2377 SM - Team Up | 196 | 16 | 6 | 0 | 6 | 0 | low match rate |
| `base4` | Base Set 2 | 605 Base Set 2 | 130 | 8 | 5 | 0 | 5 | 0 |  |
| `bw10` | Plasma Blast | 1370 Plasma Blast | 105 | 12 | 4 | 3 | 4 | 0 | low match rate |
| `bw8` | Plasma Storm | 1413 Plasma Storm | 138 | 12 | 4 | 4 | 4 | 0 | low match rate |
| `sm11` | Unified Minds | 2464 SM - Unified Minds | 258 | 7 | 4 | 0 | 4 | 0 |  |
| `swsh1` | Sword & Shield | 2585 SWSH01: Sword & Shield Base Set | 216 | 7 | 4 | 0 | 8 | 0 | name twin rejected |
| `xy2` | Flashfire | 1464 XY - Flashfire | 110 | 7 | 4 | 0 | 4 | 0 |  |
| `bw1` | Black & White | 1400 Black and White | 115 | 3 | 3 | 0 | 3 | 0 | name twin rejected |
| `dp7` | Stormfront | 1369 Stormfront | 106 | 6 | 3 | 0 | 6 | 0 |  |
| `neo1` | Neo Genesis | 1396 Neo Genesis | 111 | 3 | 3 | 0 | 6 | 0 |  |
| `sm7` | Celestial Storm | 2278 SM - Celestial Storm | 183 | 9 | 3 | 0 | 3 | 0 | low match rate |
| `bw9` | Plasma Freeze | 1382 Plasma Freeze | 122 | 14 | 2 | 2 | 2 | 0 | low match rate |
| `dp1` | Diamond & Pearl | 1430 Diamond and Pearl | 130 | 7 | 2 | 0 | 4 | 0 | name twin rejected, low match rate |
| `dp6` | Legends Awakened | 1417 Legends Awakened | 146 | 10 | 2 | 1 | 4 | 0 | low match rate |
| `ex7` | Team Rocket Returns | 1428 EX Team Rocket Returns | 111 | 2 | 2 | 0 | 2 | 0 |  |
| `ru1` | Pokémon Rumble | 1433 Rumble | 16 | 2 | 2 | 2 | 2 | 0 |  |
| `sm3.5` | Shining Legends | 2054 Shining Legends | 78 | 3 | 2 | 0 | 2 | 0 |  |
| `sm6` | Forbidden Light | 2209 SM - Forbidden Light | 146 | 9 | 2 | 0 | 2 | 0 | low match rate |
| `swsh3.5` | Champion's Path | 2685 Champion's Path | 80 | 3 | 2 | 0 | 4 | 0 |  |
| `xy0` | Kalos Starter Set | 1522 Kalos Starter Set | 39 | 2 | 2 | 0 | 2 | 0 |  |
| `xy11` | Steam Siege | 1815 XY - Steam Siege | 116 | 4 | 2 | 0 | 2 | 0 |  |
| `base2` | Jungle | 635 Jungle | 64 | 2 | 1 | 0 | 2 | 0 |  |
| `bw2` | Emerging Powers | 1424 Emerging Powers | 98 | 1 | 1 | 0 | 1 | 0 |  |
| `dp5` | Majestic Dawn | 1390 Majestic Dawn | 100 | 3 | 1 | 0 | 2 | 0 | low match rate |
| `ex12` | Legend Maker | 1378 EX Legend Maker | 93 | 1 | 1 | 1 | 1 | 0 |  |
| `ex9` | Emerald | 1410 EX Emerald | 107 | 1 | 1 | 0 | 1 | 0 |  |
| `neo2` | Neo Discovery | 1434 Neo Discovery | 75 | 1 | 1 | 1 | 2 | 0 |  |
| `neo3` | Neo Revelation | 1389 Neo Revelation | 66 | 1 | 1 | 0 | 2 | 0 |  |
| `neo4` | Neo Destiny | 1444 Neo Destiny | 113 | 2 | 1 | 0 | 2 | 0 |  |
| `sm5` | Ultra Prism | 2178 SM - Ultra Prism | 173 | 12 | 1 | 0 | 1 | 0 | low match rate |
| `sm7.5` | Dragon Majesty | 2295 Dragon Majesty | 78 | 4 | 1 | 0 | 1 | 0 | low match rate |
| `sm8` | Lost Thunder | 2328 SM - Lost Thunder | 236 | 13 | 1 | 0 | 1 | 0 | low match rate |
| `xy10` | Fates Collide | 1780 XY - Fates Collide | 129 | 5 | 1 | 0 | 1 | 0 | low match rate |
| `xy12` | Evolutions | 1842 XY - Evolutions | 113 | 3 | 1 | 0 | 1 | 0 | name twin rejected, low match rate |
| `xy8` | BREAKthrough | 1661 XY - BREAKthrough | 165 | 2 | 1 | 0 | 1 | 0 |  |
| `xy9` | BREAKpoint | 1701 XY - BREAKpoint | 126 | 4 | 1 | 0 | 1 | 0 | low match rate |

## Doubtful sets

A set is doubtful when it lists several groups, has a low match rate (under 50% of its no-id cards), has cards that two products both claim, has a name twin group that was rejected, or whose group has a very different card count.

- `bw11` Legendary Treasures: several groups.
- `g1` Generations: several groups.
- `sm115` Hidden Fates: name twin rejected.
- `bw5` Dark Explorers: low match rate.
- `bw6` Dragons Exalted: low match rate.
- `sm9` Team Up: low match rate.
- `bw10` Plasma Blast: low match rate.
- `bw8` Plasma Storm: low match rate.
- `swsh1` Sword & Shield: name twin rejected.
- `bw1` Black & White: name twin rejected.
- `sm7` Celestial Storm: low match rate.
- `bw9` Plasma Freeze: low match rate.
- `dp1` Diamond & Pearl: name twin rejected, low match rate.
- `dp6` Legends Awakened: low match rate.
- `sm6` Forbidden Light: low match rate.
- `dp5` Majestic Dawn: low match rate.
- `sm5` Ultra Prism: low match rate.
- `sm7.5` Dragon Majesty: low match rate.
- `sm8` Lost Thunder: low match rate.
- `xy10` Fates Collide: low match rate.
- `xy12` Evolutions: name twin rejected, low match rate.
- `xy9` BREAKpoint: low match rate.

## Sets with no proposal

| Set | Name | No id | Why |
| --- | --- | ---: | --- |
| `dp2` | Mysterious Treasures | 5 | name candidates matched none of its cards: 1368 Mysterious Treasures |
| `dp3` | Secret Wonders | 7 | name candidates matched none of its cards: 1380 Secret Wonders |
| `dp4` | Great Encounters | 4 | name candidates matched none of its cards: 1405 Great Encounters |
| `sm1` | Sun & Moon | 11 | no TCGCSV group has a name containing the set name |
| `sm4` | Crimson Invasion | 1 | name candidates matched none of its cards: 2071 SM - Crimson Invasion |
| `tk-hs-g` | HS trainer Kit (Gyarados) | 1 | no TCGCSV group has a name containing the set name |
| `tk-xy-n` | XY trainer Kit (Noivern) | 5 | no TCGCSV group has a name containing the set name |
| `tk-xy-sy` | XY trainer Kit (Sylveon) | 3 | no TCGCSV group has a name containing the set name |
| `xy3` | Furious Fists | 1 | name candidates matched none of its cards: 1481 XY - Furious Fists |
| `xy4` | Phantom Forces | 7 | name candidates matched none of its cards: 1494 XY - Phantom Forces |
| `xy5` | Primal Clash | 1 | name candidates matched none of its cards: 1509 XY - Primal Clash |
| `xy6` | Roaring Skies | 2 | name candidates matched none of its cards: 1534 XY - Roaring Skies |
| `xy7` | Ancient Origins | 1 | name candidates matched none of its cards: 1576 XY - Ancient Origins |
| `xya` | Yellow A Alternate | 6 | no TCGCSV group has a name containing the set name |

## Name equivalences

Applied to both sides before the comparison. Nothing else is folded: `LV.X`, `(Prime)`, stamps and forme qualifiers still fail.

Reviewed in design section 4.16:

- `delta`: `<name> δ` = `<name> (Delta Species)`.
- `hyphen-suffix`: `-EX`, `-GX`, `-V`, `-VMAX`, `-VSTAR`, `-ex` = the same suffix after a space.

Accepted by the owner, because the misses show TCGplayer writing plain ASCII names (without them the sets below lose the cards listed in the table above):

- `apostrophe`: the apostrophe-like characters `’` `‘` `ʼ` and a backtick all equal a straight `'`.
- `accent`: an accented letter = the plain letter (`Poké Ball` = `Poke Ball`).

A method named in the lists below is the set of equivalences that changed either name.

Matches by method over all proposed sets: accent 65, accent+apostrophe 1, apostrophe 35, delta 145, exact 104, hyphen-suffix 84.

## Sets

### `sma` Hidden Fates Shiny Vault

- Group(s): 2594 Hidden Fates: Shiny Vault (same, 94 card products)
- TCGdex cards: 94; cards with no id: 94; exact matches: 55; matches by an equivalence: 39; misses: 0; special only: 0.

<details>
<summary>39 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| SV46 | Leafeon-GX | 197770 Leafeon GX | hyphen-suffix |
| SV47 | Decidueye-GX | 197774 Decidueye GX | hyphen-suffix |
| SV48 | Golisopod-GX | 197776 Golisopod GX | hyphen-suffix |
| SV49 | Charizard-GX | 197780 Charizard GX | hyphen-suffix |
| SV50 | Ho-Oh-GX | 197782 Ho-Oh GX | hyphen-suffix |
| SV51 | Reshiram-GX | 197785 Reshiram GX | hyphen-suffix |
| SV52 | Turtonator-GX | 197787 Turtonator GX | hyphen-suffix |
| SV53 | Alolan Ninetales-GX | 197789 Alolan Ninetales GX | hyphen-suffix |
| SV54 | Articuno-GX | 197791 Articuno GX | hyphen-suffix |
| SV55 | Glaceon-GX | 197795 Glaceon GX | hyphen-suffix |
| SV56 | Greninja-GX | 197797 Greninja GX | hyphen-suffix |
| SV57 | Electrode-GX | 197800 Electrode GX | hyphen-suffix |
| SV58 | Xurkitree-GX | 197803 Xurkitree GX | hyphen-suffix |
| SV59 | Mewtwo-GX | 197806 Mewtwo GX | hyphen-suffix |
| SV60 | Espeon-GX | 197808 Espeon GX | hyphen-suffix |
| SV61 | Banette-GX | 197810 Banette GX | hyphen-suffix |
| SV62 | Nihilego-GX | 197812 Nihilego GX | hyphen-suffix |
| SV63 | Naganadel-GX | 197814 Naganadel GX | hyphen-suffix |
| SV64 | Lucario-GX | 197816 Lucario GX | hyphen-suffix |
| SV65 | Zygarde-GX | 197818 Zygarde GX | hyphen-suffix |
| SV66 | Lycanroc-GX | 197820 Lycanroc GX (SV66) | hyphen-suffix |
| SV67 | Lycanroc-GX | 197821 Lycanroc GX (SV67) | hyphen-suffix |
| SV68 | Buzzwole-GX | 197822 Buzzwole GX | hyphen-suffix |
| SV69 | Umbreon-GX | 197823 Umbreon GX | hyphen-suffix |
| SV70 | Darkrai-GX | 197824 Darkrai GX | hyphen-suffix |
| SV71 | Guzzlord-GX | 197825 Guzzlord GX | hyphen-suffix |
| SV72 | Scizor-GX | 197826 Scizor GX | hyphen-suffix |
| SV73 | Kartana-GX | 197827 Kartana GX | hyphen-suffix |
| SV74 | Stakataka-GX | 197828 Stakataka GX | hyphen-suffix |
| SV75 | Gardevoir-GX | 197829 Gardevoir GX | hyphen-suffix |
| SV76 | Sylveon-GX | 197830 Sylveon GX | hyphen-suffix |
| SV77 | Altaria-GX | 197831 Altaria GX | hyphen-suffix |
| SV78 | Noivern-GX | 197832 Noivern GX | hyphen-suffix |
| SV79 | Silvally-GX | 197833 Silvally GX | hyphen-suffix |
| SV80 | Drampa-GX | 197834 Drampa GX | hyphen-suffix |
| SV91 | Tapu Bulu-GX | 197845 Tapu Bulu GX | hyphen-suffix |
| SV92 | Tapu Fini-GX | 197846 Tapu Fini GX | hyphen-suffix |
| SV93 | Tapu Koko-GX | 197847 Tapu Koko GX | hyphen-suffix |
| SV94 | Tapu Lele-GX | 197848 Tapu Lele GX | hyphen-suffix |

</details>

<details>
<summary>55 exact matches</summary>

SV1 Scyther = 197738; SV2 Rowlet = 197739; SV3 Dartrix = 197740; SV4 Wimpod = 197741; SV5 Pheromosa = 197743; SV6 Charmander = 197744; SV7 Charmeleon = 197745; SV8 Alolan Vulpix = 197762; SV9 Wooper = 197763; SV10 Quagsire = 197764; SV11 Froakie = 197765; SV12 Frogadier = 197766; SV13 Voltorb = 197767; SV14 Xurkitree = 197768; SV15 Seviper = 197769; SV16 Shuppet = 197771; SV17 Inkay = 197772; SV18 Malamar = 197773; SV19 Poipole = 197775; SV20 Sudowoodo = 197777; SV21 Riolu = 197778; SV22 Lucario = 197779; SV23 Rockruff = 197781; SV24 Buzzwole = 197783; SV25 Zorua = 197784; SV26 Guzzlord = 197786; SV27 Magnemite = 197788; SV28 Magneton = 197790; SV29 Magnezone = 197792; SV30 Beldum = 197793; SV31 Metang = 197794; SV32 Celesteela = 197796; SV33 Kartana = 197798; SV34 Ralts = 197799; SV35 Kirlia = 197801; SV36 Diancie = 197802; SV37 Altaria = 197804; SV38 Gible = 197805; SV39 Gabite = 197807; SV40 Garchomp = 197809; SV41 Eevee = 197811; SV42 Swablu = 197813; SV43 Noibat = 197815; SV44 Oranguru = 197817; SV45 Type: Null = 197819; SV81 Aether Foundation Employee = 197835; SV82 Cynthia = 197836; SV83 Fisherman = 197837; SV84 Guzma = 197838; SV85 Hiker = 197839; SV86 Lady = 197840; SV87 Aether Paradise Conservation Area = 197841; SV88 Brooklet Hill = 197842; SV89 Mt. Coronet = 197843; SV90 Shrine of Punishment = 197844

</details>

### `ex15` Dragon Frontiers

- Group(s): 1411 EX Dragon Frontiers (same, 101 card products)
- TCGdex cards: 101; cards with no id: 80; exact matches: 0; matches by an equivalence: 67; misses: 13; special only: 0.

<details>
<summary>67 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 1 | Ampharos δ | 83549 Ampharos (Delta Species) | delta |
| 2 | Feraligatr δ | 85423 Feraligatr (Delta Species) | delta |
| 3 | Heracross δ | 86067 Heracross (Delta Species) | delta |
| 4 | Meganium δ | 87297 Meganium (Delta Species) | delta |
| 5 | Milotic δ | 87458 Milotic (Delta Species) | delta |
| 6 | Nidoking δ | 87701 Nidoking (Delta Species) | delta |
| 7 | Nidoqueen δ | 87712 Nidoqueen (Delta Species) | delta |
| 8 | Ninetales δ | 87781 Ninetales (Delta Species) | delta |
| 9 | Pinsir δ | 88141 Pinsir (Delta Species) | delta |
| 10 | Snorlax δ | 89395 Snorlax (Delta Species) | delta |
| 11 | Togetic δ | 89946 Togetic (Delta Species) | delta |
| 12 | Typhlosion δ | 90110 Typhlosion (Delta Species) | delta |
| 13 | Arbok δ | 83572 Arbok (Delta Species) | delta |
| 14 | Cloyster δ | 84376 Cloyster (Delta Species) | delta |
| 15 | Dewgong δ | 84792 Dewgong (Delta Species) | delta |
| 16 | Gligar δ | 85770 Gligar (Delta Species) | delta |
| 17 | Jynx δ | 86378 Jynx (Delta Species) | delta |
| 18 | Ledian δ | 86697 Ledian (Delta Species) | delta |
| 19 | Lickitung δ | 86724 Lickitung (Delta Species) | delta |
| 20 | Mantine δ | 87185 Mantine (Delta Species) | delta |
| 21 | Quagsire δ | 88475 Quagsire (Delta Species) | delta |
| 23 | Tropius δ | 90064 Tropius (Delta Species) | delta |
| 25 | Xatu δ | 90668 Xatu (Delta Species) | delta |
| 26 | Bayleef δ | 83750 Bayleef (Delta Species) | delta |
| 27 | Croconaw δ | 84504 Croconaw (Delta Species) | delta |
| 28 | Dragonair δ | 84907 Dragonair (Delta Species) | delta |
| 29 | Electabuzz δ | 85119 Electabuzz (Delta Species) | delta |
| 30 | Flaaffy δ | 85487 Flaaffy (Delta Species) | delta |
| 33 | Kirlia δ | 86473 Kirlia (Delta Species) | delta |
| 34 | Nidorina δ | 87740 Nidorina (Delta Species) | delta |
| 35 | Nidorino δ | 87749 Nidorino (Delta Species) | delta |
| 36 | Quilava δ | 88488 Quilava (Delta Species) | delta |
| 38 | Shelgon δ | 89134 Shelgon (Delta Species) | delta |
| 39 | Smeargle δ | 89358 Smeargle (Delta Species) | delta |
| 40 | Swellow δ | 89696 Swellow (Delta Species) | delta |
| 41 | Togepi δ | 89938 Togepi (Delta Species) | delta |
| 43 | Bagon δ | 83705 Bagon (Delta Species) | delta |
| 44 | Chikorita δ | 84281 Chikorita (Delta Species) | delta |
| 45 | Cyndaquil δ | 84554 Cyndaquil (Delta Species) | delta |
| 46 | Dratini δ | 84942 Dratini (Delta Species) | delta |
| 47 | Ekans δ | 85105 Ekans (Delta Species) | delta |
| 48 | Elekid δ | 85173 Elekid (Delta Species) | delta |
| 49 | Feebas δ | 85407 Feebas (Delta Species) | delta |
| 52 | Larvitar δ | 86647 Larvitar (Delta Species) | delta |
| 53 | Ledyba δ | 86707 Ledyba (Delta Species) | delta |
| 54 | Mareep δ | 87209 Mareep (Delta Species) | delta |
| 55 | Natu δ | 87689 Natu (Delta Species) | delta |
| 59 | Pupitar δ | 88456 Pupitar (Delta Species) | delta |
| 61 | Ralts δ | 88568 Ralts (Delta Species) | delta |
| 62 | Seel δ | 89055 Seel (Delta Species) | delta |
| 63 | Shellder δ | 89140 Shellder (Delta Species) | delta |
| 64 | Smoochum δ | 89365 Smoochum (Delta Species) | delta |
| 65 | Swablu δ | 89664 Swablu (Delta Species) | delta |
| 66 | Taillow δ | 89738 Taillow (Delta Species) | delta |
| 67 | Totodile δ | 90004 Totodile (Delta Species) | delta |
| 70 | Vulpix δ | 90449 Vulpix (Delta Species) | delta |
| 71 | Wooper δ | 90639 Wooper (Delta Species) | delta |
| 90 | Altaria ex δ | 83525 Altaria ex (Delta Species) | delta |
| 91 | Dragonite ex δ | 84919 Dragonite ex (Delta Species) | delta |
| 92 | Flygon ex δ | 85532 Flygon ex (Delta Species) | delta |
| 93 | Gardevoir ex δ | 85642 Gardevoir ex (Delta Species) | delta |
| 94 | Kingdra ex δ | 86452 Kingdra ex (Delta Species) | delta |
| 95 | Latias ex δ | 86661 Latias ex (Delta Species) | delta |
| 96 | Latios ex δ | 86675 Latios ex (Delta Species) | delta |
| 97 | Rayquaza ex δ | 88647 Rayquaza ex (Delta Species) | delta |
| 98 | Salamence ex δ | 88905 Salamence ex (Delta Species) | delta |
| 99 | Tyranitar ex δ | 90126 Tyranitar ex (Delta Species) | delta |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 22 | Seadra δ | missed | 89019 Seadra - 022/101 (Delta Species) (22/101) |
| 24 | Vibrava δ | missed | 90341 Vibrava - 024/101 (Delta Species) (24/101) |
| 31 | Horsea δ | missed | 86195 Horsea - 031/101 (Delta Species) (31/101) |
| 37 | Seadra δ | missed | 89020 Seadra - 037/101 (Delta Species) (37/101) |
| 42 | Vibrava δ | missed | 90342 Vibrava - 042/101 (Delta Species) (42/101) |
| 50 | Horsea δ | missed | 86196 Horsea - 050/101 (Delta Species) (50/101) |
| 56 | Nidoran♀ δ | missed | 87722 Nidoran F (Delta Species) (56/101) |
| 57 | Nidoran♂ δ | missed | 87731 Nidoran M (Delta Species) (57/101) |
| 68 | Trapinch δ | missed | 90027 Trapinch - 068/101 (Delta Species) (68/101) |
| 69 | Trapinch δ | missed | 90028 Trapinch - 069/101 (Delta Species) (69/101) |
| 88 | δ Rainbow Energy | missed | 84755 Delta Rainbow Energy (88/101) |
| 100 | Charizard ☆ δ | missed | 84198 Charizard Star (Delta Species) (100/101) |
| 101 | Mew ☆ δ | missed | 87408 Mew Star (Delta Species) (101/101) |

### `ex13` Holon Phantoms

- Group(s): 1379 EX Holon Phantoms (same, 111 card products)
- TCGdex cards: 111; cards with no id: 51; exact matches: 0; matches by an equivalence: 41; misses: 10; special only: 0.

<details>
<summary>41 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 1 | Armaldo δ | 83622 Armaldo (Delta Species) | delta |
| 2 | Cradily δ | 84456 Cradily (Delta Species) | delta |
| 7 | Flygon δ | 85529 Flygon (Delta Species) | delta |
| 8 | Gyarados δ | 86002 Gyarados (Delta Species) | delta |
| 9 | Kabutops δ | 86401 Kabutops (Delta Species) | delta |
| 10 | Kingdra δ | 86450 Kingdra (Delta Species) | delta |
| 13 | Omastar δ | 87872 Omastar (Delta Species) | delta |
| 14 | Pidgeot δ | 88036 Pidgeot (Delta Species) | delta |
| 15 | Raichu δ | 88524 Raichu (Delta Species) | delta |
| 17 | Vileplume δ | 90383 Vileplume (Delta Species) | delta |
| 19 | Bellossom δ | 83803 Bellossom (Delta Species) | delta |
| 21 | Latias δ | 86657 Latias (Delta Species) | delta |
| 22 | Latios δ | 86671 Latios (Delta Species) | delta |
| 24 | Mewtwo δ | 87426 Mewtwo (Delta Species) | delta |
| 35 | Aerodactyl δ | 83472 Aerodactyl (Delta Species) | delta |
| 37 | Chimecho δ | 84297 Chimecho (Delta Species) | delta |
| 41 | Exeggutor δ | 85364 Exeggutor (Delta Species) | delta |
| 42 | Gloom δ | 85788 Gloom (Delta Species) | delta |
| 43 | Golduck δ | 85820 Golduck (Delta Species) | delta |
| 48 | Persian δ | 87989 Persian (Delta Species) | delta |
| 49 | Pidgeotto δ | 88044 Pidgeotto (Delta Species) | delta |
| 50 | Primeape δ | 88367 Primeape (Delta Species) | delta |
| 52 | Seadra δ | 89018 Seadra (Delta Species) | delta |
| 53 | Sharpedo δ | 89102 Sharpedo (Delta Species) | delta |
| 54 | Vibrava δ | 90340 Vibrava (Delta Species) | delta |
| 57 | Anorith δ | 83562 Anorith (Delta Species) | delta |
| 61 | Carvanha δ | 84118 Carvanha (Delta Species) | delta |
| 65 | Exeggcute δ | 85352 Exeggcute (Delta Species) | delta |
| 66 | Horsea δ | 86194 Horsea (Delta Species) | delta |
| 67 | Kabuto δ | 86388 Kabuto (Delta Species) | delta |
| 68 | Lileep δ | 86791 Lileep (Delta Species) | delta |
| 69 | Magikarp δ | 87038 Magikarp (Delta Species) | delta |
| 70 | Mankey δ | 87178 Mankey (Delta Species) | delta |
| 71 | Meowth δ | 87329 Meowth (Delta Species) | delta |
| 73 | Oddish δ | 87847 Oddish (Delta Species) | delta |
| 74 | Omanyte δ | 87862 Omanyte (Delta Species) | delta |
| 76 | Pichu δ | 88023 Pichu (Delta Species) | delta |
| 77 | Pidgey δ | 88053 Pidgey (Delta Species) | delta |
| 79 | Pikachu δ | 88108 Pikachu (Delta Species) | delta |
| 81 | Psyduck δ | 88443 Psyduck (Delta Species) | delta |
| 84 | Trapinch δ | 90026 Trapinch (Delta Species) | delta |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 3 | Deoxys δ | missed | 84760 Deoxys (Delta Species - Attack Forme) (3/110) |
| 4 | Deoxys δ | missed | 84762 Deoxys (Delta Species - Defense Forme) (4/110) |
| 5 | Deoxys δ | missed | 84764 Deoxys (Delta Species - Normal Forme) (5/110) |
| 6 | Deoxys δ | missed | 84767 Deoxys (Delta Species - Speed Forme) (6/110) |
| 11 | Latias δ | missed | 86656 Latias - 011/110 (Delta Species) (11/110) |
| 12 | Latios δ | missed | 86670 Latios - 012/110 (Delta Species) (12/110) |
| 16 | Rayquaza δ | missed | 88634 Rayquaza - 016/110 (Delta Species) (16/110) |
| 26 | Rayquaza δ | missed | 88635 Rayquaza - 026/110 (Delta Species) (26/110) |
| 98 | δ Rainbow Energy | missed | 84754 Delta Rainbow Energy (98/110) |
| 102 | Gyarados ☆ δ | missed | 86003 Gyarados Star (Delta Species) (102/110) |

### `bw11` Legendary Treasures

- Group(s): 1409 Legendary Treasures (same, 115 card products); 1465 Legendary Treasures: Radiant Collection (subset, 25 card products)
- TCGdex cards: 140; cards with no id: 37; exact matches: 19; matches by an equivalence: 12; misses: 6; special only: 0.
- Doubtful: several groups.

<details>
<summary>12 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 24 | Victini-EX | 90351 Victini EX | hyphen-suffix |
| 29 | Reshiram-EX | 88715 Reshiram EX | hyphen-suffix |
| 44 | Kyurem-EX | 86569 Kyurem EX | hyphen-suffix |
| 45 | Keldeo-EX | 86438 Keldeo EX | hyphen-suffix |
| 52 | Zekrom-EX | 90742 Zekrom EX | hyphen-suffix |
| 54 | Mewtwo-EX | 87431 Mewtwo EX | hyphen-suffix |
| 77 | Chandelure-EX | 84168 Chandelure EX | hyphen-suffix |
| 82 | Excadrill-EX | 85340 Excadrill EX | hyphen-suffix |
| 88 | Darkrai-EX | 84708 Darkrai EX | hyphen-suffix |
| 100 | Black Kyurem-EX | 83856 Black Kyurem EX | hyphen-suffix |
| 101 | White Kyurem-EX | 90591 White Kyurem EX | hyphen-suffix |
| RC11 | Meloetta-EX | 87304 Meloetta EX | hyphen-suffix |

</details>

<details>
<summary>19 exact matches</summary>

RC1 Snivy = 89382; RC2 Servine = 89080; RC3 Serperior = 89075; RC4 Growlithe = 85963; RC5 Torchic = 89964; RC6 Piplup = 88154; RC7 Pikachu = 88105; RC8 Ralts = 88567; RC9 Kirlia = 86472; RC10 Gardevoir = 85639; RC12 Stunfisk = 89583; RC13 Purrloin = 88462; RC14 Eevee = 85094; RC15 Teddiursa = 89862; RC16 Ursaring = 90257; RC17 Audino = 83665; RC18 Minccino = 87479; RC19 Cinccino = 84321; RC20 Elesa = 85174

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 102 | Lugia-EX | missed | 86915 Lugia EX (Team Plasma) (102/113) |
| RC21 | Shaymin-EX | missed | 89113 Shaymin EX (Full Art) (RC21/RC25) |
| RC22 | Reshiram | missed | 88712 Reshiram (Full Art) (RC22/RC25) |
| RC23 | Emolga | missed | 85194 Emolga (Full Art) (RC23/RC25) |
| RC24 | Mew-EX | missed | 87413 Mew EX (Full Art) (RC24/RC25) |
| RC25 | Meloetta-EX | missed | 87305 Meloetta EX (Full Art) (RC25/RC25) |

### `g1` Generations

- Group(s): 1728 Generations (same, 84 card products); 1729 Generations: Radiant Collection (subset, 32 card products)
- TCGdex cards: 117; cards with no id: 37; exact matches: 26; matches by an equivalence: 4; misses: 7; special only: 0.
- Doubtful: several groups.

<details>
<summary>4 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 67 | Poké Ball | 113725 Poke Ball | accent |
| 68 | Pokémon Center Lady | 113726 Pokemon Center Lady | accent |
| 69 | Pokémon Fan Club | 113727 Pokemon Fan Club | accent |
| RC17 | Flabébé | 113759 Flabebe | accent |

</details>

<details>
<summary>26 exact matches</summary>

RC1 Chikorita = 113742; RC2 Shroomish = 113743; RC3 Charmander = 113744; RC4 Charmeleon = 113745; RC5 Charizard = 113746; RC6 Flareon EX = 113747; RC7 Snorunt = 113749; RC8 Froslass = 113750; RC9 Raichu = 113751; RC10 Dedenne = 113752; RC11 Wobbuffet = 113753; RC12 Gulpin = 113754; RC13 Jirachi = 113755; RC14 Espurr = 113756; RC15 Meowstic = 113757; RC16 Yveltal = 113758; RC18 Floette = 113760; RC19 Swirlix = 113761; RC20 Slurpuff = 113762; RC21 Sylveon EX = 113763; RC22 Diancie = 113765; RC23 Swablu = 113766; RC24 Altaria = 113767; RC25 Fletchling = 113768; RC26 Floral Crown = 113769; RC27 Wally = 113770

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 28a | Jolteon-EX | missed | none |
| 73a | Team Flare Grunt | missed | none |
| RC28 | Flareon EX | missed | 113748 Flareon EX (Full Art) (RC28/RC32) |
| RC29 | Pikachu | missed | 113771 Pikachu (Full Art) (RC29/RC32) |
| RC30 | Gardevoir EX | missed | 113772 Gardevoir EX (Full Art) (RC30/RC32) |
| RC31 | M Gardevoir EX | missed | 113773 M Gardevoir EX (Full Art) (RC31/RC32) |
| RC32 | Sylveon EX | missed | 113764 Sylveon EX (Full Art) (RC32/RC32) |

### `ex11` Delta Species

- Group(s): 1429 EX Delta Species (same, 114 card products)
- TCGdex cards: 114; cards with no id: 35; exact matches: 0; matches by an equivalence: 24; misses: 11; special only: 0.

<details>
<summary>24 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 1 | Beedrill δ | 83775 Beedrill (Delta Species) | delta |
| 2 | Crobat δ | 84490 Crobat (Delta Species) | delta |
| 3 | Dragonite δ | 84917 Dragonite (Delta Species) | delta |
| 4 | Espeon δ | 85327 Espeon (Delta Species) | delta |
| 5 | Flareon δ | 85501 Flareon (Delta Species) | delta |
| 6 | Gardevoir δ | 85640 Gardevoir (Delta Species) | delta |
| 7 | Jolteon δ | 86349 Jolteon (Delta Species) | delta |
| 8 | Latias δ | 86655 Latias (Delta Species) | delta |
| 9 | Latios δ | 86669 Latios (Delta Species) | delta |
| 10 | Marowak δ | 87230 Marowak (Delta Species) | delta |
| 11 | Metagross δ | 87342 Metagross (Delta Species) | delta |
| 12 | Mewtwo δ | 87425 Mewtwo (Delta Species) | delta |
| 13 | Rayquaza δ | 88633 Rayquaza (Delta Species) | delta |
| 14 | Salamence δ | 88902 Salamence (Delta Species) | delta |
| 16 | Tyranitar δ | 90123 Tyranitar (Delta Species) | delta |
| 17 | Umbreon δ | 90151 Umbreon (Delta Species) | delta |
| 18 | Vaporeon δ | 90290 Vaporeon (Delta Species) | delta |
| 19 | Azumarill δ | 83687 Azumarill (Delta Species) | delta |
| 24 | Mightyena δ | 87450 Mightyena (Delta Species) | delta |
| 27 | Sandslash δ | 88936 Sandslash (Delta Species) | delta |
| 49 | Metang δ | 87384 Metang (Delta Species) | delta |
| 51 | Pupitar δ | 88455 Pupitar (Delta Species) | delta |
| 59 | Beldum δ | 83794 Beldum (Delta Species) | delta |
| 73 | Larvitar δ | 86646 Larvitar (Delta Species) | delta |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 15 | Starmie δ | missed | 89540 Starmie - 015/113 (Delta Species) (15/113) |
| 30 | Starmie δ | missed | 89541 Starmie - 030/113 (Delta Species) (30/113) |
| 41 | Dragonair δ | missed | 84905 Dragonair - 41/113 (Delta Species) (041/113) |
| 42 | Dragonair δ | missed | 84906 Dragonair - 42/113 (Delta Species) (042/113) |
| 53 | Shelgon δ | missed | 89132 Shelgon - 053/113 (Delta Species) (53/113) |
| 54 | Shelgon δ | missed | 89133 Shelgon - 054/113 (Delta Species) (54/113) |
| 57 | Bagon δ | missed | 83703 Bagon - 057/113 (Delta Species) (57/113) |
| 58 | Bagon δ | missed | 83704 Bagon - 058/113 (Delta Species) (58/113) |
| 65 | Dratini δ | missed | 84940 Dratini - 065/113 (Delta Species) (65/113) |
| 66 | Dratini δ | missed | 84941 Dratini - 066/113 (Delta Species) (66/113) |
| 68 | Eevee δ | missed | 85097 Eevee - 068/113 (68/113) |

### `sm115` Hidden Fates

- Group(s): 2480 Hidden Fates (same, 69 card products)
- TCGdex cards: 69; cards with no id: 16; exact matches: 0; matches by an equivalence: 15; misses: 1; special only: 0.
- Doubtful: name twin rejected.
- Rejected name candidate: 2594 Hidden Fates: Shiny Vault (subset); it matched no card the chosen groups missed.

<details>
<summary>15 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 45 | Farfetch’d | 197689 Farfetch'd | apostrophe |
| 51 | Bill’s Analysis | 197697 Bill's Analysis | apostrophe |
| 52 | Blaine’s Last Stand | 197699 Blaine's Last Stand | apostrophe |
| 53 | Brock’s Grit | 197700 Brock's Grit | apostrophe |
| 54 | Brock’s Pewter City Gym | 197702 Brock's Pewter City Gym | apostrophe |
| 55 | Brock’s Training | 197704 Brock's Training | apostrophe |
| 56 | Erika’s Hospitality | 197706 Erika's Hospitality | apostrophe |
| 57 | Giovanni’s Exile | 197709 Giovanni's Exile | apostrophe |
| 59 | Koga’s Trap | 197712 Koga's Trap | apostrophe |
| 60 | Lt. Surge’s Strategy | 197714 Lt. Surge's Strategy | apostrophe |
| 61 | Misty’s Cerulean City Gym | 197716 Misty's Cerulean City Gym | apostrophe |
| 62 | Misty’s Determination | 197717 Misty's Determination | apostrophe |
| 63 | Misty’s Water Command | 197720 Misty's Water Command | apostrophe |
| 64 | Pokémon Center Lady | 197724 Pokemon Center Lady | accent |
| 65 | Sabrina’s Suggestion | 197725 Sabrina's Suggestion | apostrophe |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 67 | Giovanni’s Exile | missed | 197730 Giovanni's Exile (Full Art) (67/68) |

### `ex14` Crystal Guardians

- Group(s): 1395 EX Crystal Guardians (same, 100 card products)
- TCGdex cards: 100; cards with no id: 14; exact matches: 0; matches by an equivalence: 14; misses: 0; special only: 0.

<details>
<summary>14 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 2 | Blastoise δ | 83899 Blastoise (Delta Species) | delta |
| 4 | Charizard δ | 84195 Charizard (Delta Species) | delta |
| 6 | Ludicolo δ | 86902 Ludicolo (Delta Species) | delta |
| 15 | Cacturne δ | 84083 Cacturne (Delta Species) | delta |
| 18 | Fearow δ | 85400 Fearow (Delta Species) | delta |
| 19 | Grovyle δ | 85946 Grovyle (Delta Species) | delta |
| 22 | Kingler δ | 86458 Kingler (Delta Species) | delta |
| 26 | Pelipper δ | 87980 Pelipper (Delta Species) | delta |
| 30 | Charmeleon δ | 84236 Charmeleon (Delta Species) | delta |
| 49 | Charmander δ | 84220 Charmander (Delta Species) | delta |
| 68 | Treecko δ | 90044 Treecko (Delta Species) | delta |
| 82 | Poké Ball | 88185 Poke Ball | accent |
| 83 | PokéNav | 88245 Pokenav | accent |
| 96 | Sceptile ex δ | 88955 Sceptile ex (Delta Species) | delta |

</details>

### `bw7` Boundaries Crossed

- Group(s): 1408 Boundaries Crossed (same, 153 card products)
- TCGdex cards: 153; cards with no id: 14; exact matches: 0; matches by an equivalence: 8; misses: 6; special only: 0.

<details>
<summary>8 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 9 | Celebi-EX | 84152 Celebi EX | hyphen-suffix |
| 49 | Keldeo-EX | 86436 Keldeo EX | hyphen-suffix |
| 67 | Cresselia-EX | 84470 Cresselia EX | hyphen-suffix |
| 89 | Landorus-EX | 86595 Landorus EX | hyphen-suffix |
| 101 | Black Kyurem-EX | 83853 Black Kyurem EX | hyphen-suffix |
| 103 | White Kyurem-EX | 90588 White Kyurem EX | hyphen-suffix |
| 107 | Farfetch’d | 85389 Farfetch'd | apostrophe |
| 131 | Poké Ball | 88193 Poke Ball | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 141 | Celebi-EX | missed | 84153 Celebi EX (141 Full Art) (141/149) |
| 142 | Keldeo-EX | missed | 86439 Keldeo EX (142 Full Art) (142/149) |
| 143 | Cresselia-EX | missed | 84471 Cresselia EX (143 Full Art) (143/149) |
| 144 | Landorus-EX | missed | 86596 Landorus EX (144 Full Art) (144/149) |
| 145 | Black Kyurem-EX | missed | 83857 Black Kyurem EX (145 Full Art) (145/149) |
| 146 | White Kyurem-EX | missed | 90592 White Kyurem EX (146 Full Art) (146/149) |

### `bw4` Next Destinies

- Group(s): 1412 Next Destinies (same, 103 card products)
- TCGdex cards: 103; cards with no id: 13; exact matches: 0; matches by an equivalence: 7; misses: 6; special only: 0.

<details>
<summary>7 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 5 | Shaymin-EX | 89111 Shaymin EX | hyphen-suffix |
| 22 | Reshiram-EX | 88713 Reshiram EX | hyphen-suffix |
| 38 | Kyurem-EX | 86566 Kyurem EX | hyphen-suffix |
| 51 | Zekrom-EX | 90740 Zekrom EX | hyphen-suffix |
| 54 | Mewtwo-EX | 87429 Mewtwo EX | hyphen-suffix |
| 82 | Regigigas-EX | 88666 Regigigas EX | hyphen-suffix |
| 90 | Pokémon Center | 88215 Pokemon Center | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 94 | Shaymin-EX | missed | 89112 Shaymin EX (94 Full Art) (94/99) |
| 95 | Reshiram-EX | missed | 88716 Reshiram EX (95 Full Art) (95/99) |
| 96 | Kyurem-EX | missed | 86570 Kyurem EX (96 Full Art) (96/99) |
| 97 | Zekrom-EX | missed | 90743 Zekrom EX (97 Full Art) (97/99) |
| 98 | Mewtwo-EX | missed | 87432 Mewtwo EX (98 Full Art) (98/99) |
| 99 | Regigigas-EX | missed | 88667 Regigigas EX (99 Full Art) (99/99) |

### `sm12` Cosmic Eclipse

- Group(s): 2534 SM - Cosmic Eclipse (same, 271 card products)
- TCGdex cards: 271; cards with no id: 12; exact matches: 0; matches by an equivalence: 7; misses: 5; special only: 0.

<details>
<summary>7 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 149 | Flabébé | 201193 Flabebe - 149/236 | accent |
| 150 | Flabébé | 201194 Flabebe - 150/236 | accent |
| 195 | Lana’s Fishing Rod | 201316 Lana's Fishing Rod | apostrophe |
| 196 | Lillie’s Full Force | 201317 Lillie's Full Force | apostrophe |
| 197 | Lillie’s Poké Doll | 201318 Lillie's Poke Doll | accent+apostrophe |
| 200 | N’s Resolve | 201321 N's Resolve | apostrophe |
| 201 | Professor Oak’s Setup | 201322 Professor Oak's Setup | apostrophe |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 230 | Lillie’s Full Force | missed | 201344 Lillie's Full Force (Full Art) (230/236) |
| 232 | N’s Resolve | missed | 201979 N's Resolve (Full Art) (232/236) |
| 233 | Professor Oak’s Setup | missed | 201981 Professor Oak's Setup (Full Art) (233/236) |
| 266 | Lana’s Fishing Rod | missed | 201631 Lana's Fishing Rod (Secret) (266/236) |
| 267 | Lillie’s Poké Doll | missed | 201632 Lillie's Poke Doll (Secret) (267/236) |

### `bw5` Dark Explorers

- Group(s): 1386 Dark Explorers (same, 111 card products)
- TCGdex cards: 111; cards with no id: 13; exact matches: 0; matches by an equivalence: 6; misses: 7; special only: 0.
- Doubtful: low match rate.

<details>
<summary>6 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 13 | Entei-EX | 85279 Entei EX | hyphen-suffix |
| 26 | Kyogre-EX | 86559 Kyogre EX | hyphen-suffix |
| 38 | Raikou-EX | 88541 Raikou EX | hyphen-suffix |
| 54 | Groudon-EX | 85932 Groudon EX | hyphen-suffix |
| 63 | Darkrai-EX | 84706 Darkrai EX | hyphen-suffix |
| 90 | Tornadus-EX | 89978 Tornadus EX | hyphen-suffix |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 103 | Entei-EX | missed | 85280 Entei EX (103 Full Art) (103/108) |
| 104 | Kyogre-EX | missed | 86560 Kyogre EX (104 Full Art) (104/108) |
| 105 | Raikou-EX | missed | 88542 Raikou EX (105 Full Art) (105/108) |
| 106 | Groudon-EX | missed | 85933 Groudon EX (106 Full Art) (106/108) |
| 107 | Darkrai-EX | missed | 84709 Darkrai EX (107 Full Art) (107/108) |
| 108 | Tornadus-EX | missed | 89980 Tornadus EX (108 Full Art) (108/108) |
| 111 | Pokémon Catcher | missed | 88212 Pokemon Catcher (Gold) (111/108) |

### `bw6` Dragons Exalted

- Group(s): 1394 Dragons Exalted (same, 128 card products)
- TCGdex cards: 128; cards with no id: 14; exact matches: 0; matches by an equivalence: 6; misses: 8; special only: 0.
- Doubtful: low match rate.

<details>
<summary>6 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 22 | Ho-Oh-EX | 86130 Ho-Oh EX | hyphen-suffix |
| 46 | Mew-EX | 87411 Mew EX | hyphen-suffix |
| 71 | Terrakion-EX | 89892 Terrakion EX | hyphen-suffix |
| 81 | Registeel-EX | 88681 Registeel EX | hyphen-suffix |
| 85 | Rayquaza-EX | 88645 Rayquaza EX | hyphen-suffix |
| 92 | Giratina-EX | 85740 Giratina EX | hyphen-suffix |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 117 | Blend Energy Grass Fire Psychic Darkness | missed | 83916 Blend Energy GFPD (117/124) |
| 118 | Blend Energy Water Lightning Fighting Metal | missed | 83917 Blend Energy WLFM (118/124) |
| 119 | Ho-Oh-EX | missed | 86131 Ho-Oh Ex (119 Full Art) (119/124) |
| 120 | Mew-EX | missed | 87412 Mew EX (120 Full Art) (120/124) |
| 121 | Terrakion-EX | missed | 89893 Terrakion EX (121 Full Art) (121/124) |
| 122 | Registeel-EX | missed | 88682 Registeel EX (122 Full Art) (122/124) |
| 123 | Rayquaza-EX | missed | 88648 Rayquaza EX (123 Full Art) (123/124) |
| 124 | Giratina-EX | missed | 85741 Giratina EX (124 Full Art) (124/124) |

### `sm10` Unbroken Bonds

- Group(s): 2420 SM - Unbroken Bonds (same, 234 card products)
- TCGdex cards: 234; cards with no id: 11; exact matches: 0; matches by an equivalence: 6; misses: 5; special only: 0.

<details>
<summary>6 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 174 | Giovanni’s Exile | 189276 Giovanni's Exile | apostrophe |
| 175 | Green’s Exploration | 189277 Green's Exploration | apostrophe |
| 177 | Koga’s Trap | 189281 Koga's Trap | apostrophe |
| 178 | Lt. Surge’s Strategy | 189283 Lt. Surge's Strategy | apostrophe |
| 182 | Pokégear 3.0 | 189289 Pokegear 3.0 | accent |
| 184 | Red’s Challenge | 189292 Red's Challenge | apostrophe |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 172 | Fairy Charm Lightning | missed | 189273 Fairy Charm L (172/214) |
| 209 | Green’s Exploration | missed | 189278 Green's Exploration (Full Art) (209/214) |
| 211 | Koga’s Trap | missed | 189282 Koga's Trap (Full Art) (211/214) |
| 213 | Red’s Challenge | missed | 189293 Red's Challenge (Full Art) (213/214) |
| 233 | Pokégear 3.0 | missed | 189290 Pokegear 3.0 (Secret) (233/214) |

### `sm9` Team Up

- Group(s): 2377 SM - Team Up (same, 196 card products)
- TCGdex cards: 196; cards with no id: 16; exact matches: 0; matches by an equivalence: 6; misses: 10; special only: 0.
- Doubtful: low match rate.

<details>
<summary>6 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 127 | Farfetch’d | 183916 Farfetch'd | apostrophe |
| 133 | Bill’s Analysis | 183922 Bill's Analysis | apostrophe |
| 135 | Brock’s Grit | 183924 Brock's Grit | apostrophe |
| 140 | Erika’s Hospitality | 183934 Erika's Hospitality | apostrophe |
| 152 | Pokémon Communication | 183954 Pokemon Communication | accent |
| 154 | Sabrina’s Suggestion | 183957 Sabrina's Suggestion | apostrophe |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 10 | Shaymin ◇ | missed | 183781 Shaymin Prism Star (10/181) |
| 51 | Tapu Koko ◇ | missed | 183826 Tapu Koko Prism Star (51/181) |
| 54 | Nidoran♀ | missed | 183832 Nidoran F (54/181) |
| 57 | Nidoran♂ | missed | 183835 Nidoran M (57/181) |
| 134 | Black Market ◇ | missed | 183923 Black Market Prism Star (134/181) |
| 158 | Wondrous Labyrinth ◇ | missed | 183962 Wondrous Labyrinth Prism Star (158/181) |
| 172 | Brock’s Grit | missed | 183925 Brock's Grit (Full Art) (172/181) |
| 174 | Erika’s Hospitality | missed | 183933 Erika's Hospitality (Full Art) (174/181) |
| 181 | Sabrina’s Suggestion | missed | 183958 Sabrina's Suggestion (Full Art) (181/181) |
| 196 | Pokémon Communication | missed | 183955 Pokemon Communication (Secret) (196/181) |

### `base4` Base Set 2

- Group(s): 605 Base Set 2 (same, 130 card products)
- TCGdex cards: 130; cards with no id: 8; exact matches: 0; matches by an equivalence: 5; misses: 3; special only: 0.

<details>
<summary>5 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 105 | Pokémon Breeder | 42555 Pokemon Breeder | accent |
| 106 | Pokémon Trader | 106358 Pokemon Trader | accent |
| 114 | Pokémon Center | 106359 Pokemon Center | accent |
| 115 | Pokédex | 106360 Pokedex | accent |
| 121 | Poké Ball | 106361 Poke Ball | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 82 | Nidoran♀ | missed | 106357 Nidoran F (082/130) |
| 83 | Nidoran♂ | missed | 42534 Nidoran M (083/130) |
| 102 | Impostor Professor Oak | missed | 42552 Imposter Professor Oak (102/130) |

### `bw10` Plasma Blast

- Group(s): 1370 Plasma Blast (same, 105 card products)
- TCGdex cards: 105; cards with no id: 12; exact matches: 0; matches by an equivalence: 4; misses: 8; special only: 0.
- Doubtful: low match rate.

<details>
<summary>4 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 9 | Virizion-EX | 90393 Virizion EX | hyphen-suffix |
| 30 | Kyurem-EX | 86568 Kyurem EX | hyphen-suffix |
| 60 | Jirachi-EX | 86333 Jirachi EX | hyphen-suffix |
| 83 | Pokémon Catcher | 88210 Pokemon Catcher | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 11 | Genesect-EX | missed | 85665 Genesect EX (Team Plasma) (11/101) |
| 65 | Dialga-EX | missed | 84808 Dialga EX (Team Plasma) (65/101) |
| 66 | Palkia-EX | missed | 87915 Palkia EX (Team Plasma) (66/101) |
| 96 | Virizion-EX | missed | 90394 Virizion EX (Full Art) (96/101) |
| 97 | Genesect-EX | missed | 85666 Genesect EX (Team Plasma) (97 Full Art) (97/101) |
| 98 | Jirachi-EX | missed | 86334 Jirachi EX (98 Full Art) (98/101) |
| 99 | Dialga-EX | missed | 84809 Dialga EX (Team Plasma) (99 Full Art) (99/101) |
| 100 | Palkia-EX | missed | 87916 Palkia EX (Team Plasma) (100 Full Art) (100/101) |

### `bw8` Plasma Storm

- Group(s): 1413 Plasma Storm (same, 138 card products)
- TCGdex cards: 138; cards with no id: 12; exact matches: 0; matches by an equivalence: 4; misses: 8; special only: 0.
- Doubtful: low match rate.

<details>
<summary>4 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 18 | Victini-EX | 90350 Victini EX | hyphen-suffix |
| 93 | Cobalion-EX | 84382 Cobalion EX | hyphen-suffix |
| 95 | Black Kyurem-EX | 83854 Black Kyurem EX | hyphen-suffix |
| 96 | White Kyurem-EX | 90589 White Kyurem EX | hyphen-suffix |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 14 | Moltres-EX | missed | 87568 Moltres EX (Team Plasma) (14/135) |
| 25 | Articuno-EX | missed | 83656 Articuno EX (Team Plasma) (25/135) |
| 48 | Zapdos-EX | missed | 90725 Zapdos EX (Team Plasma) (48/135) |
| 108 | Lugia-EX | missed | 86913 Lugia EX (Team Plasma) (108/135) |
| 131 | Victini-EX | missed | 90352 Victini EX (131 Full Art) (131/135) |
| 132 | Articuno-EX | missed | 83657 Articuno EX (Team Plasma) (132 Full Art) (132/135) |
| 133 | Cobalion-EX | missed | 84383 Cobalion EX (133 Full Art) (133/135) |
| 134 | Lugia-EX | missed | 86916 Lugia EX (Team Plasma) (134 Full Art) (134/135) |

### `sm11` Unified Minds

- Group(s): 2464 SM - Unified Minds (same, 258 card products)
- TCGdex cards: 258; cards with no id: 7; exact matches: 0; matches by an equivalence: 4; misses: 3; special only: 0.

<details>
<summary>4 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 188 | Blue’s Tactics | 195218 Blue's Tactics | apostrophe |
| 202 | Misty’s Favor | 195257 Misty's Favor | apostrophe |
| 204 | Poké Maniac | 195259 Poke Maniac | accent |
| 205 | Pokémon Research Lab | 195262 Pokemon Research Lab | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 231 | Blue’s Tactics | missed | 195292 Blue's Tactics (Full Art) (231/236) |
| 235 | Misty’s Favor | missed | 195296 Misty's Favor (Full Art) (235/236) |
| 236 | Poké Maniac | missed | 195298 Poke Maniac (Full Art) (236/236) |

### `swsh1` Sword & Shield

- Group(s): 2585 SWSH01: Sword & Shield Base Set (subset, 216 card products)
- TCGdex cards: 216; cards with no id: 7; exact matches: 0; matches by an equivalence: 4; misses: 3; special only: 0.
- Doubtful: name twin rejected.
- Rejected name candidate: 2545 SWSH: Sword & Shield Promo Cards (subset); it matched no card the chosen groups missed.

<details>
<summary>4 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 173 | Poké Kid | 208503 Poke Kid | accent |
| 174 | Pokégear 3.0 | 208504 Pokegear 3.0 | accent |
| 175 | Pokémon Catcher | 208505 Pokemon Catcher | accent |
| 176 | Pokémon Center Lady | 208506 Pokemon Center Lady | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 178 | Professor's Research (Professor Magnolia) | missed | 208508 Professor's Research [Professor Magnolia] (178/202) |
| 201 | Professor's Research (Professor Magnolia) | missed | 208509 Professor's Research [Professor Magnolia] (Full Art) (201/202) |
| 209 | Professor's Research (Professor Magnolia) | missed | 208510 Professor's Research [Professor Magnolia] (Secret) (209/202) |

### `xy2` Flashfire

- Group(s): 1464 XY - Flashfire (same, 109 card products)
- TCGdex cards: 110; cards with no id: 7; exact matches: 0; matches by an equivalence: 4; misses: 3; special only: 0.

<details>
<summary>4 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 62 | Flabébé | 91199 Flabebe (62) | accent |
| 63 | Flabébé | 91200 Flabebe (63) | accent |
| 93 | Pokémon Center Lady | 91230 Pokemon Center Lady | accent |
| 94 | Pokémon Fan Club | 91231 Pokemon Fan Club | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 88a | Blacksmith | missed | none |
| 105 | Pokémon Center Lady | missed | 91243 Pokemon Center Lady (105 Full Art) (105/106) |
| 106 | Pokémon Fan Club | missed | 91244 Pokemon Fan Club (106 Full Art) (106/106) |

### `bw1` Black & White

- Group(s): 1400 Black and White (same, 115 card products)
- TCGdex cards: 115; cards with no id: 3; exact matches: 0; matches by an equivalence: 3; misses: 0; special only: 0.
- Doubtful: name twin rejected.
- Rejected name candidate: 1407 Black and White Promos (subset); it matched no card the chosen groups missed.

<details>
<summary>3 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 97 | Poké Ball | 88192 Poke Ball | accent |
| 98 | Pokédex | 88200 Pokedex | accent |
| 99 | Pokémon Communication | 88223 Pokemon Communication | accent |

</details>

### `dp7` Stormfront

- Group(s): 1369 Stormfront (same, 106 card products)
- TCGdex cards: 106; cards with no id: 6; exact matches: 0; matches by an equivalence: 3; misses: 3; special only: 0.

<details>
<summary>3 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 88 | Poké Blower + | 88195 Poke Blower + | accent |
| 89 | Poké Drawer + | 88196 Poke Drawer + | accent |
| 90 | Poké Healer + | 88197 Poke Healer + | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| SH1 | Drifloon | missed | 84958 Drifloon (Shiny) (SH1) |
| SH2 | Duskull | missed | 85054 Duskull (Shiny) (SH2) |
| SH3 | Voltorb | missed | 90421 Voltorb (Shiny) (SH3) |

### `neo1` Neo Genesis

- Group(s): 1396 Neo Genesis (same, 111 card products)
- TCGdex cards: 111; cards with no id: 3; exact matches: 0; matches by an equivalence: 3; misses: 0; special only: 0.

<details>
<summary>3 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 88 | PokéGear | 88204 PokeGear | accent |
| 95 | New Pokédex | 87690 New Pokedex | accent |
| 102 | Pokémon March | 88228 Pokemon March | accent |

</details>

### `sm7` Celestial Storm

- Group(s): 2278 SM - Celestial Storm (same, 183 card products)
- TCGdex cards: 183; cards with no id: 9; exact matches: 0; matches by an equivalence: 3; misses: 6; special only: 0.
- Doubtful: low match rate.

<details>
<summary>3 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 126 | Bill’s Maintenance | 170987 Bill's Maintenance | apostrophe |
| 140 | PokéNav | 171001 PokeNav | accent |
| 145 | Steven’s Resolve | 171006 Steven's Resolve | apostrophe |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 97 | Jirachi ◇ | missed | 170922 Jirachi Prism Star (97/168) |
| 107 | Latias ◇ | missed | 170934 Latias Prism Star (107/168) |
| 108 | Latios ◇ | missed | 170935 Latios Prism Star (108/168) |
| 162 | Bill’s Maintenance | missed | 171014 Bill's Maintenance (Full Art) (162/168) |
| 165 | Steven’s Resolve | missed | 171017 Steven's Resolve (Full Art) (165/168) |
| 181 | PokéNav | missed | 171024 PokeNav (Secret) (181/168) |

### `bw9` Plasma Freeze

- Group(s): 1382 Plasma Freeze (same, 122 card products)
- TCGdex cards: 122; cards with no id: 14; exact matches: 0; matches by an equivalence: 2; misses: 12; special only: 0.
- Doubtful: low match rate.

<details>
<summary>2 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 85 | Latias-EX | 86660 Latias EX | hyphen-suffix |
| 86 | Latios-EX | 86674 Latios EX | hyphen-suffix |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 13 | Heatran-EX | missed | 86052 Heatran EX (Team Plasma) (13/116) |
| 38 | Thundurus-EX | missed | 89907 Thundurus EX (Team Plasma) (38/116) |
| 40 | Nidoran♀ | missed | 87721 Nidoran F (40/116) |
| 43 | Nidoran♂ | missed | 87730 Nidoran M (43/116) |
| 53 | Deoxys-EX | missed | 84775 Deoxys EX (Team Plasma) (53/116) |
| 98 | Tornadus-EX | missed | 89981 Tornadus EX (Team Plasma) (98/116) |
| 109 | Heatran-EX | missed | 86053 Heatran EX (Team Plasma) (Full Art) (109/116) |
| 110 | Thundurus-EX | missed | 89909 Thundurus EX (Team Plasma) (110 Full Art) (110/116) |
| 111 | Deoxys-EX | missed | 84777 Deoxys EX (Team Plasma) (Full Art) (111/116) |
| 112 | Latias-EX | missed | 86662 Latias EX (112 Full Art) (112/116) |
| 113 | Latios-EX | missed | 86676 Latios EX (113 Full Art) (113/116) |
| 114 | Tornadus-EX | missed | 89982 Tornadus EX (Team Plasma) (114 Full Art) (114/116) |

### `dp1` Diamond & Pearl

- Group(s): 1430 Diamond and Pearl (same, 130 card products)
- TCGdex cards: 130; cards with no id: 7; exact matches: 0; matches by an equivalence: 2; misses: 5; special only: 0.
- Doubtful: name twin rejected, low match rate.
- Rejected name candidate: 1421 Diamond and Pearl Promos (subset); it matched no card the chosen groups missed.

<details>
<summary>2 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 108 | Night Pokémon Center | 87753 Night Pokemon Center | accent |
| 110 | Poké Ball | 88186 Poke Ball | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 65 | Unown A | missed | 90198 Unown [A] (65/130) |
| 66 | Unown B | missed | 90200 Unown [B] (66/130) |
| 67 | Unown C | missed | 90202 Unown [C] (67/130) |
| 68 | Unown D | missed | 90204 Unown [D] (68/130) |
| 111 | Pokédex HANDY910is | missed | 88202 Pokedex (HANDY910is) (111/130) |

### `dp6` Legends Awakened

- Group(s): 1417 Legends Awakened (same, 146 card products)
- TCGdex cards: 146; cards with no id: 10; exact matches: 1; matches by an equivalence: 1; misses: 8; special only: 0.
- Doubtful: low match rate.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 133 | Poké Radar | 88198 Poke Radar | accent |

</details>

<details>
<summary>1 exact matches</summary>

50 Castform Snow-cloud Form = 84130

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 42 | Unown ! | missed | 90194 Unown (!) (42/146) |
| 76 | Unown J | missed | 90216 Unown (J) (76/146) |
| 77 | Unown R | missed | 90231 Unown (R) (77/146) |
| 78 | Unown U | missed | 90237 Unown (U) (78/146) |
| 79 | Unown V | missed | 90239 Unown (V) (79/146) |
| 80 | Unown W | missed | 90241 Unown (W) (80/146) |
| 81 | Unown Y | missed | 90245 Unown (Y) (81/146) |
| 82 | Unown ? | missed | 90195 Unown (?) (82/146) |

### `ex7` Team Rocket Returns

- Group(s): 1428 EX Team Rocket Returns (same, 111 card products)
- TCGdex cards: 111; cards with no id: 2; exact matches: 0; matches by an equivalence: 2; misses: 0; special only: 0.

<details>
<summary>2 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 84 | Pokémon Retriever | 88234 Pokemon Retriever | accent |
| 89 | Rocket's Poké Ball | 88784 Rocket's Poke Ball | accent |

</details>

### `ru1` Pokémon Rumble

- Group(s): 1433 Rumble (same, 16 card products)
- TCGdex cards: 16; cards with no id: 2; exact matches: 2; matches by an equivalence: 0; misses: 0; special only: 0.

<details>
<summary>2 exact matches</summary>

3 Ninetales = 87775; 4 Heatran = 86051

</details>

### `sm3.5` Shining Legends

- Group(s): 2054 Shining Legends (same, 78 card products)
- TCGdex cards: 78; cards with no id: 3; exact matches: 0; matches by an equivalence: 2; misses: 1; special only: 0.

<details>
<summary>2 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 63 | Pokémon Breeder | 146730 Pokemon Breeder | accent |
| 64 | Pokémon Catcher | 146724 Pokemon Catcher | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 73 | Pokémon Breeder | missed | 146731 Pokemon Breeder (Full Art) (73/73) |

### `sm6` Forbidden Light

- Group(s): 2209 SM - Forbidden Light (same, 146 card products)
- TCGdex cards: 146; cards with no id: 9; exact matches: 0; matches by an equivalence: 2; misses: 7; special only: 0.
- Doubtful: low match rate.

<details>
<summary>2 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 83 | Flabébé | 165741 Flabebe (83) | accent |
| 84 | Flabébé | 165742 Flabebe (84) | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 31 | Volcanion ◇ | missed | 165682 Volcanion Prism Star (31/131) |
| 74 | Diancie ◇ | missed | 165728 Diancie Prism Star (74/131) |
| 96 | Arceus ◇ | missed | 165758 Arceus Prism Star (96/131) |
| 110 | Lysandre ◇ | missed | 165773 Lysandre Prism Star (110/131) |
| 117 | Beast Energy ◇ | missed | 165779 Beast Energy Prism Star (117/131) |
| 118 | Unit Energy FightingDarknessFairy | missed | 165790 Unit Energy FDY (118/131) |
| 146 | Unit Energy FightingDarknessFairy | missed | 165791 Unit Energy FDY (Secret) (146/131) |

### `swsh3.5` Champion's Path

- Group(s): 2685 Champion's Path (same, 80 card products)
- TCGdex cards: 80; cards with no id: 3; exact matches: 0; matches by an equivalence: 2; misses: 1; special only: 0.

<details>
<summary>2 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 59 | Poké Ball | 223059 Poke Ball | accent |
| 60 | Pokémon Center Lady | 223060 Pokemon Center Lady | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 62 | Professor's Research (Professor Magnolia) | missed | 223062 Professor's Research [Professor Magnolia] (62/73) |

### `xy0` Kalos Starter Set

- Group(s): 1522 Kalos Starter Set (same, 39 card products)
- TCGdex cards: 39; cards with no id: 2; exact matches: 0; matches by an equivalence: 2; misses: 0; special only: 0.

<details>
<summary>2 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 35 | Poké Ball | 88194 Poke Ball | accent |
| 36 | Pokémon Catcher | 88211 Pokemon Catcher | accent |

</details>

### `xy11` Steam Siege

- Group(s): 1815 XY - Steam Siege (same, 116 card products)
- TCGdex cards: 116; cards with no id: 4; exact matches: 0; matches by an equivalence: 2; misses: 2; special only: 0.

<details>
<summary>2 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 99 | Captivating Poké Puff | 120157 Captivating Poke Puff | accent |
| 104 | Pokémon Ranger | 121228 Pokemon Ranger | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 43 | Nidoran♂ | missed | 121132 Nidoran M (43/114) |
| 113 | Pokémon Ranger | missed | 121237 Pokemon Ranger (Full Art) (113/114) |

### `base2` Jungle

- Group(s): 635 Jungle (same, 64 card products)
- TCGdex cards: 64; cards with no id: 2; exact matches: 0; matches by an equivalence: 1; misses: 1; special only: 0.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 64 | Poké Ball | 45167 Poke Ball | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 57 | Nidoran♀ | missed | 45160 Nidoran F (57/64) |

### `bw2` Emerging Powers

- Group(s): 1424 Emerging Powers (same, 98 card products)
- TCGdex cards: 98; cards with no id: 1; exact matches: 0; matches by an equivalence: 1; misses: 0; special only: 0.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 95 | Pokémon Catcher | 88209 Pokemon Catcher | accent |

</details>

### `dp5` Majestic Dawn

- Group(s): 1390 Majestic Dawn (same, 100 card products)
- TCGdex cards: 100; cards with no id: 3; exact matches: 0; matches by an equivalence: 1; misses: 2; special only: 0.
- Doubtful: low match rate.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 85 | Poké Ball | 88187 Poke Ball | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 33 | Unown P | missed | 90228 Unown [P] (33/100) |
| 49 | Unown Q | missed | 90230 Unown [Q] (49/100) |

### `ex12` Legend Maker

- Group(s): 1378 EX Legend Maker (same, 93 card products)
- TCGdex cards: 93; cards with no id: 1; exact matches: 0; matches by an equivalence: 1; misses: 0; special only: 0.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 93 | Pikachu δ | 88107 Pikachu (Delta Species) | delta |

</details>

### `ex9` Emerald

- Group(s): 1410 EX Emerald (same, 107 card products)
- TCGdex cards: 107; cards with no id: 1; exact matches: 0; matches by an equivalence: 1; misses: 0; special only: 0.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 81 | PokéNav | 88244 Pokenav | accent |

</details>

### `neo2` Neo Discovery

- Group(s): 1434 Neo Discovery (same, 75 card products)
- TCGdex cards: 75; cards with no id: 1; exact matches: 1; matches by an equivalence: 0; misses: 0; special only: 0.

<details>
<summary>1 exact matches</summary>

26 Magnemite = 87065

</details>

### `neo3` Neo Revelation

- Group(s): 1389 Neo Revelation (same, 66 card products)
- TCGdex cards: 66; cards with no id: 1; exact matches: 0; matches by an equivalence: 1; misses: 0; special only: 0.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 62 | Pokémon Breeder Fields | 88208 Pokemon Breeder Fields | accent |

</details>

### `neo4` Neo Destiny

- Group(s): 1444 Neo Destiny (same, 113 card products)
- TCGdex cards: 113; cards with no id: 2; exact matches: 0; matches by an equivalence: 1; misses: 1; special only: 0.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 102 | Pokémon Personality Test | 88232 Pokemon Personality Test | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 33 | Dark Exeggutor | missed | 84593 Dark Exeggcutor (033/105) |

### `sm5` Ultra Prism

- Group(s): 2178 SM - Ultra Prism (same, 173 card products)
- TCGdex cards: 173; cards with no id: 12; exact matches: 0; matches by an equivalence: 1; misses: 11; special only: 0.
- Doubtful: low match rate.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 133 | Pokémon Fan Club | 157749 Pokemon Fan Club | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 58 | Giratina ◇ | missed | 157675 Giratina Prism Star (58/156) |
| 62 | Lunala ◇ | missed | 157679 Lunala Prism Star (62/156) |
| 77 | Darkrai ◇ | missed | 157694 Darkrai Prism Star (77/156) |
| 89 | Solgaleo ◇ | missed | 157706 Solgaleo Prism Star (89/156) |
| 120 | Cyrus ◇ | missed | 157737 Cyrus Prism Star (120/156) |
| 136 | Super Boost Energy ◇ | missed | 157752 Super Boost Energy Prism Star (136/156) |
| 137 | Unit Energy GrassFireWater | missed | 157753 Unit Energy GRW (137/156) |
| 138 | Unit Energy LightningPsychicMetal | missed | 157754 Unit Energy LPM (138/156) |
| 155 | Pokémon Fan Club | missed | 157771 Pokemon Fan Club (Full Art) (155/156) |
| 170 | Unit Energy GrassFireWater | missed | 157786 Unit Energy GRW (Secret Rare) (170/156) |
| 171 | Unit Energy LightningPsychicMetal | missed | 157787 Unit Energy LPM (Secret Rare) (171/156) |

### `sm7.5` Dragon Majesty

- Group(s): 2295 Dragon Majesty (same, 78 card products)
- TCGdex cards: 78; cards with no id: 4; exact matches: 0; matches by an equivalence: 1; misses: 3; special only: 0.
- Doubtful: low match rate.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 58 | Blaine’s Last Stand | 175488 Blaine's Last Stand | apostrophe |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 7 | Victini ◇ | missed | 175275 Victini Prism Star (7/70) |
| 61 | Lance ◇ | missed | 175491 Lance Prism Star (61/70) |
| 69 | Blaine’s Last Stand | missed | 175499 Blaine's Last Stand (Full Art) (69/70) |

### `sm8` Lost Thunder

- Group(s): 2328 SM - Lost Thunder (same, 236 card products)
- TCGdex cards: 236; cards with no id: 13; exact matches: 0; matches by an equivalence: 1; misses: 12; special only: 0.
- Doubtful: low match rate.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 188 | Professor Elm’s Lecture | 179023 Professor Elm's Lecture | apostrophe |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 19 | Celebi ◇ | missed | 178818 Celebi Prism Star (19/214) |
| 144 | Xerneas ◇ | missed | 178963 Xerneas Prism Star (144/214) |
| 154 | Ditto ◇ | missed | 178975 Ditto Prism Star (154/214) |
| 174 | Fairy Charm Grass | missed | 179003 Fairy Charm G (174/214) |
| 175 | Fairy Charm Psychic | missed | 179004 Fairy Charm P (175/214) |
| 176 | Fairy Charm Fighting | missed | 179005 Fairy Charm F (176/214) |
| 177 | Fairy Charm Dragon | missed | 179006 Fairy Charm O (177/214) |
| 178 | Heat Factory ◇ | missed | 179007 Heat Factory Prism Star (178/214) |
| 180 | Life Forest ◇ | missed | 179011 Life Forest Prism Star (180/214) |
| 182 | Lusamine ◇ | missed | 179014 Lusamine Prism Star (182/214) |
| 191 | Thunder Mountain ◇ | missed | 179028 Thunder Mountain Prism Star (191/214) |
| 213 | Professor Elm’s Lecture | missed | 179024 Professor Elm's Lecture (Full Art) (213/214) |

### `xy10` Fates Collide

- Group(s): 1780 XY - Fates Collide (same, 125 card products)
- TCGdex cards: 129; cards with no id: 5; exact matches: 0; matches by an equivalence: 1; misses: 4; special only: 0.
- Doubtful: low match rate.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 107 | Pokémon Fan Club | 117879 Pokemon Fan Club | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 43a | Regirock EX | missed | none |
| 54a | Zygarde EX | missed | none |
| 105a | N | missed | none |
| 111a | Shauna | missed | none |

### `xy12` Evolutions

- Group(s): 1842 XY - Evolutions (same, 113 card products)
- TCGdex cards: 113; cards with no id: 3; exact matches: 0; matches by an equivalence: 1; misses: 2; special only: 0.
- Doubtful: name twin rejected, low match rate.
- Rejected name candidate: 23821 SV: Prismatic Evolutions (subset); it matched no card the chosen groups missed.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 82 | Pokédex | 124095 Pokedex | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 43 | Nidoran♂ | missed | 124056 Nidoran M (43/108) |
| 109 | ナッシー[Exeggutor] | missed | 124122 Exeggutor (109/108) |

### `xy8` BREAKthrough

- Group(s): 1661 XY - BREAKthrough (same, 164 card products)
- TCGdex cards: 165; cards with no id: 2; exact matches: 0; matches by an equivalence: 1; misses: 1; special only: 0.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 101 | Flabébé | 107220 Flabebe | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 146a | Professor's Letter | missed | none |

### `xy9` BREAKpoint

- Group(s): 1701 XY - BREAKpoint (same, 123 card products)
- TCGdex cards: 126; cards with no id: 4; exact matches: 0; matches by an equivalence: 1; misses: 3; special only: 0.
- Doubtful: low match rate.

<details>
<summary>1 matches by an equivalence</summary>

| Number | Card | Product | Equivalence |
| --- | --- | --- | --- |
| 105 | Pokémon Catcher | 111635 Pokemon Catcher | accent |

</details>

Misses:

| Number | Card | Outcome | Candidates on the number |
| --- | --- | --- | --- |
| 98a | Delinquent | missed | none |
| 98b | Delinquent | missed | none |
| 107a | Professor Sycamore | missed | none |
