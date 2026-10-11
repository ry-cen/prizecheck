# Deck export browser comparison

Observed on 2026-10-08 in the Codex in-app browser on macOS. The owner authorized replacing the clipboard with the public reference list and requested comparison with a similar Limitless deck in place of opening the locked native Pokémon TCG Live client. [Planning evidence scope](../../../../adr/0005-deck-export-planning-evidence.md).

## Similar public Decks

Compared [Gholdengo by Cody Graham](https://limitlesstcg.com/decks/list/17168) with [Gholdengo by Armando Cervantes](https://limitlesstcg.com/decks/list/17105), using their rendered English card rows. The comparison was found through the reference tournament's Gholdengo entries. Both contain 14 Pokémon, 34 Trainer cards and 12 Energy cards: 60 copies each. The reference has 35 distinct rows; the comparison has 33. Both share the four Gimmighoul/four Gholdengo ex core, and the same Basic Energy quantities with a different row order. The lists differ in Pokémon choices and Trainer quantities; they are similar references, not identical Decks.

The [previously inspected first-party formatter](https://limitlesstcg.com/build/assets/decklist-11f9e903.js) transforms these DOM rows into category-count headings, quantity/name/set/number lines and blank lines. These two examples use ordinary set/number paths; neither exercises its promo/subset remapping branches. Card names include apostrophes, a colon and an accented character. Examples reconstructed from the observed rows and formatter are:

```text
Pokémon: 14
4 Gimmighoul SSP 97
4 Gholdengo ex PAR 139
```

```text
2 Pokégear 3.0 SVI 186
2 Technical Machine: Evolution PAR 178
```

```text
Energy: 12
3 Metal Energy SVE 8
```

These are source-reconstructed excerpts, not raw clipboard captures or importer results. Complete rendered rows are saved in [browser fixtures](deck-export-browser-fixtures.json), and complete reconstructed text examples are [reference](limitless-reference-reconstructed.txt) and [comparison](limitless-comparison-reconstructed.txt).

## Clipboard observation

After the owner's explicit permission, the reference deck's **Copy to Clipboard** button changed to **Copied!**. The supported browser clipboard `readText()` returned an empty string and `read()` returned no items. This establishes the observed site success indicator; it does not establish the actual clipboard bytes. No pre-existing clipboard content was read. The earlier automatic approval review rejected clipboard reading/overwriting due to possible private content access or loss; the subsequent explicit overwrite permission allowed the Copy action.

## TCGplayer destination observation

Decoded the reference deck's total-price affiliate href and opened its actual `https://www.tcgplayer.com/massentry?productline=Pokemon&c=quantity-productId||...` destination. The visible Mass Entry page selected Pokemon and prefilled **all 35 quantity/product-ID rows**, representing **60 copies**, with no observed omission. The full href and destination are retained in the [browser fixture](deck-export-browser-fixtures.json). [Screenshot proof](tcgplayer-mass-entry-prefill.jpg).

Observed options included all shown printings and Near Mint, Lightly Played and Moderately Played. After the options panel was dismissed, the editor displayed resolved readable card names/set/number labels in place of the raw ID segments. All 35 named rows still represented 60 copies; these rows are also saved in the browser fixture and shown in the screenshot. No cart submission or purchase occurred. Readable prefill does not prove exact physical finish/condition, that a cart can be completed, or that this undocumented URL contract will remain stable. No oversized URL, text-prefill URL or malformed-input test was performed.

## Handoff checks

- Import generated complete text into an authorized Pokémon TCG Live client, confirming quantities and identities for ordinary rows, accented/punctuated names, Energy, promos/ALT/subsets and unsupported cards. Compare the client's own exported text where possible. Test incomplete metadata and supported non-60-card behavior without silently dropping copies.
- Verify each physical Edition-to-marketplace mapping against product/finish information; product IDs and successful prefill alone do not establish finish or condition.
- Exercise complete manual Mass Entry text, unresolved mappings and an oversized-link fallback during implementation. Keep the complete text available and require buyer review of resolved products/preferences.

These checks remain unverified. This note completes the owner's selected planning comparison, not destination compatibility acceptance.
