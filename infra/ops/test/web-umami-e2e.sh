#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
id="test-ops-$$"
cleanup() { docker rm -f "$id-umami" "$id-db" >/dev/null 2>&1 || true; docker network rm "$id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
image() { grep -o "$1:[^ ]*" "$root/infra/ops/deploy.yml" | head -1; }
docker network create "$id" >/dev/null
docker run -d --name "$id-db" --network "$id" --network-alias db -e POSTGRES_DB=umami -e POSTGRES_USER=umami -e POSTGRES_PASSWORD=test "$(image postgres)" >/dev/null
for _ in {1..60}; do docker exec "$id-db" pg_isready -U umami >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name "$id-umami" --network "$id" -p 127.0.0.1::3000 -e DATABASE_URL=postgresql://umami:test@db:5432/umami -e APP_SECRET=test-secret -e TRACKER_SCRIPT_NAME=t.js -e COLLECT_API_ENDPOINT=/api/e "$(image ghcr.io/umami-software/umami)" >/dev/null
export UMAMI_URL="http://$(docker port "$id-umami" 3000)"
for _ in {1..90}; do curl -fsS "$UMAMI_URL/api/heartbeat" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$UMAMI_URL/api/heartbeat" >/dev/null
bun "$root/packages/web/test/umami-e2e.ts"
