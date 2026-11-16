#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
name="backup-test-$$"
tmp=$(mktemp -d)
cleanup() { docker rm -f "$name-minio" "$name-pg" "$name-health" >/dev/null 2>&1 || true; docker network rm "$name" >/dev/null 2>&1 || true; docker run --rm -v "$tmp:/data" --entrypoint chmod "$name" -R 777 /data >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
chmod 777 "$tmp"
docker build -t "$name" infra/backup/image >/dev/null
docker network create "$name" >/dev/null
docker run -d --name "$name-minio" --network "$name" --network-alias minio -e MINIO_ROOT_USER=testaccess -e MINIO_ROOT_PASSWORD=testsecret ghcr.io/l33tlamer/minio-backup@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e server /data >/dev/null
docker run -d --name "$name-pg" --network "$name" --network-alias pg -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=produto postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929 >/dev/null
cat > "$tmp/health.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  with open('/data/pings','a') as f: f.write(self.path+'\n')
  self.send_response(200); self.end_headers()
HTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
PY
docker run -d --name "$name-health" --network "$name" --network-alias health -v "$tmp:/data" python:3.13-alpine python /data/health.py >/dev/null
for _ in $(seq 1 90); do
  if docker run --rm --network "$name" --entrypoint sh ghcr.io/l33tlamer/minio-backup@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e -c 'mc alias set local http://minio:9000 testaccess testsecret >/dev/null && mc mb --ignore-existing local/dangus-backups >/dev/null' 2>/dev/null && docker exec "$name-pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$name-pg" psql -U postgres -d produto -c "CREATE TABLE items (value text); INSERT INTO items VALUES ('backup postgres');" >/dev/null
docker run --rm --entrypoint age-keygen "$name" > "$tmp/identity" 2>/dev/null
pub=$(sed -n 's/^# public key: //p' "$tmp/identity")
docker run --rm -v "$tmp:/data" --entrypoint sqlite3 "$name" /data/input.sqlite "CREATE TABLE items (value text); INSERT INTO items VALUES ('backup sqlite');"
for type in postgres sqlite; do
  docker run --rm --network "$name" -v "$tmp:/data:ro" --entrypoint /usr/local/bin/backup.sh \
    -e BACKUP_PRODUCT=example -e BACKUP_DATABASE="$type" -e BACKUP_TYPE="$type" -e DATABASE_URL=postgres://postgres:testpass@pg/produto \
    -e SQLITE_PATH=/data/input.sqlite -e AGE_PUBLIC_KEY="$pub" -e R2_ENDPOINT=http://minio:9000 -e R2_ACCESS_KEY_ID=testaccess -e R2_SECRET_ACCESS_KEY=testsecret -e HEALTHCHECKS_URL=http://health:8000/check "$name"
done
docker run --rm --network "$name" -v "$tmp:/data" --entrypoint sh ghcr.io/l33tlamer/minio-backup@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e -c 'mc alias set local http://minio:9000 testaccess testsecret >/dev/null; mc cp --recursive local/dangus-backups/daily/example /data/download >/dev/null'
for type in postgres sqlite; do
  file=$(find "$tmp/download/example/$type" -type f | head -1)
  test -n "$file"
  docker run --rm -v "$tmp:/data" --entrypoint bash "$name" -c 'age -d -i /data/identity "$1" | gzip -d > "/data/$2.out"' _ "/data/${file#"$tmp/"}" "$type"
done
docker exec "$name-pg" createdb -U postgres restored
docker exec -i "$name-pg" psql -U postgres -d restored < "$tmp/postgres.out" >/dev/null
[[ $(docker exec "$name-pg" psql -U postgres -d restored -tAc 'SELECT value FROM items') == 'backup postgres' ]]
[[ $(docker run --rm -v "$tmp:/data" --entrypoint sqlite3 "$name" /data/sqlite.out 'SELECT value FROM items') == 'backup sqlite' ]]
[[ $(grep -c '^/check/start$' "$tmp/pings") == 2 && $(grep -c '^/check$' "$tmp/pings") == 2 ]]
if docker run --rm --network "$name" --entrypoint /usr/local/bin/backup.sh \
    -e BACKUP_PRODUCT=example -e BACKUP_DATABASE=missing -e BACKUP_TYPE=sqlite -e SQLITE_PATH=/missing \
    -e AGE_PUBLIC_KEY="$pub" -e R2_ENDPOINT=http://minio:9000 -e R2_ACCESS_KEY_ID=testaccess -e R2_SECRET_ACCESS_KEY=testsecret -e HEALTHCHECKS_URL=http://health:8000/check "$name"; then exit 1; fi
[[ $(grep -c '^/check/fail$' "$tmp/pings") == 1 ]]
if docker run --rm -v "$tmp:/data" --entrypoint age "$name" -d -i /dev/null "/data/${file#"$tmp/"}" >/dev/null 2>&1; then exit 1; fi
printf '%s\n' 'Postgres e SQLite restaurados; pings recebidos; chave pública não decripta.'
