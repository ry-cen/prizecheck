# Export metadata provenance and correction paths

Research date: 2026-10-08. This is bounded source and repository inspection for [ticket 24](../tickets/24-decide-export-metadata-contract.md), not a product decision, mapping verification, importer test, or implementation.

## Findings

### What TCGdex documents

TCGdex's current [TCG Live integration page](https://tcgdex.dev/tcg-live) calls its API card data for Live applications and says it covers the physical card pool (lines 88–100, 141–147). It presents ordinary card/set retrieval by TCGdex IDs; it does not document an importer-specific Live card ID or a clipboard/export mapping (lines 153–180). The page's broad claim of Live availability is TCGdex's description of its coverage, not Pokémon's guarantee that every returned physical record has a legal/current in-game representation.

The [Card object reference](https://tcgdex.dev/reference/card) documents common fields `id`, `localId`, `name`, `category`, `set`, and `variants`; `category` values are `Pokemon`, `Energy`, or `Trainer` (lines 114–128). It documents Energy subtype separately (`Basic` or `Special`, lines 238–256). The [Set object reference](https://tcgdex.dev/reference/set) documents `tcgOnline` as the “Pokémon TCG Online Set code” and nullable (lines 74–98). The reference does not label this field as a TCG Live code. The same Set example uses TCGdex `id: swsh3`, while the corresponding card response uses `localId: 136` and nested set data, establishing the source record's own set/local-number pair; it does not establish that `swsh3` is an export abbreviation.

The official [set/card REST example](https://tcgdex.dev/rest/set-card) shows lookup by TCGdex set ID and local ID, and a full response with `category`, `id`, `localId`, `name`, and `set` (lines 73–150). Current repository fixtures include three bounded English API records: special-art Charizard `sv03-223`, promo Pikachu `svp-085`, and Fire Energy `base1-98`. Those fixtures show ordinary source category, local number and set IDs, plus detailed physical variant descriptors. They contain no `tcgLive` field. That absence is only observed in those samples; the cited schema's lack of a documented Live ID is not proof that no future/other payload contains one. [Fixture](remaining-price-fixtures.json)

### What can and cannot be derived

| Export fact | Evidence-backed automatic derivation | Remaining verification |
|---|---|---|
| Live group/category | `category` directly supplies Pokémon, Trainer, or Energy in the documented schema. | The local normalized catalog currently does not expose/store this category as an export field; mapping source category to the formatter's exact heading is deterministic, subject to accepted serializer policy. |
| Display name | TCGdex `name` is documented as the official card name. | A reviewed/manual Printing or correction may intentionally preserve a different effective name; export must follow accepted identity/display policy. |
| Printed collector number | `localId` is documented as card number within its set and becomes local `collector_number`. | This does not determine Live's identifier for promo/ALT or subset cases. Do not drop leading zeros or reformat special numbers without a known rule. |
| Live set code | `tcgOnline` is available on Set and explicitly means the *Online* set code. | Its name does not verify current Live acceptance. A Live abbreviation, special promo code, subset prefix, promo/ALT ID, or Energy numbering transform needs a trusted explicit crosswalk or review. Do not infer from TCGdex set ID, name, or `tcgOnline` alone. |
| PTCGL ALT/promo identity | The API schema and sampled records establish source card/set/local IDs and promo rarity in one sample. | They do not provide evidence that a catalog printing maps to an ALT game identifier or that a printed identity can be rewritten to it. Limitless's warning is parser-specific and does not create an authoritative PTCGL crosswalk. |
| TCGplayer product | Source `thirdParty.tcgplayer` / nested quote product references are available in raw records and existing price fixtures. | A product ID is a marketplace pointer, not proof of exact physical finish/printing. TCGplayer itself tells users to verify the catalog version and set/foil details (official [individual product listing guidance](https://help.tcgplayer.com/hc/en-us/articles/201574827-How-do-I-list-individual-products); [scanner accuracy guidance](https://help.tcgplayer.com/hc/en-us/articles/115009674788-Tips-for-Accurate-Scanning)). Mapping verification requires evidence for the exact TCGplayer product/version; product ID presence alone is insufficient. |

Evidence from the official API is suitable for deterministic ordinary fields where the source field directly expresses the target fact. It does not settle destination-specific compatibility. In particular, ticket 19 requires unresolved Live rows to block a complete Live export and requires complete Mass Entry text when any product mapping is unavailable; ticket 23 says a changed/conflicting marketplace mapping becomes unverified and stops quote/product-link use, independently of any verified Live identifier. Those accepted constraints should govern unresolved provenance, but they do not select a storage or correction mechanism.

### Current repository path and ownership

`api/app/catalog.py` fetches each full source record, normalizes `id`, set ID/name, `localId`, name, variants and basic-Energy classification (lines 97–132). It uses `category` and `energyType` transiently to classify basic Energy (lines 115–125), but does not include category or `tcgOnline` in the normalized result. A full raw record is gzip-serialized into `catalog_generation.raw_gzip` during promotion (lines 205–214); this establishes retained source data, not a purpose-built query, durable crosswalk, or confirmation that a particular metadata field has been retained in every historical generation.

The current catalog search exposes source references and catalog overrides, while the current review surface is specifically physical/catalog reconciliation. `GET /api/admin/catalog-reviews` calls `require_owner` and returns pending catalog reviews; its decision API covers source matching and Printing/Edition keep/deprecate corrections ([`catalog_reconciliation.py`](../../../../api/app/catalog_reconciliation.py#L14), lines 53–79 and 80–124). Review rows are constrained to `name_change` and `variant_ambiguity` in the initial schema ([`003_catalog.sql`](../../../../migrations/003_catalog.sql#L82)). Catalog status presents pending reviews in owner controls ([`main.py`](../../../../api/app/main.py#L146)). Missing-card reports and manual Catalog Overrides also feed reviewed catalog correction; their existing purpose is to add/approve physical catalog records, not target export metadata ([`missing_cards.py`](../../../../api/app/missing_cards.py#L220), lines 220–278). There is no current mapping-specific report/override or target-specific verification state identified in these entry points.

Thus the existing patterns offer possible UI/authorization precedent, but they do not establish which person should own export mapping review. Ticket 23 explicitly characterizes marketplace mapping verification as catalog-maintainer correction, not manual price refresh by a deck owner or site operator. Ticket 24 still needs the owner's policy on whether the same catalog maintainer owns Live and marketplace crosswalks, and whether a collector may only flag a missing/disputed mapping. No manual price-refresh feature is part of this research or implied by these review paths.

### Existing format and compatibility evidence

The existing [deck export research](deck-export-formats.md) inspected Limitless's first-party formatter and documented its category headings plus `quantity name SET number` row shape. Limitless's [ALT card guidance](https://docs.limitlesstcg.com/player/decklists.html#ptcgl-alt-cards) warns about parser behavior for game-only IDs. This is useful compatibility evidence for that third-party formatter/parser, not official Pokémon import grammar or proof that a given source record maps to an accepted Live row. No actual PTCGL importer test was performed here.

The existing [TCGplayer Mass Entry guidance](https://help.tcgplayer.com/hc/en-us/articles/360055768913-Getting-Started-With-Mass-Entry), recorded in the export research, documents name/set/number text matching and its specificity tradeoffs. TCGplayer's current help further tells catalog users to verify product version and printing attributes. Use of an observed product ID must therefore remain gated by a verified mapping, as ticket 23 requires; a URL or ID that resolves is not sufficient exact-finish evidence.

## Decision inputs and unresolved questions

- Does a source field's direct fact (`category`, official name, `localId`) count as sufficient ordinary Live metadata after it is retained in a versioned export projection, with only the target group serialization requiring product verification?
- Which source and evidence establish Live set-code abbreviations and exception mappings for `tcgOnline` sets, promos, ALT identifiers, subsets, and Energy numbering? Are any records to remain blocked until a maintainer records an explicit target mapping?
- What review evidence is sufficient for a TCGplayer product mapping: current official catalog/product page showing product name, set, number, language and version/finish, with a second source fact where the source metadata is ambiguous?
- Should collectors be allowed to file mapping disputes while only catalog maintainers can approve mappings? Which existing owner-only review/override concepts, if any, are appropriate to reuse without conflating physical corrections, export targets, prices, or public snapshots?
- How should approved mappings for fixed Published Deck snapshots remain usable, and what evidence change invalidates them? The current repository research confirms publications freeze card content, but this ticket's storage/versioning mechanism remains open.

## Evidence classification and limits

- **Documented:** Current TCGdex reference fields and definitions; TCGdex's Live integration page claims coverage and describes generic card/set retrieval; TCGplayer product guidance asks users to verify the product version/attributes.
- **Observed locally:** Three existing bounded TCGdex fixtures have category, set ID and local number; the normalizer omits category and `tcgOnline`; raw catalog generation payloads are gzip retained; current catalog-review routes address physical source/Printing/Edition corrections.
- **Inferred:** Category/name/localId can provide ordinary export fields once the accepted target mapping treats them as direct facts. A distinct explicit crosswalk is needed where destination codes or IDs transform those facts.
- **Unverified:** Any universal equivalence of `tcgOnline` with Live codes; PTCGL import acceptance for Limitless's complete format or special mappings; any exact TCGdex-to-TCGplayer physical finish relation based solely on product ID; correct target mapping for the sampled promo; who the owner selects as export-mapping reviewer; and actual importer interoperability.

No catalog was downloaded beyond the already captured fixture. No application, browser, clipboard, database, importer, or destination-marketplace state was accessed. No importer tests are claimed.

## Follow-up — Limitless formatter rules (2026-10-08)

The owner clarified that Live identifiers should be deduced from Printing/Card Edition metadata and deterministic rules, without per-card stored mapping. The prior source inspection recorded in [deck export format research](deck-export-formats.md) found the Limitless formatter helper at [`decklist-11f9e903.js`](https://limitlesstcg.com/build/assets/decklist-11f9e903.js) to be rule-table driven. For the mapping helper, the required ordinary inputs are set code and collector number; the row serializer additionally needs quantity and name, while section headings come from the card category/group. The source inspection recorded these explicit branches:

- Set code `SP` becomes `PR-SW`; `SVP` becomes `PR-SV`.
- Number patterns for `RC`, `TG`, and `GG` render with the set prefix (example: `SWSH-TG 5`).
- Energy numbering uses set-specific lookup tables for `SUM`, `TEU`, `SSH`, and `BRS`.
- `HIF` and `SHF` numbers beginning with `SV` receive set-specific offsets.
- Other inspected ordinary rows preserve `SET number`.

These branches demonstrate that the listed Limitless behaviors can be computed from a trusted set code, collector number, and fixed rule tables; they do not require a persisted per-card crosswalk. They do require those input values to be present and trusted, and any unknown/unhandled pattern remains unresolved rather than becoming a guessed mapping. This is a claim about Limitless's inspected helper behavior, not a finding that Pokémon publishes these transformation rules or guarantees importer acceptance.

**Current-inspection limitation:** a fresh web fetch of the known JS asset returned an error (`400 OK`), direct shell access had no network resolution, and the accessible deck-page rendering did not expose the asset contents. Thus this follow-up relies on the earlier first-party source inspection recorded in `deck-export-formats.md`; it does not claim that the asset hash or implementation was revalidated against a fresh response today. The current deck page is [Gholdengo by Cody Graham](https://limitlesstcg.com/decks/list/17168), and the known inspected asset URL is linked above.

ALT remains distinct from these printed set/number normalization branches. Limitless's [ALT guidance](https://docs.limitlesstcg.com/player/decklists.html#ptcgl-alt-cards) describes certain Live-exported promo rows using game-only identifiers and its parser's failure modes; that evidence does not provide an input rule translating a physical Edition's set/collector number to every such ALT ID. The formatter's printed metadata rules therefore do not establish ALT derivability from physical Edition descriptors alone. Whether to handle ALT through a maintained set/number rule table, source metadata, or unresolved status remains open. No actual PTCGL import was attempted.
