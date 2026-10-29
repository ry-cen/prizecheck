# Design brief: shared identity database and Python core/games split

**Branch:** `refactor/shared-core` (cut from `dev` at 2f335c7). Nothing merges to `dev` until every work package here is
done. Merge `dev` into the branch before each work package starts.
**Direction:** ADR 0022 and the Riftbound spec (`git show riftbound:docs/adr/0022-separate-game-backends-with-shared-sign-in.md`,
`git show riftbound:docs/planning/riftbound/spec.md`), phases 1 and 2. Where this brief and those documents disagree,
this brief wins. Section 3.2 says where and why.
**Discovery used:** `/tmp/prizecheck-split/identity.md`, `/tmp/prizecheck-split/api.md` (quoted below as *identity pack*
and *api pack*). The web pack is not used: the web app is out of scope (section 5).

**Ready for implementation (2026-10-29).** Every item below is settled:
- [x] Every owner question is answered (section 7). Q1 to Q7 wait for the identity re-plan (Later), and none blocks Now.
- [x] Now order (section 4):
  1. WP-B, WP-B2 and WP-B4;
  2. WP-B3;
  3. WP-C1, then WP-C2, then WP-I1, then WP-F;
  4. WP-S1 in parallel with WP-S2;
  5. WP-S3, then WP-D1, then WP-D2;
  6. WP-K at any point.
- [x] WP-B3, WP-D1 and WP-D2 get an independent opus review. So does WP-C1, because it carries the one migration.
- [x] Test invariants and the one WP-B3 exception (section 4). Snapshots stay byte-identical, and `check:client` shows
  no diff.
- [x] Coverage gaps are closed: 4 group (a) tests in WP-B2, plus the slow tests in WP-I1 and WP-S2.
- [x] Each package is accepted on:
  - green default CI;
  - the touched `api/tests` files;
  - an `integration=sharded` run, with its counts quoted.

  One `integration=full` run comes before the branch merges to `dev`.
- [x] Every verify command runs with `TMPDIR=<worktree>/.scratch/tmp` (host note, section 4).

---

**Revision 3 (2026-10-29): composition.** D11 to D13, section 3.4 and the Now work packages (WP-B, WP-B2, WP-I1,
WP-F, WP-S1, WP-S2, WP-S3, WP-K) replace the earlier seam and registry design. The identity packages (WP-A, WP-C,
WP-D, WP-E) are **Later (Riftbound)**. They are kept for reference and will be re-planned, because split-map
section 5 recommends identity Design B. The old WP-G, WP-H, WP-I and WP-J are removed: the core baseline keeps its
design in D9 and D10, and the Later splits will be planned when Riftbound resumes. Where an earlier section mentions `GAME`, `current()`, slots or
protocols, D12 overrides it.

**Revision 4 (2026-10-29).** Three owner decisions:
- The deck routes, and publishing and discovery, split Now: WP-D1 and WP-D2 (split-map section 1B).
- The architecture-pin assertions move into the boundary checker (option C): WP-B3 (split-map section 9).
- The stored-response replay fixtures are WP-B4.

## 1. Goal

Move all identity data (sign-in tables, sign-up and send limits, Handles, Display Names and the owner binding) into an
auth database that the gateway owns, and split `api/app` into `app/core`, `app/games/pokemon` and a game registry, with
an import boundary check. Collector-facing behaviour, API paths, request and response shapes, and the generated web
clients stay exactly as they are.

## 2. Acceptance criteria

1. With `AUTH_DATABASE_URL` pointing at a database other than `DATABASE_URL` (the **split topology**):
   - the gateway reads and writes only the auth database;
   - the API reads Handles, Display Names, the owner binding and the gateway's counters from the auth database through
     `app/core/identity_store.py`, and only there;
   - sign-in, the sign-up gate, owner routes, Handle and Display Name changes and the operations panel all work. The new
     split tests in WP-D and WP-C show this.
2. With `AUTH_DATABASE_URL` unset or equal to `DATABASE_URL` (the **co-located topology**, used by every existing test
   harness), every existing suite passes with no change to any assertion:
   - `api/tests`, `auth/tests`, `web/tests` (Playwright), `tests/tooling` and `tests/operations`;
   - nothing under `web/` changes;
   - `api/tests` files change only in `app.*` import paths and in monkeypatch target strings;
   - `auth/tests` changes only in support files, and only additively.
3. `npm run check:client` passes with no diff. The new `api/tests/test_api_contract.py` proves that `app.openapi()` and
   the ordered route table match the snapshots taken in WP-B, before any change.
4. `scripts/migrate.py` applies three tracks:
   - `auth` (`migrations/auth/`) to `AUTH_DATABASE_URL`;
   - `core` (`migrations/core/`) to `DATABASE_URL`;
   - `pokemon` (the existing `migrations/*.sql`) to `DATABASE_URL`.

   On a database already migrated by today's `migrate.py`, it re-runs no existing file. `api/tests/test_core_baseline.py`
   migrates a core-only database from empty and checks that its core tables match the ones in a Pokémon database.
5. `scripts/check_python_boundaries.py` runs in `npm run guardrails`. In the end state it fails when:
   - `app.core` imports `app.games` or `app.main`;
   - one game imports another;
   - an `importlib.import_module` literal crosses those lines;
   - a module other than `main.py`, `__init__.py` and the four D11 entry shims is left directly under `app/`. This
     rule applies in the end state; until the Later work lands, the owners file lists the unmoved modules;
   - SQL in `api/app` outside `core/identity_store.py` names an auth-only table.

   The allow-list holds only the edges of files tagged Later (split-map section 1A), and is empty when they land.
6. `scripts/identity_cutover.py` has three commands:
   - `copy` copies live identity data from the Pokémon database into an empty, migrated auth database in one
     transaction;
   - `verify` proves the copy matches by row counts and key digests;
   - `copy-back` returns data written after the cutover to the Pokémon database for a rollback.

   The deploy refuses to start when `AUTH_DATABASE_URL` is missing or equals `DATABASE_URL`, and backs up both databases.
7. `main.py` mounts `games/pokemon/app.py`'s `ROUTERS` and `LIFESPAN_HOOKS`, in today's order. There is no `GAME`
   setting and no registry (D12).
8. The layout rules that five `api/tests` files used to pin are named rules in
   `scripts/check_python_boundaries.py` (WP-B3), each at least as strict as the assertion it replaced. Each rule has a
   tooling test that fails on a planted violation.

## 3. Context

### 3.1 Facts the design rests on (checked in source, HEAD 2f335c7)

- `api/app/identity.py:10-32` builds the signed message `METHOD\npath\nsha256(body)\nuser\nstamp`.
  - 11 API test files build these headers themselves, for example `api/tests/test_holdings.py:18-23` (`call`).
  - Changing the message, or requiring a new signed header, would break every one of those files.
- `require_owner` (`identity.py:35-39`) reads `owner_binding`.
  - 18 API test files, 17 web test files and 5 auth test files seed `owner_binding` directly (*identity pack* §5).
  - Web tests use one `process.env.DATABASE_URL` for identity tables (`"user"`, `account`, `owner_binding`,
    `auth_send_event`, `auth_rate_event`, `collector_profile`) and game tables (`catalog_*`, `holding`, `location`,
    `inventory_owner`) alike (for example `web/tests/app-shell.spec.ts:53`, `web/tests/sign-ins.spec.ts:18`).
  - `web/tests/support/browser-stack.ts:7-16` copies each stack's settings from `VERIFY_BROWSER_STACKS`, which
    `scripts/verify_resources.py:26-30` (`WORKER_KEYS`, `STACK_KEYS`) writes. A new variable reaches the stacks without
    touching `web/`.
- API tests write `inventory_owner` directly 84 times and rely on the trigger
  `onboard_collector_profile` (`migrations/100_collector_profile.sql:89-96`) to make the profile. They also run
  `UPDATE collector_profile SET handle/display_name/suspended_at` on the game connection (for example
  `api/tests/test_conversations.py:229`).
- The Handle rules live in `api/app/social/profile.py:213-272` (`set_handle`). The order of checks matters:
  1. the format;
  2. the same key in another case;
  3. the 30-day limit;
  4. the hourly attempt limit, counted in `handle_lookup_event`;
  5. advisory locks;
  6. taken or held;
  7. release and update.

  Seven API test files and 17 Playwright files call `PUT /api/profile/handle` or `/display-name`.
- Many tests read migration files by path from the `migrations/` root:
  - `api/tests/test_catalog_references.py:84-94` (`migrate()`, globbing `migrations/*.sql`, imported by other tests);
  - `test_settings.py:168`, `test_blocks.py:235` and 12 more;
  - `scripts/release.py:106-107` (digests of `migrations/*.sql` between releases).

  The existing files cannot move.
- The gateway writes `operations_counter` with the names `too_many_sign_ups` (`auth/src/rateLimits.ts:34`),
  `sign_in_delivered` and `sign_in_failed` (`auth/src/server.ts:232-236`). The ops panel reads those names, plus
  `auth_send_event` and `auth_rate_event`, at `api/app/operations.py:59-81`.
- The only Python import edges from modules bound for core into modules bound for Pokémon, once the Pokémon clusters in
  3.4 move whole, are these (AST scan, `/tmp/planner-scratch/seams.py`):
  - `collection`, `holdings`, `social/friend_reads` and `swap_hints` import the module `set_codes`.
  - `decks` imports `construction_checks` {`DISCLAIMER`, `IdentityCount`, `evaluate_checks`}, `deck_format_checks`
    {`DeckFormatChecks`, `TargetFormat`, `command_format_checks`, `held_format_checks`} and `format_evaluator` {`FORMATS`}.
  - `publications` imports `construction_checks` {`DISCLAIMER`, `IdentityCount`, `evaluate_checks`} and
    `deck_format_checks` {`TargetFormat`, `held_format_checks`}.
  - `host_readiness` imports `catalog_targets` {`LIVE`, `MATCHING`, `load_active`}.
  - `price_runner.py:114,119,620` loads `app.price_source` and `app.tcgdex_record` through `importlib`.
  - `deck_list_display.py:21-22` defines the Pokémon Literals `CardKind` and `TrainerType`. Core modules use them
    (`publications`, `want_list`, `decks`, `deck_ownership`, `trade_wants`).
- `main.py:94-118` registers one ordered `ROUTERS` tuple. Order matters (comment at lines 95-96). The lifespan
  (`main.py:74-79`) runs `art_store.start_warmups`, then `rule_rollout.start_on_startup`, then
  `format_standing.rebuild_on_startup`.

### 3.2 Decisions

**D1. One auth database, two topologies.**
- The code always uses two settings: `DATABASE_URL` (the game) and `AUTH_DATABASE_URL` (identity). When
  `AUTH_DATABASE_URL` is unset, it falls back to `DATABASE_URL`.
- **Co-located** means both settings name the same database. That is today's schema and today's single-transaction
  behaviour. Every test harness, dev and local stacks use it.
- **Split** is production, and the dedicated split tests.
- *Why:* the frozen `web/tests` and the unchanged `api/tests` seed identity and game rows through one URL (3.1). Only
  co-location keeps them passing unchanged.
- *What guards the split code paths:*
  - new split tests in WP-C and WP-D;
  - a static SQL rule (D8) that rejects auth-only table names outside `identity_store.py`. This is the bug class that
    co-located tests cannot catch;
  - the deploy refuses the co-located topology.
- *Rejected:*
  - Converting every harness to two databases. That changes the frozen web support files and 40-plus API test files.
  - `postgres_fdw` foreign tables in test databases. It needs an extension, works differently from production, and
    adds a test-only schema.

**D2. Auth database contents** (`migrations/auth/001_baseline.sql`). The baseline creates:
- `"user"`, `session`, `account`, `verification` and their indexes, copied from `migrations/002_auth.sql`;
- `auth_send_event` (from `001_inventory.sql:21-27`) and `auth_rate_event` (from `040_auth_rate_event.sql`);
- `operations_counter`, with the same columns and name CHECK as `019_operations.sql` plus `040`'s widening. Only the
  gateway names are written there;
- `owner_binding(singleton bool PRIMARY KEY CHECK(singleton), user_id text NOT NULL REFERENCES "user"(id) ON DELETE
  CASCADE, bound_at timestamptz NOT NULL DEFAULT now())`;
- `collector_profile`, with the identity columns only: `user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE
  CASCADE`, `handle`, `handle_key UNIQUE`, `display_name`, `handle_changed_at`, and the CHECKs from `100:8-14`;
- `released_handle` (from `100:18-21`);
- `generated_handle()`, with its body copied verbatim from `100:54-64`.

Every statement uses `IF NOT EXISTS` or `CREATE OR REPLACE` with an identical body, so in the co-located topology the
file is a no-op on a database that already has the legacy tables.

The baseline has no trigger that writes game rows: no `onboard_auth_account`, no `onboard_collector_profile`.

Grants: a `DO` block grants the role `prizecheck_identity` the following, and only when that role exists:
- `SELECT, INSERT, UPDATE` on `collector_profile`;
- `SELECT, INSERT, UPDATE, DELETE` on `released_handle`;
- `SELECT` on `owner_binding`, `auth_send_event`, `auth_rate_event` and `operations_counter`;
- `EXECUTE` on `generated_handle()`.

The role gets nothing on `"user"`, `session`, `account` or `verification`.

*Why `collector_profile` and `owner_binding` keep their names:* in the co-located topology they must be the very tables
the frozen tests seed.

*Owner flag:* the binding stays a singleton table in the auth database. It is not a `"user".is_owner` column and not a
signed claim (owner question Q2).

**D3. The game database keeps a mirror.**
- The game database's `collector_profile` stays exactly as it is: the same table, columns, FKs to `inventory_owner`,
  and the display-name and invite triggers.
- In the split topology its `handle`, `handle_key`, `display_name` and `handle_changed_at` are a mirror of the auth
  database. The game-only columns (`open_to_cash_offers`, `trader_id`, `suspended_at`) stay authoritative locally.
- Every game SQL join on Handles and names stays unchanged: Friend lookups, sorts, Trade matches and reports.
- `friendship`, `block`, `friend_request_declined`, `invite_link`, `invite_projection_outbox`, `discovery_setting` and
  `handle_lookup_event` stay in the game database. The Handle attempt limit stays per backend.
- *Rejected:*
  - A gateway read per lookup. It rewrites about 15 modules' SQL joins and sorts, and makes every social read depend on
    the gateway.
  - Signing the Handle into requests. It only covers the caller, not the Friends shown to them.

**D4. Who writes Handles: the API, through a narrow seam into the auth database.**
- `PUT /api/profile/handle` and `/display-name` stay API routes, with today's paths, shapes and check order.
- The parts that must be global (the advisory locks, the taken and held check, the release, the update, and the 30-day
  limit read) run on the auth database through `IdentityStore`. The API then copies the result into the mirror.
- *Rejected:* moving these routes to the gateway. It ports `name_rules.py` and the filter list to TypeScript and moves
  7 API test files' coverage. It also needs an API-to-gateway callback.
- This deviates from the spec's "a claim goes through the gateway" (owner question Q3).

**D5. The signed message is unchanged.**
- `verified_user` and `identity.py:28` stay byte-for-byte the same. So does the gateway's signing at
  `auth/src/server.ts:600-611`.
- The owner check reads the auth `owner_binding` through `IdentityStore.is_owner`.
- The owner rule stays as it is today: the gateway admits the verified `OWNER_EMAIL` before binding (for sign-in only),
  and the API denies owner routes until `bind_owner.py` binds.
- *Why:* behaviour preservation. Changing it would break 11 API test files.
- When test helpers may change, add a signed `x-internal-owner` claim. The cost is low: one header, `verified_user`,
  and the `server.ts` signing.

**D6. New owners and lazy creation.**
- The auth database has no sign-up trigger that reaches game data. The API already creates `inventory_owner`, `Unsorted`
  and the profile lazily (*identity pack* §4: `location_tree.py:127-135`, `locations.py:28-36`, `decks.py:311`,
  `holdings.py:111`, `inventory_core.py:136`, `metadata_reviews.py:117`, `social/owners.py:22-29`).
- In the split topology, every one of those insert sites calls `identity_store(conn).adopt_new_owner(user_id)` when its
  insert created the row:
  1. ensure the auth identity row exists (generating a Handle in the auth database if needed);
  2. overwrite the local placeholder made by the trigger with it, in the same game transaction.
- In the co-located topology `adopt_new_owner` is a no-op, so behaviour is as today.
- `auth/tests/signup.test.ts:82` keeps passing because co-located databases keep the legacy `020` trigger.

**D7. Account deletion stays out of scope.**
- Hook only: the module docstring of `identity_store.py` records the future path. The gateway deletes `"user"`, which
  cascades to `collector_profile`, `owner_binding`, `session` and `account` in the auth database. It then calls each
  enabled backend's future internal deletion route, which applies the existing set-null and cascade rules.
- No route is added.

**D8. Python boundaries use a guardrail-style AST script, not import-linter.**
- *Why:*
  - no new dependency in the API image (`api/requirements.txt` is the runtime image's file);
  - it matches `scripts/check_guardrails.py`;
  - it can read `importlib.import_module("app.…")` literals, which import-linter cannot see;
  - the same script carries the SQL rule.
- The allow-list is a text file. A new edge fails, and a stale allow-list line fails too, so the list can only shrink.
- No TypeScript check this round (the web app is out of scope).

**D9. Catalog FKs: the core baseline leaves out FKs into game tables.**
- `migrations/core/000_baseline.sql` creates the core tables with their id columns and no FK to any `catalog_*` table.
  The affected columns are those in the *api pack* §4: `holding.edition_id`, `deck_list_line.edition_id`,
  `loan_line.edition_id`, `borrowed_holding.edition_id`, `trade_line`, `trade_want`, `trade_accept`,
  `collection_import_row`, `missing_card_report` and `art_*.printing_id`.
- A future game track adds the FKs after it creates its catalog. The Pokémon database keeps its existing FKs.
- *Rejected:* a shared core `card_edition` and `card_printing` identity table. It needs a live backfill and FK repointing
  on 13 columns, and every catalog insert path would change.

**D10. Migration tracks without re-running history.**
- The pokemon track is the existing `migrations/*.sql` at the root. Files stay in place, and `schema_migration.name`
  stays the bare file name, as old releases expect for a rollback.
- New tracks record `core/<file>` and `auth/<file>`.
- For a game database the order is:
  1. game files up to and including the game's cutoff (pokemon: `159_*`, the last file today);
  2. the core track, with the files that the game's legacy history already provides recorded without running (pokemon:
     `core/000_baseline.sql`);
  3. the remaining game files.
- Later releases follow the same rule: pending core files first, then pending game files. Core migrations never
  reference game tables; game migrations may depend on core.
- With no game (`--game none`), only the core track is applied.
- No new pokemon or core migration ships in this refactor, except WP-C1's `160_catalog_set_code.sql` (owner decision) and
  later `NNN_set_codes.sql` files that a `set_codes.tsv` edit requires.

**D11. Composition, not seams.**
- **Core is a library of game-free pieces:** pure functions, SQL building blocks and Pydantic models. It never imports a
  game and knows nothing about the active game.
- **`games/pokemon` composes features.** It owns every route and all the wiring, imports core pieces, and adds its own.
- **Game values reach core as arguments or SQL fragments at the call site.** Examples are `source='tcgdex'`, `'USD'`,
  the allowed art hosts, card-kind lists, facet SQL, Reprint Group and Card Identity CTEs, and format check results.
  Nothing is registered, and core has no `current()`.
- **Extract only code that already exists and is game-free.** Invent nothing for a second game.

Rules the workers apply to every split:
1. **A route goes where its wiring is.** A route module that needs any Pokémon value moves its *whole* router to
   `games/pokemon`, so router-internal route order never changes. Core keeps the game-free functions, models and SQL
   that the route uses.
2. **A Pydantic model** with a Pokémon-typed field (`CardKind`, `TrainerType`, `ElementalType`, `TargetFormat`, a
   format-check result) lives with its Pokémon route. Game-free models go to core. Class names never change, so the
   OpenAPI component names stay the same. The WP-B snapshot proves it.
3. **A core function that needs a game value** takes it as a keyword-only parameter with **no default**, so a missed
   call site fails loudly.
4. **Mixed files are split, not allow-listed.** The allow-list holds only the edges of files tagged **Later**
   (split-map section 1A), and it shrinks to empty when they land.
5. **Entry points pinned by test assertions keep their dotted path as a root-class shim.** The shim runs the real module
   when started with `-m`, and re-exports nothing else. The pins:
   - `app.catalog_import` (`api/tests/test_catalog_outbox.py:842`, `catalog_dispatch.py:18`);
   - `app.catalog_refresh` (`tests/tooling/test_deploy_pipeline.py:300,306`, `test_host_deploy_script.py:119,145,1128`);
   - `app.price_runner` (`auth/tests/price-runners-harness.ts:272`,
     `api/tests/catalog_process_fixture/price_fixture.py:232`, `test_price_fixture.py:60,202`,
     `price_launcher.py:133`);
   - `app.host_readiness` (`tests/tooling/test_host_deploy_script.py:183,1561`, `api.Dockerfile:28`).

**D12. No `GAME` setting, no registry, no protocols.**
- One game exists, so `main.py` mounts the Pokémon app: `from app.games.pokemon.app import ROUTERS, LIFESPAN_HOOKS`.
- `games/pokemon/app.py` holds today's `main.py:94-116` tuple **in the same order**. That tuple includes the core
  routers that need no game value; the Pokémon app imports them (game → core is allowed).
- `LIFESPAN_HOOKS` is `(start_warmups bound to the Pokémon art hosts, rule_rollout.start_on_startup,
  format_standing.rebuild_on_startup)`, run in that order, with `stop_warmups` on shutdown as today.
- `main.py` keeps the FastAPI app, `/api/health`, the request-count middleware, and the re-export of `connect`.
- Rejected: `GAME`, slots, `current()` and the D12 protocols of the previous revision. They solved for a second game
  that doesn't exist yet. When Riftbound comes, `main.py` chooses which game's `app.py` to mount.

**D13. Phasing (the owner may adjust).**
- **Now:**
  - WP-B, WP-B2, WP-B3 (the architecture-pin port) and WP-B4 (the replay fixtures);
  - WP-C1, the printed set code table (the one migration allowed Now), then WP-C2, where CardDisplay reads it;
  - moving the 58 Pokémon-only files;
  - the MarketplacePrices, QuoteSource and ArtSources splits;
  - the CollectionImport and deck-import groups (the five `import_*` helpers and `missing_cards` move wholly; owner
    decision 2026-10-29);
  - the deck routes (WP-D1), and publishing and discovery (WP-D2), by composition: the game owns the response
    models, and core owns the mechanics (owner decision 2026-10-29);
  - docs.
- **Later (Riftbound):**
  - ReprintRules (`want_list`, `swap_hints`, `social/friend_reads`, `social/trade_matches`, `card_accepts`);
  - `host_readiness`;
  - moving the pure core modules;
  - identity (Design B, split-map section 5);
  - revisiting which parts of the Missing Card Reports flow (`missing_cards`) could become core for reuse;
  - before `social/` moves: porting the six remaining path-keyed scans in `test_social_contract.py`
    (`RESERVING_PICKS_`, `LISTABLE_`, `FOR_TRADE_`, `REACH_`, `MESSAGE_` and `DISCOVERY_CALLERS`) into the checker, the
    same way as WP-B3;
  - the migration tracks and the core baseline.
- CardDisplay is Now, through a catalog table (WP-C1, WP-C2; owner decision 2026-10-29).
- GameTypes and DeckChecks are Now, in WP-D1 and WP-D2 (owner decision). Only `want_list` (ReprintRules) keeps a
  Later edge, to the Pokémon line display.

### 3.3 IdentityStore (WP-D), `api/app/core/identity_store.py` (at `api/app/identity_store.py` until WP-J)

```python
@dataclass(frozen=True)
class Identity: user_id: str; handle: str; handle_key: str; display_name: str; handle_changed_at: datetime | None
GATEWAY_COUNTERS = ("sign_in_delivered", "sign_in_failed", "too_many_sign_ups")
class IdentityStore(Protocol):
    def current(self, user_id: str) -> tuple[Identity, datetime | None]: ...  # (identity, available_at) as profile.py:228-231
    def recase(self, user_id: str, handle: str) -> None: ...                   # profile.py:235-237 branch
    def claim(self, user_id: str, handle: str) -> tuple[Literal["claimed", "taken", "too_soon"], datetime | None]: ...
        # profile.py:252-271 block; "too_soon" carries available_at (split recheck, see below)
    def set_display_name(self, user_id: str, name: str) -> None: ...
    def sync_mirror(self, game_conn, user_ids: Sequence[str]) -> None: ...
    def adopt_new_owner(self, user_id: str) -> None: ...                       # D6
    def is_owner(self, user_id: str) -> bool: ...
    def owner_id(self) -> str | None: ...
    def gateway_operations(self) -> dict: ...  # sign_in_requests_24h, signups_24h, {name: count} for GATEWAY_COUNTERS
def identity_store(game_conn) -> IdentityStore: ...
```

The two topologies:
- `identity_store` returns `ColocatedStore(game_conn)` when `AUTH_DATABASE_URL` is unset, or equal to `DATABASE_URL`
  after normalisation (parse with `urllib.parse`; compare host, port, dbname and user). Otherwise it returns
  `SplitStore(game_conn)`.
- `ColocatedStore` runs today's SQL, verbatim, on `game_conn`, inside the caller's transaction.
  `sync_mirror` and `adopt_new_owner` are no-ops.
- `SplitStore` opens its own connection to `AUTH_DATABASE_URL` for each method call:
  - settings: `connect_timeout=5`, `options='-c statement_timeout=3000 -c lock_timeout=3000'`, `dict_row`;
  - each method runs in its own committed transaction;
  - an `OperationalError` raises `HTTPException(503, {"code": "IDENTITY_UNAVAILABLE"})`.

`SplitStore.claim` and `SplitStore.recase` each run one auth transaction:
1. `SELECT … FROM collector_profile WHERE user_id=%s FOR UPDATE` on the auth connection, which serialises one user's
   changes across backends.
2. Recheck the 30-day limit inside this transaction (claim only). If it fails, return `("too_soon", available_at)`.
   `profile.py` maps that to the same 409 `HANDLE_CHANGE_TOO_SOON` as the earlier check. Both checks run, so the error
   order is unchanged; within one backend the game owner lock (`owner_and_rows`) already serialises the user.
3. Take the advisory locks (`prizecheck.handle:<key>`, in key order).
4. Check taken or held, then release and update.
5. Commit.

`ColocatedStore.claim` never returns `"too_soon"`, because the caller's earlier check ran in the same transaction.

The caller then runs `sync_mirror(game_conn, [user_id])` before storing the idempotent answer.

If the game transaction fails after the auth commit, a retry with the same idempotency key takes the "same key" branch
and repairs the mirror. If the client never retries, the next `read_profile` repairs it. In the split topology
`read_profile` calls `sync_mirror(conn, [user_id])` for the caller first; on `IDENTITY_UNAVAILABLE` it skips the repair
and reads the mirror as is, so profile reads never fail because of the auth database.

`sync_mirror(game_conn, user_ids)`:
1. Read the auth identity columns for `user_ids` (the target set).
2. Run everything inside a savepoint (`with game_conn.transaction():`), so a failure never poisons the caller's
   transaction.
3. Build the closure: the target users, plus every local user whose mirror `handle_key` equals a target's new key,
   repeated until no new user appears (at most 20 users, else 503).
4. Read the auth rows for the whole closure.
5. Phase 1: set each closure user's mirror `handle` and `handle_key` to a placeholder, so swaps and cycles cannot hit the
   non-deferrable UNIQUE. The placeholder is `'z' || substr(md5(user_id), 1, 19)`, which is 20 characters and passes
   the `100:8-14` CHECKs.
6. Phase 2: set each to its auth values. Update only the four identity columns.
7. Any `UniqueViolation` or `CheckViolation` rolls back the savepoint and raises 503 `IDENTITY_UNAVAILABLE`.

The display-name triggers fire only in phase 2, and only when `display_name` is in the `SET` list. Leave
`display_name` out of phase 1.

Stale mirrors come only from multi-backend setups, the cutover gap, or a missed retry.

### 3.4 Target layout after the Now work

```
api/app/main.py                      root: FastAPI app, middleware; mounts games.pokemon.app.ROUTERS
api/app/{catalog_import,catalog_refresh,price_runner,host_readiness}.py   root entry shims (D11 rule 5)
api/app/core/prices/cost.py          from deck_cost: summarize, money helpers, DeckCostFigures, DeckCost, CostStatus,
                                     IncompleteReason
api/app/core/prices/quote_contract.py, core/prices/runner.py   game-free; source/currency passed in
api/app/core/art/store.py, core/art/urls.py   game-free; allowed hosts passed in
api/app/core/decks/printing.py       choose_edition (pure), store_printing_result
api/app/core/imports/collection_draft.py   storage_leaf, row-state SQL, counts and grouping, game-free models
api/app/core/decks/{store,index,ownership,loans,contents}.py   deck mechanics (WP-D1, split-map 1B)
api/app/core/trading/trade_wants.py   Trade Wants reads and writes used by core (WP-D1)
api/app/core/publications/{publish,discovery}.py   publish mechanics, listing and paging (WP-D2)
api/app/games/pokemon/app.py         ROUTERS (today's order), LIFESPAN_HOOKS
api/app/games/pokemon/{catalog,prices,imports,formats,exports,scanner,decks,art,publications,trading}/…   the 58 files
                                     + the Pokémon halves (no new folder may be named social: WP-B3 rule 12)
api/app/<every other module>         unchanged until Later (pure core, and the Later mixed files)
```

The full per-file map, with target paths, is `split-map.md` sections 1 and 1A. `api/tests` stays flat.

### 3.5 Live cutover plan (used by WP-E; the owner runs it)

1. Ship the release containing WP-A to WP-E with `AUTH_DATABASE_URL` set. The deploy script:
   - creates the auth database and roles if they are missing (database `prizecheck_auth`, owner role `prizecheck_auth`,
     API role `prizecheck_identity`), on the existing `db` service;
   - stops the old release, as it already does before migrating (`deploy/host/prizecheck-deploy.sh:879`);
   - backs up the Pokémon database;
   - runs `migrate.py`, which applies the auth track to the empty auth database;
   - if the auth database's `"user"` is empty and the Pokémon database's is not, runs `identity_cutover.py copy` then
     `verify`, and aborts the deploy on any mismatch. Nothing has written to the auth database at that point;
   - starts the new release.

   Sessions are copied, so nobody has to sign in again. The copy covers:
   - `"user"`, `account`, `session`, `verification` and `owner_binding`;
   - the identity columns of `collector_profile`;
   - `released_handle`;
   - `auth_send_event` and `auth_rate_event` rows from the last 2 days;
   - the `operations_counter` rows named in `GATEWAY_COUNTERS`.
2. The legacy identity tables stay in the Pokémon database, unused, as the rollback source.
3. **Rollback** to a pre-split release:
   1. stop the new release;
   2. run `identity_cutover.py copy-back`, which upserts the same tables from the auth database into the Pokémon
      database, so sign-ins and Handle changes made after the cutover survive;
   3. deploy the old release. Its `migrate.py` sees all of its files as applied, because the names are unchanged.
4. Dropping the legacy tables is a later, separate decision (Q5). Nothing in this refactor drops them.

## 4. Work packages

Rules for every package:
- Merge `dev` first.
- Run `npm run guardrails` and `npm run check`.
- Never edit anything under `web/`.
- Never change a test assertion. Changing one is a stop condition. The one exception is WP-B3's retirement (test
  invariants).
- Record each suite's baseline counts before the change and the actual counts after it.
- **Host note.** On this host, run every verify command with `TMPDIR=<worktree>/.scratch/tmp` (create the directory
  first; it is git-ignored scratch). `/tmp` is btrfs on a loop device, where an fsync takes about 234 ms, and the
  file-store timing tests fail there. Capacity and p95 budget tests may still fail under load. Rerun such a failure
  alone before treating it as evidence of anything.

Order and parallelism (**Now**):
1. **WP-B**, **WP-B2** and **WP-B4** together, first.
2. **WP-B3**, the architecture-pin port. It runs after WP-B, because it needs the checker, and before anything moves.
   WP-B2's group (a) tests must be green before step 3.
3. **WP-C1**, the printed set code table.
4. **WP-C2**, where the display reads use it.
5. **WP-I1**, which moves the Pokémon-only files.
6. **WP-F**, the Pokémon app module.
7. **WP-S1** (MarketplacePrices) in parallel with **WP-S2** (QuoteSource and ArtSources). Their files don't overlap.
8. **WP-S3** (CollectionImport and the deck-import group), after S1.
9. **WP-D1**, the deck routes.
10. **WP-D2**, publishing and discovery.
11. **WP-K** (docs) at any point.

WP-C1, WP-B3, WP-D1 and WP-D2 need independent opus review. For WP-B3, the review checks rule equivalence: each old assertion
maps to a rule at least as strict.

**Later (Riftbound)** work, which this revision does not detail:
- re-plan WP-A, WP-C, WP-D and WP-E for identity Design B;
- WP-H (the core baseline);
- the ReprintRules split;
- WP-J (moving the pure core modules).

The identity packages below (WP-A, WP-C, WP-D, WP-E) and WP-H are kept as reference only.

**Test invariants**, which bind every package:
- `web/tests` and `auth/tests` are not edited at all.
- In `api/tests`, only import lines, and monkeypatch or patch target strings naming moved symbols, may change. No
  assertion, fixture data, expected response or test may change or be removed.
- WP-B's snapshots must stay byte-identical across every package: the OpenAPI document, the route table (method, path,
  router order) and `npm run check:client`.
- Any expectation that would have to change: stop and escalate to the owner. Don't adjust the test.
- **Architecture-pin exception (owner decision, option C).** WP-B3 alone may delete these layout and architecture
  assertions:
  - `test_set_codes.py:68-79`;
  - `test_import_aliases.py:65-73`;
  - `test_price_source.py:268-280` except line 272;
  - `test_price_import.py:486-489`;
  - in `test_social_contract.py`, five scan tests and the constants `FRIENDS_OF_READERS`, `READERS` and
    `ALLOWED_IMPORTS`.

  WP-B3 also rewrites `test_set_codes.py:17` to find its data file through `format_evaluator`. Each deleted assertion
  becomes a named checker rule that is at least as strict (WP-B3). Every behaviour and data test in those files stays,
  and no other test anywhere is removed. After WP-B3, packages update the checker's rule lists, never `api/tests`, and
  each PR lists every rule-list change.

**Acceptance for each package:**
- the default CI checks are green;
- the touched `api/tests` files pass, through `npm run verify -- --suite api -- <files>`;
- a dispatched integration run, `gh workflow run verify.yml --ref refactor/shared-core -f integration=sharded`, passes,
  with its counts quoted, before the package is accepted.

**Before the branch merges to dev:** one `integration=full` run.

### WP-A: migration tracks and the auth baseline
- **Owned files:** `scripts/migrate.py`, `migrations/auth/001_baseline.sql` (new), `migrations/core/` (new, empty but for
  `README.md`), `scripts/release.py` (the migration digest lines only), `tests/tooling/test_migrate_tracks.py` (new),
  `api/tests/test_auth_track.py` (new).
- **Steps:**
  1. Write `migrations/auth/001_baseline.sql` per D2. Copy the table, index, CHECK and function bodies verbatim from
     `002_auth.sql`, `001_inventory.sql:16-27`, `019_operations.sql` plus `040_auth_rate_event.sql:5-16`, and
     `100_collector_profile.sql:8-21,54-64`. Make every statement idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`).
     Add no triggers. End with the guarded `DO $$ … IF EXISTS (SELECT FROM pg_roles WHERE rolname='prizecheck_identity')
     THEN GRANT … $$` block from D2.
  2. Rewrite `scripts/migrate.py` with these parts:
     - `TRACKS`: `auth -> migrations/auth`, `core -> migrations/core`, `pokemon -> migrations` (root, `*.sql`, not
       recursive).
     - `GAMES = {"pokemon": Game(cutoff="159_", core_provided=("000_baseline.sql",))}`. The cutoff is the prefix of the
       last root file today. Confirm it with `ls migrations | tail -1`.
     - Arguments `--game {pokemon,none}` (default: the `GAME` env var, else `pokemon`) and `--only {auth,game}`
       (default: both).
     - Game database order per D10.
     - The recorded name is `path.name` for the pokemon track and `f"{track}/{path.name}"` for the other tracks.
     - The auth track goes to `AUTH_DATABASE_URL`, falling back to `DATABASE_URL`. Apply it **after** the game tracks,
       so that in the co-located topology the legacy tables exist first and the auth file is a no-op.
     - Take `pg_advisory_lock(914710)` on each connection for the whole run. This closes the concurrent-run race noted
       in the *identity pack* §6.
     - Keep the `Applied <name>` output format.
  3. In `scripts/release.py:106-107`, make the digest comparison cover `migrations/**/*.sql`, keyed by the path relative
     to `migrations/`.
  4. No other file changes. `api/tests/test_catalog_references.migrate` stays as it is. It applies only root files,
     which in the co-located topology is today's full schema.
- **Tests:**
  - `tests/tooling/test_migrate_tracks.py` (pure; copy the structure of `tests/tooling/test_verify_harness.py`). Factor
    the plan function in `migrate.py` as `plan(track_files, applied_names, game) -> list[(track, path, run: bool)]` so
    it can be tested without a database. Assert:
    - root files map to bare names;
    - `core/000_baseline.sql` is recorded with `run=False` for pokemon;
    - the order is pokemon up to the cutoff, then core, then pokemon after the cutoff;
    - `--game none` gives the core track only.
  - `api/tests/test_auth_track.py`. Create its own databases the way `api/tests/test_catalog_browse.py` does (find its
    `CREATE DATABASE` helper), then assert:
    - (a) migrating an empty database with `--only auth` creates exactly the D2 tables and no trigger on `"user"`;
    - (b) running `migrate.py` twice on a co-located database applies nothing the second time, and records
      `auth/001_baseline.sql`;
    - (c) a database migrated by the *old* `migrate.py` (copy the old file's logic inline in the test) then migrated by
      the new one re-runs no root file.
- **Verify:** `npm run guardrails`. Then
  `npm run verify -- --suite api -- api/tests/test_auth_track.py api/tests/test_catalog_references.py api/tests/test_settings.py`
  must pass. Then `npm run verify -- --suite api --fast` must give baseline counts and zero new failures.

### WP-B: contract snapshots and the Python boundary checker
- **Owned files:**
  - new: `api/tests/test_api_contract.py`, `api/tests/api_contract/openapi.json`, `api/tests/api_contract/routes.json`,
    `scripts/check_python_boundaries.py`, `scripts/python_module_owners.txt`,
    `scripts/python_boundary_allowlist.txt`, `tests/tooling/test_python_boundaries.py`;
  - `package.json` (the `guardrails` script only).
- **Steps:**
  1. **Before any other change** on the branch, generate `openapi.json` (`json.dumps(app.openapi(), indent=1,
     sort_keys=True)`) and `routes.json`. `routes.json` is the list, in `app.routes` order, of
     `[sorted(methods) or None, path, route.name]`.
     `test_api_contract.py` asserts that both match the files exactly. It has no regenerate flag.
  2. Write `python_module_owners.txt`: one line per module still directly under `app/` (`<dotted name> <core|pokemon|root>`),
     from 3.4. `app.main` is root.
  3. Write `check_python_boundaries.py`:
     - It walks `api/app/**/*.py` with `ast`, covering module-level and function-level `Import` and `ImportFrom`
       (resolve relative imports) and `importlib.import_module("<literal>")` calls.
     - `app.games` and `app.games.pokemon` are empty packages. There is no registry and no `app/core/game.py` (D12),
       so the checker has no registry exception.
     - Owner of a module: `app.core.*` is core; `app.games.<g>.*` is game `<g>`; `app.main` is root; anything else
       comes from the owners file. A module missing from the owners file fails, and so does a stale owners line.
     - Forbidden edges: core to any game, core to root, core to a top-level module that the owners file marks `mixed`,
       and game `<g>` to game `<h>`.
     - Root modules are `app.main` and the D11 entry shims (`app.catalog_import`, `app.catalog_refresh`,
       `app.price_runner`, `app.host_readiness`). They may import anything.
     - The initial allow-list is the 34 edges in split-map section 2. Each Now package removes its own lines, leaving
       the 2 Later lines that split-map section 1A lists.
     - Each forbidden edge must appear in the allow-list as `src -> dst`, or the check fails. An allow-list line that
       matches no edge also fails.
     - SQL rule: in any string constant in `api/app` outside `identity_store.py`, the regex
       `(?i)\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+("user"|session|account|verification|auth_send_event|auth_rate_event|owner_binding|released_handle)(?![\w"])`
       fails. Baseline it with today's hits in a second section of the allow-list file (`sql <module>: <table>`). WP-D
       empties that section.
     - Output `FAILED: <reason>` lines and exit 1, matching `check_guardrails.py`.
  4. Generate the initial allow-list from the tool's own output, with the tool's own `--write-baseline` flag.
  5. `package.json` `guardrails`: insert `&& .venv/bin/python scripts/check_python_boundaries.py` right after
     `check_guardrails.py`.
- **Tests:** `tests/tooling/test_python_boundaries.py`, built from temporary-directory fixture trees in the style of
  `tests/tooling/test_bundle_boundary.py`. Cases:
  - a core-to-game import fails;
  - a game-to-other-game import fails;
  - a function-level import is seen;
  - an `importlib.import_module("app.games.pokemon.x")` in core fails;
  - an allow-listed edge passes;
  - a stale allow-list line fails;
  - an unowned top-level module fails;
  - a SQL hit outside `identity_store.py` fails, and the same text inside it passes.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):** `npm run guardrails` (includes the new unittest). Then
  `npm run verify -- --suite api -- api/tests/test_api_contract.py` passes.

### WP-C: the gateway uses `AUTH_DATABASE_URL`
- **Owned files:** `auth/src/auth.ts`, `auth/src/server.ts`, `auth/src/rateLimits.ts` (only if it reads the URL
  itself), `auth/tests/support/oauth-gateway.ts` (additive only), `auth/tests/identity-split.test.ts` (new).
- **Steps:**
  1. Add one exported `authDatabaseUrl()` in `auth/src/auth.ts` that returns
     `process.env.AUTH_DATABASE_URL || process.env.DATABASE_URL`.
     - All four pools (`auth.ts:15,22-28,32-36,47-54`) use it.
     - The gateway must not read `DATABASE_URL` anywhere else. Check with `grep -rn DATABASE_URL auth/src`.
  2. `server.ts:41-49`: the start check requires `AUTH_DATABASE_URL` or `DATABASE_URL`, with the same error style.
  3. No SQL changes. `BOUND`, `isOwner`, the rate limits, `allowedSend` and `authCounter` already touch only tables that
     D2 puts in the auth database. Confirm this by reading each query. Any query that names a game table is a stop
     condition.
  4. `oauth-gateway.ts`: add an optional `authDatabaseUrl` option. When it is given, the gateway gets
     `AUTH_DATABASE_URL`, and the helper runs `migrate.py --only auth` against it. Existing callers are unchanged.
- **Tests:** `auth/tests/identity-split.test.ts`, structured like `auth/tests/oauth-owner-bootstrap.test.ts`. It creates
  two databases (game: the full `migrate.py`; auth: `--only auth`), starts the gateway on the auth database, signs in
  through the OAuth fake, and asserts:
  - the sign-in works;
  - the `"user"` and `session` rows exist in the auth database and the game database's `"user"` is empty;
  - the owner bootstrap and the signup gate behave as in `oauth-owner-bootstrap.test.ts`, with `owner_binding` seeded in
    the auth database.

  The test does not start the API.
- **Verify:** `npm run check`. Then `npm run verify -- --suite auth` gives baseline counts plus the new file.

### WP-D: the API IdentityStore
- **Owned files:**
  - new: `api/app/identity_store.py`, `api/tests/test_identity_split.py`;
  - `api/app/identity.py` (`require_owner` body only), `api/app/social/profile.py`, `api/app/operations.py`,
    `api/app/host_readiness.py`, `api/app/rule_rollout.py`, the lazy-creation sites listed in D6, `scripts/bind_owner.py`,
    `scripts/operations_mail.py`;
  - `scripts/python_boundary_allowlist.txt` (removing the SQL lines only).
- **Steps:**
  1. Write `identity_store.py` per 3.3. In `ColocatedStore`, every method's SQL is cut verbatim from the place it
     replaces, so behaviour is byte-for-byte the same.
  2. `require_owner(conn, user_id)`: same signature. The body becomes
     `if not identity_store(conn).is_owner(user_id): raise HTTPException(403, "Owner access required")`.
  3. `profile.py`. `set_handle` keeps the order of 3.1:
     1. `clean_handle`;
     2. `store.current()`;
     3. the same-key branch, `store.recase()`;
     4. the 30-day limit, from `available_at`;
     5. the attempt limit on the game connection, unchanged;
     6. `store.claim()`;
     7. `store.sync_mirror(conn, [user_id])`, then `_store`.

     The "taken" path still commits the counted attempt and then raises 409, as at line 271. A `"too_soon"` result from
     `claim()` (split only) raises the same 409 `HANDLE_CHANGE_TOO_SOON` with `available_at`, after the commit, so the
     attempt stays counted.

     `read_profile`: in the split topology, call `sync_mirror(conn, [user_id])` for the caller first, and skip it on
     `IDENTITY_UNAVAILABLE` (3.3).

     `set_display_name`: call `store.set_display_name` and then `sync_mirror` in place of the `UPDATE` at line 191. The
     mirror `UPDATE` fires the existing triggers.

     `read_profile`'s `create_collector_profile` call and the invite link stay as they are.
  4. D6: at each lazy-creation site, make the insert `RETURNING user_id` if it doesn't already. When a row came back,
     call `identity_store(conn).adopt_new_owner(user_id)`.
     - `SplitStore.adopt_new_owner` inserts into the auth database: `INSERT INTO collector_profile(user_id, handle,
       handle_key, display_name) SELECT %s, h, lower(h), 'Collector' FROM generated_handle() h ON CONFLICT (user_id) DO
       NOTHING`.
     - It then runs `sync_mirror`.
  5. `operations.py`:
     - read `sign_in_requests_24h`, `signups_24h` and the `GATEWAY_COUNTERS` rows through `store.gateway_operations()`;
     - read the other `operations_counter` rows on the game connection with `WHERE name <> ALL(%s)`;
     - merge the two into the same `counters` dict.

     In the co-located topology the result equals today's.
  6. `host_readiness.py:75` and `rule_rollout.py:176,412-416`: read the owner through `store.owner_id()`. Leave the
     operator text at `host_readiness.py:80-82` unchanged.
  7. `scripts/bind_owner.py`:
     - ensure `inventory_owner` and `Unsorted` on `DATABASE_URL`, as now;
     - then write `owner_binding` on `AUTH_DATABASE_URL`, falling back to `DATABASE_URL`;
     - in the co-located topology, use one connection and one transaction.

     `scripts/operations_mail.py:27`: run the join on `AUTH_DATABASE_URL`, with the same fallback.
  8. Empty the `sql` section of the allow-list. `check_python_boundaries.py` must pass.
- **Tests:** `api/tests/test_identity_split.py`. It creates game and auth databases as in WP-A's test, sets both URLs with
  `monkeypatch.setenv`, seeds `"user"` rows in the auth database, and calls routes with the `call` helper from
  `test_holdings`. It asserts:
  - a new caller's first `GET /api/profile` shows the auth database's generated Handle, and the game mirror equals it;
  - `set_handle` gives claimed, taken (held in auth `released_handle`), too soon, and recased;
  - a retry after a game-side failure, simulated by monkeypatching `_store` to raise once, repairs the mirror;
  - with no retry after that failure, the next `GET /api/profile` repairs the mirror;
  - two threads claiming the same free Handle for two users at once: exactly one gets `claimed` and the other
    `HANDLE_TAKEN`;
  - two threads changing one user's Handle at once: exactly one succeeds and the other gets `HANDLE_CHANGE_TOO_SOON`;
  - `sync_mirror` resolves a two-user Handle swap (the auth rows swapped, the mirror stale) without an error;
  - a Display Name change reaches the auth database, the mirror and a Loan's `lender_name`, through the trigger;
  - `require_owner` follows the auth `owner_binding`, while the game `owner_binding` stays empty;
  - the operations panel counts gateway rows from the auth database;
  - every split case above also passes with `AUTH_DATABASE_URL` connecting as a `prizecheck_identity` login role.
    The test creates the role with a random password and re-runs the auth baseline to grant it. The same role gets
    `permission denied` on `SELECT FROM "user"`, `session` and `account`, and on `INSERT INTO owner_binding`. If the
    CI server refuses password login for a new role, stop and report.

  It creates its own databases, so give it exactly the marks `test_catalog_browse.py` uses for its database-creating
  tests, and no others.
- **Verify:**
  - `npm run guardrails`;
  - `npm run verify -- --suite api -- api/tests/test_identity_split.py api/tests/test_profile.py api/tests/test_operations.py api/tests/test_host_readiness.py api/tests/test_rule_rollout.py api/tests/test_signup_capacity.py`;
  - then `npm run verify -- --suite api --fast` (all shards) and
    `npm run verify -- --suite browser -- web/tests/social-profile.spec.ts web/tests/owner-controls.spec.ts web/tests/app-shell.spec.ts`.

  Each gives baseline counts.

### WP-E: harness, deploy and cutover
- **Owned files:** `scripts/verify_resources.py`, `scripts/identity_cutover.py` (new), `compose.deploy.yml`,
  `compose.prod.yml`, `deploy/host/prizecheck-deploy.sh`, `deploy/host/*.env.example`, `scripts/recovery.py`,
  `tests/tooling/test_deploy_pipeline.py`, `tests/operations/*` (only where backup and restore now cover two databases),
  `tests/tooling/test_identity_cutover.py` (new), `api/tests/test_identity_cutover.py` (new).
- **Steps:**
  1. `verify_resources.py`: add `AUTH_DATABASE_URL` to `WORKER_KEYS` and `STACK_KEYS`, with the value equal to that
     worker's or stack's `DATABASE_URL` (co-located).
  2. `identity_cutover.py`, with subcommands `copy`, `verify` and `copy-back`:
     - It refuses unless both URLs are set and differ (D1 normalisation).
     - `copy` requires the target `"user"` to be empty. It copies the tables of 3.5 in FK order inside one target
       transaction, using `COPY … TO STDOUT` / `COPY … FROM STDIN` through psycopg with explicit column lists.
     - `copy` and `verify` read the source in one `REPEATABLE READ READ ONLY` transaction, so they see one snapshot.
     - `verify` compares, per table, the row count and `md5(string_agg(row_to_json(t)::text, E'\\n' ORDER BY <pk>))`.
       It uses the same explicit column list on both sides, which is **every copied column**: session tokens, expiry
       and profile values, not just keys. For `collector_profile`, the list is the four identity columns plus
       `user_id`.
     - `copy-back` makes the game database's identity data equal to the auth database's, in one game transaction:
       - for `"user"`, `session`, `account`, `verification`, `owner_binding` and `released_handle`, delete the game rows
         whose primary key is absent from the auth database, then upsert the rest. Revoked sessions and removed sign-ins
         stay removed;
       - insert new `"user"` rows normally. The legacy `020` trigger then creates their `inventory_owner` and `Unsorted`,
         as the old release expects;
       - for `collector_profile`, update only the four identity columns of existing rows. Never touch
         `open_to_cash_offers`, `trader_id` or `suspended_at`. Rows missing locally are made by the legacy trigger chain
         and then updated;
       - `copy-back` then runs `verify` in the reverse direction and exits non-zero on any mismatch.
  3. Compose:
     - auth gets `AUTH_DATABASE_URL=postgresql://prizecheck_auth:${AUTH_DB_PASSWORD}@db:5432/prizecheck_auth`;
     - the API anchor gets `AUTH_DATABASE_URL` as `prizecheck_identity`, and `GAME=pokemon`;
     - `tools` gets `AUTH_DATABASE_URL` as `prizecheck_auth`, for migrations and the cutover.
  4. Deploy script:
     - create the database and roles idempotently (through `compose exec db psql`);
     - refuse when `AUTH_DATABASE_URL` is missing or equals `DATABASE_URL`;
     - `backup_database` dumps both databases;
     - after `migrate.py`, run the 3.5 step-1 cutover logic.

     `recovery.py` restores both dumps. Add the new secrets to the env examples.
- **Tests:**
  - `api/tests/test_identity_cutover.py`, with its own databases. Seed a co-located database with users, sessions,
    owner, Handles and a released Handle. Then:
    - `copy` then `verify` passes;
    - `copy` into a non-empty target fails;
    - `copy-back` after a Handle change in the auth database updates the game database;
    - `verify` detects a tampered row, including a changed session token or `expiresAt` with the same key;
    - `copy-back` after a session is revoked in the auth database removes it from the game database, and keeps
      `suspended_at` and `trader_id` on the game profile.
  - `tests/tooling/test_identity_cutover.py`: the argument and refusal rules.
  - Update `tests/tooling/test_deploy_pipeline.py` only for the new deploy steps.
- **Verify:**
  - `npm run guardrails`;
  - `npm run verify -- --suite api -- api/tests/test_identity_cutover.py`;
  - `npm run verify -- --suite operations`;
  - an integration run, `gh workflow run verify.yml --ref refactor/shared-core -f integration=sharded`. Quote its
    result.

### WP-C1: printed set code in the catalog (Now, after WP-B; the one migration allowed Now)
- **Decision, set level.**
  - Add a new table, `catalog_set_code(set_id text PRIMARY KEY CHECK (length(set_id) BETWEEN 1 AND 80), code text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,4}$'))`,
    holding exactly the 136 rows of `set_codes.tsv`.
  - The fallback is written once, in a view (owner decision 2026-10-29, option A, read time):
    ```sql
    CREATE VIEW catalog_printing_set_code AS
    SELECT p.id AS printing_id, coalesce(sc.code, pd.set_id, '') AS set_code
      FROM catalog_printing p
      LEFT JOIN catalog_printing_display pd ON pd.printing_id = p.id
      LEFT JOIN catalog_set_code sc ON sc.set_id = pd.set_id;
    ```
    There is exactly one row per `catalog_printing`. Readers add `JOIN catalog_printing_set_code psc ON
    psc.printing_id = p.id` and select `psc.set_code`.
  - **Why a view, not a shared Python fragment:**
    - It matches the existing style. Derived catalog facts are already views that readers join by `printing_id`
      (`catalog_printing_art`, `catalog_card_attribute`, `catalog_reprint_group_effective`).
    - The rule lives next to its table, in the database. `migrate.py` checks the very object that readers use.
    - A fragment would force every query to use the same `pd` alias, and would need a home module that four core
      modules import.
  - Core reads may select the view. It stays Pokémon-backed, and no Riftbound filling is planned: the owner says
    Riftbound won't need it.
- **Why set level:**
  - The code is a function of the TCGdex set ID alone (`set_codes.code_for(set_id) = CODES.get(set_id, set_id)`).
  - There is no durable set table. `catalog_generation_set` is keyed by `(generation_id, set_id)` and remade by every
    import (`044:10-15`).
  - `catalog_printing_display` is per Printing, and its trigger `remember_printing_display` (`016`) cannot read the
    TSV. A Printing-level column would copy one value onto every Printing of a set, and would need the trigger changed
    and every row rewritten on each TSV edit.
- **Fallback at read time (owner decision, option A).** The view's `coalesce` gives the same result as
  `code_for(coalesce(pd.set_id, ''))`, which is what every reader passes today, including `''` for a Printing with no
  display row. `catalog_set_code` holds only the rows of `set_codes.tsv`. Catalog import and refresh never touch it,
  and a new set shows its set ID exactly as today.
- **Not a source:** tcgcsv's group `abbreviation` differs from the printed codes for older sets and subsets (`SWSH01`
  against `SSH`, `SM01` against `SUM`, `CRZ:GG` against `CRZ`; checked 2026-10-29), so nothing fills the table from it.
- **Owned files:**
  - new: `migrations/160_catalog_set_code.sql`, `scripts/set_code_migration.py`, `api/tests/test_set_code_column.py`,
    `tests/tooling/test_set_code_guardrail.py`;
  - `scripts/check_guardrails.py` (one new rule), `scripts/migrate.py` (a post-run check), `api/app/set_codes.py`
    (an exported `parse(text)` alias of `_load`, only if the generator needs it without importing `app`).
- **Steps:**
  1. `scripts/set_code_migration.py`:
     - `render(tsv_text) -> str` returns SQL: a first line `-- set_codes.tsv digest: <sha256[:16]>` (the same
       computation as `set_codes.DIGEST`), then `DELETE FROM catalog_set_code;`, then one
       `INSERT INTO catalog_set_code(set_id, code) VALUES …` with every row in file order.
     - It parses with the same rules as `set_codes._load`: read `api/app/set_codes.tsv` by path and copy the 12-line
       parser, so the script needs no `PYTHONPATH`.
     - `python scripts/set_code_migration.py <NNN>` writes `migrations/<NNN>_set_codes.sql`. It refuses if the file
       exists.
  2. `160_catalog_set_code.sql`: the `CREATE TABLE` and the `CREATE VIEW` above, then the output of `render()`
     pasted below them. No other table changes. Later `NNN_set_codes.sql` files replace rows only; the view stays.
  3. **Guardrail** (`check_guardrails.py`, rule `set_code_migration_violations`):
     - find the highest-numbered `migrations/*.sql` whose first line matches `-- set_codes.tsv digest: ([0-9a-f]{16})`;
     - fail with `FAILED: set_codes.tsv changed; run scripts/set_code_migration.py <next number>` unless the digest
       equals the current TSV's digest.

     It runs in `npm run guardrails` (the CI `checks` job and the pre-commit hook), so a TSV edit cannot merge without
     its migration.
  4. **Live check after migrating:**
     - at the end of `scripts/migrate.py`, if the table `catalog_set_code` exists, compare its rows with the parsed TSV
       (exact set equality of `(set_id, code)`);
     - check that, for every `catalog_printing`, the view's `set_code` equals the TSV-derived
       `code_for(coalesce(pd.set_id, ''))`, and that the view has exactly one row per Printing;
     - on any difference, print `set code table disagrees with set_codes.tsv: <first 5 differences>` and exit 1.

     The deploy already aborts on a failed `migrate.py` (`deploy/host/prizecheck-deploy.sh:881`), so no deploy-script
     or tooling-test change is needed. Every gate database runs it too (`ci.sh:79`, `verify_resources.py:26`).
- **Staleness cannot be silent:**
  - every TSV edit must ship a migration (the guardrail);
  - every deploy applies migrations;
  - every `migrate.py` run proves that the table equals the TSV, or fails;
  - catalog imports cannot make it stale, because new sets fall back at read time.
- **Tests (additions only):**
  - `api/tests/test_set_code_column.py` on the gate database:
    - the table equals `set_codes.CODES` exactly (136 rows);
    - `catalog_printing_set_code` has exactly one row per `catalog_printing`;
    - for each row, `set_code` equals `set_codes.code_for(coalesce(pd.set_id, ''))`. This covers the unmapped fixture
      set (`code_for("fixture") == "fixture"`).
  - `tests/tooling/test_set_code_guardrail.py`, structured like the tests in `tests/tooling/test_guardrails.py`:
    - a matching digest passes;
    - a TSV edit with no new migration fails;
    - `render()` is deterministic.
- **Acceptance (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):**
  - the new tests pass;
  - `test_api_contract.py` is unchanged (the column is in no response model);
  - `npm run guardrails`;
  - the full `--suite api --fast` run gives baseline counts;
  - the live check is printed by `migrate.py` on the first deploy, and its output is quoted;
  - the per-package acceptance.

### WP-C2: CardDisplay reads the column (Now, after WP-C1)
- **Owned files:** `api/app/collection.py`, `api/app/holdings.py`, `api/app/swap_hints.py`,
  `api/app/social/friend_reads.py`, `scripts/python_boundary_allowlist.txt`,
  `scripts/python_architecture_rules.py` (rule 1 only).
- **Steps:** in each query that feeds a `set_code` field, add `JOIN catalog_printing_set_code psc ON
  psc.printing_id = p.id` and select `psc.set_code AS set_code` (WP-C1). Never repeat the `coalesce`. All four sites
  inner-join `catalog_printing p` today. If one doesn't, stop. Then
  replace the Python `set_codes.code_for(row[...])` with `row['set_code']`, and drop `from . import set_codes`:
  - `collection.py:50` (the query behind `views`);
  - `holdings.py:322` (the leaf read);
  - `swap_hints.py:243` (its queries at lines 71 and 92 already select `coalesce(pd.set_id,'')`; add `set_code` beside
    it, and carry it on the edition object);
  - `social/friend_reads.py:142` (`CARD_FACTS`).

  `card_facts` feeds `loans`, `trades`, `reports`, `trade_list`, `trade_inventory` and `loan_inventory`, so those
  modules need no edit. No route moves.
- **Stays on `code_for`:**
  - `import_publication.py:89`: its edition comes from a Published Deck snapshot, not a catalog row;
  - `catalog_browse` and `deck_import`: Pokémon modules, together with search (`sets_for_code`, `DIGEST`) in
    `catalog_browse`, `collection_import_matcher`, `import_matching`, `import_aliases` and `scanner`.

  After WP-C2 **no core-bound module imports `set_codes`**, so nothing needs composing.
- **Allow-list:** remove the 4 lines `collection -> set_codes`, `holdings -> set_codes`, `social/friend_reads -> set_codes`
  and `swap_hints -> set_codes`.
- **Pin rule (intended change):** in `scripts/python_architecture_rules.py`, remove `app.collection`, `app.holdings`,
  `app.swap_hints` and `app.social.friend_reads` from `set-codes-importers` (WP-B3 rule 1). Name it in the PR as an
  intended change. `api/tests` is not touched.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):** `test_api_contract.py`, then every file matching
  `ls api/tests | grep -e collection -e holdings -e swap -e friend -e loan -e trade`, then
  `npm run verify -- --suite browser -- web/tests/social-friend-collection.spec.ts web/tests/trade-lists.spec.ts`,
  then the per-package acceptance.

### WP-B3: port the architecture pins into the boundary checker (Now, after WP-B, before WP-C1; independent opus review)
- **Owner decision (option C, 2026-10-29).** The layout and architecture assertions in five `api/tests` files become
  named checker rules. Only those assertions leave `api/tests`; every behaviour and data test stays. Split-map
  section 9 maps each old assertion to its rule.
- **Owned files:**
  - `scripts/check_python_boundaries.py` (adds the rule engine);
  - new `scripts/python_architecture_rules.py` (rule data only: names, patterns, exact lists, and the old tests'
    explanatory comments moved over);
  - new `tests/tooling/test_python_architecture_rules.py`;
  - for the retirement only: `api/tests/test_set_codes.py`, `test_import_aliases.py`, `test_price_source.py`,
    `test_social_contract.py` and `test_price_import.py`.
- **Rule conventions:**
  - Scan `api/app/**/*.py` recursively, and `scripts/**/*.py` where the old test did.
  - Name modules by dotted name (`app.social.friends`). The one exception is `import-aliases-tsv-readers`, whose old
    test listed repository paths.
  - Resolve imports with the WP-B resolver: relative and absolute imports, `import app.x` as name `*`, and
    function-level imports.
  - Copy `string_constants`, `inventory_reads`, `several_owners_reads` and the regexes from
    `api/tests/test_social_contract.py` (`:32-38`, `:39`, `:75-78`, `:297-322`) with unchanged logic.
  - The social area is every module under a package listed in `SOCIAL_PACKAGES`, which is `["app.social"]` today.
  - Each failure prints `FAILED: <rule>: <detail>`.
  - An exact list stays exact and a subset stays a subset. No rule gets an allow-list escape.
- **Rules**, with today's values:
  1. `set-codes-importers`: the modules that import `set_codes` equal `{app.catalog_browse, app.collection,
     app.collection_import_matcher, app.deck_import, app.holdings, app.import_aliases, app.import_matching,
     app.import_publication, app.scanner, app.swap_hints, app.social.friend_reads}`. The last one is new, from the
     recursive scan; the old top-level glob missed it.
  2. `format-rules-beside-evaluator`: `format_rules/imported_sets.txt` exists in the directory of the module
     `app.format_evaluator`.
  3. `import-aliases-importers`: the modules that import `import_aliases` equal `{app.collection_import_matcher,
     app.deck_import, app.import_matching}`.
  4. `import-aliases-tsv-readers`: the files under `api/app` and `scripts` whose text matches
     `['"]import_aliases\.tsv['"]` equal `{api/app/import_aliases.py}`.
  5. `price-source-client`, in the module `app.price_source`. Every assertion of `test_price_source.py:268-280` except
     line 272, as AST checks:
     - the `str` constants that start with `http:` or `https:` equal `['https://api.tcgdex.net']`;
     - there is exactly one `httpx.Client(...)` call, and its keywords include `follow_redirects=False` and
       `trust_env=False`;
     - there is at least one `json.loads` call, and every one passes `parse_float`;
     - the top-level `fetch` has the positional arguments `['card', 'may_retry']`.
  6. `tcgcsv-host`: the modules whose text contains `tcgcsv.com` (case-insensitive) are a subset of
     `{app.price_import}`.
  7. `social-inventory-readers`: the social-area modules for which `inventory_reads` is true equal
     `{app.social.friend_copies, app.social.hidden_locations}`.
  8. `social-allowed-imports`:
     - the set of social-area modules equals the map's keys;
     - each module's imports are a subset of its entry.

     The map is `ALLOWED_IMPORTS` (`test_social_contract.py:82-215`), rewritten with absolute module names:
     - `'.x'` becomes `app.social.x`;
     - `'..x'` becomes `app.x`;
     - `'.'` becomes `app.social`;
     - `'..'` becomes `app`.

     The names are unchanged.
  9. `friends-of-readers`: the modules whose whole text matches `\bfriends_of\b` equal `{app.social.friends,
     app.social.friend_copies, app.social.friend_reads}`.
  10. `several-owners-readers`: the modules for which `several_owners_reads` is true are a subset of
      `{app.social.friend_copies}`.
  11. `trade-steps-no-friend-ids`: `app.trade_inventory` imports no name `friend_ids`.
  12. `social-area-complete` (new): every package directory named `social` under `api/app` is in `SOCIAL_PACKAGES`.
- **Steps:**
  1. Write the rules and the engine. Add a `--show-pins` flag that prints each rule's found set.
  2. **Agreement on today's tree.** Run `--show-pins`, then compare each set with the old assertion's expected value:
     - for rules 1, 3 and 6, compare the top-level part of the set;
     - for the others, compare the whole set.

     The only allowed difference is the extra `app.social.friend_reads` in rule 1. Any other difference is a stop
     condition. Put the comparison in the PR body.
  3. **Tooling tests** in `tests/tooling/test_python_architecture_rules.py`. Copy the structure of WP-B's
     `tests/tooling/test_python_boundaries.py` (temporary fixture trees).
     - For each rule, one clean tree passes, and one tree with a planted violation fails with that rule's name. For
       example:
       - an extra `from . import set_codes` in an export module fails rule 1;
       - a nested `games/pokemon/x.py` naming `tcgcsv.com` fails rule 6, which the old top-level glob would miss;
       - a new `app/core/social/x.py` fails rule 12.
     - Also run the inputs of `test_social_contract.py:525-546`, `:548-556` (translated to absolute names) and
       `:596-609` against the checker's copies of the helpers.
  4. **Retire the old assertions** in the same PR. Delete exactly these lines and nothing else:
     - `test_set_codes.py:68-79`. Line 67, `assert LiveRulesV1.SET_CODES == {}`, stays.
     - `test_import_aliases.py:65-73`. Line 64 stays.
     - `test_price_source.py:268-271` and `:273-280`. Line 272, the `ORIGIN` assertion, stays.
     - `test_price_import.py:486-489`, the whole test `test_only_price_import_talks_to_tcgcsv`, and the blank lines
       before it.
     - In `test_social_contract.py`:
       - the tests at `:562`, `:567`, `:574`, `:590` and `:636`;
       - the constants `FRIENDS_OF_READERS` (`:27-28`, with its comment), `READERS` (`:40-41`) and
         `ALLOWED_IMPORTS` (its comment and `:82-215`).

       Keep every other test and helper, including `sources()` and the guard self-tests.
  5. Rewrite `test_set_codes.py:17` to read
     `Path(format_evaluator.__file__).parent / "format_rules/imported_sets.txt"`, and add
     `from app import format_evaluator`. This line feeds a data test, so it is rewritten rather than removed; rule 2
     pins the layout fact it relied on.
  6. Leave unused imports and module constants (`APP`, `ROOT`, `re`, `ast`) in place.
  7. In the PR body, list every deleted line with the rule that replaces it.
- **Later packages:** a package that moves a module named in a rule updates `python_architecture_rules.py` in the same
  PR, and lists each change.
  - A **rename** of a moved module is the only change allowed to an existing entry.
  - A **removal** is allowed only where this brief names it as intended: WP-C2 removes `app.collection`,
    `app.holdings`, `app.swap_hints` and `app.social.friend_reads` from rule 1.
  - **Adding** a module or name to any list is an expectation change: stop and escalate.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):**
  - `npm run guardrails`, including the new tooling tests;
  - `npm run verify -- --suite api -- api/tests/test_set_codes.py api/tests/test_import_aliases.py
    api/tests/test_price_source.py api/tests/test_social_contract.py api/tests/test_price_import.py`.

  Compare the counts with the baseline:
  - `test_price_import` has 1 fewer test;
  - `test_social_contract` has 5 fewer;
  - the other three files keep their counts.

  Then the per-package acceptance.

### WP-B4: stored-response replay fixtures (lands with WP-B)
- **Owned files:** new `api/tests/test_replay_fixtures.py` and `api/tests/replay_fixtures/*.json`.
- **Why:** these tests already replay legacy stored responses: `test_target_format.py:173` (pre-045, `'standard'`),
  `test_deck_list_display.py:155` (missing display fields), `test_deck_list_changes.py:203` and
  `test_deck_list_printing.py:117`. None pins a response *as today's code stores it*, so drift in `keep_response` or
  `replayed` after a split could pass unnoticed.
- **Steps:** on today's code, capture one stored `location_command.response` per deck command:
  - add, change and remove a line;
  - change the list;
  - set the Target Format;
  - set the cover;
  - add a Printing.

  Do the same for each publication command stored in `publication_command` (publish, republish, revoke, visibility),
  and write them as JSON fixtures. The test inserts each fixture under a fresh idempotency key and replays it through
  its route, then asserts that the response equals the fixture byte for byte (`json.dumps(sort_keys=True)`).
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):** `npm run verify -- --suite api -- api/tests/test_replay_fixtures.py`, on today's code, before WP-I1.

### WP-B2: characterization tests (lands with WP-B)
- **Owned files:** new `api/tests/test_edition_replacements_route.py` and new `api/tests/test_characterization_now.py`.
- **Why:** the static route census (split-map section 8) found every one of the 88 routes in the Now groups referenced
  by a test, except `GET /api/catalog/edition-replacements` (`catalog_reconciliation`). Playwright reaches that route,
  but no API test does.
- **Steps:** add one test that seeds a replacement, the way `api/tests/test_catalog_reconciliation.py` seeds them, and
  pins the full JSON response of `GET /api/catalog/edition-replacements` for the owner and for a non-owner. Copy the
  structure of `test_catalog_reconciliation.py`. It must pass on today's code before WP-I1 starts.
- **Group (a) characterization tests** (split-map section 8). The coverage run (fast tier: 95.3% of statements and
  90.7% of branches over the 76 Now files) left these branches unreached in code that composition changes. Each pins
  behaviour the planned change could break. They go in `test_characterization_now.py`, and each must pass on today's
  code before WP-C1.
  1. `test_leaf_holdings_pages_by_quantity`:
     - **Target:** `holdings.leaf_holdings`, lines 301-304, the quantity-order cursor.
     - **Behaviour pinned:** with more than 48 holdings in one Storage Leaf and `sort=quantity`, page 2 (fetched with
       `next_cursor`) returns the exact rows, `set_code` values and `next_cursor` that it returns today.
     - **Route:** `GET` on the `holdings.leaf_holdings` route (path in `api/tests/api_contract/routes.json`).
     - **Copy:** `api/tests/test_holdings.py`.
     - **Why:** WP-C2 rewrites this f-string query (it adds the set code view join), and the cursor's `after`
       clause is spliced into it.
  2. `test_discovery_refuses_an_unreadable_listing`:
     - **Target:** `discovery.listed_snapshots`, line 141.
     - **Behaviour pinned:** a manifest record whose visibility is neither `listed` nor `unlisted` makes
       `GET /api/public/discovery` answer 503 `PUBLIC_PROJECTION_UNAVAILABLE`, with `HEADERS`.
     - **Copy:** `api/tests/test_discovery.py`.
     - **Why:** WP-D2 moves `listed_snapshots` to core and passes the parser in (`parse`).
  3. `test_visibility_change_retries_an_unreadable_snapshot`:
     - **Target:** `publications.mutate`, lines 305-306 and 337.
     - **Behaviour pinned:** when the stored snapshot fails `PublicSnapshot` validation, a visibility command writes
       nothing and answers what `ProjectionUnavailable` maps to today.
     - **Route:** `PATCH /api/decks/{deck_id}/publication/visibility`.
     - **Copy:** `api/tests/test_publications.py`.
     - **Why:** WP-D2 moves `mutate` to core, and the Pokémon snapshot model becomes the injected `snapshot_model`.
  4. `test_legacy_replay_without_format_checks`:
     - **Target:** `decks.replayed`, the branch where the stored response has neither `target_format` nor
       `format_checks`.
     - **Behaviour pinned:** the replay answers `target_format: 'standard'` and `format_checks: null`, with the line
       display filled in.
     - **Route:** a replayed `POST /api/decks/{deck_id}/deck-list/lines`.
     - **Copy:** `api/tests/test_target_format.py:173`.
     - **Why:** WP-D1 turns the `'standard'` fix-up into the injected `fixup`.

  The worker takes the expected values from today's responses. If a test can't pass on today's code, stop.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):** `npm run verify -- --suite api -- api/tests/test_edition_replacements_route.py`.

### WP-I1: move the Pokémon-only files (Now)
- **Owned files:**
  - `git mv` of the 58 files that split-map section 1 tags `pokemon`, into `api/app/games/pokemon/<group>/`;
  - new root shims `api/app/catalog_import.py` and `api/app/catalog_refresh.py`;
  - importers: `api/app/**`, `api/tests/*.py` (import lines and patch strings only), the 9 scripts and 5 deploy lines in
    split-map section 6, `scripts/check_guardrails.py` and `tests/tooling/test_guardrails.py` (the `scanner.py` path
    constant only);
  - `scripts/python_module_owners.txt`, `scripts/python_boundary_allowlist.txt` and
    `scripts/python_architecture_rules.py` (renames only).
- **Steps:**
  1. Move the files. Each data file moves beside its module (`format_rules/` beside `format_evaluator`).
  2. Rewrite imports: absolute `from app.<x> import` for modules still at the top level; relative imports within
     `games/pokemon`.
  3. Write the shims, for example `app/catalog_refresh.py`:
     `from app.games.pokemon.catalog.catalog_refresh import main` and
     `if __name__ == "__main__": raise SystemExit(main())`. First read how the real module runs as `__main__`, and
     mirror it exactly. If it doesn't run through a function, stop.
  4. Update the `importlib` literals in `price_runner.py:114,119,620` to the new dotted paths. `price_runner` stays where
     it is until WP-S2.
  5. Rename the moved modules in `scripts/python_architecture_rules.py`:
     - rules 1, 3, 5 and 6 get the new dotted names;
     - rule 4 gets the new repository path of `import_aliases.py`;
     - rule 8 needs no change: no social module imports a file that WP-I1 moves (`social/friend_reads` stops
       importing `set_codes` in WP-C2).

     Renames only (WP-B3, "Later packages"). List each one in the PR. Any test failure in the five files from WP-B3 is
     a stop condition.
- **Slow tests (coverage gap, split-map section 8):** `catalog_import` and much of `price_runner` are reached only by
  `slow` tests, which `--fast` skips. This package's acceptance therefore also requires, without `--fast`:
  `TMPDIR=<worktree>/.scratch/tmp npm run verify -- --suite api -- api/tests/test_catalog_process.py
  api/tests/test_catalog_outbox.py api/tests/test_price_runner.py api/tests/test_price_fixture.py`, with its counts
  quoted.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):** `.venv/bin/python -m compileall -q api scripts`, then `npm run guardrails`, then `npm run check` (no
  client diff), then `test_api_contract.py`. Then the per-package acceptance: the default CI checks, the touched
  `api/tests` files, and an `integration=sharded` run.

### WP-F: the Pokémon app module (Now)
- **Owned files:** `api/app/main.py`, `api/app/games/pokemon/app.py` (new), `api/app/games/__init__.py` and
  `api/app/games/pokemon/__init__.py` (empty).
- **Steps:**
  1. Move the `ROUTERS` tuple and the lifespan hook list into `games/pokemon/app.py`, in the same order, as D12 says.
  2. `main.py` imports `ROUTERS` and `LIFESPAN_HOOKS` and mounts them.
  3. No `GAME` setting.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):** `test_api_contract.py` passes, so the route order is unchanged. Then the lifespan tests
  (`test_format_standing.py`, `test_rule_rollout.py` and `test_signup_capacity.py`, which use `with TestClient(app)`),
  then the per-package acceptance.

### WP-S1: MarketplacePrices split (Now)
- **Owned files:** `api/app/{deck_cost,want_list_cost,trade_value,published_cost,deck_list_printing}.py` (moved or
  split), new `api/app/core/prices/cost.py`, new `api/app/core/decks/printing.py`, the matching new
  `api/app/games/pokemon/{decks,prices,publications,social}/*.py`, the `games/pokemon/app.py` import lines, and the
  importers' import lines (`deck_import`, `discovery`, `import_allocation`, `api/tests`).
- **Steps:** follow split-map section 1A, the rows for those five files.
  - `core/prices/cost.py` gets, from `deck_cost`:
    - the functions `summarize`, `_micros`, `_exact` and `_display`;
    - the constants `_INCOMPLETE`, `_FALLBACK` and `_MICRO`;
    - the models `DeckCostFigures` and `DeckCost`;
    - the types `CostStatus` and `IncompleteReason` (wherever they are defined today).
  - Each route module moves whole to `games/pokemon/…`. It keeps its router, models, `_uncaptured` and its route
    function, and calls core `summarize` with the Pokémon price reads (`prices.*`).
  - `deck_list_printing`: `choose_edition` moves to `core/decks/printing.py`, but only if it is pure given its inputs.
    Otherwise stop. `AVAILABLE_EDITIONS` (catalog SQL), `available_editions`, the route and its models move to
    `games/pokemon/decks/printing.py`. `store_printing_result` goes to core if it touches only `decks` helpers.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):** `test_api_contract.py`, then `npm run verify -- --suite api -- api/tests/test_deck_cost.py api/tests/test_want_list_cost.py api/tests/test_trade_value.py api/tests/test_published_cost.py api/tests/test_deck_list_printing.py`.
  If a name doesn't exist, use `ls api/tests | grep -e cost -e value -e printing`. Then the per-package acceptance.

### WP-S2: QuoteSource and ArtSources (Now)
- **Owned files:** `api/app/{price_runner,quote_contract,art_store,art_urls}.py` (split), new
  `api/app/core/{prices/runner.py,prices/quote_contract.py,art/store.py,art/urls.py}`, new
  `api/app/games/pokemon/{prices/runner_entry.py,prices/quote_values.py,art/hosts.py,art/route.py,art/urls.py}`, the
  root shim `api/app/price_runner.py`, `api/app/decks.py` (the `warm_deck` call site only), the
  `games/pokemon/app.py` import and hook lines, `scripts/check_guardrails.py` and `tests/tooling/test_guardrails.py`
  (only the `WEBP_SUFFIX_MODULES` and art path constants), and importers' import lines.
- **Steps:**
  1. **Quote values.** The Pokémon literals are exactly `quote_contract.py:531` and `:569` (`'USD'`, `'tcgdex'`) and
     `price_runner.py:109`.
     - Those functions gain keyword-only `source: str, currency: str` parameters, with no default.
     - `games/pokemon/prices/quote_values.py` holds `SOURCE = 'tcgdex'` and `CURRENCY = 'USD'`.
     - Every caller passes them. If a caller is a core module more than two calls away from a Pokémon caller, stop and
       report; do not thread further.
  2. **Runner.** `core/prices/runner.py` holds today's runner, with `card_source` and `record_rules` modules and the
     quote values passed into `main()` and `worker_main()`. It replaces the `importlib` literals.
     `games/pokemon/prices/runner_entry.py` binds `app.games.pokemon.prices.price_source`, `tcgdex_record` and the
     quote values. The root shim `app/price_runner.py` runs the entry when started with `-m`.
     The CI connect guard (`price_fixture.py:232`) arms on the lookup of `app.price_runner`. The shim must be the first
     module the runner imports, before any PostgreSQL code; check this with `api/tests/test_price_fixture.py`.
  3. **Art.**
     - `core/art/store.py` takes the allowed host and the linked-art pattern as keyword parameters, through
       `ArtFetcher(...)`, `host_allowed`, `upstream_target` and `_linked`.
     - The `art` route and the module-level fetcher move to `games/pokemon/art/route.py`. `art/hosts.py` holds
       `ALLOWED_HOST` and `LINKED_ART`.
     - `start_warmups` and `warm_deck` take the hosts. `decks.py`'s `warm_deck` call passes the Pokémon hosts. That is
       an allow-listed edge until DeckChecks lands.
     - `art_urls`: `tcgdex_source` and `large_direct_url` go to `games/pokemon/art/urls.py`. `SIZES`, `route_address`,
       `art_version` and `art_url` go to `core/art/urls.py`. If `art_url` embeds the TCGdex rule, stop.
- **Slow tests (coverage gap, split-map section 8):** the fast tier reaches about 67% of `price_runner`. Acceptance
  also requires, without `--fast`: `TMPDIR=<worktree>/.scratch/tmp npm run verify -- --suite api --
  api/tests/test_price_runner.py api/tests/test_price_fixture.py`, with its counts quoted. Some of these tests SIGKILL
  their runners, so coverage cannot be measured there; passing is the bar.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):** `test_api_contract.py`. Then `npm run verify -- --suite api -- api/tests/test_price_fixture.py api/tests/test_art_store.py`,
  plus every file matching `ls api/tests | grep -e price -e art -e quote`. Then `npm run verify -- --suite auth`, which
  runs the `price-runners` harness, unedited. Then the per-package acceptance.

### WP-S3: CollectionImport and the deck-import group (Now, after S1)
- **Owned files:** `api/app/{collection_import,scanner_save,import_match_core,import_owned,import_allocation,import_publication,import_replace,missing_cards}.py`,
  new `api/app/core/imports/collection_draft.py`, the matching `games/pokemon/imports/*` and
  `games/pokemon/{scanner,catalog}/*`, `games/pokemon/app.py`, and importers' import lines.
- **Steps:**
  1. The five `import_*` helpers, `scanner_save` and `missing_cards` move wholly (split-map section 1A).
  2. Split `collection_import` per its 1A row:
     - **core** (`core/imports/collection_draft.py`): `storage_leaf`; the row-state SQL constants (`OPEN_DRAFT`,
       `READY_ROW`, `NEEDS_YOU_ROW`, `FINISH_UNKNOWN_ROW`, `SKIPPED_ROW`, `LEFT_OUT_ROW`, `INCLUDED_ROW`, `BY_NAME_ROW`,
       `SWEEP_LIMIT`, `MAX_CHANGES`, `MAX_CHANGE_ROWS`); the counts and grouping helpers; and every model whose fields
       are game-free;
     - **Pokémon** (`games/pokemon/imports/collection_import.py`): the router and its routes, and the
       reader → matcher → finish calls.
  3. If a function mixes both halves, move it whole to the Pokémon side and list it in the report.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):** `test_api_contract.py`, then every file matching `ls api/tests | grep -e collection_import -e import_ -e scanner -e missing`,
  then the per-package acceptance.

### WP-D1: deck routes by composition (Now, after WP-S3; independent opus review)
- **Owned files:**
  - `api/app/{decks,deck_ownership,deck_list_display,trade_wants}.py` (split or moved);
  - new `api/app/core/decks/{store,index,ownership,loans,contents}.py`, `api/app/core/trading/trade_wants.py`,
    `api/app/games/pokemon/decks/{routes,models,line_display,checks}.py`, `api/app/games/pokemon/trading/trade_wants.py`
    (not under `social/`: WP-B3 rule 12 would treat them as social modules);
  - `scripts/python_architecture_rules.py` (rule 8 renames for `social/trade_matches`, which imports `trade_wants`);
  - the callers of `construction_checks` and `deck_format_checks` in `games/pokemon/formats/` (import lines only);
  - `games/pokemon/app.py`, the allow-list, and importers' import lines (`deck_pick_list`, `trade_inventory`,
    `want_list`, `deck_list_printing`, `import_replace`, `import_owned`, `api/tests`).
- **Steps:** follow split-map section 1B for `decks.py`, `deck_ownership.py`, `deck_list_display.py` and `trade_wants`,
  symbol by symbol. Then:
  1. Define `DeckListLineBase(edition_id, quantity, in_deck)` and `SurplusHoldingBase(edition_id, quantity, version)`
     in core. The Pokémon models inherit from them.
  2. Before writing any model, compare its OpenAPI component (in `api/tests/api_contract/openapi.json`) field by field
     with the planned class. Any order mismatch means the Pokémon module defines the whole model, with no inheritance.
  3. Every core function that took display, model or check pieces now takes them keyword-only with no default:
     `display`, `line`, `holding`, `fixup`. `cover_candidates` is already game-free and keeps its signature. The
     Pokémon `index_summaries` applies the "a Pokémon first" cover key (`decks.py:366`) after it, over core
     `index_counts` (split-map 1B).
  4. The Pokémon routes keep their function names.
  5. Pass the art hosts into `warm_deck`.
- **Tests:** none new beyond WP-B4. `test_api_contract.py`, `npm run check:client` (no diff) and
  `test_replay_fixtures.py` must pass unchanged.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):**
  - every file matching `ls api/tests | grep -e deck -e target_format -e surplus -e ownership -e trade_want -e want_list`;
  - then `npm run verify -- --suite browser -- web/tests/deck-builder.spec.ts` and the other `deck-*` specs;
  - then the per-package acceptance, including an `integration=sharded` run.

### WP-D2: publishing and discovery by composition (Now, after WP-D1; independent opus review)
- **Owned files:**
  - `api/app/{publications,discovery}.py` (split), and `api/app/public_deck.py` (moved whole);
  - new `api/app/core/publications/{publish,discovery}.py`,
    `api/app/games/pokemon/publications/{routes,models,discovery,public_deck}.py`;
  - `scripts/python_architecture_rules.py` (rule 8 renames for `social/friends` and `social/profile`, which import
    `TOKEN` and `PUBLIC_HEADERS`);
  - import lines in `social/friends.py`, `social/profile.py`, `import_publication`, the `published_*` modules,
    `games/pokemon/app.py`, `api/tests`, and the allow-list.
- **Steps:** follow split-map section 1B for `publications.py`, `discovery.py` and `public_deck`. Core keeps:
  - publishing needs a passing check: `require_legal(*, checks)`;
  - snapshot storage, mutate and drain, with `snapshot` (the builder) and `snapshot_model` (`PublicSnapshot`, which
    the visibility path validates against) passed in;
  - listing and paging.

  Pokémon supplies the check result, the snapshot builder and its models, the Format filter (`target_status`,
  `confirm`), `featured`, the cost, and `CODE_SHA256`. Update `CODE_SHA256`'s file list to the new paths of the modules
  it hashes today.
- **Verify (run every command with `TMPDIR=<worktree>/.scratch/tmp`; host note, section 4):**
  - `test_api_contract.py`, `check:client` and `test_replay_fixtures.py`;
  - every file matching `ls api/tests | grep -e publi -e discover -e sitemap -e public_deck`;
  - `web/tests/publications.spec.ts`, `web/tests/published-deck.spec.ts` and the discover specs;
  - then the per-package acceptance, including an `integration=sharded` run.

### WP-K: docs (technical-writer, Now)
- **Content:** the reworded ADR for the core/game split, by composition, with D11 to D13. The identity design is left
  to the Later plan (split-map section 5 recommends Design B). Update the `docs/agents/verification.md` lines for the
  boundary check.

## 5. Out of scope

- Anything under `web/`, including `web/tests` and the generated clients. **The web split is deferred future work:**
  moving web code into `web/src/core` and `web/src/games/pokemon`, per-game client base paths, per-game lazy bundles,
  game-first routing and a TypeScript boundary check all wait for a later round. That round starts from
  `/tmp/prizecheck-split/web.md`.
- Riftbound code, gateway routing of `/api/riftbound/*`, `RIFTBOUND_ENABLED`, the game switcher, and cross-backend
  Handle propagation. For the propagation: a later phase adds an auth-database change log that backends pull; this
  refactor's hook is `sync_mirror`.
- Account deletion (D7). Dropping the legacy identity tables from the Pokémon database. Removing core SQL references to
  catalog tables, and the Pokémon literals in core (D11).
- Any new pokemon or core migration other than WP-C1's, any change to the signed message, any change to an API path or response shape, and
  any reorganisation of `api/tests` beyond import lines.

## 6. Stop conditions

Stop and report; do not improvise, when:

1. Any existing test assertion would need to change, or a test fails in the co-located topology for a reason other than
   an import path.
2. `test_api_contract.py`, or `npm run check:client`, shows any difference.
3. A symbol, line range or file named here does not exist, or the code contradicts a fact in 3.1.
4. A query in `auth/src` names a game table (WP-C), or a function kept in the core baseline names a game table (WP-H).
5. An import cycle appears when core modules resolve `current()` at import time (WP-F, WP-G).
6. A path built from the repository root names a moved directory, and changing it would affect deploy behaviour beyond
   the path string (WP-I).
7. Any verify command fails for a reason this brief did not anticipate, including a flake that recurs on a rerun.
8. A step requires touching a file outside the package's owned list.
9. WP-B3: a ported rule disagrees with the old assertion on today's tree, other than the extra
   `app.social.friend_reads` in `set-codes-importers`.
10. Any package would add a module or a name to a WP-B3 rule list, or place a module that is not in `app/social/` today
    into a folder named `social`.

## 7. Risks and review notes

- **Security (independent review required for WP-C, WP-D and WP-E):**
  - The API gains a connection into the auth database. Least privilege rests on the `prizecheck_identity` grants (D2).
    Check that the role cannot read `"user"`, `session`, `account` or `verification`, and cannot write `owner_binding`.
  - Check that no fallback lets production run co-located: the deploy refuses it.
  - The cutover copies live sessions. The script must never log row contents.
- **Data, cutover:**
  - The copy runs with both services stopped. `copy-back` is the only way to keep sign-ins made after the cutover
    through a rollback.
  - Confirm that `copy` refuses a non-empty target, so a second deploy can never overwrite live auth data with stale
    game data.
- **Two-database writes:** a Handle claim commits in the auth database before the game transaction. The idempotent retry
  repairs the mirror (3.3). With no retry, the caller's next `read_profile` repairs it. Other collectors see the stale
  Handle until then. A durable identity change log, pulled by each backend, is the multi-backend answer and belongs to
  a later phase.
- **Coverage gap:** the frozen suites only run co-located. The split code paths rely on the WP-C and WP-D tests and on
  the SQL rule. Reviewers should check that the SQL rule's regex catches the forms used in `api/app`.
- **Import-time game resolution:** `current()` at import time ties module import to `GAME`. Scripts that import core
  modules inherit the default `pokemon`. The price runner subprocesses inherit `GAME` from the environment.
- **Deferred coupling:** core SQL still names Pokémon catalog tables and views (`catalog_edition`,
  `catalog_card_attribute`, `catalog_evolution_root` and others). Core still has the literals `'tcgdex'` (in
  `quote_contract`) and `ALLOWED_HOST` (in `art_store`). A second game must either provide compatible catalog relations
  or a later phase must put them behind a contract. The orchestrator should make sure the owner knows this, because it
  narrows what "game-agnostic core" means after this refactor.
- **Long-lived branch:** WP-I and WP-J touch most files under `api/` and many under `api/tests`. Merge `dev` right before
  each, and land each in one sitting to keep conflicts small.

### Owner questions: all answered (2026-10-29)

Q1 to Q7 belong to the identity packages, which are Later and will be re-planned for Design B (split-map section 5).
They don't block the Now work, and they are recorded here for that re-plan.

- **Q1. Display Name:** the default moves it to the auth database. Reverting is cheap: `SplitStore.set_display_name`
  writes the mirror only, and `sync_mirror` stops copying `display_name`.
- **Q2. Owner flag:** the singleton `owner_binding` moves to the auth database and the API reads it there. It is not a
  signed flag, which deviates from the spec's "signed by the gateway". The reason is the frozen API test signing
  helpers. A signed claim can be added later (D5).
- **Q3. Handle claims:** the API runs them against the auth database. They do not go through the gateway, which
  deviates from the spec.
- **Q4. Topology:** test harnesses run co-located and only production runs split. Is that acceptable?
- **Q5. Legacy tables:** when should they be dropped from the Pokémon database, and after how long a soak?
- **Q6. Hosting:** the auth database is on the same PostgreSQL server as the Pokémon database, not in its own
  container. Is that acceptable?
- **Q7. Narrower core:** the core is game-agnostic in imports only; its SQL is not (D11). Is that acceptable for this
  refactor?
- **Q8. Architecture-pin tests: decided (option C).** Both readings were confirmed by the owner:
  - `test_set_codes.py:17` finds its file through `format_evaluator` (WP-B3);
  - the six other path-keyed social scans stay for now, and a Later step ports them before `social/` moves.
- **Q9. Set code fallback: decided (option A, read time).** A view, `catalog_printing_set_code`, holds the fallback
  (WP-C1). Import and refresh never touch the table.
- **Q10. Missing cards: decided.** It moves whole in WP-S3. Later: revisit which parts could become core.
- **Q11. Coverage measurement: done.** It is in `/tmp/prizecheck-split/coverage.md`. The classification and the WP-B2
  group (a) tests are in split-map section 8.
