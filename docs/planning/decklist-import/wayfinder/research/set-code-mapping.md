# Research — How decklist set codes map to Card Printings

**For:** [Research how set codes map to the catalog](https://github.com/ry-cen/prizecheck/issues/200), which blocks [#203](https://github.com/ry-cen/prizecheck/issues/203). It overlaps [Show printed set codes on Collection's tiles and inspector](https://github.com/ry-cen/prizecheck/issues/192).

**Gathered:** 2026-10-14, on `dev` at `2435ed8`.

**Sources:**
- the repository: `api/app/set_codes.tsv` and `set_codes.py`, `api/app/catalog_browse.py`, `api/app/catalog.py`, `api/app/catalog_targets.py`, `api/app/missing_cards.py`, `migrations/003_catalog.sql` and `044_catalog_set_release.sql`, and earlier research in `docs/planning/tcg-collection-tracker/wayfinder/research/deck-export-formats.md` and `export-metadata-provenance.md`;
- the TCGdex API: `GET https://api.tcgdex.net/v2/en/sets/<id>` for all 201 catalog sets, read 2026-10-14, and the [Set](https://tcgdex.dev/reference/set) and [Card](https://tcgdex.dev/reference/card) reference pages;
- Limitless: the [card database set list](https://limitlesstcg.com/cards), every set's list view (`https://limitlesstcg.com/cards/<CODE>?display=list`, 154 sets, 20,639 rows), the deck-page clipboard formatter [`decklist-11f9e903.js`](https://limitlesstcg.com/build/assets/decklist-11f9e903.js) loaded by [a deck page](https://limitlesstcg.com/decks/list/17168), and the [Decklist Submission docs](https://docs.limitlesstcg.com/player/decklists.html#ptcgl-alt-cards), all read 2026-10-14;
- the local catalog: read-only queries against `prizecheck_devcopy3`, a copy of the dev database whose active generation was imported 2026-10-13 (21,256 Printings, 201 sets, all from TCGdex). The `tcg` dev database holds only 1 active Printing, so it was not measured. No `.env` file was read and nothing was written.

No Pokémon TCG Live client was run. Everything said about Live's paste format comes from Limitless's formatter and docs, and is marked as such.

## Summary

- **The catalog stores no set code.** A Printing has a TCGdex `set_id` (`sv02`), a `set_name` and TCGdex's `localId` as `collector_number` (`185`, `001`, `TG05`, `SWSH001`). The printed code ("PAL") lives only in the checked-in display table `api/app/set_codes.tsv`. That table has 136 of the 201 catalog sets. The Live export table `LiveRulesV1.SET_CODES` ships empty on purpose.
- **Catalog search already accepts "PAL 185"**, and it resolves 18,615 of the 20,639 code-and-number pairs in Limitless's card database to exactly one Printing. No pair matched more than one.
- **Pasted lists are not shaped like the database.** Limitless's clipboard formatter rewrites 1,006 rows before they reach the clipboard, presumably to match what Live accepts:
  - `SP` becomes `PR-SW` and `SVP` becomes `PR-SV`;
  - Trainer Gallery, Galarian Gallery and Radiant Collection numbers become `BRS-TG 5`;
  - Shining Vault numbers are offset, so `SHF SV1` becomes `SHF 74`;
  - Sun & Moon and Sword & Shield basic Energy becomes `Energy 18`.

  Today's search resolves none of these forms. In Standard it misses every SVP promo pasted as `PR-SV` (105 Printings).
- **A small alias layer closes almost all of it.** On top of `set_codes.tsv`, add promo codes and number prefixes, `-TG`/`-GG`/`-RC`, the Shining Vault offsets and Celebrations' Classic Collection. Pasted rows then resolve to one Printing 19,608 times, with no row resolving to several. That reaches 3,031 of the 3,037 Standard Printings that aren't basic Energy, and 14,675 of the 15,138 Expanded ones.
- **What still fails:** letter-suffix prints that TCGdex has no Printing for (`TEU 152a`), cards newer than the last TCGdex import (`MEP 89`–`101`), Live's game-only ALT IDs (`SWSHALT 127`), the `Energy N` pseudo-set, and sets with no agreed code (e-Card, Base Set 2, POP, trainer kits, McDonald's). Manual Printings have a set ID the reviewer typed, which no code table keys.
- **TCGdex has an abbreviation field, but it is undocumented.** `abbreviation.official` appears in API responses for 190 of 201 sets. It doesn't fit the job: it has no code for SWSH promos, disagrees with Limitless on six sets, and gives two different sets the same code. The finding favours a checked-in table, with the TCGdex field as a cross-check. See [Mapping source](#mapping-source-finding-not-decision).

## 1. What the catalog stores

| Field | Where | Holds |
| --- | --- | --- |
| `catalog_generation_printing.set_id` | `migrations/003_catalog.sql` | TCGdex set ID, from the card record's `set.id` (`api/app/catalog.py` `normalize`) |
| `.set_name` | same | TCGdex set name |
| `.collector_number` | same | `str(localId)`, unchanged: TCGdex's zero padding and prefixes are kept |
| `catalog_printing.source` / `source_id` | same | `tcgdex` with the TCGdex card ID (`sv02-185`), or `manual` with no source ID |
| `catalog_generation_set.release_date` | `migrations/044_catalog_set_release.sql` | the set's release date only |
| `catalog_generation.raw_gzip` | `migrations/003_catalog.sql` | the full card records. A card record's `set` holds only `id`, `name`, `logo`, `symbol` and `cardCount`, not the set's abbreviation |

No migration adds a set code or abbreviation column. Searching `api/app` and `migrations/` for `abbreviation` finds nothing. `tcgOnline` appears only in `catalog.py`'s `EXPORT_SET_KEYS` and `MUTABLE_SOURCE_KEYS`, kept as unclassified source metadata.

The printed code is display data:
- `api/app/set_codes.tsv` maps TCGdex set ID to printed code, with sources per row. Its header records the rule: two independent sources (Limitless and JustInBasil), or a card scan plus one source. It rules out TCGdex's `abbreviation` and `tcgOnline` as sources.
- Subsets numbered with their own prefix inherit the main set's code: `swsh9tg` is `BRS`, `swsh12.5gg` is `CRZ`, `swsh4.5sv` is `SHF` and `sma` is `HIF`.
- 65 sets are left out on purpose. `sve`, `mee`, `swshp`, `smp`, `xyp` and `bwp` are among them, because only one source gave a code or the sources disagreed.
- `api/app/set_codes.py` exposes `code_for(set_id)` and `sets_for_code(word)`.

`catalog_browse._search` is the only code that reads a code and number today. A first word that is a printed code (or else a TCGdex set ID), then one more word, is looked up as set plus collector number. `NUMBER_KEY` drops zeros after a number's letters, so `1` finds `001` and `TG5` finds `TG05`.

`catalog_targets.LiveRulesV1.SET_CODES` is `{}`. Its docstring says no Live code is evidenced in the repository, and codes are never guessed from `tcgOnline`.

## 2. Codes: Limitless, Live and TCGdex

The table below covers the sets the ticket names. "Limitless" is the code on Limitless's set list. "Pasted" is what Limitless's formatter writes to the clipboard.

| TCGdex set | `set_codes.tsv` | Limitless | Pasted | TCGdex `abbreviation.official` | TCGdex `tcgOnline` |
| --- | --- | --- | --- | --- | --- |
| `sv01` Scarlet & Violet | SVI | SVI | SVI | SVI | — |
| `sv02` Paldea Evolved | PAL | PAL | PAL | PAL | — |
| `sv03` Obsidian Flames | OBF | OBF | OBF | OBF | — |
| `sv03.5` 151 | MEW | MEW | MEW | MEW | — |
| `sve` SV Energy | — | SVE | SVE | SVE | — |
| `svp` SVP Promos | SVP | SVP | **PR-SV** | SVP | — |
| `swsh9` / `swsh9tg` | BRS / BRS | BRS (TG numbers in the same list) | BRS / **BRS-TG** | BRS / BRS:TG | BRS / BRS |
| `swsh11` / `swsh11tg` | LOR / LOR | LOR | LOR / **LOR-TG** | LOR / LOR:TG | LOR / LOR |
| `swsh12.5gg` | CRZ | CRZ | **CRZ-GG** | CRZ:GG | CRZ |
| `swshp` SWSH Promos | — | SP | **PR-SW** | *(none)* | — |
| `smp` SM Promos | — | SMP | SMP | SMP | PR-SM |
| `xyp` XY Promos | — | XYP | XYP | XYP | PR-XY |
| `bwp` BW Promos | — | BWP | BWP | BWP | PR-BLW |
| `xy8` BREAKthrough | BKT | BKT | BKT | BKT | BKT |
| `bw9` Plasma Freeze | PLF | PLF | PLF | PLF | PLF |

Codes from the Limitless set list and from TCGdex's live set records, 2026-10-14. The formatter rules are quoted below.

**Limitless's formatter** (the `G` function of `decklist-11f9e903.js`, re-read 2026-10-14 with the same hash the 2026-10-08 research inspected) does five things:
- maps `SP` to `PR-SW` and `SVP` to `PR-SV`;
- writes basic Energy from `SUM`, `TEU`, `SSH` and `BRS` as `Energy <n>`, with a lookup table: `SUM` Grass is 18 and `BRS` Metal is 52;
- writes a number matching `(RC|TG|GG)[0-9]{1,2}` as `<code>-<prefix> <rest>`, e.g. `BRS TG5` as `BRS-TG 5`;
- writes `HIF` and `SHF` numbers starting `SV` as the number plus 69 or 73, so `SHF SV1` becomes `SHF 74`;
- writes everything else as `<code> <number>`.

That is Limitless's convention. Pokémon documents no grammar, and these forms weren't tested in Live. Limitless's docs add that Live itself exports some promo variants with game-only IDs, e.g. `SWSHALT 127` for a card printed `BRS 132` ([PTCGL ALT Cards](https://docs.limitlesstcg.com/player/decklists.html#ptcgl-alt-cards)).

**TCGdex's `abbreviation`** is in the API's set responses (`{"official": "PAL"}`, and `"BRS:TG"` for subsets), but the [Set reference](https://tcgdex.dev/reference/set) doesn't list it. The reference documents `tcgOnline` as the "Pokémon TCG Online Set code" and nothing else code-like. Across the 201 catalog sets:
- `abbreviation.official` is set on 190 and `tcgOnline` on 118. `set_codes.tsv` covers 136.
- **It disagrees with Limitless and `set_codes.tsv`** on `bw2` (EP, not EPO), `col1` (COL, not CL), `hgss3` (UND, not UD), `hgss4` (TRI, not TM), `ex7` (TR, not TRR) and `base5` (RO, not TR).
- **It collides.** Its `TR` (`ex7`) is the table's code for Team Rocket (`base5`). Its `30C` belongs to both `30th` and `30th-c`, which TCGdex numbers alike (`001`–`030`), so `30C 1` matches two Printings. Its `CEL` belongs to both `cel25` and `cel25cc`.
- **It has gaps:** `swshp` has none, and none of the Limitless codes `SP`, `E1`–`E3`, `BS2`, `CL`, `TM`, `UD`, `EPO`, `TRR`, `DPP`, `HSP`, `WP` or `NP` appears in it. Resolving Limitless's database pairs by this field leaves 1,643 rows with an unknown code and 830 with no Printing, against 0 rows that match several.
- **`tcgOnline` is empty for every Scarlet & Violet and Mega Evolution set.** Where it exists it gives Online's promo codes (`PR-SM`, `PR-XY`, `PR-BLW`), which Limitless's formatter doesn't emit.

## 3. Collector-number shapes

Across the 21,256 catalog Printings, TCGdex `localId` shapes are:
- `999` (9,340) and `99` (8,972);
- `9` (1,336);
- `AA99`, e.g. `RC10` and `TG05` (672);
- `AA999`, e.g. `BW100` and `SV001` (410);
- `AAAA999`, i.e. `SWSH001` (307);
- `A99`, e.g. `H01` in Aquapolis (64);
- a letter suffix, e.g. `50a` or `XY150a` (37);
- a few one-offs: `ONE` and `THREE` in HGSS, `!`, `%3F` and `A` for Unown in `exu`, and `Museum` in `mep`.

How they differ from what a paste carries:

| Case | TCGdex `localId` | Limitless and paste | Handled today? |
| --- | --- | --- | --- |
| Leading zeros: all SV and ME sets, `sve`, `svp`, `mep` and `swsh9`–`swsh12.5` (35 sets) | `001`, `098` | `1`, `98` | Yes, by `NUMBER_KEY` |
| Trainer Gallery, Galarian Gallery | `TG05`, `GG05` | `TG5` in the database, pasted as `BRS-TG 5` | `TG5` yes; `BRS-TG 5` no |
| Radiant Collection (`g1`, `bw11`) | `RC5` | pasted as `GEN-RC 5` | No |
| Shining Vault (`swsh4.5sv`, `sma`) | `SV001`, `SV1` | `SV1` in the database, pasted as `SHF 74` / `HIF 70` | `SV1` yes; offset no. The main sets end at 73 and 69, so the offsets don't collide |
| SWSH promos | `SWSH001` | `SP 1`, pasted as `PR-SW 1` | No: the code is unknown and the prefix is missing |
| SM, XY, BW, HGSS and DP promos | `SM01`, `XY01`, `BW01`, `HGSS01`, `DP01` | `SMP 1`, `XYP 1`, `BWP 1`, `HSP 1`, `DPP 1` | No: the prefix is missing |
| SVP, MEP | `001`, `087` | `1`, `87`; SVP pasted as `PR-SV 1` | `SVP 1` yes; `PR-SV 1` no |
| Celebrations Classic Collection (`cel25cc`) | `CC001` | `CEL CC1` | No: `cel25cc` has no code. `NUMBER_KEY` would match `CC1` |
| 30th Celebration subset (`30th-c`) | `001`–`030` | `30C CC1`–`CC30` | No: the subset numbers lack `CC` |
| Basic Energy, SUM/TEU/SSH/BRS | `sm1` has `164`–`172`. The others have no energy Printings | `SUM G` in the database, pasted as `Energy 18` | No |
| Limitless-only letter suffixes | — (TCGdex has no such Printing) | `TEU 152a`, `BUS 18a`, `UNB 182b` | No. Dropping the suffix reaches the base Printing, which isn't the card printed |

The Limitless letter-suffix rows are prints Limitless lists and prices on their own. For example, Team Up lists #152 at $0.16, #152a at $31.49 and #152b at $0.43 ([TEU 152a](https://limitlesstcg.com/cards/TEU/152a)). There are 56 such rows across Sun & Moon sets. Falling back to the base number would pick a related Printing, not the card on the list, so that fallback is lossy.

## 4. Coverage against the local catalog

**Method.**
- Every row of Limitless's English card database (20,639 code-and-number pairs over 154 sets) was resolved against the catalog's active generation in `prizecheck_devcopy3`.
- Each row was resolved twice: as listed in the database, and after a Python port of the formatter's `G`, which gives the pasted form.
- Each run used either today's rule (`catalog_browse`: `set_codes.tsv`, or else a TCGdex set ID, then `NUMBER_KEY`) or that rule plus the alias rules in section 5.
- The Standard and Expanded pools approximate `api/app/format_rules/standard.toml` and `expanded.toml` on 2026-10-14:
  - Standard is a set with a passed legal-from date plus regulation mark H, I or J;
  - Expanded is a set with a passed legal-from date;
  - basic Energy is always in.
  
  Bans and other rules are ignored, because `catalog_format_standing` doesn't exist in that copy.

| Run | One Printing | No Printing | Several | `Energy N` |
| --- | --- | --- | --- | --- |
| Database pairs, today's search | 18,615 | 2,024 | 0 | — |
| Pasted forms, today's search | 17,935 | 2,670 | 0 | 34 |
| Pasted forms, with the alias rules | 19,608 | 997 | 0 | 34 |

By format, counting Printings that are not basic Energy and that some pasted row reaches:

| Pool | Printings | Today's search | With alias rules | Not reached, by set |
| --- | --- | --- | --- | --- |
| Standard | 3,037 (plus 336 basic Energy) | 2,932 | 3,031 | `svp` 6 (`085`, `190`–`192`, `213`–`215`, `225`, `500`: not in Limitless's database, so unmeasured rather than failing) |
| Expanded | 15,138 (plus 336 basic Energy) | 13,138 | 14,675 | 463: `mfb` 30; the trainer kits `tk-*` (about 18–30 each); the McDonald's sets `2011bw`–`2024sv` (12–25 each). Limitless lists none of these, so no pasted code names them |

Today's search misses these in Expanded: `swshp` 307, `smp` 248, `svp` 226, `xyp` 216, `swsh4.5sv` 122, `bwp` 101, `sma` 94, `swsh12.5gg` 70 and `g1` 32. In Standard it misses only `svp`, 105 Printings.

Rows that still fail with the alias rules, by cause:
- **No agreed code:** `E1`–`E3` (529), `BS2` (130), `WP` (53), `P1`–`P9` (153), `RM` (16) and `BG` (9). All are older than Expanded.
- **Missing from the catalog:**
  - `MEP 89`–`101` (12): Limitless has Mega Evolution promos that the 2026-10-13 TCGdex import doesn't.
  - `MEE 9`–`16` (8): Limitless lists 16 Mega Evolution Energy, TCGdex 8.
  - `UF` Unown letters (28): TCGdex keeps them in `exu`, which has no code.
  - `30C` Mew variants `G`/`R`/`B`.
- **Letter-suffix prints:** 56 rows, as above.
- **`Energy N`:** 34 rows. Basic Energy can be found by name, but the number doesn't name a Printing without a further table.

**By name alone.** Name finds a Card Identity, but an import has to land on a Printing, and then an Edition. Within the Standard pool, a non-basic-Energy name names exactly one Reprint Group (from `catalog_reprint_group_effective`) for 1,760 of 3,037 Printings:
- every Trainer (445) and every Special Energy (8);
- 1,307 of 2,584 Pokémon.

In Expanded the figure is 4,457 of 15,138: 1,824 of 2,173 Trainers and 2,535 of 12,855 Pokémon. A name-only fallback is safe for Trainers and Energy, and often ambiguous for Pokémon. That matches Limitless's own advice for ALT rows.

**Name checks after a code-and-number match.** 112 rows matched one Printing whose name differed from Limitless's. Every difference was a naming convention, not a wrong card:
- `◇` vs "Prism Star", and `☆` vs "Star";
- TCGdex dropping "LV.X" (`dp1 120` is "Empoleon");
- parenthetical subtitles, e.g. "Boss's Orders (Giovanni)";
- "Basic Grass Energy" vs "Grass Energy";
- "Impostor" vs "Imposter".

A name cross-check must allow for these, or it will flag correct lines.

## 5. Ambiguities and failure cases

- **One code and number, several Printings.** None, under `set_codes.tsv`:
  - in the catalog, no printed code plus `NUMBER_KEY` value is shared by two Printings;
  - in Limitless's database, no row matched several;
  - subsets inherit their main set's code only because their numbers carry a prefix the main set doesn't use.
  
  The collisions all come from the alternatives:
  - TCGdex's abbreviation: `TR` and `30C`;
  - giving `30th-c` the code `30C` without restoring the `CC` prefix, which collides on 30 numbers;
  - the `G1`/`g1` overlap, which the code table already settles (a printed code wins over a TCGdex set ID, so `G1` is Gym Heroes).
- **One pasted line, several Editions.** A code and number names a Printing, not an Edition. Choosing the Edition (cheapest, or owned first) is the import decision's job, not this mapping's.
- **Sets missing from the code table.** 65 catalog sets have no code. Those that matter for Expanded decklists are the promos `swshp`, `smp`, `xyp` and `bwp`, the Energy sets `sve` and `mee`, and `cel25cc`. The rest are pre-BW sets, POP, trainer kits and McDonald's sets, which a pasted Standard or Expanded list rarely names.
- **Cards missing from the catalog.** New promos and Energy reach Limitless before TCGdex (`MEP 89`–`101`, `MEE 9`–`16`). Letter-suffix prints never reach TCGdex as Printings.
- **Manual Printings.** `api/app/missing_cards.py` creates a manual Printing with whatever `set_id`, `set_name` and `collector_number` the reviewer enters. The only one in the `tcg` database has `set_id` `jungle`, not TCGdex's `base2`. `code_for` returns an unknown set ID unchanged, so a code table keyed by TCGdex set ID can't reach a manual Printing unless reviewers enter TCGdex set IDs. The catalog import does flag a later TCGdex record whose set and number match a manual Printing for review (`catalog.py`, the `source_match` review).
- **Live ALT IDs** (`SWSHALT 127`) name no printed card. No rule maps them. Limitless's own parser rejects them.
- **Open, not verified:**
  - whether Live pastes SWSH promos as `PR-SW 123` or `PR-SW SWSH123`;
  - what code Live uses for `MEP`, `SMP`, `XYP` and `BWP`: the formatter leaves the Limitless codes alone, while TCGdex `tcgOnline` gives Online's `PR-SM`, `PR-XY` and `PR-BLW`;
  - whether Live itself uses the `-TG`, `Energy N` and offset forms.
  
  A pasted Live export would settle these.

## Mapping source (finding, not decision)

The evidence favours a **checked-in import-alias table layered on `set_codes.tsv`**, keyed by the pasted code, with TCGdex's `abbreviation.official` used only as a cross-check in a test:
- **`set_codes.tsv` already has the right shape and evidence.** It keys by TCGdex set ID, gives no false matches across 20,639 rows, and covers every Standard set that a pasted list names, except the Energy sets `sve` and `mee` (of the other Standard sets without a code, `mfb` contributes only basic Energy to the Standard pool, and `30th-c`, `2023sv` and `2024sv` contribute no Printings). Its sources rule excludes TCGdex's fields, and the repository's earlier export research reached the same conclusion about `tcgOnline`.
- **The rewrites are few and rule-shaped.** The pasted forms need only these additions, which together lift Standard coverage from 2,932 to 3,031 of 3,037:
  - aliases: `PR-SV` to `svp`, `PR-SW` and `SP` to `swshp`, and `SMP`/`XYP`/`BWP`/`HSP`/`DPP`/`SVE`/`MEE` to their sets;
  - a number prefix per promo set: `SWSH`, `SM`, `XY`, `BW`, `HGSS`, `DP`;
  - the `<code>-TG|GG|RC <n>` split;
  - the `HIF` and `SHF` offsets (69, 73);
  - `CEL CC<n>` to `cel25cc`, and `30C CC<n>` to `30th-c` with the prefix dropped.
- **TCGdex's field fits less well.** It is undocumented, has no code for SWSH promos, disagrees on six sets and collides on `TR` and `30C`. It is still useful to cross-check new sets when an import brings them in.
- **What a table can't fix:** ALT IDs, letter-suffix prints, cards TCGdex lacks and manual Printings. Those need a review step: name search, or the Missing cards report.

Whether the alias rows join `set_codes.tsv`, form a second table, or wait for Live-export evidence like `LiveRulesV1` is for the import decision ([#203](https://github.com/ry-cen/prizecheck/issues/203)). The open Live-format questions above would decide how much of the table needs that evidence.
