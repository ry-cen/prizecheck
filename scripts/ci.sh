#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL database}"
export OWNER_EMAIL="${OWNER_EMAIL:-owner@example.test}"
export PUBLIC_ORIGIN="${TEST_ORIGIN:-http://localhost:${WEB_PORT:-5173}}"
export TEST_ORIGIN="$PUBLIC_ORIGIN"
export TEST_BASE_URL="$PUBLIC_ORIGIN"
export REVIEW_BROWSER_ORIGIN="$PUBLIC_ORIGIN"
export TEST_LOG_DIR="${TEST_LOG_DIR:-$(mktemp -d)}"
export INTERNAL_AUTH_SECRET="test-internal-secret-abcdefghijklmnopqrstuvwxyz"
export BETTER_AUTH_SECRET="test-better-auth-secret-abcdefghijklmnopqrstuvwxyz"
export SIGNUP_MODE=owner-only
export PUBLIC_PROJECTION_ADAPTER=filesystem
export MAIL_MODE=file
export MAIL_FILE="$(mktemp)"
export PUBLIC_PROJECTION_DIR="$(mktemp -d)"
export CATALOG_PROCESS_FIXTURE_DIR="$(mktemp -d)"
cleanup() {
  kill "${api_pid:-}" "${auth_pid:-}" "${web_pid:-}" 2>/dev/null || true
  rm -f "$MAIL_FILE"
  rm -rf "$PUBLIC_PROJECTION_DIR" "$CATALOG_PROCESS_FIXTURE_DIR"
}
trap cleanup EXIT
.venv/bin/python scripts/migrate.py
.venv/bin/python scripts/init_public_projection.py
npm run guardrails
npm run build
case "${VERIFY_SUITE:-all}" in
  all|browser|auth)
PYTHONPATH="$PWD/api/tests/catalog_process_fixture:$PWD/api" .venv/bin/uvicorn app.main:app --app-dir api --host 127.0.0.1 --port "${API_PORT:-8000}" --no-access-log > "$TEST_LOG_DIR/api.log" 2>&1 & api_pid=$!
node --import tsx auth/src/server.ts > "$TEST_LOG_DIR/auth.log" 2>&1 & auth_pid=$!
node node_modules/vite/bin/vite.js --config web/vite.config.ts --strictPort > "$TEST_LOG_DIR/web.log" 2>&1 & web_pid=$!
for i in $(seq 1 50); do
  kill -0 "$api_pid" "$auth_pid" "$web_pid"
  if curl -fsS "$PUBLIC_ORIGIN/api/health" >/dev/null 2>&1; then break; fi
  sleep .2
done
kill -0 "$api_pid" "$auth_pid" "$web_pid"
curl -fsS "$PUBLIC_ORIGIN/api/health" >/dev/null
    ;;
  operations) ;;
  *) echo 'Unknown verification suite' >&2; exit 1 ;;
esac
case "${VERIFY_SUITE:-all}" in all) PYTHONPATH=api .venv/bin/pytest -q api/tests ;; esac
case "${VERIFY_SUITE:-all}" in all|auth) npm run test:auth ;; esac
case "${VERIFY_SUITE:-all}" in all|browser) npx playwright test "$@" ;; esac
case "${VERIFY_SUITE:-all}" in all|operations) .venv/bin/python -m unittest discover -s tests/operations -v ;; esac
