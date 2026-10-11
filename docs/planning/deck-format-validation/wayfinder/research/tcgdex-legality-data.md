# Research: TCGdex legality data and catalog coverage (as of 2026-10-10)

**Label:** wayfinder:research
**Ticket:** [#71 Research TCGdex legality data and catalog coverage](https://github.com/ry-cen/tcg-tracker/issues/71)
**Researched:** 2026-10-10

## Question

What can TCGdex tell us about format legality, and how complete is it for our catalog?

1. What do `legal.standard`, `legal.expanded`, `regulationMark`, `suffix`, `trainerType`, `energyType`, `rarity`, `stage`, `types` and `category` mean, and how reliable are they? Which fields identify Rule Box Pokémon, ACE SPEC cards and Basic Energy? Are the `legal.*` flags current with the latest rotation?
2. How often is each needed field missing or ambiguous across the catalog, and what do manually approved Printings lack?

## Short answer

- **`legal.*` is not an independent legality source.** The TCGdex compiler computes it from a hand-maintained filter. Standard is true when the mark is H, I or J, or `energyType` is `"Normal"`. Expanded is true when the series is bw, xy, sm, swsh, sv or me, or `energyType` is `"Normal"`, minus a per-ID exclusion list (T1, T2). It does **not** model the reprint rule, the waiting period for new sets, or the Expanded extras (McDonald's, Trainer Kits). Its Expanded ban list misses 8 of the 49 officially banned printings and wrongly bans 1 card.
- **The G rotation is applied.** Only 1 G-marked card is still flagged Standard-legal, and that is caused by a data error. The filter was last changed on 2026-05-03 (T3). The filter hard-codes `['H','I','J']`, so a future K mark would read as not legal until TCGdex edits the file.
- **The fields are usable but uneven.** `regulationMark` is present on 96.0% of Sword & Shield-onward printings (8,293 of 8,637 in the swsh, sv and me series; 98.2% without the newest 30th Celebration sets). The 70 McDonald's printings from 2021–2024 have no mark at all. `energyType` mislabels 14 Special Energy cards as `"Normal"`. Rule Box status is spread across `suffix`, `stage`, `rarity` and name glyphs, with inconsistencies in the newest Mega Evolution sets. ACE SPEC is only tagged (by `rarity`) on 33 Scarlet & Violet printings. Black & White era ACE SPECs carry no marker at all.
- **Manually approved Printings have no TCGdex metadata at all.** They store set ID, set name, number, name and `basic_energy='unresolved'`. They have no category, mark, legality, type or suffix.

## What was measured

- **No full catalog DB was reachable.** The docker-compose PostgreSQL on 127.0.0.1:5432 was up. The `tcg` database holds 18 Printings (17 from TCGdex, 1 manual) and lacks migrations 021–023 (`catalog_printing_metadata` does not exist). The other local databases are test fixtures with at most 300 Printings. They were inspected read-only.
- **All measurements below are therefore over the TCGdex English dataset itself.** That is what the importer pulls, one source record per Printing.
  - Enumerated `GET /v2/en/cards`: 23,736 IDs.
  - Fetched every full record (`/v2/en/cards/{id}`) at concurrency 6 with backoff, on 2026-10-10 (PDT). Result: 23,736 of 23,736 fetched, 0 failures.
  - Set-to-series membership came from `/v2/en/series/{id}`.
- **Scripts and raw output:** `crawl.py`, `deep.py`, `q.py` and `deep_full.txt` in the session scratchpad (`/private/tmp/claude-501/-Users-raian-dev-tcg-tracker/82fb32c6-4f4c-4a6d-bc7d-3c6fc3a23a16/scratchpad/`).
- The importer stores each source record with quotes stripped in `catalog_printing_metadata.source_record` (A1). That includes `legal` and `updated`. The figures here are what an import on 2026-10-10 would store.

## Sources

| Ref | Source | Kind |
|-----|--------|------|
| T1 | [`meta/legals.ts`](https://github.com/tcgdex/cards-database/blob/master/meta/legals.ts), tcgdex/cards-database master (head 4199850, 2026-10-06) | Primary (TCGdex source) |
| T2 | [`server/compiler/utils/util.ts`](https://github.com/tcgdex/cards-database/blob/master/server/compiler/utils/util.ts) `cardIsLegal` / `setIsLegal` | Primary (TCGdex source) |
| T3 | `legals.ts` history: dd83ece "Updated Legalities and Banned Cards" 2026-05-03; e4eb25b "2025 Rotation" 2025-04-30 | Primary |
| T4 | [`interfaces.d.ts`](https://github.com/tcgdex/cards-database/blob/master/interfaces.d.ts): enumerations for `suffix`, `trainerType`, `energyType` and `rarity` | Primary |
| T5 | [tcgdex.dev card reference](https://tcgdex.dev/reference/card) | Primary (docs) |
| T6 | Live API `https://api.tcgdex.net/v2/en/...`, full crawl 2026-10-10 | Primary (data) |
| P1 | [2026 Standard Format Rotation Announcement](https://www.pokemon.com/us/pokemon-news/2026-pokemon-tcg-standard-format-rotation-announcement), pokemon.com | Primary (rules) |
| P2 | [Pokémon TCG Banned Card List](https://www.pokemon.com/us/play-pokemon/about/pokemon-tcg-banned-card-list), read 2026-10-10 | Primary (rules) |
| R1 | Sibling note [standard-and-expanded-rules.md](standard-and-expanded-rules.md): handbook pool tables, reprint rule, Basic Energy | Research (ticket #69) |
| A1 | App code on `feature/deck-format-validation`: `api/app/catalog.py`, `api/app/missing_cards.py`, `api/app/catalog_reconciliation.py`, `migrations/003`, `007`, `016`, `021`–`023` | Primary (repo) |

The TCG Tournament Handbook PDF and the Bulbapedia pages returned a bot challenge or HTTP 403 to fetch tools. For rules beyond P1 and P2, this note relies on R1.

## Findings

### 1. How TCGdex computes `legal`

From T2 (`cardIsLegal`), with filter values from T1 at commit dd83ece:

```ts
if (series ∈ includes.series || set ∈ includes.sets || card.energyType === "Normal"
    || (card.regulationMark && includes.regulationMark.includes(card.regulationMark)))
  return !(set ∈ excludes.sets || (type==='standard' && card.types?.includes("Fairy"))
           || `${set.id}-${localId}` ∈ excludes.cards)
return false
```

- **Standard.** `includes.regulationMark = ['H','I','J']`. There are no series, set or card excludes. Any card with `energyType: "Normal"` is legal. Any card whose `types` contains Fairy is excluded.
- **Expanded.** `includes.series = ['bw','xy','sm','swsh','sv','me']`, plus `energyType: "Normal"`, minus 42 hard-coded `"{setId}-{localId}"` strings.
- **The crawl confirms the formula exactly.** Every card's `legal.standard` equals the Standard formula, with 0 deviations. Every `legal.expanded` equals the series formula except the 41 IDs the exclude list actually matches.
- **No source record is missing `legal`** (0 of 23,736).
- **`legal` encodes this filter, not a ruling.** Its quality is the quality of the filter. T5 documents neither `legal` nor `regulationMark` beyond showing them in an example.
- **Set-level `legal` is always `standard: false`.** It is computed by series or set only. The me01–me05 sets all report `standard:false`, so the set object is useless for Standard.

### 2. Is `legal.*` current?

- **The G rotation (in-person 2026-04-10, P1) is reflected.**
  - 1 G-marked card is still `standard:true`: sv04-266 Reversal Energy. That is because its `energyType` is wrongly `"Normal"` (see section 4).
  - Standard-true printings by mark: H 1,303, I 1,278, J 469, unmarked 294 (all `energyType:"Normal"`), G 1.
- **The newest set, 30th Celebration (`30th`, released 2026-09-16, 158 cards) and `30th-c` (30 cards), has no `regulationMark` on any card.** All 188 are therefore `standard:false`. Whether the physical cards carry a mark was not verified. me05 Pitch Black (2026-07-17) is fully marked (J 117, I 3) and Standard-true.
- **Future marks.** The filter lists marks explicitly. A K mark would compute as not Standard-legal until T1 is edited. T1's comment says it is updated from the April rotation posts each year.
- **`updated` is not a legality-freshness signal.** 15,042 records show an `updated` date in 2026-08. That looks like a bulk recompile; this is an inference, not something observed. Values range from 2021-04 to 2026-09.

### 3. Where `legal.*` disagrees with the official rules

| Rule (source) | What TCGdex does | Measured effect |
|---|---|---|
| Reprint rule: older printings of a currently legal card are legal (P1; handbook per R1) | Not modeled. Each printing is judged on its own mark or series. | **Standard:** 151 printings are `standard:false` while a printing with the same name and identical effect text (Trainer/Energy), or the same name, HP and attacks (Pokémon), is `true`. Examples: Rare Candy sm1-129, bw5-100, swsh1-180 (D) and sv01-191 (G) are false, while me01-125 (I) is true. P1 uses exactly this card as its example of a legal old printing. Switch has 18 false printings and 2 true (me01-130, me02-123). **Expanded:** 315 printings, mostly McDonald's (136) and Trainer Kit (140) cards plus pre-BW reprints such as Poké Ball dp1-110. These counts are lower bounds: the text match is strict, and 133 Trainer names have more than one effect wording. |
| Expanded pool includes McDonald's Collection 2011–2021 and the BW/XY/SM Trainer Kits (R1, handbook table) | The `mc` and `tk` series are not in `includes.series`. | All 166 McDonald's printings are `expanded:false`. That includes the 121 from 2011–2021 that R1's pool names. The 45 from 2022–2024 would be legal only through a D-or-later mark, and TCGdex records no mark for them. Of 348 BW/XY/SM Trainer Kit printings, 117 are `expanded:true`, and those only because they are Basic Energy. |
| SM Black Star promos legal from SM158 up (R1, medium confidence) | The whole `smp` set is in the `sm` series. | 156 of 157 promos numbered SM1–SM157 are `expanded:true`. The exception is banned SM85. This conflicts with R1's reading of the handbook table. |
| Expanded ban list: 27 entries, 49 printings (P2) | Exclude list keyed by `setId-localId` | 40 correct. **8 banned printings are `expanded:true`:** Sableye bw5-62, Duskull sm12-83, Marshadow sm3.5-45 (the exclude says `sm35-45`, which matches nothing), Hex Maniac xy7-75a, Lt. Surge's Strategy sm115-60, and Flapple swsh4.5sv-SV013, swsh10tg-TG02 and swshp-SWSH022. 1 banned printing (Reset Stamp UNM 206a) has no TCGdex record. **1 card is wrongly banned:** Bellelba & Brycen-Man sm12-186 is `expanded:false` but is not on P2. |
| Standard ban list: none (P2) | No Standard excludes | Consistent |
| New-card waiting period (P1: about two weeks; promos monthly, R1) | Not modeled | A card is Standard-true as soon as it is marked in TCGdex. TCGdex has no notion of a format-legal date. |
| Basic Energy legal in every format regardless of printing (R1, secondary) | `energyType:"Normal"` short-circuits to legal, but the Fairy exclusion runs first in Standard. | 308 of 336 `"Normal"` energies are `standard:true`. All 28 Fairy Energy printings are `standard:false` (`types:["Fairy"]`). Whether Basic Fairy Energy is Standard-legal was not settled from a primary source. 35 Trainer Kit Basic Energies lack `energyType` and are false in both formats. |
| Fairy-type Pokémon | Excluded from Standard | No-op today: 0 Fairy-typed cards carry H, I or J. |

### 4. Field meanings and reliability

The figures cover all 23,736 records unless a narrower set is named. The "BW+" set means the bw, xy, sm, swsh, sv and me series (12,569 Pokémon).

- **`category`** is always present: Pokemon 20,108, Trainer 3,060, Energy 568. Reliable.
- **`regulationMark`** (T4: "added from Sword & Shield"; T5 has no definition):
  - It is missing on every card before Sword & Shield, as expected.
  - **It is also missing on all McDonald's Collection printings, including those from the mark era:** 2021swsh (25), 2022swsh (15), 2023sv (15) and 2024sv (15). R1 lists McDonald's Collection 2023 among the sets that rotated out of Standard in 2026, which implies printed marks. TCGdex records none, so these read as not Standard-legal however they are marked.
  - Sword & Shield series: 3,593 of 3,675 marked. The 82 unmarked are 25 Classic Collection reprints (`cel25cc`) plus Basic Energy and a scattering of Trainer and Pokémon printings, for example swsh12.5-141 Rare Candy, swsh9-186 Ultra Ball and swsh10-139 Dark Patch.
  - Scarlet & Violet series: 3,633 of 3,698. The 65 unmarked are 32 in My First Battle (`mfb`, including its 4 Basic Energy), 32 other Basic Energy (24 of them in `sve`) and 1 promo (svp-500 Terapagos & Friends).
  - Mega Evolution series: 1,067 of 1,264. The 197 unmarked are 188 from `30th`/`30th-c`, 8 `mee` Basic Energy and mep-Museum.
  - **Malformed values:** mep-051 has `"j"` (lowercase), and mfb-33 and mfb-34 have the string `"None"`.
  - **Reprints keep their original mark.** Crown Zenith has D 8, E 24 and F 109. sv08.5 Prismatic Evolutions has 29 G-marked printings. So a mark that reads "not legal" may belong to a card with a legal reprint.
- **`energyType`** (T4: `'Normal' | 'Special'`; T5 says `Basic | Special`, but the data uses `"Normal"`):
  - Of 568 Energy cards: Normal 336, Special 196, missing 36 (35 Trainer Kit Basic Energy, plus Rainbow Energy base5-17, which is Special).
  - **14 Special Energy printings are labeled `"Normal"`:** sv04-266 Reversal Energy, sv10.5b-086 and me02.5-216 Prism Energy, sv10.5w-086 and me02-124 Ignition Energy, me02.5-217 Team Rocket's Energy, me03-086/087/088, me04-084/085/086 and me05-083/084 (the new typed Special Energies). Other printings of the same names are labeled Special, for example sv02-192 Reversal Energy and sv10-182 Team Rocket's Energy. Because `"Normal"` short-circuits the filter, these 14 are legal in both formats regardless of mark.
  - Pre-BW Darkness and Metal Energy are correctly `Special`; they were special energies then.
- **`suffix`** (T4: `EX | GX | V | Legend | Prime | SP | TAG TEAM-GX | ex`). The type comment says `ex` is the Gen 3/9 mechanic and `EX` the Gen 5/6 one. Values: EX 908, ex 907, V 723, GX 455, TAG TEAM-GX 107, SP 32, Prime 27, Legend 20. There is no value for VMAX, VSTAR, Radiant, Prism Star, BREAK or Mega.
  - **ex/EX confusion:** 70 Mega Evolution-era paper "ex" printings carry `suffix:"EX"` (me04 23, me05 23, 30th 24). So do 395 TCG Pocket "ex" cards. Another 21 me02 "ex" printings have no suffix, and 2 non-ex Raichu (sv02-064, sv02-211) carry `suffix:"ex"`.
  - **Missing suffix:** 22 XY "EX" printings (mostly Mega EX promos), 18 GX and 11 TAG TEAM printings.
- **`stage`** (T5: Basic, Stage1, Stage2; observed also VMAX 210, VSTAR 94, MEGA 94, LEVEL-UP 77, BREAK 37, V-UNION 20, RESTORED 13, Baby 9):
  - **Missing on 752 of 12,569 BW+ Pokémon.** Most are Rule Box Pokémon: 716 of the 1,024 BW–SM EX/GX/TAG TEAM/MEGA/BREAK printings have no `stage`. Examples are sm6-73 Zygarde GX and bw6-124 Giratina-EX. The gap is concentrated in `smp` (93), `xyp` (53) and the main SM sets (25–44 each).
  - VSTAR cards carry `suffix:"V"` plus `stage:"VSTAR"`. VMAX cards carry `stage:"VMAX"` and no suffix.
  - 119 Energy cards carry `stage:"Basic"`, a data artifact.
- **`types`:** only 9 BW+ Pokémon lack it (fut2020 ×5, Morpeko V-UNION promos ×4). 103 Pokémon are multi-type.
- **`trainerType`** (T4 lists Supporter, Item, Stadium, Tool, Ace Spec, Technical Machine, and others): Supporter 1,314, Item 904, Tool 351, Stadium 262, missing 220. All 220 missing are pre-BW. **`"Ace Spec"` occurs 0 times**, even though T4 cites bw7-139 as its example; bw7-139 Crystal Wall is `trainerType:"Tool"`.
- **`rarity`** has 44 values. `"None"` appears 591 times, including all 166 McDonald's and 115 Trainer Kit Pokémon. The values that matter here are `ACE SPEC Rare` (33) and `Radiant Rare` (15).

### 5. Identifying Rule Box Pokémon, ACE SPEC and Basic Energy

There is no single TCGdex field for any of these. For BW+ printings, the signals are:

| Kind | Best TCGdex signal | Coverage and ambiguity |
|---|---|---|
| EX (BW/XY) | `suffix:"EX"` (409) | 22 XY printings lack the suffix. Names vary between "Giratina-EX" and "Magearna EX". |
| Mega EX (XY) | `stage:"MEGA"` and/or `suffix:"EX"` | 73 have both, 21 have MEGA only, 1 swsh MEGA. Names start with "M " or "Primal ". |
| BREAK | `stage:"BREAK"` (37) | swshp-SWSH135 Zacian has `stage:"BREAK"`, which looks like a data error. |
| GX / TAG TEAM-GX | `suffix` | 18 GX and 11 TAG TEAM lack the suffix. Most also lack `stage`. |
| Prism Star (◇) | **Name only:** "◇" in the name (27 cards: 16 Pokémon, 9 Trainer, 2 Energy) | No suffix. Rarity is "Rare". |
| V / V-UNION | `suffix:"V"` (723, which includes VSTAR and V-UNION); V-UNION also has `stage:"V-UNION"` | 4 V-UNION promos lack the stage. |
| VMAX | `stage:"VMAX"` (210) | No suffix. |
| VSTAR | `stage:"VSTAR"` (94) plus `suffix:"V"` | 30th-c-027 Arceus VSTAR has neither. |
| Radiant | **Name prefix "Radiant "** (16) | `rarity:"Radiant Rare"` covers 15; swshp-SWSH230 is "Ultra Rare". |
| ex (SV/ME) | `suffix:"ex"` | 70 ME-era printings use "EX". 21 me02 printings have no suffix. Name matching (" ex" token) works. |
| ACE SPEC | `rarity:"ACE SPEC Rare"` (33: sv05, sv06, sv06.5, sv07, sv08 and sv08.5, including 3 Energy) | **BW-era ACE SPECs are unmarked.** Computer Search bw7-137, Dowsing Machine bw8-128, Crystal Wall bw7-139, G Booster bw10-92 and the others have rarity "Rare" and an ordinary `trainerType`. No `effect` text mentions "ACE SPEC" (0 hits). Every sv or me printing of the 33 tagged names carries the tag; no untagged reprint was found. No me-series card has the ACE SPEC rarity; whether ME sets print ACE SPECs was not checked. |
| Basic Energy | `category:"Energy"` and `energyType:"Normal"` | 14 false positives (Special Energy labeled Normal) and 35 false negatives (Trainer Kit energies without `energyType`). Names of the form "{Type} Energy" are a usable cross-check, since pre-BW "Darkness Energy" and "Metal Energy" are Special. |

### 6. Other catalog-wide facts

- **TCG Pocket cards are in the catalog.** The English listing includes the `tcgp` series: 2,480 digital-only cards across sets A1–B2a and P-A. The importer (A1, `TCGdexSource.enumerate`) has no series filter, so these become Printings. All are `legal.standard:false` and `expanded:false`. Their ex cards carry `suffix:"EX"`.
- **Pre-BW series** (base through col, 5,691 records) are `expanded:false` except their Basic Energy. That is correct apart from the unmodeled reprint rule.
- **Per-set mark coverage, Sword & Shield to Mega Evolution:**
  - 100% marked, except the sets named above: cel25cc, mfb, sve, mee, 30th and 30th-c are entirely or mostly unmarked.
  - Sets missing a handful of marks: swsh6–swsh12.5, swshp, svp and mep each have 1–19 unmarked printings, mostly Basic Energy and reprinted Trainers.

### 7. What the app stores (A1)

- **TCGdex Printings.** `normalize` / `source_metadata` in `api/app/catalog.py` write `catalog_printing_metadata` (migration 021):
  - `source_record` is the whole TCGdex record minus quote keys. It includes `legal`, `regulationMark`, `suffix`, `stage`, `types`, `trainerType`, `energyType`, `rarity`, `effect`, `attacks` and `updated`.
  - `export_candidate` = `{name, category, energyType, set{id,name,tcgOnline}, localId, regulationMark}`.
  - `catalog_generation_printing.basic_energy` is derived: `supported` when category is Energy and `energyType` ∈ {Normal, Basic}; `not_basic` when Special or not Energy; `unresolved` otherwise. The 14 mislabeled Special Energies would therefore be `supported`, and the 35 Trainer Kit energies `unresolved`.
  - The stored `legal` is a snapshot from import time. It changes only on the next manual import. Rows are rewritten only when the source record changes (`IS DISTINCT FROM` guard).
- **Manually approved Printings** (`catalog_printing.source='manual'`, created by `missing_cards.py` on owner approval with a `catalog_override` row `approve_printing`) store only:
  - in `catalog_generation_printing`: `set_id`, `set_name`, `collector_number`, `display_name`/`search_name`, `basic_energy='unresolved'`, `image_url NULL`, and a fingerprint of set:number:name;
  - in `catalog_override`: `evidence_url`, `reason` and the reviewer.
- **Nothing writes `catalog_printing_metadata` for manual Printings.** The only INSERT is `store_source_metadata`, which runs per TCGdex source record. So manual Printings have no category, regulation mark, legality, types, stage, suffix, rarity, trainer type, energy type or card text. `metadata_reviews.py` only UPDATEs existing rows.
- **A manual Printing linked to a TCGdex record does not gain that record's metadata.** Owner `confirm_source` on a `source_match` review inserts `catalog_source_reference(source_id → manual printing_id)`, and that suppresses further match reviews. The import loop still keys metadata by the TCGdex record's own Printing.
- **Manually approved Editions** (`approve_edition`) hang off an existing Printing. Format data is per-Printing, so they inherit whatever the Printing has.

## Implications for an advisory Standard/Expanded/GLC validator (facts only)

- **Reading `legal.*` directly** would wrongly report:
  - "not legal" for every old printing of a reprinted card: ≥151 printings in Standard, ≥315 in Expanded;
  - "not legal" for McDonald's and Trainer Kit cards in Expanded;
  - "legal" for 8 banned Expanded printings and 14 mislabeled Special Energies;
  - "not legal" for the newest set's unmarked cards and for any future K mark.
- **The raw inputs** (`regulationMark`, series via set, name, effect/attack text) are present for nearly all BW+ printings. The gaps that would force an "unknown" result are:
  - unmarked Sword & Shield-onward printings: 344 in the swsh, sv and me series, most of them Basic Energy or 30th Celebration, plus 70 McDonald's printings from 2021–2024;
  - malformed marks (3);
  - Energy with a wrong or missing `energyType`: 14 Special labeled Normal, 35 Basic Energy with no type, and 1 Special with no type;
  - BW ACE SPECs, which no field identifies;
  - Prism Star and Radiant, which only the name identifies;
  - ME-era ex cards whose suffix is wrong or missing (91);
  - and all manual Printings.
- **Any ban list or set-pool data** would have to come from outside TCGdex's exclude list to match P2. TCGdex's own list is wrong in 9 places.

## Open uncertainties

1. Whether 30th Celebration (`30th`, `30th-c`) physical cards carry regulation marks. TCGdex has none, and the set was released 25 days before this note.
2. Whether Basic Fairy Energy is Standard-legal. TCGdex says no. R1 says Basic Energy is always legal (secondary source).
3. Whether SM promos SM1–SM157 are Expanded-legal. TCGdex says yes. R1's reading of an older handbook revision says the pool starts at SM158 (medium confidence).
4. Whether Mega Evolution-era sets contain ACE SPEC cards. None is tagged.
5. The reprint-match counts use strict text equality. True reprint coverage is likely higher, and how to define "same card" for Pokémon is open in R1.
6. Whether McDonald's Collection 2024 (and 2021–2022) printings carry marks, and so whether they are Standard- or Expanded-legal. TCGdex has no marks for them.
7. The local `tcg` database was not migrated past 020, so these counts come from a fresh TCGdex pull. The owner's production catalog may come from an older import, with older `legal` snapshots.
