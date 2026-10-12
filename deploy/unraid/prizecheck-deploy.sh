#!/bin/bash
# PrizeCheck deployment driver for the Unraid host. Installed at $PRIZECHECK_HOME/bin/prizecheck-deploy.sh next to
# $PRIZECHECK_HOME/compose.deploy.yml and $PRIZECHECK_HOME/prizecheck.env. See docs/deployment-unraid.md.
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
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    die "Docker Compose v2 not found; install it (docs/deployment-unraid.md, step 2)"
  fi
}

load_config() {
  [[ -f "$COMPOSE_FILE" ]] || die "Missing $COMPOSE_FILE"
  [[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE (copy deploy/unraid/prizecheck.env.example)"
  if [[ "$(stat -c '%a' "$ENV_FILE")" != "600" ]]; then
    die "$ENV_FILE must be mode 600"
  fi
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
  # The app must stay off the LAN: loopback, or docker0's own address for a containerized Tailscale.
  if [[ "$WEB_BIND" != 127.0.0.1 ]]; then
    local bridge
    bridge="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
    [[ -n "$bridge" && "$WEB_BIND" == "$bridge" ]] \
      || die "PRIZECHECK_WEB_BIND must be 127.0.0.1 or docker0's address (${bridge:-not found})"
  fi
  REGISTRY="$(env_value PRIZECHECK_REGISTRY)"; REGISTRY="${REGISTRY:-ghcr.io/ry-cen}"
  [[ -d "$DATA_DIR" ]] || die "Data directory $DATA_DIR is missing (array or pool not mounted?)"
  local sub
  for sub in postgres public price-runners mail; do
    [[ -d "$DATA_DIR/$sub" ]] || die "Missing $DATA_DIR/$sub; run '$SCRIPT_PATH setup'"
  done
  mkdir -p "$STATE_DIR" "$BACKUP_DIR"
  compose_cmd
}

compose() {
  "${COMPOSE[@]}" --project-directory "$PRIZECHECK_HOME" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
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
  cat "$COMPOSE_FILE" "$SCRIPT_PATH" | sha256sum | cut -d' ' -f1
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
    DOCKER_CONFIG="$PULL_DOCKER_CONFIG" "${COMPOSE[@]}" --project-directory "$PRIZECHECK_HOME" -f "$COMPOSE_FILE" \
      --env-file "$ENV_FILE" pull --quiet "${APP_SERVICES[@]}"
  else
    compose pull --quiet "${APP_SERVICES[@]}"
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
    die "Host deployment files differ from commit $commit; reinstall compose.deploy.yml and prizecheck-deploy.sh (docs/deployment-unraid.md, 'Updating the host files')"
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
  [[ -f "$ENV_FILE" ]] || die "Create $ENV_FILE first (deploy/unraid/prizecheck.env.example)"
  chmod 600 "$ENV_FILE"
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
  [[ -f "$DATA_DIR/mail/codes.jsonl" ]] || die "No codes delivered yet"
  tail -n "${1:-1}" "$DATA_DIR/mail/codes.jsonl"
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
  sign-in-code [n]                 Show the newest n delivered sign-in/approval codes (MAIL_MODE=file)
  tool <script> [args]             Run a Python script in the current API image, e.g. tool /app/scripts/bind_owner.py <id>
  compose <args>                   Run docker compose for this stack, e.g. compose logs -f api
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
    bundle-digest) bundle_digest ;;
    help|-h|--help) usage ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
