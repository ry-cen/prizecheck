# Local testing

How a fresh checkout or worktree gets from nothing to the checks in [verification.md](verification.md). The runner there (`npm run verify`) is the only test runner; this page covers what it needs and the disposable PostgreSQL server `scripts/local_test_db.py` provides for it.

Start with the doctor. It changes nothing, prints no URL or password, and ends with which tiers this checkout can run:

```sh
python3 scripts/local_test_db.py doctor     # or: npm run test:db -- doctor, once node_modules exists
```

## Tiers

| Tier       | Commands                                                                                              | Needs                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| DB-free    | `npm run check`, `npm run guardrails`, `npm run test:unit`, `npm run build`, `npx prettier --check .` | Node 22 or later, `node_modules`, `.venv`                                   |
| DB-backed  | `npm run verify:local -- --suite api [-- <pytest selectors>]`, `--suite auth`                         | the above, and a PostgreSQL server (below)                                  |
| Browser    | `npm run verify:local -- --suite browser [-- <specs>]`                                                | the above, and Playwright's Chromium (`npx playwright install chromium`)    |
| Operations | `npm run verify:local -- --suite operations`, the full gate `npm run verify:local`                    | the above, `psql` and `pg_dump` on PATH, and full git history (not shallow) |

The DB-backed and browser tiers use synthetic fixtures only (`api/tests`, `auth/tests`, `web/tests`). They need no provider keys or mail service: `scripts/ci.sh` sends email to a file, signs in through the OAuth fake (`auth/testing/oauth-fake`) and imports the catalog from a fixture. Two scanner checks sit outside these tiers: `npm run test:scanner-models` (the `*.models.test.ts` and `*.local.test.ts` vitest files) needs local model files and runs only locally, and the scanner index image's `test` stage (`deploy/docker/scanner-index.Dockerfile`, `api/tests/test_scanner_index_job.py`) needs ONNX Runtime and runs on CI.

## Dependencies in a new worktree

Give each worktree its own dependencies. A symlink to another checkout's `node_modules` or `.venv` is not read-only: Vite and Vitest write caches into `node_modules`, and an install through the link changes the other checkout's. If the worktree already has those symlinks, remove the links themselves first (`rm node_modules .venv`, no `-r`, which would delete through them), then install:

```sh
HUSKY=0 npm ci                       # HUSKY=0 only here: husky's prepare step would rewrite core.hooksPath,
                                     # which every worktree of the repository shares
python3 -m venv .venv && .venv/bin/pip install -r api/requirements.txt
python3 scripts/local_test_db.py hooks
```

`core.hooksPath` is `.husky/_`, relative to each worktree, and a fresh worktree has no `.husky/_`, so git skips the pre-commit and commit-msg hooks without a word. `hooks` writes the files husky would write into this worktree's `.husky/_` and leaves git config alone; it refuses when `core.hooksPath` is anything else. The doctor's `git hooks` line shows whether they are in place. Never commit with `HUSKY=0` or `--no-verify`.

## The disposable server

`npm run verify:local -- <verify arguments>` is `npm run verify` with `TEST_ADMIN_DATABASE_URL` supplied: it starts this checkout's server if it is not running, sets the variable for that one command, and never prints it. Arguments go to verify unchanged:

```sh
npm run verify:local -- --suite api -- api/tests/test_prices.py -k stale
npm run verify:local -- --suite browser -- web/tests/workspace-actions.spec.ts
npm run verify:local -- --fast
```

A browser run that ends in `curl: (22) The requested URL returned error: 500` before any spec ran had a stack that did not answer `scripts/ci.sh`'s 10-second health check. On the dev container (16 cores, a fresh `node_modules`, other sessions' runs alongside) the default four stacks failed that check once and `--browser-workers 1` passed; no four-stack run has been shown to pass there, and the cause was not timed. For narrow browser runs on a shared host, pass `--browser-workers 1`:

```sh
npm run verify:local -- --suite browser --browser-workers 1 -- web/tests/deck-builder.spec.ts
```

When `TEST_ADMIN_DATABASE_URL` is already set, `run` passes it through instead (add `--local` to use this checkout's server anyway). The other commands:

```sh
python3 scripts/local_test_db.py start [--backend auto|native|docker|podman] [--allow-pull]
python3 scripts/local_test_db.py run [--backend ...] [--local] -- <command>
python3 scripts/local_test_db.py status
python3 scripts/local_test_db.py stop       # stop it; start or run brings it back
python3 scripts/local_test_db.py destroy    # stop it and delete .scratch/local-test-db
```

`--backend auto` takes the first of:

- **native**: `initdb`, `pg_ctl` and `postgres` together, from `$PG_BIN`, PATH, `pg_config --bindir`, `/usr/lib/postgresql/*/bin`, `/usr/pgsql-*/bin`, Homebrew's `postgresql@*` or Postgres.app. Client tools alone (`psql`, `pg_dump`) are not enough. The cluster is `.scratch/local-test-db/data`, made by `initdb --auth=scram-sha-256 --locale=C`.
- **docker**, then **podman**: when the CLI exists and its daemon answers this user. The container is `docker.io/library/postgres:16-alpine`, the image `docker-compose.yml` uses, named `prizecheck-test-db-<id>` and labelled `dev.prizecheck.local-test-db=<id>`, where `<id>` is a hash of the checkout's path. Its data is on tmpfs, so it makes no volume and `stop` removes it. The image is pulled only with `--allow-pull`.

Either way the server listens on 127.0.0.1 only, on a free port chosen at start, with no unix socket. Its only role is the superuser `postgres`, with a random test-only password in `.scratch/local-test-db/password` (mode 0600, directory 0700), and durability is off (`fsync`, `synchronous_commit`, `full_page_writes`) since the data is disposable. CI and production run PostgreSQL 16; the doctor notes a native server of another major version. Two worktrees get different directories, container names and ports, so their servers never meet, and inside one server verify gives every run its own databases.

`stop` and `destroy` act only on what `.scratch/local-test-db/owner.json` names: they refuse a record written by another checkout and a container with this name but another label, and `destroy` removes nothing but this checkout's `.scratch/local-test-db`. Nothing here prunes, stops or reconfigures any other server, container, image or volume. Removing a worktree with its server still running leaves the process or container behind, so run `destroy` first. The record names the checkout's path, so after `git worktree move` the script refuses it: run `destroy` before `git worktree move`, or remove `.scratch/local-test-db` once nothing runs from it.

## When no server is available

The doctor reports `local server backend: none` and `start` and `run` stop with the choices below. Each is a decision for the host's owner, not a step for an agent to take unasked:

1. **A PostgreSQL 16 server package** from the system package manager (on Debian and Ubuntu, `postgresql-16` from the PGDG repository; Debian 13's own repository carries 17). Follow the repository setup on [postgresql.org/download/linux/debian](https://www.postgresql.org/download/linux/debian/) and check the signing key's fingerprint against the one published there (`B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8` on 2026-10-30). This installs system software and needs root. Read `apt-get install -s` first: the package creates a `postgres` system account, may pull in `ssl-cert` (a self-signed key) and may upgrade `libpq5` and `postgresql-client-common`, which the host's owner should approve explicitly. Debian's `postgresql-common` creates and starts a default `main` cluster on install, so first set `create_main_cluster = false` in `/etc/postgresql-common/createcluster.conf`. Never stop, disable or reconfigure a PostgreSQL service that is already there: other work may use it. The script uses only the binaries and starts its own cluster.
2. **Docker or Podman**, already installed and usable by this user. Membership of the `docker` group is root-equivalent; rootless Podman is not. `--allow-pull` fetches `docker.io/library/postgres:16-alpine` from Docker Hub once.
3. **Your own disposable server** on loopback, with a role that may create and drop databases: export `TEST_ADMIN_DATABASE_URL` and `run` passes it through. Never point it at a database that holds anything you want to keep: the runner's reaper drops leftover `tcg_verify_*` databases.

The script downloads nothing and installs nothing. Do not borrow another session's server or binaries (under `/tmp` or another worktree): they disappear without warning and their data is not yours.
