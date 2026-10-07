#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?Set DATABASE_URL to a disposable PostgreSQL database}"
export OWNER_EMAIL="${OWNER_EMAIL:-owner@example.test}"
export PUBLIC_ORIGIN="http://localhost:5173"
export INTERNAL_AUTH_SECRET="test-internal-secret-abcdefghijklmnopqrstuvwxyz"
export BETTER_AUTH_SECRET="test-better-auth-secret-abcdefghijklmnopqrstuvwxyz"
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
.venv/bin/python scripts/generate_client.py --check
.venv/bin/python scripts/generate_location_client.py --check
.venv/bin/python scripts/generate_holdings_client.py --check
.venv/bin/python scripts/generate_moves_client.py --check
.venv/bin/python scripts/generate_decks_client.py --check
.venv/bin/python scripts/generate_collection_client.py --check
.venv/bin/python scripts/generate_publications_client.py --check
.venv/bin/python scripts/generate_reconciliation_client.py --check
.venv/bin/python scripts/generate_discovery_client.py --check
npm run build
PYTHONPATH="$PWD/api/tests/catalog_process_fixture:$PWD/api" .venv/bin/uvicorn app.main:app --app-dir api --host 127.0.0.1 --port 8000 --no-access-log > /tmp/tcg-api-test.log 2>&1 & api_pid=$!
node --import tsx auth/src/server.ts > /tmp/tcg-auth-test.log 2>&1 & auth_pid=$!
node node_modules/vite/bin/vite.js --config web/vite.config.ts --strictPort > /tmp/tcg-web-test.log 2>&1 & web_pid=$!
for i in $(seq 1 50); do
  kill -0 "$api_pid" "$auth_pid" "$web_pid"
  if curl -fsS http://localhost:5173/api/health >/dev/null 2>&1; then break; fi
  sleep .2
done
kill -0 "$api_pid" "$auth_pid" "$web_pid"
curl -fsS http://localhost:5173/api/health >/dev/null
PYTHONPATH=api .venv/bin/pytest -q api/tests
npm run test:auth
npx playwright test
