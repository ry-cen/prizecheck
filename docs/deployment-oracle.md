# Production deployment on Oracle Cloud

Every push to `main` deploys PrizeCheck to an Oracle Cloud Ampere A1 instance (Ubuntu 24.04, linux/arm64). The site is public on your own domain, served by Caddy with a Let's Encrypt certificate. SSH is reachable only over your Tailscale tailnet.

Production never builds images. `main` is only ever fast-forwarded from `dev`, so every commit on it was built and verified by the **Deploy dev** workflow. The **Deploy prod** workflow checks that those images exist for the exact commit, with a linux/arm64 entry for every service, and deploys them. A `main` commit that dev did not build (or built before multi-arch images existed) cannot be deployed.

This guide is for a fresh instance. The dev environment is described in [Dev deployment on Unraid](deployment-unraid.md); production reuses its images, `compose.deploy.yml` and deploy script.

## How it works

```
push to main
  └─ GitHub Actions: Deploy prod (.github/workflows/deploy-prod.yml)
       ├─ images   wait (up to 60 minutes, only while Deploy dev is still running for this commit) until the
       │           :<commit> index of api, auth, web and scanner-index has a linux/arm64 entry; fail otherwise
       └─ deploy   join the tailnet as tag:ci-prod (ephemeral) → SSH to the Oracle host with a forced command
                     └─ prizecheck-deploy.sh deploy <commit> <host-file digest>
                          ├─ pull the :<commit> images (one-time GHCR login, deleted afterwards)
                          ├─ start PostgreSQL and list pending migrations
                          ├─ if any are pending: pg_dump, stop the app, run scripts/migrate.py
                          ├─ new install only: initialize the public projection store
                          ├─ start api → auth → web and wait for their health checks
                          ├─ smoke checks over loopback
                          └─ pass: record the release · fail: bring the previous release back, fail the job
                   └─ check the public site: GET <PROD_PUBLIC_URL>/api/health must return 2xx
```

The deploy script's steps are the same as on dev (see [Dev deployment on Unraid](deployment-unraid.md#how-it-works)). What differs in production:

- `compose.prod.yml` is added to `compose.deploy.yml` whenever the env file says `PRIZECHECK_ENVIRONMENT=prod`. It forces `NODE_ENV=production`, defaults `MAIL_MODE` to `http`, defaults `MARKETPLACE_MATCHING` to `off`, and pins the edge network.
- The script refuses a configuration the auth gateway would reject under `NODE_ENV=production`, or one that would publish the web port beyond loopback.
- Caddy on the host is the only public entry. It forwards to the `web` container's loopback port, `127.0.0.1:8088`.

### The client-address chain

The auth gateway's per-IP limits (signups, code sends, public reads) need the visitor's real address. The chain is:

1. Caddy sets `X-Real-IP` to the visitor's address, overwriting anything the visitor sent.
2. Caddy reaches `web` through Docker's published loopback port. nginx sees the connection come from the edge network's gateway, `10.201.80.1`, and trusts `X-Real-IP` only from that address.
3. nginx forwards the resolved address to the auth gateway as `X-Real-IP` and strips `X-Forwarded-For`. The gateway trusts it only from the `web` container's fixed address, `10.201.80.10` (`TRUSTED_PROXY_IPS`).

The edge network is `10.201.80.0/24` (compose network `prizecheck-prod_edge`). Step 15 verifies the chain on your host. If you later run Caddy in a container or put a CDN or proxy in front of Caddy, the chain must be revisited.

### What the repository provides and what you set up

| Implemented in this repository                                                          | One-time manual steps (this guide)                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Multi-arch images built by `.github/workflows/deploy-dev.yml`                           | Create the instance and its network rules (steps 1 and 4)       |
| `.github/workflows/deploy-prod.yml`                                                     | Tailscale on the host, policy and OAuth client (steps 2 and 10) |
| `compose.deploy.yml` and `compose.prod.yml`                                             | Docker and Compose (step 3)                                     |
| `deploy/host/prizecheck-deploy.sh` (deploy, rollback, backup, operator helpers)         | Directories and host files (step 5)                             |
| `deploy/host/prizecheck-prod.env.example`                                               | The env file and the Discord application (steps 6 and 7)        |
| `deploy/oracle/Caddyfile`, `deploy/docker/nginx.conf`                                   | The deploy key as a forced command (step 9)                     |
| Health checks, smoke checks, pre-migration backups, automatic rollback, public check    | GitHub environment, secrets and variables (step 11)             |
| Repository tests that pin the compose overlay, the Caddyfile, nginx and the host script | DNS and Caddy (step 12)                                         |
|                                                                                         | First release, owner binding, edge checks (steps 13 to 15)      |

Nothing in this guide has been run against an Oracle instance yet. Commands and messages quoted from the repository come from the files themselves; where the guide relies on behaviour of Oracle, Ubuntu, Docker, Caddy, Tailscale or Discord that the repository can't confirm, it says so.

## What you still have to supply

- **A domain**, and the ability to create an A record for it. Use DNS-only (no proxy).
- **A sign-in method valid under production.** This guide uses Discord OAuth with `EMAIL_SIGN_IN=off`, which needs no mail relay. A Google OAuth client works the same way. Email sign-in (`EMAIL_SIGN_IN=on`) would need an HTTPS mail relay, which isn't set up (see [signup readiness](signup-readiness.md)).
- **A Discord account** whose verified email address becomes `OWNER_EMAIL`.
- **An SSH key** for your first login to the instance, and a Tailscale tailnet.

Mail relay and approval codes: there's no mail relay in this setup, so the deploy script prints `WARNING: no mail relay; owner catalog approval codes cannot be delivered until MAIL_RELAY_URL, MAIL_RELAY_TOKEN and MAIL_FROM are set`. Emailed approval codes are being removed in a separate change; until then, treat that warning as expected. `MARKETPLACE_MATCHING` stays unset in production, so activating a marketplace matching rule remains an owner approval. Don't set it to `automatic`.

### Launch blockers that remain open

A working pipeline doesn't open the site to the public. Public signup stays `owner-only`: only the account whose verified email is `OWNER_EMAIL` can create an account. These items are still open, and this guide doesn't clear any of them:

- real mail delivery and public signup ([signup readiness](signup-readiness.md));
- the scanner rights check ([scanner launch checklist](planning/card-scanner/launch-checklist.md));
- the provider, storage and scheduling boundaries ([deployment boundaries](deployment-boundaries.md));
- the release gate ([release tooling](operations/release.md)).

Don't announce the site until you have worked through those documents.

## Behaviour to know about

- **Commits built before multi-arch support can't deploy.** Their images are amd64 only. The `images` job fails with `No linux/arm64 image for <services> at <commit>. Production deploys only images Deploy dev built and verified for this exact commit: move main to a dev commit whose Deploy dev images job succeeded after multi-arch builds were added.` The first production release must be a dev commit built after the change that introduced production.
- **Pushing `dev` and `main` together is fine.** The `images` job waits for the running **Deploy dev** for the same commit. It fails at once if no such run is active and the images are missing, after a five-minute grace period for the run to appear.
- **Every visitor's address reaches the gateway.** The per-IP limits are real in production, unlike on dev where everyone shares one bucket.
- **Use DNS-only.** Cloudflare's proxied ("orange cloud") records would make every visitor one of Cloudflare's addresses and defeat the per-IP limits.
- **Caddy keeps no access log.** Published-deck URLs are capability links. The Caddyfile has no `log` directive, and its global block excludes the two loggers (`http.log.error` and `http.handlers.reverse_proxy`) that would otherwise record a failed request's URI. Step 15 checks this on your host. nginx and uvicorn access logs are off as on dev.
- **Deploys with pending migrations cause downtime, and a deploy interrupts running imports.** Both work as described in the [Unraid guide](deployment-unraid.md#behaviour-to-know-about).
- **Migrations are never reversed.** See [Rolling back](#rolling-back).
- **Always Free instances can be reclaimed when idle.** Oracle may reclaim idle Always Free compute instances. Upgrading the account to Pay As You Go keeps the free shapes but is said to stop reclamation. This guide couldn't confirm that against current Oracle terms: check them before relying on it.
- **Docker publishes bypass the host firewall.** Ports Docker publishes are reachable whatever the iptables `INPUT` rules say. That is why the deploy script refuses `PRIZECHECK_WEB_BIND` other than `127.0.0.1` in production.

## 1. Create the instance

In the Oracle Cloud console, create a compute instance with these choices:

| Setting               | Choice                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Name / hostname       | `prizecheck-prod`                                                                                                                                |
| Shape                 | `VM.Standard.A1.Flex` (Ampere, linux/arm64). 2 OCPU and 12 GB memory is a reasonable start                                                       |
| Image                 | Canonical Ubuntu 24.04 (not Minimal)                                                                                                             |
| Boot volume           | About 100 GB. Enable in-transit encryption if offered                                                                                            |
| Shielded instance     | Enable Secure Boot, Measured Boot and the vTPM if offered. They're likely unavailable on A1: don't change the shape for them                     |
| Networking            | A new VCN and a new public subnet. Auto-assign a public IPv4 address. No IPv6. No network security group                                         |
| SSH keys              | Your own public key. Use key authentication only                                                                                                 |
| Public IP             | Optional but recommended: swap the auto-assigned address for a reserved public IP, so the DNS record survives an instance rebuild                |
| Instance metadata     | After creation, edit the instance and turn off the legacy metadata endpoints (require IMDSv2 only)                                               |
| Security list ingress | Keep the default TCP 22 rule only until Tailscale works (step 2). Add TCP 80 and TCP 443 from `0.0.0.0/0`, and UDP 443 from `0.0.0.0/0` (HTTP/3) |

Also turn on multi-factor authentication for your Oracle account, and keep `unattended-upgrades` enabled on the instance (it is on by default on Ubuntu).

Log in as the image's default user, `ubuntu`, with your key. The rest of this guide runs commands with `sudo` from that account unless it says otherwise:

```bash
ssh ubuntu@PUBLIC_IP
```

## 2. Install Tailscale and close port 22

On the instance, install Tailscale with its official script:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

Start it without Tailscale SSH (do not pass `--ssh`):

```bash
sudo tailscale up
```

Open the printed login URL and approve the node. In the [Tailscale admin console](https://login.tailscale.com/admin) **Machines** page, open the node's menu and choose **Disable key expiry**: an expired key would lock CI out. Note the node's tailnet address:

```bash
tailscale ip -4
```

Tailscale SSH must stay off on this node. When it's on, tailscaled answers port 22 on the tailnet address itself and never consults `authorized_keys`, so the deploy key below would be refused.

From a machine on your tailnet, confirm that SSH works over the tailnet address before you remove the public rule:

```bash
ssh ubuntu@100.x.y.z
```

Then, in the OCI console, delete the TCP 22 ingress rule from the VCN's security list. From then on the instance accepts SSH only from tailnet devices. Keep the OCI console's serial connection (Instance → Console connection) as your break-glass way in if Tailscale ever fails. Check the rule is gone by trying the public address from a device off the tailnet; the connection should time out:

```bash
ssh -o ConnectTimeout=10 ubuntu@PUBLIC_IP
```

## 3. Install Docker and the Compose plugin

These are Docker's documented apt steps for Ubuntu (see [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)); check that page if they have changed.

```bash
sudo apt update && sudo apt install -y ca-certificates curl
```

```bash
sudo install -m 0755 -d /etc/apt/keyrings && sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

```bash
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Check that Compose v2 works (the deploy script needs 2.20 or later):

```bash
docker compose version
```

Leave Docker's default settings alone. In particular, don't add `userland-proxy: false` to `/etc/docker/daemon.json` without redoing the checks in step 15.

## 4. Open ports 80 and 443 on the host

Oracle's Ubuntu images ship iptables rules that reject everything except SSH (port 22) and a few basics, on top of the VCN security list. Without a host rule, Caddy can't get a certificate and nobody can reach the site. This is how those images behave according to the project's setup notes; this guide couldn't confirm it against Oracle's documentation, so look at the file before you edit it.

```bash
sudo cat /etc/iptables/rules.v4
```

Open the file for editing:

```bash
sudo nano /etc/iptables/rules.v4
```

Add these three lines **above** the final `-A INPUT -j REJECT ...` line, next to the existing port 22 rule, so they're evaluated first:

```text
-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT
-A INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT
-A INPUT -p udp --dport 443 -j ACCEPT
```

Reboot so the persistent rules are loaded and Docker rebuilds its own chains:

```bash
sudo reboot
```

Don't run `netfilter-persistent save` while Docker is running: it would write Docker's own chains into `rules.v4` and they would come back stale. After the reboot, confirm the rules are active:

```bash
sudo iptables -S INPUT
```

Remember that this firewall does not govern ports Docker publishes. The `web` container's port is protected by being bound to `127.0.0.1`, not by these rules.

## 5. Create the directories and install the host files

Everything lives under `/opt/prizecheck-prod`:

| Path                                     | Contents                                                     |
| ---------------------------------------- | ------------------------------------------------------------ |
| `bin/prizecheck-deploy.sh`               | The deploy script                                            |
| `compose.deploy.yml`, `compose.prod.yml` | The stack and the production overlay                         |
| `prizecheck.env`                         | The env file (mode 600; step 7)                              |
| `data/`                                  | PostgreSQL, the public projection store, price runners, mail |
| `state/`, `backups/`                     | Release state and logs; database dumps and archives          |

The script finds its home as the parent of its `bin/` directory, so keep that layout. `setup` (step 7) creates `data/`, `state/` and `backups/`.

On the instance:

```bash
sudo mkdir -p /opt/prizecheck-prod/bin
```

From your workstation, in a checkout of the commit you're going to deploy (step 13), copy the host files to the `ubuntu` user's home. Use the tailnet address:

```bash
scp compose.deploy.yml compose.prod.yml deploy/host/prizecheck-deploy.sh deploy/host/prizecheck-prod.env.example deploy/oracle/Caddyfile ubuntu@100.x.y.z:
```

On the instance, install them as root:

```bash
sudo install -m 0644 compose.deploy.yml compose.prod.yml /opt/prizecheck-prod/
```

```bash
sudo install -m 0755 prizecheck-deploy.sh /opt/prizecheck-prod/bin/prizecheck-deploy.sh
```

```bash
sudo install -m 0644 prizecheck-prod.env.example /opt/prizecheck-prod/bin/prizecheck-prod.env.example
```

The `Caddyfile` stays in your home directory until step 12.

## 6. Register the Discord application

Production sign-in is Discord OAuth. Register the application before you fill in the env file, because the env file needs its credentials.

The redirect URL comes from the auth gateway's callback route, `/api/auth/callback/<provider>` (`auth/src/server.ts`; Better Auth's base path is `/api/auth`). For Discord on your domain it's:

```text
https://YOUR-DOMAIN/api/auth/callback/discord
```

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create a **New Application**.
2. Open **OAuth2**, add the redirect URL above under **Redirects**, and save. It must match `PUBLIC_ORIGIN` plus the path exactly (scheme and host).
3. Copy the **Client ID**, and reset and copy the **Client Secret**. They go in the env file as `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.

The gateway uses Better Auth's default scopes. The portal's menu names above are from memory of Discord's interface, not from the repository: check them against what you see.

`OWNER_EMAIL` must be the **verified** email address of your Discord account. The gateway accepts a Discord profile's email only when Discord marks it verified (`auth/src/providers.ts`); an unverified address is dropped and sign-in ends in an `email_not_found` refusal. Verify the address in Discord's account settings first.

Google works the same way: its redirect URL ends in `/callback/google`, and its credentials go in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Set a pair completely or not at all.

## 7. Configure the env file

On the instance:

```bash
cd /opt/prizecheck-prod && sudo cp bin/prizecheck-prod.env.example prizecheck.env && sudo chmod 600 prizecheck.env
```

Generate three distinct secrets, one per command run. Don't reuse any value from dev:

```bash
openssl rand -hex 32
```

Edit `prizecheck.env` (`sudo nano prizecheck.env`):

| Variable                                     | Value                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PRIZECHECK_ENVIRONMENT`                     | `prod`. This selects `compose.prod.yml` and the production checks                             |
| `PRIZECHECK_PROJECT`                         | `prizecheck-prod`. Never `prizecheck-dev`                                                     |
| `PRIZECHECK_DATA_DIR`                        | `/opt/prizecheck-prod/data`                                                                   |
| `PRIZECHECK_WEB_BIND`                        | `127.0.0.1`. Production refuses anything else                                                 |
| `PRIZECHECK_WEB_PORT`                        | `8088`, and the same port in the Caddyfile                                                    |
| `PRIZECHECK_REGISTRY`                        | `ghcr.io/ry-cen`                                                                              |
| `PUBLIC_ORIGIN`                              | `https://YOUR-DOMAIN`: https, host and optional port, no path                                 |
| `OWNER_EMAIL`                                | The verified email address of your Discord account (step 6)                                   |
| `POSTGRES_PASSWORD`                          | A secret (letters and digits only, at least 32 characters; it's embedded in a connection URL) |
| `BETTER_AUTH_SECRET`, `INTERNAL_AUTH_SECRET` | A secret each                                                                                 |
| `MAIL_MODE`                                  | `http`. The gateway refuses file and console mail under `NODE_ENV=production`                 |
| `EMAIL_SIGN_IN`                              | `off`. Leave the `MAIL_RELAY_*` and `MAIL_FROM` lines commented out                           |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | From step 6. Leave the `GOOGLE_*` pair empty                                                  |
| `DAILY_SEND_CAP`, `DAILY_SIGNUP_CAP`         | Whole numbers; the example's `100` is fine                                                    |
| `MARKETPLACE_MATCHING`                       | Leave it commented out, so rule activation stays owner-approved                               |

The file may contain only `KEY=value` lines, comments and blank lines. The script refuses `export KEY=...`, indented keys and `KEY: value`, and names the offending line number. Values stay in this file only: they aren't in the repository or GitHub, and the script reads individual keys without printing them.

Create the data directories with the ownership the non-root containers need:

```bash
sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh setup
```

Then validate the file without touching containers:

```bash
sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh check-config
```

A good file ends with these lines, each prefixed with a timestamp:

```text
WARNING: no mail relay; owner catalog approval codes cannot be delivered until MAIL_RELAY_URL, MAIL_RELAY_TOKEN and MAIL_FROM are set
Configuration OK (prod)
```

The warning is expected here (see [What you still have to supply](#what-you-still-have-to-supply)). Any `ERROR:` line names the key at fault, never its value; fix it and run the check again.

## 8. Allow the repository to pull the images

The `prizecheck-api`, `prizecheck-auth`, `prizecheck-web` and `prizecheck-scanner-index` packages already exist, created by the dev pipeline. No registry credential is stored on the host: each deploy pipes the job's short-lived `GITHUB_TOKEN` over SSH for one read-only login.

On GitHub, check each of the four packages: **Package settings → Manage Actions access** must give `ry-cen/prizecheck` **Read**. If the dev host already pulls them, this is already true.

## 9. Create the deploy key

On your workstation, create a key used only for production:

```bash
ssh-keygen -t ed25519 -N '' -C prizecheck-prod-deploy -f prizecheck-prod-deploy
```

Install the public key on the instance as a **forced command** in root's `authorized_keys`. The line has three restrictions: `from=` limits it to tailnet addresses, `restrict` stops shells, port forwarding and terminals, and `command=` allows only `deploy <commit> <digest>`, `rollback` or `status`. Anything else is refused. Append this single line, with your public key:

```text
from="100.64.0.0/10,fd7a:115c:a1e0::/48",restrict,command="/bin/bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh --ssh-gate" ssh-ed25519 AAAA...your-key... prizecheck-prod-deploy
```

Keep any line that is already in `/root/.ssh/authorized_keys` (Oracle's Ubuntu image puts a line there that tells root logins to use the `ubuntu` user). Append rather than overwrite:

```bash
sudo tee -a /root/.ssh/authorized_keys
```

Paste the line, press Enter, then Ctrl-D. Key login for root works under Ubuntu's default `PermitRootLogin prohibit-password`. Confirm it:

```bash
sudo sshd -T | grep permitrootlogin
```

The script runs as root because it must read data directories owned by other users with mode 700.

Record the host key for CI's verification. On the instance, read its fingerprint:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

From a tailnet machine, fetch the key using the **same address CI will use** (`PROD_SSH_HOST` in step 11), the instance's tailnet IP:

```bash
ssh-keyscan -t ed25519 100.x.y.z > oracle_known_hosts && ssh-keygen -lf oracle_known_hosts
```

The two fingerprints must match. The content of `oracle_known_hosts` becomes `PROD_SSH_KNOWN_HOSTS`. CI connects with `StrictHostKeyChecking=yes`.

Test the key from the tailnet machine. Nothing is deployed yet, so `status` may print an empty `current:` line or an error from the script. What matters is that you reach the script: `Permission denied` means the key line is wrong, and `Refused` means the forced command didn't recognise the request.

```bash
ssh -i prizecheck-prod-deploy root@100.x.y.z status
```

Delete the private key file from your workstation after storing it in GitHub (step 11).

## 10. Configure Tailscale for CI

In the [Tailscale admin console](https://login.tailscale.com/admin):

1. **Access controls**: make `tag:ci-prod` a tag that may reach only SSH on this instance. Merge this into your policy, keeping the `tag:ci` entries you already have for dev. Use the instance's tailnet IP from step 2.

   ```jsonc
   {
     "tagOwners": {
       "tag:ci-prod": ["autogroup:admin"],
     },
     "hosts": {
       "oracle": "100.x.y.z",
     },
     "grants": [
       // CI runners for production: SSH to the Oracle instance only.
       { "src": ["tag:ci-prod"], "dst": ["oracle"], "ip": ["tcp:22"] },
     ],
   }
   ```

   Don't keep or add a rule with `"src": ["*"]` or an allow-all rule: it would give `tag:ci-prod` (and every tagged device) access to everything. Tailscale's policy preview lets you check that `tag:ci-prod` reaches only `oracle:22`. A separate tag means a run on the dev branch, which holds `tag:ci`, can't reach production.

2. **Trust credentials** (Settings → OAuth clients): create an OAuth client with the **Auth Keys → Write** scope, limited to the tag `tag:ci-prod`. Copy the client ID and secret into GitHub (step 11). The action mints a short-lived, ephemeral node for each run.

## 11. Configure GitHub

In `ry-cen/prizecheck` → **Settings**:

1. **Environments → New environment `prod`**: under deployment branches, allow only `main`. Required reviewers are optional: pushing to `main` is the release authorization, so the default is to have none.
2. **Environment secrets** (in `prod`):

   | Secret                 | Value                                              |
   | ---------------------- | -------------------------------------------------- |
   | `TS_OAUTH_CLIENT_ID`   | The production Tailscale OAuth client ID (step 10) |
   | `TS_OAUTH_SECRET`      | The production Tailscale OAuth client secret       |
   | `PROD_SSH_PRIVATE_KEY` | The content of `prizecheck-prod-deploy` (step 9)   |

   These are the `prod` environment's own secrets, not the dev environment's.

3. **Environment variables** (in `prod`):

   | Variable               | Value                                             |
   | ---------------------- | ------------------------------------------------- |
   | `PROD_SSH_HOST`        | The instance's tailnet IP, used for `ssh-keyscan` |
   | `PROD_SSH_USER`        | `root` (the default when unset)                   |
   | `PROD_SSH_KNOWN_HOSTS` | The content of `oracle_known_hosts` (step 9)      |

4. **Repository variables** (Secrets and variables → Actions → Variables). These are read before the job enters the environment, so they must be repository-level:

   | Variable              | Value                                                                                    |
   | --------------------- | ---------------------------------------------------------------------------------------- |
   | `PROD_PUBLIC_URL`     | The `PUBLIC_ORIGIN` from step 7 (the deployment link and the target of the public check) |
   | `PROD_DEPLOY_ENABLED` | `true`. **Set this last, in step 13**; until then every Deploy prod job is skipped       |

Don't set `PROD_DEPLOY_ENABLED` yet: DNS and Caddy come first, because the workflow checks the public site after deploying.

## 12. Set up DNS and Caddy

Create an **A record** for your domain pointing at the instance's public (reserved) IP. Use DNS-only: no CDN proxy in front. There's no AAAA record because the instance has no IPv6.

Install Caddy from its official apt repository. These are the commands from [caddyserver.com/docs/install](https://caddyserver.com/docs/install) (Debian, Ubuntu, Raspbian, stable releases). The first `curl` line is shown there cut off in this guide's source check; the keyring file name below is taken from the following `chmod` line. Compare with the page before you run them:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
```

```bash
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
```

```bash
sudo apt update && sudo apt install -y caddy
```

Replace the example domain in the Caddyfile you copied in step 5, then install it:

```bash
sed -i 's/prizecheck\.example\.com/YOUR-DOMAIN/' Caddyfile
```

```bash
sudo install -m 0644 Caddyfile /etc/caddy/Caddyfile
```

Validate it and reload Caddy:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

```bash
sudo systemctl reload caddy
```

The Caddyfile does four things:

- It obtains and renews the certificate itself and redirects HTTP to HTTPS.
- It sends `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no preload).
- It forwards to `127.0.0.1:8088` and sets `X-Real-IP` to the visitor's address (the chain described above).
- It keeps no access log, and no compression or `Cross-Origin-*` headers: nginx owns those, including the scanner page's isolation headers.

Until the stack is deployed, Caddy answers with a 502 for the domain, which is expected. Caddy can obtain its certificate as soon as DNS resolves and ports 80 and 443 are open; see its journal if not:

```bash
journalctl -u caddy --since '10 minutes ago' --no-pager
```

## 13. Perform the first release

1. Confirm the host files match the commit you'll deploy. On the instance:

   ```bash
   sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh bundle-digest
   ```

   On your workstation, in the same commit:

   ```bash
   cat compose.deploy.yml compose.prod.yml deploy/host/prizecheck-deploy.sh | sha256sum
   ```

2. Choose the commit. It must be a `dev` commit whose **Deploy dev** run finished its `images` and `manifests` jobs, and which was built after the change that introduced production (earlier commits have no linux/arm64 images). `main` is fast-forwarded, never merged:

   ```bash
   git fetch origin && git merge-base --is-ancestor origin/main FULL_40_CHAR_DEV_COMMIT && echo fast-forward
   ```

3. Enable the pipeline. This is the last setting: in **Settings → Secrets and variables → Actions → Variables**, set the repository variable `PROD_DEPLOY_ENABLED` to `true`.

4. Move `main` to that commit. This is the release authorization:

   ```bash
   git push origin FULL_40_CHAR_DEV_COMMIT:main
   ```

   Or, if `main` is already at the commit, run **Actions → Deploy prod → Run workflow → branch `main`, operation `deploy`**.

5. Watch **Actions → Deploy prod**. The `images` job confirms a linux/arm64 entry for all four services (it waits while **Deploy dev** is still running for the commit), then `deploy` joins the tailnet, runs the script on the host and checks `GET <PROD_PUBLIC_URL>/api/health`. A missing `Strict-Transport-Security` header is a warning, not a failure.

On a new installation the script applies all migrations and initializes the public projection store, as on dev. See [public projections](public-projections.md) if the store is reported missing.

If either of the checks in step 15 fails, set `PROD_DEPLOY_ENABLED` to anything other than `true` to stop further deploys while you investigate.

## 14. Verify the application and sign in

On the instance:

```bash
sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh status
```

```bash
curl -s http://127.0.0.1:8088/api/health
```

The deploy has already checked every container's health, the smoke routes, the served `index.html` and its assets, the schema, and that each service runs the image tagged with the deployed commit; a failure in any of them fails the job and triggers the automatic rollback.

From a device **off** the tailnet and off your home network if possible, check that the public IP doesn't serve the app on the web port; the connection must fail:

```bash
curl --max-time 5 http://PUBLIC_IP:8088/api/health
```

Then sign in:

1. Open `https://YOUR-DOMAIN` and sign in with Discord, using the account whose verified email is `OWNER_EMAIL`.
2. Bind the owner once. Find the account id:

   ```bash
   sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh compose exec db psql -U prizecheck -d prizecheck -c 'select id, email from "user";'
   ```

   Then bind it:

   ```bash
   sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh tool /app/scripts/bind_owner.py 'ID-FROM-THE-QUERY'
   ```

3. Refresh, open **Owner controls**, and start the full English catalog pull.
4. After the catalog pull, build the scanner's index by hand:

   ```bash
   sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh compose run --rm scanner-index
   ```

## 15. Check the edge on the host

These two checks confirm the assumptions the client-address chain and the no-URL-logging promise rest on. Neither could be run while this guide was written, so run both once on the real host before you rely on the per-IP limits or announce the site. In a shell on the instance:

```bash
P=/opt/prizecheck-prod/bin/prizecheck-deploy.sh
```

**nginx sees peer 10.201.80.1.** First check the addresses Docker assigned. The network gateway must be `10.201.80.1`:

```bash
sudo docker network inspect prizecheck-prod_edge --format '{{(index .IPAM.Config 0).Gateway}}'
```

The `web` container must be at `10.201.80.10`:

```bash
sudo docker inspect --format '{{(index .NetworkSettings.Networks "prizecheck-prod_edge").IPAddress}}' "$(sudo bash $P compose ps -q web)"
```

Then look at a real connection. Open a connection to the published port and keep it idle for 30 seconds in the background:

```bash
bash -c 'exec 3<>/dev/tcp/127.0.0.1/8088; sleep 30' &
```

While it's open, list the connections inside the `web` container:

```bash
sudo bash $P compose exec -T web netstat -tn
```

An `ESTABLISHED` line with local address `10.201.80.10:8080` must show the foreign address `10.201.80.1:<port>`. That is the address nginx trusts for `X-Real-IP`. Docker's port proxy, if you want to see it, shows as:

```bash
ps -ef | grep '[d]ocker-proxy'
```

Its arguments name the host port and the container address (the exact flags depend on the Docker version):

```text
docker-proxy ... -host-ip 127.0.0.1 -host-port 8088 -container-ip 10.201.80.10 -container-port 8080
```

It should list `127.0.0.1:8088` forwarding to `10.201.80.10:8080`. If the gateway differs, the peer is not `10.201.80.1` (for example because Docker runs with `userland-proxy: false`), or the container isn't at `.10`, stop and report it. Don't widen the trusted addresses to make it work: the per-IP limits would then trust an address a visitor could reach.

**Caddy's journal holds no request URIs after a forced 502.** Stop `web`, request a path with a recognizable marker from outside, and start `web` again:

```bash
sudo bash $P compose stop web
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-DOMAIN/published/forced-502-marker
```

```bash
sudo bash $P compose start web
```

The request should print `502`. Now search Caddy's journal for the marker:

```bash
journalctl -u caddy --since '10 minutes ago' --no-pager | grep -c forced-502-marker
```

The count must be `0`. Caddy may well log that the upstream refused the connection, but the line must not contain the request path or the client address. If the marker appears, the Caddyfile's `log default { exclude ... }` block isn't doing its job on this Caddy version: don't announce the site, since published-deck URLs are capability links, and fix the Caddyfile first. Run `status` afterwards to confirm `web` is healthy again.

## Updating the host files

`compose.deploy.yml`, `compose.prod.yml` and `prizecheck-deploy.sh` run on the instance as root, so CI never ships them. A stolen deploy key can only deploy images from GHCR with the files you installed. CI sends the digest of the commit's copies, and the host refuses to deploy if its own differ:

```text
ERROR: Host deployment files differ from commit ...; reinstall compose.deploy.yml compose.prod.yml and prizecheck-deploy.sh (docs/deployment-oracle.md, 'Updating the host files')
```

When a commit changes any of the three files, repeat the `scp` and `install` commands in step 5 from that commit, then re-run the failed workflow run. The digest covers only those three files: `deploy/oracle/Caddyfile` isn't checked, and the deploy never touches `/etc/caddy/Caddyfile`. Reinstall and reload it yourself (step 12) when a commit changes it.

## Viewing logs

| What                      | Command (on the instance)                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Deploy output             | The **Deploy on the Oracle host** step of the workflow run                                             |
| Deploy history            | `sudo cat /opt/prizecheck-prod/state/history.log`                                                      |
| Full deploy script output | `sudo tail -n 200 /opt/prizecheck-prod/state/deploy.log` (kept even if the CI job lost its connection) |
| Application containers    | `sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh compose logs -f --tail 200 api auth web`      |
| Database                  | `sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh compose logs --tail 200 db`                   |
| Container state           | `sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh status`                                       |
| Caddy                     | `journalctl -u caddy` (certificate and service events; no request log by design)                       |

The application logs fixed operational messages, not request URLs, codes or credentials.

## Troubleshooting

| Symptom                                                                | Cause and fix                                                                                                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every Deploy prod job skipped                                          | `PROD_DEPLOY_ENABLED` isn't the repository variable `true`, or (for `deploy`) the `images` job was skipped                                                              |
| `No linux/arm64 image for ... at <commit>`                             | `main` is at a commit dev didn't build, or built before multi-arch images. Move `main` to a dev commit whose Deploy dev `images` and `manifests` jobs succeeded         |
| Tailscale step fails                                                   | OAuth client lacks **Auth Keys: Write** or isn't allowed `tag:ci-prod`; `tag:ci-prod` missing from `tagOwners`                                                          |
| `tailscale ping` or SSH times out                                      | The policy doesn't grant `tag:ci-prod` → `oracle:22`, `PROD_SSH_HOST` is wrong, or key expiry took the node off the tailnet                                             |
| `Host key verification failed`                                         | `PROD_SSH_KNOWN_HOSTS` doesn't match the address in `PROD_SSH_HOST`; rescan the same address (step 9). Never disable checking                                           |
| `Permission denied (publickey)`                                        | A typo in the `authorized_keys` line, or a `from=` that doesn't include the tailnet range; the secret must hold the whole private key, including the BEGIN/END lines    |
| `Refused`                                                              | Something other than `deploy`, `rollback` or `status` was sent through the forced command                                                                               |
| `Host deployment files differ`                                         | See [Updating the host files](#updating-the-host-files)                                                                                                                 |
| `Image pull failed`                                                    | A package doesn't grant the repository Read access (step 8)                                                                                                             |
| `PRIZECHECK_WEB_BIND must be 127.0.0.1 in production`                  | Fix `PRIZECHECK_WEB_BIND`: Caddy on the host is the only public entry                                                                                                   |
| `... line N must be KEY=value, a comment or blank`                     | A line in `prizecheck.env` uses `export`, indentation or `KEY: value`. Rewrite line N                                                                                   |
| `No sign-in method: set GOOGLE_* or DISCORD_* ...`                     | The Discord pair is empty and `EMAIL_SIGN_IN` is `off`                                                                                                                  |
| `DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must be set together`     | Set both values of the pair or neither                                                                                                                                  |
| `PUBLIC_ORIGIN must be https://host[:port] with no path in production` | Remove the path, or use https                                                                                                                                           |
| `Production delivers codes by mail relay, not to a file`               | `sign-in-code` isn't available in production. Sign in with Discord                                                                                                      |
| `Data directory ... is missing`                                        | `PRIZECHECK_DATA_DIR` is wrong or `setup` wasn't run. The deploy refuses to create data in the wrong place                                                              |
| `Public projection store ... missing`                                  | See [Dev deployment on Unraid](deployment-unraid.md#troubleshooting) and [public projections](public-projections.md); the commands are the same with this guide's paths |
| `Migration failed`                                                     | `scripts/migrate.py` runs all pending migrations in one transaction, so nothing was committed and the previous release was restarted. Fix forward with a new commit     |
| `Services did not become healthy` / `Smoke: ...`                       | The log shows the last 50 lines of each service and the previous release is restored. Typical causes: a wrong `PUBLIC_ORIGIN`, an invalid `prizecheck.env` value        |
| The public check fails after a successful deploy                       | DNS doesn't resolve to the instance, port 80 or 443 is blocked (security list or host iptables), or Caddy has no certificate yet: `journalctl -u caddy`                 |
| Browser gets `403 Origin required`                                     | `PUBLIC_ORIGIN` doesn't exactly match the URL in the address bar (scheme and host)                                                                                      |
| Sign-in with Discord is refused                                        | The redirect URL isn't registered exactly, or the Discord email isn't verified, or isn't `OWNER_EMAIL` (public signup is `owner-only`)                                  |

## Rolling back

Don't cancel a workflow run while its **Deploy on the Oracle host** step is running. The host script keeps going after the connection drops (its output continues in `state/deploy.log`), but the job then reports nothing about the outcome. Check `status` and `deploy.log` on the instance instead.

- **From GitHub:** Actions → **Deploy prod** → Run workflow → branch `main`, operation `rollback`.
- **On the instance:**

  ```bash
  sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh rollback
  ```

Rollback starts the previous successful release's images (kept locally), runs the same health and smoke checks, and swaps `current` and `previous`. It does **not** reverse migrations. A failed deploy already rolls back automatically.

To return `main` to an earlier commit as well, you would have to rewrite `main`, which this setup doesn't do for you; a rollback changes only what runs on the host until the next push to `main`.

### Restoring the database

To restore a pre-migration dump after data damage or when an old release can't run against the new schema, follow the dev procedure in [Restoring the database](deployment-unraid.md#restoring-the-database). Use this guide's paths: set `P=/opt/prizecheck-prod/bin/prizecheck-deploy.sh`, run the commands with `sudo`, and read dumps from `/opt/prizecheck-prod/backups/`. Anything written after the dump is lost.

## Backing up persistent data

- **Automatic:** before applying migrations to an existing install, each deploy writes `backups/<time>-pre-<commit>.dump` and keeps the newest ten pre-deploy dumps.
- **On demand:** this dumps PostgreSQL and archives the public projection store into `backups/`, keeping ten of each kind:

  ```bash
  sudo bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh backup
  ```

- **Nightly (recommended, not set up by the pipeline):** a root cron entry. Create it with:

  ```bash
  echo '17 3 * * * root /bin/bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh backup' | sudo tee /etc/cron.d/prizecheck-backup
  ```

**Scheduled off-host backups are not set up yet.** Nothing in this repository or the pipeline copies `backups/` or `prizecheck.env` off the instance, and the dumps sit on the same boot volume as the database. Until you set that up (for example by copying them to OCI Object Storage, your choice), a lost instance or volume loses the data. Without the env file's secrets, existing sessions and the database password are lost too. The backups contain private collection data; keep them out of any shared or public location.

Don't run `backup` while a deploy is migrating; the deploy lock prevents this when both use the script. For the application's own logical backup and restore drill, see [local recovery](operations/local-recovery.md).
