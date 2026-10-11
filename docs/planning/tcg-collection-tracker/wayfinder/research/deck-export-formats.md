# Deck export formats: Pokémon TCG Live and TCGplayer Mass Entry

Research date: 2026-10-08

## Findings

### Pokémon TCG Live text export

**Documented by Pokémon:** Pokémon Support says saved Pokémon TCG Online deck lists could be exported as text, saved locally, then pasted into the Pokémon TCG Live Deck Editor. The support article confirms the text-import workflow, but gives no grammar, field rules, or exact export sample. [Pokémon Support: Migration FAQ](https://support.pokemon.com/hc/en-us/articles/6489934466708-Pok%C3%A9mon-TCG-Live-Migration-FAQ-from-the-Pok%C3%A9mon-TCG-Online)

**Documented by Limitless:** Limitless's decklist submission documentation says TCG Live's Deck Manager `Export` action copies the list to clipboard. It recommends `Share > Copy as Text` for its own Deck Builder. This makes the actual PTCGL export the best compatibility target, rather than inventing a format from the support article. [Limitless: Decklist Submission](https://docs.limitlesstcg.com/player/decklists.html)

**Observed Limitless rendered deck list:** A main-site deck page renders three groups, `Pokémon (14)`, `Trainer (34)`, and `Energy (12)`, with visible rows such as `4 Gimmighoul`, `4 Arven`, and `3 Metal Energy`. This is HTML presentation with card links/prices, not evidence of the clipboard payload grammar. A separate tournament page renders Pokémon print identities in parentheses, such as `2 Gimmighoul (SSP-97)`; those parentheses are also UI presentation and must not be described as TCG Live clipboard syntax. [Limitless main-site deck](https://limitlesstcg.com/decks/list/17168) [Limitless tournament deck](https://play.limitlesstcg.com/tournament/6962bda3ba66621ba08b937b/player/saitam365/decklist)

**Verified clipboard formatter from first-party source:** The main-site page marks its button `data-export` and loads `/build/assets/decklist-11f9e903.js`. The formatter reads each displayed column heading and rewrites `Category (count)` to `Category: count`, then writes each row as `count name formatted-set-and-number`, adds a blank line after each category, trims the output, and calls `navigator.clipboard.writeText(...)`. The format can therefore be reproduced from the inspected first-party code without running it. [Limitless deck page HTML](https://limitlesstcg.com/decks/list/17168) [Limitless decklist formatter JS](https://limitlesstcg.com/build/assets/decklist-11f9e903.js)

For the inspected deck, first lines are `Pokémon: 14`, `4 Gimmighoul SSP 97`, `4 Gholdengo ex PAR 139`, then a blank line and `Trainer: 34`. Thus, for ordinary printings, actual clipboard syntax is `quantity name SET number`; the parentheses in the tournament page were only rendered UI syntax. Every row includes a set and number, including Trainer/Energy. Punctuation is copied from card-name text content without formatter normalization (e.g. `Pokégear 3.0`, `Technical Machine: Evolution`). Source emits no `Total Cards:` line. It does not append a newline after the final category because it trims the composed text.

The formatter helper also has explicit set-specific cases: alternate promo sets `SP` and `SVP` map to `PR-SW` and `PR-SV`; special subsets matching `RC`, `TG`, or `GG` numbers render as `SET-prefix number` (e.g. `SWSH-TG 5`); special energy numbering has lookup tables for SUM/TEU/SSH/BRS; HIF/SHF numbers beginning `SV` get offsets. These are Limitless's export conventions inferred directly from its helper, not an official Pokémon grammar. [Limitless formatter JS](https://limitlesstcg.com/build/assets/decklist-11f9e903.js)

**Safe implementation guidance:** this confirms the requested Limitless-style clipboard output, but does not establish that every PTCGL version accepts all Limitless mappings or the same optional categories. Preserve catalog print identity and card name, use Live-compatible set code/collector number for ordinary rows, and test special promo/subset/energy cases against the actual importer. Limitless's parser warning about PTCGL ALT IDs remains relevant: [Limitless: PTCGL ALT Cards](https://docs.limitlesstcg.com/player/decklists.html#ptcgl-alt-cards)

**Promo/ALT caveat (documented by Limitless):** PTCGL may export some promo variants using game-only identifiers such as `SWSHALT 127`, rather than printed identity `BRS 132`. Limitless warns not to manually rewrite those identifiers: its parser may fail to find the card or interpret a manual correction incorrectly. For English Trainer/Energy, removing the ALT code and number may let Limitless identify the card by name; Pokémon and non-English cards need proper set code and number. This is Limitless parser behavior, not an official Pokémon format guarantee. [Limitless: PTCGL ALT Cards](https://docs.limitlesstcg.com/player/decklists.html#ptcgl-alt-cards)

**Implication:** keep both internal card/printing identity and display name available. For Live export, emit stable set/card number when known and retain true card names/diacritics. Promos whose PTCGL ALT identity differs from the printed/catalog identity remain an unresolved compatibility case; do not silently substitute another printing.

### TCGplayer Mass Entry

**Documented by TCGplayer:** Mass Entry processes each line independently, with documented grammar `quantity card name [set code] [card number]`. TCGplayer's example is `1 Lightning Bolt [SLD] 84`. Omitting number permits any art from the selected set; omitting both set and number permits any set matching the name. Preferences control acceptable printings and condition. [TCGplayer Help: Getting Started With Mass Entry](https://help.tcgplayer.com/hc/en-us/articles/360055768913-Getting-Started-With-Mass-Entry)

**Observed Limitless purchase URL contract:** On the Limitless main-site deck page, the deck-total affiliate link resolves to `partner.tcgplayer.com/LIMITLESS?u=<encoded destination>`. Decoding its destination gives `https://www.tcgplayer.com/massentry?productline=Pokemon&c=4-589955||4-523818||1-589954...`, where each segment is `quantity-TCGplayerProductId`, with `||` between products. This is a product-ID list and differs from TCGplayer's documented typed text grammar. The same page's card-level TCGplayer price links are separate per-card links. [Limitless main-site deck](https://limitlesstcg.com/decks/list/17168) [Observed resolved affiliate destination](https://partner.tcgplayer.com/LIMITLESS?u=https%3A%2F%2Fwww.tcgplayer.com%2Fmassentry%3Fproductline%3DPokemon%26c%3D4-589955%7C%7C4-523818%7C%7C1-589954%7C%7C1-623525%7C%7C1-623524%7C%7C1-560348%7C%7C1-550139%7C%7C1-523666%7C%7C4-509778%7C%7C2-542660%7C%7C2-523852%7C%7C2-497544%7C%7C1-497557%7C%7C4-542659%7C%7C4-497562%7C%7C2-488087%7C%7C2-560372%7C%7C1-488105%7C%7C1-497560%7C%7C1-523841%7C%7C1-488102%7C%7C1-523844%7C%7C1-589933%7C%7C2-523859%7C%7C1-542677%7C%7C1-623577%7C%7C1-550197%7C%7C3-475432%7C%7C2-475428%7C%7C2-475431%7C%7C1-475425%7C%7C1-475426%7C%7C1-475427%7C%7C1-475429%7C%7C1-475430)

The exact `quantity-productId` Mass Entry link shape is directly observed in Limitless's href via its affiliate redirect; the redirect itself could not be opened in the web renderer (cache miss), but its full destination URL was shown in the link target. Treat product-ID linking as observed Limitless integration behavior, not a TCGplayer-documented stable API. For a project without TCGplayer product IDs, the typed text format documented above remains a less exact fallback, with its matching caveats.

**Matching guarantee:** specificity in the text narrows the request, but name-only or set-only inputs deliberately allow alternatives. The user must still review what Mass Entry resolves, especially where multiple printings, language variants, promos, or products share a name. TCGplayer defaults to all printings and Moderately Played or better; those defaults affect cart matching and can make a resulting cart differ from an exact desired deck. The feature must not claim that opening the link creates an exact-printing cart without user review.

**Recommended generated content:** readable Mass Entry text uses one card per line, quantity first, canonical card name, then `[TCGplayer set code] collector number` only when a verified mapping exists. The app's own set code must not be assumed identical to TCGplayer's set code. Name-only rows are a less-specific fallback. The observed deep link uses quantity/product-ID segments; retain copyable typed text when exact product IDs or a working link are unavailable. A text-prefill URL is unverified and must not be inferred from the documented manual-input grammar.

## Alternatives and tradeoffs

| Target | Strength | Limitation |
|---|---|---|
| Pokémon TCG Live text | Familiar import into game; official support confirms text paste into Deck Editor. | Pokémon's support docs do not define syntax; set/number and promo edge cases vary. |
| TCGplayer Mass Entry link | Convenient path from deck to vendor's list/cart; vendor documents line-level name/set/number matching. | Site URL parameter is observed, not formally documented; matching and printings depend on available data/preferences and require review. |

Limitless's documentation describes workflows and ALT limitations; subsequent first-party source inspection established its formatter. Its rendered deck view alone would not establish that payload. [Limitless docs](https://docs.limitlesstcg.com/player/decklists.html) [observed main-site page](https://limitlesstcg.com/decks/list/17168)

## Unresolved questions for product/spec

- Should the app's default clipboard action be Pokémon TCG Live text (as requested by the user, modeled on Limitless), with TCGplayer Mass Entry as a separate export action?
- Which price source and condition/printing should inform deck cost? A price for one card identity can vary substantially by printing and condition; deck-level cost needs an explicit policy (for example lowest available printing vs selected printing).
- Which catalog fields map to official Live set codes/numbers and TCGplayer set codes/numbers, particularly promos and alternate arts? Current export cannot promise exact physical printing unless this crosswalk exists.
- Does the current PTCGL importer accept Limitless's category headers and every special set-number mapping? The Limitless formatter is now established, but Pokémon does not document its grammar and acceptance was not tested in-game.
- Does Limitless server-render empty categories? Its client formatter will emit a heading for each `.decklist-column` present, even if it has no cards; whether empty columns are rendered was not established. Its payload has no title or `Total Cards:` line.
- Limitless's observed Mass Entry query uses product IDs, while TCGplayer help documents typed text but not this query parameter. Treat product-ID URL behavior as best-effort and keep readable/exportable text as fallback.

## Evidence classification and limits

- **Documented:** Pokémon support endorses exporting text and pasting it in Live; Limitless documents PTCGL's Export workflow and its own ALT parsing caveat; TCGplayer defines Mass Entry line syntax and matching specificity/preferences.
- **Observed/source-inspected:** Limitless's first-party formatter writes `Category: count`, `quantity name SET number`, and blank lines between its rendered columns to the clipboard; no total-card line. Main-site deck-total affiliate href contains a `productline=Pokemon` Mass Entry destination with `c=quantity-productId||...` values.
- **Inferred:** matching TCGplayer lines to exact desired printings requires catalog crosswalk; safest Live output follows Limitless/actual PTCGL text shape; omit empty sections absent evidence of parser requirements.
- **Not verified:** official PTCGL grammar, whether PTCGL accepts empty sections or all Limitless special mappings, exact acceptance of ALT IDs, empty-column server rendering, or permanent stability of TCGplayer's query URL.
