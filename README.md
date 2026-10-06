# TCG Collection Tracker

Tickets 01–02 provide owner email-code sign-in, a private Unsorted Storage Leaf, and an owner-started English TCGdex catalog pull. The app uses React, TypeScript, Vite, FastAPI, Better Auth, and PostgreSQL. Hosting and delivery providers are deliberately unselected.

## Local setup

Requires Node 20+, Python 3.11+, and PostgreSQL 16. Docker Compose is an optional way to run PostgreSQL.

1. Start PostgreSQL with `docker compose up -d db`, or use a local server.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL`, `OWNER_EMAIL`, and both secrets. The Compose URL is `postgresql://tcg:tcg@127.0.0.1:5432/tcg`. Use two distinct random secrets of at least 32 characters.
3. Run `npm ci`, `python3 -m venv .venv`, and `.venv/bin/pip install -r api/requirements.txt`.
4. Load `.env` into the shell (`set -a; source .env; set +a`), then run `.venv/bin/python scripts/migrate.py`.
5. In separate terminals with the same environment, run `.venv/bin/uvicorn app.main:app --app-dir api --host 127.0.0.1 --port 8000` and `npm run dev`. Open `http://localhost:5173/`.

The owner starts each full English pull in Owner controls. The API promptly launches one detached Python child for that server-generated run ID; the child saves progress, holds PostgreSQL session ownership through publication, and exits. No importer polls or remains idle between pulls. Closing the browser or restarting the API does not stop a local import. An unfinished run with stale progress can be checked and recovered by an explicit Start request; the server never overlaps an importer that still holds its session lock, and allows a two-minute startup window. A host shutdown or destroyed execution environment can interrupt the process.

The host must support detached Python subprocesses, inherited server environment, independent database connections, and process lifetime beyond the request/API restart. The launcher uses the current Python interpreter, a fixed argument list, no shell, a nonblocking output sink, and a finite child-reaping thread. Hosting must provide this capability or an equivalent on-demand job launcher before deployment; request sandboxes that kill children after returning are insufficient. Docker Compose continues to run PostgreSQL only. The current and previous successful compressed raw generations are private PostgreSQL rows. `CATALOG_RAW_MAX_BYTES` bounds each compressed generation (default 100 MB); set `CATALOG_DB_MAX_BYTES` to the selected database's safe capacity threshold before deployment. A failed import keeps the prior active generation and revision. The first catalog remains unavailable until a complete import succeeds.

With `MAIL_MODE=console`, the fake delivery code appears in the auth service terminal. With `MAIL_MODE=file` and `MAIL_FILE` set to a private local path, it is appended there for tests. Production delivery must provide a real sender adapter before launch; neither fake mode should be deployed. Set `DAILY_SEND_CAP` below the chosen delivery provider's actual daily allowance. The limiter uses the connection IP by default. If a reverse proxy is used, list only its transport IP in `TRUSTED_PROXY_IPS` and configure it to replace incoming `X-Real-IP` with the client IP; untrusted callers cannot choose their own rate-limit IP.

Only the configured `OWNER_EMAIL` can receive a code in this first configuration. After that person first signs in, bind owner privileges explicitly to Better Auth's immutable user ID:

```sh
psql "$DATABASE_URL" -c 'select id, email from "user";'
.venv/bin/python scripts/bind_owner.py '<id from the query>'
```

This setup is one-time and rejects a different ID once bound. Never derive owner privilege from the current email address or signup order. The API gateway must be the only publicly routed path to the API; the API and auth service bind to loopback locally. A deployment can place them on a private network with the same signed internal request boundary. All browser requests use the same public origin. Secure cookies are enabled outside loopback HTTP development; local HTTP uses HttpOnly and SameSite=Lax without Secure so browsers can sign in.

## Verification

`scripts/ci.sh` runs the migration, generated client check, TypeScript check, Vite build, PostgreSQL/API tests, live Better Auth HTTP tests, and Chromium journey against a disposable `DATABASE_URL`. It requires `npm ci`, `.venv` dependencies, and `npx playwright install chromium` beforehand. It is provider-neutral so a later CI provider can invoke the same gate. Do not point it at an account or production database; its tests change auth records.

The Python API returns a safe public `/api/health`. Protected routes accept only short-lived HMAC assertions from the auth gateway after Better Auth verifies the server session. The browser cannot choose its user ID. `scripts/generate_client.py` reads FastAPI OpenAPI schemas to generate `web/src/generated.ts` and `--check` detects drift.

Public Deck snapshots use a separate sanitized local object projection. Initialize a new store with `.venv/bin/python scripts/init_public_projection.py` and configure `PUBLIC_PROJECTION_DIR` for the API. See [public projection setup, failure recovery, and privacy](docs/public-projections.md). Disable or redact access logs on public token routes before deployment.
