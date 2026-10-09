# Investigate Live clipboard and TCGplayer Mass Entry contracts

**Parent:** [Card prices and Deck exports — decision map](../card-prices-and-deck-exports-map.md)

**Label:** wayfinder:research

**Status:** closed

**Assignee:** export_research

**Blocked by:** None.

**Research:** [Deck export formats](../research/deck-export-formats.md)

**Resolution:** [Destination contracts and remaining compatibility evidence](../resolutions/17-investigate-deck-export-formats.md)

## Question

What actual plain-text clipboard payload does the main Limitless TCG site's Copy to Clipboard action produce, and what does Pokémon's first-party support establish about Live import? What TCGplayer Mass Entry line grammar and URL/query shape are documented or observed? Separate visible website deck rendering from raw export syntax; capture category headings/counts, set codes, numbers, special names, Energy/promos/ALT edge cases, encoding and any footer. Determine which details and destination behaviors still require direct compatibility verification.

## Comments

Claimed by the primary on behalf of the bounded export researcher. First pass found official text-import guidance, Limitless ALT caveats, and TCGplayer line grammar, but only a rendered tournament list rather than the raw main-site clipboard payload. The primary requested a second evidence pass that inspected the main site and its actual TCGplayer href. Raw clipboard capture was unavailable because the enabled computer-use surface reported a locked Mac. The documentation/link investigation is closed with that limitation retained in [live price and export fixtures](21-verify-price-and-export-fixtures.md); importer compatibility is not claimed. No research branch was committed or pushed because repository instructions require owner approval.

Follow-up approved read-only HTTPS source inspection verified the actual main-site clipboard formatter, including heading/row/spacing/footer behavior and special set mappings. Running the clipboard button and importing into Live remain unverified; earlier inaccessible-browser evidence is historical rather than a claim that source inspection is impossible.
