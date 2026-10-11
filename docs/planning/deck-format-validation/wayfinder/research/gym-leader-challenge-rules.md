# Research: Gym Leader Challenge construction rules

**Ticket:** [#70 Research Gym Leader Challenge construction rules](https://github.com/ry-cen/tcg-tracker/issues/70)

**Researched:** 2026-10-10

**Question:** What are the current Gym Leader Challenge (GLC) deck construction rules, according to the format's own authority? And which per-card attributes would an advisory validator need?

## Sources

Primary sources are the format's own site, gymleaderchallenge.com. All of them were read on 2026-10-10.

- [Rules](https://gymleaderchallenge.com/rules) (P-Rules): the short construction summary.
- [FAQ and Rulings](https://gymleaderchallenge.com/faq) (P-FAQ): clarifications. The page has no last-updated date.
- [Ban List](https://gymleaderchallenge.com/ban-list) (P-Ban): each ban with its effective date and a link to the announcement.
- [Getting Started Guide overview](https://gymleaderchallenge.com/overview) (P-Guide): the guide, last updated March 2026 for the Perfect Order set.
- [Colorless type page](https://gymleaderchallenge.com/colorless) (P-Colorless).
- [Blog index](https://gymleaderchallenge.com/news) (P-News). The posts used are [GLC Update 1.6](https://gymleaderchallenge.com/news/v19xdyflddh37cw6wx03xe1s7w2eqr) (2025-04-07), [Dimension Valley Banned](https://gymleaderchallenge.com/news/dimension-valley-banned) (2026-04-06) and [One Year of GLC](https://gymleaderchallenge.com/news/one-year-of-glc) (2022-07-14).

Secondary sources:

- [Bulbapedia: Gym Leader Challenge format](https://bulbapedia.bulbagarden.net/wiki/Gym_Leader_Challenge_format_(TCG)), seen through search-result excerpts. It was used only for the creator, the launch date and recognition by Pokémon. **Secondary.**
- Pokémon.com's article "Side Event Breakdown: Gym Leader Challenge" sits behind a bot check and could not be read. Its search snippet describes GLC as a fan-made format created by Andrew Mahone. **Secondary.**

The Bulbapedia search excerpt also claimed Rule Box Pokémon were "allowed" from 2021-11-16, when the first bans took effect. P-Rules, P-Guide and P-FAQ all say otherwise. The claim appears garbled and is disregarded.

Pages were read through a summarizing fetch tool. Short quotes are verbatim as returned.

## Findings

### Who maintains the format

- GLC is a fan-made format, not a format run by Pokémon. Andrew Mahone (Tricky Gym) created it, launching around 2021-07-14. Bulbapedia gives that date (secondary). P-News's "One Year of GLC" post dated 2022-07-14 marks the first anniversary, which agrees. **High confidence.**
- The official site carries Tricky Gym branding and sends rules questions to the Tricky Gym Discord (P-FAQ, P-Rules). Every ban announcement ("GLC Update 1.x" and "Dimension Valley Banned") is written by Andrew Mahone in the first person (P-News, Update 1.6). No committee is named. **High confidence** that Mahone and Tricky Gym are the authority.
- Pokémon acknowledges the format but does not run it. Secondary sources say it appears in the official Alternative Play Handbook and has been a side event at Worlds 2022 and EUIC 2023. P-FAQ notes that "as of January 2024" Pokémon's rulings team treats the game as knowing the format, and some older GLC rulings were adjusted as a result. **Medium confidence** on the details of that recognition.

### Card pool

- Legal cards are those "from Black & White onward" (P-Rules), through the most recent expansions (P-Guide). The starting point is the same as Expanded's. **High confidence.**
- Nothing rotates. Update 1.6 says the format does not rotate and power keeps rising as sets are added. **High confidence.**
- Expanded's ban list does not apply. GLC keeps its own list, and cards not on it are allowed "even if banned in Standard or Expanded" (P-FAQ). **High confidence.**
- When a new set becomes legal: P-FAQ says unreleased cards follow the event region's set legality. Organizers are encouraged to allow new expansions immediately rather than after the usual two-week wait. **High confidence**, but this is an organizer recommendation, not a fixed date.
- Reprints and old prints (P-FAQ):
  - GLC follows the official Pokémon **Reprint and Errata Legality List**. Some pre-B&W prints of cards reprinted later are legal and some are not.
  - **Classic Collection** cards are not allowed unless they come from Black & White or later and follow GLC rules. In practice only Reshiram and Zekrom qualify.
  - **Pokémon TCG Classic** cards are generally not legal. The exception is reprints of GLC-legal cards, such as Ultra Ball, Super Rod and VS Seeker.
  - Cards marked as not for tournament use are illegal. Examples are Zacian Lv. X, Dragapult Prime and Imakuni?'s Doduo.
  - World Championship decks and foreign-language cards are allowed at the organizer's discretion, with opaque sleeves.
  - **High confidence.**
- The deck has 60 cards, and games use 6 Prize cards under current Pokémon TCG rules (P-Rules). **High confidence.**

### Singleton rule

- A deck may hold only one copy of each card with the same name, except Basic Energy (P-Rules, P-Guide). Any number of any type of Basic Energy is allowed (P-FAQ). **High confidence.**
- The rule goes by card name, so a reprint or alternate art of the same name still counts as the one copy. Different names are different cards even for the same species: Genesect and Shining Genesect may both be played (P-FAQ). **High confidence.**
- Special Energy has no exemption, so the singleton rule covers it. This is inferred from "except Basic Energy". **High confidence.**
- Two groups of cards with different names are capped at one combined copy (P-FAQ, which calls these official Pokémon TCG rulings):
  - Only one of Boss's Orders or Lysandre.
  - Only one of Professor's Research, Professor Sycamore or Professor Juniper.
  - P-FAQ says "These are the only cards affected by this restriction". Gloria and Brigette, or Hop, Hau, Tierno and Cheren, may be combined. **High confidence.**

### Single-type requirement

- "Your deck can only contain one type (color) of Pokémon" (P-Rules). The rule covers **Pokémon only**. Trainers and Energy are not restricted by type, and Basic Energy of any type is allowed (P-FAQ). **High confidence.**
- A Pokémon's type is the type printed on the card. P-FAQ requires dual-type cards to physically show both types. **High confidence.**
- **Dual-type Pokémon** are allowed if one of their printed types matches the deck's type. Volcarona (STS, Fire/Grass) may go in a Fire or a Grass deck. Gallade (CEC) is Psychic only (P-FAQ). **High confidence.**
- **Colorless** is a deck type of its own. P-Colorless says "Colorless is its own type, with its own identity", in contrast to Standard, where Colorless Pokémon can be splashed into any deck. A Fire deck may therefore not include Colorless Pokémon. **High confidence** on the intent. No page states the exclusion in a separate sentence.
- **Evolution lines across types:** "cards that are one type and evolve into a different type cannot be played in the same deck, like Eevee" (P-FAQ). Each Pokémon card must match the deck type on its own; the evolution line gives no exemption. **High confidence.**
- **Types in use:** P-Guide covers ten types: Grass, Fire, Water, Lightning, Psychic, Fighting, Colorless, Darkness, Metal and Dragon. Fairy is not banned, but the TCG has discontinued it, so the guide leaves it out. Fairy Pokémon from XY and SM remain legal as a Fairy deck. **Medium-high confidence.**
- **Effects that change a Pokémon's type** at runtime, such as Kecleon's Chromashift (P-Colorless), do not affect construction. Only the printed type counts. This is inferred. **Medium confidence.**

### Rule Box and ACE SPEC exclusions

- "Cards with a Rule Box are not allowed" and "ACE SPEC cards are not allowed" (P-Rules, P-Guide). **High confidence.**
- P-FAQ lists what counts: "Pokemon V, EX, GX, BREAK, Radiant Pokémon, ACE SPECs, and Prism Stars". The list includes Prism Star Trainers and Prism Star Energy. P-FAQ also says "Ancient Trait Pokémon do not have a rule box", so Ancient Trait Pokémon are legal. **High confidence.**
- The FAQ list is not complete. The governing test is whether the printed card has a Rule Box. In the B&W-onward pool, the following also print a Rule Box: Pokémon ex (Scarlet & Violet era, including Tera ex and Mega Evolution ex), Mega Pokémon-EX, TAG TEAM GX, VMAX, VSTAR and V-UNION. All are therefore excluded. This follows from the governing rule (no Rule Box) and the printed cards, not from a GLC statement that names them. It agrees with the [Fire type page](https://gymleaderchallenge.com/fire) (2026-10-10), which lists 22 featured Pokémon and none are ex, V, VMAX, VSTAR, GX, EX or Radiant. **High confidence.**
- Pokémon whose names start with "Shining" are not on the Rule Box list (P-FAQ). Neither are Ancient Trait Pokémon. **High confidence.**
- Inferred: a Tera Pokémon without the ex suffix, if one exists, would be judged by whether it prints a Rule Box. P-FAQ does not mention Tera. **Low-medium confidence.**

### Ban list (current as of 2026-10-10, from P-Ban)

| Card | Printing(s) named | Effective |
|---|---|---|
| Lysandre's Trump Card | PHF 99/119, 118/119 | 2021-11-16 (Update 1.0) |
| Oranguru | UPR 114/156 | 2021-11-16 (Update 1.0) |
| Forest of Giant Plants | AOR 74/98 | 2022-01-10 (Update 1.1) |
| Chip-Chip Ice Axe | UNB 165/214 | 2022-06-08 (Update 1.2) |
| Hiker | CES 133/168; Hidden Fates SV85/SV94 | 2022-06-08 (Update 1.2) |
| Kyogre | Shining Fates 021/072 | 2022-11-11 (Update 1.3) |
| Pokémon Research Lab | UNM 205/236 | 2023-11-01 (Update 1.4) |
| Raikou | Vivid Voltage 050/185 | 2024-09-01 (Update 1.5) |
| Marshadow | Shining Legends 45/73; SM85 promo | 2024-09-01 (Update 1.5) |
| Duskull | Cosmic Eclipse 83/236 | 2024-09-01 (Update 1.5) |
| Double Colorless Energy | Shining Legends 69/73 "and all other versions" | 2025-04-24 (Update 1.6) |
| Twin Energy | Rebel Clash 174/192, 209/192 | 2025-04-24 (Update 1.6) |
| Dimension Valley | PHF 93/119 | 2026-04-20 |

- **Some bans name a specific printing, not the card name.** Kyogre (SHF 021), Raikou (VIV 050), Marshadow (SLG 45 / SM85) and Duskull (CEC 83) each name one set and number. Other Pokémon with those names, which have different attacks, are not banned. For Trainers and Energy the list names printings, and for DCE it adds "all other versions". **High confidence** on what the page says. Whether a reprint of a banned Trainer with the same text is also banned is not stated except for DCE. **Medium confidence** that all same-text reprints are covered.
- The ban list has no watch list and lists no unbans. The Dimension Valley post says Ancient Trait Pokémon combined with TM tools are being "closely monitored". **High confidence.**

### Other restrictions

- Organizers may set event rules, such as recommended timers (P-FAQ). These do not affect construction.
- No minimum Pokémon count, no Energy cap and no other deck-wide limits appear in any primary source. **Medium-high confidence**; absence was checked only against the pages listed.

### How changes are announced and how often

- Changes are announced as blog posts on gymleaderchallenge.com (P-News), each with a separate effective date, typically about one to three weeks after the post. Examples: Update 1.6 posted 2025-04-07, effective 2025-04-24. Dimension Valley posted 2026-04-06, effective 2026-04-20. The ban list links each effective date to its post (P-Ban). Bans are discussed with the community, including on the Tricky Gym Discord and in livestreamed discussions (One Year post, Dimension Valley post). **High confidence.**
- There is no fixed schedule (Update 1.6, Dimension Valley post). Since 2021, ban updates have come about once or twice a year: 2021-11, 2022-01, 2022-06, 2022-11, 2023-11, 2024-09, 2025-04 and 2026-04. The stated aim is to keep the list "as small as possible". **High confidence.**
- The card pool grows with each set release, every two to three months (One Year post). The core rules have stayed the same since launch: single type, singleton, no Rule Box, no ACE SPEC, B&W onward. **High confidence.**

## Implications for an advisory validator (facts only)

A GLC check needs these attributes for each Card Printing:

1. **Card name**, for the singleton rule. It must group reprints under one name and treat "Shining X" and "X" as different names. Two fixed groups also count as one card: {Boss's Orders, Lysandre} and {Professor's Research, Professor Sycamore, Professor Juniper}.
2. **Supertype and subtype**: Pokémon, Trainer or Energy, and whether an Energy is Basic. Only Basic Energy is exempt from singleton.
3. **Printed Pokémon type(s)**, as a list, because dual types exist. The deck passes the type rule if one type appears on every Pokémon. Colorless counts as a type.
4. **Rule Box status.** A name suffix is not a reliable test. Mechanics differ (V, VMAX, VSTAR, V-UNION, EX, Mega EX, GX, TAG TEAM, BREAK, Radiant, Prism Star, ex), and "Shining" and Ancient Trait cards have no Rule Box. A subtype or rule-box flag from the source data would be needed.
5. **ACE SPEC status**, for Trainers and, in SV, Energy.
6. **Set and release era**, for the B&W-onward cutoff. Older prints also need the official Reprint and Errata Legality List, and Classic Collection and Pokémon TCG Classic cards need exceptions.
7. **Exact set and number**, because several bans target a single printing, such as Kyogre SHF 021. DCE is banned in all versions.
8. **Matching names to the rules name.** This is a general Pokémon TCG rule, not a GLC statement. **Medium confidence.**
   - Sword & Shield prints add a parenthetical, such as "Professor's Research (Professor Magnolia)" or "Boss's Orders (Ghetsis)". These count as the same name as the card without the parenthetical.
   - Regional forms, such as "Alolan Vulpix" and "Vulpix", are different names.
   - Singleton and the cross-name groups therefore need catalog names normalized to the rules name.
9. **The Expanded flag is not the GLC pool.** GLC's pool starts where Expanded's does, but Expanded's ban list does not apply. If a catalog's Expanded-legal flag already leaves out Expanded-banned cards, it can't stand in for GLC pool membership unchanged.
10. GLC has its own **ban list**, separate from Expanded's, and it changes about once a year with announced effective dates.

## Open uncertainties

- The FAQ list of Rule Box mechanics leaves out ex, VMAX, VSTAR, V-UNION, TAG TEAM and Mega. They are excluded only because the printed card has a Rule Box, not because GLC names them.
- No page says in a separate sentence that Colorless Pokémon can't be splashed. This rests on "Colorless is its own type" and the single-type rule.
- Whether reprints of banned Trainers or Stadiums are banned too is stated only for DCE ("all other versions").
- The Pokémon.com article and the Alternative Play Handbook were not read directly.
- The FAQ has no last-updated date, so it may lag recent sets. For example, it does not mention Tera or Mega Evolution ex.
