# Dev deployment on Linux

Running **Deploy dev** by hand on `dev` deploys PrizeCheck to a Linux dev host once the commit passes the verification gate. A push to `dev` deploys nothing. The app is reachable only on your Tailscale tailnet, at an HTTPS address such as `https://ryan-dev-vm.tail791645.ts.net`. There's no port forwarding, Funnel, or public reverse proxy.

This guide covers the dev environment. Production runs on Oracle Cloud and reuses the same image build and deploy script, with its own project name, data directory, secrets, GitHub environment and SSH key (see [Adding production later](#adding-production-later)).

The guide has three parts: host and account preparation, installing the host files with `setup`, and following the readiness report. Examples use an Ubuntu 26.04 systemd VM named `ryan-dev-vm`. Run host commands as root (use `sudo -i` for an administrative session); use a separate operator key for shell access. CI's key is restricted to the deploy gate.

The unchanged host script still links to `docs/deployment-unraid.md` and may suggest legacy plugins when prerequisites are missing. That compatibility stub maps its messages here. Follow this guide's Linux instructions instead.

## How it works

```
Actions → Deploy dev → Run workflow (branch dev)
  └─ GitHub Actions: Deploy dev (.github/workflows/deploy-dev.yml)
       ├─ build    the shared build (.github/workflows/build-images.yml), which production also uses:
       │    ├─ verify    the default checks: format, lint, compile, build, unit tests (.github/workflows/verify.yml)
       │    ├─ images    build api, auth, web and scanner-index natively for amd64 and arm64; push per-architecture tags
       │    └─ manifests join them into one :<commit> index per image (plus a moving :dev pointer)
       └─ deploy   join the tailnet as tag:ci (ephemeral) → SSH to the dev host with a forced command
                     └─ prizecheck-deploy.sh deploy <commit> <host-file digest>
                          ├─ pull the three :<commit> images (one-time GHCR login, deleted afterwards)
                          ├─ start PostgreSQL and list pending migrations
                          ├─ if any are pending: pg_dump, stop the app, run scripts/migrate.py
                          ├─ new install only: initialize the public projection store
                          ├─ start api → auth → web and wait for their health checks
                          ├─ smoke checks over loopback (below)
                          └─ pass: record the release · fail: bring the previous release back, fail the job
```

Containers (`compose.deploy.yml`, Compose project `prizecheck-dev`):

| Service         | Image                                              | Role                                                                                                        | Network reach                                     |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `web`           | `ghcr.io/ry-cen/prizecheck-web:<commit>`           | nginx (non-root) serving the Vite build; proxies `/auth/*` and `/api/*` to `auth`                           | The only published port: `127.0.0.1:18088`        |
| `auth`          | `ghcr.io/ry-cen/prizecheck-auth:<commit>`          | The unchanged Better Auth gateway (`auth/src`, compiled to JS), signs requests to `api`                     | Internal; outbound allowed for an HTTP mail relay |
| `api`           | `ghcr.io/ry-cen/prizecheck-api:<commit>`           | FastAPI under uvicorn: one process, no reload, no access log                                                | Internal; outbound allowed for TCGdex imports     |
| `db`            | `postgres:16-alpine`                               | PostgreSQL                                                                                                  | Internal-only network, never published            |
| `tools`         | the `api` image                                    | One-off runs: migrations, store initialization, `bind_owner.py`                                             | Started only by the deploy script or operator     |
| `scanner-index` | `ghcr.io/ry-cen/prizecheck-scanner-index:<commit>` | The card scanner's fingerprint index job (`scripts/scanner_index_job.py`), run by hand after a catalog pull | Database, and `assets.tcgdex.net` for artwork     |

Containers find each other by service name (`db`, `api`, `auth`). The browser talks to one origin, as it does in local development. The session, request-signing and public-read paths are the existing code, unchanged.

Persistent data lives on the host under `PRIZECHECK_DATA_DIR`:

| Directory   | Contents                                                                | Owner (uid) |
| ----------- | ----------------------------------------------------------------------- | ----------- |
| `postgres/` | PostgreSQL cluster                                                      | postgres    |
| `public/`   | Public projection and shared records store (published decks, discovery) | 10001       |
| `mail/`     | `codes.jsonl`, the sign-in codes while `MAIL_MODE=file`                 | 1000        |
| `art/`      | Card art stored on first request (ADR 0020); regenerable                | 10001       |

`art/` holds the card pictures the API fetched from TCGdex on first request and serves from `/api/art`. It is regenerable, so `backup` leaves it out on purpose; deleting it only costs refetches. After copying an updated `prizecheck-deploy.sh` to the host, run `prizecheck-deploy.sh setup` once: it creates `art/`, and deploys refuse to run without it.

Deploy state lives under `PRIZECHECK_HOME` (`state/current`, `state/previous`, `state/history.log`, `backups/`).

## Behaviour to know about

- **Sign-in codes go to a file, not to email.** No email provider has been selected yet (see [signup readiness](signup-readiness.md)), and the gateway refuses console and file mail under `NODE_ENV=production`. So dev runs with `NODE_ENV=development` and `MAIL_MODE=file`. Codes are written with mode 0600 to `mail/codes.jsonl` and never to container logs; read them with `prizecheck-deploy.sh sign-in-code`. `SIGNUP_MODE` is fixed to `owner-only`. Production must use `MAIL_MODE=http` with `NODE_ENV=production`.
- **Deploys with pending migrations cause downtime.** The deploy script stops the old release before migrating, so the old application never serves against a half-migrated schema (see the migration 026 notes in [release](operations/release.md)). Deploys without pending migrations replace containers with only a few seconds' interruption.
- **A deploy interrupts running imports.** Catalog imports are child processes of the `api` container, so recreating it ends them. Avoid deploying during a full catalog pull. A failed or interrupted pull keeps the previous successful catalog; check **Owner controls** after the deploy and start the pull again.
- **Migrations are never reversed.** Rollback starts the previous images against the current schema. The repository expects each migration to stay compatible with the previous release ([release](operations/release.md) has an opt-in check), but this pipeline doesn't run that check, and no check can cover every data state. To return to an older schema, restore a pre-migration dump (see [Restoring the database](#restoring-the-database)).
- **One rate-limit bucket.** `TRUSTED_PROXY_IPS` is empty, so the gateway ignores forwarding headers and sees every browser as the `web` container. The per-IP limits (code sends, public reads) are shared by everyone using dev. That's fine for a single owner.
- **No URLs in logs.** Published-deck URLs are capability links. nginx and uvicorn access logs are off, and nginx logs only its own critical failures. Container logs rotate at 3 × 10 MB per service.

## Part 1. What only you can do

Prepare the host and credentials before enabling deployments.

### 1. Prepare the Linux host

Use a supported Ubuntu system with systemd, local persistent storage, Docker Engine and OpenSSH. Install `openssh-server`, enable it with `systemctl enable --now ssh`, and permit root public-key authentication (`PermitRootLogin prohibit-password`). Keep an operator session open while changing SSH settings. Install and authenticate Tailscale on the host, with Tailscale SSH **off**:

```bash
tailscale set --ssh=false
```

Choose a real filesystem that supports PostgreSQL, atomic renames and `flock`; avoid network or FUSE storage. These examples use:

```bash
export PRIZECHECK_HOME=/srv/prizecheck-dev
```

### 2. Install Docker Compose

Install Docker Engine using Docker's Ubuntu apt repository and its Compose v2 plugin. Enable the daemon with `systemctl enable --now docker`. Check:

```bash
docker version
docker compose version
```

Compose must be v2 **2.20 or later**, for `up --wait --wait-timeout`. The script also accepts standalone `docker-compose` v2. Do not substitute Ubuntu's older Compose v1 package.

### 3. Configure Tailscale for CI

In the [Tailscale admin console](https://login.tailscale.com/admin):

1. **Access controls**: make CI a tag that may reach only SSH on the dev host. Merge this into your policy. Use the dev host tailnet IP from `tailscale ip -4` on the host.

   ```jsonc
   {
     "tagOwners": {
       "tag:ci": ["autogroup:admin"],
     },
     "hosts": {
       "ryan-dev-vm": "100.x.y.z",
     },
     "grants": [
       // Your own devices keep their access. Do NOT keep a rule with "src": ["*"]:
       // it would give tag:ci (and every tagged device) access to everything.
       { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
       // CI runners: SSH to the dev host only.
       { "src": ["tag:ci"], "dst": ["ryan-dev-vm"], "ip": ["tcp:22"] },
     ],
   }
   ```

   If your policy still has the default allow-all rule, replace it as shown. Tailscale's policy preview lets you check that `tag:ci` reaches only `ryan-dev-vm:22`.

2. **Trust credentials** (Settings → OAuth clients): create an OAuth client with the **Auth Keys → Write** scope, limited to tag `tag:ci`. Copy the client ID and secret into GitHub (step 8). The action uses them to mint a short-lived, ephemeral, pre-authorized node for each run, which disappears when the run ends. The `tailscale/github-action` also supports OIDC workload identity federation (`audience`), which needs no stored secret; switch to it later if you want.

3. **DNS**: enable **MagicDNS** and **HTTPS Certificates** (needed by Serve in step 4). Certificate issuance publishes the machine name (for example `ryan-dev-vm.tail791645.ts.net`) in public Certificate Transparency logs. The app itself stays unreachable from the internet.

### 4. Enable Tailscale Serve

Run Tailscale directly on the host so it can reach the loopback web port. Inspect existing routes before configuring HTTPS 443:

```bash
tailscale status --self
tailscale serve status
tailscale serve --bg --https=443 http://127.0.0.1:18088
tailscale funnel status
```

Keep Funnel off. `--bg` persists the route through reboots. The example dev URL is `https://ryan-dev-vm.tail791645.ts.net`; use your machine's actual HTTPS name. Set the same origin in the env file and GitHub. Keep `PRIZECHECK_WEB_BIND=127.0.0.1`.

### 5. Authenticate the dev host with GHCR

The workflow needs no stored registry credential on the dev host. Each deploy pipes the job's short-lived `GITHUB_TOKEN` (`packages: read` and `contents: read`) over SSH. The host logs in to a temporary Docker config, pulls, and deletes the config.

The packages `prizecheck-api`, `prizecheck-auth`, `prizecheck-web` and `prizecheck-scanner-index` are created private and linked to the repository by the first `images` run. If a deploy fails with `Image pull failed`, open each package on GitHub, go to **Package settings → Manage Actions access**, and give `ry-cen/prizecheck` **Read**. A deploy also pulls the `scanner-index` image, so the card scanner's index job is ready to run; start it by hand with `prizecheck-deploy.sh compose run --rm scanner-index`.

Optionally, for manual pulls (deploying a specific older commit by hand), store a persistent read-only login. Use a classic personal access token with only the `read:packages` scope:

```bash
DOCKER_CONFIG=/srv/prizecheck-dev/docker-config docker login ghcr.io -u YOUR_GITHUB_USER
```

The script uses this config only when CI hasn't supplied a token. Keep this read-only credential private and outside the repository.

### 6. Create the env file

Create the install directory on the dev host, then copy the example from your workstation (in a checkout of the `dev` commit you're going to deploy) as the env file. Replace `ryan-dev-vm` with the host's tailnet name or IP:

```bash
ssh root@ryan-dev-vm 'mkdir -p /srv/prizecheck-dev/bin'
```

```bash
scp deploy/host/prizecheck-dev.env.example root@ryan-dev-vm:/srv/prizecheck-dev/prizecheck.env
```

```bash
ssh root@ryan-dev-vm 'chmod 600 /srv/prizecheck-dev/prizecheck.env'
```

Generate three distinct secrets, one per command run:

```bash
openssl rand -hex 32
```

Edit `prizecheck.env` (for example `nano /srv/prizecheck-dev/prizecheck.env`):

| Variable               | Value                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PRIZECHECK_DATA_DIR`  | `/srv/prizecheck-dev/data`                                                                                        |
| `PRIZECHECK_WEB_PORT`  | A free loopback port. Set `18088` (Compose defaults to `8088`); check with `ss -ltn \| grep 18088`                |
| `PUBLIC_ORIGIN`        | The exact URL from step 4, e.g. `https://ryan-dev-vm.tail791645.ts.net`. Use the exact origin served by Tailscale |
| `OWNER_EMAIL`          | The address you sign in with                                                                                      |
| `POSTGRES_PASSWORD`    | A secret (letters and digits only, at least 32 characters; it's embedded in a connection URL)                     |
| `BETTER_AUTH_SECRET`   | A secret                                                                                                          |
| `INTERNAL_AUTH_SECRET` | A secret                                                                                                          |
| `MAIL_MODE`            | Keep `file`, unless you have an HTTP mail relay (then set the three `MAIL_*` relay values)                        |

These values stay in this file only. They aren't in the repository or GitHub, and the deploy script reads individual keys without printing them. Don't reuse them for production.

`setup` (step 9) creates the data directories and checks this file with `check-config`; its report names the key at fault, never the value.

### 7. Generate the SSH deployment key

On your workstation, create a key used only for this:

```bash
ssh-keygen -t ed25519 -N '' -C prizecheck-dev-deploy -f prizecheck-dev-deploy
```

Install the public key on the dev host as a **forced command**. With `restrict`, the key can't open a shell, forward ports or allocate a terminal. It can only ask the deploy script for `deploy <commit> <digest>`, `rollback` or `status`; anything else is refused. Add this single line (with your public key) to root's authorized keys:

```text
from="100.64.0.0/10,fd7a:115c:a1e0::/48",restrict,command="/bin/bash <PRIZECHECK_HOME>/bin/prizecheck-deploy.sh --ssh-gate" ssh-ed25519 AAAA...your-key... prizecheck-dev-deploy
```

Replace `<PRIZECHECK_HOME>` with `/srv/prizecheck-dev` (the absolute install path). Append the line to `/root/.ssh/authorized_keys`, with `/root/.ssh` mode 0700 and `authorized_keys` mode 0600, both root-owned. The `from` restriction limits the key to tailnet source addresses. Do not use this key to copy files or open an operator shell.

Record the host key for CI's verification. On the dev host console, read its fingerprint:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

From a tailnet machine, fetch the key using the **same address CI will use** (`DEV_SSH_HOST` in step 8). The tailnet IP is the most stable choice:

```bash
ssh-keyscan -t ed25519 100.x.y.z > dev_known_hosts && ssh-keygen -lf dev_known_hosts
```

The two fingerprints must match. The content of `dev_known_hosts` becomes `DEV_SSH_KNOWN_HOSTS`. CI connects with `StrictHostKeyChecking=yes`. OpenSSH host keys persist under `/etc/ssh`; verify them again when replacing the host.

Delete the private key file from your workstation after storing it in GitHub (step 8) and testing `status` after setup (step 9).

If Tailscale SSH is enabled for the dev host node (`tailscale set --ssh`), tailscaled answers port 22 on the tailnet address itself and never consults `authorized_keys`. The policy in step 3 doesn't grant `tag:ci` Tailscale SSH, so the deploy is denied rather than let in. Keep Tailscale SSH off on this node, so CI reaches the dev host's OpenSSH.

### 8. Configure GitHub

In `ry-cen/prizecheck` → **Settings**:

1. **Environments → New environment `dev`**: under deployment branches, allow only `dev`. Optionally add yourself as a required reviewer for manual approval of each deploy.
2. **Environment secrets** (in `dev`):

   | Secret                | Value                                           |
   | --------------------- | ----------------------------------------------- |
   | `TS_OAUTH_CLIENT_ID`  | Tailscale OAuth client ID (step 3)              |
   | `TS_OAUTH_SECRET`     | Tailscale OAuth client secret (step 3)          |
   | `DEV_SSH_PRIVATE_KEY` | The content of `prizecheck-dev-deploy` (step 7) |

3. **Environment variables** (in `dev`):

   | Variable              | Value                                                    |
   | --------------------- | -------------------------------------------------------- |
   | `DEV_SSH_HOST`        | The dev host tailnet IP (or name) used for `ssh-keyscan` |
   | `DEV_SSH_USER`        | `root` (the default when unset)                          |
   | `DEV_SSH_KNOWN_HOSTS` | The content of `dev_known_hosts` (step 7)                |

4. **Repository variables** (Secrets and variables → Actions → Variables). These are read before the job enters the environment, so they must be repository-level:

   | Variable             | Value                                                                               |
   | -------------------- | ----------------------------------------------------------------------------------- |
   | `DEV_PUBLIC_URL`     | The `PUBLIC_ORIGIN` from step 6 (shown as the deployment link)                      |
   | `DEV_DEPLOY_ENABLED` | `true`. Set this last; until then `verify` and `images` run but `deploy` is skipped |

The workflow uses the job's own `GITHUB_TOKEN` for GHCR. Grants are per job: `contents: read` for `verify`, `images` and `deploy`, `packages: write` only for `images`, `packages: read` for `deploy`, and none for `rollback`. Third-party actions are pinned to commit SHAs.

## Part 2. Install the host files and run `setup`

`setup` is the one command that prepares the host. It does every step a root script can do safely, can be run as often as you like, and changes nothing the second time. Run it again after every change to a host file.

### 9. Install the host files and run `setup`

From your workstation, in a checkout of the `dev` commit you're going to deploy, copy the host files. Replace `ryan-dev-vm` with the host's tailnet name or IP:

```bash
scp compose.deploy.yml root@ryan-dev-vm:/srv/prizecheck-dev/compose.deploy.yml
```

```bash
scp deploy/host/prizecheck-deploy.sh deploy/host/prizecheck-catalog-refresh.service deploy/host/prizecheck-catalog-refresh.timer deploy/host/prizecheck-backup.service deploy/host/prizecheck-backup.timer deploy/host/prizecheck-dev.env.example root@ryan-dev-vm:/srv/prizecheck-dev/bin/
```

The script finds its home as the parent of its `bin/` directory, so keep that layout. The four unit files go in `bin/` too; they are part of the digest CI checks, and `setup` renders their service paths for this install and installs them in systemd.

Run `setup` on the dev host:

```bash
bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh setup
```

`setup` stops with an error if the env file (step 6) is missing. Otherwise it:

- creates `data/` (PostgreSQL, the public projection store, mail, card art), `state/`, `backups/`, `signup/` and `signup-active/`, with the owners the containers need. `data/art/` holds the card pictures the API fetched from TCGdex on first request (ADR 0020); it is regenerable, so `backup` leaves it out on purpose, and deploys refuse to run without it;
- installs and enables the backup and catalog-refresh systemd timers (below);
- ends with the readiness report, which `setup` also runs for you. Run it alone with `bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh readiness`.

The report prints one line per item, `ok`, `missing` or `warning`, with the command for each item that is not ok. It exits non-zero while a prerequisite for the first deploy is missing: Docker or the Compose plugin, or the env file and its `check-config` checks. Tailscale is checked as a warning only, because the detection can be wrong (it cannot see a Tailscale that runs in a container). It never prints a value from the env file.

`check-config` runs the env file checks without the report (no containers are touched; with Docker Compose installed, it also checks that the rendered configuration publishes the web port on your `PRIZECHECK_WEB_BIND` address only):

```bash
bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh check-config
```

Any `ERROR:` line names the key or file at fault, never its value; fix it and run `setup` again. Once setup succeeds, test the restricted CI key from a tailnet machine (using the same verified address as `DEV_SSH_HOST`):

```bash
ssh -i prizecheck-dev-deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes root@100.x.y.z status
```

Only `status`, `rollback` and the validated deploy command are permitted; use your operator key for installation commands.

**Systemd schedules.** `setup` installs `prizecheck-backup.timer` (03:17 UTC) and `prizecheck-catalog-refresh.timer` (04:00 UTC), with randomized delay and persistent catch-up. Verify them:

```bash
systemctl list-timers 'prizecheck-*'
journalctl -u prizecheck-backup.service -u prizecheck-catalog-refresh.service
```

The refresh imports prices, checks for catalog changes and runs the scanner index. The backup dumps PostgreSQL and archives the public store. Before the first deploy both jobs log that nothing is deployed and exit successfully. Service paths are rendered from this host's install directory; do not install the repository units directly with their production paths.

## Part 3. Follow the readiness report

When the report says `This host is ready for the first deploy`, deploy. After the first deploy, `setup` or `readiness` also reads the app's state through the release's own tools image and lists what is left, each with its command:

| Report item            | Step                                                     |
| ---------------------- | -------------------------------------------------------- |
| The owner is bound     | [12](#12-verify-the-application-and-sign-in)             |
| The catalog rules      | [13](#13-apply-the-catalog-rules-and-import-the-catalog) |
| An active catalog      | [13](#13-apply-the-catalog-rules-and-import-the-catalog) |
| The last price import  | [13](#13-apply-the-catalog-rules-and-import-the-catalog) |
| The scanner index      | [13](#13-apply-the-catalog-rules-and-import-the-catalog) |
| The last catalog check | [Step 9](#9-install-the-host-files-and-run-setup)        |
| The signup mode        | Owner-only on dev                                        |

These items never fail the report: they come after the first deploy.

### 10. Read the report

Run the report whenever you want to know what is left:

```bash
bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh readiness
```

Before the first deploy it lists only the host items. Fix every `missing` line (the `next:` line under it has the command), run the report again, and go on when it says the host is ready.

### 11. Perform the initial deployment

1. Confirm the host files match the commit you'll deploy. On the dev host:

   ```bash
   bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh bundle-digest
   ```

   On your workstation, in the same commit:

   ```bash
   cat compose.deploy.yml deploy/host/prizecheck-deploy.sh deploy/host/prizecheck-catalog-refresh.service deploy/host/prizecheck-catalog-refresh.timer deploy/host/prizecheck-backup.service deploy/host/prizecheck-backup.timer | sha256sum
   ```

2. Run the workflow: **Actions → Deploy dev → Run workflow → branch `dev`, operation `deploy`** (or `gh workflow run .github/workflows/deploy-dev.yml --ref dev`). Pushing to `dev` doesn't start it. The default checks run first (formatting, lint, compilation, build and unit tests), then the images are built and the deploy runs. The deep integration suites do not gate the deploy; run them on demand from **Actions → Verify → Run workflow** with an **integration** choice, or run the full gate locally with `npm run verify`.
3. On a new installation the script applies all migrations and initializes the public projection store. It initializes the store only when the store is empty **and** nothing has been deployed before. A missing store on an existing install stops the deploy instead of silently creating an empty one; see [public projections](public-projections.md) for recovery.

### 12. Verify the application and sign in

On the dev host:

```bash
bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh status
```

```bash
curl -s http://127.0.0.1:18088/api/health
```

Use `172.17.0.1` instead of `127.0.0.1` if you set `PRIZECHECK_WEB_BIND` to the bridge address.

The deploy has already checked all of the following. A failure in any one fails the job and triggers the automatic rollback:

- every container reached `healthy`; `web` checks `/api/health` through nginx → gateway → API
- `GET /api/health` → 200, `GET /api/locations` without a session → 401, `GET /api/public/decks/unknown-smoke-token` → 404 (proves the projection store is readable)
- the served `index.html` is byte-identical to the one in the new `web` image, and every asset it references returns 200
- inside the `api` container, PostgreSQL is reachable and every migration file in the image is recorded in `schema_migration`
- each service runs the image tagged with the deployed commit

Then sign in from a tailnet device:

1. Open `PUBLIC_ORIGIN` and request a code for `OWNER_EMAIL`.
2. Read the code on the dev host:

   ```bash
   bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh sign-in-code
   ```

3. After the first sign-in, bind the owner once. Find the account id:

   ```bash
   bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh compose exec db psql -U prizecheck -d prizecheck -c 'select id, email from "user";'
   ```

   Then bind it:

   ```bash
   bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh tool /app/scripts/bind_owner.py 'ID-FROM-THE-QUERY'
   ```

From a device that is **not** on the tailnet, the URL must not resolve or connect.

### 13. Apply the catalog rules and import the catalog

A deploy applies the newest version of each catalog rule by itself ([ADR 0021](adr/0021-deploy-applies-newest-catalog-rules.md)); there is no activation step and no environment switch. It does so only once the owner is bound, so the first deploy leaves them unapplied until then. Until both are applied, the daily check records a failed check and starts no pull, and the report lists the rules as missing. Apply them now rather than waiting for the next deploy:

```bash
bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh tool /app/scripts/rule_rollout.py resume
```

It applies the newest rules, finishes any unfinished rollout and prints one line per rule. If a rollout failed, Owner controls → **Rules** shows the error; run the same command again to resume it. Then refresh, open **Owner controls**, and start the full English catalog pull. After the pull, build the scanner's index and import the first prices; the daily refresh keeps both current afterwards through its systemd timer.

```bash
bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh compose run --rm scanner-index
```

```bash
bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh tool /app/scripts/price_import_job.py --rematch
```

## Updating the host files

`compose.deploy.yml`, `prizecheck-deploy.sh` and the four unit files (the catalog refresh and the nightly backup) run on the dev host as root, so CI never ships them. A stolen deploy key can only deploy images from GHCR with the files you installed. CI sends the digest of the commit's copies, and the host refuses to deploy if its own files differ:

```text
ERROR: Host deployment files differ from commit ...; reinstall compose.deploy.yml, prizecheck-deploy.sh and the host units (docs/deployment-unraid.md, 'Updating the host files')
```

When a commit changes any of these files, repeat the `scp` commands in step 9 from that commit, run `setup`, then re-run the failed workflow run. To check the env file and host files (no containers are touched), run `prizecheck-deploy.sh check-config` on the dev host.

## Viewing logs

| What                      | Command (on the dev host)                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Deploy output             | The **Deploy on dev host** step of the workflow run                                              |
| Deploy history            | `cat /srv/prizecheck-dev/state/history.log`                                                      |
| Full deploy script output | `tail -n 200 /srv/prizecheck-dev/state/deploy.log` (kept even if the CI job lost its connection) |
| Application containers    | `bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh compose logs -f --tail 200 api auth web`      |
| Database                  | `bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh compose logs --tail 200 db`                   |
| Container state           | `bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh status`                                       |

The application logs fixed operational messages, not request URLs, codes or credentials. Use `docker ps` or the script’s `status` command to inspect containers.

## Troubleshooting

| Symptom                                          | Cause and fix                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy` job skipped                             | `DEV_DEPLOY_ENABLED` isn't the repository variable `true`, or a newer commit is now `dev`'s head (that run deploys)                                                                                                                                                         |
| Tailscale step fails                             | OAuth client lacks **Auth Keys: Write** or isn't allowed `tag:ci`; `tag:ci` missing from `tagOwners`                                                                                                                                                                        |
| `tailscale ping` or SSH times out                | The policy doesn't grant `tag:ci` → `ryan-dev-vm:22`, `DEV_SSH_HOST` is wrong, or SSH is disabled on the dev host                                                                                                                                                           |
| `Host key verification failed`                   | `DEV_SSH_KNOWN_HOSTS` doesn't match the address in `DEV_SSH_HOST`; rescan the same address (step 7). Never disable checking                                                                                                                                                 |
| `Permission denied (publickey)`                  | The authorized-keys line didn't persist (check after reboot) or has a typo; the secret must contain the whole private key, including the BEGIN/END lines                                                                                                                    |
| `Refused`                                        | Something other than `deploy`, `rollback` or `status` was sent through the forced command                                                                                                                                                                                   |
| `Host deployment files differ`                   | See [Updating the host files](#updating-the-host-files)                                                                                                                                                                                                                     |
| `Image pull failed`                              | The package doesn't grant the repository Read access (step 5)                                                                                                                                                                                                               |
| `Data directory ... is missing`                  | The array or pool isn't started, or `PRIZECHECK_DATA_DIR` is wrong. The deploy refuses to create data in the wrong place                                                                                                                                                    |
| `Public projection store ... missing`            | An existing install lost `data/public`: restore it (`backup` archives it) or follow [public projections](public-projections.md). On a first install whose store initialization failed, run `prizecheck-deploy.sh init-store <commit>` on the dev host and re-run the deploy |
| `Migration failed`                               | `scripts/migrate.py` runs all pending migrations in one transaction, so nothing was committed and the previous release was restarted. Fix forward with a new commit                                                                                                         |
| `Services did not become healthy` / `Smoke: ...` | The log shows the last 50 lines of each service and the previous release is restored. Typical causes: a wrong `PUBLIC_ORIGIN`, a port already in use, an invalid `prizecheck.env` value                                                                                     |
| Sign-in says the code was sent but none appears  | The address isn't `OWNER_EMAIL`, or the send limits were hit (one per minute, five per day). Check `sign-in-code`                                                                                                                                                           |
| Browser gets `403 Origin required`               | `PUBLIC_ORIGIN` doesn't exactly match the URL in the address bar (scheme, host and port)                                                                                                                                                                                    |

## Rolling back

Don't cancel a workflow run while its **Deploy on dev host** step is running. The host script keeps going after the connection drops (its output continues in `state/deploy.log`), but the job then reports nothing about the outcome. Check `status` and `deploy.log` on the dev host instead.

- **From GitHub:** Actions → **Deploy dev** → Run workflow → branch `dev`, operation `rollback`.
- **On the dev host:**

  ```bash
  bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh rollback
  ```

Rollback starts the previous successful release's images (kept locally), runs the same health and smoke checks, and swaps `current` and `previous`. It does **not** reverse migrations. A failed deploy already rolls back automatically.

To deploy a specific older commit by hand, use the persistent GHCR login from step 5 and the host-file digest of that commit's files:

```bash
bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh deploy FULL_40_CHAR_COMMIT "$(bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh bundle-digest)"
```

### Restoring the database

Use this when an old release can't run against the new schema, or after data damage. It replaces the dev database with a dump, and anything written after the dump is lost. Run these on the dev host with `P=/srv/prizecheck-dev/bin/prizecheck-deploy.sh`:

1. Stop the app:

   ```bash
   bash $P compose stop api auth web
   ```

2. Recreate the empty database:

   ```bash
   bash $P compose exec -T db dropdb -U prizecheck prizecheck && bash $P compose exec -T db createdb -U prizecheck prizecheck
   ```

3. Restore the dump taken before the deploy you're undoing (`backups/<time>-pre-<commit>.dump`):

   ```bash
   bash $P compose exec -T db pg_restore -U prizecheck -d prizecheck --no-owner < /srv/prizecheck-dev/backups/FILE.dump
   ```

4. Start the release that matches that schema: `rollback` if it's the previous release, otherwise the manual `deploy` command above.

If publications changed after the dump, also restore the matching `public` archive, or follow the [public projection recovery](public-projections.md).

## Backing up persistent data

- **Automatic:** before applying migrations to an existing install, each deploy writes `backups/<time>-pre-<commit>.dump` (`pg_dump -Fc`) and keeps the newest ten pre-deploy dumps. Pre-deploy and manual dumps are pruned separately (ten of each), so daily manual backups never push out the pre-migration dump a restore needs.
- **On demand:** this dumps PostgreSQL and archives the public projection store into `backups/` (card art in `art/` is regenerable and left out):

  ```bash
  bash /srv/prizecheck-dev/bin/prizecheck-deploy.sh backup
  ```

- **Nightly:** `setup` enables `prizecheck-backup.timer`; inspect failures with `systemctl status prizecheck-backup.service` and `journalctl -u prizecheck-backup.service`. Before the first deploy it exits successfully; a deployed host without a running database fails clearly.
- **Off the server:** copy `backups/` and `prizecheck.env` to separate storage. Without the env file's secrets, existing sessions and the database password are lost. The backups contain private collection data; keep them out of any shared or public location.

Don't run `backup` while a deploy is migrating; the deploy lock prevents this when both use the script. For the application's own logical backup and restore drill, which also enforces the public/private storage separation, see [local recovery](operations/local-recovery.md).

## Adding production later

Production runs on Oracle Cloud and is described in [Production deployment on Oracle Cloud](deployment-oracle.md). It reuses these images, `compose.deploy.yml` plus `compose.prod.yml`, and the same deploy script with `PRIZECHECK_ENVIRONMENT=prod` in its env file. A push to `main` deploys that commit's images: the ones a dev deploy built, or, if no dev deploy built that commit, images it builds the same way (`build-images.yml`).

The release gate and launch checks in [release](operations/release.md) and [deployment boundaries](deployment-boundaries.md) still apply to production.

## Moving dev to a new host

Use a cold copy of the whole install, not a logical backup alone: this preserves the PostgreSQL cluster, public store, `state/` release pointers, backups, `signup/`, `signup-active/` and `prizecheck.env`. Use the same PostgreSQL major version and a compatible architecture for the physical cluster. If changing architecture, plan a logical restore separately.

1. Set the repository variable `DEV_DEPLOY_ENABLED=false`. Wait for any in-flight deploy to finish. On the old host disable schedules: stop and disable `prizecheck-backup.timer` and `prizecheck-catalog-refresh.timer` on systemd; on Unraid disable both User Scripts entries. Stop running service jobs or wait for them to finish. Inspect `docker ps` for this Compose project's one-off tools, scanner-index, backup and catalog-refresh containers; wait for them to finish or stop them explicitly. No process may still write the install or data directories.
2. On the old host, run the following as root. Keep the old host stopped for the rest of the migration and afterwards.

   ```bash
   bash "$PRIZECHECK_HOME/bin/prizecheck-deploy.sh" compose down
   ```

3. Prepare the new host using steps 1–4, but leave schedules and the app stopped. Copy the **whole** old `PRIZECHECK_HOME` with numeric ownership, permissions and hidden files. If `PRIZECHECK_DATA_DIR` is outside that tree, cold-copy that directory too. From a trusted operator workstation, with a separate administrative SSH key and verified host keys:

   ```bash
   ssh root@OLD_HOST 'tar --numeric-owner -C /OLD/PRIZECHECK_HOME -cpf - .' | ssh root@ryan-dev-vm 'mkdir -p /srv/prizecheck-dev && tar --numeric-owner -C /srv/prizecheck-dev -xpf -'
   ```

   Replace `/OLD/PRIZECHECK_HOME` with the old absolute directory. Check both pipeline exits (use `set -o pipefail`) and compare the source and destination trees before proceeding. Do not start from a partial copy.

4. On the new host edit the copied `prizecheck.env`: set `PRIZECHECK_DATA_DIR=/srv/prizecheck-dev/data`, `PUBLIC_ORIGIN=https://ryan-dev-vm.tail791645.ts.net` and `PRIZECHECK_WEB_PORT=18088`. Preserve all secrets and persistent state. Remove stale `*.bak` files from the copied install after inspecting them; they can contain old secrets or obsolete paths. Do not remove PostgreSQL files, runner locks or release state.
5. From the checkout matching `state/current`, reinstall all six digest-protected host files as in step 9. Run `setup`, `check-config` and `readiness`. `setup` enables the timers, so immediately stop both timers until verification is complete; stop any catch-up service they started and wait for it to exit. Install the new forced-command deploy key and verify the new host key (step 7).
6. Start the recorded current release using the script, preserving its release and signup state:

   ```bash
   P=/srv/prizecheck-dev/bin/prizecheck-deploy.sh
   CURRENT=$(cat /srv/prizecheck-dev/state/current)
   bash "$P" deploy "$CURRENT" "$(bash "$P" bundle-digest)"
   ```

   Authenticate GHCR first as in step 5 if a manual pull needs it. Verify status, loopback health, HTTPS, owner sign-in, collections, publications, catalog and prices using steps 10–13. Check that no old-host jobs or containers restarted.

7. Update GitHub's `DEV_SSH_HOST`, `DEV_SSH_KNOWN_HOSTS`, `DEV_SSH_PRIVATE_KEY` and `DEV_PUBLIC_URL` for the new host. Re-enable the new host's timers and `DEV_DEPLOY_ENABLED` only after verification. Then retire the old host's deploy key and its Serve route. Keep its stopped data as a recovery copy until satisfied; do not restart the old app or schedules.
