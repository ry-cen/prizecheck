# TCGCSV prices and fallback art: tickets

Decision: [ADR 0019](../../adr/0019-tcgcsv-daily-prices.md). Design sections are cited as §n. Terms follow `CONTEXT.md`. Proposed label: `feature: tcgcsv prices`. Related tickets:

- #339, #340 and #341 are unchanged; P8 builds on #339, and P6 lands after #340.
- #342 is superseded by P4.
- #343 was unchanged and recommended before the cutover; P11 (#377) now supersedes it.

Each ticket is accepted on its own narrow tests plus `npm run check` and `npm run guardrails`. The pull request is accepted on
green GitHub CI; the full local gate and the burn-in are optional ([verification](../../agents/verification.md)). Collector screens must show no source, time or refresh state
([AGENTS.md](../../../AGENTS.md)). The single exception, decided by the owner, is P4b's footer line "Prices from TCGCSV".

Issues: P1 [#345](https://github.com/ry-cen/prizecheck/issues/345), P2 [#346](https://github.com/ry-cen/prizecheck/issues/346), P2b [#347](https://github.com/ry-cen/prizecheck/issues/347), P3 [#348](https://github.com/ry-cen/prizecheck/issues/348), P4 [#349](https://github.com/ry-cen/prizecheck/issues/349), P4b [#350](https://github.com/ry-cen/prizecheck/issues/350), P5 [#351](https://github.com/ry-cen/prizecheck/issues/351), P5b [#352](https://github.com/ry-cen/prizecheck/issues/352), P6 [#353](https://github.com/ry-cen/prizecheck/issues/353), P7 [#354](https://github.com/ry-cen/prizecheck/issues/354), P8 [#355](https://github.com/ry-cen/prizecheck/issues/355), P9 [#356](https://github.com/ry-cen/prizecheck/issues/356), P10 [#376](https://github.com/ry-cen/prizecheck/issues/376), P11 [#377](https://github.com/ry-cen/prizecheck/issues/377), P12 [#378](https://github.com/ry-cen/prizecheck/issues/378).

Order: P1 → P2 and P3 (parallel) → P2b, P5, P6 and P7 (after P2/P3) → **release A** → P4, P4b and P5b → **release B** → P8 (after
#339) → P9 (≥7 days after release B). The two releases are the staged cutover in [design](design.md) §4.11. Release A changes no
collector-visible price; release B switches readers onto data that is already complete. P4 and P5b must not reach `main`
before release A has run in production.

## P1. Import the daily TCGCSV snapshot into PostgreSQL (#345)

**What to build.**

- Migration `152_tcgcsv_prices.sql`, as in §4.1.
- `api/app/price_import.py`: `run(conn, client=None, *, force=False)` and `main(argv)`, exit codes 0/1/2/3 (§4.2).
- `scripts/price_import_job.py`, which calls `main`.
- The job fetches `last-updated.txt`, groups, and each group's products and prices. It upserts per group, never deletes,
  and records a `price_import` row.
- Binding, art and publish are stubbed until P3/P5/P7: the job calls them only if the modules exist. Simpler: P1 leaves a
  clearly marked call list, and later tickets add to it.

**Acceptance criteria.**

- [ ] With a fake TCGCSV (an `httpx.MockTransport` serving two groups), a run stores every product and price row and
      records `imported` with the counts and `source_updated_at`.
- [ ] `tcgplayer_product.number_key` is `number_key(Number)` ([design](design.md) §4.4). A product without a Number has a null key.
- [ ] Amounts are exact decimals: `954.65` stays `954.650000`.
- [ ] A negative, non-finite, ≥10^12 or 7-decimal value **keeps the previously stored value** of that field and counts
      in `rejected_rows`. A legitimate JSON null stores NULL, and a zero stores 0.
- [ ] Null-burst guard: when more than half of a group's previously non-null market prices arrive null, the group is not
      written and counts in `groups_failed`.
- [ ] A `last-updated.txt` older than the newest stored `source_updated_at` records `failed` with `stale_source` and
      writes no rows.
- [ ] A `last-updated.txt` that changes between the start and the end of the download records `partial` with
      `source_moved`, and the next run does not take the "unchanged" shortcut.
- [ ] A second run whose `last-updated.txt` is unchanged records `unchanged` and makes no group requests. `--force`
      re-fetches.
- [ ] A group whose `/prices` fails after 3 attempts, returns `success: false`, or returns an empty list where rows exist
      leaves that group's stored rows and dates untouched, and the run is `partial` (exit 3).
- [ ] The group list or `last-updated.txt` failing records `failed` with an `error_code` and exits 2. No row is changed.
- [ ] A row missing from today's response keeps its earlier values, `seen_at` and `source_updated_at`.
- [ ] A second job started while one runs exits 0 without work (advisory lock).
- [ ] Requests carry `PrizeCheck-prices/1 (+contact)`, and no payload or secret reaches the logs.
- [ ] Nothing in `api/app` outside `price_import.py` imports `httpx` for tcgcsv.com (guardrail grep in the test).

**Blocked by.** Nothing.

**Likely touched.** New `migrations/152_tcgcsv_prices.sql`, `api/app/price_import.py`, `scripts/price_import_job.py` and
`api/tests/test_price_import.py` (copy the fake-source style of `api/tests/test_catalog.py` and the job style of
`api/tests/test_scanner_index_job.py`).

**Verification.** `npm run verify -- --suite api -- api/tests/test_price_import.py`

## P2. Matching rule v4: TCGdex variant ids and the reviewed Black Star promo path (#346)

**What to build.**

- `MatchingRulesV4` registered as 4 (§4.4), with:
  - `TCGPLAYER_GROUPS`, the ten Black Star promo sets with their verified group ids;
  - `number_key` and `match_name`;
  - the collision rules;
  - `matched_by_number(facts)`.
- `refresh_editions` adds `facts["tcgplayer_candidates"]` only for sets in `TCGPLAYER_GROUPS`.
- `price_import_job.py --rematch`: after an import, re-evaluate `unverified` `rule_failed` Editions of
  `TCGPLAYER_GROUPS` sets under the active rule. It covers promos TCGCSV lists later, such as svp's 9 unmatched cards.
  It uses `refresh_editions` in batches of 500, each batch in its own transaction.
- `plan_marketplace` accepts a decision with `quote_variant: null` without the TCGdex block check.
- The Oracle guide's activation example uses the newest version.

**Acceptance criteria.**

- [ ] An svp-shaped Edition (variant `thirdParty.tcgplayer` 477184, `pricing.tcgplayer: null`) is verified with product
      477184 under v4 and fails `no_product` under v3.
- [ ] base1-4's three variants verify: unlimited to 42382; Shadowless and 1st Edition Shadowless both to 106999 (siblings
      may share a product).
- [ ] A thirdParty id already verified on another Printing gives `duplicate_mapping`. V3's `conflict` cases are still
      conflicts under v4.
- [ ] An xyp Edition verifies to the single TCGCSV product with its group 1451, number `XY01` and an **equal**
      normalized name ("Chespin - XY01" equals "Chespin"). A bwp `BW02` Tepig matches "Tepig (BW02)".
- [ ] These fail and stay `rule_failed`:
  - "Torterra LV.X - DP09" against "Torterra";
  - "Minccino - BW13 (Cosmos Holo)" against "Minccino";
  - "Dragalge - XY10 (Prerelease)" against "Dragalge";
  - a prefix-only match;
  - a qualifier for another number.
- [ ] Several products on one number with exactly one exact name (the others `[Staff]`/`(Prerelease)`): a non-special
      Edition verifies to that one, and a special Edition does not. Two exact matches give `no_product`.
- [ ] `number_key`: `DP05`→`DP5`, `SWSH001`→`SWSH1`, `001`→`1`, `XY01`→`XY1`, `12/102`→`12`.
- [ ] `TCGPLAYER_GROUPS` equals exactly `{basep:1418, np:1423, dpp:1421, hgssp:1453, bwp:1407, xyp:1451, smp:1861,
      swshp:2545, svp:22872, mep:24451}`, and a set outside it never takes the path.
- [ ] A card in a listed set that has a TCGdex id never takes the number path.
- [ ] `--rematch` verifies an Edition whose product appeared in `tcgplayer_product` after the activation, and leaves other
      Editions untouched. With two
      products on its number (`XY27`), with none, or with no `tcgplayer_product` rows at all, it stays unverified
      `rule_failed`. A set not in the table never takes this path.
- [ ] `test_registered_rule_digests_are_pinned` pins v4's digest. Editing V1–V3 still fails it.
- [ ] Activating v4 re-evaluates unverified, not auto-closed Editions only. Quarantined and maintainer-decided Editions
      are unchanged.
- [ ] With `MARKETPLACE_MATCHING=automatic`, `ensure_matching_rule` activates v4.
- [ ] Compatibility: with an activation row for a version the registry lacks (simulating older code after v4 was
      activated), `load_active` returns None and an import verifies nothing new, while verified Editions stay verified.

**Blocked by.** P1 (the `tcgplayer_product` table, for the group/number path).

**Likely touched.** `api/app/catalog_targets.py`, `api/app/metadata_reviews.py`, `api/tests/test_catalog_targets.py`,
`api/tests/test_metadata_reviews.py` and `docs/deployment-oracle.md` (version in the activation command).

**Verification.** `npm run verify -- --suite api -- api/tests/test_catalog_targets.py api/tests/test_metadata_reviews.py
api/tests/test_catalog_metadata.py`

## P2b. Owner reviews card-number matches (#347)

**What to build.**

- The owner review queue (`metadata_reviews.review_queue`, `GET` under the existing admin metadata routes) gains the
  filter `matched=card_number`. It lists verified Editions where `MatchingRulesV4.matched_by_number` holds, each with its
  set, card number, display name, the matched product's id, name and group, and the rule version.
- The owner metadata screen gains a "Matched by card number" view with that list. Each row offers the existing marketplace
  decision to unverify (reject). The owner screen may name TCGplayer and show product names.
- The owner panel (P6) shows the count with a link to the list.

**Acceptance criteria.**

- [ ] After v4 verifies two dpp Editions by number and one svp Edition by its TCGdex id, the filter lists the two dpp
      Editions only.
- [ ] Rejecting one through the existing decision makes it `unverified`/`reviewed_unmapped`. It leaves the list, loses its
      binding and price at the next rebind and publish, and a later activation or `--rematch` does not verify it again.
- [ ] A non-owner gets 403. No collector response exposes the list.
- [ ] Generated clients are regenerated. A browser test shows the list and a reject on the owner screen.

**Blocked by.** P2.

**Likely touched.** `api/app/metadata_reviews.py`, `api/app/catalog_targets.py` (the predicate), the owner metadata
screen under `web/src/owner/`, the generated client, `api/tests/test_metadata_reviews.py` and
`web/tests/owner-controls.spec.ts` (or the metadata review spec, if a separate one exists).

**Verification.** `npm run verify -- --suite api -- api/tests/test_metadata_reviews.py -k card_number`;
`npm run verify -- --suite browser -- web/tests/owner-controls.spec.ts`.

## P3. Bind each verified Edition to one product subtype (#348)

**What to build.**

- Migration `153_price_binding.sql` (`edition_price_binding`; also `public_price_ref` if P5 needs it).
- `api/app/price_binding.py` with `sub_type_for` and `rebind` (§4.3).
- `rebind` is always full (no partial form). It is called by the import job, after catalog promotion (best effort,
  **after** the existing `seed_from_import`, which P4 removes), after a marketplace decision, and after a rule
  activation.
- The special-Edition rule and the shared-price guard follow [design](design.md) §4.3.
- `price_import_job.py --rebind-only` runs `rebind`, `refresh_fallbacks` (once P7 exists) and `publish` (once P5 exists)
  without fetching. It is the data-repair step of the fix-forward plan.

**Acceptance criteria.**

- [ ] `sub_type_for` table test:
  - holo + 1st-edition stamp with {Unlimited Holofoil, 1st Edition Holofoil} → 1st Edition Holofoil;
  - holo + shadowless with the same set → Unlimited Holofoil;
  - holo with {Holofoil} → Holofoil;
  - normal with {Normal, Reverse Holofoil} → Normal;
  - reverse → Reverse Holofoil;
  - normal with {1st Edition, Unlimited} → Unlimited;
  - normal + 1st-edition with the same set → 1st Edition;
  - jumbo → `uncovered_variant`;
  - Unspecified Variant → `unspecified_variant`;
  - empty set → `no_product_rows`;
  - plain normal with only {Holofoil} → Holofoil (single-subtype fallback);
  - stamped (staff) normal with only {Holofoil} → `uncovered_variant` (no fallback for special Editions);
  - 1st-edition holo with only {Holofoil} → `uncovered_variant`.
- [ ] Two verified Editions that resolve to the same (product, subtype) are both stored unbound with `shared_price`.
- [ ] A special Edition (staff stamp, `foil` facet, or another subtype) is bound only when no other verified Edition holds
      its product. A staff Edition on its own product binds, and a staff Edition sharing the unstamped product is
      `shared_price`.
- [ ] Verifying a second Edition onto an already-bound (product, subtype) and then running the post-commit rebind unbinds
      both. The reader prices neither, and after `publish` neither public record remains.
- [ ] An Edition that stops being verified loses its binding row. A product change while verified rebinds to the new
      product on the next `rebind`.
- [ ] A catalog promotion followed by its post-commit step leaves the new verified Editions bound. A `rebind` failure is
      logged and never fails the run.
- [ ] `rebind` over a 40,000-Edition fixture finishes inside 30 s (mark `slow`, `capacity:`).
- [ ] The import job records `verified_editions`, `priced_editions` and `unpriced` counts by reason.

**Blocked by.** P1.

**Likely touched.** New `migrations/153_price_binding.sql`, `api/app/price_binding.py` and
`api/tests/test_price_binding.py`; also `api/app/price_import.py`, `api/app/catalog.py` (`_publish_after_commit`) and
`api/app/metadata_reviews.py` (after-commit hooks).

**Verification.** `npm run verify -- --suite api -- api/tests/test_price_binding.py api/tests/test_price_import.py
api/tests/test_catalog.py -k "promot or publish"`

## P4. Read every private price from PostgreSQL and stop seeding (supersedes #342) (#349)

**What to build.**

- In `api/app/prices.py`, replace the store read, admission, wait and final re-read with the one query of §4.5.
- Add the `no_price` reason and `chosen_amount`.
- Keep the signatures and `QuoteView` (`refresh` always null).
- Delete seeding from `catalog.py` (`seed_from_import`, `price_views`, `price_view`, the second parse).
- Rewrite the test price fixture to seed `tcgplayer_price` and `edition_price_binding` rows instead of `quote:`/`result:`
  records.
- Regenerate clients.

- Add the `PRICE_READS` kill switch ([design](design.md) §4.11): read by `prices.py` and passed to `api` in `compose.deploy.yml`
  (`PRICE_READS: ${PRICE_READS:-on}`), with the line documented in both env examples.

**Acceptance criteria.**

- [ ] `POST /api/prices/editions` returns `quote` with `display_amount` from the bound row's **market** price only. A row
      with a null market price and a non-null low or mid price is `no_price` (owner answer 1).
- [ ] With `PRICE_READS=off`, every price row is `unavailable`/`no_price`, Deck, Want List and Trade costs are
      `no_quotes`, and no price query runs (patch `psycopg.connect` to count). Unset or `on` behaves normally. A verified,
      unbound Edition, a null market price or a zero market price is `unavailable`/`no_price`. Unverified, quarantined and
      Unspecified Variant rows keep their reasons.
- [ ] No price route reads or writes the record store, and none calls `price_refresh` (patch both to raise in the tests).
- [ ] A binding whose `mapping_revision` or `product_id` no longer matches the mapping is ignored (`no_price`).
- [ ] Deck cost, Want List cost and Trade value give the same figures as before for equal amounts (existing tests pass with
      the new fixture). `fallback_copies` is `"0"`.
- [ ] `stored_edition_quotes` gives the cheapest-pick and import-allocation answers from the same rows, and returns None
      when PostgreSQL cannot answer inside its 1 s.
- [ ] A PostgreSQL timeout gives `deadline`/`validation_unavailable` as before.
- [ ] A catalog pull no longer writes any `quote:`/`result:`/`fence:` record.
- [ ] `web/tests/prices.spec.ts` and `workspace-prices.spec.ts` show prices for seeded rows. Apart from the P4b footer
      credit, no collector page text names TCGCSV or TCGplayer as a source, and none shows a time.

**Blocked by.** P3, and release A on `main` and run in production. Do not merge to `dev` before that.

**Likely touched.** `api/app/prices.py`, `api/app/catalog.py`, `api/tests/test_price_fixture.py`, `api/tests/test_prices.py`,
`api/tests/test_deck_cost.py`, `api/tests/test_want_list_cost.py`, `api/tests/test_trade_value.py` and the tests of
`deck_list_printing`/`deck_import`; also `web/src/prices_generated.ts` (regenerated), `web/tests/prices.spec.ts` and
`web/tests/workspace-prices.spec.ts`, plus the fixtures they use.

**Verification.** `npm run verify -- --suite api -- api/tests/test_prices.py api/tests/test_deck_cost.py
api/tests/test_want_list_cost.py api/tests/test_trade_value.py api/tests/test_price_fixture.py`, then
`npm run verify -- --suite browser -- web/tests/prices.spec.ts web/tests/workspace-prices.spec.ts
web/tests/deck-cost.spec.ts web/tests/want-list-cost.spec.ts`.

## P4b. "Prices from TCGCSV" footer credit (owner decision; release B) (#350)

**What to build.**

- `web/src/ui/PriceCredit.tsx` renders one line: `Prices from <a href="https://tcgcsv.com" rel="noopener">TCGCSV</a>`,
  in `text-caption text-text-subtle`, with no date or time.
- Render it at the end of the signed-in shell's page area (`web/src/shell/Shell.tsx`) and of the public layout
  (`web/src/public/PublicLayout.tsx`). On the Published Deck page it comes after the TCGdex not-endorsed note.
- Not on the scanner page.
- Add a comment beside the component pointing to ADR 0019's exception to AGENTS.md.

**Acceptance criteria.**

- [ ] A signed-in Collection page, a catalog page, a Published Deck page and the sign-in page each show exactly one "Prices
      from TCGCSV" line whose link's `href` is `https://tcgcsv.com`.
- [ ] `/collection/scan` shows no credit.
- [ ] The credit shows no time or date, and it is the only collector-visible mention of TCGCSV (a browser test scans page
      text on the four pages for "TCGCSV" and "TCGplayer" and finds only the footer line).
- [ ] The footer is readable at phone width and does not overlap fixed bottom controls (Collection's phone layout).
- [ ] `scripts/check_bundle_boundary.py` still passes (`npm run guardrails`).

**Blocked by.** Nothing, but merge with release B (P4) so the credit appears with TCGCSV prices.

**Likely touched.** New `web/src/ui/PriceCredit.tsx`, `web/src/shell/Shell.tsx`, `web/src/public/PublicLayout.tsx` and
`web/src/public/PublishedDeckPage.tsx` (placement only); new `web/tests/price-credit.spec.ts`.

**Verification.** `npm run verify -- --suite browser -- web/tests/price-credit.spec.ts web/tests/published-deck.spec.ts`;
`npm run check`; `npm run guardrails`.

## P5. Publish public price records (writer only; release A) (#351)

**What to build.**

- The `price:` key family (§4.6) and `api/app/public_prices.publish`: full, serialized under lock 914713, with the
  `public_price_ref` superset registry.
- The import job, the post-promotion step and the decision rebind call `publish`.
- No reader changes. Published Deck cost keeps its legacy path until P5b.

**Acceptance criteria.**

- [ ] After `publish`, each priced Edition has exactly one `price:<ref>` record of `{mapping_revision, product_id,
      amount}`. A second `publish` with no changes writes nothing. A changed price writes only that record. An Edition
      that stops being priced has its record deleted.
- [ ] Two `publish` calls started together run one after the other (lock), and the second re-reads PostgreSQL: a price
      changed between them ends in the store at its newest value.
- [ ] A crash simulated after the registry insert and before the CAS, and another after the CAS delete and before the
      registry delete, both reconcile on the next `publish` with no orphan record.
- [ ] A store failure during `publish` sets `public_error` on the import row and never fails the import.
- [ ] A first `publish` of 40,000 records on the filesystem adapter finishes within 5 min (mark `slow`, `capacity:`).
      Record the measured time in the ticket evidence.

**Blocked by.** P3.

**Likely touched.** `api/app/public_records.py`, new `api/app/public_prices.py`, `migrations/153_price_binding.sql` (the
registry table, if P3 has not merged yet; otherwise a new `155_public_price_ref.sql`), `api/app/price_import.py`,
`api/app/catalog.py` and `api/app/metadata_reviews.py`; tests: new `api/tests/test_public_prices.py` and
`api/tests/test_public_records.py`.

**Verification.** `npm run verify -- --suite api -- api/tests/test_public_prices.py api/tests/test_public_records.py`

## P5b. Price Published Decks from the public price records (release B) (#352)

**What to build.**

- In `marketplace_states`, read `price:` instead of `quote_states`, rename `MarketplaceState.quote` to `price`, and make
  `price_eligible` mean `product_eligible`.
- Remove admission from `published_cost.public_quotes`.
- Remove `publish_refresh`.

**Acceptance criteria.**
- [ ] Published Deck cost totals and `editions[]` amounts come from those records. A record with another
      `mapping_revision` or `product_id`, extra keys, or a bad amount leaves that row unpriced.
- [ ] A quarantine delivered through the outbox unprices the row even though its `price:` record remains.
- [ ] `test_published_cost.py` still patches `psycopg.connect` to raise for every public call, and
      `auth/tests/published-cost.test.ts` still counts zero database connections.
- [ ] Publishing a Deck no longer admits anything (`publish_refresh` is gone; nothing imports it).
- [ ] With `PRICE_READS=off`, Published Deck cost answers `no_quotes` with every `editions[]` amount null, and reads no
      `price:` record.

**Blocked by.** P5, and release A on `main` and run in production. Do not merge to `dev` before that, because `dev` is what the next release takes.

**Likely touched.** `api/app/public_catalog.py`, `api/app/published_cost.py`, `api/app/publish_refresh.py` (deleted) and
its caller; tests `test_public_catalog.py`, `test_published_cost.py`, `test_publish_price_refresh.py` (deleted) and
`auth/tests/published-cost.test.ts`.

**Verification.** `npm run verify -- --suite api -- api/tests/test_published_cost.py api/tests/test_public_catalog.py`; `npm run verify -- --suite auth` (published-cost
isolation; it is slow-tagged, so run it without `--fast`); `npm run verify -- --suite browser --
web/tests/published-cost.spec.ts web/tests/published-deck.spec.ts`.

## P6. Owner controls shows the price import (#353)

**What to build.**

- `GET /api/admin/catalog-runs` gains `last_price_import` and `last_good_price_import_at`.
- The status panel lines of §4.12.

**Acceptance criteria.**

- [ ] Before any import the panel says prices have not been imported. After an `imported` run it shows the import time,
      TCGCSV's update time, "N of M verified Editions priced", unpriced counts by reason and the fallback-art count.
- [ ] `partial`, `failed`, a set `public_error`, a last good run older than 48 h, and `source_updated_at_max` older
      than 48 h even though the latest run is `unchanged` each show their own warning line (one test each).
- [ ] The panel shows "N Editions matched by card number", linking to the P2b list (once P2b exists).
- [ ] A non-owner gets 403. `GET /api/catalog/status` and every collector page carry no import text (a browser test checks
      a collector's catalog page).
- [ ] Generated clients are regenerated. The panel stays readable at phone width.

**Blocked by.** P1, P3. Land after #340 if #340 is in flight (same files).

**Likely touched.** `api/app/catalog_status.py`, `web/src/owner/StatusPanel.tsx`, `web/src/owner/health.ts` and
`web/src/generated.ts`; tests `api/tests/test_catalog.py` (`-k catalog_runs`) and `web/tests/owner-controls.spec.ts`.

**Verification.** `npm run verify -- --suite api -- api/tests/test_catalog.py -k catalog_runs`;
`npm run verify -- --suite browser -- web/tests/owner-controls.spec.ts`.

## P7. TCGplayer art for Printings without a TCGdex image (#354)

**What to build.**

- Migration `154_fallback_art.sql` (table and `catalog_printing_art` view, §4.8).
- `api/app/card_art.refresh_fallbacks`, called by the import job after `rebind`.
- Changed Printings are enqueued in the public catalog outbox.
- Every API image consumer except the scanner reads `low_image_url`/`high_image_url` from the view. The `/low.webp` and
  `/high.webp` suffixing is deleted from those modules.

**Acceptance criteria.**

- [ ] A Printing with no TCGdex image and a verified Edition whose product has `image_count > 0` gets
      `https://tcgplayer-cdn.tcgplayer.com/product/<id>_200w.jpg` (low) and `_400w.jpg` (high). With `image_count = 0`,
      or no verified product, it gets no image.
- [ ] Among several candidates, an Edition without a stamp wins, and then the lowest product id.
- [ ] A Printing with a TCGdex image (active generation or display) never gets fallback art. When a new generation gains
      a TCGdex image, the view shows it at once, and the next `refresh_fallbacks` deletes the fallback row and enqueues
      the Printing.
- [ ] Catalog search, card detail, Collection, Deck, Want List, trading, discovery and friend-read responses use the view.
      The `catalog:printing` public record carries the fallback low URL after delivery.
- [ ] Scanner responses (`scanner.py`) and the scanner index job are unchanged (TCGdex only).
- [ ] A guardrail test fails when any `api/app` module other than `scanner.py` builds `"/low.webp"` or `"/high.webp"`.
- [ ] The import row's `fallback_art` count equals the table's row count.
- [ ] Browser: a gallery tile and the inspector render the CDN URL for a fallback Printing (fixture image route stubbed).

**Blocked by.** P1, P3 (needs `tcgplayer_product` and bound/verified products; it does not need P4).

**Likely touched.** New `migrations/154_fallback_art.sql` and `api/app/card_art.py`; also `api/app/catalog_search.py`,
`collection.py`, `holdings.py`, `decks.py`, `deck_list_display.py`, `deck_import.py`, `want_list.py`, `catalog_browse.py`,
`discovery.py`, `missing_cards.py`, `deck_ownership.py`, `trade_list.py`, `trade_inventory.py`, `trade_wants.py`,
`loan_inventory.py`, `social/trade_matches.py`, `social/friend_reads.py`, `social/trades.py`, `social/loans.py`,
`publications.py`, `public_catalog.py` and `api/app/price_import.py`; tests: new `api/tests/test_card_art.py` plus the
touched modules' tests.

**Verification.** `npm run verify -- --suite api -- api/tests/test_card_art.py api/tests/test_catalog_search.py
api/tests/test_public_catalog.py` plus each touched module's test file; `npm run verify -- --suite browser --
web/tests/workspace-prices.spec.ts` (or the gallery spec the worker extends).

## P8. Run the price import every day from `catalog-refresh`, and the cutover checklist (#355)

**What to build.**

- In `prizecheck-deploy.sh`'s `catalog-refresh` subcommand (from #339), run `price_import_job.py` first. Log its exit
  code, continue to the catalog check and the scanner index whatever it returned, and exit non-zero at the end when it was
  2 or 3.
- Add the job to `docs/operations/portable-jobs.md` (row, exit codes, link to ADR 0019).
- `docs/deployment-oracle.md`'s catalog step mentions the first price import.
- Add `docs/planning/tcgcsv-prices/launch-checklist.md` with the cutover and rollback of §4.11.
- Add ADR 0019 to `docs/adr/`.

**Acceptance criteria.**

- [ ] `catalog-refresh` with a stubbed `docker` runs the price job, then the check, then the index. A price exit of 2
      still runs the check and the index and ends non-zero. A price exit of 0 changes nothing else.
- [ ] `catalog-refresh` and the job appear in `usage` and in the deploy-script tests.
- [ ] The launch checklist lists the two-release cutover of [design](design.md) §4.11 (release A: the deploy, the first import by hand, the v4 activation on the host (or through Owner
      controls once #343 ships), the `--force` re-import and the spot checks of AC 4/5; release B: the reader switch and its checks) and the fix-forward procedure (`PRICE_READS=off`, `--rebind-only` or a
      `--force` re-import, a follow-up release). It says plainly that release A is never redeployed to restore TCGdex
      prices.
- [ ] Every path and command in the new text exists.

**Blocked by.** #339, P1.

**Likely touched.** `deploy/host/prizecheck-deploy.sh`, `tests/tooling/test_deploy_pipeline.py`,
`tests/tooling/test_host_deploy_script.py`, `docs/operations/portable-jobs.md`, `docs/deployment-oracle.md`, new
`docs/planning/tcgcsv-prices/launch-checklist.md` and new `docs/adr/0019-tcgcsv-daily-prices.md`.

**Verification.** `npm run guardrails` (runs the deploy pipeline tests); `npm run verify -- --suite api --
tests/tooling/test_host_deploy_script.py` if that file is not in guardrails.

## P9. Retire the price runner, admission, seeding and their records (#356)

Run this at least 7 days after the production cutover, with owner approval.

**What to build.** Everything in §4.10 step 3, including:

- `scripts/purge_price_records.py` (`--dry-run` by default; deletes `quote/result/fence/work/lease/admission/backoff` keys
  in CAS batches);
- `docs/prices.md` rewritten for the new model;
- ADR 0006, 0008 and 0013 status lines pointing to 0019.

**Acceptance criteria.**

- [ ] The listed modules, the script, the tests and the `PRICE_RUNNER_LOCK_DIR` env and volume are gone. `git grep -n
      "price_runner\|price_launcher\|price_refresh\|price_seed\|price_source\|PRICE_RUNNER_LOCK_DIR"` finds only
      historical docs and ADRs.
- [ ] `tcgdex_record.py` keeps only identity helpers, and catalog import and metadata review tests pass.
- [ ] `QuoteView` has no `refresh`/`refresh_failed_at`, and the reason literal lists only produced reasons. Clients are
      regenerated, and the web compiles (`npm run check`).
- [ ] `purge_price_records.py --dry-run` reports counts by family. Without `--dry-run` it deletes them. A rerun finds none.
      Unknown families are untouched.
- [ ] The deploy smoke import (`prizecheck-deploy.sh:422`) imports the new modules.
- [ ] `docs/price-refresh.md` is reduced to a pointer, and `docs/prices.md` describes import, binding, reads, public
      records and failure.

**Blocked by.** P4, P5b, P8, release B, and 7 days in production after it.

**Likely touched.** `api/app/price_*.py`, `api/app/quote_contract.py`, `api/app/tcgdex_record.py`, `api/app/prices.py`,
`api/app/public_records.py`, `scripts/price_runners.py`, new `scripts/purge_price_records.py`, `compose.deploy.yml`,
`docker-compose.yml`, `deploy/host/prizecheck-deploy.sh`, the tests named in §4.10, `docs/prices.md`,
`docs/price-refresh.md`, `docs/adr/0006-*.md`, `0008-*.md`, `0013-*.md` and `scripts/check_guardrails.py` (if it names
runner tests).

**Verification.** `npm run verify -- --fast`, because P9 deletes across suites, then, because it crosses suites, an
integration run on CI (`gh workflow run verify.yml -f integration=sharded`) before the release PR.

## P10. Matching rule v5: card-level TCGplayer ids and the 30th Anniversary sets (#376)

Added after release (v0.2.1). Design §4.14.

**What to build.**

- `MatchingRulesV5(MatchingRulesV4)` registered as 5 (§4.14), with:
  - `card_product`, the card-level TCGdex `thirdParty.tcgplayer` for a plain Edition whose variant names no id (source 3);
  - `TCGPLAYER_GROUPS`, V4's ten sets plus `30th: 24722` and `30th-c: 24837`;
  - `NAME_ONLY_SETS = {"30th-c"}` and the name-only match.
- `refresh_editions` fills `tcgplayer_candidates` from the active rule's table: the group's numbered products for name-only
  sets, and `number_key` matches otherwise. For name-only sets it also fills `set_name_count`.
- `tcgplayer_candidates`, `rematch_promos` and `matched_by_number_editions` read the active rule's table and predicate
  (falling back to the newest registered rule) instead of `MatchingRulesV4` directly.
- The owner list "Matched by card number" becomes "Matched by number or name" and includes the 30th sets.

**Acceptance criteria.**

- [ ] An `xy11-116`-shaped Edition (one variant `{type: normal}` with no `thirdParty`, card `thirdParty.tcgplayer`
      121240, no `pricing` in the stored record) verifies to 121240 under v5 and fails `no_product` under v4. With
      TCGCSV offering only `Holofoil` it binds `Holofoil`. With `Normal` and `Holofoil` both offered it binds `Normal`.
- [ ] A card with `normal` and `reverse` variants and only a card-level id verifies both to that product. They bind
      `Normal` and `Reverse Holofoil`.
- [ ] A stamped (non-1st-Edition) variant of such a card stays `rule_failed`.
- [ ] A variant with its own `thirdParty.tcgplayer` uses that id, not the card's.
- [ ] The card's product already verified on another Printing gives `duplicate_mapping`.
- [ ] A `30th` Edition `021` "Greninja ex" verifies to the product numbered `021/128` named "Greninja ex - 021/128".
      `087` "Nidoran♀" against "Nidoran F" stays `rule_failed`. A sealed product with no number is never a candidate.
- [ ] A `30th-c` Edition `001` "Charizard" verifies to the group's product "Charizard", numbered `4/102`. `003`
      "Metagross" against "Metagross (Delta Species)" stays `rule_failed`. Two Printings with the same name in a
      name-only set both stay `rule_failed`, even when one product matches exactly.
- [ ] A `30th-c` Printing verified by name gets TCGplayer fallback art from `card_art.refresh_fallbacks` (TCGdex has no
      image for any of the 30; all 30 TCGCSV products have one). A `30th` Printing keeps its TCGdex image.
- [ ] `TCGPLAYER_GROUPS` equals exactly V4's table plus `{30th: 24722, 30th-c: 24837}`, and `NAME_ONLY_SETS` equals
      `{30th-c}`. A set outside the table never takes the set path, and a card with a TCGdex id never takes it.
- [ ] `--rematch` verifies a `30th` Edition whose product appears in `tcgplayer_product` after activation.
- [ ] The owner list shows a `30th-c` name match beside a dpp number match. Rejecting it keeps it unverified through
      later activations and rematches.
- [ ] `test_registered_rule_digests_are_pinned` pins v5's digest. Editing V1–V4 still fails it.
- [ ] Applying v5 (through P11's rollout) re-evaluates unverified, not auto-closed Editions only. Quarantined and
      maintainer-decided Editions are unchanged.
- [ ] No collector response or screen changes, apart from cards that now have a price.

**Blocked by.** P11 [#377](https://github.com/ry-cen/prizecheck/issues/377) (v5 reaches production by deploy, not by an owner activation). The code can be built in parallel.

**Likely touched.** `api/app/catalog_targets.py`, `api/app/metadata_reviews.py`, `web/src/owner/NumberMatches.tsx`,
`api/tests/test_catalog_targets.py`, `api/tests/test_metadata_reviews.py` and `api/tests/test_price_binding.py`.

**Verification.** `npm run verify -- --suite api -- api/tests/test_catalog_targets.py api/tests/test_metadata_reviews.py
api/tests/test_price_binding.py`, plus `npm run check` and `npm run guardrails`.

## P11. Deploying a release applies its newest catalog rules (#377)

Decision: [ADR 0021](../../adr/0021-deploy-applies-newest-catalog-rules.md). Design §4.15. Supersedes #343. This touches
concurrency, a migration and a public (owner) interface, so it needs an independent review before it merges.

**What to build.**

- Migration `157_rule_rollout.sql`: `catalog_rule_activation.source` and `release_commit`, plus the
  `catalog_rule_rollout` table (§4.15 point 2).
- `api/app/rule_rollout.py`: `apply_newest_rules` and `resume`, which hold the advisory lock on a dedicated autocommit
  connection. Each kind takes one of the apply, resume, digest-mismatch or newer-than-code paths. The phases are `live`
  (one transaction), `editions` and `quote_variants` (batched), then `deliver`. It retries with backoff and marks
  `failed` (§4.15 points 3–5).
- Callers: API startup (background thread, never blocking health), `price_import_job.py`, and the catalog promotion path,
  which calls `resume`.
- `scripts/rule_rollout.py restore --to <commit>`, called by `cmd_rollback` before the previous release starts (point
  6).
- Removals: `MARKETPLACE_MATCHING`, `automatic_matching`, `ensure_matching_rule`, `_apply_automatic_matching`, the
  activation route and form, and deactivation.
- Owner controls: the read-only rules panel (point 7), with generated clients regenerated.
- Docs and config listed in point 8. `compose.deploy.yml` passes `RELEASE_COMMIT: ${PRIZECHECK_IMAGE_TAG:-}` to the `api`
  and `tools` services (today only `auth` has it).

**Acceptance criteria.**

- [ ] Starting the API with the newest version unapplied records exactly one `deploy` activation per kind, with
      `release_commit`, and completes the rollout. Starting it again records nothing.
- [ ] Two processes starting at once record one activation (advisory lock).
- [ ] With `RULE_ROLLOUT_BATCH=2`, killing the rollout mid-`editions` and calling `resume` finishes from the cursor. The
      final mapping states equal those of a single uninterrupted run, and `deliver` runs once more after a crash inside
      it.
- [ ] A concurrent collection write (`inventory_owner ... FOR UPDATE`) completes while a rollout runs, waiting no longer
      than one batch.
- [ ] A live-rule collision whose two claimants fall in different 500-row ranges suspends both and never qualifies
      either first.
- [ ] Same version with a different recorded digest: nothing is recorded or re-evaluated, and the panel shows the
      mismatch.
- [ ] An active version newer than the code knows: nothing is recorded, and verified Editions stay verified.
- [ ] `restore --to` a commit whose newest matching version is 4, after v5 was applied: a `rollback` activation for v4
      becomes current, nothing is re-evaluated, and v4 code then evaluates a live Printing without `no_active_rule`.
- [ ] No bound owner: nothing is recorded, and the next `resume` after binding applies it.
- [ ] A promotion during a rollout evaluates its new Editions under the new rule.
- [ ] `POST /api/admin/catalog-rules/{kind}/activate` is gone (404/405). The panel shows progress and has no activate
      control (browser test). `MARKETPLACE_MATCHING` appears nowhere in compose, env examples or docs.
- [ ] `test_registered_rule_digests_are_pinned` still pins every version.

**Blocked by.** Nothing. P10 is blocked by this ticket.

**Likely touched.** `migrations/157_rule_rollout.sql`, `api/app/rule_rollout.py`, `api/app/catalog_targets.py`,
`api/app/metadata_reviews.py`, `api/app/catalog.py`, `api/app/main.py`, `scripts/price_import_job.py`,
`scripts/rule_rollout.py`, `deploy/host/prizecheck-deploy.sh`, `compose.deploy.yml`, `compose.prod.yml`,
`deploy/host/prizecheck-prod.env.example`, `docs/deployment-oracle.md`, `docs/prices.md`,
`docs/adr/0019-tcgcsv-daily-prices.md`, the owner rules panel under `web/src/owner/`, the generated clients,
`api/tests/test_rule_rollout.py`, `api/tests/test_metadata_reviews.py`, `tests/tooling/test_deploy_pipeline.py` and
`web/tests/owner-controls.spec.ts`.

**Verification.** `npm run verify -- --suite api -- api/tests/test_rule_rollout.py api/tests/test_catalog_targets.py
api/tests/test_metadata_reviews.py`; `npm run verify -- --suite browser -- web/tests/owner-controls.spec.ts`;
`python -m pytest tests/tooling/test_deploy_pipeline.py`; `npm run check`; `npm run guardrails`.

## P12. Matching rule v6: main-set cards with no TCGdex id (#378)

Design §4.16.

**What to build.**

- `scripts/propose_set_groups.py`: proposes the TCGdex set → TCGCSV group(s) table and writes a per-set match report to
  `docs/planning/tcgcsv-prices/set-groups-report.md`.
- `MatchingRulesV6(MatchingRulesV5)`, registered as 6, with:
  - `TCGPLAYER_SET_GROUPS`, the reviewed table;
  - multi-group candidates;
  - the reviewed name equivalences (`δ` ↔ `(Delta Species)`, hyphenated ↔ spaced `EX`/`GX`/`V`/`VMAX`/`VSTAR`/`ex`).
- `refresh_editions` and `rematch_promos` cover every listed set.

**Acceptance criteria.**

- [ ] The report lists, for every proposed set: its group(s), TCGdex card count, cards with no id, exact matches and
      misses with their candidates. The table contains only sets accepted in review.
- [ ] `ex15` `1` "Ampharos δ" matches "Ampharos (Delta Species)". `sma` `SV46` "Leafeon-GX" matches "Leafeon GX" in
      group 2594 and never in Shining Fates 2781. `bw11` Radiant Collection cards match in group 1465.
- [ ] "Deoxys δ" against "Deoxys (Delta Species - Attack Forme)" and "Gengar" against "Gengar (Prime)" stay
      `rule_failed`.
- [ ] A card with any TCGdex id never takes the path. Special Editions are never matched.
- [ ] `test_registered_rule_digests_are_pinned` pins v6.
- [ ] After P11's rollout, the owner list shows the main-set matches, and matched Printings without a TCGdex image get
      fallback art.

**Blocked by.** P10 and P11.

**Likely touched.** `scripts/propose_set_groups.py`, `api/app/catalog_targets.py`, `api/app/metadata_reviews.py`,
`api/tests/test_catalog_targets.py` and `docs/planning/tcgcsv-prices/set-groups-report.md`.

**Verification.** `npm run verify -- --suite api -- api/tests/test_catalog_targets.py api/tests/test_metadata_reviews.py`,
plus `npm run check` and `npm run guardrails`.

## Not ticketed (recorded follow-ups)

- Scanner fingerprints of fallback art. They are blocked by the scanner page's COEP and the CDN's missing CORS header.
- An owner subtype override for ambiguous or shared Editions. Only if the P6 counts show it is needed.
- Group/number matching for trainer kits, McDonald's and other promo groups not covered by P12's reviewed table.
- The 91 scanner-index failures (TCGdex assets, unrelated to fallback art). Query `scanner_fingerprint_failure` first.
