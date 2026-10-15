# Research — decklist text formats

**For:** [Research decklist text formats](https://github.com/ry-cen/prizecheck/issues/199). It answers which text formats a collector is likely to paste into a Deck, and what the exact grammar of each one is. It blocks [#202](https://github.com/ry-cen/prizecheck/issues/202) (prototype the import review step) and [#203](https://github.com/ry-cen/prizecheck/issues/203) (decide the import contract). This file covers text formats only; the builders themselves are covered in [ptcgl-deck-builder.md](../../../app-redesign/wayfinder/research/ptcgl-deck-builder.md) and [limitless-deck-builder.md](../../../app-redesign/wayfinder/research/limitless-deck-builder.md).

**Gathered:** 2026-10-14. Pokémon publishes no specification of the TCG Live export. A search of pokemon.com and support.pokemon.com found nothing, and Bulbapedia and PokeBeach refused automated fetches (403). Each part of this file is therefore based on one of three kinds of source, and each claim says which:

- **Code.** Limitless's own exporter JavaScript, served by limitlesstcg.com and my.limitlesstcg.com, read on 2026-10-14. This is the strongest evidence.
- **Real exports.** Text people saved or pasted, found in public GitHub repositories.
- **Third-party docs.** Limitless Docs and RK9 support.

Claims that no source confirmed are marked **unconfirmed**.

## Summary

| | TCG Live (PTCGL) | Limitless (deck page and builder) | TCG Online (PTCGO, retired) |
| --- | --- | --- | --- |
| Section header | `Pokémon: N` / `Trainer: N` / `Energy: N` | the same | `##Pokémon - N` / `##Trainer Cards - N` / `##Energy - N` |
| What `N` counts | **number of lines** (distinct prints) | **number of cards** | number of cards |
| Card line | `4 Iono PAL 185` | `4 Iono PAL 185` | `* 4 Iono PAL 185` |
| Basic Energy | `Basic {P} Energy SVE 5` | `Psychic Energy SVE 5`, or `Psychic Energy Energy 22` for SUM–BRS prints | `Grass Energy GRI 167` (one theme deck has an empty set: `Water Energy  12`) |
| Sword & Shield / Scarlet & Violet promos | `PR-SW 281`, `PR-SV 75` | `PR-SW 167`, `PR-SV …` (mapped from Limitless's `SP`/`SVP`) | `PR-SM SM62`, `PR-BLW BW100` |
| Blank lines | between sections | between sections | after each header and between sections |
| Footer | `Total Cards: 60` | none | `Total Cards - 60` plus a `******` footer line |
| Language | headers are localised (German: `Energie:`, `Karten insgesamt:`) | English only | English |
| Format marker (Standard/Expanded) | none | none | none |

**What this means for the parser.** Treat a header as a section marker only. Never use its number as a checksum, because TCG Live and Limitless count different things. Work out totals by adding up the lines.

## Pokémon TCG Live export

**How it's produced.** Deck manager → Export copies the list to the clipboard. [Limitless Docs: Decklist Submission][ldocs], [RK9: import from TCG Live][rk9]. Nothing was found that shows the text written by Pokémon itself.

**Evidence.**
- [JoseRivas1998/pokemon-decklists][jr], 2024-12 to 2025-03. Its README says the lists are "in the `Export Deck` format in Pokémon TCG Live". It is the cleanest example.
- [geekazoid-at/codes4tcg-decks][gz]: about 5,300 lists scraped from YouTube video descriptions, with raw descriptions under [`youtubeBot/src/test/`][gz-test]. Its bot **rewrites lists**:
  - [`deckTransformer.ts`][gz-transform] splits `PAF183` into `PAF 183`;
  - it rewrites `… Lightning Energy …` and `… Energy Energy …` lines as `Basic {L} Energy SVE 4`;
  - [`processVideo.ts`][gz-process] adds `Total Cards: 60` where it is missing.

  Its `deck.txt` files are therefore "community-collected, TCG Live-shaped". Only the raw descriptions in its test folder are verbatim.

**Grammar** (observed in every JoseRivas file):

```
export   := section ( "\n\n" section )* "\n\n" footer "\n"?
section  := header "\n" line ( "\n" line )*
header   := ( "Pokémon" | "Trainer" | "Energy" ) ": " int     ; int = number of LINES in the section
line     := qty " " name " " set " " number ( " PH" )?
footer   := "Total Cards: " int                                ; int = number of cards (60)
```

- **The header counts lines, not cards.** Examples:
  - JoseRivas's Gardevoir list has `Pokémon: 12` over 12 lines that hold 20 cards.
  - The same holds in all four JoseRivas files, and in 32 of a 41-list geekazoid sample, dated 2023-06 to 2026-08.
  - The other 9 geekazoid lists count cards. Two of their raw descriptions ([description2][gz-d2], [description3][gz-d3]) are Limitless exports: they count cards, write `Metal Energy SVE 16` names and have no footer. The bot then added a `Total Cards: 60` line to them.

  So "TCG Live counts lines" is an inference from about 36 exports. Pokémon doesn't document it. Whether some TCG Live version counts cards instead is **unconfirmed**.
- **Footer:** `Total Cards: 60`, after a blank line. Whether TCG Live adds a final newline is **unconfirmed**: the JoseRivas files have one, but Git and editors can change that.
- **Line endings:** **unconfirmed.** Every TCG Live-shaped file seen uses LF, but Git can normalise line endings, and nothing shows what the Windows client puts on the clipboard. Accept LF, CRLF and CR.
- **Localisation.** A German player's [description1][gz-d1] (PokéPhil) has `Pokémon: 13`, `Trainer: 17`, `Energie: 2` and `Karten insgesamt: 60`, while the card lines stay in English with English set codes. The bot's [`germanToEnglish`][gz-transform] exists for exactly this. Other client languages are **unconfirmed**.
- **The same card on several lines.** One line is one print. JoseRivas's Gardevoir list has `1 Buddy-Buddy Poffin PRE 101 PH` and `2 Buddy-Buddy Poffin TEF 144 PH`. PokéPhil's list has `1 Nest Ball SVI 255` and `3 Nest Ball SVI 181`. Copy limits must add up across lines by card Identity.
- **Order within a section** follows the deck builder, not the alphabet. TCG Live doesn't group evolution lines.

**Tokens.**
- **`PH` suffix.** Seen on Pokémon, Trainer and Basic Energy lines, for example `1 Mimikyu PAL 97 PH`, `1 Technical Machine: Evolution PAR 178 PH` and `1 Basic {P} Energy SVE 13 PH`. It probably marks a reverse-holo ("parallel holo") print. Its meaning is **unconfirmed**. The parser should strip a trailing `PH` and remember it as a finish hint.
- **Basic Energy.** Written `Basic {X} Energy <set> <n>`. `{X}` is one of `G R W L P F D M Y`, matching the energy letters in Limitless's exporter.
  - Scarlet & Violet energy appears under both `SVE 1–8` and `SVE 9–16`, for example `Basic {P} Energy SVE 5` and `16 Basic {P} Energy SVE 13`. They are different energy printings.
  - Older energy keeps its own set: `8 Basic {G} Energy GRI 167`, `6 Basic {L} Energy GEN 78 PH`.
  - Mega Evolution-era energy uses `MEE`: `9 Basic {G} Energy MEE 1`.
- **`SVALT` / `SWSHALT`.** Set codes that exist only in the game.
  - JoseRivas's lists contain `1 Basic {P} Energy SVALT 135`.
  - Limitless Docs gives the example "Cosmo foil Boss's Orders … listed as SWSHALT 127 instead of BRS 132", and says such codes won't resolve against real sets. Trainer and English Energy lines can still be found by name alone. [Limitless Docs][ldocs]
  - What `SVALT` numbers map to is **unconfirmed**.
- **Promos:** `1 Regidrago V PR-SW 281` and `1 Mimikyu PR-SV 75`. The number has no prefix. An older TCG Live-shaped Expanded list in [Shutterst0ck/SUM-on_TCGLive_Expanded][shut] has `PR-SM 217`. Those files are reformatted Markdown with `* ` bullets, so they are not raw.
- **Trainer Gallery and Galarian Gallery cards:** `2 Bibarel CRZ-GG 25` and `1 Manaphy CRZ-GG 6`. The subset goes into the set code, and the number has no zero padding. This comes from geekazoid lists, and the bot's rewriting wouldn't produce the hyphen. Trainer Gallery cards (`LOR-TG`) are expected to work the same way, but no clean raw example was found.
- **Prism Star:** `1 Thunder Mountain {*} LOT 191`, from a geekazoid 2023 list. Shutterst0ck's TCG Live Expanded lists (2023) write `◇` (U+25C7) instead: `1 Ditto ◇ LOT 154`. Those files are reformatted, so whether `◇` came from TCG Live or from the author is **unconfirmed**. Accept both.
- **Energy type symbols in names:** `4 Speed {L} Energy RCL 173`.
- **Secret-rare numbers** above the set size: `1 Jacq SVI 236`, `1 Iono PAL 269`.
- **Names:**
  - The apostrophe is ASCII `'`, as in `Boss's Orders` and `Lillie's Determination`. No U+2019 appeared in any file.
  - `é` is precomposed (NFC, bytes `C3 A9`), as in `Poké Pad` and `Pokégear 3.0`.
  - A colon can sit inside a name: `Technical Machine: Evolution`.
  - Subtitles and forms are part of the name: `Bloodmoon Ursaluna ex`, `Teal Mask Ogerpon ex`, `Lillie's Clefairy ex`, `Gengar & Mimikyu-GX`.
  - No NBSP or BOM appeared in any file, but the scraped YouTube descriptions contain zero-width spaces (U+200B) in the surrounding prose.

**Parsing by position.** Work from the right of the line, in this order:

1. An optional `PH`.
2. The number: `\d+[a-z]?`, or one with a prefix such as `SM62`, `BW100` or `TG05`.
3. The set token:
   - `[A-Z0-9]{2,8}`, so 7-letter `SWSHALT` fits;
   - optionally `-[A-Z0-9]{2,4}`, for `PR-BLW`, `CRZ-GG` and `LOR-TG`;
   - or the mixed-case pseudo-set `Energy`, valid only when the name before it ends in `Energy`.

Everything between the quantity and the set is the name. Set codes have no spaces.

Two cases need care:
- **The empty set code.** Check for TCG Online's empty-set Energy line (`Water Energy  12`, with two spaces) *before* collapsing repeated spaces. Once collapsed it becomes `Water Energy 12`, which reads like the `Energy N` pseudo-set.
- **`Dawn M 2 77`.** The space comes from the geekazoid bot's `([A-Za-z]+)(\d+)` split, so the original was probably `M2 77`, which looks like a Japanese set code. Pasted lists may therefore carry codes that don't exist in an English catalog. This is **unconfirmed**.

## Limitless deck pages and the Limitless deck builder

**This is the strongest evidence: the exporter's code.**
- The "Copy to Clipboard" button on a deck page (for example [/decks/list/29678][l-29678]) runs [`decklist-11f9e903.js`][l-js].
- The builder's Share → Copy as Text runs `exportText` in [`chunks/CJkcgh53.js`][lb-js].

Both use the same set-and-number function. The file names are content hashes and will change.

**Deck page grammar.** The exporter takes each column heading, such as `Pokémon (19)`, and applies `replace(/(\w+)\s*\((\d+)\)/, "$1: $2")`. It then writes each card as `` `${count} ${name} ${G(set, number, basicEnergy)}` ``. A blank line follows each section, and the whole string is passed to `.trim()`.

```
export   := section ( "\n\n" section )*          ; LF only, no leading/trailing whitespace
section  := header "\n" line ( "\n" line )*
header   := ( "Pokémon" | "Trainer" | "Energy" ) ": " int   ; int = number of CARDS
line     := qty " " name " " setnum
```

- **There is no `Total Cards` line.**
- **The builder:** `A(e)` writes `` `${label}: ${sum of counts}` `` with labels `Pokémon`, `Trainer` and `Energy`, then the lines, then `.trim()`. It produces the same shape.
- **Names on the page:** Basic Energy is called `Fire Energy` or `Psychic Energy`, never `Basic {R} Energy`. A `data-basic-energy` attribute marks them.

**`G(set, number)`, verbatim logic:**
1. If the set is `SP`, write `PR-SW <n>`. If it is `SVP`, write `PR-SV <n>`. **Only these two promo sets are mapped.** Sun & Moon promos stay as Limitless's own code, for example `1 Tapu Koko SMP 30`, while TCG Online writes `PR-SM SM30`.
2. Basic Energy from **SUM, TEU, SSH or BRS** becomes `Energy <id>`, a numbering that exists only in the game:
   - SUM: G18 R19 W20 L21 P22 F23 D24 M25 Y26
   - TEU: 27–35
   - SSH: 36–44
   - BRS: 45–53

   Limitless stores these energy numbers as the type letter (`data-set="TEU" data-number="P"`). Its export of [/decks/list/2000][l-2000] therefore reads `7 Psychic Energy Energy 31`.
3. A number matching `(RC|TG|GG)\d{1,2}` becomes `<SET>-<prefix> <digits>`. For example, `CRZ`/`GG25` becomes `CRZ-GG 25`. Limitless's card URLs use unpadded numbers such as [`/cards/LOR/TG1`][l-tg], which gives `LOR-TG 1`. Whether any deck-page number keeps a zero pad is **unconfirmed**.
4. HIF and SHF shiny-vault numbers `SVnn` become `<SET> <nn + 69>` for HIF and `<SET> <nn + 73>` for SHF, giving the game's flat numbering.
5. Anything else becomes `<SET> <number>`. Scarlet & Violet energy comes out as `Psychic Energy SVE 13` and Mega Evolution energy as `Fire Energy MEE 10`.

**The builder's import parser runs on the server.** Import from Clipboard POSTs the text to `/api/dm/import`, so the grammar it accepts can't be read. Limitless Docs says TCG Live exports and Limitless's own export both work, and that English Trainer and Energy lines resolve by name alone. Its tolerance beyond that is **unconfirmed**. I didn't send test lists to it.

## Pokémon TCG Online export (retired in 2023, still in old posts)

**Evidence.**
- A verbatim export in [SeniorProjectPTCG/Vulpix `deck.txt`][sp-deck] (committed 2019), with CRLF line endings stored in the blob.
- A theme deck in [`decklists/THEME_TEU_Torrential_Cannon.txt`][sp-teu], with LF.
- The [PTCGO-Deck-Helper importer][dz] parses the same markers.

```
****** Pokémon Trading Card Game Deck List ******

##Pokémon - 20

* 4 Zorua SLG 52
…

##Trainer Cards - 33

* 4 N PR-BLW BW100
…

##Energy - 7

* 3 Grass Energy GRI 167
* 4 Double Colorless Energy GRI 166

Total Cards - 60

****** Deck List Generated by the Pokémon TCG Online www.pokemon.com/TCGO ******
```

- **Headers** are `##Pokémon - N`, `##Trainer Cards - N` and `##Energy - N`, where N is the number of **cards**. A blank line comes before and after each header.
- **Lines** start with `* `, followed by `qty name set number`.
- **Promo numbers keep their prefix:** `PR-SM SM62`, `PR-BLW BW100`.
- **The footer** is `Total Cards - 60`, followed by the `******` line. There is no newline after it.
- **Basic Energy** uses its real print: `Grass Energy GRI 167`. The theme deck has `* 20 Water Energy  12`, with an empty set code and two spaces. That comes from one file, so whether TCG Online always wrote theme-deck energy this way is **unconfirmed**.
- **Set codes are TCG Online's own,** for example `EVO`, `STS` and `PR-SM`. They mostly match today's codes.
- **The CRLF** suggests the Windows client wrote CRLF, but this comes from one file, so it is **unconfirmed** in general.

## Format markers

None of the three formats has a Standard or Expanded marker:
- **TCG Live:** checked in every export seen.
- **Limitless:** checked against the exporter code.
- **TCG Online:** checked in the observed exports.

Other sources only hint at a format:
- **Text around the list.** geekazoid's bot guesses `standard: !description.includes("expanded")` ([processVideo.ts][gz-process]), and lists posted with prose often carry a title such as "1st Place Archaludon ex Decklist:".
- **Set codes** suggest a format, but only by inference. For example, `PR-BLW` or anything older than SVI points to Expanded.

Inferring the Target Format would therefore mean checking legality from the cards, not reading a marker.

## What this means for the parser

- **Accept text around the list.** Pastes from YouTube, Discord or forums wrap the list in prose: a title line ending `:`, `Deckliste:`, links and emoji.
  - Recognise lines that match the card-line grammar.
  - Treat lines matching a header as section breaks.
  - Treat `Total Cards`, `Karten insgesamt` and `******` lines as noise.
  - Report anything else as unparsed, and don't fail the whole paste.
- **Normalise before matching:**
  - LF, CRLF and CR line endings;
  - a leading BOM;
  - NBSP and zero-width spaces;
  - trailing spaces;
  - repeated spaces (the TCG Online energy line has two);
  - NFC normalisation;
  - `Pokemon:` as well as `Pokémon:`;
  - an optional `* ` bullet;
  - `’` treated as `'` for the copy-paste-from-a-website case. Exports themselves use ASCII.
- **Map energy spellings onto one catalog card:** `Basic {P} Energy`, `Psychic Energy` and the `Energy 22` pseudo-set. A Basic Energy line should match by type even when its set and number don't resolve, for example `SVALT 135` or `Energy 31`.
- **Resolve set codes through an alias table:**
  - `PR-SW` = SWSH promos;
  - `PR-SV` = SVP;
  - `PR-SM` = SMP;
  - `PR-BLW` = BW promos;
  - `<SET>-TG n` / `<SET>-GG n` = subset numbers;
  - SHF/HIF flat numbering back to `SVnn`.

  Unknown ALT codes should fall back to matching by name for Trainers and Energy. Pokémon lines need confirmation instead.
- **Keep one line per print** and add up copy limits by Identity.

## Fixtures

These are decklists, which are factual data. Where a list is cut, the cut is shown with `…`.

**F1. TCG Live, English, 2024–25** ([JoseRivas1998 `gardevoir-ex.txt`][jr-gard], verbatim). It shows `PH`, `SVALT`, a colon in a name, line-count headers and the footer.

```
Pokémon: 12
1 Mimikyu PAL 97 PH
1 Cresselia LOR 74
1 Drifloon SVI 89
1 Scream Tail PAR 86
2 Munkidori TWM 95
1 Lumineon V BRS 40
4 Kirlia SIT 68
1 Mew ex MEW 151
4 Ralts SIT 67
1 Radiant Greninja ASR 46
1 Klefki SVI 96
2 Gardevoir ex SVI 86

Trainer: 18
1 Buddy-Buddy Poffin PRE 101 PH
1 Unfair Stamp TWM 165
2 Counter Catcher CIN 91
1 Nest Ball SVI 181
2 Artazon PAL 171
4 Bravery Charm PAL 173
2 Buddy-Buddy Poffin TEF 144 PH
2 Boss's Orders PAL 172
3 Iono PAL 185
2 Arven SVI 166
1 Professor Turo's Scenario PAR 171
1 Technical Machine: Evolution PAR 178
1 Super Rod PAL 188
1 Crispin SCR 133
1 Professor's Research CEL 24
2 Ultra Ball SVI 196
2 Rare Candy SVI 191
2 Earthen Vessel PAR 163

Energy: 4
1 Basic {D} Energy SVALT 137
1 Basic {P} Energy SVALT 135
1 Basic {D} Energy SVE 15
6 Basic {P} Energy SVE 13

Total Cards: 60
```

**F2. TCG Live, German client, pasted in a YouTube description** ([geekazoid `description1.txt`][gz-d1], cut). It shows localised headers, surrounding prose, `PR-SW` and repeated prints.

```
Deckliste:
Pokémon: 13
1 Noivern ex PAF 220
1 Fezandipiti ex SFA 92
3 Regidrago VSTAR SIT 136
1 Regidrago V PR-SW 281
…
1 Haxorus SFA 46 PH
…

Trainer: 17
…
1 Nest Ball SVI 255
…
3 Nest Ball SVI 181
…

Energie: 2
7 Basic {G} Energy SVE 1
3 Basic {R} Energy OBF 230

Karten insgesamt: 60
```

**F3. Limitless deck page, 2026 Regionals** (Dragapult, [/decks/list/29678][l-29678]). This is what Copy to Clipboard produces, obtained by running a faithful port of `decklist-11f9e903.js` over the page's HTML rather than by capturing the clipboard. It shows card-count headers, Basic Energy named `Fire Energy` and no footer.

```
Pokémon: 19
4 Dreepy TWM 128
4 Drakloak TWM 129
3 Dragapult ex TWM 130
2 Munkidori TWM 95
2 Budew ASC 16
1 Dunsparce TEF 128
1 Dudunsparce TEF 129
1 Meowth ex POR 62
1 Fezandipiti ex ASC 142

Trainer: 32
4 Lillie's Determination MEG 119
3 Boss's Orders MEG 114
2 Crispin SCR 133
1 Rosa's Encouragement POR 84
1 Judge POR 76
4 Buddy-Buddy Poffin TEF 144
4 Poké Pad POR 81
4 Crushing Hammer POR 71
3 Ultra Ball MEG 131
3 Night Stretcher ASC 196
1 Unfair Stamp TWM 165
2 Risky Ruins MEG 127

Energy: 9
3 Fire Energy MEE 10
3 Psychic Energy MEE 13
3 Darkness Energy MEE 15
```

**F4. Limitless deck page, Sun & Moon era** (Ultra Malamar, Champions League Chiba, [/decks/list/2000][l-2000], produced the same way, cut). It shows the `Energy N` pseudo-set, a Limitless-native `SMP` promo and a `&` tag-team name.

```
Pokémon: 19
4 Inkay FLI 50
…
1 Gengar & Mimikyu-GX TEU 53
1 Tapu Lele-GX GRI 60
1 Tapu Koko SMP 30

Trainer: 31
4 Lillie UPR 125
…
1 Pokémon Communication TEU 152
…

Energy: 10
7 Psychic Energy Energy 31
3 Metal Energy Energy 34
```

**F5. Limitless deck page, NAIC 2023** (Lugia Archeops, [/decks/list/8000][l-8000], produced the same way, cut). It shows `SP` mapped to `PR-SW`, and an Energy section with Special Energy only.

```
Trainer: 28
4 Professor's Research SVI 189
…
1 Professor Burnet PR-SW 167
…

Energy: 13
4 Single Strike Energy BST 141
3 Double Turbo Energy BRS 151
3 Gift Energy LOR 171
2 V Guard Energy SIT 169
1 Jet Energy PAL 190
```

**F6. A Limitless export pasted by a creator** ([geekazoid `description3.txt`][gz-d3], cut). It shows that real pastes mix with prose, plus `Psychic Energy SVE 13` naming and a card-count header with no footer.

```
BUY THE CHARIZARD LEAGUE BATTLE DECK FROM AMAZON (affiliate link): https://amzn.to/…

Pokémon: 22
4 Hoothoot SCR 114
…
1 Lillie's Clefairy ex JTG 56
…

Energy: 9
3 Water Energy SVE 11
2 Fire Energy SVE 10
2 Lightning Energy SVE 12
2 Psychic Energy SVE 13
```

**F7. TCG Online, Expanded, 2019** ([Vulpix `deck.txt`][sp-deck], verbatim; CRLF in the original). It shows `* ` bullets, `##` headers, prefixed promo numbers and the footer lines.

```
****** Pokémon Trading Card Game Deck List ******

##Pokémon - 20

* 4 Zorua SLG 52
* 1 Zoroark BKT 91
* 4 Zoroark-GX SLG 53
* 1 Mr. Mime GEN 52
* 3 Wimpod BUS 16
* 2 Golisopod-GX PR-SM SM62
* 1 Tapu Koko PR-SM SM30
* 1 Mewtwo EVO 51
* 3 Tapu Lele-GX GRI 60

##Trainer Cards - 33

* 2 Professor Sycamore STS 114
* 3 Acerola BUS 142
* 4 N PR-BLW BW100
* 4 Puzzle of Time BKP 109
* 4 Ultra Ball SUM 161
* 4 Guzma BUS 143
* 3 Brigette BKT 161
* 2 Choice Band BUS 162
* 4 Field Blower GRI 163
* 1 Mallow GRI 145
* 2 Enhanced Hammer GRI 162

##Energy - 7

* 3 Grass Energy GRI 167
* 4 Double Colorless Energy GRI 166

Total Cards - 60

****** Deck List Generated by the Pokémon TCG Online www.pokemon.com/TCGO ******
```

**F8. TCG Online theme deck** ([Vulpix `THEME_TEU_Torrential_Cannon.txt`][sp-teu], cut). It shows an apostrophe in a Pokémon name and Basic Energy with an empty set code.

```
##Pokémon - 22

* 3 Farfetch'd TEU 127
…

##Energy - 20

* 20 Water Energy  12

Total Cards - 60
```

**F9. Edge lines from TCG Live-shaped lists** (geekazoid, normalised by its bot, so use these as single-line cases, not whole lists):

```
1 Thunder Mountain {*} LOT 191
4 Speed {L} Energy RCL 173
2 Bibarel CRZ-GG 25
1 Mimikyu PR-SV 75
1 Psyduck MEP 7
6 Basic {L} Energy GEN 78 PH
```

## Not confirmed

- Whether the TCG Live header ever counts cards instead of lines, and whether that differs by version or platform.
- Whether TCG Live uses CRLF on Windows, and whether it adds a trailing newline.
- What `PH` means, and what `SVALT` numbers map to. Whether other `…ALT` codes exist beyond `SWSHALT`.
- What other TCG Live client languages write in their headers (only German was seen).
- A clean raw TCG Live `LOR-TG`/`SIT-TG` line, and whether TCG Live zero-pads subset numbers.
- Which variations Limitless's server-side import accepts.
- How TCG Online wrote theme-deck energy in general (only one file shows `Water Energy  12`).

[ldocs]: https://docs.limitlesstcg.com/player/decklists
[rk9]: https://support.rk9.gg/kb/article/18-how-to-import-a-deck-list-from-pokemon-tcg-live/
[jr]: https://github.com/JoseRivas1998/pokemon-decklists
[jr-gard]: https://github.com/JoseRivas1998/pokemon-decklists/blob/main/gardevoir-ex.txt
[gz]: https://github.com/geekazoid-at/codes4tcg-decks
[gz-test]: https://github.com/geekazoid-at/codes4tcg-decks/tree/master/youtubeBot/src/test
[gz-d1]: https://github.com/geekazoid-at/codes4tcg-decks/blob/master/youtubeBot/src/test/description1.txt
[gz-d2]: https://github.com/geekazoid-at/codes4tcg-decks/blob/master/youtubeBot/src/test/description2.txt
[gz-d3]: https://github.com/geekazoid-at/codes4tcg-decks/blob/master/youtubeBot/src/test/description3.txt
[gz-transform]: https://github.com/geekazoid-at/codes4tcg-decks/blob/master/youtubeBot/src/utils/deckTransformer.ts
[gz-process]: https://github.com/geekazoid-at/codes4tcg-decks/blob/master/youtubeBot/src/processVideo.ts
[shut]: https://github.com/Shutterst0ck/SUM-on_TCGLive_Expanded
[l-js]: https://limitlesstcg.com/build/assets/decklist-11f9e903.js
[lb-js]: https://my.limitlesstcg.com/_app/immutable/chunks/CJkcgh53.js
[l-29678]: https://limitlesstcg.com/decks/list/29678
[l-2000]: https://limitlesstcg.com/decks/list/2000
[l-8000]: https://limitlesstcg.com/decks/list/8000
[l-tg]: https://limitlesstcg.com/cards/LOR/TG1
[sp-deck]: https://github.com/SeniorProjectPTCG/Vulpix/blob/master/deck.txt
[sp-teu]: https://github.com/SeniorProjectPTCG/Vulpix/blob/master/decklists/THEME_TEU_Torrential_Cannon.txt
[dz]: https://github.com/Dillonzer/PTCGO-Deck-Helper/blob/main/src/PTCGO-Deck-Helper.DeckImporter/Importer.cs
