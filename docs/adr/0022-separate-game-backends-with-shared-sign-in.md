# Each game runs as its own backend and database, with one shared sign-in

**Status:** proposed 2026-10-29. The owner chose the topology, one codebase, Friends per game, and a separate Location
tree per game the same day. Spec: [Riftbound side](../planning/riftbound/spec.md). Builds on
[ADR 0001](0001-react-python-workers-auth-boundary.md) (the auth gateway signs the caller for the API). This ADR
narrows `PRODUCT.md`'s "English Pokémon cards only" statement, which needs updating when this ADR is accepted.

**Context.** PrizeCheck will offer a second game, Riftbound, next to Pokémon. To collectors the two read as two sites
that share one sign-in: a collector signs in once and switches between them. Nothing crosses between games. A Location
holds one game's cards, a Deck is built from one game's catalog, and a Trade swaps one game's cards. The Riftbound side
must also be removable at short notice without touching the Pokémon side, because its catalog data and card images
come from third parties whose terms may change.

Nothing in the app knows which game a card belongs to today. The catalog, format checks, prices, imports, exports and
scanner assume Pokémon throughout. The data that is not about cards (Locations, Holdings, moves, Friends, Loans, Trades,
Published Decks) refers to a card only by its Card Edition or Card Printing id. Auth and the API share one PostgreSQL
database: migration 002 creates the sign-in tables, and the gateway reads `owner_binding` to gate sign-up. No API table
has a foreign key to the sign-in tables, so user ids already cross the boundary as plain text.

**Decision.**

- **One backend and one database per game.** Each game is its own API container with its own PostgreSQL database,
  migrations, jobs, art store and backups. Neither backend reads the other's database. Within a backend there is no game
  column, because the whole database is one game.
- **One shared sign-in.** The auth gateway gets its own database with the sign-in tables, the sign-up and rate-limit
  tables, and the owner binding. It is the only service that knows sessions. It routes `/api/riftbound/*` to the
  Riftbound backend and every other `/api/*` to the Pokémon backend, signing the user id as it does today. The signature
  covers the path the backend receives. Deleting an account in the gateway reaches every enabled backend.
- **Friends, Handles, Blocks, conversations, Loans and Trades are per game.** Each backend keeps its own social tables.
  A collector who plays both games adds Friends on each side. The social module keeps its tables to itself, so it can
  later move into a shared service without changing the rest.
- **One repository and one API image, split into core and game modules.** Core holds what both games share: Locations,
  Holdings, moves, removal and undo, the Collection read, Want List mechanics, social, Loans, Trades, Published Deck
  mechanics, the price runner, the art store and operations. Each game module holds its catalog source, card attributes,
  deck rules and format checks, decklist and collection import parsing, exports, marketplace price mapping and scanner
  inputs. Core calls game modules only through a small set of interfaces. The container's game setting picks the module
  at start-up. The web app follows the same split: a shared shell, kit and core pages, plus a folder for each game.
- **Boundaries are checked, not just agreed.** CI fails when core imports a game module or one game imports another,
  for both Python and TypeScript, in the way `scripts/check_bundle_boundary.py` checks bundles today.
- **Migrations come in two tracks.** A core track applies to every game database, and each game has its own track. The
  Pokémon database keeps its existing history. A new game database starts from a core baseline.
- **Each game can be switched off on its own.** One gateway setting turns a game off: its routes answer 410, it is
  dropped from the game switcher, and its pages show an unavailable notice. Its container can then be stopped and its
  data kept or deleted. The game's web code is its own lazily loaded bundle, so a disabled game sends nothing to
  browsers.
- **No third-party game assets in git.** Card images, catalog dumps and scanner reference images for Riftbound are
  fetched at run time, or in CI from private storage, and never committed.

**Rejected.**

- **A game column on shared tables in one database.** It touches every Pokémon catalog query and puts the live app at
  risk. It makes Riftbound's deck shape (Legend, Champion, Battlefields, runes) fit Pokémon's tables, and it cannot
  remove one game's data or code on its own.
- **Separate repositories with a shared core package.** About 10 to 15 thousand backend lines and 25 thousand web lines
  are shared and change often. A published core package would turn each change into a release plus two upgrades. The
  checked boundaries keep a later split to a move of files.
- **A full fork.** Every fix to the shared code would be made twice, and the copies would drift.
- **Shared Friends and Handles now.** Moving the social graph into the gateway is a sizeable extraction, and nothing in
  the first release needs it.

**Consequences.**

- Moving the sign-in tables and the owner binding out of the Pokémon database is a one-time migration of live data, and
  it ships before any Riftbound work.
- Splitting the existing code into core and the Pokémon module must not change behaviour. The current test suites are
  the check that it hasn't.
- Each game gets its own deploy units: a container, a database, backups, price and catalog jobs, and health checks. The
  operations panel has to show each one.
- A Handle is unique only within one game, so two different collectors can hold the same Handle on different sides.
  Reserving a Handle across games is possible later and is not decided here.
- Published Deck URLs and generated web clients carry the game in their path. Existing Pokémon URLs stay as they are.
