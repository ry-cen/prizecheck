# Riftbound Catalog read API (local and test only)

Issue [#661](https://github.com/ry-cen/prizecheck/issues/661), under umbrella #534. The smallest real step toward connected Catalog parity: a Riftbound backend entry that reads the Riftbound database and serves the Catalog. It is not deployed, no gateway reaches it and the browser cannot call it. The frontend is not connected in this slice.

## What exists

- Entry: `app.riftbound_main` builds the app with the shared builder (`app.core.app_builder.build_app`, from #630) over `app.games.riftbound.app` (`ROUTERS`, `LIFESPAN_HOOKS`). It mounts `/api/health` and the three routes below, nothing else. `app.main` does not import it, and no compose, deploy, gateway, systemd or Docker file names it.
- Database: `RIFTBOUND_DATABASE_URL`, opened lazily per request (`app.games.riftbound.db`). `DATABASE_URL` is never read. The database is the one `scripts/migrate_riftbound.py` builds (core track, then `migrations/riftbound/`).
- Auth: every `/api/catalog/*` route needs the gateway's signed user, in the same `x-internal-user`, `x-internal-time` and `x-internal-signature` headers and HMAC message as `app.identity.verified_user`, but checked against `RIFTBOUND_INTERNAL_AUTH_SECRET` (ADR 0023: Riftbound has its own key). A missing secret, headers, a stale or future timestamp (over 30 seconds), a wrong signature and a request signed with Pokémon's `INTERNAL_AUTH_SECRET` all return 401. `app.identity` is untouched; the check is repeated in `app.games.riftbound.identity`, a candidate to consolidate into one core helper later. As in Pokémon's check, the query string is not signed.

## Endpoints (internal app paths, no public prefix chosen)

| Route | Result |
| --- | --- |
| `GET /api/catalog/sets` | `[{id, name, code}]` for sets with at least one visible Edition, ordered by name then id. `code` is the verified set code of the current generation's set id, or `''`. |
| `GET /api/catalog/editions?q=&set=&page=` | `{editions, total, pages, catalog_empty}`. `q`: case-insensitive substring of card name or collector number (trimmed; blank means no filter). `set`: a set id, optional. `q` is at most 120 characters and `set` at most 80, the caps Pokémon's browse uses (`games/pokemon/catalog/catalog_browse.py`); neither may contain a NUL byte; `page`: from 1 to 100000 (outside that, or any over-limit input, is a 422), `PAGE_SIZE = 24` per page. `pages` is at least 1. A page past the end returns no Editions with the real `total`. `catalog_empty` is true only when no Edition is visible at all (no accepted generation, or none listed), whatever the filters. |
| `GET /api/catalog/editions/{edition_id}` | One Edition, or 404 for an unknown, invisible or malformed id. |

An Edition is `{id, printing_id, name, set: {id, name, code}, number, finish, art}`. `finish` is the descriptor's `finish` (`normal`, `foil`) or `unspecified`. `art` is always `null`. Two finishes of one Printing are two Editions with the same `printing_id`. Order is the shared Card order (casefolded name, set name, natural collector number via `app.core.catalog.card_facts.number_order`), then finish, then Edition id. The list reads every match and sorts in Python so numbers sort naturally; it suits a small catalog and is to be revisited if it grows. `finish` stays a raw key; a future web adapter maps it to a display label. `PAGE_SIZE = 24` is a choice, not a contract.

Not returned, on purpose: facets (domain, type, orientation: D4 is undecided), art URLs, prices, source or provenance ids, fetch times, review state.

Paging is by number, not a signed cursor: core cursors read `INTERNAL_AUTH_SECRET` directly, and this slice does not change core.

## Visibility and grounding

Visible means all of: `catalog_state.active_generation` is that generation; `catalog_generation_edition` lists the Edition there with `active`; the Printing's `catalog_generation_printing` row in that generation is not `tombstoned`; `catalog_edition.printing_id` equals the generation row's `printing_id`. This is the rule of the shared `AVAILABLE` reader (`api/app/core/trading/trade_wants.py`; `docs/planning/shared-core/catalog-data-contract.md`, rows `catalog_state`, `catalog_generation_edition`, `catalog_generation_printing`). The Riftbound writer (`api/app/games/riftbound/catalog/writer.py`) only moves `active_generation` when it accepts a pull, so held (`group_pull_held` reviews), failed and unapproved pulls are never visible.

| Relation (migration `migrations/riftbound/001_catalog.sql` unless noted) | Columns read |
| --- | --- |
| `catalog_state` | `singleton`, `active_generation` |
| `catalog_generation_edition` | `generation_id`, `edition_id`, `printing_id`, `active` |
| `catalog_generation_printing` | `generation_id`, `printing_id`, `tombstoned`, `display_name`, `set_id`, `set_name`, `collector_number` (current accepted display, not the retained one) |
| `catalog_edition` | `id`, `printing_id`, `descriptor` (jsonb object; the writer's descriptors are `{"finish": ...}` or the unspecified one) |
| `catalog_set_code` (`001_catalog.sql`, primary key `set_id`; seeded by `003_set_codes.sql`) | `set_id`, `code`, left-joined on the current generation's `gp.set_id`; no row means `''`. The shared `catalog_printing_set_code` view is not used: it derives the code from the Printing's first, immutable retained `set_id`, so a Printing that moved sets would show the old set's code. |

`migrations/riftbound/README.md`: Riftbound's art views return no art, so `art` is null.

## Tests

Each read runs in one `REPEATABLE READ` transaction, so `total` and `catalog_empty` come from one snapshot. `api/tests/test_riftbound_catalog_read_api.py` runs the real migrations on a disposable database with synthetic rows: the auth matrix on every route (including the Pokémon key), an empty catalog, sets, name and number search, set filter, paging boundaries and totals, detail and 404, finishes as separate Editions, and invisibility of old, pending, held, retired and tombstoned rows. It also checks the entry mounts only health and the Riftbound routes with `DATABASE_URL` unset and that the entry is not wired into Pokémon or deploy files. `api/tests/riftbound_contract/` holds the Riftbound OpenAPI and route-table snapshots; Pokémon's snapshots (`api/tests/api_contract/`, `api/tests/app_builder_contract/`) are unchanged.

## Remaining gates before the frontend connects

1. Gateway routing is settled: the gateway maps `/api/riftbound/<rest>` to this backend's `/api/<rest>`, off unless `RIFTBOUND_API_ORIGIN` is set (ADR 0023, 2026-11-16 amendment; [public-routing.md](public-routing.md)).
2. Identity propagation (#531, IM-16), the remaining gate: the gateway forwards no identity yet, so every Catalog read through it answers 401. How the signed user and Handle writes reach this backend is not decided.
3. Key provisioning: creating, storing and rotating `RIFTBOUND_INTERNAL_AUTH_SECRET`, and the Riftbound database role and URL on a real host (owner approval).
4. A generated web client for the Riftbound OpenAPI, and a thin adapter from `snake_case` fields and `finish` keys to the `CatalogReader` shape in `web/src/games/riftbound/catalog.ts` (on the #660 frontend branch, not yet on `dev`).
5. D4 facets (domain, type, orientation): not decided, so not served.
6. Art: no Riftbound image decision exists, so `art` stays null.
7. Deployment of the entry (compose, systemd or Docker), which this slice does not touch.
