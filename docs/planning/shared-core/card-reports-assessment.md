# Card Reports: reuse assessment

**Status:** assessment for [#530](https://github.com/ry-cen/prizecheck/issues/530), from `dev` at `41ffcbab` on 2026-11-04. It authorizes no implementation. Line references are to that commit.

**Base:** the deferred question in [#418](https://github.com/ry-cen/prizecheck/issues/418) and design brief D13 and Q10, under [ADR 0023](../../adr/0023-split-core-and-games-by-composition.md). Split-map sections 1A and 10 record that `missing_cards` moved whole.

## Conclusion

**No extraction from `missing_cards` is justified now.** The module should stay whole in `games/pokemon/catalog/`.

- About 50 of its 257 lines are game-free, and they are single SQL statements on one Pokémon-shaped table. The other lines are the Pokémon request and response models, the manual catalog decision, and helpers those need.
- Paging, one of the mechanics #530 names, does not exist in this flow.
- The real repetition is the report lifecycle, and it sits inside the Pokémon game: `missing_cards`, `metadata_reviews` and `attribute_corrections`. No game-free caller needs it, because no second game has this flow.

One seam is concrete enough to name (seam 4 below). It should wait for a reason to build it. The characterization tests below are worth adding whichever way that goes.

The navigation rename in #494 and #497 changed labels only: the API paths, tables and tab keys stayed as they were. It is no evidence for a backend split.

## What the flow is today

| Part | Evidence | Owner |
| --- | --- | --- |
| Report and decision models | `api/app/games/pokemon/catalog/missing_cards.py:20-65` | Pokémon: set, collector number, English name, Printing, descriptor |
| Text and URL helpers | `missing_cards.py:68-73` | Game-free, but `_clean` is private and small |
| Row lookup | `missing_cards.py:80-83` | Game-free. The `owner=False` branch is dead: the only caller, line 175, passes `True` |
| Variant Descriptor rules | `missing_cards.py:86-97` | Pokémon |
| Submit, and owner's Begin a record | `missing_cards.py:100-115`, `153-168` | Pokémon: catalog lookup and all columns. The two routes repeat their insert |
| My reports, one report, reply | `missing_cards.py:118-142` | Lifecycle, on one table |
| Owner queue | `missing_cards.py:145-150` | Lifecycle, on one table |
| Needs info and reject | `missing_cards.py:175-187` | Lifecycle, on one table, opening the Pokémon decision route |
| Approve | `missing_cards.py:188-257` | Pokémon: generation checks, set ambiguity, Card Identity, Printing, Edition, Catalog Override, catalog revision, public records |

The table is `missing_card_report` (`migrations/007_missing_card_reports.sql:1-22`). Its content columns are Pokémon catalog columns, with foreign keys to `catalog_printing` and `catalog_edition`. Later migrations do not alter it. Its `kind` is `printing` or `edition`, and its `CHECK` depends on that.

There is no cursor or page. `my_reports` stops at `LIMIT 100` (line 122) and `review_queue` at `LIMIT 200` (line 150), with open reports first. The web queue count reads that list and filters it (`web/src/owner/useQueueCounts.ts:63-70`), so it can't count past 200 reports.

### Dependencies

```text
web/src/reports/* ─────┐
web/src/MissingCardReports.tsx ─┤
web/src/owner/MissingQueue.tsx ─┼─ generated client (scripts/generate_client.py:57-74)
web/src/owner/useQueueCounts.ts ┘        │
                                         ▼
     7 routes in missing_cards.py, mounted at games/pokemon/app.py:27,64
        │            │              │              │
        ▼            ▼              ▼              ▼
   app.identity  app.db   card_identity_key  publish_catalog_best_effort
                                         (both Pokémon)

Readers of what approval writes:
  catalog.py:645,744        a pull keeps overridden Editions
  catalog_search.py:119,124 manual source and evidence in search and card details

Consumers of the report shape:
  deck_import.py:148,334     MissingCardPrefill, Decklist Import's Not found lines
  import_publication.py:62   the same prefill fields
  web/src/reports/missingCardLink.ts   /reports?report=… link
  web/src/catalog/CatalogCardPopup.tsx:269   missing-Edition form
```

`catalog_override.report_id` and `catalog_approval_code.report_id` both reference `missing_card_report`. `catalog_approval_code` has no remaining reader or writer in `api/app`.

## The three catalog report flows

`trade_report` (`migrations/149_trade_reports.sql:9`) is not a fourth member. It has different statuses (`open`, `dismissed`, `actioned`), no reporter reads and no reply, and it files a Block and a snapshot. It reports a collector, not a card.

| | `missing_cards` | `metadata_reviews` | `attribute_corrections` |
| --- | --- | --- | --- |
| Reporter list | `:118-122` | `:140-144` | `:193-197` |
| Reply SQL | `:134-142` | `:156-165` | `:210-219` |
| Refusal shape | `HTTPException(404, "Report not found")` | `fail(404, "REPORT_NOT_FOUND")` | `fail(404, "REPORT_NOT_FOUND")` |
| Open-report cap | none | 25, `:36`, `:124-127` | 25, `:45`, `:182-185` |
| Closed test | `approved`, `rejected` | not `pending` or `needs_info` (also `superseded`) | not `pending` or `needs_info` |
| Reason cleaning | `_clean`: NFC, then whitespace | whitespace only | whitespace only |
| Needs info writes reviewer columns | **yes**, `:185-186` | no, its `CHECK` forbids it | no, its `CHECK` forbids it |
| Owner queue | `LIMIT 200` list | keyset page by target | keyset page by target |
| Approval | inside the report's decision route | a separate decision command | a separate decision command |
| Owner begins a record | yes | no | no |

The list and reply SQL are nearly the same apart from the table name. The decision step is similar in shape, but the differences in the table above are observable or enforced by constraints. A shared helper would need to carry each one as an argument.

## Seams considered

1. **Shared report storage: rejected.** A core table would need a migration and a data move, ADR 0023 keeps migrations unsplit, and the content columns are Pokémon's anyway. The split map lists `missing_card_report` as game-core (section 3, line 563; section 4, line 686), and the design brief expects a core baseline without its catalog foreign keys (D9). That classification describes a future migration track only. It doesn't make the content game-free.
2. **Shared models: rejected.** `ReportInput`, `ReportView` and `DecisionInput` have Pokémon-typed fields, so ADR 0023 keeps them with the route. Their component names are also in the API contract.
3. **Shared paging: rejected.** There is nothing to extract, and adding paging would change the API.
4. **Report lifecycle helpers: possible, not yet justified.** This would be a game-free module, under a core path, with the reporter list, one-row read and reply statements. Moving the routes is out: under ADR 0023 they stay with the game, because their models and wiring are Pokémon's.
   - **Required inputs, keyword-only with no default:** table name from a trusted constant; a view function; the limit; the not-found refusal, because the 404 bodies differ.
   - **Left out:** decisions, approval, caps and queues. These differ too much to share cleanly.
   - **Gain:** it removes about 25 lines repeated across three files. It takes on dynamic table-name SQL, and no other caller would use it yet.
5. **Generic report framework or registry: rejected.** ADR 0023 forbids registries and protocols, and #530 excludes it.

## Compatibility limits for any later work

- The 7 routes in `api/tests/api_contract/routes.json` and the 4 paths and 4 component names in `openapi.json` stay byte-identical, including route order and the `ReportView` field set.
- Refusal bodies stay as they are: plain-string 404s here, the `code` and `message` objects used for other refusals here, and `fail` shapes elsewhere. The generated client reads `detail.message` (`scripts/generate_client.py:52-54`).
- The approval stays one transaction with its current order: report lock, `catalog_state` lock, `catalog_begin_correction()`, writes, revision, override, report update. Publishing stays after commit and best effort.
- `reviewer_id` and `reviewed_at` on `needs_info` stay as they are, unless the owner decides otherwise.
- `/reports`, `/owner/missing`, the tab keys and the Report-a-card link parameters stay unchanged. Reports stay private to their reporter.
- `scripts/python_module_owners.txt:72` changes only if a module moves. The boundary allow-list gains nothing.
- Names need care. In `CONTEXT.md`, **Report** means a collector's account of another collector, and "Card reports" is a navigation label with no glossary entry. A `core/reports` package would read as the social Report. The name should be settled first, using `mattpocock-skills:domain-modeling`.

## Characterization coverage

`api/tests/test_missing_cards.py` covers privacy, needs-info and reply, approval refusals, approval rollback, pull preservation and publication. `web/tests/owner-queues.spec.ts`, `missing-cards.spec.ts` and `missing-cards-page.spec.ts` cover the screens, including Request information and Reject.

These behaviours have no direct API assertion that I could find:

- `submit_report`: `PRINTING_REQUIRED` for an Edition report, 404 for an unknown Printing, text cleaning, and creating the inventory owner.
- `owner_begin`: creation with `reporter_id` NULL, refusal for a non-owner, and the same two refusals. No test I found submits the Begin a record form.
- `respond_to_review`: the reporter's own 404 outside `needs_info`, `evidence_url` kept when the reply omits it, and which review fields survive the return to `pending`.
- `decide_report`: reject and its closure, `REASON_REQUIRED` for a blank reason after cleaning, `CATALOG_UNAVAILABLE`, 404 for an unknown report, and reviewer columns written on `needs_info`.
- Lists: reporter order and `LIMIT 100`; queue order with open reports first and `LIMIT 200`.
- Comparable coverage for the reject and repeat-decision paths already exists in `test_metadata_reviews.py:164-170` and `test_attribute_corrections.py:129-137`, so those tests can serve as the pattern.

## Suggested follow-up

Each step needs its own owner approval, and no issue has been opened or changed for them.

1. **Close the question in the docs.** Add a dated note to split-map section 10 pointing here, as an exact narrow hunk.
2. **Optional: test-only characterization ticket.** It helps the flow whether or not anything is extracted.
   - Adds API tests for the list above and changes no production code.
   - No existing assertion changes.
   - `test_api_contract.py`, the touched API tests where a database is available, `npm run check` and `npm run guardrails` pass. CI's `verify` check is green on the exact head.
   - If a test exposes a bug, the test records the current behaviour and the bug goes to the owner. The ticket doesn't fix it.
3. **Later, only on a trigger: lifecycle helpers (seam 4).** Triggers are an owner decision that a second game gets this flow, or that the within-game repetition is worth removing now.
   - Starts after step 2.
   - Routes stay in their game modules. The contract snapshots and all three flows' refusals and SQL effects are unchanged.
   - Moves only the reporter list, one-row read and reply. Decisions, approval, caps and queues stay.
   - The core module imports no game and holds no game literals; its inputs are keyword-only with no default. The boundary check passes with no new allow-list line.
   - Rename or rewrite of tables, models and routes is out of scope.

## Open owner decisions

- Will Riftbound, or any second game, need a report-a-missing-card flow at all? The branch is paused, and this assessment found no approved design for one.
- If it will, should its reports use their own table, or does the split map's game-core classification mean one table with game-specific content? That decides whether seam 1 stays rejected.
- Is the within-game repetition worth removing on its own, without a second game?
- Is writing reviewer columns on `needs_info` in `missing_cards` intended? It differs from the two later flows. Nothing here changes it.
- Should `catalog_approval_code`, the dead `owner=False` branch and the silent 200 limit on the queue count be cleaned up? They are recorded here as observations and don't affect the conclusion.
