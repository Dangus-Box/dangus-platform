#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
id="test-ops-$$"
cleanup() { docker rm -f "$id-edge" "$id-server" "$id-db" >/dev/null 2>&1 || true; docker network rm "$id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
image() { grep -o "$1:[^ ]*" "$root/infra/ops/deploy.yml" | head -1; }
export UNLEASH_ADMIN_PASSWORD=${UNLEASH_ADMIN_PASSWORD:-test-password-14}
export UNLEASH_BACKEND_TOKEN='default:development.test-backend-token-14'
export UNLEASH_FRONTEND_TOKEN='default:development.test-frontend-token-14'
docker network create "$id" >/dev/null
docker run -d --memory 256m --cpus 0.1 --name "$id-db" --network "$id" -e POSTGRES_DB=unleash -e POSTGRES_USER=unleash -e POSTGRES_PASSWORD=test "$(image postgres)" >/dev/null
for _ in {1..60}; do docker exec "$id-db" pg_isready -U unleash >/dev/null 2>&1 && break; sleep 1; done
docker run -d --memory 768m --cpus 0.1 --name "$id-server" --network "$id" -p 127.0.0.1::4242 -e DATABASE_URL="postgres://unleash:test@$id-db:5432/unleash" -e DATABASE_SSL=false -e UNLEASH_DEFAULT_ADMIN_USERNAME=admin -e UNLEASH_DEFAULT_ADMIN_PASSWORD="$UNLEASH_ADMIN_PASSWORD" -e INIT_CLIENT_API_TOKENS="$UNLEASH_BACKEND_TOKEN" -e INIT_FRONTEND_API_TOKENS="$UNLEASH_FRONTEND_TOKEN" "$(image unleashorg/unleash-server)" >/dev/null
export UNLEASH_URL="http://$(docker port "$id-server" 4242)"
for _ in {1..120}; do curl -fsS "$UNLEASH_URL/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$UNLEASH_URL/health" >/dev/null
docker run -d --memory 128m --cpus 0.1 --name "$id-edge" --network "$id" -p 127.0.0.1::3063 -e DISABLE_TOKENS_ENDPOINT=true -e DISABLE_FEATURES_ENDPOINT=true -e DISABLE_METRICS_ENDPOINT=true -e DISABLE_METRICS_BATCH_ENDPOINT=true -e DISABLE_INSTANCE_DATA_ENDPOINT=true -e UPSTREAM_URL="http://$id-server:4242" -e TOKENS="$UNLEASH_BACKEND_TOKEN" "$(image unleashorg/unleash-edge)" edge >/dev/null
export EDGE_URL="http://$(docker port "$id-edge" 3063)"
export TEST_NETWORK="$id" TEST_SERVER="$id-server" TEST_SERVER_IMAGE="$(image unleashorg/unleash-server)"
bun "$root/infra/ops/test/unleash-e2e.ts"
