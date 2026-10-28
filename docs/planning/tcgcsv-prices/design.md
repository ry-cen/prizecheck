# Design: price every card from TCGCSV, and use TCGplayer art where TCGdex has none

Design, 2026-10-27, written against `origin/dev` at `ea2f1b2` (v0.2.0); line numbers refer to that commit. Decision: [ADR 0019](../../adr/0019-tcgcsv-daily-prices.md). Tickets: [tickets.md](tickets.md). Builds on [ADR 0018](../../adr/0018-scheduled-catalog-change-check.md).

## 1. Goal

Every collector-facing price comes from one daily TCGCSV (TCGplayer) snapshot. A host job imports it into PostgreSQL, and
readers only read from our own store. The access-triggered runner, admission and import seeding are retired. A Printing
with no TCGdex image shows the TCGplayer product image of its verified product.

## 2. Acceptance criteria (feature level; each ticket has its own)

1. A daily job imports every Pokémon (category 3) group's `/products` and `/prices` from tcgcsv.com into PostgreSQL. It runs
   from the host (`catalog-refresh`, ADR 0018) and never from a request path. One run makes at most about 450 requests.
2. A failed or partial day never blanks or rolls back a stored price. Rows keep their last values and the date they were last
   seen.
3. Every price read (inspector/gallery `POST /api/prices/editions`, Deck cost, Want List cost, Trade value, Deck List
   cheapest-pick and import allocation) is answered from PostgreSQL in one query. Nothing waits on, admits or launches a
   fetch.
4. A verified Edition is priced from exactly one `(product_id, sub_type_name)` row, chosen by the binding rule in §4.3.
   Shadowless base1-4 Charizard binds to (106999, "Unlimited Holofoil"), 1st Edition Shadowless to (106999, "1st Edition
   Holofoil"), and unlimited to (42382, "Holofoil").
5. svp, mep and swshp Editions that carry a TCGdex `thirdParty.tcgplayer` id become verified under matching rule v4 and are
   priced. Black Star promo Editions with no TCGdex id (in practice dpp, bwp, xyp, mep and svp) are verified through the
   reviewed set → group, card-number and exact-name path (§4.4). About 255 cards match. The owner can review and reject
   every match from a dedicated list (ticket P2b).
6. Published Deck cost still makes zero PostgreSQL connections. It reads prices from a new `price:` record family that the
   job publishes into the public record store.
7. Owner controls shows the last price import: when, outcome, TCGCSV's own update time, group failures, priced and verified
   Edition counts, unpriced counts by reason, fallback-art count, and a warning when the newest good run, or TCGCSV's own
   update time, is over 48 h old.
   Apart from the single footer credit line (AC 10), no collector screen or collector response names TCGCSV or TCGplayer
   as a price source, or shows import times or refresh state.
8. A Printing whose TCGdex image is missing (active generation and established display) shows
   `https://tcgplayer-cdn.tcgplayer.com/product/<id>_200w.jpg` (tiles) and `_400w.jpg` (inspector) on gallery tiles, the
   inspector, Collection, Deck, Want List, trading and Published Deck screens. A TCGdex image always wins, including one
   that TCGdex adds later.
9. When the feature finishes, `price_runner`, `price_launcher`, `price_refresh`, `price_seed`, `price_source`,
   `scripts/price_runners.py`, `PRICE_RUNNER_LOCK_DIR` and the record-store `quote/result/fence/work/lease/admission/backoff`
   families are gone, and docs/ADRs say so.
10. The signed-in shell and every public page (the public layout) end with one short footer line, "Prices from TCGCSV",
    linking https://tcgcsv.com. This is the owner's explicit exception to the AGENTS.md provenance rule (§8). No other
    collector-facing provenance is added.

## 3. Context (read before any ticket)

### Evidence gathered for this plan (2026-10-27, live)

- TCGCSV Pokémon: 220 groups, 32,882 products (1,190 with `imageCount` 0), and 45,404 price rows (782 with `marketPrice`
  null). 13,908 products carry more than one subtype. The full subTypeName vocabulary is exactly `Normal` (19,254),
  `Reverse Holofoil` (13,600), `Holofoil` (10,678), `1st Edition` (761), `Unlimited` (761), `Unlimited Holofoil` (179) and
  `1st Edition Holofoil` (171).
- Product fields: `productId, name, cleanName, imageUrl, imageCount, groupId, url, modifiedOn, extendedData[] (Number,
  Rarity…), presaleInfo`. Price fields: `productId, subTypeName, lowPrice, midPrice, highPrice, marketPrice,
  directLowPrice` (JSON numbers, any of them null). `last-updated.txt` read `2026-10-27T20:05:13+0000`.
- Shadowless is its own group, 1663 "Base Set (Shadowless)". Product 106999 there has `Unlimited Holofoil` (market 2172.24)
  and `1st Edition Holofoil` (market **null**, low/mid/high 100000). Base Set group 604 has 42382 `Holofoil` (market
  954.65).
- Promo groups: SWSH promos **2545** "SWSH: Sword & Shield Promo Cards" (343 products, 341 price rows), SV 22872, ME 24451,
  XY 1451 (269 products; numbers `XY01`… match TCGdex localIds, and 24 numbers have more than one product, such as stamped
  or staff copies).
- TCGdex `variants_detailed[]` descriptors look like `{type, subtype?, size, stamp?: [...], foil?, thirdParty: {tcgplayer,
  cardmarket}}`. base1-4 has `{type: holo, subtype: unlimited}` → 42382, `{type: holo, subtype: shadowless, stamp:
  ["1st-edition"]}` → 106999, and `{type: holo, subtype: shadowless}` → 106999. svp/mep variants have `thirdParty.tcgplayer`
  but `pricing.tcgplayer: null`, which is why v3 fails them (`MatchingRulesV1.products` returns `no_product`). xyp cards
  have no TCGplayer id anywhere.
- I sampled 219 random non-Pocket TCGdex cards. 204 (93%) carry some TCGplayer product id. Every sampled id I checked
  against TCGCSV (242 variants in 12 sets) exists there: 202 have a price row, 2 have none. Expect roughly 1,500 catalog
  cards with no id at all: xyp, trainer kits, some vintage and some odd sets.
- Images: TCGdex lists 1,749 of 23,736 cards with no `image`, about 1,590 after the excluded Pocket series. Samples suggest
  **roughly 800 (±150)** of those have a TCGdex product id: swsh4.5sv, mep, swsh12.5gg, the SWSH trainer galleries,
  McDonald's sets, mfb, smp, ecard2/3, svp and swshp. sm3.5, sm7.5, trainer kits, sve, cel25cc, 30th-c and exu have none.
  The job reports the exact count on the owner panel (ticket P7).
- The TCGplayer CDN serves `_200w.jpg` (~25 KB) and `_400w.jpg` (~77 KB). `_in_1000x1000.jpg` is a padded square
  (unsuitable), and `_600w`/`_1000x1000` return 403. The CDN sends **no** `Access-Control-Allow-Origin` and no CORP header.
  assets.tcgdex.net sends `Access-Control-Allow-Origin: *`.
- The repository sets no Content-Security-Policy (`git grep` finds none), so `img-src` needs no change. Only
  `/collection/scan` and the scanner assets send COEP `require-corp` (`deploy/docker/nginx.conf:80-87,121,135`). The
  scanner's `CardArt` uses `crossOrigin="anonymous"` (`web/src/scanner/ui/CardArt.tsx`), so a TCGplayer CDN image cannot
  load on the scanner page.
- `scripts/scanner_index_job.py:337-344` takes only Printings with a non-empty `image_url`, and fetches only from
  `*.tcgdex.net` (`ALLOWED_HOST`, :55). **The 91 failing Printings are therefore not the image-less ones.** They have a
  TCGdex URL whose `/low.webp` failed. Orchestrator check (read-only, prod):
  `SELECT image_url, failures FROM scanner_fingerprint_failure` to see whether those assets 404 at TCGdex.

### Code the workers must understand

- **Mapping (ADR 0007): `api/app/catalog_targets.py`.** Covers `MatchingRulesV1–V3` (:120-275), `MATCHING_RULES` (:278), the
  `code_digest` pin (:290; `test_registered_rule_digests_are_pinned`), `evaluate_edition` (:340), `verified_elsewhere`
  (:546), `refresh_editions` (:563, which builds `facts`), `activate_rule` (:675), `ensure_matching_rule` (:713;
  `MARKETPLACE_MATCHING=automatic` on dev, `off` on prod via `compose.prod.yml`) and `edition_targets` (:757). An Edition's
  `mapping_revision` bumps only when it becomes or stops being verified. A maintainer changing the product while it stays
  verified does not bump it, so readers must also compare `product_id`.
- **Owner decisions: `api/app/metadata_reviews.py`.** `MetadataMarketplaceProposal{product_id, quote_variant}` (:52),
  `_variant_block_holds` (:421), `plan_marketplace` (:436), `decide` (:502), `apply_marketplace` (:569) and the activation
  route (~:621 onward).
- **Price read today: `api/app/prices.py`.** `QuoteView` (:57), `format_usd` (:72), `validate_quote` (:104),
  `_read_targets` (:150), `_label` (:164), `private_edition_quotes` (:195), `_priced`/`_admit` (:226-283),
  `stored_edition_quotes` (:288) and the route (:347). Consumers: `deck_cost.py:168`, `want_list_cost.py:96`,
  `trade_value.py:77` (all `private_edition_quotes`), plus `deck_list_printing.py:96`, `deck_import.py:394` and
  `import_allocation.py` (all `stored_edition_quotes`). The web client already hides source, age and refresh: it reads only
  `status`, `display_amount` and the `deadline`/`validation_unavailable` reasons (`web/src/EditionPrice.tsx:128-137`).
  `DeckCost.tsx` does not render the stale counts.
- **Public price read: `api/app/published_cost.py:60-125`** (`_label`, `public_quotes`, admission) and
  **`api/app/public_catalog.py:645-746`** (`MarketplaceState`, `_marketplace`, and `marketplace_states`, which reads
  `catalog:edition` and `quarantine` records plus `quote_states` at one pinned generation). The drainer's conventions are in
  `public_catalog.py:1-60` (CAS ≤128 keys, `CHUNK_SECONDS`, `ATTEMPTS`). Key families are in
  `api/app/public_records.py:~100-140` (`_FAMILIES`) and `quote_states` (:1011). Prod uses the filesystem adapter on a
  shared volume (`compose.deploy.yml:27-29`). `api/app/publish_refresh.py` admits a refresh at publish time.
- **Seeding: `api/app/catalog.py`.** `PRICE_VIEW_KEYS`/`price_view` (:157-163), `TCGdexSource.price_views` (:172, :256) and
  `_publish_after_commit` (:767-781, the `seed_from_import` call). `tcgdex_record.py` also holds identity helpers that
  catalog.py and metadata_reviews.py import (`distinct_variants`, `priced_variant`, `source_descriptor`), so it is **not**
  deleted whole. `quote_contract.parse_amount` is imported by `deck_list_printing.py:30` and `tcgdex_record.py:11`.
  `catalog.py` uses `quote_contract.wall_ms`.
- **Images.** `catalog_printing_display.image_url` is first-seen and immutable: `migrations/016_catalog_reconciliation.sql`
  has an update trigger that raises. `catalog_generation_printing.image_url` is per generation (`003_catalog.sql:66`).
  Consumers append `/low.webp` or `/high.webp` in Python: `catalog_search.py:134-135`, `collection.py:45`,
  `public_catalog.py:78-87` (`public_image_url` → `catalog:printing` record), `publications.py:203` (frozen into Published
  Deck snapshots) and about 20 more modules (`git grep -n "image_url" origin/dev -- api/app`). `scanner.py` serves the
  scanner's `low_image_url`.
- **Deploy.** `deploy/host/prizecheck-deploy.sh:422` smoke-imports `app.price_source` and `app.price_runner`. `cmd_tool`
  runs `/app/scripts/*.py` in the current release image (the `bind_owner.py` pattern in `docs/deployment-oracle.md`).
- **Conventions.** Migrations are numbered SQL files under `migrations/`. **151 is reserved by #339** (`catalog_check`), so
  this feature uses 152–154. Generated clients are regenerated with `scripts/generate_all_clients.py`, never hand-edited.
  UI copy follows AGENTS.md. Verification follows `docs/agents/verification.md`: narrow `npm run verify -- --suite api --
  <files>` plus `npm run check` and `npm run guardrails` per ticket, with green GitHub CI before each pull request; the full local gate is optional.

## 4. Decisions

### 4.1 Data model (migration `152_tcgcsv_prices.sql`)

```sql
CREATE TABLE price_import (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('imported','unchanged','partial','failed')),   -- null while running / after a crash
  source_updated_at timestamptz,          -- TCGCSV last-updated.txt
  groups_total int, groups_failed int NOT NULL DEFAULT 0,
  product_rows int, price_rows int, rejected_rows int NOT NULL DEFAULT 0,
  verified_editions int, priced_editions int,
  unpriced jsonb NOT NULL DEFAULT '{}',   -- {reason: count} from the binding pass
  fallback_art int, public_error text, error_code text);
CREATE TABLE tcgplayer_product (
  product_id int PRIMARY KEY CHECK (product_id > 0),
  group_id int NOT NULL, name text NOT NULL, number text,            -- extendedData "Number", trimmed, as given
  number_key text,                                                   -- number_key(number), §4.4 (shared helper in price_import.py)
  image_count int NOT NULL DEFAULT 0,
  seen_at timestamptz NOT NULL, source_updated_at timestamptz NOT NULL);
CREATE INDEX tcgplayer_product_group_number ON tcgplayer_product(group_id, number_key);
CREATE TABLE tcgplayer_price (
  product_id int NOT NULL CHECK (product_id > 0),
  sub_type_name text NOT NULL CHECK (length(sub_type_name) BETWEEN 1 AND 60),
  market_price numeric(18,6), low_price numeric(18,6), mid_price numeric(18,6),
  high_price numeric(18,6), direct_low_price numeric(18,6),
  seen_at timestamptz NOT NULL,             -- when our import last saw this row
  source_updated_at timestamptz NOT NULL,   -- TCGCSV's update time of the snapshot it came from
  PRIMARY KEY (product_id, sub_type_name));
```

- Rows are upserted, never deleted. A row absent from today's response keeps its values and old dates (the "never blank"
  rule). There is no foreign key from price to product, because the two endpoints are imported independently.
- All five figures are stored, but only `market_price` is ever shown (owner answer 1). The others are kept for owner
  diagnostics, at no extra cost.
- Amounts are parsed with `json.loads(..., parse_float=Decimal)`. Three cases are kept apart:
  - **Invalid.** A value that is negative, non-finite, ≥ 10^12 or carries more than 6 fractional digits never overwrites
    the stored field: the upsert keeps the previous value for that field (`COALESCE`-style per field, or a pre-read), and
    `rejected_rows` is incremented.
  - **Legitimate null.** A JSON `null` is today's snapshot truth and is stored.
  - **Zero.** A zero is stored, and readers treat it as no price (§4.5).
- **Null-burst guard.** If, in one group, more than half of the rows that had a non-null `marketPrice` stored now arrive
  with `marketPrice: null`, the group is treated as failed (not written, counted in `groups_failed`). This stops a glitch
  from blanking a set.

### 4.2 The daily import job (`api/app/price_import.py`, wrapper `scripts/price_import_job.py`)

- `run(conn, client=None, *, force=False) -> ImportResult` and `main(argv) -> int`. The exit codes are 0 for `imported` or
  `unchanged`, 1 when the database is unreachable, 2 for `failed` (no group list, or `last-updated.txt` unreadable), and 3
  for `partial` (some groups failed).
- Order of work:
  1. Take session advisory lock **914712** (non-blocking; `git grep 9147` first and pick an unused value if it is taken),
     and exit 0 with "already running" if it is held.
  2. Insert a `price_import` row.
  3. GET `https://tcgcsv.com/last-updated.txt`. If it equals the newest `imported` row's `source_updated_at` and `force` is
     false, the outcome is `unchanged` and the job skips to step 5. If it is **older** than that value, the run records
     `failed` with `error_code='stale_source'` and writes nothing (rebind, art and publish still run).
  4. GET `/tcgplayer/3/groups`, then for each group GET `/products` and `/prices`. Requests are sequential with 100 ms
     spacing, use `httpx` with a 30 s timeout and at most 3 attempts per request (backoff 1 s, 4 s), and send
     User-Agent `PrizeCheck-prices/1 (+<contact>)` with the contact taken as `scripts/scanner_index_job.py` takes it. Each
     group is upserted in its own transaction. A response with `success != true` or a non-list `results` fails only that
     group. A group whose response is empty while PostgreSQL holds rows for it is treated as failed and is not written.
     After the last group, the job reads `last-updated.txt` again. If it moved during the download, the run is `partial`
     with `error_code='source_moved'`, and the next run behaves as `--force`: it ignores the "unchanged" shortcut once,
     because the newest row's `source_updated_at` is the first read.
  5. Run `price_binding.rebind(conn)` (§4.3), then `card_art.refresh_fallbacks(conn)` (§4.8), then
     `public_prices.publish(conn)` (§4.6, best effort, which sets `public_error` on failure).
  6. Finish the row with counts and the outcome.
- **Where it runs.** It runs as a step of ADR 0018's host `catalog-refresh` subcommand, **before** the catalog change
  check. The step is `run_tool /app/scripts/price_import_job.py`, its exit code is logged, a non-zero code makes the
  subcommand exit non-zero at the end, and it never stops the catalog check or the scanner index. The timer stays at 04:00
  UTC, about 8 h after TCGCSV's ~20:00 update, so the day's files are complete. Running the step first means that when
  that day's pull adds Printings, its promotion binds them against fresh rows.
  - *Why the same timer:* it is one unit and one lock, it runs in the same place as the backup, and the steps are
    independent. A separate timer would buy freshness of hours on a once-a-day source.
  - Until #339 ships, the job runs by hand (`prizecheck-deploy.sh tool /app/scripts/price_import_job.py`). The cutover
    needs no timer.
- It never runs in the API process and never runs in a request.

### 4.3 How an Edition maps to `(productId, subTypeName)`

**The product stays the reviewed mapping (ADR 0007, unchanged).** It is `catalog_edition_metadata.product_id` while
`mapping_state='verified'`. The subtype is **derived, not reviewed**. A pure function binds it, and the result is stored in
a table.

Migration `153_price_binding.sql`:

```sql
CREATE TABLE edition_price_binding (
  edition_id uuid PRIMARY KEY REFERENCES catalog_edition(id) ON DELETE CASCADE,
  product_id int NOT NULL, mapping_revision bigint NOT NULL,
  sub_type_name text,                         -- null when unbound
  reason text CHECK (reason IN ('no_product_rows','uncovered_variant','ambiguous','shared_price','unspecified_variant')),
  bound_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((sub_type_name IS NULL) <> (reason IS NULL)));
```

`api/app/price_binding.py`:

```python
FIRST_EDITION = "1st-edition"
NAMES = {("holo", True): ("1st Edition Holofoil",), ("holo", False): ("Holofoil", "Unlimited Holofoil"),
         ("normal", True): ("1st Edition",), ("normal", False): ("Normal", "Unlimited"),
         ("reverse", False): ("Reverse Holofoil",)}
FINISH = {"holo": "holo", "normal": "normal", "reverse": "reverse"}   # legacy {"finish": ...} descriptors use the same words

def sub_type_for(descriptor, offered: frozenset[str]) -> tuple[str | None, str | None]:
    """(sub_type_name, None) or (None, reason). Pure; tested on its own."""
    plain = MatchingRulesV3.plain(descriptor)
    if not isinstance(plain, dict) or is_unspecified(plain): return None, "unspecified_variant"
    if plain.get("size", "standard") != "standard": return None, "uncovered_variant"
    finish = FINISH.get(plain.get("type", plain.get("finish")))
    stamps = plain.get("stamp") or []
    first = FIRST_EDITION in stamps
    extra = special(plain)   # True for any facet beyond KNOWN: other stamps, foil, subtypes outside {unlimited, shadowless}
    names = NAMES.get((finish, first))
    if names is None: return None, "uncovered_variant"
    if not offered: return None, "no_product_rows"
    hits = [n for n in names if n in offered]
    if len(hits) == 1: return hits[0], None
    if hits: return None, "ambiguous"
    # TCGdex sometimes labels a promo's finish wrongly: an ordinary normal/holo Edition takes the product's only price.
    if not first and not extra and finish in ("normal", "holo") and len(offered) == 1 \
            and next(iter(offered)) in ("Normal", "Holofoil"):
        return next(iter(offered)), None
    return None, "uncovered_variant"

KNOWN = {"type", "finish", "size", "subtype", "stamp"}       # thirdParty is already dropped by plain()
def special(plain) -> bool:
    return (bool(set(plain) - KNOWN) or plain.get("subtype") not in (None, "unlimited", "shadowless")
            or any(s != FIRST_EDITION for s in plain.get("stamp") or []))
```

- **Special Editions** are those with any extra facet: a stamp other than 1st Edition (staff, prerelease, Pokémon Center…),
  a `foil` pattern, or another subtype. `sub_type_for` still returns their finish's subtype, but `rebind` binds a special
  Edition **only when it is the sole verified Edition holding that product**: no other verified Edition, of its own
  Printing or any other, has the same `product_id`. Otherwise it is stored unbound with `shared_price`. A stamped
  Edition is therefore priced only when TCGplayer gave it its own product (mep staff 656800, for example), never from the
  unstamped product.

- `rebind(conn) -> dict[str, int]`, **always over the whole catalog.** There is no partial form: the shared-price guard
  needs every Edition holding a product, and a full pass is one query and finishes inside the 30 s bound.
  - Takes `pg_advisory_xact_lock(914713)` (the "price publication" lock, shared with `public_prices.publish`, §4.6).
  - In one REPEATABLE READ snapshot, selects every verified Edition with a product, with its descriptor and
    `mapping_revision`, then the offered subtypes per product from `tcgplayer_price`.
  - Applies `sub_type_for`.
  - **Shared-price guard:** when two or more verified Editions resolve to the same `(product_id, sub_type_name)`, every one
    of them is stored unbound with `shared_price`. One product row cannot price two physical Editions.
  - Upserts changed rows and deletes rows for Editions that are no longer verified.
  - Mapping writers do not take the lock. Correctness under a concurrent mapping change comes from the reader's
    `product_id`/`mapping_revision` match: an Edition verified after the snapshot has no binding, so it is unpriced and
    cannot double-price a sibling's row until the next full rebind sees both.
  - Returns counts by reason plus `bound`.
  - Runs in one transaction and must finish in under 30 s for 40k Editions: one SELECT, Python, then `executemany`.
- **`quote_variant` is retired as a price input.** It is still written by rules and decisions and still published in
  `catalog:edition` records' `quote_lookup` (that record shape is unchanged, to avoid a full public rebuild), but no reader
  uses it for prices. Readers decide price eligibility by verified + `product_id` + binding.
- **Who calls `rebind`:**
  - the import job (all Editions);
  - `catalog._publish_after_commit`, followed by `publish` (best effort, logged, never fails the run). P3 adds the call
    **after** `seed_from_import`, so release A keeps the legacy path whole; P4 deletes seeding;
  - `metadata_reviews.decide` after a marketplace decision commits (full rebind, then `publish`; best effort);
  - the rule activation route after commit (all Editions);
  - `ensure_matching_rule` callers, through the promotion path above.

  A stale binding never prices a different product, because the reader requires `binding.product_id = m.product_id AND
  binding.mapping_revision = m.mapping_revision`. Until the next rebind the Edition is just unpriced.
  - **Remaining stale case.** A sibling newly verified onto the same product leaves the older Edition's binding valid until
    the next rebind. Every caller that can verify an Edition (promotion, decision, activation) triggers a full rebind
    right after its commit, so the window is that call's duration. Daily runs repair any crash.

### 4.4 Matching rule v4 (`MatchingRulesV4(MatchingRulesV3)` in `catalog_targets.py`, registered as 4)

Two product sources, tried in order. Every V1 physical check still applies first: correspondence `source_candidate`, set,
number and name equal to the display.

1. **TCGdex id.** It runs V3's evaluation. If that returns `Failure("no_product")`, it reads the variant's own
   `lookup["thirdParty"]["tcgplayer"]` and accepts it when it is a positive int. In that case `quote_variant =
   cls.finish_key(cls.plain(descriptor))` (may be None), and `verified_elsewhere(product, quote_variant)` must be false
   (else `duplicate`). V3's `conflict` outcomes are not overridden.
2. **Reviewed Black Star promo path (set → group, card number, exact name).**
   - **When it applies.** Only when the Printing has no TCGdex id anywhere (no block product and no
     `thirdParty.tcgplayer`) and its TCGdex set id is in the reviewed table below. It covers every Black Star promo set
     from the Wizards era through ME (owner answer 4). Each group was checked against `/tcgplayer/3/groups` on 2026-10-27.

     | TCGdex set | TCGdex name | TCGCSV group | TCGCSV name | Cards with no TCGdex id | Exact matches (cards) | Left for owner |
     | --- | --- | --- | --- | --- | --- | --- |
     | `basep` | Wizards Black Star Promos | 1418 | WoTC Promo | 0 of 53 | 0 | 0 |
     | `np` | Nintendo Black Star Promos | 1423 | Nintendo Promos | 0 of 40 | 0 | 0 |
     | `dpp` | DP Black Star Promos | 1421 | Diamond and Pearl Promos | 55 of 56 | 31 | 24 |
     | `hgssp` | HGSS Black Star Promos | 1453 | HGSS Promos | 0 of 25 | 0 | 0 |
     | `bwp` | BW Black Star Promos | 1407 | Black and White Promos | 101 of 101 | 64 | 37 |
     | `xyp` | XY Black Star Promos | 1451 | XY Promos | 215 of 216 | 152 | 63 |
     | `smp` | SM Black Star Promos | 1861 | SM Promos | 0 of 248 | 0 | 0 |
     | `swshp` | SWSH Black Star Promos | 2545 | SWSH: Sword & Shield Promo Cards | 0 of 307 | 0 | 0 |
     | `svp` | SVP Black Star Promos | 22872 | SV: Scarlet & Violet Promo Cards | 9 of 226 | 0 | 9 (no TCGCSV product on that number yet) |
     | `mep` | MEP Black Star Promos | 24451 | ME: Mega Evolution Promo | 9 of 89 | 9 | 0 |

     Sizing (TCGdex and TCGCSV, 2026-10-27; counts are cards, and Editions are about the same except dpp, which has about
     12 more variant Editions on matched cards): **about 256 cards gain a price, and about 133 remain for owner review.**
     The sets with all ids stay in the table so a future TCGdex gap is covered without a new rule version. The path does
     nothing for a card that has an id.
   - **Candidates.** `refresh_editions` adds `facts["tcgplayer_candidates"]`: every product in `tcgplayer_product` with
     the mapped `group_id` and the same `number_key`, each as `{product_id, name, number}`. They are read only when the set
     is in the table.
   - **`number_key(n)`:** uppercase, drop any `/total`, then strip leading zeros from the digit run. `DP05` → `DP5`,
     `SWSH001` → `SWSH1`, `001` → `1`, `XY01` → `XY1`. The same function fills `tcgplayer_product.number_key` in P1, so
     P1 must use it rather than plain `upper`.
   - **Exact name.** `match_name(product_name, number)` NFC-normalizes, collapses whitespace and casefolds. It then removes
     exactly one trailing number qualifier, `" - <n>"` or `" (<n>)"`, and only when `number_key(<n>)` equals the card's
     own number key. The result must **equal** the display name, normalized the same way. Everything else stays in the
     name, so `LV.X`, `(Prerelease)`, `[Staff]`, `(Cosmos Holo)`, `(Worlds 07)` and `(Supporter)` all fail.
   - **Collision handling:**
     - exactly one candidate on the number and it matches: accept;
     - several candidates on the number and **exactly one** matches exactly (the others carry qualifiers such as
       `[Staff]` or `(Prerelease)`): accept, for a non-special Edition only;
     - two or more exact matches: `Failure("no_product")`, left for the owner (none seen today);
     - no candidate, or no exact match: `Failure("no_product")`, left for the owner.
   - Accept only for an Edition whose descriptor is not special (§4.3). Special Editions on this path stay unverified for
     the owner.
   - `quote_variant` is the finish key, and the `verified_elsewhere` check applies.
   - Anything else is `Failure("no_product")`.
   - New sets, or changes to the name rule, are added only as a later rule version (the digest is pinned), never by
     editing V4.
   - **Owner review of the matches (P2b).** A card-number match is verified with `mapping_basis='matching_rule'` like any
     rule match. Activating v4 is the owner's approval of the rule, as for every rule.
     - The owner review queue gains a filter, "Matched by card number". It lists every verified Edition whose Printing's
       set is in `TCGPLAYER_GROUPS` and whose candidate carries no TCGplayer id, with the product name, number and group.
       The rule exposes the predicate as `MatchingRulesV4.matched_by_number(facts)` so the list and the rule agree.
     - The owner rejects a match with the existing marketplace decision (unverify, which becomes `reviewed_unmapped`, and
       its fingerprint rejection prevents a re-match).
     - The ~133 unmatched cards appear in the existing unverified queue, where the owner can verify a product by decision.
- Tests pin V4's digest, as `test_registered_rule_digests_are_pinned` does for V1–V3.
- **Unverified Editions.** Activating v4 re-evaluates every `unverified AND NOT auto_closed` Edition (the 9,101
  `rule_failed`), as `activate_rule` already does. Quarantined Editions and owner decisions are untouched (strict
  clearing). The 25 `duplicate_mapping` Editions stay for the owner.
- **Owner mapping decisions.** The shape (`product_id`, optional `quote_variant`) is unchanged. In `plan_marketplace`, a
  decision with `quote_variant: null` is valid, and the binding derives the subtype. No subtype override ships in this
  feature. Ambiguous and shared Editions show on the owner panel, and the owner resolves them by deciding the product or
  leaving the Edition unverified. A subtype override is a later ticket only if the panel shows it is needed.
- **Prod activation** re-evaluates about 9k Editions, and v3 took 18 min on 2 OCPUs while blocking collection writes
  (#343). The cutover therefore runs it on the host at a quiet time, as the Oracle guide's existing step does, unless #343
  has shipped. Activate v4 **after** the first price import, so the group/number path finds `tcgplayer_product` rows. With
  no rows it simply fails those Editions; a later activation of the same version does not re-run them, because they are not
  auto_closed and stay `rule_failed`. Re-running `activate` with v4 again re-evaluates them.

### 4.5 Private reads (`api/app/prices.py`)

Signatures are kept: `private_edition_quotes(edition_ids, budget, releases=None)` and
`stored_edition_quotes(edition_ids, wait_seconds=1.0)`. The `QuoteView` shape is kept for one ticket. `refresh` is always
null, and the field is removed in the retirement ticket. The gateway budget and `BUDGETED_ROUTES` stay, and still bound
the PostgreSQL work.

One REPEATABLE READ query replaces `_read_targets`, the store read, admission, the wait and the final re-read:

```sql
SELECT e.id, e.descriptor, m.mapping_state, m.mapping_reason, m.product_id,
       b.sub_type_name, b.reason AS bind_reason,
       p.market_price, p.low_price, p.mid_price, p.source_updated_at, p.seen_at
FROM catalog_edition e
JOIN catalog_edition_metadata m ON m.edition_id = e.id
LEFT JOIN edition_price_binding b ON b.edition_id = e.id AND b.product_id = m.product_id
                                  AND b.mapping_revision = m.mapping_revision AND m.mapping_state = 'verified'
LEFT JOIN tcgplayer_price p ON p.product_id = b.product_id AND p.sub_type_name = b.sub_type_name
WHERE e.id = ANY(%s)
```

- Labels: `not_found`, `unspecified_variant`, `unverified`, `quarantined` (as today) and a **new `no_price`**. `no_price`
  covers a verified Edition with no binding, an unbound reason, no price row, or a chosen amount that is null or zero.
  `store_unavailable`, `deadline` and `validation_unavailable` keep their meanings for PostgreSQL failure and timeout.
  `not_cached`, `confirmed_absent`, `lookup_mismatch`, `invalid_quote`, `no_quote_variant` and `pending` are no longer
  produced.
- `chosen_amount(row) -> Decimal | None` lives in prices.py and is the only place that picks the figure. It returns
  `market_price`, and None when that is null or ≤ 0. There is no fallback to mid or low (owner answer 1). The other four
  figures are stored but never read by any collector path.
- The amount text is `format(value.normalize(), 'f')`. It must pass the existing `parse_amount` regex, which deck_cost's
  micro-dollar fold relies on. `display_amount` is `format_usd(value)`. `provider_updated_at = source_updated_at`,
  `checked_at = seen_at`, and `stale` is age over 48 h as today. These fields are not rendered on collector screens.
- `catalog.py`: delete the `seed_from_import` import and call, `price_views`, `PRICE_VIEW_KEYS` and `price_view`, and the
  extra `response.json(parse_float=str)` parse. In their place, call `price_binding.rebind` best effort in
  `_publish_after_commit`. This retires ADR 0013 seeding and supersedes #342.

### 4.6 Public reads and the public projection

- **Zero-PostgreSQL stays** (ADR 0006's isolation clause and the Published Deck decision). Anonymous routes keep reading
  only the record store.
- New protected key family `price:<edition_ref>` in `public_records._FAMILIES` (regex `price:([0-9a-f]{48})`, not
  evictable). The value is exactly `{"mapping_revision": int ≥ 1, "product_id": int > 0, "amount": "<parse_amount text>"}`
  (allowlist; no dates, subtype or source).
- `api/app/public_prices.py`:
  - `publish(conn, store=None) -> PublishResult(written, deleted, unchanged)`, always full. **Serialized:** it holds
    session advisory lock 914713 (the same one `rebind` takes as an xact lock) from **before** it reads the desired state
    until its last CAS. Two publishers therefore never interleave, and a retry re-reads PostgreSQL inside the lock
    instead of replaying an old snapshot. It builds the desired values from the §4.5 query (only priced Editions, by
    `public_ref`) and reads the current `price:` records with `read_all`. It then CASes only differences in chunks of ≤128 keys, using the expected versions, `CHUNK_SECONDS`
    deadlines, and up to `ATTEMPTS` re-read-and-retry rounds on a conflict.
  - It also deletes `price:` records whose ref is no longer priced. The refs ever written live in the registry table
    `public_price_ref(edition_ref text PRIMARY KEY)` (migration 153). The registry is kept a **superset** of the store:
    a ref is inserted (committed) **before** its first CAS write, and removed only **after** its CAS delete has
    committed. A crash anywhere leaves extra registry rows, never orphaned records, and the next full publish deletes
    what is no longer wanted. The set to reconcile is `desired ∪ registry`.
  - A changed subtype or a new shared-price decision changes or removes the desired amount, so the next publish writes or
    deletes that record. Mapping revision and product id fence mapping changes; the serialized full publish covers
    binding changes.
  - It never raises out of the job: it returns or records the error.
- **Readers (ticket P5b, release B; everything above this bullet is the P5 writer, release A):**
- `marketplace_states` reads `price:<ref>` at the same pinned generation instead of `quote_states`, for verified,
  product-eligible refs. `MarketplaceState.quote` is renamed `price` (validated dict or None). A record is valid only when
  its keys are exactly the allowlist, `mapping_revision == market.mapping_revision`, `product_id == market.product_id` and
  `parse_amount(amount)` is not None and greater than zero. Otherwise the field is None and the row is unpriced. `price_eligible` becomes
  `product_eligible` (`quote_lookup` no longer required).
- `published_cost.public_quotes`: drop admission and the wait. `_label` returns `no_price` when `state.price is None`, and
  the view is built from `state.price['amount']`. Eligibility and price are read once at one pinned generation (no admission
  wait remains, so there is no final eligibility re-read); the token/version/digest checks are kept unchanged. `editions[]` amounts come from the same views.
- `publish_refresh.py`: remove its admission and its call site, and delete the module once nothing imports it.
- **Lag:** a quarantine still reaches public pages through the outbox as today. A new price reaches them in the same job
  run. A rebind after an owner decision calls `public_prices.publish(conn)` best effort (full, diff-only).

### 4.7 Every consumer, in one table

| Consumer | Reads | Change |
| --- | --- | --- |
| Inspector, gallery tiles, catalog rows, Collection and Deck rows (`EditionPrice.tsx` → `POST /api/prices/editions`) | `private_edition_quotes` | internals only (§4.5). The client keeps viewport batching; nothing in web changes except regenerated types |
| Deck cost, Deck List cost, cost to complete (`deck_cost.py`) | `private_edition_quotes` | none. `fallback_copies` is always 0 (no refresh labels) |
| Want List cost (`want_list_cost.py`), Decks index Want List line | `private_edition_quotes` | none |
| Trade value (`trade_value.py`) | `private_edition_quotes` | none |
| Deck List cheapest pick, deck import, import allocation | `stored_edition_quotes` | internals only |
| Published Deck cost and per-Edition amounts (`published_cost.py`) | `price:` records | §4.6 |
| Mass Entry / Live exports / "Buy on TCGplayer" | `product_id` via mapping (`product_eligible`) | none; they never read prices |

### 4.8 Fallback card art

- Migration `154_fallback_art.sql`: table `catalog_printing_fallback_art(printing_id uuid PRIMARY KEY REFERENCES
  catalog_printing(id) ON DELETE CASCADE, product_id int NOT NULL, chosen_at timestamptz NOT NULL DEFAULT now())`, plus a
  view:

```sql
CREATE VIEW catalog_printing_art AS
SELECT p.id AS printing_id, t.url AS tcgdex_url,
  CASE WHEN t.url IS NOT NULL THEN t.url || '/low.webp'
       WHEN f.product_id IS NOT NULL THEN 'https://tcgplayer-cdn.tcgplayer.com/product/' || f.product_id || '_200w.jpg' END AS low_image_url,
  CASE WHEN t.url IS NOT NULL THEN t.url || '/high.webp'
       WHEN f.product_id IS NOT NULL THEN 'https://tcgplayer-cdn.tcgplayer.com/product/' || f.product_id || '_400w.jpg' END AS high_image_url
FROM catalog_printing p
LEFT JOIN catalog_printing_display pd ON pd.printing_id = p.id
LEFT JOIN catalog_generation_printing gp ON gp.printing_id = p.id
       AND gp.generation_id = (SELECT active_generation FROM catalog_state)   -- catalog_state is one row
CROSS JOIN LATERAL (SELECT coalesce(nullif(gp.image_url, ''), nullif(pd.image_url, '')) AS url) t
LEFT JOIN catalog_printing_fallback_art f ON f.printing_id = p.id;
```

  Required semantics: TCGdex URL = the active generation's
  `image_url`, else the established display's, and only when both are null/empty does the fallback apply. URLs are built
  from the integer id, never copied from TCGCSV's `imageUrl` string.
- `card_art.refresh_fallbacks(conn) -> int`:
  - For non-tombstoned active-generation Printings whose TCGdex URL is null, take candidates from that Printing's verified
    Editions whose `product_id` has `tcgplayer_product.image_count > 0`.
  - Choose the product of an Edition whose plain descriptor has no `stamp`, lowest product_id first; otherwise the lowest
    product_id.
  - Upsert, and delete rows for Printings that now have a TCGdex URL or no candidate.
  - For each Printing whose row changed, enqueue it in the public catalog outbox the way a correction does, so its
    `catalog:printing` record's `image_url` updates (see `public_catalog.mark_all_dirty` (:434) and the per-target
    enqueue used by corrections). `printing_value` reads the view's `low_image_url`.
- **Consumers:** every API module that builds `…/low.webp` or `…/high.webp` from `image_url` switches to selecting
  `art.low_image_url` / `art.high_image_url` from `catalog_printing_art art` (LEFT JOIN on the printing id), and the Python
  suffixing is deleted. **Exceptions:**
  - `scanner.py` and `scripts/scanner_index_job.py` stay TCGdex-only: the scanner page's COEP blocks the CDN (no CORS), and
    the index only fetches `*.tcgdex.net`.
  - Published Deck snapshots (`publications.py`) freeze art at publish time, as today. Old snapshots keep no-image rows
    until republished.
- **Hotlink, not copy.** The owner decided on "image links". The CDN is TCGplayer's, not TCGCSV's, so TCGCSV's
  "no user-facing requests" guidance does not apply. TCGdex images are already hotlinked. There is no CSP to change.
  Copying ~800 × 2 images into our volume would also make us a redistributor and add storage and serve paths.
- **Sizes:** `_200w.jpg` for tiles and rows, `_400w.jpg` for the inspector.
- **Preference:** TCGdex always wins. If TCGdex adds an image later, the next generation carries it, the view prefers it at
  once, and the next `refresh_fallbacks` deletes the fallback row and re-enqueues the Printing.
- **Scanner fingerprints for fallback art:** not in this feature. The art could not be shown on the scanner page, and the
  91 failures are a different problem (TCGdex assets). Recorded as a follow-up.

### 4.9 Staleness and failure

- Collector screens never show age, source or refresh state. The `stale`/`age` fields stay in the API (unrendered) until
  the retirement ticket decides whether to drop them. Keep them: Deck cost's counts use them.
- A failed day leaves every stored price as it was. The owner panel shows the failure and warns when **either** the newest
  `imported`/`unchanged` run is over 48 h old **or** the newest stored `source_updated_at` is over 48 h old. The second
  check matters because repeated `unchanged` runs against a frozen upstream would otherwise look healthy. There is no mail
  (production sends none).
- A product that TCGplayer drops keeps its last price indefinitely (owner answer 3), and collectors see it like any other.
  The owner panel counts priced Editions whose `seen_at` is over 7 days old (`stale_rows`) for information only.

### 4.10 Retirement order

1. **P4 ships (release B):** readers stop touching `quote:`/`result:` and seeding stops. Runner code stays deployed but is
   unreachable, because nothing admits.
2. **P5b ships (release B):** public readers stop touching them.
3. **P9 (≥7 days after the production cutover, owner-approved):**
   - delete `price_runner.py`, `price_launcher.py`, `price_refresh.py`, `price_seed.py`, `price_source.py`,
     `scripts/price_runners.py` and their tests (`test_price_runner`, `test_price_refresh`, `test_price_seed`,
     `test_price_source`, `test_publish_price_refresh`, `auth/tests/price-runners*.ts`, `auth/tests/price-refresh.test.ts`,
     `web/tests/price-refresh.spec.ts`);
   - trim `tcgdex_record.py` to the identity helpers (drop `select_quote`), and `quote_contract.py` to `parse_amount` and
     `wall_ms`, or move those into `prices.py` with re-exports;
   - remove the store families `quote, result, fence, work, lease, admission, backoff` from `_FAMILIES`, after
     `scripts/purge_price_records.py` (new, `--dry-run` default) deletes their keys;
   - drop `PRICE_RUNNER_LOCK_DIR` and the `price-runners` volume from `compose.deploy.yml`, and fix the smoke import at
     `prizecheck-deploy.sh:422`;
   - drop `refresh`/`refresh_failed_at` and the dead reasons from `QuoteView`, and regenerate clients;
   - archive `docs/price-refresh.md` (replace it with a pointer) and rewrite `docs/prices.md`;
   - set ADR 0006, 0008 and 0013 statuses.

### 4.11 Production cutover and rollback

Cutover, written into `docs/planning/tcgcsv-prices/launch-checklist.md` by P8. It is **staged over two releases**, so
readers switch only after the data is complete.

**Release A** carries P1, P2, P3, P5 (the writer of public `price:` records) and optionally P6/P7. Readers are still the
legacy path, migrations 152–154 are additive, and nothing collector-facing changes, except fallback art if P7 is in.

1. Deploy release A, then run `prizecheck-deploy.sh tool /app/scripts/price_import_job.py`. It takes about 2–4 min.
2. At a quiet time, activate matching v4 on the host (the existing Oracle guide command with `('marketplace_matching',
   4)`), unless #343 has shipped, in which case use Owner controls. Then run the job again with `--force`; it rebinds and
   publishes.
3. Check the owner panel (if P6 is in) or query the tables:
   - priced and verified counts;
   - svp, mep and swshp spot checks bound (Koraidon ex 500070, Meganium 654594, staff 656800 bound only if no sibling
     shares it);
   - base1-4's three Editions as in AC 4;
   - `price:` records present for the Editions of an existing Published Deck.

**Release B** carries P4 and P5b (the reader switches). Because the tables and records are already populated, there is no
gap.

4. Deploy release B. Check one card, one Deck cost and one Published Deck cost.
5. Once #339 ships, the timer runs the job daily (P8). Until then, run it by hand daily, or at least before each release.

**Compatibility of release A's data with older code.** If code from before release A runs with v4 active, `load_active`
finds no version 4 and treats matching as inactive (fail closed). Verified Editions stay verified, and new pulls verify
nothing new until v4 code returns. P2's tests must include this case: an old registry with an activation row for an
unknown version gives `load_active` None.

**Rollback: fix forward only (owner answer 5).** Release A is **never** redeployed to bring back TCGdex prices, and no
step in the checklist does so. A broken release B is handled in this order:

1. **Hide prices if they are wrong.** P4 adds the kill switch `PRICE_READS` (`on` by default; any other value is off). It
   is read from the environment by `prices.py` and `published_cost.py`, and passed through `compose.deploy.yml` to `api`
   from the env file. When off, every private and public price row answers `unavailable`/`no_price` without querying
   anything, and Deck, Want List and Trade costs read as `no_quotes`. The operator sets `PRICE_READS=off` in the env file
   and restarts `api` (`prizecheck-deploy.sh compose up -d api`). This needs no image change and never reads TCGdex.
2. **Repair data that stays on TCGCSV.** Rows are never deleted, so a bad import is undone by re-running the job with
   `--force` after a fix, or by restoring the three price tables from the nightly backup. Then run `rebind` and `publish`
   (`price_import_job.py --rebind-only`, added in P3).
3. **Ship a fast follow-up release** from `dev` with the fix (TCGCSV reads kept), then set `PRICE_READS=on` again.

A failure of the readers themselves (exceptions, timeouts) already answers "Price unavailable" per row, so step 1 is only
needed for wrong prices.

### 4.12 Owner panel

The panel extends `GET /api/admin/catalog-runs` (`catalog_status.py`) with `last_price_import` (the newest row) and
`last_good_price_import_at`. `StatusPanel.tsx` shows:

- "Prices: imported <time> (TCGplayer data from <source time>), N of M verified Editions priced";
- unpriced counts by reason;
- "K Printings use TCGplayer art";
- a red line when the outcome is `failed`/`partial` (with `error_code` and `groups_failed`), when `public_error` is set,
  when the last good run is over 48 h old, or when TCGCSV's own update time (`max(source_updated_at)`) is over 48 h old.
  The endpoint also returns `source_updated_at_max`.

Owner screens may name TCGCSV/TCGplayer and show times (AGENTS.md exemption). This lands after #340 if #340 is in flight,
because the files are the same.

### 4.13 Existing tickets

- **#339: unchanged.** P8 adds the price step to its subcommand afterwards, and is blocked by #339.
- **#340: unchanged.** P6 extends the same endpoint and panel, sequenced after it.
- **#341: unchanged**, except that P8 adds the price step to the `portable-jobs.md` row and the launch checklist. The timer
  time stays at 04:00 UTC.
- **#342: superseded** by P4 (seeding is deleted). Close it with the release that carries P4. Per the tickets-close-on-main
  convention, add a "Superseded by" comment now and put the `Closes` line in the release PR.
- **#343: unchanged, and now more important.** The v4 activation is the next long activation. Recommended before the
  cutover; the host-run workaround is otherwise documented in step 3.
- **#338:** unrelated.

## 5. Out of scope

- A price history or trends; a subtype override in owner decisions; scanner fingerprints of fallback art.
- Copying images; any change to COEP/COOP or to the scanner page.
- Group/number matching for non-Black-Star sets (trainer kits, McDonald's, other promo groups). Each would need a new rule
  version and an owner decision.
- Changing the `catalog:edition` record shape, the Published Deck snapshot format, the gateway budget or `BUDGETED_ROUTES`.
- Any collector-visible source name, time or freshness label beyond the one footer credit line (§8, answer 2).
- A fallback to mid or low prices; price expiry for delisted products; any path that re-enables TCGdex prices.
- Contacting TCGCSV; calling TCGCSV from any request path.

## 6. Stop conditions (for every ticket)

Stop and report instead of improvising when any of these happen:

- A referenced symbol, line or file differs materially from this brief: for example, `public_records` has no protected
  family list, `refresh_editions` has no `facts` dict, or `catalog_printing_display` is not immutable.
- TCGCSV returns a field shape or subTypeName outside §3's evidence. The job must still store it, but report it.
- Migration 151–154 numbers collide with something merged meanwhile.
- `rebind` over the full dev catalog takes over 30 s, or `public_prices.publish` over 5 min.
- A test proves a Published Deck route opens a PostgreSQL connection.
- Any collector-facing string other than the footer credit (§8, answer 2) would name TCGCSV/TCGplayer as a price source,
  or any collector-facing string would show a time.
- A verify command fails for a reason the ticket did not anticipate.

## 7. Risks and review notes

- **Wrong-price risk moves from "missing" to "mispriced".** Stamped Editions whose TCGdex id is the unstamped product
  would take the unstamped price when no verified sibling shares it. The shared-price guard catches only verified
  siblings. Review the `sub_type_for` table and the single-subtype fallback carefully, and spot-check mep (staff 656800 vs
  654594) and the McDonald's sets.
- **Group/number path couples matching to TCGCSV data.** It is limited to one reviewed group. A TCGCSV rename after
  verification does not quarantine (the projection covers TCGdex inputs only). This is acceptable because the mapping is
  then owner-reviewable.
- **Public store write volume:** about 30–40k `price:` records. The first publish writes them all (about 300 CAS commits);
  later days write only changed prices. Measure on dev. If the filesystem adapter's daily write is heavy, restrict
  publishing to refs in active Published Deck snapshots (fallback design; stop and report first).
- **Two copies of prices** (PostgreSQL and the store) can disagree for the length of one job run. This is harmless and
  documented.
- **Hotlinked art** sends collectors' browsers to TCGplayer's CDN, as TCGdex art already does with tcgdex.net. There is no
  CSP to update. Check that nothing adds `crossorigin` to non-scanner `<img>` tags (it would break the CDN images).
- **Concurrency:** the import's session lock and `rebind`'s transaction lock keep two jobs from interleaving. Promotion and
  decision rebinds take the same xact lock.
- **Compatibility:** generated clients gain the `no_price` reason. Old web bundles treat unknown reasons as "Price
  unavailable" (checked in `EditionPrice.tsx:137`).
- **Orchestrator double-checks:** that migration 151 is still #339's; the 91 scanner failures query (§3); and that the prod
  v4 activation is scheduled with the owner because of #343.

### Risks added by the owner answers

- **Card-number matching across ten sets** is the largest new wrong-price risk. The exact-name rule rejected every
  qualifier variant in the sample, and no two-exact-match collision was seen. The residual risk is a TCGdex card that is
  physically a stamped copy without a stamp facet, matched to the plain product. The P2b list exists so the owner can
  catch it; ask the owner to skim the dpp list first, since dpp has the most stamped variants.
- **svp's 9 unmatched cards** are newer than TCGCSV's catalog. They match on a later activation of the same version only
  if re-evaluated. P2 adds `price_import_job.py --rematch`, which re-runs the v4 evaluation for `rule_failed` Editions in
  `TCGPLAYER_GROUPS` sets after an import. Use the same batching as activation, and keep it small (at most a few hundred
  Editions).
- **The footer credit** is collector-visible provenance by owner decision. Reviewers should not "fix" it as an AGENTS.md
  violation. AGENTS.md itself is not edited; the decision lives in ADR 0019.
- **The kill switch** must be covered by tests on both the private and the public path, or a broken release B has no
  quick mitigation.

## 8. Owner answers (2026-10-27; decided, do not reopen)

1. **Price shown:** the TCGplayer **market price**. When market is empty the card shows **no price**, with no fallback to
   mid or low. Implemented by `chosen_amount` (§4.5).
2. **Credit:** a small TCGCSV credit in the site footer, visible to collectors. This is the owner's explicit exception to
   AGENTS.md's no-provenance rule, and the only one.
   - **Text:** exactly `Prices from TCGCSV`, where "TCGCSV" links `https://tcgcsv.com` (`rel="noopener"`, same tab).
     It is one line in the caption style (`text-caption text-text-subtle`) with no time, date or freshness.
   - **Where:** at the end of the signed-in shell's page area (`web/src/shell/Shell.tsx`) and of the public layout
     (`web/src/public/PublicLayout.tsx`, which covers Published Deck, invite and sign-in pages). On the Published Deck
     page it sits after the existing TCGdex not-endorsed note.
   - **Not on** the scanner page (`/collection/scan`, a separate isolated document) or any owner screen beyond what the
     shell already shows.
   - **Component:** `web/src/ui/PriceCredit.tsx`, a dependency-free component so the bundle boundary check
     (`scripts/check_bundle_boundary.py`) still passes for the public route.
   - **Ticket:** P4b, shipped with release B, so the credit appears when TCGCSV prices do.
3. **Delisted cards:** keep the last known price **indefinitely** (§4.9).
4. **Promo matching:** apply the reviewed set → group, card-number and exact-name match to **all** Black Star promo sets,
   Wizards era through ME, wherever TCGdex gives no product id. The owner keeps review of the matches (§4.4, tickets P2
   and P2b).
5. **Rollback:** **fix forward only.** Never redeploy release A to restore TCGdex prices. A broken release B is handled by
   the `PRICE_READS` kill switch, a TCGCSV data repair, and a fast follow-up release (§4.11).

> Owner confirmation (2026-10-27): promo number-and-name matches are priced when the v4 rule is activated; the owner
> reviews and rejects from the P2b "Matched by card number" list afterwards (not approve-each-first).
