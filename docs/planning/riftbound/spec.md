# Spec — Riftbound side

**Status:** drafted 2026-10-29 from the owner's decisions that day. The architecture is
[ADR 0022](../../adr/0022-separate-game-backends-with-shared-sign-in.md). Every open question is listed under
[Open Questions](#open-questions). No tickets are filed yet.

**Branch:** all Riftbound work, including this spec and ADR 0022, lives on the `riftbound` branch, cut from `dev`. Nothing
merges into `dev` until the owner decides to. See [Branch and merge](#branch-and-merge).

## Problem Statement

Collectors who play Riftbound, the League of Legends trading card game, have the same problem PrizeCheck solves for
Pokémon: knowing which copies they own and where each one is, so they can sleeve up a deck, lend or borrow cards and
trade in person. Much of what PrizeCheck has built doesn't depend on the game, but the catalog, deck rules, prices,
imports, exports and scanner assume Pokémon throughout.

The Riftbound side must also be removable at short notice without disturbing the Pokémon side, because its catalog data
and card images come from third parties whose terms may change.

## Solution

PrizeCheck offers two sides, Pokémon and Riftbound, that read as separate sites behind one sign-in. A collector signs in
once and moves between them with a game switcher. Each side has its own Collection, Locations, Decks, Friends, Loans,
Trades and Published Decks. Nothing crosses between the sides.

Behind that, each game runs as its own backend container with its own database, built from one codebase that is split
into shared core modules and per-game modules (ADR 0022). The auth gateway owns sign-in and routes each request to the
right backend. One setting turns the Riftbound side off.

## User Stories

### Switching sides

1. As a collector, I sign in once and can open either side without signing in again.
2. As a collector, I switch between Pokémon and Riftbound from the shell, and land on the same page on the other side
   when it exists there, or on its Collection when it doesn't.
3. As a collector, links I share, such as a Published Deck, open on the side they belong to.
4. As a collector who uses only one side, I am not asked to set anything up for the other.

### Riftbound collection (first release)

5. As a collector, I search and browse the Riftbound catalog by name, set, collector number, domain and card type.
6. As a collector, I record Riftbound copies by Card Edition, including alternate art, overnumbered, signature and
   foil Editions where the catalog can tell them apart. Where it can't, the copy is an Unspecified Variant.
7. As a collector, I organise Riftbound copies into Locations, move them, remove them and undo, as on the Pokémon side.
8. As a collector, I see estimated market prices on Riftbound copies where they exist.
9. As a collector, I add Friends, lend and borrow, and trade Riftbound cards, exactly as on the Pokémon side.

### Riftbound decks (second release)

10. As a collector, I build a Riftbound Deck with a Legend, a Chosen Champion, a main deck, a rune deck, Battlefields and
    a sideboard, and see each part separately.
11. As a collector, I get an advisory format check against Riftbound's rules and ban list. It never blocks editing or
    moving cards, as on the Pokémon side.
12. As a collector, I see my Want List and Deck Pick List for Riftbound Decks.
13. As a collector, I publish a Riftbound Deck that passes its format check.
14. As a collector, I import a Riftbound decklist and export a Deck in the formats Riftbound players use.

### Owner and operations

15. As the owner, I turn the Riftbound side off with one setting. Its routes answer 410, the switcher drops it, its
    pages show an unavailable notice, and the Pokémon side is unaffected.
16. As the owner, I can then stop its container and keep or delete its data and backups.
17. As the owner, I see each side's database, jobs and health separately in operations.
18. As the owner, I import and review the Riftbound catalog and its marketplace mappings with the same review screens as
    the Pokémon side.

## Implementation Decisions

### Topology (ADR 0022)

- **Services.** The edge serves the web app and sends `/api/*` to the auth gateway. The gateway signs the caller and
  forwards `/api/riftbound/*` to the Riftbound API and every other `/api/*` to the Pokémon API. Existing Pokémon paths
  don't change.
- **Databases.** There are three: auth, Pokémon and Riftbound. The auth database holds the Better Auth tables (migration
  002), the sign-up and rate-limit tables, and `owner_binding`. Each game database holds core tables plus its game's
  tables. No API table has a foreign key to the sign-in tables today (checked 2026-10-29), so moving them changes no
  foreign keys.
- **Signature.** The gateway signs the path the backend receives. If it strips `/riftbound`, it signs the stripped path,
  and `api/app/identity.py` stays unchanged.
- **Owner.** The owner binding moves to the auth database. Each backend asks the gateway-signed identity whether the
  caller is the owner. How that reaches the backend (a signed claim or a gateway read) is decided in Phase 1.
- **Account deletion.** The gateway deletes the account and calls each enabled backend's deletion route. A disabled
  backend's data is deleted when it is re-enabled or wiped.

### Code layout

The target layout is below. Phase 2 picks the exact paths.

- `api/app/core/`: Locations, Holdings, moves, removal and undo, the Collection read, Want List mechanics, Deck and Deck
  List storage, social, Loans, Trades, Published Deck mechanics, the price runner and cache, the art store, operations
  and idempotency.
- `api/app/games/pokemon/`: the TCGdex catalog, card attributes, Card Identity and Reprint Groups, the format evaluator
  and rules, decklist text, Collection Import matching and aliases, TCG Live export, the tcgcsv category 3 price import
  and binding, and scanner index inputs.
- `api/app/games/riftbound/`: the same seams for Riftbound.
- `web/src/core/`, `web/src/games/pokemon/`, `web/src/games/riftbound/`: the same split for the web app. The shell, kit,
  Locations, social, Loans and Trades are core.

Core reaches a game module only through interfaces. The list starts with:

- **Catalog source:** enumerate sets, fetch cards, and map them to Card Printings and Card Editions.
- **Card attributes:** the facets search and browse filter on, and how a card displays.
- **Deck shape and format check:** a Deck List's parts, the Formats, and the advisory evaluator.
- **Decklist text:** parse and print.
- **Collection Import readers:** the other trackers' export files.
- **Exports:** decklist text, deck codes, and TCGplayer Mass Entry.
- **Marketplace price mapping:** the TCGplayer category, and how products bind to Card Editions.
- **Scanner inputs:** the reference art, card layout and number parser.

The container's `GAME` setting picks the module at start-up. Boundary checks in `scripts/ci.sh` fail when core imports
a game module or a game imports another. They use `import-linter` for Python and an ESLint boundaries rule for
TypeScript.

### Migrations

- `migrations/core/` and `migrations/<game>/` are applied by `scripts/migrate.py` with a game setting.
- The Pokémon database keeps its applied history, and the existing files are attributed to a track without being
  re-run.
- A Riftbound database starts from a core baseline: one migration that creates today's core tables as they now stand,
  then the core track from there.
- New core migrations must apply to both databases. CI applies core plus each game's track to empty databases.

### Web

- The game is the first path segment for Riftbound (`/riftbound/collection`). Pokémon keeps its current paths.
  `web/src/shell/routes.ts` and `canonicalPath` resolve the game first.
- The generated clients take a base path per game. Pages shared by both games use the current game's base path.
- Each game is its own lazily loaded bundle. `scripts/check_bundle_boundary.py` gains a rule that no Riftbound module is
  in the Pokémon or core graph.
- `--tile-aspect` stays 245/342 (Riftbound cards are expected to be the same 63 × 88 mm size; unverified).
  Battlefields are landscape and need a landscape tile.
- The game switcher shows only enabled games. The gateway tells the web app which games are enabled.

### Switching Riftbound off

- `RIFTBOUND_ENABLED` is read by the gateway. Off means:
  - `/api/riftbound/*` answers 410.
  - The enabled-games read omits Riftbound.
  - `/riftbound/*` pages show an unavailable notice.
- The Riftbound container can then be stopped. Its backups follow the owner's choice to keep or delete them.
- Switching back on needs no migration step.

### Third-party assets

- No Riftbound card images, catalog dumps or scanner reference images are committed. Tests that need them fetch them
  from private storage in CI, or use generated stand-ins.
- The art store's allowed source hosts are per game.
- Riftbound pages carry the credit the data and asset terms require, as the Published Deck page carries its notice
  today.

### Riftbound domain

The Riftbound catalog and rules below come from secondary sources gathered on 2026-10-29. Each needs confirming against
the official rules and the chosen data source before it is built.

- **Catalog:**
  - Sets so far: Origins, Proving Grounds, Spiritforged, Unleashed, Vendetta and Radiance, plus promos.
  - Cards carry a set code and a collector number. Alternate art, overnumbered and signature cards are distinct
    printings or Editions, and foil handling is unconfirmed.
- **Deck shape:**
  - 1 Legend and 1 Chosen Champion that shares a tag with the Legend.
  - A 40-card main deck that includes the Champion, with at most 3 copies of a card.
  - A 12-card rune deck and 3 Battlefields.
  - A sideboard of 8 or 10 cards (unconfirmed).
  - Main and rune cards must match the Legend's domains.
- **Formats:** Standard Constructed and 2v2 Constructed, each with a ban list. No rotation is planned before 2028.
- **Prices:** tcgcsv carries Riftbound as TCGplayer category 89. Alternate art is its own product.
- **Terms:**
  - `CONTEXT.md` gains Riftbound meanings for Card Identity, Format and Deck List parts before Phase 7.
  - The Pokémon-only terms (Trainer Type, Reprint Group) stay Pokémon's.

## Phases

Each phase leaves both sides working. Phases 1 to 4 change no collector-facing behaviour on the Pokémon side.

| # | Phase | Main work | Done when |
|---|---|---|---|
| 0 | Decisions | Answer the open questions: data source, image use, the Riftbound side's name, private fixture storage. | Each answered in this spec. |
| 1 | Auth database | Move the sign-in tables, the sign-up and rate-limit tables and `owner_binding` to their own database. Decide how the owner check reaches backends. | Sign-in, sign-up gate, owner screens and account deletion pass against the split databases on dev. |
| 2 | Backend core/game split | Move Pokémon code behind the interfaces into `games/pokemon`. Add `GAME`, import boundary checks, and the migration tracks with a core baseline. | The full API and Playwright suites pass unchanged. The boundary check passes. A core-only database migrates from empty. |
| 3 | Web core/game split | Move Pokémon-specific web code into `games/pokemon`. Add per-game client base paths, game-first routing and the switcher behind a flag. | The full web suite passes. The bundle check proves no game leaks into core. |
| 4 | Second deploy and kill switch | Gateway routing, `RIFTBOUND_ENABLED`, the enabled-games read, compose services, backups and operations. A Riftbound API with core only and an empty catalog. | On dev, the switcher reaches an empty Riftbound side. Switching it off answers 410 and hides it. Pokémon is unaffected. |
| 5 | Riftbound catalog, art and prices | Catalog source and owner import review, card attributes and search facets, the art source, and the tcgcsv category 89 price import and binding. | The owner imports every released set. Search, browse and card display work. Prices show where products bind. |
| 6 | Riftbound collection release | Card display tuning and landscape Battlefields. Collection, Locations, Friends, Loans and Trades on the Riftbound side. | User stories 5 to 9 pass on dev. |
| 7 | Riftbound decks | Deck List parts, the format evaluator, the ban list, Want List and Pick List, Published Decks. | User stories 10 to 13 pass. |
| 8 | Imports and exports | Decklist text and deck codes, the Collection Import readers chosen in Phase 0, Mass Entry. | User story 14 passes for each chosen format. |
| 9 | Scanner (later) | Riftbound layout, number parser and reference index. | Measured on real cards as the Pokémon scanner was. |

Rough sizes for one developer with agents:

| Phases | Estimate |
|---|---|
| 1 | Several days |
| 2 and 3 | 2 to 3 weeks |
| 4 | About a week |
| 5 and 6 | 3 to 4 weeks |
| 7 | 3 to 4 weeks |
| 8 | 1 to 2 weeks |
| 9 | 3 to 4 weeks |

## Testing Decisions

- Phases 1 to 3 are refactors. The existing suites are the acceptance test, unchanged except for import paths. Changing
  a test's expectation is a stop-and-check.
- CI applies migrations to empty auth, Pokémon and Riftbound databases.
- Boundary checks run in `scripts/ci.sh` for Python imports, TypeScript imports and the web bundles.
- A Playwright journey covers: sign in once, switch sides, open a Riftbound page, switch Riftbound off, and see the 410
  and unavailable notice while the Pokémon side still works.
- Riftbound tests use fixtures fetched from private storage or generated stand-ins, never committed card images or
  data.

## Open Questions

1. **Catalog source.** Riftcodex (an unofficial API that carries TCGplayer ids), TCGplayer products from tcgcsv category
   89, or both? Which one supplies images, and on what terms?
2. **Name.** Is the Riftbound side also called PrizeCheck, or does it get its own name?
3. **Private fixtures.** Where do Riftbound test fixtures and scanner references live, so CI can reach them and the
   public repo never holds them?
4. **Foils.** How does tcgcsv represent Riftbound foils? This decides the Edition and price binding model.
5. **Sideboard.** Is the sideboard 8 or 10 cards under the current official rules?
6. **Handles.** Should a Handle be reserved on both sides when it is claimed on one?
7. **Owner check.** How do backends learn the caller is the owner once `owner_binding` leaves their database: a signed
   claim from the gateway, or a read the gateway answers?

## Out of Scope

- Cards from both games in one Location, Deck or Trade.
- Friends, Handles, conversations or inboxes shared across sides.
- Languages other than English.
- A Riftbound scanner before Phase 9.
- Separate repositories. ADR 0022 keeps the split possible but doesn't plan it.

## Further Notes

### Branch and merge

`riftbound` is a long-lived branch from `dev`. Phases 1 to 3 restructure code the Pokémon side changes every day, so the
branch should merge `dev` often, at least before each phase starts. A large divergence there means painful conflicts.

The owner may choose to land Phases 1 to 3 on `dev` once they pass, since they change no behaviour. That would keep only
Riftbound code on the branch. It is not decided here.

### Sizes the estimates rest on

Counts were taken on 2026-10-29.

**Shared code:**
- Backend: about 20,000 of `api/app`'s 36,000 lines are shared as-is or need only parameterising.
- Web: about 25,000 lines (kit, shell, Trades, Loans, social, settings, inbox) are core as they stand.

**Code that needs a Riftbound counterpart:**
- Backend: about 9,000 to 10,000 lines. They are:
  - the catalog importer
  - format evaluator and rules
  - card attributes and Reprint Groups
  - price import and binding
  - text parsing and exports
  - marketplace mapping
- Web: the deck model, the catalog filters, the import parsers, the exports and the scanner's recognition layer.

**Tests:** about 60 or more of about 150 Playwright files use Pokémon data.
