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
- **Databases.** There are three: auth, Pokémon and Riftbound. The auth database holds:
  - the Better Auth tables (migration 002)
  - the sign-up and rate-limit tables
  - Handles and released Handles (from migration 100)
  - an owner flag on the user, which replaces `owner_binding`
 Each game database holds core tables plus its game's
  tables. No API table has a foreign key to the sign-in tables today (checked 2026-10-29), so moving them changes no
  foreign keys.
- **Signature.** The gateway signs the path the backend receives. If it strips `/riftbound`, it signs the stripped path,
  and `api/app/identity.py` stays unchanged.
- **Owner.** The owner is a flag on the user in the auth database (owner, 2026-10-29). The gateway signs it into each
  request beside the user id, and `require_owner` reads the signed flag instead of `owner_binding`.
- **Handles.** A Handle belongs to the collector on both sides (owner, 2026-10-29). It lives in the auth database. A
  claim, change or release made from either side goes through the gateway. Backends get Handles from the gateway for
  Friend lookups and display. Phase 1 picks whether they come signed in the request or from a gateway read, and whether
  Display Name moves with them.
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

- **Catalog:** see [Catalog from tcgcsv](#catalog-from-tcgcsv). Sets so far: Origins, Proving Grounds, Spiritforged,
  Unleashed, Vendetta and Radiance, plus promos and bundles.
- **Deck shape:**
  - 1 Legend and 1 Chosen Champion that shares a tag with the Legend.
  - A 40-card main deck that includes the Champion, with at most 3 copies of a card.
  - A 12-card rune deck and 3 Battlefields.
  - A sideboard of 10 cards (owner, 2026-10-29).
  - Main and rune cards must match the Legend's domains.
- **Formats:** Standard Constructed and 2v2 Constructed, each with a ban list. No rotation is planned before 2028.
- **Terms:**
  - `CONTEXT.md` gains Riftbound meanings for Card Identity, Format and Deck List parts before Phase 7.
  - The Pokémon-only terms (Trainer Type, Reprint Group) stay Pokémon's.

### Catalog from tcgcsv

The owner chose tcgcsv as the only Riftbound source for both the catalog and prices (2026-10-29). Riftbound is TCGplayer
category 89. The checks below were run on the Origins group (`/tcgplayer/89/24344`, 365 products) on 2026-10-29. Phase 5
repeats them on every group before the importer is built.

- **Cards versus sealed products.** In Origins a card is a product with a `Number` extended-data field, and a sealed
  product has none. The sealed products are boosters, displays, cases, Champion Decks, promo packs and art bundles, and
  none of them carries `Number`, `Rarity` or `Card Type`. Tokens are not cards (owner, 2026-10-29) and are skipped: `Buff`
  has a `Card Type` of `Token` and no `Number`, and two `Recruit // Buff` products have a `Number` but no `Card Type`.
  The importer takes products with a `Number` and a `Card Type`, and skips any whose `Card Type` includes `Token`.
  Phase 5 confirms on every group that this keeps every card and no token.
- **Printings.** Each product is one Card Printing. Numbers are `038/298`, `007a/298` for alternate art, and
  `299*/298` for overnumbered and signature cards. No number repeats within the set. The names carry `(Alternate Art)`,
  `(Overnumbered)` or `(Signature)`, which are stripped for the card name.
- **Foils are a price subtype, not a product.** tcgcsv prices each product under the subtype `Normal`, `Foil` or both.
  In Origins:
  - Common and Uncommon cards have both.
  - Rare, Epic and Showcase cards are Foil only.
  - Twelve products with no rarity, and nine Commons, are Normal only.

  So a Card Edition is a product and a finish, one Edition for each subtype the product is priced in. This matches how
  the Pokémon side binds subtypes to Editions, and it means foils need no Unspecified Variant.
- **Card facts in `extendedData`:** `Card Type` (Unit, Champion Unit, Legend, Spell, Signature Spell, Gear,
  Battlefield, Rune, Token), `Domain`, `Tag` (`;`-separated), `Energy Cost`, `Power Cost`, `Might`, `Rarity`,
  `Description` and `Flavor Text`. That is enough for the deck shape: Legend, Champion tag, domains and Battlefields.
- **Images** are TCGplayer CDN URLs (`tcgplayer-cdn.tcgplayer.com/product/<id>_200w.jpg`). Whether to cache them in the
  art store, and at what size, is a Phase 5 decision.
- **Not checked yet:**
  - groups other than Origins
  - promo and bundle groups whose cards may share numbers with a main set
  - multi-domain cards (does `Domain` use `;`?)
  - the `Legacy` group dated 2027-01-29

## Phases

Each phase leaves both sides working. Phases 1 to 4 change no collector-facing behaviour on the Pokémon side.

| # | Phase | Main work | Done when |
|---|---|---|---|
| 0 | Decisions | Answer the data source, name, private fixture storage and foil questions. | Done 2026-10-29 (see [Answered](#answered)). |
| 1 | Shared identity | Move the sign-in tables, the sign-up and rate-limit tables and Handles to the auth database. Replace `owner_binding` with an owner flag on the user, and sign the owner flag into requests. Decide how backends get Handles. | Sign-in, sign-up gate, owner screens and account deletion pass against the split databases on dev. |
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
| 1 | 1 to 2 weeks (Handles are read across social, Blocks and Trades) |
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
- Riftbound tests use fixtures from the private fixtures repository or generated stand-ins, never committed card images
  or data.

## Open Questions

1. **Handles to backends.** Do backends get Handles signed in each request, or from a gateway read? Does Display Name
   move to the auth database with the Handle? This is a Phase 1 design decision.

### Answered

The owner answered these on 2026-10-29:

- **Catalog source:** tcgcsv only, provided cards can be told apart from sealed products. They can, as
  [Catalog from tcgcsv](#catalog-from-tcgcsv) shows. Riftcodex is not used.
- **Name:** the Riftbound side is also PrizeCheck, with a game switcher.
- **Private fixtures:** Riftbound test fixtures and scanner reference images live in a separate private GitHub
  repository that CI checks out. Nothing from it is committed here.
- **Foils:** check the data before deciding. The check showed foils are a price subtype, so a Card Edition is a product
  and a finish (see [Catalog from tcgcsv](#catalog-from-tcgcsv)).
- **Sideboard:** 10 cards.
- **Handles:** shared. A Handle claimed on one side is reserved on the other, and the whole identity (sign-in, Handle
  and owner) lives in the shared auth service.
- **Owner check:** an owner flag on the user, signed by the gateway.
- **Tokens:** not cards. The importer skips them.

## Out of Scope

- Cards from both games in one Location, Deck or Trade.
- Friends, Blocks, conversations or inboxes shared across sides.
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
