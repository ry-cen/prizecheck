# Pokémon TCG Collection Tracker

A web app for tracking the physical Pokémon cards you own, how many copies you
have, and where they are stored. Organize boxes, binders, and shelves into a
location tree, move cards between them, and build decks from your actual inventory.

A Deck is a physical storage location: moving cards into it changes where those
copies are stored. The Collection view totals your holdings across all locations.
Public sharing uses a separate snapshot so visitors can see a published deck
without seeing your private inventory or storage tree.

## What you can do

- Search an English Pokémon card catalog imported from TCGdex, with printing and
  physical edition distinctions. Unknown finishes remain **Unspecified Variant**.
- Add card quantities to storage locations, move selections in bulk, remove cards
  from inventory, and undo recent moves or removals.
- Browse your full collection and find the locations holding each edition.
- Create physical decks and check the 60-card total and four-copy limit, including
  supported Basic Energy exemptions. These checks do not establish tournament or
  Standard legality.
- Publish revocable deck snapshots as unlisted links or listed pages in public
  discovery at `/discover`. Anyone with an unlisted link can view it.
- Report missing catalog entries. Owner controls provide catalog imports, review
  of corrections and missing entries, and operational status.

The application and local operations tooling are implemented. Hosting, email,
and storage providers are still unselected; production launch has a separate
[acceptance checklist](.scratch/tcg-collection-tracker/launch-checklist.md).
Sign-in uses email codes and defaults to the configured owner account only.

## Run locally

Use Node.js 22.12+ and Python 3.11+. You also need PostgreSQL 16, either installed
locally or through Docker Compose. Run the commands below from the repository root.

### 1. Install dependencies and configure the environment

```sh
npm ci
python3 -m venv .venv
.venv/bin/pip install -r api/requirements.txt
cp .env.example .env
```

Edit `.env`:

- Set `OWNER_EMAIL` to the address you will use to sign in.
- Replace `BETTER_AUTH_SECRET` and `INTERNAL_AUTH_SECRET` with two distinct random
  secrets of at least 32 characters. Run `openssl rand -hex 32` once for each.
- Set `DATABASE_URL` if you are using your own PostgreSQL server. The example URL
  already matches the included Compose database.

Keep `MAIL_MODE=console` for local development: sign-in codes appear in the auth
service terminal instead of being emailed. Keep `.env` private.

### 2. Initialize the database and public snapshot store

If using Compose, start PostgreSQL and wait for it to be healthy:

```sh
docker compose up -d --wait db
```

Then load the environment and initialize a new local installation:

```sh
set -a
source .env
set +a
.venv/bin/python scripts/migrate.py
.venv/bin/python scripts/init_public_projection.py
```

The public store defaults to `.local/public-projections`. Initialize it for a new
installation; use the [projection recovery instructions](docs/public-projections.md)
if an existing store is lost or corrupt.

### 3. Start the app

In one terminal, with `.env` loaded:

```sh
.venv/bin/uvicorn app.main:app --app-dir api --host 127.0.0.1 --port 8000 --no-access-log
```

In a second terminal, load the same environment and start the auth gateway and UI:

```sh
set -a
source .env
set +a
npm run dev
```

Open **http://localhost:5173/**. Request a code for `OWNER_EMAIL`, read it in the
`npm run dev` terminal, and sign in. Your account starts with an Unsorted storage
location.

### 4. Bind the owner and import the catalog

After the first sign-in, run these commands in a terminal with `.env` loaded:

```sh
psql "$DATABASE_URL" -c 'select id, email from "user";'
.venv/bin/python scripts/bind_owner.py '<id from the query>'
```

Owner privileges bind to that immutable account ID. This is a one-time setup and
rejects a different ID once bound. Refresh the page, open **Owner controls**, and
choose **Start full English pull**. The import requires internet access to TCGdex;
the catalog becomes available after the first complete successful pull.

Imports run on demand in a separate Python process and survive closing the browser
or restarting the API. A failed refresh keeps the previous successful catalog.

### 5. Try the inventory workflow

Create a location for a box or binder, then add an edition and quantity from the
catalog in that location. Create a Deck and move some of those copies into it.
Check **Collection** to see the total and its distribution between locations;
check **Decks** for construction counts. Publish a snapshot when you want to share
that deck. Later inventory edits require publishing an updated snapshot to change
what visitors see.

## Development

The stack is React, TypeScript, and Vite for the UI; Better Auth for email-code
sessions; FastAPI/Python for application logic; and PostgreSQL for private data.

Browser requests use one origin. Vite proxies `/auth` and `/api` to the auth gateway,
which verifies sessions and signs protected requests to FastAPI. Keep the API behind
that gateway. Anonymous deck and discovery reads use a sanitized public projection.

| Path                               | Purpose                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `web/src/`                         | React views and generated API clients                                    |
| `auth/src/`                        | Better Auth, email delivery, and API gateway                             |
| `api/app/`                         | Inventory, catalog, decks, publications, and operations logic            |
| `migrations/`                      | Database schema migrations                                               |
| `scripts/`                         | Migrations, client generation, verification, recovery, and release tools |
| `docs/`                            | Architecture decisions and operational guides                            |
| `.scratch/tcg-collection-tracker/` | Specification, implementation tickets, and launch evidence               |

FastAPI's OpenAPI schemas generate the TypeScript clients. Edit the generators or
API contracts rather than editing generated clients directly.

Useful commands:

```sh
npm run check       # TypeScript and generated-client drift checks
npm run build       # Checks plus the production frontend build
npm run guardrails  # Database-free privacy and tooling checks
```

For the full application, recovery, and release-runtime regression gate, install
Chromium and provide a local PostgreSQL role that can create and drop databases:

```sh
npx playwright install chromium
TEST_ADMIN_DATABASE_URL=postgresql://YOUR_TEST_ROLE@127.0.0.1:5432/postgres npm run verify
```

The runner creates disposable databases and services, tests the current working
tree, and saves diagnostics under `.scratch/verification/`. It needs full Git
history for historical runtime fixtures. See the [verification guide](docs/agents/verification.md)
for focused reruns and failure artifacts. `npm ci` installs the pre-commit hook
for staged formatting, type/contract checks, and fast privacy checks.

Use `dev` as the integration branch. Update `main` from `dev` when a release is
authorized.

## Further reading

- [Domain model](CONTEXT.md): printings, editions, holdings, locations, and decks.
- [Product specification](.scratch/tcg-collection-tracker/spec.md) and
  [local issue tracker](docs/agents/issue-tracker.md): scope and implementation history.
- [Architecture decisions](docs/adr/): stack, on-demand imports, and provider decisions.
- [Provider adapters](docs/provider-adapters.md) and
  [deployment boundaries](docs/deployment-boundaries.md): connecting a hosting runtime,
  real email delivery, storage, and scheduling.
- [Signup readiness](docs/signup-readiness.md): email adapters and the gate for opening
  public signup. Console/file email modes are local-only.
- [Public projections](docs/public-projections.md): snapshot storage, privacy, and recovery.
- [Local recovery](docs/operations/local-recovery.md),
  [portable operations jobs](docs/operations/portable-jobs.md), and
  [release tooling](docs/operations/release.md): backups, restores, monitoring, and releases.
