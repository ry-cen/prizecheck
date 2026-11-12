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
python3 scripts/local_admission.py exec -- env HUSKY=0 npm ci  # HUSKY=0 only here: husky's prepare step would rewrite core.hooksPath,
                                     # which every worktree of the repository shares
python3 scripts/local_admission.py exec -- python3 -m venv .venv
python3 scripts/local_admission.py exec -- .venv/bin/pip install -r api/requirements.txt
python3 scripts/local_test_db.py hooks
```

`core.hooksPath` is `.husky/_`, relative to each worktree, and a fresh worktree has no `.husky/_`, so git skips the pre-commit and commit-msg hooks without a word. `hooks` writes the files husky would write into this worktree's `.husky/_` and leaves git config alone; it refuses when `core.hooksPath` is anything else. The doctor's `git hooks` line shows whether they are in place. Never commit with `HUSKY=0` or `--no-verify`.

## The disposable server

`npm run verify:local -- <verify arguments>` is the admitted Linux local workflow described below. It forces this checkout's native PG16 cluster and ignores inherited `TEST_ADMIN_DATABASE_URL` and `DATABASE_URL`. API runs require explicit `--pytest-workers 1` or `2`. The underlying runner keeps its existing selectors and assertions:

```sh
npm run verify:local -- --suite api --pytest-workers 2 -- api/tests/test_prices.py -k stale
npm run verify:local -- --suite browser -- web/tests/workspace-actions.spec.ts
npm run verify:local -- --fast
```

A browser run that ends in `curl: (22) The requested URL returned error: 500` before any spec ran had a stack that did not answer `scripts/ci.sh`'s 10-second health check. On the dev container (16 cores, a fresh `node_modules`, other sessions' runs alongside) the default four stacks failed that check once and `--browser-workers 1` passed; no four-stack run has been shown to pass there, and the cause was not timed. For narrow browser runs on a shared host, pass `--browser-workers 1`:

```sh
npm run verify:local -- --suite browser --browser-workers 1 -- web/tests/deck-builder.spec.ts
```

The lower-level `local_test_db.py run` remains available for CI/admin-URL and other-host workflows. It passes an existing `TEST_ADMIN_DATABASE_URL` through unless `--local` is supplied. This legacy entrypoint does **not** acquire admission. The other commands:

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

The commit hook runs on macOS; `verify:local` and local admission remain Linux-only.

## Host admission (Linux)

The shared queue lives at `~/.local/state/prizecheck-admission-v1/`, outside every worktree. All cooperating Prizecheck worktrees/clones under the same OS user and HOME use it. A short `flock` transaction and atomic durable state replacement admit either two API runs or one exclusive task. Each API run must declare 1–2 workers; at most four workers run together. No two admitted tasks use the same worktree simultaneously. An earlier waiting exclusive request stops newer API requests from overtaking it; healthy active runs drain first. A retained owner blocks the queue rather than expiring on a timer.

The scheduler does not see commands from old revisions, direct `verify`, bare pytest, `local_test_db.py run`, release tools, unwrapped npm commands, other users/HOMEs or other projects. During rollout, the existing host coordinator reserves a window covering all such work and the admitted queue. Do not activate concurrent real runs merely because this code is present. Agree on a drained legacy window, adopt the admitted commands in every participating worktree, and keep legacy/heavy work coordinated exclusively until it migrates. Two independently running copies with a different HOME do not coordinate.

A new or changed narrow selection first performs **exclusive preparation** automatically. Its real pytest collection records inherited, parameter and dynamically resolved serial markers in the normal verification artifacts. After verified harness cleanup and local PG shutdown it releases that reservation, checks the exact fingerprint again and makes a new FIFO request for the actual tests. Eligible API work may then share a slot; serial-containing selections requeue exclusively without omitting tests. Unknown selector options and other suites remain exclusive throughout. No held lock is downgraded, and the second request cannot overtake an earlier exclusive waiter.

Evidence is private to the worktree and bound to all copied source bytes, exact runner arguments and installed dependency file metadata. A matching rerun reuses the evidence without an extra preparation phase. The local path rechecks the fingerprint after queueing, validates the copied source, repeats collection before tests and guards actual pytest passes against serial cases. Source edits, installs and new arguments invalidate eligibility. Preparation failure, uncertain cleanup, missing evidence or a changed fingerprint stops before actual tests. Do not mutate source/dependencies during execution; this cooperating mechanism is not a sandbox against a caller that forges evidence or changes dependency stamps. See verification.md for classification limits.

Normal commands prepare automatically when needed. For a collection-only check, explicit `--prepare` still stops before test fixtures execute. Run it in the selected worktree (substitute the actual selected files):

```sh
npm run verify:local -- --prepare --suite api --pytest-workers 2 -- api/tests/test_holdings.py
npm run verify:local -- --prepare --suite api --pytest-workers 2 -- api/tests/test_moves.py
```

Preparation still imports test modules and performs the harness's disposable DB/migration setup, so it needs an exclusive coordinated window. It runs no tests, and both automatic and explicit preparation preserve their own artifact directory. Once the coordinator has authorized rollout/the trial, start one normal command in each worktree. Fresh selections prepare exclusively and requeue automatically; matching eligible selections can run together, and a third waits. Preserve each printed token and run artifact directory:

```sh
npm run verify:local -- --suite api --pytest-workers 2 -- api/tests/test_holdings.py
npm run verify:local -- --suite api --pytest-workers 2 -- api/tests/test_moves.py
```

For an exclusive API baseline add `--exclusive` before the selector separator. Browser, full/fast gates and other suites automatically request exclusive admission. Browser concurrency across runs remains unsupported; the narrow browser default is one worker. Existing explicit worker overrides do not gain evidence or permission to increase browser load.

Use the exclusive wrapper for foreground builds, guardrails, installs, hooks/commits and other heavy commands. It forces this checkout's physical `.scratch/tmp` and refuses dependency-directory symlinks; it does not change global Git configuration. Do not nest an admitted verification command inside the exclusive wrapper (it would wait on itself), and do not wrap daemon/service startup commands:

```sh
npm run local:exclusive -- npm run guardrails
npm run local:exclusive -- npm run check
npm run local:exclusive -- npm run build
python3 scripts/local_admission.py exec -- env HUSKY=0 npm ci
```

The local verification path refuses a checkout cluster already running before admission: finish/coordinate its legacy users, then stop it using `python3 scripts/local_test_db.py stop`. It starts only its own native PG16 cluster, passes its URL privately to verify, then stops it after cleanup. Other servers, containers and worktrees are untouched. Lower-level DB commands retain their prior backend/admin-URL behavior.

### Ownership, interrupts and recovery

Supported local entry points reset `SIGCHLD` to `SIG_DFL` before starting children so an inherited ignored disposition cannot turn a lost child exit status into success.

```sh
npm run local:status
python3 scripts/local_admission.py status
```

Status names each token, FIFO position, worktree, owner PID/start identity (Linux boot id plus start ticks), mode, workers, child and cleanup receipt path. SIGINT/TERM/HUP are forwarded once to the owned child; subsequent signals cannot skip its cleanup wait. Only a confirmed empty child group, a token-matching receipt written after the existing harness's workspace/database cleanup with no cleanup failures, and verified local PG shutdown release verification admission. A failing test preserves its exit status even when cleanup succeeds. Cleanup failures still fail the run and retain admission. Generic foreground commands release only after their child exits and its process group is empty. Commands that detach/daemonize descendants are outside that generic wrapper's guarantee and must not be wrapped.

A sent signal, elapsed time, dead supervisor, missing result or stale PID is **not** cleanup proof. A killed/crashed owner stays retained and stops new admission. Preserve its artifact directory and `.scratch/admission/<token>/cleanup.json`; do not delete the shared state or lock to unblock the queue. A process that starts another session can leave its parent's group; the existing harness's limitation still applies, so audit escaped children too.

After the owner has exited, independently audit the recorded run: verify all known PID/start identities, process groups, ports/listeners, workspaces, run databases/sessions, native cluster status, `cleanup_failures`, `database_removed` and any `RETAINED:` lines. Coordinate any targeted cleanup using the existing runbook; do not kill an arbitrary PID or delete another worktree's data. Only after this audit may the coordinator remove the exact reservation:

```sh
python3 scripts/local_admission.py recover <exact-token> --cleanup-verified
```

Recovery checks that the owner identity is gone and the recorded child group is absent, signals nothing, and requires the caller's explicit audit attestation for resources outside that group. An unknown identity or live group refuses recovery. This intentionally trades availability for safe cleanup after crashes, including a crash between child spawn and registry update.
