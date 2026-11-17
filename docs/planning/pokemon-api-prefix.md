# Pokémon API prefix: `/api/pokemon`

**Status:** first slice, additive and transitional. Owner direction (2026-11-16): "Let's start a migration over to
`/api/pokemon` to make things consistent."

**What this slice does.** The gateway serves a fixed list of Pokémon-only routes under `/api/pokemon/` as well as at their
old `/api/` paths. The old paths keep working, unchanged. The repository's own callers (the generated web clients and the
browser specs that watch them) call the new paths. The FastAPI app, the OpenAPI document and the API tests do not change.

**What it does not do.** It removes no old path, moves nothing that a Riftbound or shared route could use, and applies
nothing to a live host. Removing the old paths is a later rollout and needs its own decision (see "Open decisions").

## Inventory

Read-only count of `api/tests/api_contract/routes.json` at the base of this branch: 243 routes, 239 of them under `/api/`.

| Group                                                                                              |  Routes | Where it goes                         |
| -------------------------------------------------------------------------------------------------- | ------: | ------------------------------------- |
| Pokémon-only, moved in this slice (list below)                                                     |      60 | `/api/pokemon/...` and the old path   |
| Scanner (`scanner`)                                                                                |       5 | stays; later rollout                  |
| Shared or core (social 37, loans 33, moves 9, location-tree 6, locations 2, holdings 3, profile 4, settings 2, threads 1, the other trades routes 16, admin collectors, operations and trade reports 5; see the note below the table) | 118 | stays on `/api` |
| Infrastructure and anonymous reads (health 1, art 1, public 13; see the note below the table)      |      15 | stays on `/api`                       |
| Ambiguous, waiting on the owner (decks 28, collection 7, publications 3, trade-wants 3)            |      41 | stays on `/api` for now               |
| Total                                                                                              | **239** |                                       |

Two groups are counted where they are for now but are still open questions for the owner: the public decks and discovery
routes sit inside the 13 `public` routes, and the Pokémon trade inventory routes sit inside the 16 other `trades` routes.
The ambiguous row is decks, collection, publications and trade-wants only. Prose elsewhere in this page uses the same split.

### The allowlist moved in this slice

Two kinds of entry, both on a segment boundary and nothing else:

- **Trees** move with everything below them (`/api/pokemon/<route>` and `/api/pokemon/<route>/...`, any method): `catalog`,
  `collection-imports`, `want-list`, `missing-card-reports` and the admin trees `admin/missing-card-reports`,
  `admin/catalog-reviews`, `admin/catalog-metadata`, `admin/card-attributes` and `admin/card-identities`.
- **Single routes** match exactly, and only for the methods the contract has for them, so a longer path can never fall into a
  shared route's pattern (`/api/pokemon/trades/value/accept` must not become `POST /api/trades/{id}/accept`, and
  `GET /api/pokemon/holdings/reassign` must not become `GET /api/holdings/{location_id}`): `POST prices/editions`,
  `POST trades/value`, `POST holdings/reassign`, `GET`/`POST admin/catalog-runs`, `GET admin/catalog-rules` and
  `POST admin/reprint-groups/decisions`.

The table counts the routes of `routes.json` each prefix covers.

| Prefix                       | Routes |
| ---------------------------- | -----: |
| `catalog`                    |     14 |
| `collection-imports`         |      7 |
| `want-list`                  |      4 |
| `missing-card-reports`       |      4 |
| `prices/editions`            |      1 |
| `trades/value`               |      1 |
| `holdings/reassign`          |      1 |
| `admin/catalog-runs`         |      2 |
| `admin/missing-card-reports` |      3 |
| `admin/catalog-reviews`      |      3 |
| `admin/catalog-metadata`     |      5 |
| `admin/catalog-rules`        |      1 |
| `admin/card-attributes`      |      5 |
| `admin/card-identities`      |      8 |
| `admin/reprint-groups` (`/decisions`) |      1 |
| **Total**                    | **60** |

The list lives in two places that must agree: `POKEMON_TREES` and `POKEMON_EXACT` in `auth/src/pokemonRoutes.ts` and the
same two lists in `scripts/client_generator.py`. `tests/tooling/test_client_generator.py` fails when they differ.
`auth/tests/pokemon-routes.test.ts` walks `routes.json` and fails unless exactly these 60 routes move, whatever a path
parameter is filled in with (a shared pattern such as `/api/trades/{trade_id}/accept` is tried with `trade_id = value`).

### What stays on `/api`, and why

- **Scanner.** Its caches embed `/api/scanner/*` URLs. Moving it would orphan every user's Cache Storage entry, so it is
  a separate rollout with a cache migration (below).
- **Shared and core routes.** Social, loans, moves, locations, holdings core, profile, settings, threads, the trade social
  routes and admin operations serve every game. A per-game prefix would be wrong for them.
- **Infrastructure.** Health, art, public reads and auth are not game-scoped.
- **Ambiguous routes.** Decks, collection, publications and trade-wants mix per-game and shared behaviour, and so do the
  public decks and discovery routes and the Pokémon trade inventory routes counted under infrastructure and shared above.
  The owner decides where they live.

Any other `/api/pokemon/...` answers 404 from the gateway before any session lookup, rate limiter or API call: `/api/pokemon`, `/api/pokemon/health`,
`/api/pokemon/auth/...`, `/api/pokemon/public/...`, `/api/pokemon/loans`, a double prefix (`/api/pokemon/pokemon/...`), another
game (`/api/pokemon/riftbound/...`), any name that only starts with a moved one (`/api/pokemon/catalogue`), a single route with a longer path or another method
(`/api/pokemon/trades/value/accept`, `GET /api/pokemon/holdings/reassign`), and any target with a dot segment, an encoded
slash or a backslash (`/api/pokemon/%2e%2e/loans`). The namespace is decided on the raw request target, before the URL is
normalised, because normalising first would turn that last one into `/api/loans` and let it out of the namespace.

## How it works

- **Gateway (`auth/src/server.ts`).** `pokemonUpstream` (`auth/src/pokemonRoutes.ts`) runs first in the request handler. For a moved route it rewrites
  the path to `/api/<rest>`; the same value is then used for every later rule: same-origin and method checks, the public,
  health, budget, import-limit and art tests, the identity signature, the budget signature and the URL forwarded to the API
  (rewritten pathname plus the original query string). The API therefore receives, and verifies signatures over, exactly the
  paths it has today, and no FastAPI or signing code changed. Rate limiters, `BUDGETED_ROUTES` and `IMPORT_ROUTES` apply to
  the rewritten path exactly as they do to the old one.
- **Ingress (`deploy/docker/nginx.conf`).** The 5 MiB start route has a second exact location,
  `= /api/pokemon/collection-imports`, with the same limit and the same proxy directives as the old one. Every other
  `/api/pokemon/...` falls under the existing `/api/` location at 64k, as the old paths do.
  `scripts/release_runtime.py` forwards every `/api/` path unchanged, so it needed no change; a routing test now pins that.
  Nothing was applied to any host.
- **Clients.** The emitters in `scripts/generate_*.py` still assert the upstream `/api/...` path in the OpenAPI document.
  `client_generator.assemble` rewrites each quoted `/api/<moved route>` in the emitted text to `/api/pokemon/<moved route>`
  using the same list, so one helper covers every client. This is a deliberate choice over editing each emitter's literals: the emitters stay
  readable against the OpenAPI document, and a new emitter gets the rewrite without remembering it. The generated files were regenerated through
  `scripts/generate_all_clients.py`. No hand-written web code calls a moved route (only doc comments name them).
- **Specs.** Playwright specs that watch or intercept a moved route in the browser now use the new path. Specs that call
  the API directly (seeding through `page.request`, `ORIGIN/api/...`) stay on the old path on purpose: they keep covering
  the retained paths. API tests stay on the upstream paths.

## Why a direct switch is not safe

Evidence from the coordinator's read-only inventory:

1. **Open tabs.** A tab keeps running its old bundle against the old paths until it reloads. Assets are immutable, there is
   no service worker to refresh them, and some screens poll or refetch when the tab becomes visible. Removing `/api/want-list`
   or `/api/prices/editions` would break every tab that was open during a deploy.
2. **Scanner caches.** The scanner's Cache Storage entries embed `/api/scanner/*` URLs. Renaming them orphans the entries.
3. **Native client (#676).** The iOS gateway work hard-codes `/api/collection` in its bearer scope
   (`native.ts`). It cannot follow a rename it does not know about.

So old and new paths are served together until a later release removes the old ones.

## Open decisions for the owner

1. **Where the ambiguous routes live:** decks, collection, publications and trade-wants, and the two groups noted under the
   inventory table (public decks and discovery, inside `public`; the Pokémon trade inventory routes, inside `trades`). This decides whether they get `/api/pokemon/...` twins, stay shared, or split.
2. **Whether the catalog admin routes move.** This slice moved them with the rest of the Pokémon catalog; say so if the
   owner screens should stay on `/api/admin`.
3. **The scanner cache migration:** version the cache name, or serve both URL shapes until the old entries expire, then move
   `scanner`.
4. **When and how the old paths go.** Suggested: a release after the one that ships these clients, so reloaded tabs hold the
   new bundle; then remove the old paths from the gateway allowlist-equivalent and let them 404. Optionally answer a 404 on a
   retired path with a "reload for the latest version" prompt in the web app.
5. **The #676 `native.ts` scope.** When collection is decided, the native gateway's bearer scope must name the new path as
   well as `/api/collection`, and the old one stays until native builds have updated.

## Recommended rollout

1. Land the Riftbound gateway prefix (`feature/534-riftbound-gateway-prefix`) first. That branch is not committed yet, so a
   conflict in the same region of `auth/src/server.ts` (the start of the request handler where `path` is computed) is
   expected, not observed. This branch rebases on it after it lands: keep one `path`/upstream-URL pair, make the Pokémon helper and the Riftbound one siblings (ideally one
   per-game prefix table), and keep the rule that an unlisted `/api/<game>/...` answers 404 without an upstream call.
   Re-run `auth/tests/pokemon-prefix-gateway.test.ts` after the rebase.
2. Land this slice to `dev`, then release it with the host steps below.
3. Release host steps: ship the updated `nginx.conf` (the new exact location) with the same release as the gateway, since
   nginx would otherwise cap `/api/pokemon/collection-imports` at 64k while the gateway accepts 5 MiB. Deploy the gateway and
   the web bundle together.
4. Let the new bundle reach users, then decide the open items above before any old path is removed. The removal is its own
   release, with the old-tab and native-client checks repeated.

## Shared with #674 (crawler routing)

`deploy/docker/nginx.conf` and `scripts/release_runtime.py` are also where #674 put the root `/robots.txt` and
`/sitemap.xml` rewrites. This slice leaves every #674 line as it is: its only change to those two files is the second exact
start-route location in nginx. `release_runtime.py` needed no edit, because it already forwards any `/api/` path.

Local checks of the Collection Import start route. Real nginx was not run; its config is checked statically
(`tests/tooling/test_proxy_config.py`: both locations exist once, with `client_max_body_size 5m` and the same proxy
directives as the `/api` and `/auth` location).

- Gateway, with an upstream mock: a 1 MiB payload (over nginx's 64k, under 5 MiB) on `/api/collection-imports` and
  `/api/pokemon/collection-imports` reaches the upstream at the old path with `location_id` and the bytes unchanged; 5 MiB
  passes and 5 MiB + 1 byte is 413 on both.
- Dev proxy (`release_runtime.py`): it enforces no body limit; a payload between 64k and 5 MiB passes through on both paths
  with the query intact (`tests/tooling/test_release_runtime_routing.py`).

### Combined regression check for a release owner

Not run here, and no release, merge or production step was taken. When an authorized release owner combines #674 and this
slice and releases, they should re-run against the combined build:

1. `POST /api/collection-imports?location_id=<id>` and `POST /api/pokemon/collection-imports?location_id=<id>` with a valid
   file between the default cap (64k) and 5 MiB: both accepted, `location_id` intact at the API.
2. Root `/sitemap.xml`: `GET` and `HEAD`.
3. Root `/robots.txt`: the response.
