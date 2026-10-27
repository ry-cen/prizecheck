#!/bin/bash
# PrizeCheck deployment driver: one script for the Unraid dev host (docs/deployment-unraid.md) and the Oracle production
# host (docs/deployment-oracle.md). Installed at $PRIZECHECK_HOME/bin/prizecheck-deploy.sh (from deploy/host/) next to
# $PRIZECHECK_HOME/compose.deploy.yml and $PRIZECHECK_HOME/prizecheck.env; production also installs compose.prod.yml.
# PRIZECHECK_ENVIRONMENT in the env file selects dev (the default) or prod.
#
# CI reaches this script only through a forced SSH command (`--ssh-gate`), which allows exactly:
#   deploy <40-hex commit> <64-hex bundle digest>   (stdin: one line "<user> <token>" for a read-only GHCR login)
#   rollback                                        (back to the previous successful release)
#   status
# The operator runs the other subcommands directly on the host (see `help`).
set -Eeuo pipefail
umask 077

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
PRIZECHECK_HOME="$(dirname "$(dirname "$SCRIPT_PATH")")"
COMPOSE_FILE="$PRIZECHECK_HOME/compose.deploy.yml"
ENV_FILE="$PRIZECHECK_HOME/prizecheck.env"
STATE_DIR="$PRIZECHECK_HOME/state"
BACKUP_DIR="$PRIZECHECK_HOME/backups"
# Persistent registry login for manual operator pulls; CI uses a throwaway one per deploy.
PERSISTENT_DOCKER_CONFIG="$PRIZECHECK_HOME/docker-config"
APP_SERVICES=(api auth web)
# Images a deploy pulls: the services above, plus the scanner index job, which is only run by hand (`compose run`) but must
# be pulled while the deploy holds its registry login.
PULL_SERVICES=(api auth web scanner-index)
API_UID=10001
AUTH_UID=1000
KEEP_BACKUPS=10
TEMP_DOCKER_CONFIG=""

# Log lines also go to $STATE_DIR/deploy.log, so a deploy whose SSH session dropped can still be followed. In gate
# mode all output is already teed there (ssh_gate), so log() doesn't write the file twice.
LOG_TO_FILE=1
log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$line" 2>/dev/null || true
  if [[ "$LOG_TO_FILE" == 1 && -d "$STATE_DIR" ]]; then
    printf '%s\n' "$line" >> "$STATE_DIR/deploy.log" 2>/dev/null || true
  fi
}
die() { log "ERROR: $*" >&2; exit 1; }

cleanup() {
  if [[ -n "$TEMP_DOCKER_CONFIG" && -d "$TEMP_DOCKER_CONFIG" ]]; then
    rm -rf -- "$TEMP_DOCKER_CONFIG"
  fi
}
trap cleanup EXIT

# --- Configuration ----------------------------------------------------------------------------------------------------

# Reads one KEY=value from the env file without sourcing it (values are never printed).
env_value() {
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  # Compose skips spaces after the `=` before it looks for a quote.
  line="${line#"${line%%[![:space:]]*}"}"
  # Quotes come off only as a matched pair, the way Compose reads them (and a trailing ` # comment` after the pair).
  # check_env_file_syntax has already refused backslashes inside quotes.
  local double='^"([^"\\]*)"([[:space:]]+#.*)?[[:space:]]*$' single="^'([^'\\]*)'([[:space:]]+#.*)?[[:space:]]*\$"
  if [[ "$line" =~ $double ]]; then
    line="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ $single ]]; then
    line="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$line"
}

# Sets COMPOSE; returns 1 when no Compose is installed.
find_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    return 1
  fi
}

compose_cmd() {
  find_compose || die "Docker Compose v2 not found; install it ($GUIDE)"
}

# Compose reads the env file with its own parser, which also accepts `export KEY=`, indented keys and `KEY: value`;
# env_value reads only `KEY=`. A line in any other form could be honoured by Compose and ignored by every check here, so
# it is refused. So is a quoted value that does not close on its own line: Compose lets it run on, swallowing the lines
# after it, while every check here reads them as settings. Compose also lets a backslash escape the closing quote, and
# skips spaces after the `=`; a backslash inside quotes and a space before the value are refused too. Names the line
# number, never its content.
check_env_file_syntax() {
  local line value number=0 key_pattern='^[A-Za-z_][A-Za-z0-9_]*='
  local double='^"[^"\\]*"([[:space:]]+#.*)?[[:space:]]*$' single="^'[^'\\]*'([[:space:]]+#.*)?[[:space:]]*\$"
  while IFS= read -r line || [[ -n "$line" ]]; do
    number=$((number + 1))
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# || "$line" =~ $key_pattern ]] \
      || die "$ENV_FILE line $number must be KEY=value, a comment or blank (no export, indentation or KEY: value)"
    if [[ "$line" =~ $key_pattern ]]; then
      value="${line#*=}"
      [[ ! "$value" =~ ^[[:space:]] ]] || die "$ENV_FILE line $number has a space between = and the value"
      if [[ "$value" == \"* && ! "$value" =~ $double ]] || [[ "$value" == \'* && ! "$value" =~ $single ]]; then
        if [[ "$value" == *\\* ]]; then
          die "$ENV_FILE line $number has a backslash inside a quoted value (escaped quotes are not supported)"
        fi
        die "$ENV_FILE line $number has a quoted value that does not close on the same line"
      fi
    fi
  done < "$ENV_FILE"
}

# Defence in depth for both environments: whatever the env file says, the rendered Compose model must publish exactly
# the web port, on $1 (the checked PRIZECHECK_WEB_BIND; always 127.0.0.1 in production). Every published port needs a
# host_ip, because Compose binds one without it on all interfaces. Skipped, with a note, where Compose is not installed
# (the repository's tests, `check-config` off-host).
check_published_ports() {
  local expected="$1" config binds published bind count=0
  if ! find_compose; then
    log "Note: Docker Compose not found; published-port check skipped"
    return 0
  fi
  config="$(PRIZECHECK_IMAGE_TAG=none "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" config --format json 2>/dev/null)" \
    || die "Docker Compose cannot render the configuration; check $ENV_FILE"
  # Port targets are numbers; volume targets are strings, so only the ports are counted.
  published="$(grep -oE '"target": *[0-9]+' <<<"$config" | wc -l | tr -d ' ')"
  binds="$(grep -oE '"host_ip": *"[^"]*"' <<<"$config" | sed -E 's/^"host_ip": *"//; s/"$//' || true)"
  while IFS= read -r bind; do
    [[ -z "$bind" ]] && continue
    [[ "$bind" == "$expected" ]] || die "The web port must be published on $expected only (PRIZECHECK_WEB_BIND)"
    count=$((count + 1))
  done <<<"$binds"
  [[ "$count" -ge 1 && "$count" -eq "$published" ]] \
    || die "The web port must be published on $expected only (PRIZECHECK_WEB_BIND)"
}

# Portable between GNU and BSD stat, so the config checks also run in the repository's tests on a Mac.
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# Sets ENVIRONMENT (dev unless the env file says prod), the compose files it uses, and the compose arguments.
read_environment() {
  ENVIRONMENT=dev
  if [[ -f "$ENV_FILE" ]]; then
    ENVIRONMENT="$(env_value PRIZECHECK_ENVIRONMENT)"; ENVIRONMENT="${ENVIRONMENT:-dev}"
  fi
  case "$ENVIRONMENT" in
    dev)
      COMPOSE_FILES=("$COMPOSE_FILE")
      GUIDE="docs/deployment-unraid.md" ;;
    prod)
      COMPOSE_FILES=("$COMPOSE_FILE" "$PRIZECHECK_HOME/compose.prod.yml")
      GUIDE="docs/deployment-oracle.md" ;;
    *) die "PRIZECHECK_ENVIRONMENT must be dev or prod" ;;
  esac
  COMPOSE_ARGS=(--project-directory "$PRIZECHECK_HOME" --env-file "$ENV_FILE")
  local file
  for file in "${COMPOSE_FILES[@]}"; do
    COMPOSE_ARGS+=(-f "$file")
  done
}

# Same value as env_value, with surrounding whitespace trimmed the way the auth gateway reads it.
trimmed_value() {
  local value
  value="$(env_value "$1")"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Production refuses what the auth gateway would reject under NODE_ENV=production (auth/src/auth.ts, server.ts,
# providers.ts) so a bad file fails here with a clear message instead of as a crash loop. Messages name keys, never values.
check_production_env() {
  local project origin mail_mode email_sign_in relay_url relay_token mail_from
  # Kept in variables: bash 3.2 (the repository's tests run on a Mac) wants a quoted-free pattern.
  local origin_pattern='^https://[A-Za-z0-9.-]+(:[0-9]+)?$'
  local relay_pattern='^https://[^/?#@]+(/[^@]*)?$'
  project="$(trimmed_value PRIZECHECK_PROJECT)"
  [[ -n "$project" && "$project" =~ ^[a-z0-9][a-z0-9_-]*$ && "$project" != prizecheck-dev ]] \
    || die "PRIZECHECK_PROJECT must be set to a project of its own (for example prizecheck-prod), not prizecheck-dev"
  origin="$(trimmed_value PUBLIC_ORIGIN)"
  [[ "$origin" =~ $origin_pattern ]] \
    || die "PUBLIC_ORIGIN must be https://host[:port] with no path in production"
  mail_mode="$(trimmed_value MAIL_MODE)"
  [[ -z "$mail_mode" || "$mail_mode" == http ]] \
    || die "MAIL_MODE must be http or empty in production: the gateway refuses file and console mail under NODE_ENV=production"
  email_sign_in="$(trimmed_value EMAIL_SIGN_IN)"
  [[ -z "$email_sign_in" || "$email_sign_in" == on || "$email_sign_in" == off ]] \
    || die "EMAIL_SIGN_IN must be on or off"
  local provider id secret providers=0
  for provider in GOOGLE DISCORD; do
    id="$(trimmed_value "${provider}_CLIENT_ID")"; secret="$(trimmed_value "${provider}_CLIENT_SECRET")"
    if [[ -n "$id" && -n "$secret" ]]; then
      providers=$((providers + 1))
    elif [[ -n "$id" || -n "$secret" ]]; then
      die "${provider}_CLIENT_ID and ${provider}_CLIENT_SECRET must be set together"
    fi
  done
  relay_url="$(trimmed_value MAIL_RELAY_URL)"
  relay_token="$(trimmed_value MAIL_RELAY_TOKEN)"
  mail_from="$(trimmed_value MAIL_FROM)"
  if [[ -n "$relay_url" ]]; then
    [[ "$relay_url" =~ $relay_pattern ]] \
      || die "MAIL_RELAY_URL must be an https URL without embedded credentials"
  fi
  local cap_key cap
  for cap_key in DAILY_SIGNUP_CAP DAILY_SEND_CAP; do
    cap="$(trimmed_value "$cap_key")"
    [[ -z "$cap" || "$cap" =~ ^[0-9]+$ ]] || die "$cap_key must be a whole number"
  done
  if [[ "$email_sign_in" == on ]]; then
    [[ -n "$relay_url" && -n "$relay_token" && -n "$mail_from" ]] \
      || die "EMAIL_SIGN_IN=on needs MAIL_RELAY_URL, MAIL_RELAY_TOKEN and MAIL_FROM in production"
  elif [[ "$providers" -eq 0 ]]; then
    die "No sign-in method: set GOOGLE_* or DISCORD_* client credentials, or EMAIL_SIGN_IN=on with a mail relay"
  fi
}

# Every check on the env file and the host's files. The only docker use is the published-port check, which is skipped
# where Compose is not installed, so `check-config` runs anywhere.
validate_config() {
  [[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE (copy deploy/host/prizecheck-<dev|prod>.env.example)"
  if [[ "$(file_mode "$ENV_FILE")" != "600" ]]; then
    die "$ENV_FILE must be mode 600"
  fi
  check_env_file_syntax
  read_environment
  local file
  for file in "${COMPOSE_FILES[@]}"; do
    [[ -f "$file" ]] || die "Missing $file"
  done
  local key
  for key in PRIZECHECK_DATA_DIR POSTGRES_PASSWORD BETTER_AUTH_SECRET INTERNAL_AUTH_SECRET OWNER_EMAIL PUBLIC_ORIGIN; do
    [[ -n "$(env_value "$key")" ]] || die "$key is not set in $ENV_FILE"
  done
  [[ "$(env_value POSTGRES_PASSWORD)" =~ ^[A-Za-z0-9]{32,}$ ]] \
    || die "POSTGRES_PASSWORD must be at least 32 letters/digits (it is embedded in a connection URL)"
  local value
  for key in POSTGRES_PASSWORD BETTER_AUTH_SECRET INTERNAL_AUTH_SECRET; do
    value="$(env_value "$key")"
    [[ "$value" != replace-with-* && "${#value}" -ge 32 ]] \
      || die "$key in $ENV_FILE is a placeholder or shorter than 32 characters"
  done
  DATA_DIR="$(env_value PRIZECHECK_DATA_DIR)"
  WEB_PORT="$(env_value PRIZECHECK_WEB_PORT)"; WEB_PORT="${WEB_PORT:-8088}"
  WEB_BIND="$(env_value PRIZECHECK_WEB_BIND)"; WEB_BIND="${WEB_BIND:-127.0.0.1}"
  if [[ "$ENVIRONMENT" == prod ]]; then
    # Docker-published ports bypass the host firewall, so only loopback keeps the app behind Caddy.
    [[ "$WEB_BIND" == 127.0.0.1 ]] \
      || die "PRIZECHECK_WEB_BIND must be 127.0.0.1 in production: Caddy on this host is the only public entry"
  elif [[ "$WEB_BIND" != 127.0.0.1 ]]; then
    # The app must stay off the LAN: loopback, or docker0's own address for a containerized Tailscale.
    local bridge
    bridge="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
    [[ -n "$bridge" && "$WEB_BIND" == "$bridge" ]] \
      || die "PRIZECHECK_WEB_BIND must be 127.0.0.1 or docker0's address (${bridge:-not found})"
  fi
  if [[ "$ENVIRONMENT" == prod ]]; then
    check_production_env
  fi
  check_published_ports "$WEB_BIND"
  REGISTRY="$(env_value PRIZECHECK_REGISTRY)"; REGISTRY="${REGISTRY:-ghcr.io/ry-cen}"
  [[ -d "$DATA_DIR" ]] || die "Data directory $DATA_DIR is missing (storage not mounted?)"
  local sub
  for sub in postgres public price-runners mail; do
    [[ -d "$DATA_DIR/$sub" ]] || die "Missing $DATA_DIR/$sub; run '$SCRIPT_PATH setup'"
  done
}

load_config() {
  validate_config
  mkdir -p "$STATE_DIR" "$BACKUP_DIR"
  compose_cmd
}

compose() {
  "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" "$@"
}

read_state() { [[ -f "$STATE_DIR/$1" ]] && cat "$STATE_DIR/$1" || true; }

write_state() {
  printf '%s\n' "$2" > "$STATE_DIR/$1.tmp"
  mv -f "$STATE_DIR/$1.tmp" "$STATE_DIR/$1"
}

take_lock() {
  exec 9>"$STATE_DIR/deploy.lock"
  flock -w 120 9 || die "Another deployment holds $STATE_DIR/deploy.lock"
}

valid_commit() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

bundle_digest() {
  read_environment
  cat "${COMPOSE_FILES[@]}" "$SCRIPT_PATH" | sha256sum | cut -d' ' -f1
}

# --- Registry -----------------------------------------------------------------------------------------------------------

# A token on stdin (from CI) logs in to a throwaway config that is deleted on exit. Sets PULL_DOCKER_CONFIG, which
# only the pull uses: exporting DOCKER_CONFIG globally can hide a Compose plugin installed under ~/.docker.
PULL_DOCKER_CONFIG=""
registry_login_from_stdin() {
  local user="" token=""
  if [[ ! -t 0 ]]; then
    IFS=' ' read -r -t 10 user token || true
  fi
  if [[ -n "$user" && -n "$token" ]]; then
    TEMP_DOCKER_CONFIG="$(mktemp -d)"
    PULL_DOCKER_CONFIG="$TEMP_DOCKER_CONFIG"
    link_cli_plugins "$TEMP_DOCKER_CONFIG"
    printf '%s' "$token" | DOCKER_CONFIG="$TEMP_DOCKER_CONFIG" docker login ghcr.io -u "$user" --password-stdin >/dev/null \
      || die "GHCR login failed"
  elif [[ -f "$PERSISTENT_DOCKER_CONFIG/config.json" ]]; then
    PULL_DOCKER_CONFIG="$PERSISTENT_DOCKER_CONFIG"
    link_cli_plugins "$PERSISTENT_DOCKER_CONFIG"
  fi
}

# Docker looks for CLI plugins under $DOCKER_CONFIG/cli-plugins; keep a Compose plugin installed in ~/.docker visible.
link_cli_plugins() {
  if [[ -d "$HOME/.docker/cli-plugins" && ! -e "$1/cli-plugins" ]]; then
    ln -s "$HOME/.docker/cli-plugins" "$1/cli-plugins"
  fi
}

pull_images() {
  if [[ -n "$PULL_DOCKER_CONFIG" ]]; then
    DOCKER_CONFIG="$PULL_DOCKER_CONFIG" "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" pull --quiet "${PULL_SERVICES[@]}"
  else
    compose pull --quiet "${PULL_SERVICES[@]}"
  fi
}

# --- Database and storage -----------------------------------------------------------------------------------------------

# First line "schema" or "empty" (does the database already hold this app?), then the release's migration files that
# the database has not applied.
migration_state() {
  compose run --rm --no-deps -T tools - <<'PY'
import os
from pathlib import Path
import psycopg
files = sorted(p.name for p in Path('/app/migrations').glob('*.sql'))
with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=10) as conn:
    exists = conn.execute("SELECT to_regclass('public.schema_migration') IS NOT NULL").fetchone()[0]
    applied = {r[0] for r in conn.execute('SELECT name FROM schema_migration')} if exists else set()
print('schema' if exists else 'empty')
for name in files:
    if name not in applied:
        print(name)
PY
}

# backup_database <label> <retention group>: pre-deploy and manual dumps are retained separately.
backup_database() {
  local label="$1" target
  target="$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$label.dump"
  log "Backing up PostgreSQL to $target"
  if ! compose exec -T db pg_dump -U prizecheck -d prizecheck -Fc > "$target.partial"; then
    rm -f -- "$target.partial"
    die "Database backup failed"
  fi
  mv -f -- "$target.partial" "$target"
  prune_backups "*-$2.dump"
}

# Keeps the newest $KEEP_BACKUPS files matching a pattern in $BACKUP_DIR.
prune_backups() {
  find "$BACKUP_DIR" -maxdepth 1 -name "$1" -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP_BACKUPS + 1)) \
    | cut -d' ' -f2- | while IFS= read -r old; do rm -f -- "$old"; done
}

store_initialized() {
  [[ -f "$DATA_DIR/public/current.json" && -f "$DATA_DIR/public/records/current.json" ]]
}

# --- Health -------------------------------------------------------------------------------------------------------------

http_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --noproxy '*' "http://$WEB_BIND:$WEB_PORT$1" || true
}

# Same checks as scripts/release.py smoke, plus schema and image identity, all over the host's loopback.
smoke() {
  local commit="$1" route actual service image
  for _ in $(seq 1 12); do
    [[ "$(http_status /api/health)" == "200" ]] && break
    sleep 5
  done
  # shellcheck disable=SC2086 # "route status" pairs
  for route in "/api/health 200" "/api/locations 401" "/api/public/decks/unknown-smoke-token 404"; do
    set -- $route
    actual="$(http_status "$1")"
    if [[ "$actual" != "$2" ]]; then
      log "Smoke: GET $1 returned $actual, expected $2"; return 1
    fi
  done
  local served bundled asset
  served="$(curl -sS --max-time 10 --noproxy '*' "http://$WEB_BIND:$WEB_PORT/")" || { log "Smoke: index unavailable"; return 1; }
  bundled="$(compose exec -T web cat /usr/share/nginx/html/index.html)" || { log "Smoke: cannot read bundled index"; return 1; }
  [[ "$served" == "$bundled" ]] || { log "Smoke: served index differs from the release image"; return 1; }
  local assets
  assets="$(grep -oE '(src|href)="/assets/[^" ]+"' <<<"$served" | sed -E 's/^(src|href)="//; s/"$//' || true)"
  [[ -n "$assets" ]] || { log "Smoke: built assets missing from index"; return 1; }
  while IFS= read -r asset; do
    actual="$(http_status "$asset")"
    [[ "$actual" == "200" ]] || { log "Smoke: $asset returned $actual"; return 1; }
  done <<<"$assets"
  # The API container itself reaches PostgreSQL and sees every migration its release ships.
  compose exec -T api python - <<'PY' || { log "Smoke: API database/schema check failed"; return 1; }
import os, sys
from pathlib import Path
import psycopg
files = {p.name for p in Path('/app/migrations').glob('*.sql')}
with psycopg.connect(os.environ['DATABASE_URL'], connect_timeout=5) as conn:
    applied = {r[0] for r in conn.execute('SELECT name FROM schema_migration')}
sys.exit(0 if files <= applied else 1)
PY
  # Modules only the detached catalog import and price runner load; /api/health never imports them.
  compose exec -T api python -c 'import app.catalog, app.catalog_import, app.price_source, app.price_runner' \
    || { log "Smoke: API background-job modules fail to import"; return 1; }
  for service in "${APP_SERVICES[@]}"; do
    image="$(docker inspect --format '{{.Config.Image}}' "$(compose ps -q "$service")" 2>/dev/null || true)"
    [[ "$image" == *":$commit" ]] || { log "Smoke: $service runs '$image', expected tag $commit"; return 1; }
  done
}

# Starts the application services on a release and checks them. Does not touch state files.
start_release() {
  local commit="$1"
  export PRIZECHECK_IMAGE_TAG="$commit"
  compose up -d --wait --wait-timeout 240 --remove-orphans "${APP_SERVICES[@]}" || { log "Services did not become healthy"; return 1; }
  smoke "$commit"
}

restore_release() {
  local commit="$1"
  if [[ -z "$commit" ]]; then
    log "No previous release; stopping application services"
    compose stop "${APP_SERVICES[@]}" || true
    return 1
  fi
  log "Restoring release $commit (database migrations are not reversed)"
  if start_release "$commit"; then
    log "Release $commit restored and healthy"
  else
    log "Restored release $commit is NOT healthy; operator attention required"
    return 1
  fi
}

prune_images() {
  local keep_current keep_previous ref
  keep_current="$(read_state current)"; keep_previous="$(read_state previous)"
  docker image ls --format '{{.Repository}}:{{.Tag}}' \
    | grep -E "^$REGISTRY/prizecheck-(api|auth|web):[0-9a-f]{40}$" \
    | while IFS= read -r ref; do
        case "$ref" in
          *":$keep_current"|*":$keep_previous") ;;
          *) docker image rm "$ref" >/dev/null 2>&1 || true ;;
        esac
      done
}

# --- Commands -----------------------------------------------------------------------------------------------------------

cmd_deploy() {
  local commit="${1:-}" expected_bundle="${2:-}"
  valid_commit "$commit" || die "deploy requires a full 40-character commit"
  [[ "$expected_bundle" =~ ^[0-9a-f]{64}$ ]] || die "deploy requires the 64-character bundle digest"
  load_config
  if [[ "$(bundle_digest)" != "$expected_bundle" ]]; then
    die "Host deployment files differ from commit $commit; reinstall ${COMPOSE_FILES[*]##*/} and prizecheck-deploy.sh ($GUIDE, 'Updating the host files')"
  fi
  take_lock
  registry_login_from_stdin
  local current; current="$(read_state current)"
  log "Deploying $commit (current: ${current:-none})"
  export PRIZECHECK_IMAGE_TAG="$commit"

  pull_images || die "Image pull failed"
  compose up -d --wait --wait-timeout 120 db || die "PostgreSQL did not become healthy"

  local state existing pending
  state="$(migration_state)" || die "Could not read migration state"
  existing="$(head -n 1 <<<"$state")"
  pending="$(tail -n +2 <<<"$state")"
  [[ "$existing" == schema || "$existing" == empty ]] || die "Unexpected migration state output"

  # Only a brand-new installation (empty database, empty store, nothing deployed) gets a fresh public store.
  local fresh_store=0
  if ! store_initialized; then
    if [[ -n "$current" || "$existing" == schema || -n "$(ls -A "$DATA_DIR/public")" ]]; then
      die "Public projection store at $DATA_DIR/public is missing or incomplete on an existing install; restore it (docs/public-projections.md). If this is a first install whose store initialization failed, run '$SCRIPT_PATH init-store $commit' on the host. Not deploying."
    fi
    fresh_store=1
  fi

  if [[ -n "$pending" ]]; then
    log "Pending migrations: $(tr '\n' ' ' <<<"$pending")"
    if [[ "$existing" == schema ]]; then
      backup_database "pre-${commit:0:12}" "pre-*"
    fi
    # Stop the old release so it never serves against a half-migrated schema (see docs/operations/release.md, 026).
    compose stop "${APP_SERVICES[@]}" || true
    if ! compose run --rm --no-deps -T tools /app/scripts/migrate.py; then
      # scripts/migrate.py applies the whole pending batch in one transaction, so nothing from this run was committed.
      log "Migration failed; no migration from this run was committed"
      restore_release "$current" || true
      die "Deployment of $commit failed during migration"
    fi
  else
    log "No pending migrations"
  fi

  if [[ "$fresh_store" == 1 ]]; then
    log "New installation: initializing the public projection store"
    compose run --rm --no-deps -T tools /app/scripts/init_public_projection.py || die "Public store initialization failed"
  fi

  if ! start_release "$commit"; then
    log "Release $commit failed its health checks; rolling back"
    compose logs --no-color --tail 50 "${APP_SERVICES[@]}" >&2 || true
    restore_release "$current" || true
    die "Deployment of $commit failed; see the log above"
  fi

  if [[ "$current" != "$commit" ]]; then
    [[ -n "$current" ]] && write_state previous "$current"
    write_state current "$commit"
  fi
  log "Deployed $commit"
  # Bookkeeping after the release is recorded must not turn a successful deploy into a failed job.
  printf '%s deploy %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" >> "$STATE_DIR/history.log" || true
  prune_images || true
}

cmd_rollback() {
  load_config
  take_lock
  local current previous
  current="$(read_state current)"; previous="$(read_state previous)"
  [[ -n "$previous" ]] || die "No previous release recorded"
  log "Rolling back from ${current:-none} to $previous. Migrations are not reversed: $previous runs against the current schema."
  if ! start_release "$previous"; then
    compose logs --no-color --tail 50 "${APP_SERVICES[@]}" >&2 || true
    [[ -n "$current" ]] && restore_release "$current" || true
    die "Rollback to $previous failed"
  fi
  write_state current "$previous"
  [[ -n "$current" ]] && write_state previous "$current"
  log "Rolled back to $previous"
  printf '%s rollback %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$previous" >> "$STATE_DIR/history.log" || true
}

cmd_status() {
  load_config
  printf 'current:  %s\nprevious: %s\n' "$(read_state current)" "$(read_state previous)"
  local current; current="$(read_state current)"
  export PRIZECHECK_IMAGE_TAG="${current:-none}"
  compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
}

cmd_setup() {
  [[ -f "$ENV_FILE" ]] || die "Create $ENV_FILE first (deploy/host/prizecheck-<dev|prod>.env.example)"
  chmod 600 "$ENV_FILE"
  read_environment
  DATA_DIR="$(env_value PRIZECHECK_DATA_DIR)"
  [[ -n "$DATA_DIR" ]] || die "Set PRIZECHECK_DATA_DIR in $ENV_FILE"
  mkdir -p "$DATA_DIR"/{postgres,public,price-runners,mail} "$STATE_DIR" "$BACKUP_DIR"
  chown "$API_UID:$API_UID" "$DATA_DIR/public" "$DATA_DIR/price-runners"
  chown "$AUTH_UID:$AUTH_UID" "$DATA_DIR/mail"
  chmod 700 "$DATA_DIR/public" "$DATA_DIR/price-runners" "$DATA_DIR/mail" "$STATE_DIR" "$BACKUP_DIR"
  compose_cmd
  log "Compose: $("${COMPOSE[@]}" version --short)"
  log "Directories ready under $DATA_DIR"
}

cmd_backup() {
  load_config
  take_lock
  local current; current="$(read_state current)"
  export PRIZECHECK_IMAGE_TAG="${current:-none}"
  backup_database manual manual
  local target
  target="$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)-public.tar.gz"
  tar -C "$DATA_DIR" -czf "$target" public
  prune_backups '*-public.tar.gz'
  log "Public projection store archived to $target"
}

# Recovery for a first install whose migrations committed but whose store initialization failed. Never for an
# install that has served data: init_public_projection.py creates a NEW empty store.
cmd_init_store() {
  local commit="${1:-}"
  valid_commit "$commit" || die "init-store requires the full commit whose images are on this host"
  load_config
  take_lock
  [[ -z "$(read_state current)" ]] || die "A release has been deployed; restore the store instead (docs/public-projections.md)"
  [[ -z "$(ls -A "$DATA_DIR/public")" ]] || die "$DATA_DIR/public is not empty; inspect it before initializing"
  export PRIZECHECK_IMAGE_TAG="$commit"
  compose run --rm --no-deps -T tools /app/scripts/init_public_projection.py || die "Public store initialization failed"
  log "Public store initialized; re-run the deploy"
}

cmd_sign_in_code() {
  load_config
  [[ "$ENVIRONMENT" != prod ]] || die "Production delivers codes by mail relay, not to a file"
  [[ -f "$DATA_DIR/mail/codes.jsonl" ]] || die "No codes delivered yet"
  tail -n "${1:-1}" "$DATA_DIR/mail/codes.jsonl"
}

cmd_check_config() {
  validate_config
  log "Configuration OK ($ENVIRONMENT)"
}

cmd_tool() {
  load_config
  local current; current="$(read_state current)"
  [[ -n "$current" ]] || die "Nothing deployed yet"
  export PRIZECHECK_IMAGE_TAG="$current"
  compose run --rm --no-deps tools "$@"
}

cmd_compose() {
  load_config
  local current; current="$(read_state current)"
  export PRIZECHECK_IMAGE_TAG="${current:-none}"
  compose "$@"
}

usage() {
  cat <<EOF
Usage: $SCRIPT_PATH <command>
  deploy <commit> <bundle-digest>  Pull, back up, migrate, start and check a release (CI)
  rollback                         Return to the previous successful release (no reverse migrations)
  status                           Show current/previous releases and containers
  setup                            Create data directories with container ownership (once)
  backup                           Dump PostgreSQL and archive the public store into $BACKUP_DIR
  init-store <commit>              First install only: initialize the public store after a failed initialization
  sign-in-code [n]                 Show the newest n delivered sign-in codes (MAIL_MODE=file)
  tool <script> [args]             Run a Python script in the current API image, e.g. tool /app/scripts/bind_owner.py <id>
  compose <args>                   Run docker compose for this stack, e.g. compose logs -f api
  check-config                     Validate the env file and host files (no containers are touched)
  bundle-digest                    Print the digest CI must send for the installed host files
EOF
}

ssh_gate() {
  # A dropped SSH session (cancelled job) must not kill a deploy between stopping the app and restarting it.
  trap '' HUP PIPE
  # tee -p keeps writing the log file after the SSH side goes away, so the script's own output never breaks.
  mkdir -p "$STATE_DIR"
  if [[ -f "$STATE_DIR/deploy.log" && "$(stat -c %s "$STATE_DIR/deploy.log")" -gt 5000000 ]]; then
    mv -f "$STATE_DIR/deploy.log" "$STATE_DIR/deploy.log.1"
  fi
  exec > >(tee -p -a "$STATE_DIR/deploy.log") 2>&1
  LOG_TO_FILE=0
  local words=()
  read -r -a words <<<"${SSH_ORIGINAL_COMMAND:-}"
  case "${words[0]:-}" in
    deploy)
      [[ "${#words[@]}" -eq 3 ]] || die "Refused"
      cmd_deploy "${words[1]}" "${words[2]}" ;;
    rollback)
      [[ "${#words[@]}" -eq 1 ]] || die "Refused"
      cmd_rollback < /dev/null ;;
    status)
      [[ "${#words[@]}" -eq 1 ]] || die "Refused"
      cmd_status < /dev/null ;;
    *) die "Refused" ;;
  esac
}

main() {
  local command="${1:-help}"
  shift || true
  case "$command" in
    --ssh-gate) ssh_gate ;;
    deploy) cmd_deploy "$@" ;;
    rollback) cmd_rollback ;;
    status) cmd_status ;;
    setup) cmd_setup ;;
    backup) cmd_backup ;;
    sign-in-code) cmd_sign_in_code "$@" ;;
    init-store) cmd_init_store "$@" ;;
    tool) cmd_tool "$@" ;;
    compose) cmd_compose "$@" ;;
    check-config) cmd_check_config ;;
    bundle-digest) bundle_digest ;;
    help|-h|--help) usage ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
