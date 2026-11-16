#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
root=$PWD
name="restore-test-$$"
tmp=$(mktemp -d)
cleanup() { docker rm -f "$name-minio" "$name-pg" "$name-health" >/dev/null 2>&1 || true; docker network rm "$name" >/dev/null 2>&1 || true; [[ -z ${health_pid:-} ]] || kill "$health_pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
minio=ghcr.io/l33tlamer/minio-backup@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e
image="$name-image"
mkdir -p "$tmp/bin" "$tmp/product"
chmod 777 "$tmp"
docker build -t "$image" infra/backup/image >/dev/null
docker create --name "$name-copy" "$image" >/dev/null
docker cp "$name-copy:/usr/bin/age" "$tmp/bin/age"
docker rm "$name-copy" >/dev/null
docker network create "$name" >/dev/null
docker run -d --name "$name-minio" --network "$name" --network-alias minio -p 127.0.0.1::9000 -e MINIO_ROOT_USER=testaccess -e MINIO_ROOT_PASSWORD=testsecret "$minio" server /data >/dev/null
docker run -d --name "$name-pg" --network "$name" --network-alias pg -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=produto postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929 >/dev/null
port=$(docker port "$name-minio" 9000/tcp | sed 's/.*://')
cat > "$tmp/health.py" <<'PYHEALTH'
import http.server
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  with open('/data/pings', 'a') as f: f.write(self.path+'\n')
  self.send_response(200); self.end_headers()
 def log_message(self, *args): pass
http.server.HTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
PYHEALTH
docker run -d --name "$name-health" --network "$name" --network-alias health -p 127.0.0.1::8000 -v "$tmp:/data" python:3.13-alpine python /data/health.py >/dev/null
for _ in $(seq 1 90); do
  if docker run --rm --network "$name" --entrypoint sh "$minio" -c 'mc alias set local http://minio:9000 testaccess testsecret >/dev/null && mc mb --ignore-existing local/dangus-backups >/dev/null' 2>/dev/null && docker exec "$name-pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
health_port=$(docker port "$name-health" 8000/tcp | sed 's/.*://')
docker run --rm --entrypoint age-keygen "$image" > "$tmp/identity" 2>/dev/null
pub=$(sed -n 's/^# public key: //p' "$tmp/identity")
export RESTORE_IDENTITY=$(cat "$tmp/identity") RESTORE_ENDPOINT="http://127.0.0.1:$port" RESTORE_HEALTH="http://127.0.0.1:$health_port/check"
cat > "$tmp/bin/bws" <<'PY'
#!/usr/bin/env python3
import json, os
print(json.dumps([{'key': k, 'value': v} for k,v in {
'ops__BACKUP_AGE_PRIVATE_KEY': os.environ['RESTORE_IDENTITY'],
'platform__R2_ENDPOINT': os.environ['RESTORE_ENDPOINT'],
'ops__R2_BACKUP_ACCESS_KEY_ID': 'testaccess',
'ops__R2_BACKUP_SECRET_ACCESS_KEY': 'testsecret',
'exemplo-postgres__HEALTHCHECKS_RESTORE_URL': os.environ['RESTORE_HEALTH'],
'exemplo-sqlite__HEALTHCHECKS_RESTORE_URL': os.environ['RESTORE_HEALTH']}.items()]))
PY
chmod +x "$tmp/bin/bws"
export PATH="$tmp/bin:$PATH"
backup() {
  docker run --rm --network "$name" -v "$tmp:/data" \
    -e BACKUP_PRODUCT="$product" -e BACKUP_DATABASE=produto -e AGE_PUBLIC_KEY="$pub" \
    -e R2_ENDPOINT=http://minio:9000 -e R2_ACCESS_KEY_ID=testaccess -e R2_SECRET_ACCESS_KEY=testsecret \
    -e HEALTHCHECKS_URL="http://health:8000/backup" "$@" --entrypoint /usr/local/bin/backup.sh "$image"
}
docker exec "$name-pg" psql -U postgres -d produto -c "CREATE TABLE mensagens (id serial primary key, texto text not null); INSERT INTO mensagens (texto) VALUES ('postgres');" >/dev/null
product=exemplo-postgres
backup -e BACKUP_TYPE=postgres -e PGHOST=pg -e PGUSER=postgres -e PGDATABASE=produto -e PGPASSWORD=testpass
(cd "$root/examples/postgres" && bun "$root/packages/cli/src/index.ts" db restore --verify)
echo 'Postgres: Backup restaurado e schema verificado.'
docker run --rm -v "$tmp:/data" --entrypoint sqlite3 "$image" /data/input.sqlite "CREATE TABLE mensagens (id integer primary key autoincrement, texto text not null); INSERT INTO mensagens (texto) VALUES ('sqlite');"
product=exemplo-sqlite
backup -e BACKUP_TYPE=sqlite -e SQLITE_PATH=/data/input.sqlite
(cd "$root/examples/sqlite" && bun "$root/packages/cli/src/index.ts" db restore --target "$tmp/restored.sqlite" --yes)
[[ $(docker run --rm -v "$tmp:/data" --entrypoint sqlite3 "$image" /data/restored.sqlite 'SELECT texto FROM mensagens') == sqlite ]]
echo 'SQLite: Backup restaurado e dados conferidos.'
printf 'corrompido' > "$tmp/corrupt"
docker run --rm --network "$name" -v "$tmp:/data" --entrypoint sh "$minio" -c 'mc alias set local http://minio:9000 testaccess testsecret >/dev/null; mc cp /data/corrupt local/dangus-backups/daily/exemplo-sqlite/produto/corrupt.sqlite.gz.age >/dev/null'
if (cd "$root/examples/sqlite" && bun "$root/packages/cli/src/index.ts" db restore --from daily/exemplo-sqlite/produto/corrupt.sqlite.gz.age --verify); then echo 'Backup corrompido aceito' >&2; exit 1; fi
grep -qx '/check/fail' "$tmp/pings"
echo 'Backup corrompido: falha e ping /fail confirmados.'
