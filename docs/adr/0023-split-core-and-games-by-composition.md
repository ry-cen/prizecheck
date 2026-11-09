# Split the backend into a game-free core and games, by composition

**Status:** accepted 2026-10-29 (branch `refactor/shared-core`, issue [#421](https://github.com/ry-cen/prizecheck/issues/421)). Design: [design brief](../planning/shared-core/design-brief.md) D11 to D13. Module map: [split map](../planning/shared-core/split-map.md). The identity design is not decided here.

**Context.** `api/app` has one game, Pokémon, and a second one is planned: Riftbound. Pokémon content is spread through the flat module list: catalog, price marketplace mapping, format rules, imports and exports, and Pokémon values inside otherwise generic code such as the TCGdex source, `'USD'`, the allowed art hosts and the `CardKind` types. A second game cannot reuse the generic parts without copying them or editing them in place. Earlier drafts solved this with a `GAME` setting, a registry, and protocols that each game implements. They designed for a second game that does not exist yet.

**Decision.**

- **Core is a library.** `api/app/core/**` holds game-free pure functions, SQL building blocks and Pydantic models. It never imports a game, a root module or a module still marked mixed, and it holds no game literals. It has no `current()` and knows nothing about the active game.
- **The game composes.** `api/app/games/pokemon/**` owns every route that needs a Pokémon value. It imports core pieces and passes game values in as arguments or SQL fragments at the call site: the price source and currency, the allowed art hosts, card-kind lists, facet SQL and format check results. A core function that needs a game value takes it as a keyword-only parameter with no default, so a missed call site fails loudly.
- **A route goes where its wiring is.** A route module that needs any Pokémon value moves its whole router to the game, so router-internal route order does not change. Core keeps the game-free functions, models and SQL it uses. A Pydantic model with a Pokémon-typed field lives with its Pokémon route. Class names do not change, so the OpenAPI component names do not.
- **No registry, no `GAME` setting, no protocols** (D12). `main.py` mounts the Pokémon app (`app.games.pokemon.app`: `ROUTERS` in today's registration order, and `LIFESPAN_HOOKS`). When Riftbound arrives, `main.py` chooses which game's app to mount. Extract only code that already exists and is game-free; invent nothing for a second game.
- **Root shims keep old names working** (D11). Entry points that tests, scripts or deploy files name by dotted path stay at the `app.<name>` root as thin shims that run the real module when started with `-m`: `app.catalog_import`, `app.catalog_refresh`, `app.price_runner` and `app.host_readiness`. Alias shims at the root keep other old import names working for callers that cannot change, such as the unedited Playwright specs. A root shim may import anything and re-exports nothing else. The root `app.quote_contract` shim binds the Pokémon source and currency.
- **Phasing** (D13). Now: the contract snapshots and the boundary checker, the Pokémon-only files, the splits that composition needs (marketplace prices, quote source, art sources, collection import and the deck-import group, the deck routes, publishing and discovery), and docs. Later, with Riftbound: moving the remaining pure core modules, the reprint rules, `host_readiness`, the migration tracks and identity.
- **Every `/api` path, request and response shape, and the router order are unchanged.** Snapshots of the OpenAPI document and the route table, in match order, are the proof. A change to either is a change to the API contract and needs the owner's approval.
- **The boundary is checked, not remembered.** `scripts/check_python_boundaries.py` fails on an import from core into a game, a root module or a mixed module, and from one game into another. Remaining edges sit in an allow-list that can only shrink. See [verification](../agents/verification.md#python-boundaries).

**Out of scope.** Identity: moving sign-in, sessions and Handles to an auth database, and how Handle writes and the owner flag reach each backend. Split-map section 5 compares two designs and recommends the gateway writing Handles and signing the owner flag (Design B), to be decided when the identity work resumes for Riftbound. The Riftbound game itself, its routes and its gateway routing are not built. The web app is not split.

**Consequences.**

- A move or split changes imports, not behaviour. Tests keep their assertions; only import lines and patch strings change, except for the targeted edits the owner approved.
- Core is game-agnostic in imports only. Its SQL still names Pokémon catalog relations (`catalog_edition`, `catalog_printing` and others), and some modules still carry Pokémon literals until their package lands. A second game must provide relations with those names and shapes, or a later phase puts a contract in front of them.
- `games/pokemon` is the only place that knows Pokémon values. Adding a game adds `games/<game>` and a mount in `main.py`; it does not edit core.
- Migrations are not split. The Pokémon track stays the existing files; migration tracks for core wait for the second game.
- Docs that name a module by path follow it to its new location. The allow-list holds what is left of the old imports (no edges remain; the identity-table SQL lines wait for the identity work) and only shrinks.

**Amendment (2026-11-09, #534): one entry per game, and migration tracks.** Ryan approved two changes to this ADR. Everything else here still holds.

_Entry points._ Ryan: "yes separate entry meaning like /api/pokemon vs /api/riftbound correct?" The assistant answered that this meant separate application entry points in the code, with public URL prefixes a separate routing choice. Ryan: "ok yes to the separate entry approach, it doesnt need to be that exact setup but something like that in the case that we want to expand to even more games in the future". Where the decision above says "`main.py` chooses which game's app to mount", the approved composition is now a shared core app builder plus a separate application entry point per game, in code. Each entry lists its own game's routes and configuration explicitly, and the shape allows more games later.

_Migrations._ Ryan agreed to keep Pokémon's existing migration history intact and add separate core and game-specific tracks for new databases ("yes i agree"). This replaces the consequence "Migrations are not split. The Pokémon track stays the existing files; migration tracks for core wait for the second game." (the option B of IM-11 in #564).

- Pokémon's existing migration files and history stay as they are. They are not moved, renumbered or rewritten.
- A new database uses a core track and its own game's track. No database runs every game's migrations.
- Tooling and tests must prove the schema each track combination produces.
- **How a database selects its tracks (IM-12).** Ryan agreed to an explicit migration command for each database over a shared runner, not one command that picks a game from a runtime setting ("yes"). This is consistent with the no-`GAME`-setting rule below.
- **Hosting (IM-14).** Ryan agreed that Riftbound gets its own database and its own role on the same PostgreSQL server ("yes"), and that the separation is tested explicitly. Ryan added: "in the future we may want to separate them so keep note". So keep a practical path to separate PostgreSQL servers later: no cross-database queries, foreign keys or dblink/FDW between game databases; each backend connects only through its own connection setting; nothing assumes a shared server. Separate hosting is not built now. This is a design choice only: no provisioning, credentials or live access change.
- **Keys (IM-6).** Ryan agreed to separate keys in the design ("yes"). Pokémon keeps its current gateway-to-backend key, which also signs its pagination cursors; each other game backend gets its own key; this is separate from the login-session secret. Design only: no key is created or configured.
- **The core baseline (IM-13).** Ryan agreed to create a clean core baseline now from the existing schema, with automated checks that it matches the intended shared schema and seed data ("yes"). A new game's database does not replay Pokémon history.

_Still holds:_ no runtime game setting, no registry, no protocols.

_Unchanged today:_ the single Pokémon entry, its behaviour and every existing database stay as they are until an implementation slice lands. This amendment changes no code and applies nothing to any live database.

_Not decided here:_ public URL prefixes and gateway routing (no `/api/pokemon` or `/api/riftbound` scheme is chosen); deployment topology beyond that database choice; identity propagation (IM-16).

_Supersedes_ the wording in #563 (rows A6 and R13 of `backend-readiness.md`) that `main.py` chooses the game. #563 is not edited.
