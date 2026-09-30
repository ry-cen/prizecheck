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
cleanup() {
  kill "${api_pid:-}" "${auth_pid:-}" "${web_pid:-}" 2>/dev/null || true
  rm -f "$MAIL_FILE"
}
trap cleanup EXIT
.venv/bin/python scripts/migrate.py
.venv/bin/python scripts/generate_client.py --check
npm run build
.venv/bin/uvicorn app.main:app --app-dir api --host 127.0.0.1 --port 8000 > /tmp/tcg-api-test.log 2>&1 & api_pid=$!
npx tsx auth/src/server.ts > /tmp/tcg-auth-test.log 2>&1 & auth_pid=$!
npx vite --config web/vite.config.ts > /tmp/tcg-web-test.log 2>&1 & web_pid=$!
for i in $(seq 1 50); do
  if curl -fsS http://localhost:5173/api/health >/dev/null 2>&1; then break; fi
  sleep .2
done
curl -fsS http://localhost:5173/api/health >/dev/null
PYTHONPATH=api .venv/bin/pytest -q api/tests
npm run test:auth
npx playwright test
