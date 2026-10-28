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
# The operator's signup readiness proof (docs/signup-readiness.md) is edited in signup/. Only a copy this script has
# validated for the release being started goes to signup-active/<commit>.json, the one directory the auth container mounts: a gateway
# that restarts on its own (crash, reboot) must never read a proof edited after the last deploy or signup-apply.
SIGNUP_DIR="$PRIZECHECK_HOME/signup"
SIGNUP_FILE="$SIGNUP_DIR/readiness.json"
SNAPSHOT_DIR="$PRIZECHECK_HOME/signup-active"
SIGNUP_STAGE=""
# SIGNUP_MODE from the env file (set by check_signup_config); the mode a release actually gets is EFFECTIVE_SIGNUP_MODE.
SIGNUP_CONFIG=owner-only
EFFECTIVE_SIGNUP_MODE=owner-only
SIGNUP_RESOLVED_FOR=""
# Set by resolve_signup_mode when the release SIGNUP_CARRIED_TO is public only because the proof naming SIGNUP_CARRIED_FROM
# was carried forward; commit_signup_carry then moves the operator's file to the new commit once the release is recorded.
SIGNUP_CARRIED_FROM=""
SIGNUP_CARRIED_TO=""
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
  if [[ -n "$SIGNUP_STAGE" && -d "$SIGNUP_STAGE" ]]; then
    rm -rf -- "$SIGNUP_STAGE"
  fi
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
  config="$(PRIZECHECK_IMAGE_TAG=none PRIZECHECK_SIGNUP_MODE=owner-only "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" config --format json 2>/dev/null)" \
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
file_owner() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }

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

# SIGNUP_MODE in the env file is the operator's request (owner-only unless it says public). Compose never reads it: the
# script computes PRIZECHECK_SIGNUP_MODE for each release (resolve_signup_mode), so the env file may not set that.
check_signup_config() {
  if grep -qE '^PRIZECHECK_SIGNUP_MODE=' "$ENV_FILE"; then
    die "PRIZECHECK_SIGNUP_MODE is computed by the deploy script; remove it from $ENV_FILE (the key to set is SIGNUP_MODE)"
  fi
  SIGNUP_CONFIG="$(trimmed_value SIGNUP_MODE)"; SIGNUP_CONFIG="${SIGNUP_CONFIG:-owner-only}"
  case "$SIGNUP_CONFIG" in
    owner-only) ;;
    public) [[ "$ENVIRONMENT" == prod ]] || die "SIGNUP_MODE=public is for production only; this environment stays owner-only" ;;
    *) die "SIGNUP_MODE must be owner-only or public (local-public is for local rehearsal and is refused here)" ;;
  esac
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
  check_signup_config
  if [[ "$ENVIRONMENT" == prod ]]; then
    check_production_env
  fi
  check_published_ports "$WEB_BIND"
  REGISTRY="$(env_value PRIZECHECK_REGISTRY)"; REGISTRY="${REGISTRY:-ghcr.io/ry-cen}"
  [[ -d "$DATA_DIR" ]] || die "Data directory $DATA_DIR is missing (storage not mounted?)"
  local sub
  for sub in postgres public price-runners mail art; do
    [[ -d "$DATA_DIR/$sub" ]] || die "Missing $DATA_DIR/$sub; run '$SCRIPT_PATH setup'"
  done
}

load_config() {
  validate_config
  mkdir -p "$STATE_DIR" "$BACKUP_DIR"
  compose_cmd
}

# Every Compose call passes PRIZECHECK_SIGNUP_MODE explicitly: public only for the release resolve_signup_mode has just
# approved (the tag in effect), owner-only for everything else. Nothing here runs the readiness check, so a call made
# inside $(...) cannot lose its result or pollute captured output.
compose() {
  local mode=owner-only
  if [[ -n "$SIGNUP_RESOLVED_FOR" && "$SIGNUP_RESOLVED_FOR" == "${PRIZECHECK_IMAGE_TAG:-}" ]]; then
    mode="$EFFECTIVE_SIGNUP_MODE"
  fi
  PRIZECHECK_SIGNUP_MODE="$mode" "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" "$@"
}

# --- Signup readiness -------------------------------------------------------------------------------------------------

# Sets PROOF_PROBLEM and returns 1 when the operator's proof file cannot be trusted. The gateway never reads it (it reads
# the copy this script publishes), so only its writers matter: it must belong to root (or to whoever runs this script)
# and be writable by nobody else, or a different writer could open signup for a release the operator never attested.
check_signup_proof_file() {
  local me mode uid path
  me="$(id -u)"
  PROOF_PROBLEM=""
  for path in "$SIGNUP_DIR" "$SIGNUP_FILE"; do
    if [[ -L "$path" ]]; then
      PROOF_PROBLEM="$path must not be a symlink"; return 1
    fi
    if [[ ! -e "$path" ]]; then
      PROOF_PROBLEM="readiness proof $SIGNUP_FILE is missing"; return 1
    fi
    uid="$(file_owner "$path")"
    # Production requires root; elsewhere (the repository's tests) the invoking user's own files pass.
    if [[ "$uid" != 0 && ( "$ENVIRONMENT" == prod || "$uid" != "$me" ) ]]; then
      PROOF_PROBLEM="$path must be owned by root"; return 1
    fi
    mode="00$(file_mode "$path")"
    if [[ "${mode: -2:1}" == [2367] || "${mode: -1}" == [2367] ]]; then
      PROOF_PROBLEM="$path must not be group or world writable"; return 1
    fi
  done
  [[ -d "$SIGNUP_DIR" && -f "$SIGNUP_FILE" ]] || { PROOF_PROBLEM="$SIGNUP_FILE must be a regular file in a directory"; return 1; }
}

# The release's own gateway code answers whether a readiness proof is valid: signupEnabled() from the built signup
# module, run in the auth image with the environment the gateway will have. It prints one "SIGNUP_CHECK" line and exits
# 3 when the proof is not valid for the release. Only fixed messages and the proof's commit are printed, never the
# proof's text or any setting.
signup_check_js() {
  cat <<'JS'
Promise.all([import('node:fs'), import('/app/auth/signup.js')]).then(([fs, { signupEnabled }]) => {
  try {
    if (signupEnabled() === true) {
      console.log('SIGNUP_CHECK ok');
      return;
    }
    console.log('SIGNUP_CHECK signup did not enable');
    process.exit(3);
  } catch (e) {
    const message = String((e && e.message) || '');
    let reason = /^(Public )?[Ss]ignup /.test(message)
      ? message
      : 'readiness proof is unreadable or invalid JSON, or the gateway configuration is invalid';
    try {
      const proof = JSON.parse(fs.readFileSync(process.env.SIGNUP_READINESS_FILE, 'utf8'));
      if (/^[a-f0-9]{40}$/.test(String(proof.releaseCommit)) && proof.releaseCommit !== process.env.RELEASE_COMMIT) {
        reason = 'readiness proof names commit ' + proof.releaseCommit + ', not ' + process.env.RELEASE_COMMIT;
      }
    } catch (ignored) {}
    console.log('SIGNUP_CHECK ' + reason);
    process.exit(3);
  }
}, () => { console.log('SIGNUP_CHECK the release gateway code could not be loaded'); process.exit(4); });
JS
}

# Prints the commit the operator's proof names in releaseCommit (nothing when it names no 40-hex commit).
proof_named_commit() {
  grep -oE '"releaseCommit"[[:space:]]*:[[:space:]]*"[0-9a-f]{40}"' "$SIGNUP_FILE" 2>/dev/null | head -n 1 | grep -oE '[0-9a-f]{40}' || true
}

# Copies the proof $1 to $2 with its releaseCommit changed from the commit $3 to the commit $4 (both 40-hex).
copy_proof_for_commit() {
  sed -E "s/(\"releaseCommit\"[[:space:]]*:[[:space:]]*\")$3(\")/\1$4\2/" "$1" > "$2"
}

# Sets PROOF_PROBLEM and returns 1 unless the operator's proof is valid for the release $1, judged by that release's own
# image. With a commit in $2 the proof is judged as if its releaseCommit $2 read $1 (a carried-forward proof; the
# operator's file is not touched). The proof is first copied to a staging directory, which is what the check mounts (in place of the snapshot
# directory); only if that exact copy passes is it moved into signup-active/$1.json in one rename. Each release has its
# own file, so a gateway still running another release keeps the file it was started with. A check that cannot run (no
# image, no Docker, a timeout) or a failed publish counts as not valid.
signup_proof_problem() {
  local commit="$1" carry_from="${2:-}" js out line status=0 prefix=()
  PROOF_PROBLEM=""
  check_signup_proof_file || return 1
  SIGNUP_STAGE="$(mktemp -d "$PRIZECHECK_HOME/.signup-stage.XXXXXX")" || { SIGNUP_STAGE=""; PROOF_PROBLEM="cannot stage the readiness proof"; return 1; }
  chmod 755 "$SIGNUP_STAGE"
  if [[ -n "$carry_from" ]]; then
    copy_proof_for_commit "$SIGNUP_FILE" "$SIGNUP_STAGE/readiness.json" "$carry_from" "$commit" || rm -f -- "$SIGNUP_STAGE/readiness.json"
  else
    cp "$SIGNUP_FILE" "$SIGNUP_STAGE/readiness.json"
  fi
  if [[ ! -f "$SIGNUP_STAGE/readiness.json" ]] || ! chmod 644 "$SIGNUP_STAGE/readiness.json"; then
    rm -rf -- "$SIGNUP_STAGE"; SIGNUP_STAGE=""; PROOF_PROBLEM="cannot stage the readiness proof"; return 1
  fi
  js="$(signup_check_js)"
  if command -v timeout >/dev/null 2>&1; then prefix=(timeout 120); fi
  out="$(PRIZECHECK_IMAGE_TAG="$commit" PRIZECHECK_SIGNUP_MODE=public ${prefix[@]+"${prefix[@]}"} "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" \
    run --rm --no-deps -T -v "$SIGNUP_STAGE:/run/prizecheck/candidate:ro" -e SIGNUP_READINESS_FILE=/run/prizecheck/candidate/readiness.json \
    auth node -e "$js" </dev/null 2>&1)" || status=$?
  line="$(grep '^SIGNUP_CHECK ' <<<"$out" | tail -n 1 || true)"
  if [[ "$status" -eq 0 && "$line" == "SIGNUP_CHECK ok" ]]; then
    if ! mkdir -p "$SNAPSHOT_DIR" || ! chmod 755 "$SNAPSHOT_DIR"; then
      rm -rf -- "$SIGNUP_STAGE"; SIGNUP_STAGE=""; PROOF_PROBLEM="cannot publish the validated proof"; return 1
    fi
    if [[ "$(id -u)" == 0 ]]; then chown 0:0 "$SNAPSHOT_DIR" "$SIGNUP_STAGE/readiness.json" || true; fi
    mv -f -- "$SIGNUP_STAGE/readiness.json" "$SNAPSHOT_DIR/$commit.json" \
      || { rm -rf -- "$SIGNUP_STAGE"; SIGNUP_STAGE=""; PROOF_PROBLEM="cannot publish the validated proof"; return 1; }
    rm -rf -- "$SIGNUP_STAGE"; SIGNUP_STAGE=""
    if [[ ! -f "$SNAPSHOT_DIR/$commit.json" || -L "$SNAPSHOT_DIR/$commit.json" ]]; then
      PROOF_PROBLEM="cannot publish the validated proof"; return 1
    fi
    return 0
  fi
  rm -rf -- "$SIGNUP_STAGE"; SIGNUP_STAGE=""
  if [[ "$status" -eq 3 && -n "$line" && "$line" != "SIGNUP_CHECK ok" ]]; then
    PROOF_PROBLEM="${line#SIGNUP_CHECK }"
  else
    PROOF_PROBLEM="the readiness check could not run in the release's gateway image"
  fi
  return 1
}

# Removes the published proofs no running or starting gateway needs: every one except the release $1 when it is public,
# all of them when it is owner-only. Only called once the new gateway is up.
prune_signup_snapshots() {
  local file
  for file in "$SNAPSHOT_DIR"/*.json; do
    [[ -e "$file" || -L "$file" ]] || continue
    if [[ "$EFFECTIVE_SIGNUP_MODE" == public && "$file" == "$SNAPSHOT_DIR/$1.json" ]]; then continue; fi
    rm -rf -- "$file"
  done
}

# Sets EFFECTIVE_SIGNUP_MODE for the release in PRIZECHECK_IMAGE_TAG and remembers it for compose(). Public only when the
# env file asks for it and the proof is valid for this release's commit; otherwise owner-only, with the reason logged.
# The proof names exactly one commit. When it names the release that is running public (its snapshot is still there,
# because snapshots of other releases are pruned once a gateway is up), the proof is carried forward: it is checked as if
# it named this release, and commit_signup_carry updates the operator's file once the release is recorded.
resolve_signup_mode() {
  local commit="${PRIZECHECK_IMAGE_TAG:-}" named=""
  [[ -z "$commit" || "$SIGNUP_RESOLVED_FOR" != "$commit" ]] || return 0
  EFFECTIVE_SIGNUP_MODE=owner-only
  SIGNUP_CARRIED_FROM=""; SIGNUP_CARRIED_TO=""
  if [[ "$SIGNUP_CONFIG" != public ]] || ! valid_commit "$commit"; then
    SIGNUP_RESOLVED_FOR=""
    return 0
  fi
  if [[ -f "$SIGNUP_FILE" && ! -L "$SIGNUP_FILE" ]]; then named="$(proof_named_commit)"; fi
  if [[ -n "$named" && "$named" != "$commit" && "$named" == "$(read_state current)" && -f "$SNAPSHOT_DIR/$named.json" && ! -L "$SNAPSHOT_DIR/$named.json" ]]; then
    if signup_proof_problem "$commit" "$named"; then
      EFFECTIVE_SIGNUP_MODE=public
      SIGNUP_CARRIED_FROM="$named"; SIGNUP_CARRIED_TO="$commit"
      log "Signup: public for release $commit (readiness proof carried forward from $named)"
    else
      log "Signup: owner-only for release $commit; the readiness proof carried forward from $named is refused: $PROOF_PROBLEM"
    fi
  elif signup_proof_problem "$commit"; then
    EFFECTIVE_SIGNUP_MODE=public
    log "Signup: public for release $commit (readiness proof valid)"
  else
    log "Signup: owner-only for release $commit; SIGNUP_MODE=public is not applied: $PROOF_PROBLEM"
  fi
  SIGNUP_RESOLVED_FOR="$commit"
}

# Once release $1 is recorded as current and came up public by carrying the proof forward, points the operator's proof
# at it, so the next release can carry again. Atomic, root-owned, mode 600. A failure only warns: the release is already
# public through its snapshot.
commit_signup_carry() {
  local commit="$1" from="$SIGNUP_CARRIED_FROM" tmp
  [[ -n "$from" && "$SIGNUP_CARRIED_TO" == "$commit" && "$EFFECTIVE_SIGNUP_MODE" == public ]] || return 0
  SIGNUP_CARRIED_FROM=""; SIGNUP_CARRIED_TO=""
  if ! check_signup_proof_file; then
    log "Warning: the readiness proof was not updated to name release $commit: $PROOF_PROBLEM (the next release will not carry signup forward; fix it and run signup-apply)"
    return 0
  fi
  if [[ "$(proof_named_commit)" != "$from" ]]; then
    log "Warning: the readiness proof was edited during the release and no longer names $from; leaving it as it is (the next release will not carry signup forward; update the proof and run signup-apply)"
    return 0
  fi
  if tmp="$(mktemp "$SIGNUP_DIR/.readiness.XXXXXX")" \
    && chmod 600 "$tmp" \
    && { [[ "$(id -u)" != 0 ]] || chown 0:0 "$tmp"; } \
    && copy_proof_for_commit "$SIGNUP_FILE" "$tmp" "$from" "$commit" \
    && [[ "$(grep -c "\"releaseCommit\"[[:space:]]*:[[:space:]]*\"$commit\"" "$tmp")" -ge 1 ]] \
    && mv -f -- "$tmp" "$SIGNUP_FILE"; then
    log "Signup: readiness proof now names release $commit"
  else
    [[ -z "${tmp:-}" ]] || rm -f -- "$tmp"
    log "Warning: could not update $SIGNUP_FILE to name release $commit; it is public now, but the next release will not carry signup forward until the proof names $commit (edit it, then signup-apply)"
  fi
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
    DOCKER_CONFIG="$PULL_DOCKER_CONFIG" PRIZECHECK_SIGNUP_MODE=owner-only "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" pull --quiet "${PULL_SERVICES[@]}"
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
  resolve_signup_mode
  compose up -d --wait --wait-timeout 240 --remove-orphans "${APP_SERVICES[@]}" || { log "Services did not become healthy"; return 1; }
  # Other releases' published proofs are needed only until the new gateway is up.
  prune_signup_snapshots "$commit"
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
    # The new release may have applied newer catalog rules before it failed; hand back the ones $current knows, with the
    # new release's tool. The new release is broken, so a failure here is logged and the rollback goes on.
    if [[ -n "$current" && "$current" != "$commit" ]] && ! restore_rules "$commit" "$current"; then
      log "WARNING: restoring $current's catalog rules failed; Printings may show no_active_rule until the next release applies its rules"
    fi
    restore_release "$current" || true
    die "Deployment of $commit failed; see the log above"
  fi

  if [[ "$current" != "$commit" ]]; then
    [[ -n "$current" ]] && write_state previous "$current"
    write_state current "$commit"
  fi
  commit_signup_carry "$commit"
  log "Deployed $commit"
  # Bookkeeping after the release is recorded must not turn a successful deploy into a failed job.
  printf '%s deploy %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" >> "$STATE_DIR/history.log" || true
  prune_images || true
}

# restore_rules TOOL_RELEASE TARGET_RELEASE: make the catalog rules TARGET_RELEASE knows current again, with TOOL_RELEASE's
# tool (ADR 0021). The API stops first so TOOL_RELEASE cannot apply its newer rules again after the restore. A tool release
# that predates catalog rule rollout has no script; there is nothing to restore with then.
restore_rules() {
  local tool="$1" target="$2"
  PRIZECHECK_IMAGE_TAG="$tool" compose stop api || true
  if ! PRIZECHECK_IMAGE_TAG="$tool" compose run --rm --no-deps -T tools -c "import os, sys; sys.exit(not os.path.exists('/app/scripts/rule_rollout.py'))"; then
    log "Release $tool predates catalog rule rollout; not restoring catalog rules"
    return 0
  fi
  PRIZECHECK_IMAGE_TAG="$tool" compose run --rm --no-deps -T tools /app/scripts/rule_rollout.py restore --to "$target"
}

cmd_rollback() {
  load_config
  take_lock
  local current previous
  current="$(read_state current)"; previous="$(read_state previous)"
  [[ -n "$previous" ]] || die "No previous release recorded"
  log "Rolling back from ${current:-none} to $previous. Migrations are not reversed: $previous runs against the current schema."
  # Restore the catalog rules the previous release knows, with the current release's tool.
  if [[ -n "$current" ]]; then
    if ! restore_rules "$current" "$previous"; then
      restore_release "$current" || true
      die "Rollback to $previous refused: restoring its catalog rules failed; $current was restarted"
    fi
  fi
  if ! start_release "$previous"; then
    compose logs --no-color --tail 50 "${APP_SERVICES[@]}" >&2 || true
    [[ -n "$current" ]] && restore_release "$current" || true
    die "Rollback to $previous failed"
  fi
  write_state current "$previous"
  [[ -n "$current" ]] && write_state previous "$current"
  commit_signup_carry "$previous"
  log "Rolled back to $previous"
  printf '%s rollback %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$previous" >> "$STATE_DIR/history.log" || true
}

cmd_status() {
  load_config
  printf 'current:  %s\nprevious: %s\n' "$(read_state current)" "$(read_state previous)"
  local current; current="$(read_state current)"
  export PRIZECHECK_IMAGE_TAG="${current:-none}"
  compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
  # What the running gateway was started with, not a fresh judgement (signup-apply applies a changed proof).
  local running
  running="$(compose exec -T auth printenv SIGNUP_MODE 2>/dev/null </dev/null || true)"
  printf 'signup:   %s requested, gateway running %s\n' "$SIGNUP_CONFIG" "${running:-unknown}"
}

cmd_setup() {
  [[ -f "$ENV_FILE" ]] || die "Create $ENV_FILE first (deploy/host/prizecheck-<dev|prod>.env.example)"
  chmod 600 "$ENV_FILE"
  read_environment
  DATA_DIR="$(env_value PRIZECHECK_DATA_DIR)"
  [[ -n "$DATA_DIR" ]] || die "Set PRIZECHECK_DATA_DIR in $ENV_FILE"
  mkdir -p "$DATA_DIR"/{postgres,public,price-runners,mail,art} "$STATE_DIR" "$BACKUP_DIR"
  chown "$API_UID:$API_UID" "$DATA_DIR/public" "$DATA_DIR/price-runners" "$DATA_DIR/art"
  chown "$AUTH_UID:$AUTH_UID" "$DATA_DIR/mail"
  chmod 700 "$DATA_DIR/public" "$DATA_DIR/price-runners" "$DATA_DIR/mail" "$DATA_DIR/art" "$STATE_DIR" "$BACKUP_DIR"
  # The readiness proof goes in signup/; signup-active/ holds the validated copy the gateway reads (no secrets in either).
  mkdir -p "$SIGNUP_DIR" "$SNAPSHOT_DIR"
  chown 0:0 "$SIGNUP_DIR" "$SNAPSHOT_DIR"
  chmod 755 "$SIGNUP_DIR" "$SNAPSHOT_DIR"
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
  # art/ is regenerable card art (ADR 0020) and is left out on purpose
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
  if [[ "$SIGNUP_CONFIG" == public ]]; then
    check_signup_proof_file || die "SIGNUP_MODE=public: $PROOF_PROBLEM"
    # A different commit is a warning only: this release runs owner-only until the proof names it and signup-apply has run.
    local named current
    named="$(proof_named_commit)"
    current="$(read_state current)"
    if [[ -n "$current" && "$named" != "$current" ]]; then
      log "Warning: the readiness proof does not name the current release $current; until it does, signup-apply runs it owner-only and the next release will not carry signup forward"
    fi
  fi
  log "Configuration OK ($ENVIRONMENT)"
}

# Re-evaluates the readiness proof for the current release and restarts the gateway on the result, so an edited proof
# takes effect without a deploy. Compose would not restart it: a new proof changes nothing Compose compares.
cmd_signup_apply() {
  load_config
  take_lock
  local current; current="$(read_state current)"
  [[ -n "$current" ]] || die "Nothing deployed yet"
  export PRIZECHECK_IMAGE_TAG="$current"
  SIGNUP_RESOLVED_FOR=""
  local before after running
  before="$(cat "$SNAPSHOT_DIR/$current.json" 2>/dev/null || true)"
  resolve_signup_mode
  after="$(cat "$SNAPSHOT_DIR/$current.json" 2>/dev/null || true)"
  running="$(compose exec -T auth printenv SIGNUP_MODE 2>/dev/null </dev/null || true)"
  if [[ "$running" == "$EFFECTIVE_SIGNUP_MODE" && "$before" == "$after" ]]; then
    log "The gateway already runs $EFFECTIVE_SIGNUP_MODE with this proof; not restarting it"
  else
    log "Restarting the gateway; /api is unavailable for about 5 to 15 seconds"
    compose up -d --no-deps --force-recreate --wait --wait-timeout 120 auth || die "The gateway did not become healthy; see 'compose logs auth'"
  fi
  start_release "$current" || die "Release $current did not pass its checks after the restart"
  log "Signup mode for release $current: $EFFECTIVE_SIGNUP_MODE"
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
  local current running; current="$(read_state current)"
  export PRIZECHECK_IMAGE_TAG="${current:-none}"
  # Only `up` and `create` can start the gateway, so only they re-check the proof. Anything else passes the mode the
  # gateway is running now (owner-only if unknown) and prints nothing extra.
  local sub="" arg
  for arg in "$@"; do
    if [[ "$arg" != -* ]]; then sub="$arg"; break; fi
  done
  case "$sub" in
    up|create) resolve_signup_mode ;;
    *)
      if [[ "$SIGNUP_CONFIG" == public ]]; then
        running="$(compose exec -T auth printenv SIGNUP_MODE 2>/dev/null </dev/null || true)"
        if [[ "$running" == public ]]; then
          EFFECTIVE_SIGNUP_MODE=public
          SIGNUP_RESOLVED_FOR="$PRIZECHECK_IMAGE_TAG"
        fi
      fi ;;
  esac
  compose "$@"
}

usage() {
  cat <<EOF
Usage: $SCRIPT_PATH <command>
  deploy <commit> <bundle-digest>  Pull, back up, migrate, start and check a release (CI)
  rollback                         Return to the previous successful release (no reverse migrations)
  status                           Show current/previous releases, containers and the gateway's signup mode
  setup                            Create data directories with container ownership (once)
  backup                           Dump PostgreSQL and archive the public store into $BACKUP_DIR
  init-store <commit>              First install only: initialize the public store after a failed initialization
  sign-in-code [n]                 Show the newest n delivered sign-in codes (MAIL_MODE=file)
  signup-apply                     Re-check the signup readiness proof and restart the gateway on the result
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
    signup-apply) cmd_signup_apply ;;
    tool) cmd_tool "$@" ;;
    compose) cmd_compose "$@" ;;
    check-config) cmd_check_config ;;
    bundle-digest) bundle_digest ;;
    help|-h|--help) usage ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
