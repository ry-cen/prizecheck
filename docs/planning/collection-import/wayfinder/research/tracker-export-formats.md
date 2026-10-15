# Research — Collection export formats from other trackers

**For:** [Research collection export formats from other trackers](https://github.com/ry-cen/prizecheck/issues/219). It blocks [#220](https://github.com/ry-cen/prizecheck/issues/220) (what the import accepts), [#221](https://github.com/ry-cen/prizecheck/issues/221) (how rows match) and [#222](https://github.com/ry-cen/prizecheck/issues/222).

**Builds on, and does not redo**, the decklist-import research on `feature/decklist-import`:
- [decklist-text-formats.md](../../../decklist-import/wayfinder/research/decklist-text-formats.md);
- [set-code-mapping.md](../../../decklist-import/wayfinder/research/set-code-mapping.md);
- the [import contract](../../../decklist-import/wayfinder/resolutions/decide-import-contract.md).

**Gathered:** 2026-10-15.

**Sources.** No tracker publishes a formal spec of its export, so each claim rests on one of these:
- **Official help pages**, read 2026-10-15:
  - [Collectr's Import/Export page](https://getcollectr.notion.site/Import-Export-Your-Collection-9aa6e5f4d0cd4efb995dadc992760c8e), read through Notion's page API, including its two screenshots;
  - TCGplayer's Zendesk articles, read through the Zendesk API because the HTML returns 403: [migrating from the previous app](https://help.tcgplayer.com/hc/en-us/articles/33797162920599), [App FAQ](https://help.tcgplayer.com/hc/en-us/articles/115009506407) and [BinderPOS import](https://seller.tcgplayer.com/articles/import-inventory-to-binderpos-using-the-tcgplayer-mobile-app/);
  - Dex's [import article](https://dextcg.com/help/troubleshooting/importing-your-collection-into-dex);
  - PriceCharting's [text importer](https://www.pricecharting.com/collection-text-importer), with [FAQ](https://www.pricecharting.com/faq) and [staff forum reply](https://pricecharting.userecho.com/communities/1/topics/1292-is-there-a-way-to-export-your-collection-to-a-csv-or-excel-file);
  - Sorted's [FAQ](https://tcgsorted.com/faq);
  - TCG Collector's [Premium page](https://www.tcgcollector.com/premium/usd);
  - Pokellector's [App Store listing](https://apps.apple.com/us/app/pokellector-card-collector/id600580227).
- **Real exports** that people committed to public GitHub repositories. Each is pinned to a commit in [Sources for the fixtures](#sources-for-the-fixtures). They were profiled with Python's `csv` module, and none was edited.
- **A measurement against TCGdex.** The real rows were resolved against the live TCGdex API (`/v2/en/sets/<id>` and `/v2/en/cards/<id>`), **not** against the repository's catalog. The script retried 29 responses that had failed with 503. TCGdex is where the catalog comes from, so this measures what is reachable, not what the 2026-10-13 catalog generation holds.

Claims that no source confirmed are marked **unconfirmed**.

## Summary

| Tracker | Export? | How | Shape | Names a card by | Quantity |
| --- | --- | --- | --- | --- | --- |
| **Collectr** | Yes, **Pro only** | Portfolio → ⋯ → Export; a CSV is **emailed**, holding every portfolio | CSV, 14 columns (2025) or 16 columns (2026) | set **name**, card number, product name. **No set code, no product ID, no language column** | `Quantity` |
| **TCGplayer app** | Yes, free | A collection list → ⋯ → Send via Email, as CSV or plain text (set in the app's Email Export setting) | CSV, 12 columns (older) or 14 columns (newer, adds prices) | **Product ID**, set name, card number, TCGplayer set code, name | `Quantity` |
| **TCGplayer app, previous version** | Yes | Account → Previous App Data → Download My Old Data → `legacy_data.csv` | CSV. Fields per the help page: Collection Name, Created At, Product ID, Condition, Language, Variant, Quantity. **Header spelling unconfirmed** | Product ID only | Quantity |
| **PriceCharting** | Yes, free once a week | Settings → Export Collection; a **zipped CSV is emailed** | CSV, 15 columns, every category mixed | **PriceCharting ID**, `Pokemon <Set>`, and `Name [Variant] #Number` packed into one field | `quantity`, but **one row per copy** in practice |
| **Dex** | Yes, **iOS only, Dex+ only** | Settings → Data → Export Collection | CSV. **Columns unconfirmed**: no public sample or doc found | unconfirmed | unconfirmed |
| **Pokellector** | **No export found** | The app shares PTCGO QR codes. One unofficial blog claims a CSV export, which no Pokellector page backs | — | — | — |
| **Dragon Shield Poké TCG Scanner** | Yes, but the app is being **replaced by Sorted** | Export from a folder | CSV with a `"sep=,"` first line, 15 columns | Dragon Shield set code, set name, card number, name | `Quantity` plus `Trade Quantity` |
| **Sorted** (Dragon Shield's successor) | Yes | In-app export. Dragon Shield collections migrate automatically on login | CSV, 21 columns. A `"sep=,"` line appears in a Magic export and not in the one Pokémon export found | set code, set name, card number, name | `Quantity` |
| **TCG Collector** | Yes, **Premium only** | Website export | CSV, 11 columns, CRLF | set (Expansion) **name**, card number, name | `Quantity`, with repeated identical rows |

**For the matcher, five things stand out:**
- **The common key is set name plus collector number,** not a printed set code.
  - Only Dragon Shield and Sorted carry codes close to the printed ones, and theirs are their own (`SV1`, `S4A`).
  - TCGplayer's `Set Code` is TCGplayer's own and **isn't unique**: `RR` is both Rising Rivals and Team Rocket Returns.
  - Collectr and TCG Collector carry no code at all.
- **TCGplayer's Product ID is the strongest single key for TCGplayer files.** It names the Printing, and the `Printing` column picks the Edition.
- **Finish words differ by tracker,** and stamps or patterns often sit in the card name, not in a finish column.
- **Exports contain things that aren't owned cards:**
  - watchlist rows;
  - sealed product;
  - other games;
  - Japanese and Chinese cards;
  - graded slabs.
- **Rows aren't one per Edition.** PriceCharting writes one row per copy, and TCG Collector repeats identical rows. The import has to add matching rows together.

## Collectr

**Export** ([Collectr help](https://getcollectr.notion.site/Import-Export-Your-Collection-9aa6e5f4d0cd4efb995dadc992760c8e)):
- The help page says "PRO members can export their collection at any time": Portfolio screen → three dots → Export, then enter an email address.
- The confirm screen, a screenshot on that page, says the export "packs up and sends you all of your products and portfolio's in one CSV".
- **Collectr's own import** accepts only TCGplayer CSVs, emailed to `import@getcollectr.com`. It takes 2–3 business days.

**Columns.** Read from real exports (fixtures C1 and C2):

```
14 columns (exports dated 2025-05):
Portfolio Name,Category,Set,Product Name,Card Number,Rarity,Variance,Grade,Card Condition,Average Cost Paid,Quantity,Market Price (As of 2025-05-08),Watchlist,Date Added

16 columns (exports dated 2026-03 to 2026-08):
Portfolio Name,Category,Set,Product Name,Card Number,Rarity,Variance,Grade,Card Condition,Average Cost Paid,Quantity,Market Price (As of 2026-08-26),Price Override,Watchlist,Date Added,Notes
```

- **The market-price header carries the export date,** so match headers by name prefix, never by the whole string.
- **Encoding:** UTF-8 without a BOM, LF line endings and minimal quoting. Fields are quoted only when they contain a comma, for example `"1,055.48"`.

**How a row names a card:**
- **`Set`** is a set name, apparently in TCGplayer's catalog naming without TCGplayer's `SV01:` prefixes. Examples: `Paldea Evolved`, `Brilliant Stars Trainer Gallery`, `Shining Fates: Shiny Vault`, `Base Set (Unlimited)`, `Scarlet & Violet Promo`, `Miscellaneous Cards & Products`.
- **`Card Number`** comes in several shapes:
  - with a denominator: `151/142`, `TG05/TG30`, `SV032/SV122`;
  - bare: `150`, `RC29`;
  - promo shapes: `SWSH087`, `SM190`, `037/DP-P`;
  - **blank** for sealed product and unnumbered Energy.
- **`Product Name`:**
  - often has a **trailing space** (`Adaman `);
  - carries tags such as `(Secret)`, `(Full Art)`, `(JP)`, `(CN)`, `(Cosmos Holo)`, `(Poke Ball Pattern)`, `(Master Ball Pattern)`, `(Mega Evolution Stamped)` and `(Holiday Calendar)`;
  - sometimes embeds a number: `Raichu GX - 20/68 (#60 Pikachu Stamped)`, `Eevee VMAX - SWSH087`.
- **Language has no column.** Japanese cards are marked by a `(JP)` name suffix or a Japanese set name (`Crimson Haze`, `Expedition (Japanese)`, `Scarlet & Violet Promo JP`). Chinese cards are marked `(CN)`.
- **`Category`** is the game: `Pokemon` or `One Piece` in these files. The other games Collectr tracks presumably appear the same way.

**Rows that aren't owned cards:**
- **`Watchlist=true`** rows have a blank `Portfolio Name` and a blank `Quantity`. They are watched cards, not copies.
- **Sealed product** (`Scarlet & Violet Booster Box`, `Ascended Heroes Elite Trainer Box`) has a blank `Card Number` and often a blank `Rarity`.
- **Other games** have a `Category` other than Pokemon.

**Extra columns:**
- `Grade`: `Ungraded`, or a company plus grade such as `CGC 8.5`, `PSA 10.0`, `BGS 9.5 Gem Mint` or `TAG 10.0 GEM MINT`.
- `Card Condition`: `Near Mint`, `Moderately Played`, `Heavily Played`, `Damaged`.
- `Average Cost Paid`, `Market Price`, `Price Override`, `Date Added` and `Notes`.
- **`Portfolio Name`** acts like a binder or list. One real file has `Album`, `For SaleTrade`, `Journey together`, `psa` and `Graded`.

## TCGplayer app

**Export** ([App FAQ](https://help.tcgplayer.com/hc/en-us/articles/115009506407), [BinderPOS article](https://seller.tcgplayer.com/articles/import-inventory-to-binderpos-using-the-tcgplayer-mobile-app/)):
- "You can export a list of cards to email, text message, and other third-party apps as either plaintext or CSV formats."
- The path is Collection tab → open a list → ⋯ → Send via Email, with the app's Email Export setting on CSV.
- Exports are per list, not per account.
- **Lists sync with the cloud** since the 2025 rewrite. The migration article says the new app "splits" collections over **5,000 cards**.

**Columns.** Collectr's sample-import screenshot shows the first 11. A real Pokémon export (fixture T1, 898 rows) has 14:

```
Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU,Price,Price Each
```

- **An older 12-column form** without `Price` and `Price Each` appears in real Magic exports ([MtgCsvHelper notes](https://github.com/StepKie/MtgCsvHelper/blob/e8488c7c982bf4663d62e184cf23e34ce11e7b34/MtgCsvHelper/Resources/SampleCsvs/Tests/SITE_BEHAVIOR.md)).
- **Encoding:** UTF-8, no BOM, LF in the fixture's Git blob.
- **Quoting:** standard CSV, so a name with a comma is quoted, as in `"Light-Paws, Emperor's Voice (Showcase)"` in a Magic export. Prices have a `$` sign.

**How a row names a card:**
- **`Product ID`:**
  - TCGplayer's product, which names a **Printing**, not an Edition.
  - Every row has one.
  - TCGdex lists the same ID as `thirdParty.tcgplayer` on its variants. For Weepinbell (`base2-48`), one product, 45151, covers both the plain variant and the `1st-edition` stamped variant.
- **`Printing`** separates finishes within a product: `Normal`, `Holofoil`, `Reverse Holofoil`, `1st Edition`, `Unlimited`, `Unlimited Holofoil`. Collectr also shows `1st Edition Holofoil`, from TCGplayer's catalog.
- **`Set`:**
  - TCGplayer's set name, with era prefixes: `SV01: Scarlet & Violet Base Set`, `SWSH06: Chilling Reign`, `SM - Burning Shadows`, `XY - Steam Siege`, `SWSH12: Silver Tempest Trainer Gallery`;
  - catch-alls: `Miscellaneous Cards & Products`, `League & Championship Cards`, `Prize Pack Series Cards`, `Deck Exclusives`.
- **`Set Code` is TCGplayer's own code and isn't safe as a key:**
  - `RR` is both Rising Rivals and Team Rocket Returns;
  - `PR` covers WoTC Promo, Nintendo Promos, League & Championship Cards, Deck Exclusives and the EX/DP trainer kits;
  - `SV` is Supreme Victors;
  - Prize Pack rows have a **blank** code;
  - codes differ from printed ones: `SV1` not `SVI`, `SWSH01` not `SSH`, `SM03` not `BUS`, `SV07` not `SCR`, and `SWSH12: TG` for a subset.
- **`Card Number`:**
  - `042/102`, `TG01/TG30`, a bare `008` for SV basic Energy, and `037` for a promo;
  - blank for SWSH basic Energy and a Battle Academy stamped Energy.
- **`Name` vs `Simple Name`.** `Simple Name` drops the tag that tells otherwise-identical products apart:
  - `Wigglytuff (32)`, `Klara (Full Art)`;
  - `Yveltal - 65/114 (Pokemon League)`, `Vanilluxe (Holiday Calendar)`;
  - `Fire Energy (#8 Cinderace Stamped)`, `Lightning Energy (Plusle)`.

  Those tags carry stamp and promo information that no finish column holds.
- **`Language`:** `English` in every Pokémon row seen.

**Extra columns:**
- `Condition`: `Near Mint`, `Lightly Played`, `Moderately Played`, `Heavily Played`, `Damaged`. The same card in two conditions is two rows, for example Base Set Starmie.
- `Rarity`, `SKU` (Product ID plus condition, language and printing), and the prices.
- **No folder column.** The list is the file.

**Plain-text export:** the FAQ confirms it exists. Its grammar is **unconfirmed**: no sample was found. One user post describes a price on the top line and `(Normal)`/`(Foil)` suffixes on lines, but it isn't authoritative.

**Previous app version.** The [migration article](https://help.tcgplayer.com/hc/en-us/articles/33797162920599) describes `legacy_data.csv`. It lists the fields only in prose: Collection Name, Created At, Product ID, Condition, Language, Variant, Quantity. The header spellings and order are **unconfirmed**. It has no name or set at all, so only Product ID can match it.

**Website collection.** No first-party export was found for tcgplayer.com's own collection page. A third-party [exporter](https://ebola16.github.io/TCGplayer-Collection-Exporter/) reads a saved copy of that page, which suggests none exists, but this is **unconfirmed**.

## PriceCharting

**Export** ([FAQ](https://www.pricecharting.com/faq), [staff reply](https://pricecharting.userecho.com/communities/1/topics/1292-is-there-a-way-to-export-your-collection-to-a-csv-or-excel-file)): Settings → Export Collection, which emails a zipped CSV. The page needs a login, so the limits are **unconfirmed** here. Search results quote "1 import & export per week" for free accounts.

**Columns.** These are identical in four unrelated real exports (fixture P1):

```
id,product-name,console-name,price-in-pennies,include-string,condition-string,sku,notes,cost-basis-in-pennies,quantity,date-entered,date-purchased,grading-company,grading-cert-id,folder
```

**How a row names a card:**
- **`id`** is PriceCharting's product ID. Nothing in our catalog or in TCGdex records it.
- **`console-name`** is the category plus the set:
  - `Pokemon Astral Radiance`, `Pokemon Promo`, `Pokemon Japanese VMAX Climax`, `Pokemon Chinese CSGC`;
  - toys such as `Pokemon 1999 Topps TV`;
  - other categories entirely, such as `YuGiOh Pharaoh's Servant` and `Basketball Cards 2025 Topps`.
- **`product-name` packs the name, a bracketed variant and `#number` into one field:**
  - `Rubber Gloves [Reverse Holo] #156`, `Duraludon [Cosmos Holo] #129`, `Raikou V [Prize Pack] #48`, `Ninetales [1999-2000] #12`;
  - `Oranguru #TG12`, `Hydreigon C #SWSH138`, `Grass Energy [Holo] #GRA`;
  - the order varies (`Genesect V #185 [HOLO]`);
  - some have no number at all (`Fairy Energy [Reverse Holo]`, `Elite Trainer Box`).
- **No denominator and no set code.** Some SWSH promos are filed under the set they came with: `Hydreigon C #SWSH138` sits in `Pokemon Celebrations`.

**Quantities.** In the 3,178-row file every `quantity` is `1`, with 280 IDs repeated. Each repeat is a separate copy with its own `date-entered` and `folder`. Other files do have `quantity` values of `2` and `3`, so the import must **add rows together**, not trust one row per card.

**Extra columns:**
- `include-string` holds the grade for cards: `Ungraded`, `PSA 10`. For games it holds the completeness.
- `condition-string` is always `Normal wear` for cards.
- Prices are in pennies: `price-in-pennies`, `cost-basis-in-pennies`.
- `date-purchased`, `grading-company`, `grading-cert-id`, `notes`, and **`folder`** (`Collection`, `Hits`).

**Text import.** PriceCharting's own paste importer takes "one item and console/set per line", up to 5,000 lines, for example `"Charizard #4 Base Set"` and `"Blastoise #2 Celebrations PSA 8"` ([text importer](https://www.pricecharting.com/collection-text-importer)). Collectors moving from PriceCharting may paste lines in that shape.

## Dex

[Dex help](https://dextcg.com/help/troubleshooting/importing-your-collection-into-dex), updated 2026-08-21:
- "Dex supports exporting your collection as a CSV file on iOS", at Settings → Data → Export Collection.
- The export is a Dex+ feature.
- Dex has no import.

**The CSV's columns are unconfirmed.** No public sample, help page or code that reads a Dex export was found. One research repository ([CardRelay](https://github.com/Lurk390/CardRelay/blob/fc7a7e9aa8a816a5efeb0a7f40e1233e99761dfb/docs/dex-collection-contract.md)) found that Dex's web API keeps quantities per finish (a `quantities` map) against a set code and a collector number. That suggests the CSV keys on the same fields, but it isn't evidence of the CSV's shape. There is no Dex fixture.

## Pokellector

**No collection export was found.**
- Pokellector's [App Store listing](https://apps.apple.com/us/app/pokellector-card-collector/id600580227) mentions only emailing or copying PTCGO QR codes.
- Its website shows no help, export or download link.
- One retailer's 2026 guide says Pokellector "doesn't offer a direct spreadsheet export".
- One unofficial blog claims a CSV export, which nothing first-party supports.

A collector leaving Pokellector would have to retype their cards or use the paste path. There is no fixture.

## Dragon Shield and Sorted

**Dragon Shield is being retired.**
- Sorted's [FAQ](https://tcgsorted.com/faq) calls Sorted the newer version of the Dragon Shield scanner apps, covering Pokémon among six games.
- Logging in with the same account imports the Dragon Shield collection automatically.
- New Dragon Shield exports will stop appearing, but files already exported will still exist.

**Dragon Shield Poké TCG Scanner export** (fixture D1: seven real rows, quoted in a public spec, so the line endings aren't preserved):

```
"sep=,"
Folder Name,Quantity,Trade Quantity,Card Name,Set Code,Set Name,Card Number,Condition,Printing,Language,Price Bought,Date Bought,LOW,MID,MARKET
```

- **The first line is the literal `"sep=,"`,** an Excel hint. It must be skipped.
- **Set codes are Dragon Shield's own:** `SV1`, `MEW`, `PPS` (Prize Pack), `CLA` (Classic).
- **Japanese-only sets are labelled English.** `S2` Rebellion Crash, `S4A` Shiny Star V and `S5I` Single Strike Master all carry `Language` `English`.
- **Card numbers** may have spaces (`040 / 096`) or a suffix (`012VL`).
- **`Condition`** uses joined words: `NearMint`, and per the MtgCsvHelper notes, `LightPlayed`, `Good`, `Played` and `Poor`.
- **`Printing`** is `Normal` in every Pokémon row seen. What Dragon Shield writes for Pokémon reverse holo is **unconfirmed**. For Magic it writes `Foil` and named treatments.
- **For Magic,** MtgCsvHelper reports that Dragon Shield requires CRLF and that its importer keys on set name, not set code.

**Sorted export** (fixture S1: a real Pokémon export, 92 rows):

```
List Type,List Name,Collection,Format,Board,Quantity,Card Name,Set Code,Set Name,Card Number,Condition,Printing,Rarity,Language,Price Bought,Date Bought,Parent List Type,Parent List Name,Current Price (tcgplayer_marketsellprice),List Cover Image,Parent List Cover Image
```

- **`Collection`** is the game: `pok` here, `mtg` for Magic.
- **`List Type` and `List Name`** are the folder. Rows with `List Type = Deck` are decks, which Collection Import should skip or flag.
- **`Language`** is a two-letter code (`en`). For Magic, MtgCsvHelper also lists `jp`, `cn` and `tw`.
- **The `"sep=,"` line:** MtgCsvHelper reports one on a 17,967-row Magic export. The Pokémon file has none. Accept both.

## TCG Collector

**Export** ([Premium page](https://www.tcgcollector.com/premium/usd)): "Export your collection data" is a Premium feature. The steps aren't public.

**Columns** (fixture TC1: a real export, 450 rows, **CRLF**, no BOM):

```
TCG region,Expansion,Card number,Card number sorting order,Card name,Rarity,Card variant,Card language,Card condition,Note,Quantity
```

- **`TCG region`** is `International` here. Japanese cards would presumably show another region, which is **unconfirmed**.
- **`Expansion`** names sets in TCG Collector's own wording: `Scarlet & Violet 151`, `SV Black Star Promos`, `Scarlet & Violet Energies`, `2022 Energies`.
- **`Card number`** is `001/159`, a bare `1` for Energy, or `62` for a promo.
- **`Card number sorting order`** is a plain integer.
- **`Card variant`:** `Normal`, `Non-holo`, `Holo`, `Normal Holo`, `Reverse Holo`, `Cosmos Holo`, `Cracked Ice Holo`, `Promo`.
- **Identical rows repeat.** `Petilil 006/159 Normal Near Mint` appears with quantity 2 and again with 1, so rows must be added together.

## Other trackers considered

- **[Eyevo](https://eyevotcg.com/features/export/):** exports CSV, JSON and text. Its column list wasn't confirmed from a first-party page (the help URL returned 404).
- **TCG Companion and TCG Stacked:** their store pages claim CSV export, with no format published.
- **[CollectHolo](https://www.collectholo.com/help-center/guides/bulk-import):** publishes an *import* template that says "Collectr-style column names are supported". It isn't Collectr's export: its columns (`product_name`, `cardmarket_id`, `printing_variance`) are CollectHolo's own. It does show the vocabulary another importer chose: `holofoil`, `reverseHolofoil`, `firstEdition`.

None of these has public real exports, so they have no fixtures.

## Finish and variant words against Variant Descriptor

**What a Card Edition's descriptor looks like.** A Card Edition's Variant Descriptor comes from TCGdex `variants_detailed` (`api/app/catalog.py`, `PHYSICAL_VARIANT_KEYS`):
- `type`: `normal`, `holo` or `reverse`;
- `subtype`: for example `unlimited`, `shadowless` or `1999-2000-copyright`;
- `stamp`: a list, for example `['1st-edition']` or `['set-logo']`;
- `foil`: for example `pokeball`, `masterball` or `cosmos`;
- `size`.

These values were sampled live for `base1-4`, `base2-48`, `neo3-14`, `sv03.5-001` and `sv08.5-001`.

**Marketplace Mappings.** Verified mappings store TCGplayer's `product_id` with a `quote_variant` of `normal`, `holofoil` or `reverse-holofoil` (`migrations/023_metadata_review.sql`, `catalog_targets.py`).

| Descriptor (TCGdex) | TCGplayer `Printing` | Collectr `Variance` / name tag | PriceCharting `[…]` | TCG Collector `Card variant` | Dragon Shield / Sorted `Printing` |
| --- | --- | --- | --- | --- | --- |
| `type: normal` | `Normal`; `Unlimited` on WotC non-holo | `Normal`; `Unlimited` | no tag | `Normal`, `Non-holo` | `Normal` |
| `type: holo` | `Holofoil`; `Unlimited Holofoil` | `Holofoil`; `Unlimited Holofoil` | `[Holo]`, `[HOLO]` | `Holo`, `Normal Holo` | unconfirmed |
| `type: reverse` | `Reverse Holofoil` | `Reverse Holofoil` | `[Reverse Holo]` | `Reverse Holo` | unconfirmed |
| `stamp: ['1st-edition']` | `1st Edition`; `1st Edition Holofoil` | `1st Edition`; `1st Edition Holofoil` | `[1st Edition]` | not seen | unconfirmed |
| `foil: pokeball` / `masterball` (reverse) | a separate product, with the tag in `Name` | `Poke Ball Reverse Holo`, or `(Poke Ball Pattern)`/`(Master Ball Pattern)` in the name | not seen | not seen | unconfirmed |
| `foil: cosmos` | `(Cosmos Holo)` in `Name` | `(Cosmos Holo)` in the name, with `Variance` `Holofoil` | `[Cosmos Holo]` | `Cosmos Holo` | unconfirmed |
| `subtype: shadowless`, `1999-2000-copyright` | its own products | the set name `Base Set (1st Edition & Shadowless)` | `[1999-2000]` | not seen | unconfirmed |
| other stamps (League, Prerelease, Holiday Calendar, Battle Academy, Prize Pack) | tags in `Name`, or a set such as `League & Championship Cards` | tags in the name: `(Mega Evolution Stamped)`, `(#60 Pikachu Stamped)` | `[Prize Pack]` | not seen | unconfirmed |
| `Cracked Ice Holo` | not seen | not seen | not seen | `Cracked Ice Holo` | — |

**What this means:**
- **Plain, holo and reverse holo** map by a small per-tracker table.
- **1st Edition** maps to the `1st-edition` stamp. TCGplayer, Collectr and PriceCharting carry it.
- **Patterns, Cosmos and Cracked Ice holo, and the other stamps** live in name tags or set names for TCGplayer and Collectr, so a finish column alone misses them.
- **Words outside the table** should land on the Unspecified Variant, or on **Pick one** among the Printing's Editions. Never guess.
- **This differs from decklist import,** where `PH` is ignored ([import contract](../../../decklist-import/wayfinder/resolutions/decide-import-contract.md), owner decision 3). A Holding is per Edition, so the finish matters here.

## Extra columns we don't track

| Kind | Collectr | TCGplayer app | PriceCharting | TCG Collector | Dragon Shield / Sorted |
| --- | --- | --- | --- | --- | --- |
| Condition | `Card Condition` | `Condition` | `condition-string` (always `Normal wear` for cards) | `Card condition` | `Condition` (`NearMint` …) |
| Grade | `Grade` (`PSA 10.0`, `CGC 8.5`, `BGS 9.5 Gem Mint`, `TAG …`) | — | `include-string`, `grading-company`, `grading-cert-id` | — | — |
| Price paid | `Average Cost Paid` | — | `cost-basis-in-pennies` | — | `Price Bought` |
| Market price | `Market Price (As of …)`, `Price Override` | `Price`, `Price Each` | `price-in-pennies` | — | `LOW/MID/MARKET` (DS), `Current Price (…)` (Sorted) |
| Dates | `Date Added` | — | `date-entered`, `date-purchased` | — | `Date Bought` |
| Notes | `Notes` (16-column form) | — | `notes` | `Note` | — |
| Binder, folder or list | `Portfolio Name` | none; one file per list. Legacy: `Collection Name` | `folder` | — | `Folder Name` (DS), `List Type`/`List Name` (Sorted) |
| Trade or want flags | `Watchlist` | — | — | — | `Trade Quantity` (DS) |
| Language | none (name tags) | `Language` | in `console-name` | `Card language`, `TCG region` | `Language` |

Two consequences:
- **A row can split.** Two rows can differ only in condition or grade, like TCGplayer's two Base Set Starmie rows or Collectr's graded and raw Mega Evolution Bulbasaur. Without condition tracking they land on the same Edition, so their quantities add up.
- **Folders are available but have nowhere to go.** Every format but TCGplayer's carries a folder or list name. Under the map's "one landing leaf" decision, those names are dropped or shown only for review.

## File sizes and row counts

Measured on the real exports:

| File | Rows | Bytes | Bytes per row |
| --- | --- | --- | --- |
| TCGplayer app (Pokémon) | 898 (1,011 cards) | 102,226 | 114 |
| Collectr, 14 columns | 809 | 95,024 | 117 |
| Collectr, 16 columns | 522 | 64,763 | 124 |
| PriceCharting (mixed categories, 798 Pokémon) | 3,178 | 356,591 | 112 |
| TCG Collector | 450 (696 cards) | 40,875 | 91 |
| Sorted (Pokémon) | 92 | 10,900 | 118 |

**Published and observed ceilings:**
- **TCGplayer** splits migrated collections over 5,000 cards.
- **PriceCharting's** text importer takes at most 5,000 lines.
- **MtgCsvHelper** parsed a real 17,967-row Sorted export, of Magic cards.
- **CollectHolo's** importer caps files at 5 MB and free accounts at 500 rows.

**What that means for the import:**
- **Size.** At roughly 110–125 bytes a row, a 20,000-row collection is about 2.5 MB. A 5,000-row TCGplayer list is about 600 KB.
- **The decklist limits don't fit.** The decklist contract allows 20,000 characters and 200 card lines (`IMPORT_TOO_LONG`, `IMPORT_TOO_MANY_LINES`), which doesn't carry over. Even the smallest real collection file here, 92 rows, has 10,900 characters, and a typical one has 500–3,000 rows.
- **Review and save in one request may be too big.** A stateless review that posts the whole file and gets every line back, as the decklist review does, would carry megabytes on each fix. That is input for [#220](https://github.com/ry-cen/prizecheck/issues/220).

## What carries over from decklist import

**Reusable as is:**
- **Text normalisation** ([import contract, Parsing](../../../decklist-import/wayfinder/resolutions/decide-import-contract.md#parsing)):
  - line endings and the BOM;
  - NBSP and zero-width spaces;
  - NFC normalisation;
  - `’` read as `'`.

  The real files add trailing spaces in Collectr names and the `"sep=,"` line.
- **Catalog search's `NUMBER_KEY`,** which drops zeros after a number's letters. It handles `TG05` vs `TG5` and `001` vs `1`, once the denominator is cut off (`042/102` → `042`, `TG01/TG30` → `TG01`).
- **The name fallback** (matching order step 3):
  - names compared through `catalog_search_words`;
  - optional parenthetical subtitles;
  - one Reprint Group gives **Matched by name**, several give **Pick one**.

  The set-code research's finding still holds: names are safe for Trainers and Energy and often ambiguous for Pokémon. Collection rows carry a set name, so the name search can be limited to that set, which removes most of that ambiguity.
- **Basic Energy by type** (step 2), for the many Energy rows with no number (TCGplayer SWSH Energy, PriceCharting `Water Energy`).
- **The review statuses and the Missing cards hand-off,** without the Deck-specific parts:
  - allocation;
  - Use cards I own;
  - Target Format.

**Doesn't apply to tracker CSVs:**
- **The Live/Limitless alias table** (`PR-SV`, `PR-SW`, `-TG` splits, the SHF/HIF offsets, `Energy N`). No tracker CSV writes those forms. Tracker files carry set **names** (Collectr, TCGplayer, PriceCharting, TCG Collector) or their own codes (TCGplayer, Dragon Shield, Sorted).
- **Matching step 1, code plus number,** works only for Dragon Shield and Sorted codes that happen to match `set_codes.tsv` (`MEW`, `PAL`). It doesn't work for TCGplayer's codes.
- **The card-line grammar** (`qty name SET number`). It still applies to a pasted collection that is really a decklist-style list, which is the main reason "read the way decklist import reads a paste" works at all.

**New work:**
1. **A per-format header sniffer.** Recognise each header listed above by its column names, prefix-matching Collectr's dated column. Skip `"sep=,"`. Read standard CSV quoting. Accept CRLF and LF.
2. **Row filters, each reported, not silently dropped:**
   - Collectr watchlist rows;
   - sealed product, meaning a blank number together with a sealed-sounding name or blank rarity (**the exact rule is a matching decision**);
   - other games (`Category`, `console-name`, `Collection`);
   - Japanese and Chinese rows: `(JP)`/`(CN)` tags, `Japanese`/`Chinese` in `console-name`, Dragon Shield's `S…` codes;
   - Sorted deck lists.
3. **A Product ID path for TCGplayer files.** Product ID plus `Printing` → Edition, through:
   - verified Marketplace Mappings, i.e. `catalog_edition_metadata.product_id` with `quote_variant`; or
   - TCGdex's `thirdParty.tcgplayer` kept in the raw catalog generation.

   Measured against live TCGdex for the 898-row TCGplayer file:
   - 604 rows' Product ID equals a TCGdex variant's `thirdParty.tcgplayer`;
   - 2 differ;
   - 240 rows' cards have no `thirdParty` in TCGdex.
4. **A set-name alias table** keyed by each tracker's set name, to a TCGdex set ID. Naive name matching (lowercase, punctuation stripped, prefixes like `SV01:` and `SM -` removed, plus six manual entries) already reaches the card by name and number for:
   - **TCGplayer:** 846 of 898 rows (94%);
   - **Collectr:** 565 of 708 English card rows (80%);
   - **TCG Collector:** 402 of 450 rows (89%).

   What's left is mostly promo and catch-all sets and Energy sets:
   - TCGplayer's `Miscellaneous Cards & Products`, `League & Championship Cards`, `Prize Pack Series Cards`, `Expedition` (TCGdex's *Expedition Base Set*) and the McDonald's sets;
   - Collectr's `Scarlet & Violet Promo`, `Sword & Shield Promo` and `Base Set (Unlimited)`;
   - TCG Collector's `Scarlet & Violet Energies` and `SV Black Star Promos`.

   This is the collection counterpart of `import_aliases.tsv`, and like it, it should cite its evidence row by row.
5. **New number shapes:**
   - a denominator to cut (`n/m`, `TG01/TG30`, `SV032/SV122`, `040 / 096`);
   - `037/DP-P`;
   - `012VL`;
   - `#SWSH138` inside PriceCharting's name field;
   - blank numbers.
6. **Name cleaning per format:**
   - TCGplayer: use `Simple Name`, but keep `Name`'s tag as finish and stamp evidence;
   - Collectr: trim, and peel tags in parentheses (`(Secret)`, `(Full Art)`, `- 20/68`);
   - PriceCharting: split `Name [Variant] #N`.
7. **A finish table per tracker,** as above. Anything it doesn't cover goes to the Unspecified Variant or **Pick one**.
8. **Adding rows together.** Merge rows that resolve to the same Edition: PriceCharting's one row per copy, TCG Collector's repeats, and condition or grade splits. Each Edition then gets one Holding increment in the landing leaf.
9. **Pasted text** comes in three shapes, and the parser should recognise each:
   - **decklist-style lines,** for which the existing grammar works;
   - **a copied spreadsheet** (tab-separated, header first; fixture X2), which is the CSV path with a tab delimiter;
   - **free text in PriceCharting's style** (`Charizard #4 Base Set`), which only the name fallback can read.

## Fixtures

Fixtures live in [`fixtures/`](fixtures/). The filename says whether a fixture is real or a reconstruction; the CSV files hold no comment lines, so they stay parseable. The real fixtures are row slices of the public files, copied byte for byte, so the line endings and quoting are as published. A slice keeps the header and the rows picked for edge cases.

| ID | File | Kind | What it shows |
| --- | --- | --- | --- |
| T1 | `tcgplayer-app.real.csv` | real export, 25 of 898 rows | the 14-column header; `RR` used for two sets; blank set code (Prize Pack); blank numbers; `TG01/TG30`; `1st Edition`, `Unlimited Holofoil` and `Reverse Holofoil`; name tags (`(Holiday Calendar)`, `(Pokemon League)`, `(#8 Cinderace Stamped)`); one card in two conditions |
| C1 | `collectr-14col.real.csv` | real export, 17 of 809 rows | the 14-column header; watchlist rows; trailing spaces; `(JP)`; `CGC 8.5`; `037/DP-P`; `SV032/SV122`; `(Cosmos Holo)` in a name; `Poke Ball Reverse Holo` as the Variance; Rarity `Unconfirmed` |
| C2 | `collectr-16col.real.csv` | real export, 11 of 522 rows | the 16-column header; One Piece rows; a sealed ETB; a quoted `"1,055.48"`; `1st Edition Holofoil`; `(Poke Ball Pattern)`; `(CN)`; graded and raw rows of one card |
| P1 | `pricecharting.real.csv` | real export, 18 of 3,178 rows | the 15-column header; `Name [Variant] #N`; Japanese sets; promos under their box's set; Energy with no number; an ETB; a basketball card and a Yu-Gi-Oh! card; one ID twice (one row per copy); `PSA 10` in `include-string`; `folder` |
| TC1 | `tcg-collector.real.csv` | real export, 14 of 450 rows, **CRLF** | the 11-column header; identical repeated rows; `Non-holo`, `Normal Holo`, `Cosmos Holo`, `Cracked Ice Holo`, `Promo`; Energy and promo set names |
| D1 | `dragon-shield-pokemon.real.csv` | real export **as quoted in a Markdown spec**, all 7 rows; the line endings aren't original | the `"sep=,"` line; Dragon Shield codes; Japanese-only sets labelled English; `040 / 096`; `012VL` |
| S1 | `sorted-pokemon.real.csv` | real export, 5 of 92 rows | the 21-column Sorted header; `pok`; `NearMint`; `en`; no `"sep=,"` line |
| X1 | `tcgplayer-legacy.reconstruction.csv` | **reconstruction** | `legacy_data.csv` built from the help article's field list. **Header spelling and order unconfirmed.** Its Product IDs come from T1 |
| X2 | `paste-spreadsheet-tsv.reconstruction.txt` | **reconstruction** | five T1 rows as a spreadsheet puts them on the clipboard, tab-separated |
| X3 | `paste-lines.reconstruction.txt` | **reconstruction** | a mixed paste: a title line, PTCGL-shaped lines (with `PH`), `2x` quantities, a line with no quantity, PriceCharting-style free text, a TCGplayer-style name with a tag |

**No fixture** for Dex, whose columns are unconfirmed, or Pokellector, which has no export.

**Git and line endings.** The repository has no `.gitattributes` and `core.autocrlf` is unset, so TC1's CRLF survives a commit as is. Adding `fixtures/*.csv -text` would make that explicit.

### Sources for the fixtures

All pinned to the commit read on 2026-10-15:
- **T1:** [pmerrild/ptcg_collection `fixtures/TCGplayerCardList.csv`](https://github.com/pmerrild/ptcg_collection/blob/8d230c8dcbe271b6d0ad6be1606a5d58ed60890a/fixtures/TCGplayerCardList.csv), committed 2025-06-30.
- **C1:** [valuetrainerpro/valuetrainerpro `export.csv`](https://github.com/valuetrainerpro/valuetrainerpro/blob/ff5778ddbddae465155ca99face8294ffb2be8c2/export.csv). A second 14-column file with several portfolios is [antitled/abaday-dashboard `collectr-data.csv`](https://github.com/antitled/abaday-dashboard/blob/75bb81088315432da559189e9101e0a7674e2ff7/collectr-data.csv).
- **C2:** [ojandali93/truepoint-server `fixtures/export (1).csv`](https://github.com/ojandali93/truepoint-server/blob/fbeb1e0050c265e378e15c26759e3d02f0dd16e0/fixtures/export%20(1).csv). The same header appears in [BreadMakesYouFull/pokegridview `cards.csv`](https://github.com/BreadMakesYouFull/pokegridview/blob/35862e6970f8f2d6eed9bc57f6fa896b2800298d/cards.csv).
- **P1:** [lootlabs412/loot-labs `collection_20260809.csv`](https://github.com/lootlabs412/loot-labs/blob/4bc585c038cfd725cfb41a121a1d2ccb2f82e5d8/collection_20260809.csv). The same header appears in [canotpixels](https://github.com/canotpixels/le-canot-a-pixels/blob/deda001731f2d68ec3cb08f3818518471f3435de/data/pricecharting/collection.csv), [ACoolNerd](https://github.com/ACoolNerd/ACoolCOLLECTOR/blob/e27c256e3d05c3a4aed725df4255ac80532210df/data/processed/last_50_entries.csv) and [dd1x0n](https://github.com/dd1x0n/ld_collection/blob/1210978906860252a6e7e5a54a57b004c3cc7918/games_2026.csv).
- **TC1:** [shiftregister-vg/card-craft `docs/tcgcollector-export-example.csv`](https://github.com/shiftregister-vg/card-craft/blob/3ba1163f1bcabefedc7ca2f099b746840f937a5e/docs/tcgcollector-export-example.csv), committed 2025-04-18.
- **D1:** [gengar200005/pokemon-tcg-guide `pokemon-tcg-app-spec.md` §8.1](https://github.com/gengar200005/pokemon-tcg-guide/blob/2185d56d39d6cb0a60827a1460e522411a14cb1f/pokemon-tcg-app-spec.md), dated 2026-04-06.
- **S1:** [sinus0486/card-collection-tracker `data/pokemon_all.csv`](https://github.com/sinus0486/card-collection-tracker/blob/b2c7be4d36e4540066bd57d6d2f8404833303ddf/data/pokemon_all.csv), committed 2026-08-31.

**Not used as evidence of a real format:**
- [kristiangoystdal `sample.csv`](https://github.com/kristiangoystdal/kristiangoystdal.github.io/blob/256f2461be08fdf52e85ce7953b9eaed2479ac21/pokemon-tracker/tests/sample.csv): Collectr-shaped but apparently hand-made (`"Pikachu, Flying"`).
- CardRelay's `tests/fixtures/collectr/*`: fictional.
- CollectHolo's sample rows: its own import template.

## Not confirmed

- **Dex's** CSV columns.
- **TCGplayer:**
  - the plain-text export's grammar;
  - the exact header of `legacy_data.csv`;
  - whether the website collection has any export.
- **Collectr's** language for other games (the `Category` values) and whether its free tier can export at all (the help page says Pro).
- **PriceCharting's** current export limits for free accounts.
- **Dragon Shield's** Pokémon `Printing` values beyond `Normal`, its original line endings, and how many Dragon Shield users have already migrated to Sorted.
- **TCG Collector:** how it writes Japanese cards (`TCG region`), and the steps for its Premium export.
- **Exports in other languages:** whether any tracker localises its CSV headers. None seen.
