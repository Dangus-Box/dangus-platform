#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
id="test-register-$$"
cleanup() { docker rm -f "$id-edge" "$id-server" "$id-db" "$id-umami" "$id-umami-db" >/dev/null 2>&1 || true; docker network rm "$id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
image() { grep -o "$1:[^ ]*" "$root/infra/ops/deploy.yml" | head -1; }
export UNLEASH_ADMIN_PASSWORD=test-password-25 UMAMI_ADMIN_PASSWORD=test-password-25
export UNLEASH_BACKEND_TOKEN='default:production.test-edge-token-25'
docker network create "$id" >/dev/null
docker run -d --name "$id-db" --network "$id" -e POSTGRES_DB=unleash -e POSTGRES_USER=unleash -e POSTGRES_PASSWORD=test "$(image postgres)" >/dev/null
docker run -d --name "$id-umami-db" --network "$id" -e POSTGRES_DB=umami -e POSTGRES_USER=umami -e POSTGRES_PASSWORD=test "$(image postgres)" >/dev/null
for db in "$id-db" "$id-umami-db"; do for _ in {1..60}; do docker exec "$db" pg_isready >/dev/null 2>&1 && break; sleep 1; done; done
docker run -d --name "$id-server" --network "$id" -p 127.0.0.1::4242 -e DATABASE_URL="postgres://unleash:test@$id-db:5432/unleash" -e DATABASE_SSL=false -e UNLEASH_DEFAULT_ADMIN_USERNAME=admin -e UNLEASH_DEFAULT_ADMIN_PASSWORD="$UNLEASH_ADMIN_PASSWORD" -e INIT_CLIENT_API_TOKENS="$UNLEASH_BACKEND_TOKEN" "$(image unleashorg/unleash-server)" >/dev/null
docker run -d --name "$id-umami" --network "$id" -p 127.0.0.1::3000 -e DATABASE_URL="postgresql://umami:test@$id-umami-db:5432/umami" -e APP_SECRET=test-secret "$(image ghcr.io/umami-software/umami)" >/dev/null
export UNLEASH_URL="http://$(docker port "$id-server" 4242)" UMAMI_URL="http://$(docker port "$id-umami" 3000)"
for _ in {1..120}; do curl -fsS "$UNLEASH_URL/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$UNLEASH_URL/health" >/dev/null
docker exec -e UMAMI_ADMIN_PASSWORD "$id-umami" node -e "$(cat "$root/infra/ops/admin.js")"
docker run -d --name "$id-edge" --network "$id" -p 127.0.0.1::3063 -e DISABLE_TOKENS_ENDPOINT=true -e DISABLE_FEATURES_ENDPOINT=true -e DISABLE_METRICS_ENDPOINT=true -e DISABLE_METRICS_BATCH_ENDPOINT=true -e DISABLE_INSTANCE_DATA_ENDPOINT=true -e UPSTREAM_URL="http://$id-server:4242" -e TOKENS="$UNLEASH_BACKEND_TOKEN" "$(image unleashorg/unleash-edge)" edge >/dev/null
export EDGE_URL="http://$(docker port "$id-edge" 3063)"
bun "$root/infra/ops/test/register-e2e.ts"
