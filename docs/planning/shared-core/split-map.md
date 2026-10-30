# Split map: backend and auth gateway

**Status:** draft for the owner's review, 2026-10-29. Branch `refactor/shared-core`, HEAD 2f335c7. Nothing here is
implemented.

**Scope.** This map covers `api/app`, `migrations/`, `auth/src`, `scripts/`, `deploy/` and the tooling tests. `web/` is
out of scope and stays untouched.

**Phase tags.** They follow the proposal from the primary and advisor review:

- **Now:**
  - snapshots, characterization tests and replay fixtures (WP-B, WP-B2, WP-B4);
  - the architecture-pin port into the boundary checker (WP-B3, section 9);
  - the 58 Pokémon-only files;
  - the composition splits of the MarketplacePrices, QuoteSource, ArtSources, CollectionImport and deck-import groups
    (WP-S1, WP-S2, WP-S3);
  - the printed set code table (WP-C1) and the display reads that use it (WP-C2);
  - the Pokémon app module (WP-F);
  - the deck routes, and publishing and discovery, by composition (WP-D1, WP-D2; section 1B);
  - docs.
- **Later (Riftbound):**
  - ReprintRules;
  - `host_readiness`;
  - moving the pure core modules;
  - identity (Design B);
  - the migration tracks and the core baseline.

Mixed files are split by composition (design-brief D11), not allow-listed. Only the Later files' edges stay on the
allow-list until they land. The owner can move any row between phases.

**How it was made.** The tables come from read-only scans of HEAD: a Python AST walk of every import in `api/app`,
including function-level imports and `importlib` literals, and a regex parse of every migration's `CREATE`, `ALTER`,
`REFERENCES`, `TRIGGER` and `INDEX` statements. Classification is a judgment checked against module docstrings and
imports. The eight modules `/tmp/prizecheck-split/api.md` flagged as unsure were re-read; see section 1. The regex
parse of the migrations can miss unusual SQL forms, so treat counts as ±2. Design detail for the Later items is in
[design-brief.md](design-brief.md).

## 0. Summary

**Files under `api/app`: 137** (129 `.py`, 4 `format_rules` files, 3 `.tsv` files, 1 `.txt` file). Each is classed as
one of:

- **pokemon**: Pokémon-only content and dependencies.
- **core**: no Pokémon import or content.
- **core-sql**: no Pokémon import, but SQL that reads catalog tables.
- **mixed**: core mechanics with a Pokémon import, literal or type, split by composition.
- **root**: `main.py`.

| Destination | Files | Lines | Phase |
|---|---:|---:|---|
| `games/pokemon/catalog/` | 20 | 5,744 | Now |
| `games/pokemon/formats/` (5 modules + `format_rules/`) | 9 | 4,531 | Now |
| `games/pokemon/prices/` | 9 | 3,279 | Now |
| `games/pokemon/imports/` (incl. 2 `.tsv`) | 12 | 2,507 | Now |
| `games/pokemon/exports/` | 7 | 788 | Now |
| `games/pokemon/scanner/` | 1 | 249 | Now |
| **Pokémon-only, moves Now** | **58** | **17,098** | **Now** |
| Mixed, split or moved whole Now (sections 1A, 1B) | 24 | 6,587 | Now |
| Mixed, split Later (section 1A) | 7 | 2,680 | Later |
| Core, moves Later | 38 | 7,155 | Later |
| Core-sql, moves Later | 9 | 5,816 | Later |
| `app/main.py` | 1 | 137 | Now (WP-F: mounts `games/pokemon/app.py`) |

- **Touched Now:** 82 files and 23,685 lines. **Later:** 54 files and 15,651 lines.
- **Import crossings:** 34 edges from non-Pokémon modules into Pokémon modules (section 2). After the Now work, 2
  allow-list lines remain: `host_readiness` → `catalog_targets`, and `want_list` → the Pokémon line display (section
  1A). WP-C2 removes the 4 `set_codes` lines; WP-D1 and WP-D2 remove 11.
- **Entry points pinned by test assertions** stay as root shims at their old paths (design-brief D11 rule 5):
  `app.catalog_import`, `app.catalog_refresh`, `app.price_runner`, `app.host_readiness`.
- **Tables and views:** 121 (section 3):
  - **auth:** 8.
  - **split:** 2.
  - **game-core:** 56.
  - **game-pokemon:** 55.

  WP-C1 adds a 122nd and a 123rd, the table `catalog_set_code` and the view `catalog_printing_set_code` (both
  game-pokemon), in migration `160`.
- **Cross-boundary FKs:** 40, of which only the 2 identity FKs ever change (Later).
- **Migrations:** 82. Seven files mix tracks. The only Now change is WP-C1's `160_catalog_set_code.sql`.
- **Coverage:** 113 routes are in the Now groups (88, plus 25 in WP-D1 and WP-D2), and 1 has only Playwright
  coverage. It gets a characterization test in WP-B2 (section 8).
- **What the Now work touches outside `api/app`:**
  - about 76 `api/tests` files (import lines and patch strings only);
  - 9 scripts;
  - 5 deploy lines;
  - 2 guardrail path constants;
  - five architecture-pin test files: their layout assertions become boundary-checker rules in WP-B3 (owner
    option C, section 9).


## 1. API modules

Target groups:
- **catalog:** source, browse and search, attributes, Reprint Groups, rules.
- **prices:** marketplace mapping, price runner and cache.
- **imports:** decklist and Collection Import.
- **formats:** Pokémon format rules and checks.
- **decks:** deck storage and lists.
- **scanner**, **exports**.
- **inventory:** Locations, Holdings, moves, Collection.
- **social:** Friends, Loans, Trades, reports.
- **publications:** Published Decks and the public record stores.
- **ops:** identity, operations, host readiness.
- **art:** the card art store. This group is not on the requested list; the art store is its own unit under ADR 0020.

Borderline classifications re-checked against source:

| Module | Verdict | Evidence |
|---|---|---|
| `catalog_status` | pokemon/catalog | catalog run controls; imports `catalog_dispatch` and `metadata_reviews`; reads `catalog_run` |
| `card_art` | pokemon/prices | TCGplayer fallback art for Printings without a TCGdex image; imports `catalog_targets` and `price_binding` |
| `rule_rollout` | pokemon/catalog | deploy-time catalog rule rollout (ADR 0021); imports 12 `catalog_targets` symbols; also reads `owner_binding` (identity, Later) |
| `public_records` | core-sql/publications | generic public record store; imports only `public_projection`; its catalog key families have a game-neutral Printing and Edition shape |
| `set_codes` | pokemon/catalog | TCGdex set ID → printed code (`set_codes.tsv`); no imports |
| `catalog_dispatch` | pokemon/catalog | owner dispatch of catalog import runs; no imports |
| `deck_list_printing` | **mixed**/decks | a core Deck List command, but picks the Edition through `prices.stored_edition_quotes` and imports `quote_contract.parse_amount` |
| `card_accepts` | core-sql/social | Will accept rules; no imports; SQL over `catalog_printing.identity_id` and `catalog_edition` |

Each mixed module's Pokémon dependency and seam (section 1A has the composition split, which replaces the seams):
- **Imports.** The dependency column of the table below names them, and section 2 lists each one.
- **Literals or SQL.** The dependency column names them; section 2 has no entry, because the boundary check sees
  imports only.
- **Seams.** The seam names refer to design-brief D12: CardDisplay, DeckChecks, GameTypes, CatalogReadiness and
  QuoteSource. The others are new for Later:
  - **MarketplacePrices:** edition price reads;
  - **ReprintRules:** Reprint Group and Card Identity reads;
  - **DecklistText:** parse and print, energy grouping;
  - **CollectionImportReaders**;
  - **CatalogSearch**;
  - **ArtSources:** allowed hosts and the source URL rule;
  - **CardFacets:** category, Trainer Type and elemental filters;
  - **CatalogSource:** manual catalog entries.
- **Catalog SQL contract** means relations that every game track must provide under agreed names. It is deferred, as in
  design-brief D11.

Lines are physical lines, including data files.

| Current (`api/app/…`) | Target | Lines | Class | Phase | Pokémon dependency / note | Seam that removes it |
|---|---|---:|---|---|---|---|
| `__init__.py` | `core/ops/__init__.py` | 0 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `api_errors.py` | `core/ops/api_errors.py` | 8 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `art_storage.py` | `core/art/art_storage.py` | 78 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `art_store.py` | split → see 1A | 490 | mixed | **Now** (split/move) | `ALLOWED_HOST` assets.tcgdex.net (line 41), tcgplayer-cdn `LINKED_ART` regex | ArtSources (allowed hosts per game) |
| `art_urls.py` | split → see 1A | 63 | mixed | **Now** (split/move) | `tcgdex_source` rule, `.webp` suffix (guardrail pins this file) | ArtSources.source_url |
| `attribute_corrections.py` | `games/pokemon/catalog/attribute_corrections.py` | 497 | pokemon | **Now** (move) |  |  |
| `borrowed_copies.py` | `core/inventory/borrowed_copies.py` | 67 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `bounded_work.py` | `core/inventory/bounded_work.py` | 74 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `card_accepts.py` | `core/trading/card_accepts.py` | 48 | core-sql | **Later (Riftbound)** (move; owner may pull to Now) | SQL reads set_code/set_name/identity_id from catalog_edition, catalog_printing and their metadata | catalog SQL contract (Later) |
| `card_art.py` | `games/pokemon/prices/card_art.py` | 67 | pokemon | **Now** (move) |  |  |
| `card_attributes.py` | `games/pokemon/catalog/card_attributes.py` | 379 | pokemon | **Now** (move) |  |  |
| `card_identity.py` | `games/pokemon/catalog/card_identity.py` | 24 | pokemon | **Now** (move) |  |  |
| `catalog.py` | `games/pokemon/catalog/catalog.py` | 838 | pokemon | **Now** (move) |  |  |
| `catalog_browse.py` | `games/pokemon/catalog/catalog_browse.py` | 484 | pokemon | **Now** (move) |  |  |
| `catalog_dispatch.py` | `games/pokemon/catalog/catalog_dispatch.py` | 91 | pokemon | **Now** (move) |  |  |
| `catalog_import.py` | `games/pokemon/catalog/catalog_import.py` | 38 | pokemon | **Now** (move) |  |  |
| `catalog_reconciliation.py` | `games/pokemon/catalog/catalog_reconciliation.py` | 255 | pokemon | **Now** (move) |  |  |
| `catalog_refresh.py` | `games/pokemon/catalog/catalog_refresh.py` | 266 | pokemon | **Now** (move) |  |  |
| `catalog_search.py` | `games/pokemon/catalog/catalog_search.py` | 188 | pokemon | **Now** (move) |  |  |
| `catalog_status.py` | `games/pokemon/catalog/catalog_status.py` | 144 | pokemon | **Now** (move) |  |  |
| `catalog_targets.py` | `games/pokemon/prices/catalog_targets.py` | 1148 | pokemon | **Now** (move) |  |  |
| `collection.py` | split → see 1A | 411 | mixed | **Later (Riftbound)** (split) | `set_codes` module; SQL `CASE ca.card_kind WHEN 'pokemon'` (160-161), `elemental_types`, `trainer_type` | CardDisplay + CardFacets |
| `collection_import.py` | split → see 1A | 935 | mixed | **Now** (split/move) | imports reader/matcher/finish (Pokémon); `storage_leaf` used by scanner_save | CollectionImportReaders |
| `collection_import_aliases.py` | `games/pokemon/imports/collection_import_aliases.py` | 150 | pokemon | **Now** (move) |  |  |
| `collection_import_aliases.tsv` | `games/pokemon/imports/collection_import_aliases.tsv` | 34 | pokemon | **Now** (move) | data for `collection_import_aliases` |  |
| `collection_import_finish.py` | `games/pokemon/imports/collection_import_finish.py` | 271 | pokemon | **Now** (move) |  |  |
| `collection_import_matcher.py` | `games/pokemon/imports/collection_import_matcher.py` | 396 | pokemon | **Now** (move) |  |  |
| `collection_import_reader.py` | `games/pokemon/imports/collection_import_reader.py` | 523 | pokemon | **Now** (move) |  |  |
| `construction_checks.py` | `games/pokemon/formats/construction_checks.py` | 34 | pokemon | **Now** (move) |  |  |
| `copy_allocation.py` | `core/inventory/copy_allocation.py` | 516 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `copy_picks.py` | `core/inventory/copy_picks.py` | 50 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `db.py` | `core/ops/db.py` | 9 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `deck_cost.py` | split → see 1A | 192 | mixed | **Now** (split/move) | `prices` (tcgplayer_price, edition_price_binding) | MarketplacePrices |
| `deck_deletion.py` | `core/decks/deck_deletion.py` | 133 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `deck_format_checks.py` | `games/pokemon/formats/deck_format_checks.py` | 326 | pokemon | **Now** (move) |  |  |
| `deck_import.py` | `games/pokemon/imports/deck_import.py` | 540 | pokemon | **Now** (move) |  |  |
| `deck_list_capture.py` | `core/decks/deck_list_capture.py` | 73 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `deck_list_display.py` | `games/pokemon/decks/line_display.py` (whole) | 72 | mixed | **Now** (move, WP-D1) | defines `CardKind`, `TrainerType` Literals (21-22); `DISPLAY_QUERY` joins `catalog_card_attribute`, `catalog_evolution_root` | GameTypes + catalog SQL contract |
| `deck_list_printing.py` | split → see 1A | 125 | mixed | **Now** (split/move) | `prices.stored_edition_quotes` (cheapest Edition), `quote_contract.parse_amount` | MarketplacePrices |
| `deck_live_export.py` | `games/pokemon/exports/deck_live_export.py` | 142 | pokemon | **Now** (move) |  |  |
| `deck_mass_entry.py` | `games/pokemon/exports/deck_mass_entry.py` | 150 | pokemon | **Now** (move) |  |  |
| `deck_ownership.py` | split → see 1A, 1B | 204 | mixed | **Now** (split, WP-D1) | imports `CardKind`, `TrainerType`, `read_line_display` from `deck_list_display` (model field types) | GameTypes (with DeckChecks) |
| `deck_pick_list.py` | `core/decks/deck_pick_list.py` | 334 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `decklist_text.py` | `games/pokemon/imports/decklist_text.py` | 196 | pokemon | **Now** (move) |  |  |
| `decks.py` | split → see 1A, 1B | 740 | mixed | **Now** (split, WP-D1) | `construction_checks` {DISCLAIMER, IdentityCount, evaluate_checks}, `deck_format_checks` {DeckFormatChecks, TargetFormat, command_format_checks, held_format_checks}, `format_evaluator.FORMATS`; CardKind/TrainerType display | DeckChecks + GameTypes |
| `discovery.py` | split → see 1A, 1B | 331 | mixed | **Now** (split, WP-D2) | Listed Deck discovery by Format: imports `format_evaluator`, `card_attributes`, `public_catalog`, `deck_format_checks`, `prices` and more | DeckChecks + MarketplacePrices |
| `evolution_roots.py` | `games/pokemon/catalog/evolution_roots.py` | 126 | pokemon | **Now** (move) |  |  |
| `format_evaluator.py` | `games/pokemon/formats/format_evaluator.py` | 834 | pokemon | **Now** (move) |  |  |
| `format_rules/expanded.toml` | `games/pokemon/formats/format_rules/expanded.toml` | 1169 | pokemon | **Now** (move) | Pokémon Format Rules data, read by `format_evaluator` |  |
| `format_rules/glc.toml` | `games/pokemon/formats/format_rules/glc.toml` | 1091 | pokemon | **Now** (move) | Pokémon Format Rules data, read by `format_evaluator` |  |
| `format_rules/imported_sets.txt` | `games/pokemon/formats/format_rules/imported_sets.txt` | 211 | pokemon | **Now** (move) | Pokémon Format Rules data, read by `format_evaluator` |  |
| `format_rules/standard.toml` | `games/pokemon/formats/format_rules/standard.toml` | 337 | pokemon | **Now** (move) | Pokémon Format Rules data, read by `format_evaluator` |  |
| `format_standing.py` | `games/pokemon/formats/format_standing.py` | 301 | pokemon | **Now** (move) |  |  |
| `holdings.py` | split → see 1A | 326 | mixed | **Later (Riftbound)** (split) | `set_codes` module (Storage Leaf rows) | CardDisplay |
| `host_readiness.py` | split → see 1A | 234 | mixed | **Later (Riftbound)** (split) · identity edits Later | `catalog_targets` {LIVE, MATCHING, load_active}; loads `scripts/scanner_index_job.py` by path (47); operator text names `"user"`; reads `owner_binding` | CatalogReadiness (+ identity, Later) |
| `idempotency.py` | `core/inventory/idempotency.py` | 6 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `identity.py` | `core/ops/identity.py` | 39 | core | **Later (Riftbound)** (move; owner may pull to Now) · identity edits Later |  |  |
| `import_aliases.py` | `games/pokemon/imports/import_aliases.py` | 138 | pokemon | **Now** (move) |  |  |
| `import_aliases.tsv` | `games/pokemon/imports/import_aliases.tsv` | 43 | pokemon | **Now** (move) | data for `import_aliases` |  |
| `import_allocation.py` | `games/pokemon/imports/import_allocation.py` (whole) | 140 | mixed | **Now** (split/move) | Basic Energy groups via `import_owned`; `deck_list_printing` | DecklistText |
| `import_energy_matching.py` | `games/pokemon/imports/import_energy_matching.py` | 72 | pokemon | **Now** (move) |  |  |
| `import_match_core.py` | `games/pokemon/imports/import_match_core.py` (whole) | 89 | mixed | **Now** (split/move) | `catalog_browse` newest-first, `decklist_text`, TCGdex set/number `at_code_and_number`, Basic Energy default | DecklistText + CatalogSearch |
| `import_matching.py` | `games/pokemon/imports/import_matching.py` | 53 | pokemon | **Now** (move) |  |  |
| `import_name_matching.py` | `games/pokemon/imports/import_name_matching.py` | 91 | pokemon | **Now** (move) |  |  |
| `import_owned.py` | `games/pokemon/imports/import_owned.py` (whole) | 94 | mixed | **Now** (split/move) | `import_energy_matching` (Basic Energy by type) | DecklistText (energy grouping) |
| `import_publication.py` | `games/pokemon/imports/import_publication.py` (whole) | 134 | mixed | **Now** (split/move) | `set_codes`, `decklist_text` SECTIONS pokemon/trainer/energy | DecklistText + CardDisplay |
| `import_replace.py` | `games/pokemon/imports/import_replace.py` (whole) | 91 | mixed | **Now** (split/move) | pins importers to `set_codes` (test); `deck_list_display` | DecklistText |
| `inventory_core.py` | `core/inventory/inventory_core.py` | 166 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `live_export.py` | `games/pokemon/exports/live_export.py` | 122 | pokemon | **Now** (move) |  |  |
| `loan_inventory.py` | `core/loans/loan_inventory.py` | 1158 | core-sql | **Later (Riftbound)** (move; owner may pull to Now) | SQL reads set_code/set_name/identity_id from catalog_edition, catalog_printing and their metadata | catalog SQL contract (Later) |
| `loan_picks.py` | `core/loans/loan_picks.py` | 52 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `location_tree.py` | `core/inventory/location_tree.py` | 463 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `locations.py` | `core/inventory/locations.py` | 50 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `main.py` | stays `app/main.py` | 137 | root | **Later (Riftbound)** | router composition root; lifespan calls `rule_rollout`, `format_standing` (game hooks); imports `attribute_corrections`, `catalog_browse`, `catalog_reconciliation`, `catalog_search`, `catalog_status`, `deck_format_checks`, `deck_import`, `deck_live_export`, `deck_mass_entry`, `format_standing`, `metadata_reviews`, `prices`, `published_format_checks`, `published_live_export`, `published_mass_entry`, `reprint_group_reviews`, `rule_rollout`, `scanner`, `want_list_mass_entry` | game.routers() slots + lifespan_hooks() |
| `mass_entry_export.py` | `games/pokemon/exports/mass_entry_export.py` | 103 | pokemon | **Now** (move) |  |  |
| `metadata_reviews.py` | `games/pokemon/prices/metadata_reviews.py` | 716 | pokemon | **Now** (move) |  |  |
| `missing_cards.py` | `games/pokemon/catalog/missing_cards.py` (whole) | 257 | mixed | **Now** (split/move) | `card_identity.card_identity_key`, `public_catalog.publish_catalog_best_effort`; `basic_energy` column | CatalogSource (manual entries) |
| `moves.py` | `core/inventory/moves.py` | 448 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `name_search.py` | `games/pokemon/catalog/name_search.py` | 65 | pokemon | **Now** (move) |  |  |
| `operation_counts.py` | `core/ops/operation_counts.py` | 174 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `operations.py` | `core/ops/operations.py` | 81 | core | **Later (Riftbound)** (move; owner may pull to Now) · identity edits Later |  |  |
| `price_binding.py` | `games/pokemon/prices/price_binding.py` | 209 | pokemon | **Now** (move) |  |  |
| `price_budget.py` | `core/prices/price_budget.py` | 102 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `price_import.py` | `games/pokemon/prices/price_import.py` | 472 | pokemon | **Now** (move) |  |  |
| `price_launcher.py` | `core/prices/price_launcher.py` | 356 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `price_reads.py` | `core/prices/price_reads.py` | 11 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `price_refresh.py` | `core/prices/price_refresh.py` | 680 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `price_runner.py` | split → see 1A | 761 | mixed | **Now** (split/move) | `importlib` `app.price_source`, `app.tcgdex_record` (114, 119, 620); TCGdex quote kinds | QuoteSource |
| `price_source.py` | `games/pokemon/prices/price_source.py` | 140 | pokemon | **Now** (move) |  |  |
| `prices.py` | `games/pokemon/prices/prices.py` | 236 | pokemon | **Now** (move) |  |  |
| `public_catalog.py` | `games/pokemon/catalog/public_catalog.py` | 876 | pokemon | **Now** (move) |  |  |
| `public_deck.py` | `games/pokemon/publications/public_deck.py` (whole) | 186 | mixed | **Now** (move, WP-D2) | imports `PublicSnapshot` (CardKind fields), `PUBLIC_HEADERS`, `TOKEN` from `publications` | with DeckChecks |
| `public_prices.py` | `games/pokemon/prices/public_prices.py` | 177 | pokemon | **Now** (move) |  |  |
| `public_projection.py` | `core/publications/public_projection.py` | 248 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `public_records.py` | `core/publications/public_records.py` | 1055 | core-sql | **Later (Riftbound)** (move; owner may pull to Now) | catalog Printing/Edition/format key families (game-neutral shape) | catalog SQL contract (Later) |
| `publications.py` | split → see 1A, 1B | 430 | mixed | **Now** (split, WP-D2) | `construction_checks`, `deck_format_checks` {TargetFormat, held_format_checks}, `deck_list_display` CardKind/TrainerType; evolution_root in snapshot | DeckChecks + GameTypes |
| `published_cost.py` | split → see 1A | 157 | mixed | **Now** (split/move) | `deck_cost`, `prices`, `public_catalog`, `quote_contract` | MarketplacePrices |
| `published_format_checks.py` | `games/pokemon/formats/published_format_checks.py` | 228 | pokemon | **Now** (move) |  |  |
| `published_live_export.py` | `games/pokemon/exports/published_live_export.py` | 100 | pokemon | **Now** (move) |  |  |
| `published_mass_entry.py` | `games/pokemon/exports/published_mass_entry.py` | 87 | pokemon | **Now** (move) |  |  |
| `quote_contract.py` | split → see 1A | 574 | mixed | **Now** (split/move) | literal `'source': 'tcgdex'`, `'currency': 'USD'`, TCGdex card/variant shape (no Pokémon import) | QuoteSource constants |
| `reprint_group_reviews.py` | `games/pokemon/catalog/reprint_group_reviews.py` | 552 | pokemon | **Now** (move) |  |  |
| `reprint_groups.py` | `games/pokemon/catalog/reprint_groups.py` | 211 | pokemon | **Now** (move) |  |  |
| `rule_rollout.py` | `games/pokemon/catalog/rule_rollout.py` | 447 | pokemon | **Now** (move) · identity edits Later |  |  |
| `scanner.py` | `games/pokemon/scanner/scanner.py` | 249 | pokemon | **Now** (move) |  |  |
| `scanner_save.py` | `games/pokemon/scanner/scanner_save.py` (whole) | 116 | mixed | **Now** (split/move) | `collection_import.storage_leaf` (mixed), `holdings` | none once collection_import is core |
| `set_codes.py` | `games/pokemon/catalog/set_codes.py` | 48 | pokemon | **Now** (move) |  |  |
| `set_codes.tsv` | `games/pokemon/catalog/set_codes.tsv` | 164 | pokemon | **Now** (move) | data for `set_codes` |  |
| `set_counts.py` | `games/pokemon/catalog/set_counts.py` | 51 | pokemon | **Now** (move) |  |  |
| `settings.py` | `core/inventory/settings.py` | 79 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/__init__.py` | `core/social/__init__.py` | 7 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/conversations.py` | `core/social/conversations.py` | 730 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/counts.py` | `core/social/counts.py` | 155 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/discovery.py` | `core/social/discovery.py` | 300 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/friend_copies.py` | `core/social/friend_copies.py` | 345 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/friend_reads.py` | split → see 1A | 312 | mixed | **Later (Riftbound)** (split) | `set_codes`; Reprint Group other-printing reads; `want_list` | CardDisplay + ReprintRules |
| `social/friends.py` | `core/social/friends.py` | 706 | core-sql | **Later (Riftbound)** (move; owner may pull to Now) | imports mixed `publications` (CardKind via deck_list_display); profile also holds Handle writes (identity, Later) | GameTypes via publications |
| `social/hidden_locations.py` | `core/social/hidden_locations.py` | 54 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/inbox.py` | `core/social/inbox.py` | 292 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/loans.py` | `core/social/loans.py` | 744 | core-sql | **Later (Riftbound)** (move; owner may pull to Now) | SQL reads set_code/set_name/identity_id from catalog_edition, catalog_printing and their metadata | catalog SQL contract (Later) |
| `social/name_filter_words.txt` | `core/social/name_filter_words.txt` | 447 | core | **Later (Riftbound)** (move; owner may pull to Now) | data for `social/name_rules` |  |
| `social/name_rules.py` | `core/social/name_rules.py` | 121 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/owners.py` | `core/social/owners.py` | 78 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `social/profile.py` | `core/social/profile.py` | 294 | core-sql | **Later (Riftbound)** (move; owner may pull to Now) · identity edits Later | imports mixed `publications` (CardKind via deck_list_display); profile also holds Handle writes (identity, Later) | GameTypes via publications |
| `social/reports.py` | `core/social/reports.py` | 531 | core-sql | **Later (Riftbound)** (move; owner may pull to Now) | SQL reads set_code/set_name/identity_id from catalog_edition, catalog_printing and their metadata | catalog SQL contract (Later) |
| `social/trade_matches.py` | split → see 1A | 780 | mixed | **Later (Riftbound)** (split) | `want_list`, `card_accepts` (Will accept over Reprint Group / Card Identity); set_code SQL | ReprintRules |
| `social/trades.py` | `core/social/trades.py` | 588 | core-sql | **Later (Riftbound)** (move; owner may pull to Now) | SQL reads set_code/set_name/identity_id from catalog_edition, catalog_printing and their metadata | catalog SQL contract (Later) |
| `swap_hints.py` | split → see 1A | 245 | mixed | **Later (Riftbound)** (split) | `set_codes`; Reprint Group SQL (`catalog_reprint_group_effective`) | CardDisplay + ReprintRules |
| `tcgdex_record.py` | `games/pokemon/prices/tcgdex_record.py` | 114 | pokemon | **Now** (move) |  |  |
| `trade_inventory.py` | `core/trading/trade_inventory.py` | 692 | core-sql | **Later (Riftbound)** (move; owner may pull to Now) | SQL reads set_code/set_name/identity_id from catalog_edition, catalog_printing and their metadata | catalog SQL contract (Later) |
| `trade_list.py` | `core/trading/trade_list.py` | 197 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `trade_picks.py` | `core/trading/trade_picks.py` | 132 | core | **Later (Riftbound)** (move; owner may pull to Now) |  |  |
| `trade_value.py` | split → see 1A | 87 | mixed | **Now** (split/move) | `prices`, `deck_cost` | MarketplacePrices |
| `trade_wants.py` | split → see 1A, 1B | 186 | mixed | **Now** (split, WP-D1) | `deck_list_display` (CardKind), `want_list`, `card_accepts` | GameTypes |
| `want_list.py` | split → see 1A | 372 | mixed | **Later (Riftbound)** (split) | `swap_hints` (Reprint Group), `deck_list_display` | ReprintRules + GameTypes |
| `want_list_cost.py` | split → see 1A | 133 | mixed | **Now** (split/move) | `prices`, `deck_cost` | MarketplacePrices |
| `want_list_mass_entry.py` | `games/pokemon/exports/want_list_mass_entry.py` | 84 | pokemon | **Now** (move) |  |  |

## 1A. Mixed files under composition (31 files)

The rules come from design-brief D11:
- A route that needs any Pokémon value moves its whole router to `games/pokemon`.
- Models with Pokémon-typed fields go with their route.
- Game-free functions, models and SQL go to `core`.
- Game values reach core as keyword-only arguments or SQL fragments.

The **Now** rows are work packages WP-S1, WP-S2 and WP-S3 (the first 17 rows), and WP-D1 and WP-D2 (the GameTypes
and DeckChecks rows; section 1B gives them function by function). The **Later (Riftbound)** rows are
sketches only. The 29 mixed files of the previous revision are joined by two more:
- `deck_ownership` imports `CardKind` and `TrainerType` for its models;
- `public_deck` imports `PublicSnapshot` from `publications`.

| File | Group | To `core/` | `games/pokemon` composes | Target paths | Phase |
|---|---|---|---|---|---|
| `deck_cost` | MarketplacePrices | `summarize`, `_micros`, `_exact`, `_display`, `_INCOMPLETE`, `_FALLBACK`, `_MICRO`, `DeckCostFigures`, `DeckCost`, `CostStatus`, `IncompleteReason` | router, `deck_cost` route, `private_deck_cost`, `_uncaptured`. It calls `capture_deck_list` (core), the `prices` reads and core `summarize` | `core/prices/cost.py`; `games/pokemon/decks/cost.py` | **Now** (S1) |
| `want_list_cost` | MarketplacePrices | nothing new (reuses `core/prices/cost.py`) | the whole file: models `WantListLineCost`, `WantListSectionCost`, `WantListRowCost`, `WantListCost`, `want_list_cost`, the route. It calls `want_list.capture_want_list`/`combined` (top-level until Later), `prices`, `summarize` | `games/pokemon/decks/want_list_cost.py` | **Now** (S1) |
| `trade_value` | MarketplacePrices | nothing new | the whole file: models, the `POST /value` route, `trade_inventory.trade_quantity` (core), `prices`, `summarize` | `games/pokemon/trading/trade_value.py` | **Now** (S1) |
| `published_cost` | MarketplacePrices | nothing new | the whole file: `public_quotes`, `_withheld`, `_label`, `_view`, `published_deck_cost`, the route; `public_catalog.marketplace_states`, `prices`, `summarize`, `quote_contract.parse_amount` (core) | `games/pokemon/publications/published_cost.py` | **Now** (S1) |
| `deck_list_printing` | MarketplacePrices | `choose_edition` (pure: lowest stored price, else catalog order), `store_printing_result` | `AVAILABLE_EDITIONS` (catalog SQL), `available_editions`, `AddDeckListPrinting`, `DeckListPrintingResult`, the route; `prices.stored_edition_quotes` | `core/decks/printing.py`; `games/pokemon/decks/printing.py` | **Now** (S1) |
| `quote_contract` | QuoteSource | the whole file, with the record builder (`:531`) and validator (`:569`) taking keyword-only `source` and `currency` | `quote_values.py`: `SOURCE='tcgdex'`, `CURRENCY='USD'`, passed at each call | `core/prices/quote_contract.py`; `games/pokemon/prices/quote_values.py` | **Now** (S2) |
| `price_runner` | QuoteSource | supervisor, worker, claims, `decide`, `Outcome`, `Renewer` and `main`, with `card_source`, `record_rules` and the quote values as parameters (in place of the `importlib` literals at 114, 119 and 620, and the literal at 109) | `runner_entry.py` binds `price_source`, `tcgdex_record` and the quote values. A root shim, `app/price_runner.py`, keeps `-m app.price_runner` (pinned) | `core/prices/runner.py`; `games/pokemon/prices/runner_entry.py`; shim `app/price_runner.py` | **Now** (S2) |
| `art_store` | ArtSources | `RateLimiter`, `FetchFailed`, `Busy`, `ArtFetcher`, `backoff_seconds`, `resolve`, `serve`, `_image`, `_read`, `_hit`, `_stored`, the executors, `start_warmups`, `stop_warmups`, `join_warmups`, `warm_deck`, every constant except the two below. `host_allowed`, `upstream_target` and `_linked` take `allowed_host` and `linked_art` | `art/hosts.py`: `ALLOWED_HOST`, `LINKED_ART`. `art/route.py`: the module fetcher and the `GET /{printing_id}/{size}` router. Lifespan hooks bound to those hosts | `core/art/store.py`; `games/pokemon/art/{hosts,route}.py` | **Now** (S2); `decks.warm_deck` call allow-listed until Later |
| `art_urls` | ArtSources | `SIZES`, `route_address`, `art_version`, `art_url` | `tcgdex_source`, `large_direct_url`. The guardrail `WEBP_SUFFIX_MODULES` follows them | `core/art/urls.py`; `games/pokemon/art/urls.py` | **Now** (S2) |
| `collection_import` | CollectionImport | `storage_leaf`, the row-state SQL constants, the counts and grouping helpers, the messages, every game-free model | the router and its routes, and the reader → matcher → finish calls | `core/imports/collection_draft.py`; `games/pokemon/imports/collection_import.py` | **Now** (S3) |
| `scanner_save` | CollectionImport | — | whole file (route only; it uses core `storage_leaf` and `holdings.MAX_BATCH_EDITIONS`) | `games/pokemon/scanner/scanner_save.py` | **Now** (S3) |
| `import_match_core` | deck-import | — | whole file (TCGdex set and number, `catalog_browse`, `decklist_text`) | `games/pokemon/imports/` | **Now** (S3) |
| `import_owned` | deck-import | — | whole file (Basic Energy groups) | `games/pokemon/imports/` | **Now** (S3) |
| `import_allocation` | deck-import | — | whole file (it imports core `choose_edition` after S1) | `games/pokemon/imports/` | **Now** (S3) |
| `import_publication` | deck-import | — | whole file (`set_codes`, `decklist_text` SECTIONS) | `games/pokemon/imports/` | **Now** (S3) |
| `import_replace` | deck-import | — | whole file (it calls `deck_list_display.read_line_display` and `deck_ownership`, which are top-level until Later) | `games/pokemon/imports/` | **Now** (S3) |
| `missing_cards` | catalog | — | whole file (manual catalog entries write `catalog_override`; `card_identity_key`, `publish_catalog_best_effort`). Owner decision 2026-10-29: moves whole now. **Later:** revisit which parts of the Missing Card Reports flow could become core for reuse | `games/pokemon/catalog/missing_cards.py` | **Now** (S3) |
| `collection` | CardDisplay (**Now**, C2) + facets (Later) | `encode_cursor`, `cursor_key`, `decode_cursor`, `holding_keys`, `keyset_after`, `anchor_*`, `CollectionTotals`, `CollectionRevision`, the paging SQL, which takes the facet SQL fragment. **WP-C2 (Now):** `set_code` is selected from `catalog_set_code`, so the `set_codes` import goes | the router (5 routes), `CARD_KINDS`, the facet fragment (`CASE ca.card_kind`, `elemental_types`, `trainer_type`), `CollectionHoldingView` and the other Pokémon-typed models | `core/inventory/collection.py`; `games/pokemon/inventory/collection.py` | **Later** |
| `holdings` | CardDisplay | **WP-C2 (Now):** the leaf read selects `set_code` from `catalog_set_code`. After that, holdings has no Pokémon dependency: it is plain core and moves whole with the core modules (Later) | — | `core/inventory/holdings.py` | **Now** (C2); move Later |
| `social/friend_reads` | CardDisplay (**Now**, C2) + ReprintRules (Later) | **WP-C2:** `CARD_FACTS` selects `set_code` from `catalog_set_code`, which also serves `loans`, `trades`, `reports`, `trade_list`, `trade_inventory` and `loan_inventory`. Later: `reach` taking the equivalence CTE | the router, the Reprint Group CTE, `set_codes` | `core/social/friend_reads.py`; `games/pokemon/social/friend_reads.py` | **Later** |
| `swap_hints` | CardDisplay (**Now**, C2) + ReprintRules (Later) | **WP-C2:** the queries at lines 71 and 92 select `set_code`. Later: the hint ranking, taking the CTE | the Reprint Group CTE | `core/decks/swap_hints.py` + Pokémon CTE | **Later** |
| `want_list` | ReprintRules | `capture_want_list`, `combined`, `number_order`, `DISPLAY_FIELDS`, `edition_needs`, `deck_switch_candidates`, `DeckSwitch`, with the equivalence CTE and the line-display reader as parameters | the router, the CTE, the display query | `core/decks/want_list.py`; `games/pokemon/decks/want_list.py` | **Later** |
| `social/trade_matches` | ReprintRules | the match SQL, taking the equivalence CTE | the router, the Will accept CTE | `core/social/trade_matches.py`; `games/pokemon/social/trade_matches.py` | **Later** |
| `card_accepts` (core-sql) | ReprintRules | `WillAcceptRule` and the rule shape | the `printing` and `reprint_group` rules as a CTE over `catalog_printing.identity_id` | `core/trading/card_accepts.py` + Pokémon CTE | **Later** |
| `deck_list_display` | GameTypes | nothing | the whole file: `CardKind`, `TrainerType`, `DISPLAY_QUERY`, `DISPLAY_KEYS`, `read_line_display`, `with_line_display`. Core takes the reader as `display` | `games/pokemon/decks/line_display.py` | **Now** (D1) |
| `deck_ownership` | GameTypes | the ownership models and reads, and `SurplusHoldingBase(edition_id, quantity, version)`; `surplus_holdings` takes `display` and `holding` | `SurplusHolding(SurplusHoldingBase)` | `core/decks/ownership.py`; `games/pokemon/decks/models.py` | **Now** (D1) |
| `trade_wants` | GameTypes | `want_quantity`, `own_wants`, `own_rules`, `lower_trade_wants` and the limits (used by core `trade_inventory` and `social/trade_matches`) | the router (3 routes), the models, `read_trade_wants` | `core/trading/trade_wants.py`; `games/pokemon/trading/trade_wants.py` | **Now** (D1) |
| `decks` | DeckChecks | deck storage, the line commands, the revision check, `keep_response`, `replayed(…, *, display, fixup)`, `read_deck_list(…, *, display, line)`, index counts and paging, loans, contents, `DeckListLineBase`, game-free models | every route; `DeckDetail`, `DeckList`, `DeckListLine`, `DeckListCommandResult`, `DeckIndex*`; `basic_checks`, `TargetFormat`, the format checks, the `'standard'` replay fix-up, the `warm_deck` hosts | `core/decks/{store,index,loans,contents}.py`; `games/pokemon/decks/{routes,models,checks}.py` | **Now** (D1) |
| `publications` | DeckChecks | `TOKEN`, `PUBLIC_HEADERS`, `READ_ONLY`, `PublicModel`, the command and status models, `require_legal(*, checks)`, `mutate(…, *, snapshot, snapshot_model)`, `drain`, `authorized_writer`, `owned_*` | every route, `snapshot()`, `PublicSnapshot` and the `Public*` models, the check result | `core/publications/publish.py`; `games/pokemon/publications/{routes,models}.py` | **Now** (D2) |
| `public_deck` | DeckChecks | nothing | the whole file (no router; it parses `PublicSnapshot` into Printing rows; every importer is Pokémon) | `games/pokemon/publications/public_deck.py` | **Now** (D2) |
| `discovery` | DeckChecks | the cursor, `invalid_cursor`, `HEADERS`, `PAGE`, `listed_snapshots(*, parse)` | both routes, the legality cache, `CODE_SHA256`, `target_status`, `confirm`, `featured`, `cost`, `matches_query`, the models | `core/publications/discovery.py`; `games/pokemon/publications/discovery.py` | **Now** (D2) |
| `host_readiness` | CatalogReadiness | `Report`, `age`, `check`, `owner`, `signup` | `rules`, `generation`, `prices`, `scanner` (`catalog_targets.LIVE`, `MATCHING`, `load_active`). `-m app.host_readiness` stays as a root shim (pinned) | `core/ops/readiness.py`; `games/pokemon/ops/readiness.py`; shim | **Later** |

**CardDisplay is Now through a table and one view (WP-C1, WP-C2).** The display reads join
`catalog_printing_set_code` (one row per Printing; the only place that writes `coalesce(sc.code, pd.set_id, '')`)
instead of calling `set_codes.code_for`. The fallback is applied at read time (owner decision, option A).
`catalog_set_code` holds only the `set_codes.tsv` rows, and import and refresh never touch it. It stays Pokémon-backed,
core reads may select it, and no Riftbound filling is planned.
- **Search stays Pokémon:** `sets_for_code` and `DIGEST`, in `catalog_browse`, `collection_import_matcher`,
  `import_matching`, `import_aliases` and `scanner`, as does `code_for` in `catalog_browse`, `deck_import` and
  `import_publication`. `import_publication` reads a Published Deck snapshot, not a catalog row.
- After WP-C2, no core-bound module imports `set_codes`, so there is nothing to compose.

**GameTypes and DeckChecks are Now** (owner decision 2026-10-29), in WP-D1 and WP-D2. The game owns the response
models, and core owns the mechanics. `CardKind` and `TrainerType` stay Pokémon. `want_list` stays Later with
ReprintRules, and until then it imports `read_line_display` from `games/pokemon/decks/line_display`.

**Allow-list after the Now work: 2 lines.**
- `host_readiness -> games.pokemon.catalog.catalog_targets` (CatalogReadiness, Later).
- `want_list -> games.pokemon.decks.line_display` (`read_line_display`). WP-D1 creates it; ReprintRules removes it.

WP-D1 removes the 3 `decks` lines and never creates the `decks` → art hosts line from S2: the Pokémon routes pass the
hosts to `warm_deck`. WP-D2 removes the 6 `discovery` lines and the 2 `publications` lines.


## 1B. Deck and publication split, function by function (WP-D1, WP-D2; Now)

The pattern: **the game owns the response models, core owns the mechanics.**
- Route handler functions keep their names, because FastAPI builds operationIds from them.
- Every router moves whole to `games/pokemon`.
- Core functions take the game's pieces as keyword-only arguments with no default: `display` (the line-display reader),
  `line` and `holding` (the model classes to build), `fixup` (the replay fix-up), `checks` (the computed check
  result), `snapshot` (the snapshot builder) and `parse` (the snapshot parser).
- Inheritance is used only where core fields come first today: `DeckListLine(DeckListLineBase)` over
  `edition_id, quantity, in_deck`; `SurplusHolding(SurplusHoldingBase)` over `edition_id, quantity, version`;
  `DeckIndexEntry(TreeNode)` as today.

Rejected:
- `card_kind: str` in core: it changes the TS types.
- Pydantic generics: they rename schema components.
- A core `display: dict` field.

Not decided now:
- deck sections or zones on `deck_list_line`;
- a check interface in core (each game passes its result in).

Target paths:
- `core/decks/{store,index,ownership,loans,contents}.py`;
- `games/pokemon/decks/{routes,models,line_display,checks}.py`;
- `core/trading/trade_wants.py`, `games/pokemon/trading/trade_wants.py`;
- `core/publications/{publish,discovery}.py`;
- `games/pokemon/publications/{routes,models,discovery,public_deck}.py`.

No module from outside `app/social/` goes into a folder named `social`. The ported social rules (design-brief
WP-B3) treat every `social` package as the social area, where inventory reads and imports are pinned.

### `decks.py` (740 lines) → WP-D1

| Symbol (line) | Destination | Note |
|---|---|---|
| `router` (26) and the 11 routes: `create_deck` (259), `edit_deck` (276), `deck_index` (309), `deck_detail` (441), `add_deck_list_line` (547), `change_deck_list_line` (573), `remove_deck_list_line` (593), `set_target_format` (612), `set_deck_cover` (633), `change_deck_list` (667), `deck_contents` (739) | `games/pokemon/decks/routes.py` | one router, same order. The bodies call core |
| `CreateDeck` (30), `EditDeck` (35), `AddDeckListLine` (122), `ChangeDeckListLine` (129), `RemoveDeckListLine` (135), `SetDeckCover` (140), `DeckCoverResult` (146), `DeckListChange` (163), `ChangeDeckList` (169), `MAX_DECK_LIST_CHANGES` (160) | `core/decks/store.py` | game-free request and result models |
| `DeckEditionQuantity` (83), `DeckContents` (88), `capture_deck_contents` (707), `change_quantity` (659) | `core/decks/contents.py` | game-free |
| `LoanLabel` (187), `DeckLoanLine` (193), `read_deck_loans` (205) | `core/decks/loans.py` | as the owner specified |
| `deck_cursor_encode` (280), `deck_cursor_decode` (287) | `core/decks/index.py` | index paging |
| `index_summaries` (333), its counting half | `core/decks/index.py` as `index_counts(conn, user_id, deck_ids) -> dict[UUID, IndexCounts]` | lines 339-358 unchanged: the holdings and borrowed copies, the picks, the lines, `totals` (the to-get counts). `IndexCounts` is a frozen dataclass `(deck_list_total: int, in_deck: int, lines: list[tuple[UUID, int]], pick: UUID \| None)`, not a response model |
| `index_summaries`, its Pokémon half | `games/pokemon/decks/routes.py`, same name and return shape | reads `target_format` (lines 341-342, a Format value), calls `index_counts` and `cover_candidates`, reads the line display and picks the cover with the "a Pokémon first" key (line 366), builds `DeckIndexCover` |
| `cover_candidates` (374) | `core/decks/index.py`, unchanged | already game-free. The owner's `prefer` parameter is not needed: the Pokémon tie-break runs after it, in the Pokémon half |
| `require_deck` (414), `check_revision` (476), `line_exists` (485), `write_deck_list` (490), `advance_deck_list` (507), `keep_response` (533), `read_cover` (466) | `core/decks/store.py` | `trade_inventory`, `deck_pick_list` and `deck_list_printing` import these |
| `read_deck_list` (421) | `core/decks/store.py` as `read_deck_list(conn, user, deck, *, display, line)` | |
| `replayed` (519) | `core/decks/store.py` as `replayed(conn, response, *, display, fixup)` | the `'standard'` fix-up (lines 524-530) becomes the Pokémon `fixup` |
| `store_deck_list_result` (541), `read_target_format` (471) | `games/pokemon/decks/routes.py` | they build `DeckListCommandResult` and read `TargetFormat` |
| `DeckIndexCover` (39), `DeckIndexEntry` (47), `DeckIndex` (61), `IdentityCheck` (67), `DeckChecks` (74), `DeckListLine` (94), `DeckList` (117), `SetTargetFormat` (151), `DeckListCommandResult` (175), `DeckDetail` (228) | `games/pokemon/decks/models.py` | same names, fields and order. `DeckListLine` inherits core `DeckListLineBase` |
| `CHECK_SOURCES` (387), `basic_checks` (395) | `games/pokemon/decks/checks.py` | Basic Energy and four-copy checks, using `construction_checks` |
| import `art_store.warm_deck` | the Pokémon routes pass the Pokémon art hosts | removes the `decks` → art-hosts allow-list line |

### `deck_ownership.py` (204 lines) → WP-D1

| Symbol (line) | Destination | Note |
|---|---|---|
| `ElsewhereLocation` (25), `LineOwnership` (33), `CompetingDeck` (69), `CompetitionWarning` (78), `DeckOwnership` (90) | `core/decks/ownership.py` | game-free |
| `held_in` (96), `_DECK` (103), `beyond_list` (106), `read_ownership` (126) | `core/decks/ownership.py` | |
| `surplus_holdings` (119) | `core/decks/ownership.py` as `surplus_holdings(…, *, display, holding)` | `holding` is the Pokémon `SurplusHolding` class |
| `SurplusHolding` (47) | `games/pokemon/decks/models.py`, inheriting core `SurplusHoldingBase(edition_id, quantity, version)` | |

### `deck_list_display.py`, `construction_checks.py`, `deck_format_checks.py` → WP-D1

| File | Destination |
|---|---|
| `deck_list_display` | `games/pokemon/decks/line_display.py`: `CardKind`, `TrainerType`, `DISPLAY_QUERY`, `DISPLAY_KEYS`, `read_line_display`, `with_line_display`. Core takes `display` as an argument; nothing of it stays in core |
| `construction_checks`, `deck_format_checks` | `games/pokemon/formats/` (already Pokémon-only in section 1; WP-I1 moves them). WP-D1 only rewires their callers |

### `publications.py` (430 lines) → WP-D2

| Symbol (line) | Destination | Note |
|---|---|---|
| `router` (24) and the 9 routes: `publication_status` (357), `publish` (368), `republish` (373), `revoke` (378), `set_visibility` (383), `owned_publications` (388), `revoke_publication` (399), `set_publication_visibility` (404), `public_snapshot` (409) | `games/pokemon/publications/routes.py` | one router, same order |
| `TOKEN` (25), `PUBLIC_HEADERS` (26), `READ_ONLY` (30), `PublicModel` (33) | `core/publications/publish.py` | `social/friends`, `social/profile`, `public_deck`, `discovery` and `import_publication` import these |
| `PublishCommand` (95), `RevokeCommand` (109), `VisibilityCommand` (113), `PublicationStatus` (118), `PublicationResult` (126), `OwnedPublication` (132), `OwnedPublications` (142) | `core/publications/publish.py` | game-free |
| `owned_deck` (146), `owned_publication` (151), `drain` (227), `authorized_writer` (239), `mutate` (256) | `core/publications/publish.py`. `mutate` takes `*, snapshot, snapshot_model` (the Pokémon snapshot builder, and `PublicSnapshot`, which the visibility path validates against at lines 302-306) | snapshot storage and the projection drain stay core |
| `require_legal` (159) | `core/publications/publish.py` as `require_legal(*, checks)` | core keeps "publishing needs a passing check". Pokémon computes `checks` (`held_format_checks` in the Target Format) |
| `snapshot` (180) | `games/pokemon/publications/routes.py` | it builds the Pokémon snapshot: display fields, construction checks, Target Format |
| `PublicEdition` (37), `PublicIdentity` (63), `PublicIdentityCheck` (69), `PublicChecks` (75), `PublicSnapshot` (83) | `games/pokemon/publications/models.py` | same names and fields |

### `discovery.py` (331 lines) → WP-D2

| Symbol (line) | Destination | Note |
|---|---|---|
| `router` (49), `discover` (280), `sitemap` (325) | `games/pokemon/publications/discovery.py` | one router |
| `HEADERS` (50), `PAGE` (51), `invalid_cursor` (100), `cursor_encode` (104), `cursor_decode` (110) | `core/publications/discovery.py` | paging. The cursor's `format_name` is an opaque string to core |
| `listed_snapshots` (133) | `core/publications/discovery.py` as `listed_snapshots(*, parse)` | listing. `parse` is the Pokémon `public_deck.parse_record` |
| `DISCOVER_SECONDS` (54), `CHUNK` (57), `CACHE_ENTRIES` (58), `_cache` and `_cache_lock` (150-151) | `games/pokemon/publications/discovery.py` | the legality cache and time budget of `confirm` |
| `matches_query` (266), `_order_key` (275) | `games/pokemon/publications/discovery.py` | they read `PublicSnapshot` fields (`identities`, `printing_name`, `published_at`) |
| `DiscoverCost` (74) | `games/pokemon/publications/models.py` | only `PublicDeckSummary` uses it |
| `CODE_SHA256` (61) | `games/pokemon/publications/discovery.py` | it hashes the Pokémon rule modules' bytes. After WP-D1 and WP-I1 its file list must name the new files, so a code change still invalidates the cache |
| `_fact_value` (154), `facts_revision` (162), `target_status` (172), `cost` (197), `featured` (215), `summary` (233), `confirm` (245) | `games/pokemon/publications/discovery.py` | format facts, Target Format status, cost (`summarize` plus Pokémon prices), the "rule-box Pokémon" featured card, the legal-on-date filter |
| `PublicCheckSummary` (66), `PublicDeckSummary` (81), `DiscoveryPage` (94) | `games/pokemon/publications/models.py` | |

### Other users of `CardKind` or these models

| Module | Placement | Phase |
|---|---|---|
| `public_deck` | `games/pokemon/publications/public_deck.py`, whole. It has no router. `parse_record` (101) validates `PublicSnapshot` and builds Printing rows from its fields. Every importer is Pokémon (`published_format_checks`, `import_publication`, `discovery`) | **Now** (D2) |
| `published_cost`, `published_format_checks`, `published_live_export`, `published_mass_entry` | already Pokémon (section 1, and S1). Only their imports of `PublicSnapshot` and `TOKEN` change | **Now** (D2 imports) |
| `trade_wants` | `games/pokemon/trading/trade_wants.py`: the router, `get_trade_wants`, `set_trade_want`, `set_will_accept`, the models `TradeWantLine`, `WillAcceptChoice`, `TradeWants`, `SetTradeWant`, `SetWillAccept`, and `read_trade_wants` (it builds `TradeWants` from `read_line_display`). `core/trading/trade_wants.py`: `MAX_TRADE_WANTS`, `MAX_TRADE_WANT_COPIES`, `AVAILABLE`, `want_quantity`, `own_wants`, `own_rules`, `lower_trade_wants` (used by core `trade_inventory` and `social/trade_matches`) | **Now** (D1) |
| `want_list` | Later with ReprintRules (the Reprint Group swap SQL). Until then it imports `games/pokemon/decks/line_display.read_line_display`: **1 allow-list line** | **Later** |
| `import_replace`, `import_publication` | Pokémon (S3). Only their imports change | Now |

## 2. Import crossings (non-Pokémon → Pokémon), today

These are the edges a boundary check sees once the Pokémon modules move into `games/pokemon`. All 34 go on the initial
allow-list. The Now packages remove 33 of them: 29 through the splits (11 of those in WP-D1 and WP-D2), and 4
`set_codes` edges through WP-C2. The one edge of a Later file (`host_readiness`) stays, and WP-D1 adds one
(`want_list` → the Pokémon line display), so 2 lines remain after Now.

Since no core or core-sql module appears on the importer side, the Later core move adds no new edge.

The two `importlib` literals in `price_runner.py` (lines 114 and 119; line 620 repeats the same two names) are
rewritten to the new dotted paths in WP-I1 and removed by WP-S2, where the runner gets its sources as parameters.

Edges between Pokémon modules (for example `collection_import_*`), and from Pokémon modules into core or mixed modules,
are the allowed direction and are not listed. Neither are `main.py` edges, which are the composition root.

| Importer (class) | Pokémon module | Symbols | Seam that replaces it | Initial allow-list |
|---|---|---|---|---|
| `collection` (mixed) | `set_codes` | *module* | CardDisplay + CardFacets | **removed by WP-C2** (reads `catalog_set_code`) |
| `collection_import` (mixed) | `collection_import_finish` | *module* | CollectionImportReaders | yes, removed by its Now package |
| `collection_import` (mixed) | `collection_import_matcher` | *module* | CollectionImportReaders | yes, removed by its Now package |
| `collection_import` (mixed) | `collection_import_reader` | *module* | CollectionImportReaders | yes, removed by its Now package |
| `deck_cost` (mixed) | `prices` | *module* | MarketplacePrices | yes, removed by its Now package |
| `deck_list_printing` (mixed) | `prices` | *module* | MarketplacePrices | yes, removed by its Now package |
| `decks` (mixed) | `construction_checks` | DISCLAIMER, IdentityCount, evaluate_checks | DeckChecks + GameTypes | yes, removed by WP-D1 |
| `decks` (mixed) | `deck_format_checks` | DeckFormatChecks, TargetFormat, command_format_checks, held_format_checks | DeckChecks + GameTypes | yes, removed by WP-D1 |
| `decks` (mixed) | `format_evaluator` | FORMATS | DeckChecks + GameTypes | yes, removed by WP-D1 |
| `discovery` (mixed) | `card_attributes` | *module* | DeckChecks + MarketplacePrices | yes, removed by WP-D2 |
| `discovery` (mixed) | `deck_format_checks` | *module*, TargetFormat, today | DeckChecks + MarketplacePrices | yes, removed by WP-D2 |
| `discovery` (mixed) | `format_evaluator` | *module* | DeckChecks + MarketplacePrices | yes, removed by WP-D2 |
| `discovery` (mixed) | `prices` | *module* | DeckChecks + MarketplacePrices | yes, removed by WP-D2 |
| `discovery` (mixed) | `public_catalog` | *module*, marketplace_states | DeckChecks + MarketplacePrices | yes, removed by WP-D2 |
| `discovery` (mixed) | `published_format_checks` | *module* | DeckChecks + MarketplacePrices | yes, removed by WP-D2 |
| `holdings` (mixed) | `set_codes` | *module* | CardDisplay | **removed by WP-C2** (reads `catalog_set_code`) |
| `host_readiness` (mixed) | `catalog_targets` | LIVE, MATCHING, load_active | CatalogReadiness (+ identity, Later) | yes, until Later |
| `import_match_core` (mixed) | `catalog_browse` | NUMBER_KEY, _rules_release_dates | DecklistText + CatalogSearch | yes, removed by its Now package |
| `import_match_core` (mixed) | `decklist_text` | CardLine | DecklistText + CatalogSearch | yes, removed by its Now package |
| `import_owned` (mixed) | `import_energy_matching` | CATALOG_NAME | DecklistText (energy grouping) | yes, removed by its Now package |
| `import_publication` (mixed) | `decklist_text` | CardLine, MAX_CARD_LINES | DecklistText + CardDisplay | yes, removed by its Now package |
| `import_publication` (mixed) | `set_codes` | *module* | DecklistText + CardDisplay | yes, removed by its Now package |
| `missing_cards` (mixed) | `card_identity` | card_identity_key | CatalogSource (manual entries) | yes, removed by its Now package |
| `missing_cards` (mixed) | `public_catalog` | publish_catalog_best_effort | CatalogSource (manual entries) | yes, removed by its Now package |
| `price_runner` (mixed) | `price_source` | importlib | QuoteSource | yes, removed by its Now package |
| `price_runner` (mixed) | `tcgdex_record` | importlib | QuoteSource | yes, removed by its Now package |
| `publications` (mixed) | `construction_checks` | DISCLAIMER, IdentityCount, evaluate_checks | DeckChecks + GameTypes | yes, removed by WP-D2 |
| `publications` (mixed) | `deck_format_checks` | TargetFormat, held_format_checks | DeckChecks + GameTypes | yes, removed by WP-D2 |
| `published_cost` (mixed) | `prices` | *module* | MarketplacePrices | yes, removed by its Now package |
| `published_cost` (mixed) | `public_catalog` | marketplace_states | MarketplacePrices | yes, removed by its Now package |
| `social/friend_reads` (mixed) | `set_codes` | *module* | CardDisplay + ReprintRules | **removed by WP-C2** (reads `catalog_set_code`) |
| `swap_hints` (mixed) | `set_codes` | *module* | CardDisplay + ReprintRules | **removed by WP-C2** (reads `catalog_set_code`) |
| `trade_value` (mixed) | `prices` | *module* | MarketplacePrices | yes, removed by its Now package |
| `want_list_cost` (mixed) | `prices` | *module* | MarketplacePrices | yes, removed by its Now package |
| `want_list` (mixed, Later) | `games/pokemon/decks/line_display` (after WP-D1) | read_line_display | ReprintRules | added by WP-D1; stays until Later |

## 3. Tables and views

Target databases:
- **auth:** the gateway's database.
- **game-core:** core tables that every game database has.
- **game-pokemon:** the Pokémon track's tables.
- **split:** `collector_profile` and `operations_counter`. The handling of each is in its row's note and in section 5.

Phase: the auth rows and the split rows' auth halves are **Later (Riftbound)**. Every game table stays in the Pokémon
database both Now and Later. Attributing them to core or pokemon matters only for the Later core baseline. Nothing moves
physically in the Pokémon database.

| Table / view | Kind | Target database | Created | Altered by (first 6) | Dropped by | Note |
|---|---|---|---|---|---|---|
| `account` | table | auth | 002_auth.sql |  |  |  |
| `auth_rate_event` | table | auth | 040_auth_rate_event.sql |  |  |  |
| `auth_send_event` | table | auth | 001_inventory.sql |  |  |  |
| `owner_binding` | table | auth | 001_inventory.sql |  |  |  |
| `released_handle` | table | auth | 100_collector_profile.sql |  |  |  |
| `session` | table | auth | 002_auth.sql |  |  |  |
| `user` | table | auth | 002_auth.sql |  |  |  |
| `verification` | table | auth | 002_auth.sql |  |  |  |
| `art_fetch_failure` | table | game-core | 156_art_store.sql |  |  |  |
| `art_hit` | table | game-core | 156_art_store.sql |  |  |  |
| `art_object` | table | game-core | 156_art_store.sql |  |  |  |
| `block` | table | game-core | 103_blocks.sql | 148_trade_reach.sql |  |  |
| `borrowed_holding` | table | game-core | 110_borrowed_holding.sql |  |  |  |
| `collection_import` | table | game-core | 050_collection_import.sql |  |  |  |
| `collection_import_row` | table | game-core | 050_collection_import.sql |  |  |  |
| `collection_import_start` | table | game-core | 051_collection_import_start.sql |  |  |  |
| `conversation` | table | game-core | 147_conversations.sql |  |  |  |
| `conversation_member` | table | game-core | 147_conversations.sql |  |  |  |
| `deck_cover` | table | game-core | 052_deck_cover.sql |  |  |  |
| `deck_list` | table | game-core | 029_deck_lists.sql | 045_deck_list_target_format.sql |  |  |
| `deck_list_line` | table | game-core | 029_deck_lists.sql |  |  |  |
| `deck_publication` | table | game-core | 015_publications.sql | 032_publications_outlive_decks.sql |  |  |
| `discovery_setting` | table | game-core | 145_open_discovery.sql |  |  |  |
| `friend_request_declined` | table | game-core | 103_blocks.sql |  |  |  |
| `friendship` | table | game-core | 102_friends.sql | 148_trade_reach.sql |  |  |
| `handle_lookup_event` | table | game-core | 100_collector_profile.sql | 103_blocks.sql, 105_loans.sql, 141_trades.sql, 145_open_discovery.sql |  |  |
| `holding` | table | game-core | 006_add_holdings.sql |  |  |  |
| `inbox_update` | table | game-core | 130_inbox.sql | 144_trade_inbox.sql |  |  |
| `inventory_owner` | table | game-core | 001_inventory.sql | 004_location_tree.sql, 049_want_list_counting.sql |  |  |
| `inventory_undo` | table | game-core | 012_inventory_undo.sql | 026_multi_source_moves.sql, 046_inventory_undo_add.sql, 047_put_away_undo_returns_surplus.sql |  |  |
| `invite_link` | table | game-core | 100_collector_profile.sql |  |  |  |
| `invite_projection_outbox` | table | game-core | 100_collector_profile.sql |  |  |  |
| `loan` | table | game-core | 105_loans.sql | 107_loan_two_collectors.sql, 125_loan_return_by.sql, 131_loan_waiting_times.sql |  |  |
| `loan_line` | table | game-core | 105_loans.sql |  |  |  |
| `loan_notice_seen` | table | game-core | 125_loan_return_by.sql | 126_loan_notice_kinds.sql, 130_inbox.sql |  |  |
| `loan_pick` | table | game-core | 105_loans.sql |  |  |  |
| `loan_return` | table | game-core | 120_loan_returns.sql |  |  |  |
| `loan_return_line` | table | game-core | 120_loan_returns.sql |  |  |  |
| `location` | table | game-core | 001_inventory.sql | 006_add_holdings.sql, 101_hidden_locations.sql, 140_for_trade_locations.sql |  |  |
| `location_command` | table | game-core | 004_location_tree.sql |  |  |  |
| `message` | table | game-core | 147_conversations.sql |  |  |  |
| `missing_card_report` | table | game-core | 007_missing_card_reports.sql |  |  |  |
| `moderation_event` | table | game-core | 149_trade_reports.sql |  |  |  |
| `move_manifest` | table | game-core | 011_move_holdings.sql | 026_multi_source_moves.sql |  |  |
| `move_manifest_entry` | table | game-core | 026_multi_source_moves.sql |  |  |  |
| `move_manifest_item` | table | game-core | 011_move_holdings.sql |  |  |  |
| `move_response` | table | game-core | 011_move_holdings.sql | 026_multi_source_moves.sql, 046_inventory_undo_add.sql |  |  |
| `mutation_request` | table | game-core | 006_add_holdings.sql | 008_mutation_request_item_free.sql |  |  |
| `mutation_response` | table | game-core | 009_add_response_cache.sql |  |  |  |
| `open_discovery` | view | game-core | 145_open_discovery.sql |  |  |  |
| `operations_alert` | table | game-core | 019_operations.sql |  |  |  |
| `operations_hour` | table | game-core | 019_operations.sql |  |  |  |
| `operations_quota` | table | game-core | 019_operations.sql |  |  |  |
| `operations_state` | table | game-core | 019_operations.sql |  |  |  |
| `publication_command` | table | game-core | 015_publications.sql |  |  |  |
| `trade` | table | game-core | 141_trades.sql | 147_conversations.sql |  |  |
| `trade_accept` | table | game-core | 143_trade_wants.sql |  |  |  |
| `trade_line` | table | game-core | 141_trades.sql |  |  |  |
| `trade_pick` | table | game-core | 141_trades.sql |  |  |  |
| `trade_report` | table | game-core | 149_trade_reports.sql |  |  |  |
| `trade_report_message` | table | game-core | 149_trade_reports.sql |  |  |  |
| `trade_report_trade` | table | game-core | 149_trade_reports.sql |  |  |  |
| `trade_want` | table | game-core | 143_trade_wants.sql |  |  |  |
| `zip_centroid` | table | game-core | 146_zip_centroids.sql |  |  |  |
| `catalog_approval_code` | table | game-pokemon | 007_missing_card_reports.sql | 016_catalog_reconciliation.sql, 023_metadata_review.sql, 033_card_attribute_corrections.sql, 037_reviewed_reprint_groups.sql |  |  |
| `catalog_attribute_correction` | table | game-pokemon | 033_card_attribute_corrections.sql | 038_basic_pokemon.sql, 041_trainer_type_and_evolves_from.sql |  |  |
| `catalog_attribute_decision` | table | game-pokemon | 033_card_attribute_corrections.sql |  |  |  |
| `catalog_attribute_report` | table | game-pokemon | 033_card_attribute_corrections.sql |  |  |  |
| `catalog_attribute_state` | table | game-pokemon | 030_card_attributes.sql |  |  |  |
| `catalog_card_attribute` | view | game-pokemon | 030_card_attributes.sql |  |  |  |
| `catalog_card_identity_decision` | table | game-pokemon | 037_reviewed_reprint_groups.sql | 159_confirm_reprint_group_decision.sql |  |  |
| 160_catalog_set_code.sql (**planned, WP-C1**) | pokemon | | game-pokemon: `catalog_set_code` (create + 136 rows). Later `NNN_set_codes.sql` files replace the rows whenever `set_codes.tsv` changes, enforced by a guardrail |
| `catalog_check` | table | game-pokemon | 151_catalog_check.sql |  |  |  |
| `catalog_derived_attribute` | table | game-pokemon | 030_card_attributes.sql | 038_basic_pokemon.sql, 041_trainer_type_and_evolves_from.sql |  |  |
| `catalog_derived_reprint_group` | table | game-pokemon | 035_reprint_groups.sql |  |  |  |
| `catalog_edition` | table | game-pokemon | 003_catalog.sql | 021_edition_metadata.sql |  |  |
| `catalog_edition_metadata` | table | game-pokemon | 021_edition_metadata.sql | 022_mapping_evidence.sql, 023_metadata_review.sql |  |  |
| `catalog_edition_replacement` | table | game-pokemon | 016_catalog_reconciliation.sql |  |  |  |
| `catalog_evolution_root` | table | game-pokemon | 043_evolution_roots.sql |  |  |  |
| `catalog_format_standing` | table | game-pokemon | 042_format_standing.sql |  |  |  |
| `catalog_format_standing_key` | table | game-pokemon | 042_format_standing.sql |  |  |  |
| `catalog_generation` | table | game-pokemon | 003_catalog.sql |  |  |  |
| `catalog_generation_edition` | table | game-pokemon | 003_catalog.sql |  |  |  |
| `catalog_generation_printing` | table | game-pokemon | 003_catalog.sql | 048_catalog_name_search.sql |  |  |
| `catalog_set_code` (**new, WP-C1**) | table | game-pokemon | 160_catalog_set_code.sql (planned) |  |  | set level: one row per `set_codes.tsv` row; readers fall back to `set_id` with `coalesce` |
| `catalog_printing_set_code` (**new, WP-C1**) | view | game-pokemon | 160_catalog_set_code.sql (planned) |  |  | one row per Printing: `coalesce(sc.code, pd.set_id, '')`, the only copy of the fallback |
| `catalog_generation_set` | table | game-pokemon | 044_catalog_set_release.sql | 155_set_series.sql |  |  |
| `catalog_generation_set_count` | table | game-pokemon | 150_scanner_catalog_data.sql |  |  |  |
| `catalog_identity` | table | game-pokemon | 003_catalog.sql | 037_reviewed_reprint_groups.sql |  |  |
| `catalog_metadata_decision` | table | game-pokemon | 023_metadata_review.sql |  |  |  |
| `catalog_metadata_rejection` | table | game-pokemon | 023_metadata_review.sql |  |  |  |
| `catalog_metadata_report` | table | game-pokemon | 023_metadata_review.sql | 023_metadata_review.sql |  |  |
| `catalog_override` | table | game-pokemon | 007_missing_card_reports.sql |  |  |  |
| `catalog_printing` | table | game-pokemon | 003_catalog.sql | 021_edition_metadata.sql |  |  |
| `catalog_printing_art` | view | game-pokemon | 154_fallback_art.sql |  |  |  |
| `catalog_printing_display` | table | game-pokemon | 016_catalog_reconciliation.sql |  |  |  |
| `catalog_printing_fallback_art` | table | game-pokemon | 154_fallback_art.sql |  |  |  |
| `catalog_printing_metadata` | table | game-pokemon | 021_edition_metadata.sql | 023_metadata_review.sql, 027_card_attributes.sql |  |  |
| `catalog_printing_replacement` | table | game-pokemon | 016_catalog_reconciliation.sql |  |  |  |
| `catalog_public_clock` | table | game-pokemon | 023_metadata_review.sql |  |  |  |
| `catalog_public_outbox` | table | game-pokemon | 023_metadata_review.sql |  |  |  |
| `catalog_reprint_group_assignment` | table | game-pokemon | 037_reviewed_reprint_groups.sql |  |  |  |
| `catalog_reprint_group_effective` | view | game-pokemon | 037_reviewed_reprint_groups.sql |  |  |  |
| `catalog_reprint_group_link` | table | game-pokemon | 037_reviewed_reprint_groups.sql |  |  |  |
| `catalog_reprint_group_member` | view | game-pokemon | 035_reprint_groups.sql |  |  |  |
| `catalog_reprint_group_membership` | table | game-pokemon | 037_reviewed_reprint_groups.sql |  |  |  |
| `catalog_review` | table | game-pokemon | 003_catalog.sql | 016_catalog_reconciliation.sql, 018_reference_drift.sql |  |  |
| `catalog_rule_activation` | table | game-pokemon | 023_metadata_review.sql | 157_rule_rollout.sql |  |  |
| `catalog_rule_rollout` | table | game-pokemon | 157_rule_rollout.sql |  |  |  |
| `catalog_rule_state` | table | game-pokemon | 023_metadata_review.sql |  |  |  |
| `catalog_run` | table | game-pokemon | 003_catalog.sql |  |  |  |
| `catalog_source_reference` | table | game-pokemon | 016_catalog_reconciliation.sql |  |  |  |
| `catalog_state` | table | game-pokemon | 003_catalog.sql | 003_catalog.sql |  |  |
| `deck_format_result` | table | game-pokemon | 034_deck_format_results.sql |  |  |  |
| `edition_price_binding` | table | game-pokemon | 153_price_binding.sql |  |  |  |
| `price_import` | table | game-pokemon | 152_tcgcsv_prices.sql |  |  |  |
| `public_price_ref` | table | game-pokemon | 153_price_binding.sql |  |  |  |
| `scanner_fingerprint` | table | game-pokemon | 150_scanner_catalog_data.sql |  |  |  |
| `scanner_fingerprint_failure` | table | game-pokemon | 150_scanner_catalog_data.sql |  |  |  |
| `scanner_index` | table | game-pokemon | 150_scanner_catalog_data.sql |  |  |  |
| `tcgplayer_price` | table | game-pokemon | 152_tcgcsv_prices.sql |  |  |  |
| `tcgplayer_product` | table | game-pokemon | 152_tcgcsv_prices.sql |  |  |  |
| `collector_profile` | table | split | 100_collector_profile.sql | 143_trade_wants.sql, 145_open_discovery.sql |  | split: identity columns → auth; full row stays as game mirror |
| `operations_counter` | table | split | 019_operations.sql | 040_auth_rate_event.sql |  | game-core; gateway names (sign_in_delivered, sign_in_failed, too_many_sign_ups) → auth copy |

### 3.1 Foreign keys that cross a boundary, and what happens to each

| From → to | Count | FKs | What happens |
|---|---:|---|---|
| game-core → game-pokemon | 15 | `holding.edition_id`, `deck_list_line.edition_id`, `loan_line.edition_id`, `borrowed_holding.edition_id`, `trade_line.edition_id`, `trade_want.edition_id`, `trade_accept.edition_id` → `catalog_edition`; `collection_import_row.printing_id`/`edition_id`; `missing_card_report.printing_id`, `approved_printing_id`, `approved_edition_id`; `art_object`, `art_hit`, `art_fetch_failure.printing_id` → `catalog_printing` | **Now:** unchanged. **Later:** unchanged in the Pokémon database. The core baseline omits them, and each game track adds them after its catalog tables exist (design-brief D9). |
| game-pokemon → game-core | 15 | 12 reviewer, reporter or owner columns on `catalog_*` review and decision tables → `inventory_owner`; `catalog_approval_code.report_id` and `catalog_override.report_id` → `missing_card_report`; `deck_format_result(owner_id, deck_id)` → `deck_list` | Same database, allowed direction. They stay, owned by the pokemon track. A new game's equivalents point at the same core tables. |
| game-core → split `collector_profile` | 8 | `invite_link.user_id`; `friendship.user_low`/`user_high`; `block.blocker_id`/`blocked_id`; `friend_request_declined.sender_id`/`recipient_id`; `discovery_setting.user_id` (all `ON DELETE CASCADE`) | They stay, pointing at the game-database mirror. Account deletion (future) reaches them through each backend's deletion route, not across databases. |
| split `collector_profile` → game-core `inventory_owner` | 1 | `collector_profile.user_id` (`100:9`, CASCADE) | The game mirror keeps it. The auth copy references `"user"(id)` instead (**Later**). |
| auth `owner_binding` → game-core `inventory_owner` | 1 | `owner_binding.user_id` (`001:16-19`) | The auth copy references `"user"(id)` (**Later**). The legacy game table stays, unused, until the drop decision (design-brief Q5). |
| within auth | — | `session.userId`, `account.userId` → `"user"` (`002`, CASCADE) | They move together and are unchanged. |

No API table has an FK to `"user"`, `session`, `account` or `verification` today. User ids cross as plain `text`, as
ADR 0022 says.


## 4. Migrations

The tracks follow design-brief D10:
- the 82 existing files stay at `migrations/` as the **pokemon** track, under their recorded names, and none re-runs;
- the **core** track starts at `core/000_baseline.sql` (Later);
- the **auth** track starts at `auth/001_baseline.sql` (Later).

"Track(s) by content" says which target database each file's objects belong to. It decides what the Later baselines
must copy; it does not move any file.

Files flagged **MIXED** hold objects of more than one database. Their parts are copied into the baselines rather than
split, because the live Pokémon database must keep their history. "FK crosses" marks game-core files that create an FK
into the Pokémon catalog; the core baseline drops those FKs.

Phase: **Now**, nothing changes in `migrations/`. **Later (Riftbound)**, the three tracks and the baselines are added.

| File | Track(s) by content | Flag | Objects touched (by target database) |
|---|---|---|---|
| 001_inventory.sql | auth+core | **MIXED** FK crosses: `owner_binding.user_id`→`inventory_owner` | game-core: `inventory_owner`, `location`; auth: `owner_binding`, `auth_send_event` |
| 002_auth.sql | auth |  | auth: `user`, `session`, `account`, `verification` |
| 003_catalog.sql | pokemon |  | game-pokemon: `catalog_state`, `catalog_run`, `catalog_identity`, `catalog_printing`, `catalog_edition` … |
| 004_location_tree.sql | core |  | game-core: `location_command`, `inventory_owner`, `location` |
| 005_catalog_search.sql | pokemon |  | game-pokemon: `catalog_generation_printing` |
| 006_add_holdings.sql | core | FK crosses: `holding.edition_id`→`catalog_edition` | game-core: `holding`, `mutation_request`, `location` |
| 007_missing_card_reports.sql | core+pokemon | **MIXED** FK crosses: `missing_card_report.printing_id`→`catalog_printing`, `missing_card_report.approved_printing_id`→`catalog_printing`, `missing_card_report.approved_edition_id`→`catalog_edition` | game-core: `missing_card_report`; game-pokemon: `catalog_override`, `catalog_approval_code` |
| 008_mutation_request_item_free.sql | core |  | game-core: `mutation_request` |
| 009_add_response_cache.sql | core |  | game-core: `mutation_response` |
| 011_move_holdings.sql | core |  | game-core: `move_manifest`, `move_manifest_item`, `move_response` |
| 012_inventory_undo.sql | core |  | game-core: `inventory_undo`, `inventory_owner` |
| 013_collection_read_indexes.sql | core+pokemon | **MIXED** | game-core: `holding`; game-pokemon: `catalog_printing`, `catalog_edition` |
| 014_decks.sql | core |  | game-core: `location` |
| 015_publications.sql | core |  | game-core: `deck_publication`, `publication_command` |
| 016_catalog_reconciliation.sql | pokemon |  | game-pokemon: `catalog_printing_display`, `catalog_source_reference`, `catalog_edition_replacement`, `catalog_printing_replacement`, `catalog_review` … |
| 018_reference_drift.sql | pokemon |  | game-pokemon: `catalog_review` |
| 019_operations.sql | auth+core | **MIXED** | game-core: `operations_state`, `operations_hour`, `operations_alert`, `operations_quota`; split: `operations_counter` |
| 020_signup.sql | auth+core | **MIXED** | game-core: `inventory_owner`, `location`; auth: `user` |
| 021_edition_metadata.sql | pokemon |  | game-pokemon: `catalog_printing_metadata`, `catalog_edition_metadata`, `catalog_printing`, `catalog_edition` |
| 022_mapping_evidence.sql | pokemon |  | game-pokemon: `catalog_edition_metadata` |
| 023_metadata_review.sql | pokemon |  | game-pokemon: `catalog_public_clock`, `catalog_rule_activation`, `catalog_rule_state`, `catalog_metadata_report`, `catalog_metadata_decision` … |
| 026_multi_source_moves.sql | core |  | game-core: `move_manifest_entry`, `move_manifest`, `move_response`, `inventory_undo`, `move_manifest_item` |
| 027_card_attributes.sql | pokemon |  | game-pokemon: `catalog_printing_metadata` |
| 028_card_identity_subtitles.sql | pokemon |  | game-pokemon: `catalog_printing`, `catalog_identity`, `catalog_printing_metadata`, `catalog_state` |
| 029_deck_lists.sql | core | FK crosses: `deck_list_line.edition_id`→`catalog_edition` | game-core: `deck_list`, `deck_list_line`, `location` |
| 030_card_attributes.sql | pokemon |  | game-pokemon: `catalog_attribute_state`, `catalog_derived_attribute`, `catalog_card_attribute` |
| 031_deck_list_follows_moves.sql | core |  | game-core: `deck_list_line`, `deck_list`, `holding` |
| 032_publications_outlive_decks.sql | core |  | game-core: `deck_publication` |
| 033_card_attribute_corrections.sql | pokemon |  | game-pokemon: `catalog_attribute_decision`, `catalog_attribute_correction`, `catalog_attribute_report`, `catalog_card_attribute`, `catalog_approval_code` … |
| 034_deck_format_results.sql | pokemon |  | game-pokemon: `deck_format_result` |
| 035_reprint_groups.sql | pokemon |  | game-pokemon: `catalog_derived_reprint_group`, `catalog_reprint_group_member` |
| 036_public_format_facts.sql | pokemon |  | game-pokemon: `catalog_printing_metadata`, `catalog_derived_attribute`, `catalog_attribute_correction`, `catalog_printing`, `catalog_identity` … |
| 037_reviewed_reprint_groups.sql | pokemon |  | game-pokemon: `catalog_card_identity_decision`, `catalog_reprint_group_link`, `catalog_reprint_group_assignment`, `catalog_reprint_group_membership`, `catalog_reprint_group_effective` … |
| 038_basic_pokemon.sql | pokemon |  | game-pokemon: `catalog_card_attribute`, `catalog_derived_attribute`, `catalog_attribute_correction` |
| 039_deck_list_trigger_plans.sql | core |  | game-core: `deck_list_line`, `deck_list` |
| 040_auth_rate_event.sql | auth+core | **MIXED** | auth: `auth_rate_event`; split: `operations_counter` |
| 041_trainer_type_and_evolves_from.sql | pokemon |  | game-pokemon: `catalog_card_attribute`, `catalog_derived_attribute`, `catalog_attribute_correction` |
| 042_format_standing.sql | pokemon |  | game-pokemon: `catalog_format_standing`, `catalog_format_standing_key` |
| 043_evolution_roots.sql | pokemon |  | game-pokemon: `catalog_evolution_root` |
| 044_catalog_set_release.sql | pokemon |  | game-pokemon: `catalog_generation_set` |
| 045_deck_list_target_format.sql | core |  | game-core: `deck_list` |
| 046_inventory_undo_add.sql | core |  | game-core: `move_response`, `inventory_undo` |
| 047_put_away_undo_returns_surplus.sql | core |  | game-core: `inventory_undo`, `deck_list_line`, `deck_list` |
| 048_catalog_name_search.sql | pokemon |  | game-pokemon: `catalog_generation_printing` |
| 049_want_list_counting.sql | core |  | game-core: `inventory_owner` |
| 050_collection_import.sql | core | FK crosses: `collection_import_row.printing_id`→`catalog_printing`, `collection_import_row.edition_id`→`catalog_edition` | game-core: `collection_import`, `collection_import_row` |
| 051_collection_import_start.sql | core |  | game-core: `collection_import_start` |
| 052_deck_cover.sql | core |  | game-core: `deck_cover` |
| 100_collector_profile.sql | auth+core | **MIXED** FK crosses: `collector_profile.user_id`→`inventory_owner`, `invite_link.user_id`→`collector_profile` | split: `collector_profile`; auth: `released_handle`; game-core: `invite_link`, `invite_projection_outbox`, `handle_lookup_event`, `inventory_owner` |
| 101_hidden_locations.sql | core |  | game-core: `location` |
| 102_friends.sql | core | FK crosses: `friendship.user_low`→`collector_profile`, `friendship.user_high`→`collector_profile` | game-core: `friendship` |
| 103_blocks.sql | core | FK crosses: `block.blocker_id`→`collector_profile`, `block.blocked_id`→`collector_profile`, `friend_request_declined.sender_id`→`collector_profile`, `friend_request_declined.recipient_id`→`collector_profile` | game-core: `block`, `friend_request_declined`, `handle_lookup_event` |
| 105_loans.sql | core | FK crosses: `loan_line.edition_id`→`catalog_edition` | game-core: `loan`, `loan_line`, `loan_pick`, `handle_lookup_event`; split: `collector_profile` |
| 106_loan_promises.sql | core |  | game-core: `holding`, `loan`, `loan_line` |
| 107_loan_two_collectors.sql | core |  | game-core: `loan` |
| 110_borrowed_holding.sql | core | FK crosses: `borrowed_holding.edition_id`→`catalog_edition` | game-core: `borrowed_holding` |
| 115_borrowed_deck_lists.sql | core |  | game-core: `deck_list_line`, `deck_list`, `borrowed_holding` |
| 120_loan_returns.sql | core |  | game-core: `loan_return`, `loan_return_line` |
| 125_loan_return_by.sql | core |  | game-core: `loan_notice_seen`, `loan` |
| 126_loan_notice_kinds.sql | core |  | game-core: `loan_notice_seen` |
| 130_inbox.sql | core |  | game-core: `inbox_update`, `loan_notice_seen` |
| 131_loan_waiting_times.sql | core |  | game-core: `loan` |
| 140_for_trade_locations.sql | core |  | game-core: `location` |
| 141_trades.sql | core | FK crosses: `trade_line.edition_id`→`catalog_edition` | game-core: `trade`, `trade_line`, `trade_pick`, `handle_lookup_event`; split: `collector_profile` |
| 142_trade_promises.sql | core |  | game-core: `trade`, `trade_line` |
| 143_trade_wants.sql | core | FK crosses: `trade_want.edition_id`→`catalog_edition`, `trade_accept.edition_id`→`catalog_edition` | game-core: `trade_want`, `trade_accept`; split: `collector_profile` |
| 144_trade_inbox.sql | core |  | game-core: `inbox_update` |
| 145_open_discovery.sql | core | FK crosses: `discovery_setting.user_id`→`collector_profile` | game-core: `discovery_setting`, `open_discovery`, `handle_lookup_event`; split: `collector_profile` |
| 146_zip_centroids.sql | core |  | game-core: `zip_centroid` |
| 147_conversations.sql | core |  | game-core: `conversation`, `conversation_member`, `message`, `trade`; split: `collector_profile` |
| 148_trade_reach.sql | core |  | game-core: `block`, `friendship` |
| 149_trade_reports.sql | core |  | game-core: `trade_report`, `trade_report_message`, `trade_report_trade`, `moderation_event` |
| 150_scanner_catalog_data.sql | pokemon |  | game-pokemon: `catalog_generation_set_count`, `scanner_fingerprint`, `scanner_index`, `scanner_fingerprint_failure` |
| 151_catalog_check.sql | pokemon |  | game-pokemon: `catalog_check` |
| 152_tcgcsv_prices.sql | pokemon |  | game-pokemon: `price_import`, `tcgplayer_product`, `tcgplayer_price` |
| 153_price_binding.sql | pokemon |  | game-pokemon: `edition_price_binding`, `public_price_ref` |
| 154_fallback_art.sql | pokemon |  | game-pokemon: `catalog_printing_fallback_art`, `catalog_printing_art` |
| 155_set_series.sql | pokemon |  | game-pokemon: `catalog_generation_set` |
| 156_art_store.sql | core | FK crosses: `art_object.printing_id`→`catalog_printing`, `art_hit.printing_id`→`catalog_printing`, `art_fetch_failure.printing_id`→`catalog_printing` | game-core: `art_object`, `art_hit`, `art_fetch_failure` |
| 157_rule_rollout.sql | pokemon |  | game-pokemon: `catalog_rule_rollout`, `catalog_rule_activation` |
| 158_art_route_urls.sql | pokemon |  | game-pokemon: `catalog_printing_art` |
| 159_confirm_reprint_group_decision.sql | pokemon |  | game-pokemon: `catalog_card_identity_decision` |

## 5. Identity

Every item in this section is **Later (Riftbound)**. The Now work leaves identity as it is.

### 5.1 What moves to the auth database

| Object | Today | In the auth database | Stays in the game database |
|---|---|---|---|
| `"user"`, `session`, `account`, `verification` | `002_auth.sql:1-13` | whole tables | legacy copy, unused after the cutover, until the drop |
| `auth_send_event` | `001:21-27` | whole table | legacy copy |
| `auth_rate_event` | `040:5-13` | whole table | legacy copy |
| `operations_counter` | `019:20`, CHECK widened in `040:15-16` | a table of the same shape, written only with the gateway names `sign_in_delivered`, `sign_in_failed`, `too_many_sign_ups` | the table, for the API's own names (`release_failed` and others) |
| `owner_binding` | `001:16-19`, FK → `inventory_owner` | the singleton, FK → `"user"` | legacy copy |
| `released_handle` | `100:18-21` | whole table | legacy copy |
| `collector_profile` | `100:8-14` and later columns | `user_id`, `handle`, `handle_key`, `display_name` (if Display Name moves, design-brief Q1), `handle_changed_at`, with the CHECKs from `100:8-14` | the whole row as a mirror. `open_to_cash_offers` (`143:27`), `trader_id` (`145:14`) and `suspended_at` (`145:17`) stay authoritative here |
| `generated_handle()` | `100:54-64` | copied verbatim (the auth database generates new Handles) | stays (the mirror's placeholder trigger uses it) |
| `create_collector_profile(owner)` | `100:67-85` | not copied. The API's identity store makes the auth row | stays |
| trigger `onboard_auth_account` on `"user"` | `020:3-12` | **not** copied. The auth database cannot write game rows; the API already creates the owner row, `Unsorted` and the profile lazily | dead with the legacy `"user"` table |
| trigger `onboard_collector_profile` on `inventory_owner` | `100:89-96` | — | stays |
| triggers `queue_invite_record` | `100:101-122` | — | stay (the Invite Link is per game) |
| Display Name denormalising triggers | `105:81-87`, `141:88-95`, `147:147-154` | — | stay. They fire on mirror updates |
| `handle_lookup_event` and its kind CHECK widenings | `100:45-50`, `103:37-46`, `105:97-106`, `141:106-115`, `145:66-78` | — | stays: Friend, Loan, Trade and message limits are per game, and so is the Handle attempt limit |
| `invite_link`, `invite_projection_outbox`, `friendship`, `block`, `friend_request_declined`, `discovery_setting` | `100`, `102`, `103`, `145` | — | stay |
| `trade_report.reporter_handle`/`reported_handle` | `149:15-16` | — | stay (snapshots) |

### 5.2 Who owns what, under the two candidate designs

**Design A**, the one in design-brief D1 to D6. The API writes Handles into the auth database, and the owner binding is
read from the auth database.

- **Gateway owns:**
  - Better Auth sessions and accounts;
  - the sign-up gate and the `OWNER_EMAIL` admission rule;
  - the start, sign-up and send limits;
  - its counters;
  - request signing, with the message unchanged;
  - the auth track.
- **API owns:**
  - the Handle and Display Name rules (`social/name_rules.py`);
  - the attempt limit;
  - the Handle claim and change, run through `identity_store.py` on the auth database with a narrow role;
  - the game mirror (`sync_mirror`);
  - the owner check: a read of the auth `owner_binding`;
  - the operations panel's reads of the gateway counters.

**Design B**, the Riftbound spec's wording. Handle writes go through the gateway, and the owner flag is signed into each
request.

- **Gateway owns** everything in A, plus:
  - the Handle and Display Name rules, ported to TypeScript, with `name_filter_words.txt` shared as data;
  - `PUT /api/profile/handle` and `/display-name`. The gateway answers them itself, or receives them from the API on a
    signed internal route;
  - an outbox that pushes identity changes to each enabled backend's internal `PUT /internal/identity/{user_id}`;
  - an `x-internal-owner` claim added to the signed message (`server.ts:600-611`, `identity.py:28`).
- **API owns:**
  - applying pushed identity changes to the mirror;
  - `require_owner` from the signed flag;
  - background jobs (`rule_rollout`, `host_readiness`), which still need the owner id. They get it from a pushed mirror
    of the owner, or from a gateway read.

| | A: API writes, owner read from auth database | B: gateway writes, owner signed |
|---|---|---|
| Matches ADR 0022 and the spec | No (two deviations: Q2, Q3) | Yes |
| Frozen suites | `api/tests` unchanged. Every harness runs co-located | 11 API test files that sign requests need the new claim, ideally through one shared helper. 18 files that seed `owner_binding` need the owner signed or a mirror. Coverage of 7 Handle test files moves to `auth/tests`, or stays through the proxy |
| Who can write identity | the gateway, plus the API through a role limited to `collector_profile` and `released_handle` | the gateway only. This is the smaller blast radius |
| Who reads the owner | the API reads the auth database on each owner route and in each job | it is signed per request, so there is no API access to the auth database. Jobs need a pushed owner mirror |
| More than one backend | needs a change log that backends pull, added later (mirrors go stale until then) | the push outbox is the propagation path from day one |
| Two-database write | the auth database commits first, then the game transaction. Retry and read repair cover the gap | the gateway commits and its outbox delivers. The gap is the same, but one writer handles it, with retries |
| Rule duplication | none | name rules in TypeScript, or the gateway calls the API to validate |
| Size | smaller: about 1 Python module, plus tests | larger: a TypeScript port, internal routes, an outbox and worker, a signing change |
| Auth database credentials in the API | yes, a narrow role | no |

**Recommendation: B, when the identity work resumes for Riftbound.** A was chosen to keep `api/tests` and `web/tests`
byte-identical while there is still only one backend. Identity is now deferred until a second backend exists, and B's
advantages all matter then:
- it has a single writer;
- propagation is built in;
- the API holds no auth database credentials;
- it does what the owner decided and the ADR says.

The cost is test-helper churn (one shared signing helper and an owner seed), and the owner would accept that then.

Fall back to A only if the suites must stay frozen at that time.

A hybrid, B's signed owner flag with A's API-side Handle writes, removes the API's read of the owner binding but keeps
its write credentials. It is the weakest of the three.


## 6. References outside `api/app` that a move would break

The **Now** move (Pokémon modules) breaks every row tagged Now in the Phase column. Rows tagged Later break when core
modules move or when identity splits.

| Where | Reference | Breaks when | Fix |
|---|---|---|---|
| `scripts/backfill_public_catalog.py` | `app.public_catalog` | Now | new path |
| `scripts/backfill_set_counts.py` | `app.set_counts` | Now | new path |
| `scripts/derive_card_attributes.py` | `app.catalog`, `app.format_standing`, `app.public_catalog` (also `app.main`) | Now | new paths |
| `scripts/format_standing_job.py` | `app.format_standing` | Now | new path |
| `scripts/generate_prices_client.py` | `app.prices` | Now | new path; `check:client` must stay diff-free |
| `scripts/price_import_job.py` | `app.price_import`, `app.rule_rollout` | Now | new paths |
| `scripts/price_runners.py`, `init_public_projection.py`, `init_public_records.py`, `backfill_public_catalog.py` | `app.public_projection`, `app.public_records` | Later (core move) | new paths |
| `scripts/rebuild_invite_records.py` | `app.social.profile` | Later | new path |
| `scripts/rule_rollout.py`, `client_generator.py` | `app.db`, `app.main` | Later (`app.main` stays) | new `db` path only |
| `scripts/bind_owner.py`, `scripts/operations_mail.py` | SQL on `owner_binding`, `"user"` | Later (identity) | `AUTH_DATABASE_URL` |
| `scripts/migrate.py`, `release.py:106-107`, `verify_resources.py:26-30` | `migrations/*.sql`, `DATABASE_URL` only | Later (tracks, identity) | design-brief WP-A, WP-E |
| `deploy/host/prizecheck-deploy.sh:769` | `python -c 'import app.catalog, app.catalog_import, app.price_source, app.price_runner'` | Now (first three) | new paths; `app.price_runner` is mixed and stays |
| `deploy/host/prizecheck-deploy.sh:1346,1385` | `-m app.catalog_refresh` | never (the root shim keeps the path) | — |
| `deploy/host/prizecheck-deploy.sh:1275` | text naming `api/app/catalog_refresh.py` | Now | text |
| `deploy/host/prizecheck-deploy.sh:1202`, `deploy/docker/api.Dockerfile:28` | `app.host_readiness` | Later (mixed, stays Now) | — |
| `deploy/docker/api.Dockerfile:34` | `app.main` | never (root stays) | — |
| `deploy/host/prizecheck-deploy.sh:708,881,1437` | one-database backup, `migrate.py`, `bind_owner.py` | Later (identity) | design-brief WP-E |
| `compose.deploy.yml:30` | `api/app/price_reads.py` | Later (core move) | new path |
| `compose.deploy.yml` (api, auth, tools, scanner-index) | `DATABASE_URL` only | Later (identity) | `AUTH_DATABASE_URL`, `GAME` |
| `tests/tooling/test_deploy_pipeline.py:300,306`; `tests/tooling/test_host_deploy_script.py:119,145,1128` | `app.catalog_refresh` | never (shim) | — |
| `tests/tooling/test_host_deploy_script.py:170,183,1561` | `app.host_readiness` | Later | — |
| `tests/tooling/test_guardrails.py:36` | `app.price_runner` | Later | — |
| `scripts/check_guardrails.py:228-244` (`WEBP_SUFFIX_MODULES`: `api/app/scanner.py`, `api/app/art_urls.py`; `art_source_files()` globs `api/app/*.py`) and `tests/tooling/test_guardrails.py:272-279` (pins `scanner.py`, `art_urls.py`, `art_store.py`, `collection.py`, `social/friend_reads.py`) | file paths | Now for `scanner.py`; Later for the rest. The top-level glob stops seeing moved files, so make it recursive | path constants and glob |
| `tests/tooling/test_verify_harness.py:175` | `api/app/main.py` | never | — |
| `api/app/price_runner.py:114,119,620` | `importlib.import_module('app.price_source')`, `('app.tcgdex_record')` | Now | new paths in WP-I1; replaced by parameters in WP-S2 |
| `-m app.catalog_import` (`api/tests/test_catalog_outbox.py:842`, `test_catalog_process.py:114,134`, `catalog_dispatch.py:18`), `-m app.catalog_refresh` (tooling tests), `app.price_runner` (`auth/tests/price-runners-harness.ts:272`, `price_fixture.py:232`, `test_price_fixture.py:60,202`, `price_launcher.py:133`), `app.host_readiness` (`test_host_deploy_script.py:183,1561`) | module names asserted by tests | Now, for the first three | **keep them as root entry shims**, because changing them is an expectation change (design-brief D11 rule 5) |
| `api/app/price_launcher.py` | spawns `python -m app.price_runner` | never (shim) | — |
| `api/app/host_readiness.py:47` | `spec_from_file_location(…scripts/scanner_index_job.py)` | never (a scripts path) | — |
| `api/app/format_evaluator.py:56`, `set_codes.py:16`, `import_aliases.py:32`, `collection_import_aliases.py:42` | `Path(__file__)`-relative data files | Now. Moving them with their data keeps them working | move each data file beside its module |
| `api/tests/test_set_codes.py:17` (`APP / "format_rules/imported_sets.txt"`), `api/tests/test_format_rules.py` | data path from `api/app` | Now | **a path change in a test file.** It is not an import line, so the owner should allow it |
| `api/tests/*` (about 76 files) | `from app.<pokemon module> import …`, `monkeypatch.setattr(app.x, …)` and string targets | Now | import lines and monkeypatch strings only |
| `docs/adr/0021`, `docs/operations/*` | prose naming modules | Now | docs pass (technical-writer) |

## 7. Caveats

- `public_records`, `card_accepts` and the core-sql social modules have no Pokémon import, but their SQL assumes
  Pokémon's catalog relations (`catalog_edition`, `catalog_printing`, `catalog_*_metadata`, `catalog_reprint_group_*`).
  A Riftbound database must provide relations with those names and shapes, or a later phase puts a contract in front of
  them (design-brief D11).
- The deck and publication response models carry the Pokémon Literals `CardKind`, `TrainerType` and `TargetFormat`.
  WP-D1 and WP-D2 keep them in `games/pokemon` with the same class names, fields and order, so the OpenAPI document
  stays byte-identical (design-brief WP-B snapshot).
- `deck_list.target_format` is a Pokémon value in a core table. Core never reads it after WP-D1; the Pokémon routes
  do. The column itself stays (no migration Now).
- `collection_import`, `import_match_core`, `import_owned`, `import_allocation`, `import_publication` and
  `import_replace` are mixed pipeline mechanics. Lifting them into core is only worth it once Riftbound has its own
  readers and decklist format.

## 8. Test coverage of the groups that move Now

**Static route census.** For each route, a path-literal search across `api/tests`, `web/tests` and `auth/tests`:
- 88 routes in the Now modules: the 58 Pokémon-only files and the 17 Now-mixed files of S1 to S3.
- **87 are referenced by `api/tests`.**
- The 25 routes of WP-D1 and WP-D2 (`decks` 11, `publications` 9, `discovery` 2, `trade_wants` 3) are all referenced by
  `api/tests`. Stored replays are pinned by design-brief WP-B4.
- **1 is reached only by Playwright:** `GET /api/catalog/edition-replacements` (`catalog_reconciliation`). Design-brief
  WP-B2 adds a characterization test for it before anything moves.

**Non-route flows in the Now groups**, by test references:

| Flow | Tests that reference it |
|---|---|
| `catalog_refresh` | `api/tests` 1, tooling 2 |
| `price_import_job` | 4, tooling 2 |
| `format_standing_job` | 1 |
| `derive_card_attributes` | 6 |
| `backfill_set_counts` | 1 |
| `backfill_public_catalog` | 3, plus 1 auth |
| `refresh_fallbacks` | 5 |
| `rule_rollout` startup | 1, via `with TestClient(app)` in `test_rule_rollout.py` |
| `format_standing.rebuild_on_startup` | 0 by name. The lifespan runs it in `test_format_standing.py` (`with TestClient(app)`) and in every Playwright and auth stack |
| `catalog_import -m` and `price_runner` | subprocess tests (`test_catalog_outbox.py`, `test_catalog_process.py`, `test_price_fixture.py`, the auth `price-runners` harness) |

No other gap was found.

**Pure core functions extracted by the Now splits** are reached through route tests:
- `summarize` and the money helpers: the deck, want-list, trade-value and published-cost route tests (`test_deck_cost`
  alone has 43 importers);
- `choose_edition`: the deck-list printing route tests;
- the quote contract: the price runner, launcher and refresh tests;
- the art store: the art route tests;
- the collection-draft pieces: the collection-import route tests.

**Dynamic coverage (2026-10-29, owner approved, nothing committed).** The report is
`/tmp/prizecheck-split/coverage.md`, with the raw data in `/tmp/prizecheck-cov/coverage.json`.
- Over the 76 Now `.py` files, the fast tier covers **95.3% of statements and 90.7% of branches**, with 326 branches
  missed.
- Treat these as a floor:
  - `catalog_import` (0%) and much of `price_runner` (about 67%) are reached only by `slow` tests;
  - some runners are SIGKILLed, so their data is lost;
  - 2 capacity tests failed in the top-up run.
- `collection`, `swap_hints` and `social/friend_reads` (rewired by WP-C2 but tagged Later) were not measured.

**Classification of the missed code.** Group (a) is code that composition changes: it is split into core pieces,
given new arguments, or rewired. Each item gets a WP-B2 characterization test before anything moves. Group (b) is code
that moves as it is, and gets no extra test.

| File | Missed function or branch | Group | Why |
|---|---|---|---|
| `holdings` | `leaf_holdings` 301-304 (quantity-order cursor) | **(a)** WP-B2 test 1 | WP-C2 edits the f-string query that this `after` clause is spliced into |
| `holdings` | `leaf_holdings` 282; `add_holding(s)`; the unused `cursor_encode` and `cursor_decode` | (b) | WP-C2 doesn't touch them |
| `discovery` | `listed_snapshots` 141 (a malformed manifest record gives 503) | **(a)** WP-B2 test 2 | WP-D2 moves it to core with `parse` injected |
| `discovery` | `cursor_decode`, `target_status`, `confirm`, `cost`, `discover` 286 and 313-314 | (b) | they move unchanged (the cursor to core; the rest to Pokémon) |
| `publications` | `mutate` 305-306 and 337 (visibility over an unreadable snapshot) | **(a)** WP-B2 test 3 | WP-D2 moves `mutate` to core, and the `PublicSnapshot` validation becomes the injected `snapshot_model` |
| `publications` | `mutate` 313 and 324; `require_legal` 172 (the impossible "no Deck List"); `public_snapshot` 412 and 421 | (b) | core control flow that moves unchanged, or a Pokémon route that moves whole |
| `decks` | `replayed`, the branch with no `target_format` and no `format_checks` | **(a)** WP-B2 test 4 | WP-D1 turns the `'standard'` fix-up into the injected `fixup` |
| `decks` | `read_deck_loans`, `deck_cursor_decode`, `deck_index` 314, `read_deck_list` 426, `check_revision` 480, `capture_deck_contents` | (b) | they move unchanged |
| `deck_list_printing` | `add_deck_list_printing` 102 (replay) | (a), covered by WP-B4's "add a Printing" replay fixture | no extra test |
| `deck_list_printing` | `choose_edition` 70 | (b) | moves unchanged to core |
| `art_store` | `host_allowed` 80-81 (malformed URL), `ArtFetcher.fetch`, `fetcher`, `_stored`, `serve`, `_warm`, `join_warmups` | (b) | the new `allowed_host` argument replaces only the constant at line 82; the missed branches don't read it |
| `art_urls` | `tcgdex_source`, `route_address`, `large_direct_url` | (b) | they move whole to their side |
| `quote_contract` | `job_id`, `_opt_int`, `_validate_job`, `validate_scheduler`, `validate_ledger_shard`, `slot_status`, `validate_work` | (b) | none of them takes `source` or `currency`; only the record builder (531) and validator (569) do, and those are covered |
| `deck_cost` | `summarize` 130, `private_deck_cost` 159 and 161 | (b) | it moves unchanged; the Pokémon route calls the same function |
| `collection_import` | `summary`, `start_import`, `current_import`, `import_rows`, `change_import`, `rows_csv`, `save_import` | (b) | the routes move whole to Pokémon and the core pieces move unchanged; only imports change |
| `price_runner` | 70 missed branches (supervisor, worker, claims, renewer) | slow tests in WP-S2 acceptance | it gets parameters in WP-S2, but its paths are reached only by `slow` tests |
| `catalog_import` | the whole module | slow tests in WP-I1 acceptance | it moves in WP-I1; reached only by `slow` tests |
| every other Now file (Pokémon-only moves, and whole-file moves such as `public_deck`, `missing_cards`, `published_cost`, `import_*`) | all | (b) | moved by `git mv` with import rewrites only |

**Group (a): 4 new WP-B2 tests.** WP-B4's fixtures cover one more item, and the slow tests in WP-S2 and WP-I1 cover
the two runner modules.

## 9. Architecture-pin tests (owner decision: option C)

Five `api/tests` files assert `api/app` paths or exact importer lists. Moving files would change their
**expectations**, not just their import lines.

**The owner's decision (2026-10-29, option C):** these layout assertions become named rules in the boundary checker,
and only they leave `api/tests`. Design-brief **WP-B3** does the port, right after WP-B and before anything moves.
- Every behaviour and data test in the five files stays.
- From WP-B3 on, a package that moves a pinned module updates the checker's rule lists
  (`scripts/python_architecture_rules.py`), never `api/tests`. The PR lists each update.

| Old assertion | Checker rule | Strictness |
|---|---|---|
| `test_set_codes.py:68-79`: exact `set_codes` importers, top-level glob (line 67 stays) | `set-codes-importers`, exact set, recursive | stricter: the recursive scan also lists `app.social.friend_reads`, which the old glob missed |
| `test_set_codes.py:17`: `APP / "format_rules/imported_sets.txt"` | `format-rules-beside-evaluator`; line 17 reads the file through `format_evaluator.__file__` | same. Line 17 feeds a data test, so it is rewritten, not removed |
| `test_import_aliases.py:65-69`: exact `import_aliases` importers (line 64 stays) | `import-aliases-importers`, exact set, recursive | same or stricter |
| `test_import_aliases.py:70-73`: `readers == ["api/app/import_aliases.py"]` | `import-aliases-tsv-readers`, exact repository paths under `api/app` and `scripts` | same |
| `test_price_source.py:268-280`, except line 272 (the `ORIGIN` assertion, which stays) | `price-source-client`: one origin literal, one `httpx.Client` with `follow_redirects=False` and `trust_env=False`, `parse_float` on every `json.loads`, `fetch(card, may_retry)` | same |
| `test_price_import.py:486-489` (the whole test): no `tcgcsv.com` outside `price_import.py`, top-level glob | `tcgcsv-host`, subset of `{app.price_import}`, recursive | stricter: the old glob would pass vacuously after WP-I1 |
| `test_social_contract.py:562` (`READERS`) | `social-inventory-readers`, exact set | same |
| `test_social_contract.py:567` (`ALLOWED_IMPORTS`) | `social-allowed-imports`, the same map spelled as absolute module names | same |
| `test_social_contract.py:574` (`FRIENDS_OF_READERS`) | `friends-of-readers`, exact set | same |
| `test_social_contract.py:590` (several owners' inventory) | `several-owners-readers`, subset of `{app.social.friend_copies}` | same |
| `test_social_contract.py:636` (`APP / 'trade_inventory.py'`) | `trade-steps-no-friend-ids` | same |
| none | `social-area-complete`: every package named `social` is in the scanned social area | new: closes the gap a move into a new `social` folder would open |

**Intended rule-list changes in the Now packages**, each named in its PR:
- WP-C2 removes `app.collection`, `app.holdings`, `app.swap_hints` and `app.social.friend_reads` from
  `set-codes-importers`.
- WP-I1 renames the moved modules in `set-codes-importers`, `import-aliases-importers`, `import-aliases-tsv-readers`,
  `price-source-client` and `tcgcsv-host`.
- WP-S1 to WP-D2 rename `social-allowed-imports` entries whose imported module moved. For example, WP-D2 turns
  `app.publications` into `app.core.publications.publish` for `social/friends` and `social/profile`, and WP-D1 turns
  `app.trade_wants` into `app.core.trading.trade_wants` for `social/trade_matches`.

**Left in `api/tests` (owner confirmed):** six caller scans keyed by `api/app` paths: `RESERVING_PICKS_CALLERS`, `LISTABLE_CALLERS`,
`FOR_TRADE_CALLERS`, `REACH_CALLERS` and `MESSAGE_CALLERS`, together with `DISCOVERY_CALLERS`. The owner did not name
them, and no module they list moves Now (they are all `social/*` or `trade_list.py`). A Later step ports them, the
same way as WP-B3, before `social/` and `trade_list` move.

## 10. Notes as built (dated)

These notes record where the work differs from, or settles, the map above. The sections above stay as written on
2026-10-29.

**2026-10-29**

- **`art_url` stays in `games/pokemon/art/urls.py`.** Section 1A planned it for `core/art/urls.py`. The function embeds
  the TCGdex source rule, so it is not game-free. The owner chose this (option A). The rest of `art_urls` goes to core
  as planned, and the allowed hosts are passed in.
- **The root `app.quote_contract` shim binds the Pokémon source and currency** (decision Q1), so a caller of the old
  path gets `source='tcgdex'` and `'USD'` without passing them. Core's quote contract takes both as keyword-only
  parameters with no default (D11 rule 3).
- **`trade_value` lives in `games/pokemon/trading/`.** The whole file moves with its router, as section 1A says. The
  `trading` folder is new in the layout of design-brief 3.4.
- **`catalog_targets`, `public_catalog` and `public_prices` gained root alias shims** at `app.<name>`. The unedited
  Playwright specs import them by their old names.
- **Two temporary allow-list edges** stay in `scripts/python_boundary_allowlist.txt` until WP-D2 removes them:
  `app.discovery -> published_cost` and `app.publications -> games/pokemon/art/urls`. (Both are gone; the final
  allow-list is in the 2026-10-30 entry.)
- **Test-line edits.** The owner approved targeted edits to test lines for the WP-S2 art store and runner split. This
  goes beyond the import-lines-only rule of section 6.
- **FastAPI is pinned to 0.162.0** in `api/requirements.txt` on this branch until the merge (design-brief section 4,
  "Before the branch merges to dev"). (Unpinned again on 2026-10-30; see below.)
- **Docs.** [ADR 0023](../../adr/0023-split-core-and-games-by-composition.md) records the split, and
  `docs/agents/verification.md` describes the boundary checker. Prose elsewhere in `docs/` names the moved paths,
  except for modules that WP-S3, WP-D1 and WP-D2 had not moved yet. (WP-K finished the rest on 2026-10-30.)

**2026-10-30**

WP-S2, WP-S3, WP-T, WP-D1 and WP-D2 have landed, and WP-K has pointed the docs at the final locations. The entry
below says where each group ended up; the module map in section 1 stays the plan.

- **WP-S2: art and the price runner.**
  - The art store and the game-free art URL helpers are in `core/art/{store,urls}.py`. The Pokémon art route, allowed
    hosts and `art_url` are in `games/pokemon/art/{route,hosts,urls}.py`. `card_art` moved whole to
    `games/pokemon/prices/card_art.py`.
  - The price runner is `core/prices/runner.py` and the quote contract is `core/prices/quote_contract.py`. Both take
    the Pokémon source, record rules and quote values as arguments. `games/pokemon/prices/runner_entry.py` binds them,
    and `games/pokemon/prices/quote_values.py` holds `SOURCE` and `CURRENCY`.
  - `python -m app.price_runner` still works: the root `price_runner.py` is a shim that runs the entry. The CI connect
    guard arms on that module name.
- **WP-S3: collection import and the deck-import group.** `collection_import` split into
  `core/imports/collection_draft.py` (row-state SQL constants, limits and messages) and
  `games/pokemon/imports/collection_import.py` (router and the reader, matcher and finish calls). The `import_*`
  helpers, `deck_import` and `decklist_text` moved whole to `games/pokemon/imports/`, `scanner_save` to
  `games/pokemon/scanner/`, and `missing_cards` to `games/pokemon/catalog/`.
- **WP-T: trade inventory.** `trade_inventory` moved whole to `games/pokemon/trading/trade_inventory.py`, beside
  `trade_value`.
- **WP-D1: deck routes.**
  - The Deck store, index, ownership, loans, contents and printing logic is in `core/decks/`. `trade_wants` split: the
    game-free reads and rules (`want_quantity`, `own_wants`, `own_rules`, `lower_trade_wants`) are in
    `core/trading/trade_wants.py`; the Pokémon routes and models are in `games/pokemon/trading/trade_wants.py`.
  - The Deck routes are `games/pokemon/decks/routes.py`, with `models.py`, `checks.py`, `commands.py` and `cost.py`
    beside them. `deck_list_display` is now `games/pokemon/decks/line_display.py`.
- **WP-D2: publications and discovery.**
  - Publishing, snapshot storage, mutate and drain, and listing and paging are in
    `core/publications/{publish,discovery}.py`.
  - The Pokémon half is `games/pokemon/publications/`: `publications.py` (routes and the snapshot builder),
    `models.py`, `discovery.py` (Format filter, featured Decks and cost), `public_deck.py` (moved whole) and
    `published_cost.py`.
- **Root names that still resolve.** `catalog_import`, `catalog_refresh`, `catalog_targets`, `public_catalog`,
  `public_prices`, `price_runner` and `quote_contract` remain at `api/app/` as compatibility shims, for
  `python -m` entry points and for the unedited Playwright specs. The real modules are under `games/pokemon/` and
  `core/`; docs name those.
- **Final boundary allow-list.** `scripts/python_boundary_allowlist.txt` ends with exactly two `[edges]` entries:
  `app.host_readiness -> app.games.pokemon.prices.catalog_targets` and
  `app.want_list -> app.games.pokemon.decks.line_display`. Both importers are root modules that did not move Now.
  It also holds seven `[sql]` lines, the identity-table reads that wait for the auth-database work:
  `app.host_readiness` (`owner_binding`, `user`), `app.identity` (`owner_binding`), `app.operations`
  (`auth_rate_event`, `auth_send_event`), `app.games.pokemon.catalog.rule_rollout` (`owner_binding`) and
  `app.social.profile` (`released_handle`).
- **Rebased onto dev 32b7d5c.** The branch was rebased onto dev at `32b7d5c`. That carried dev's #395 change
  (`card_tcgplayer_candidate` and `add_card_tcgplayer`) into its new homes, `games/pokemon/prices/catalog_targets.py`
  and `games/pokemon/catalog/rule_rollout.py`.
- **FastAPI is unpinned.** `api/requirements.txt` is back to `fastapi>=0.115,<1`; the temporary 0.162.0 pin is gone.
- **Docs.** `docs/prices.md`, `docs/price-refresh.md` and `docs/public-projections.md` name the final module paths,
  and ADR 0020's guardrail line names the two moved modules it allows. Otherwise dated records (ADRs 0001 to 0022,
  release notes and the planning docs) still name the paths of their day.
