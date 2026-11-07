# Riftbound catalog compatibility acceptance

**Status:** proposed 2026-11-07, from `dev` at `434f5b7a`, for [#534](https://github.com/ry-cen/prizecheck/issues/534). Specification only. It contains no fixture data, ingestion code, migrations or real card data, and it authorizes none of them. Companion to the [backend readiness plan](backend-readiness.md), where running these cases is items R12a and R12c.

**Purpose.** Before any real ingestion, show on synthetic records that Riftbound-shaped catalog data can meet what shared SQL and inventory require. A failure here costs a schema decision. The same failure after ingestion could cost collectors' Holdings.

**Scope.** Riftbound as the intended second backend game, on the historical scope: TCGCSV as source, English only, no tokens, separate game data and social graphs, shared sign-in and Handles, private fixtures. Riftbound frontend, scanner and production activation are out of scope. So are the identity and migration designs, which belong to the #531 track.

**Not a second-game contract.** The [catalog data contract](catalog-data-contract.md) records what Pokémon's shared SQL consumes, and says it defines no schema for another game. These cases borrow its clauses as the bar to meet. Adopting them for Riftbound is decision D4 in the readiness plan. Where the contract is silent, a case cites a proposed clause, marked **PC**, that has no force until D4 adopts it.

**Source facts are hypotheses.** Field names and shapes come from the Riftbound spec's check of one group on 2026-10-29. That check left open other groups, promo and bundle number sharing, the multi-domain delimiter, and a `Legacy` group. A real-data difference is a reason to revise a case and record why, never a reason to weaken one silently.

## Data gate before real content

**Required before any real content ingestion, and again before any release.** Passing every case below does not pass this gate.

| Gate | Must be shown | Who decides |
| --- | --- | --- |
| Data rights | Written basis for using TCGCSV as Riftbound's catalog source, including card names, rules text, images and prices, and for the retention and display planned. | Ryan |
| Art rights | Whether images may be linked, copied or stored, and any credit required. | Ryan |
| Coverage | Every released group checked for card versus sealed separation, tokens, finishes, promo number sharing and multi-domain encoding, with counts recorded. | Ryan, on recorded evidence |

Rules for this gate:

- [ADR 0019](../../adr/0019-tcgcsv-daily-prices.md) took TCGCSV's FAQ as permission for **Pokémon pricing** and the product data and fallback art uses it names, which [ADR 0024](../../adr/0024-store-tcgplayer-art-copies.md) later changed. That is not blanket permission for Riftbound catalog or content ingestion. This document assumes no rights and makes no legal finding.
- If the gate fails, the outcome returns to Ryan. TCGCSV is not silently replaced by another source, and no fallback source is added. Choosing one is a new owner decision.
- Real data stays out of this repository, in the private fixture repository the spec names.

## How to read the cases

**Synthetic conventions.** No real card, set or domain name appears. Inputs use product IDs from `9000001`, group `900` with set ID `syn01`, a second group `901` with set ID `synp` for promos, names such as `Synthetic Unit 01`, and domains `DomainA` and `DomainB`. Field names follow the spec's TCGCSV reading: `Number`, `Card Type`, `Domain`, `Rarity` and price `subTypeName`. Art URLs use the reserved `example.invalid` host.

**Finish descriptors.** Cases write `{finish: normal}` and `{finish: foil}`. The exact Variant Descriptor shape is game-owned, but must decode as a JSON object.

**Runs on** says what each case needs:

- **Reader:** seed rows directly and call today's shared readers, as `api/tests/test_catalog_data_contract.py` does. Can run now with `source='manual'`.
- **Writer:** needs the synthetic-only normaliser and harness in readiness item R12b, which does not exist yet. The expected result is the requirement for it.
- **Red:** expected to fail under today's constraints. A red case records a known schema gap for D4, not a defect, and a red result is never a pass.

**Passing.** Reader cases must pass at R12a, and Writer cases at R12c. A failure that is only recorded does not satisfy acceptance. Red cases close as R12c says.

**Clauses** cite the contract by relation or heading, as `CDC`. `CDC join rules` is its paragraph beginning "Required Edition → Printing → Identity joins". `ADR 0019` and `CONTEXT` cite those documents. **PC** clauses are listed at the end.

## Catalog identity

| ID | Synthetic input | Expected behaviour | Clause | Runs on |
| --- | --- | --- | --- | --- |
| RB-ID-01 | Products `Synthetic Unit 01`, `… (Alternate Art)`, `… (Overnumbered)` and `… (Signature)` in `syn01`. | One Card Identity and four Card Printings. `accepts` with rule `identity` reaches every Edition of all four. | CDC `catalog_identity`: multiple Printings can share one Identity. CONTEXT Card Identity: a parenthetical is not part of the name. PC-3. | Writer |
| RB-ID-02 | Two Identities with different `identity_key` and the same `display_name`. | `accepts` with rule `identity` stays within each Identity. No name matching occurs. | CDC `catalog_identity`: uses identity ID, never name equality. | Reader |
| RB-ID-03 | A Printing with no display row and Identity name `Synthetic Unit 02`. | `card_facts` returns one entry with the Identity name and empty display strings. | CDC `catalog_printing_display`: missing row uses Identity name. | Reader |
| RB-ID-04 | Display name is the empty string. | The name stays empty. No Identity fallback is taken. | CDC `catalog_printing_display`: `coalesce`, not `nullif`. | Reader |
| RB-ID-05 | Names `Synthetic Unit: Ünit's Two // Three` and `Synthetic-Unit Four`. | `catalog_search_words` gives `synthetic unit units two three` and `synthetic unit four`. The shared key removes spaces and is never NULL. | CDC `catalog_search_words`. | Reader |
| RB-ID-06 | Product `9000001` is renamed in a later source pull. | Same Printing and Identity. Retained display is unchanged, and an owner review is queued. | CDC `catalog_printing_display`: retained display survives generation changes. PC-4. | Writer |

## Cards, sealed products and tokens

| ID | Synthetic input | Expected behaviour | Clause | Runs on |
| --- | --- | --- | --- | --- |
| RB-SCOPE-01 | Product with `Number` and `Card Type: Unit`. | One Printing. | CONTEXT Card Printing. PC-2. | Writer |
| RB-SCOPE-02 | Sealed product with neither `Number` nor `Card Type`. | No catalog row. Counted as skipped. | PC-2. | Writer |
| RB-SCOPE-03 | `Card Type: Token`, no `Number`. | No catalog row. | PC-2: no tokens. | Writer |
| RB-SCOPE-04 | `Number` present, no `Card Type`. | No catalog row, and the skip reason is recorded for the coverage gate. | PC-2. | Writer |
| RB-SCOPE-05 | A `Card Type` value that includes `Token` among others. | No catalog row. | PC-2. | Writer |

## Printing and Edition

| ID | Synthetic input | Expected behaviour | Clause | Runs on |
| --- | --- | --- | --- | --- |
| RB-PE-01 | Insert a Printing with `source='tcgcsv'` and `source_id='9000001'`. | Rejected today: `catalog_printing.source` allows only `tcgdex` and `manual`, and `source_id` must be NULL unless `source='tcgdex'`. | PC-1. Evidence `migrations/003_catalog.sql:33`, `:38`. | Red |
| RB-PE-02 | A generation row with no `basic_energy` value. | Rejected today: the column is required and Pokémon-specific. | PC-1. Evidence `migrations/003_catalog.sql:68`. | Red |
| RB-PE-03 | Pull the same product twice. | Same Printing ID, same Edition IDs, same `public_ref`. No duplicates. | CDC `catalog_printing`: immutable unique public reference. PC-3. | Writer |
| RB-PE-04 | Products `9000002` in `syn01` and `9000003` in `synp`, both `Number` `001/100`. | Two Printings. Neither replaces the other. | CONTEXT Card Printing: set and collector number. PC-3. | Writer |
| RB-PE-05 | Two products in one group with one `Number`. | The run is refused for review. Nothing is promoted. | PC-3. Pokémon precedent `api/app/games/pokemon/catalog/catalog.py:570-572`. | Writer |
| RB-PE-06 | Numbers `2/100`, `7a/100`, `10/100`, `101*/100`, `P-001`. | `Card.order` gives that exact order. Collection reads them without error. No promise that every gallery uses the same order. | CDC `catalog_search_words` section on `Card.order`. | Reader |
| RB-PE-07 | Three Editions on one Printing, all with Holdings. | Facts and holdings return one row per Edition. Nothing multiplies through optional joins. | CDC join rules: optional display and art joins must not multiply rows. | Reader |
| RB-PE-08 | `catalog_generation_edition` row whose Printing disagrees with the Edition's. | Writer refuses it. The two foreign keys alone would allow it. | CDC `catalog_generation_edition`: writers must keep the correspondence. | Writer |

## Finishes

The spec reads an Edition as a product and a finish, taken from price subtypes. That makes the price feed a source of physical identity, which is why [Retired, unpriced and promo records](#retired-unpriced-and-promo-records) treats it with care.

| ID | Synthetic input | Expected behaviour | Clause | Runs on |
| --- | --- | --- | --- | --- |
| RB-FIN-01 | Product priced under `Normal` and `Foil`. | Two Editions on one Printing. `accepts` with rule `printing` returns both. Rule `edition` returns only itself and reads nothing. | CDC `catalog_edition`: many Editions per Printing. CDC join rules. CONTEXT Will accept. | Writer |
| RB-FIN-02 | Product priced under `Foil` only. | One Edition. No Normal Edition is invented. | CONTEXT Card Edition. PC-5. | Writer |
| RB-FIN-03 | Product priced under `Normal` only. | One Edition. No Foil Edition is invented. | CONTEXT Card Edition. PC-5. | Writer |
| RB-FIN-04 | New product with no price rows at all. | One Unspecified Variant Edition. It does not claim a normal or non-foil finish. | CONTEXT Unspecified Variant. PC-5. | Writer |
| RB-FIN-05 | Product from RB-FIN-04 with copies held, and `Foil` then appears. | A Foil Edition is added. The Unspecified Variant Edition and its Holdings stay. Nothing is reassigned without owner review. | CDC Scope and consumers: inventory foreign keys. PC-6. | Writer |
| RB-FIN-06 | `subTypeName` outside the known set, `Synthetic Finish`. | No automatic Edition. Held for owner review. Price rows may be stored. | PC-5. Pokémon precedent `catalog.py:728-731`. | Writer |

## Retired, unpriced and promo records

| ID | Synthetic input | Expected behaviour | Clause | Runs on |
| --- | --- | --- | --- | --- |
| RB-PRICE-01 | **A disappearing price must not delete an Edition.** Foil Edition with Holdings, a Deck List line and a Trade Wants line. In the next price import the product stays, and its `Foil` price row is absent. | The `catalog_edition` row, its ID and `public_ref` stay, and `AVAILABLE` still passes. Holdings, Deck Lists and Trade Wants are untouched. A price-only import moves neither revision. If a catalog pull promotes a generation as well, the Edition stays active and the catalog revision rises once, as in RB-REV-01. The missing price adds no catalog change of its own. | PC-7. CDC Scope and consumers: inventory foreign keys. ADR 0019 Never blank. | Writer |
| RB-PRICE-02 | As RB-PRICE-01, but for every subtype of the product. | No Edition is withdrawn, and none becomes Unspecified Variant, with or without a promotion. | PC-7. | Writer |
| RB-PRICE-03 | `marketPrice` turns null while the row stays. | Edition unchanged. It counts as unpriced and lowers Pricing Coverage. No mid or low fallback. | ADR 0019 Market price only. CONTEXT Pricing Coverage. | Writer |
| RB-PRICE-04 | A price row is absent after a price was stored. | The stored row and date stay, and it is never deleted. | ADR 0019 Never blank; delisted product keeps its last known price. | Writer |
| RB-PRICE-05 | Group returns an empty price list where rows are stored. | The group is left as stored. The run is recorded partial or failed. | ADR 0019 Never blank. Pokémon precedent `api/app/games/pokemon/prices/price_import.py:215-220`. | Writer |
| RB-RET-01 | Product `9000004`, with Holdings, is gone from a healthy group. | In the new generation: `tombstoned` true and Editions inactive. `catalog_edition`, `catalog_printing` and display rows stay. `card_facts` and Holdings reads still show it. New copies are rejected. | CDC join rules: facts are retained; `AVAILABLE` rejects tombstoned Printings. | Reader and Writer |
| RB-RET-02 | RB-RET-01, then the product returns. | Same Printing and Editions, active again. No duplicate. | CDC `catalog_printing`. PC-3. | Writer |
| RB-RET-03 | A group returns no products where products are stored, or more than a set share of source IDs vanish. | The run is refused. Nothing is tombstoned. | PC-8. Pokémon precedent `catalog.py:574-579`. | Writer |
| RB-RET-04 | Edition with a row only in an older generation. | Rejected as unavailable. A live row elsewhere does not help. | CDC join rules: a live row in another generation cannot make a current Edition available. | Reader |
| RB-RET-05 | `catalog_state.active_generation` is NULL: a Riftbound database before its first pull. | New copies are rejected. Readers answer empty and do not error. | CDC `catalog_state`: active generation can be NULL. CDC join rules. | Reader |
| RB-RET-06 | Generation pruning removes an old generation holding the only row for a retired Edition. | Generation rows go by cascade. `catalog_edition` and inventory rows stay. | CDC `catalog_edition`. Evidence `migrations/003_catalog.sql:75-77`, `catalog.py:787-788`. | Reader |
| RB-PROMO-01 | Promo product in `synp`, no `Rarity`, `Normal` only. | One Printing and one Edition. Missing `Rarity` is not an error. | PC-2. CONTEXT Card Printing. | Writer |
| RB-PROMO-02 | Sealed promo pack in `synp`. | No catalog row. | PC-2. | Writer |
| RB-PROMO-03 | Product `9000005` moves from `syn01` to `synp`. | Same Printing. Retained display is unchanged, a review is queued, and no Edition is created while it is pending. | CDC `catalog_printing_display`. PC-4. Pokémon precedent `catalog.py:684-696`. | Writer |

## Multi-domain fields

Facets are game-supplied SQL. Core takes them as required arguments, so these cases test the game's wiring against core's reads. The delimiter is unverified.

| ID | Synthetic input | Expected behaviour | Clause | Runs on |
| --- | --- | --- | --- | --- |
| RB-DOM-01 | `Domain: DomainA;DomainB`. | Two values. A filter on either finds the card. | CDC remaining dependencies: facet SQL is game-supplied; filters use equality and `ANY`. | Writer |
| RB-DOM-02 | Same card in a Collection page and totals, no filter. | One row per Edition. Totals count it once. | CDC join rules. CDC `core/inventory/collection.py` row. | Reader |
| RB-DOM-03 | No `Domain` field. | Empty domains. The card is listed unfiltered and matches no requested domain. | CDC remaining dependencies: unknowns do not match a requested facet. | Reader and Writer |
| RB-DOM-04 | Delimiter differs from the expected one, `DomainA,DomainB`. | Treated as one unknown value and flagged for the coverage gate, never split by guesswork. | PC-9. | Writer |
| RB-DOM-05 | `Tag` with `;`-separated values. | Parsed like `Domain`, kept separate from it. | PC-9. | Writer |

## References

| ID | Synthetic input | Expected behaviour | Clause | Runs on |
| --- | --- | --- | --- | --- |
| RB-REF-01 | Any new Printing. | `public_ref` is 48 lowercase hex characters, unique and immutable. | CDC `catalog_printing`. | Reader |
| RB-REF-02 | Retire an Edition referenced by a Holding, Deck List line, Loan line, Trade line and Trade Wants line. | Every reference still resolves. `DELETE` on the Edition fails on its foreign keys. | CDC Scope and consumers: inventory foreign keys. | Reader |
| RB-REF-03 | Printings with display, without display, and no `catalog_set_code` rows at all. | Exactly one `catalog_printing_set_code` row each: retained set ID, else `''`, never NULL. No card is lost through the inner join. | CDC `catalog_printing_set_code`. | Reader |
| RB-REF-04 | Set ID `syn01` with no reviewed code. | Falls back to the retained set ID. `syn01` fails the code check on `catalog_set_code`, so it cannot be given one in that form. | CDC `catalog_printing_set_code`. Evidence `migrations/160_catalog_set_code.sql:7`. | Reader |
| RB-REF-05 | No art row, then a source image on `example.invalid`. | No art resolves to None, with no placeholder. A host outside the game's `allowed_host` is not fetched. | CDC `catalog_printing_art`. CDC Art view internals: host validation is supplied by game composition. | Reader |
| RB-REF-06 | A descriptor stored as a JSON array. | Refused by the writer. JSONB alone does not stop it. | CDC `catalog_edition`: JSONB does not enforce object shape. | Writer |

## Revisions and cursors

| ID | Synthetic input | Expected behaviour | Clause | Runs on |
| --- | --- | --- | --- | --- |
| RB-REV-01 | A pull promotes a new generation. | `catalog_state.revision` rises once. A Collection or Holdings cursor from before answers 409 `CATALOG_CHANGED`. | CDC `catalog_attribute_state`. Evidence `api/app/core/inventory/cursors.py:32`. | Reader |
| RB-REV-02 | Only a card attribute changes. | The attribute revision rises and the catalog revision does not. The Collection cursor still answers 409 `CATALOG_CHANGED`. | CDC `catalog_attribute_state`: either change invalidates it. | Reader |
| RB-REV-03 | A price-only import with changed amounts. | Neither revision moves. An open cursor still works. | PC-7. Evidence: `price_import.py` and `price_binding.py` never touch `catalog_state`. | Writer |
| RB-REV-04 | Owner and catalog revisions both moved. | Answers 409 `INVENTORY_CHANGED`, which is checked first. | Evidence `cursors.py:31-32`. | Reader |
| RB-REV-05 | Tampered cursor, or one from another context. | 400 `INVALID_CURSOR`. | Evidence `cursors.py:21-35`. | Reader |
| RB-REV-06 | Deck capture during a promotion. | The capture reads the revision under `FOR SHARE` and binds it. It sees one catalog revision. | CDC `catalog_state`. The contract does not claim to prove every concurrency schedule, so this case states the requirement. | Reader |
| RB-REV-07 | Re-run of a pull with unchanged source. | No duplicate rows. Editions and `public_ref` values are unchanged. | PC-3. | Writer |

## Proposed clauses

None has force until decision D4 adopts it into the contract.

| ID | Proposed clause |
| --- | --- |
| PC-1 | A game's catalog schema states its write-side requirements: which source values exist, and which required columns are game-specific. Shared SQL does not depend on them. |
| PC-2 | A game defines what counts as a card. For Riftbound: a product with a `Number` and a `Card Type` that does not include `Token`. |
| PC-3 | A source key maps to one Printing for good. Repeat pulls, and a product's return, reuse the same Printing and Editions. |
| PC-4 | Source changes to name, set or number do not rewrite retained display. They wait for owner review. |
| PC-5 | Editions come only from finishes the source shows or the Unspecified Variant. Finishes outside the known set wait for review. |
| PC-6 | Adding an Edition never moves Holdings. Reassignment is an explicit owner decision. |
| PC-7 | **Price data never decides whether an Edition exists or is available.** Absent, null or stale prices change pricing only: no Edition is deleted, deactivated or replaced, and they cause no catalog change. A price-only import moves no catalog or attribute revision. A catalog pull that promotes a generation still advances the catalog revision as usual. A finish first seen in price data stays until an owner review retires it. |
| PC-8 | A source drop or empty group refuses promotion. It never retires Printings in bulk. |
| PC-9 | Multi-value fields use a delimiter proved by the coverage gate. Anything else is flagged, not guessed. |

## Open questions

- **Card Identity for Riftbound.** `CONTEXT.md` defines it for Pokémon. RB-ID-01 assumes a parenthetical treatment for `(Alternate Art)`, `(Overnumbered)` and `(Signature)`. Ryan confirms the meaning before a normaliser is written.
- **What retires a finish?** PC-7 keeps an Edition when its price subtype disappears. Only owner review retires it, which matches how Pokémon keeps established Editions under review (`catalog.py:704`, `:721-727`). The review volume is unknown until the coverage gate.
- **Collector number form.** Cases keep the source's `001/100`. Whether the denominator is stored is a normaliser choice, and RB-PE-06 must pass either way.
