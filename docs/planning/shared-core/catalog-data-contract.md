# Existing shared catalog SQL contract

Issue [#520](https://github.com/ry-cen/prizecheck/issues/520), inspected at
`55d2e9d8f5e000837cfd41916ec74cadad116fa5`. This records the database coupling that
[ADR 0023](../../adr/0023-split-core-and-games-by-composition.md) leaves in place.
It defines neither an adapter nor a schema for another game. Migrations remain one
track, and these relation names still belong to the existing Pokémon catalog.

**#521 extraction update (2026-11-03).** Collection's generic reads now join the shared inventory below; its facets
and whole router are game-owned. The updates attributed to #521 record moved SQL, not a new schema requirement or
an expansion of #520's tests.

## Scope and consumers

The inventory covers SQL in every `api/app/core/**/*.py` and every module marked
`core` in `scripts/python_module_owners.txt`, including modules still at the root.
Ownership and SQL are separate concerns: a game-free import graph does not make
its database dependencies game-free.

The direct shared catalog readers are:

| Source under `api/app/` | SQL seam and purpose |
| --- | --- |
| `core/catalog/card_facts.py` | `CARD_FACTS`, `card_facts`: retained card display, search keys and `Card.order`. Used by social reads, Loans, Trades and Trade Lists. |
| `core/inventory/holdings.py` | `add_holding`, `add_holdings`: active-generation availability; `leaf_holdings`: retained display, name/set/number filters and ordering. #521 moves its shared cursor dependency to `core/inventory/cursors.py`. |
| `core/inventory/collection.py` (#521) | Aggregate Collection, Edition distribution, Holding paging/totals, set choices and revision reads. Uses the retained display/art/set-code joins and catalog generation/revision reads below. Reads the effective attribute revision; facet columns, joins, predicates, values and cursor context are supplied by Pokémon. `/sets` inner joins retained display, so bare Printings supply no set choice. |
| `card_accepts.py` | `ACCEPTED`, `accepts`: widen an Edition to its Printing's Editions or its current Card Identity's Editions. |
| `core/trading/trade_wants.py` | `AVAILABLE`: whether an Edition may start a new Trade Wants line. |
| `core/decks/contents.py`, `core/decks/deck_list_capture.py` | `capture_deck_contents`, `capture_deck_list`: lock and capture the catalog revision before detaching inventory. |
| `core/art/store.py` | `resolve`, `_read`, `_repair_pointer`, `warm_deck`: source URLs, public reference, cache state and Deck art warming. Also writes the adjacent art cache tables below. |
| `operations.py` | `operations_status`: failed catalog runs, pending reviews and undelivered public-catalog work. |

Other shared modules have no direct catalog SQL. In particular, `core/prices/**`
reads public records/quotes rather than joining catalog tables. `core/imports/collection_draft.py`
does have import-draft and Holding SQL, but no catalog SQL. Most `core/decks/**`
works with inventory Edition IDs; game-owned line display supplies catalog facts.
`public_records.py` names catalog record keys, not SQL tables. Inventory foreign
keys to `catalog_edition(id)` remain coupling even where no catalog SELECT occurs.

`core/ops/readiness.py` supplies a read-only connection/report frame and executes
callbacks; it contains **no catalog query**. `host_readiness.py` is a root
composition shim; catalog readiness queries are in `games/pokemon/ops/readiness.py`,
outside this shared inventory. Catalog-related comments and response field names
are not evidence of a SQL dependency.

## Direct relation and column requirements

Types below are PostgreSQL types. `uuid` IDs are compared/joined as UUIDs, not
source strings. Only consumed columns are listed; additive columns are allowed.
Migration numbers refer to files under `migrations/`.

| Relation | Required columns and types | Consumers and semantics | Defining migrations |
| --- | --- | --- | --- |
| `catalog_state` | `singleton boolean`, `active_generation uuid`, `revision bigint` | Holdings, Trade Wants, Deck captures. Exactly one true singleton row; active generation can be NULL, revision cannot. Captures use `FOR SHARE`; holdings mutations fence activation the same way. | `003_catalog.sql` |
| `catalog_attribute_state` (#521 extraction) | `singleton boolean`, `revision bigint` | Collection reads the singleton revision in the same repeatable snapshot as catalog/owner revisions, totals and rows. Its cursor binds `[catalog revision, attribute revision]`; either change invalidates it with `CATALOG_CHANGED`. | `030_card_attributes.sql` |
| `catalog_edition` | `id uuid`, `printing_id uuid`, `descriptor jsonb` | Facts, holdings, acceptance expansion, art warming. ID is unique, Printing FK is non-null and immutable. Many Editions can belong to one Printing. Readers expect descriptors to decode as objects; JSONB alone does not enforce that shape. | `003_catalog.sql`; correspondence immutability in `021_edition_metadata.sql` |
| `catalog_printing` | `id uuid`, `identity_id uuid`, `public_ref text` | Facts/holdings join through the non-null Identity FK; acceptance follows current identity. Art resolves the immutable unique 48-character lowercase hex public reference. | `003_catalog.sql`, `021_edition_metadata.sql`; surviving Identity handling in `037_reviewed_reprint_groups.sql` |
| `catalog_identity` | `id uuid`, `display_name text` | Facts and holdings require a unique Identity and non-null fallback name. Multiple Printings can share one Identity. Acceptance uses identity ID, never name equality. | `003_catalog.sql` |
| `catalog_generation_edition` | `generation_id uuid`, `edition_id uuid`, `printing_id uuid`, `active boolean` | Holdings and `AVAILABLE` join by current generation and Edition, then by generation and Printing; require `active`. Unique `(generation_id, edition_id)`. Writers must keep the Edition/Printing correspondence consistent; the two individual FKs alone do not enforce it. | `003_catalog.sql` |
| `catalog_generation_printing` | `generation_id uuid`, `printing_id uuid`, `tombstoned boolean` | Availability requires matching generation/Printing and `NOT tombstoned`. Holdings also left-joins these keys when listing, without filtering availability. Unique `(generation_id, printing_id)` prevents fanout. Art's view additionally reads `image_url text` indirectly. | `003_catalog.sql` |
| `catalog_printing_display` | `printing_id uuid`, `display_name text`, `set_id text`, `set_name text`, `collector_number text` | Facts and holdings left join by unique Printing. Missing row uses Identity name and empty display strings. Present values are non-null; an empty name stays empty (`coalesce`, not `nullif`). Retained display survives generation changes. | `016_catalog_reconciliation.sql` (remember-on-insert and immutable-update triggers) |
| `catalog_printing_set_code` (view) | `printing_id uuid`, `set_code text` | Facts and holdings **inner join** this view. Exactly one row for **every Printing**, even one with no display, is essential: losing a row silently loses a card. Code is reviewed printed code, else retained set ID, else `''`; never NULL. | `160_catalog_set_code.sql` |
| `catalog_printing_art` (view) | `printing_id uuid`; `small_art_url`, `low_image_url`, `high_image_url`, `large_upgrade_url`, `stored_upgrade_url` all `text` | Facts left join route-ready small art. Holdings select low source + stored upgrade and build a route for the page. Store resolves low/high/candidate/upgrade with Printing `public_ref`; warm-up joins Edition → Printing art and reads low/high/candidate. Source and route columns can be NULL. Effective view currently has one row per Printing; left joins tolerate absent art rows, `resolve` returns None without usable art. | `154_fallback_art.sql`, `158_art_route_urls.sql`, latest definition **`161_tcgplayer_large_art.sql`** |
| `catalog_run` | `outcome text` | Operations counts only `outcome='failed'`; NULL unfinished and successful runs do not count. | `003_catalog.sql` |
| `catalog_review` | `status text` | Operations counts only `status='pending'`. No dependency on review payload or kind. | `003_catalog.sql` |
| `catalog_public_outbox` | `created_at timestamptz`, `delivered_at timestamptz` | Operations counts only NULL delivery timestamps; age is seconds since the oldest pending creation, NULL with no pending rows. | `023_metadata_review.sql` |

`catalog_search_words(text) RETURNS text` is the direct function dependency in
`CARD_FACTS` (defined by **`048_catalog_name_search.sql`**). It applies Unicode
NFKD/lowercase, drops non-printable/non-ASCII characters and apostrophes/periods,
and turns other non-alphanumeric runs into trimmed spaces. For example,
`Flabébé` → `flabebe`, `Mr. Mime` → `mr mime`, `Porygon-Z` → `porygon z`.
The shared reader removes spaces and converts a NULL result to `''`.
This is distinct from holdings' lowercased, escaped **prefix** name filter.
`Card.order()` uses Python casefolded display name, raw set name, natural collector
number (including letter prefixes and suffixes), then Edition UUID. It is not a
promise that every SQL gallery uses the same order or search normalization.

Required Edition → Printing → Identity joins are inner joins backed by FKs;
optional display/art joins must not multiply rows. `card_facts` returns one entry
per existing requested Edition and ignores missing IDs; its dictionary could
otherwise conceal duplicate SQL rows. It does **not** filter active state.
Similarly, `accepts` expands retained Editions without an availability filter;
`edition` accepts itself without querying SQL. `UNION` deduplicates widened results.
In contrast, `AVAILABLE` and holdings' new-copy guards reject inactive Editions,
tombstoned Printings, absent current-generation rows and NULL active generation.
A live row in another generation cannot make a current Edition available.

## Art view internals and adjacent shared cache SQL

These are existing implementation dependencies, not additional card facets.
The art view prefers a nonempty current-generation image, then a nonempty retained
display image, then linked fallback product art. Its current-generation lookup
does not filter tombstones. The view reads `catalog_printing_display.image_url text`,
`catalog_printing_fallback_art(printing_id uuid, product_id integer)` (154) and
`catalog_printing_art_product(printing_id uuid, product_id integer)` (161).
Both product tables have one row at most per Printing. Their product selection
and provider-specific URL construction are game-owned internals of this view.

`catalog_set_code(set_id text PRIMARY KEY, code text NOT NULL)` (160) is likewise
an indirect dependency of the set-code view; shared Python never selects it.
Retained set ID, not active-generation set metadata, drives its fallback.

`core/art/store.py` also consumes/writes:

| Relation | Consumed columns and types | Assumptions / migration |
| --- | --- | --- |
| `art_object` | `printing_id uuid`, `size text`, `source_url text`, `storage_key text`, `sha256 text`, `content_type text`, `byte_size integer` | One object per `(printing_id,size)`; reuse only while source and stored byte digest match. Pointer repair joins Printing `public_ref`; object can be absent. `156_art_store.sql`. |
| `art_fetch_failure` | `printing_id uuid`, `size text`, `source_url text`, `failures integer`, `last_failed_at timestamptz`, `reason text` | One failure ledger per `(printing_id,size)`; matching-source failures back off by elapsed age/count. Optional row. `156_art_store.sql`. |
| `art_hit` | `printing_id uuid`, `size text`, `hits bigint`, `last_hit_at timestamptz` | Upsert increments the per-Printing/size counter. `156_art_store.sql`. |
| `art_large_upgrade` | `printing_id uuid`, `candidate_url text`, `base_url text`, `outcome text`, `width integer`, `height integer`, `failures integer`, `reason text`, `checked_at timestamptz` | One comparison per Printing; optional row, nullable dimensions/reason subject to outcome constraints. Store matches candidate/base and reads outcome/dimensions/age/backoff. View uses only a matching `won` row. `161_tcgplayer_large_art.sql`. |

`SELECT *` on the object/comparison rows does not make unused timestamp columns
part of the reader requirement. The art view additionally uses SQL helpers
`catalog_art_version(text)` (158), `catalog_art_version(text,text)` and
`catalog_art_route_v(uuid,text,text,text)` (161). A matching won upgrade changes
the version for both sizes; stale candidate/base matches do not. The Python twin
is `core/art/urls.py::route_address`. Optional art resolves to None rather than a
placeholder URL; store host validation is supplied by game composition.

## Remaining mixed and game-owned dependencies

These are **not** newly claimed as game-free shared facets. They explain current
coupling, including the game-owned half of [#521](https://github.com/ry-cen/prizecheck/issues/521).

| Mixed source under `api/app/` | Additional concrete catalog dependencies |
| --- | --- |
| `games/pokemon/inventory/{collection,borrowed_gallery}.py` (#521 extraction) | Pokémon owns the Collection router, typed facet models and `catalog_card_attribute(printing_id uuid, card_kind text, types text[], trainer_type text)` join/expressions (030/033/038/041). Optional attributes give NULL category/Trainer Type and empty elemental types. Filters use equality and `ANY(types)`; unknowns do not match a requested facet. The Borrowed gallery shares these facets. Generic Collection SQL and cursors have moved to `core/inventory/`; this effective facet relation remains game-supplied SQL, not a shared default. |
| `swap_hints.py` | `GROUPS`/`MEMBERS` read `catalog_reprint_group_member(printing_id uuid, group_id uuid)`, one effective group at most per Printing, possibly absent (035; stored membership/view replaced by 037). `MEMBERS`/`FACTS` read Edition `id,printing_id,descriptor`, Printing `id,identity_id`, Identity `id,display_name`, display `printing_id,display_name,set_id,set_name,collector_number`, set-code `printing_id,set_code`. Active-generation Edition/Printing predicates are returned as an **available flag**, not a filter on all facts. |
| `social/friend_reads.py` | `REACH` joins Edition `id,printing_id` and reprint membership `printing_id,group_id`; missing groups reach only the original Printing. Expands every finish and excludes the original Printing in the other-printing arm. No active-generation filter at this seam. Query normalization invokes `catalog_search_words(text)`; rendering uses shared card facts. |
| `social/trade_matches.py` | Edition `id,printing_id`, Printing `id,identity_id`, display `printing_id,set_id`: expands same Printing, same Identity or same Identity+retained set. Set matching inner joins display. No active-generation filter in these expansion statements. |

Effective attributes, reviewed Reprint Groups, evolution roots, Format Standing,
Basic Energy grouping, catalog import/reconciliation and price mapping rules live
in `games/pokemon/**`. Shared consumers do not directly select their derivation
tables or source metadata. This inventory neither exposes them as an interface
nor removes the database coupling behind effective views. Root modules marked
`root` are entry/composition shims, not part of the `core` ownership scan.

## Enforcement and limits

`api/tests/test_catalog_data_contract.py` checks required relation-column types on
the **migrated PostgreSQL database**, then executes real shared `CARD_FACTS`,
`card_facts`, `Card.order`, `AVAILABLE`, `accepts`, art `resolve` and detached Deck
capture seams. Small synthetic fixtures cover absent display/art, set-code row
coverage and fallback, search/order, generation availability and retained reads,
source precedence, and stale versus matching art upgrades. Schema tests allow
additive columns. They are independent of this document's text.

Two savepoint-isolated negative tests rename a required view column and replace
search normalization with incompatible semantics. The real shared reader raises
`UndefinedColumn` in the first and violates a meaningful accent-search assertion
in the second. Both restore the original object and successfully reread it before
the outer fixture transaction rolls back.

Existing HTTP snapshots, Collection goldens, holdings/filter characterizations,
art route tests, operations tests and rule digest pins remain separate evidence.
These tests do not parse arbitrary SQL, automatically discover future dependencies,
prove every constraint or concurrency schedule, or define a second-game contract.
When shared SQL gains a dependency, update this inventory and add a focused
schema/reader assertion. Mixed facet extraction, cursor changes, migrations,
production code, snapshots and architecture allow-lists are outside this slice.

Run through the repository runner (see [verification](../../agents/verification.md)
and [local testing](../../agents/local-testing.md)):

```sh
npm run verify:local -- --suite api -- api/tests/test_catalog_data_contract.py
npm run check
npm run guardrails
```
