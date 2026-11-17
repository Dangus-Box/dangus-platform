#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
name="backup-test-$$"
minio=ghcr.io/l33tlamer/minio-backup@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e
tmp=$(mktemp -d)
cleanup() { docker rm -f "$name-minio" "$name-pg" "$name-pg16" "$name-health" "$name-writer" >/dev/null 2>&1 || true; docker network rm "$name" >/dev/null 2>&1 || true; docker run --rm -v "$tmp:/data" --entrypoint chmod "$name" -R 777 /data >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
chmod 777 "$tmp"
docker build -t "$name" infra/backup/image >/dev/null
# R2 and Healthchecks use HTTPS: without the CA bundle curl fails (code 77).
docker run --rm --entrypoint test "$name" -s /etc/ssl/certs/ca-certificates.crt || { echo 'FAIL: image lacks ca-certificates.' >&2; exit 1; }
docker network create "$name" >/dev/null
docker run -d --name "$name-minio" --network "$name" --network-alias minio -e MINIO_ROOT_USER=testaccess -e MINIO_ROOT_PASSWORD=testsecret "$minio" server /data >/dev/null
docker run -d --name "$name-pg" --network "$name" --network-alias pg -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=produto postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929 >/dev/null
# Ops Stack major version: pg_dump 17 must read a version 16 server.
docker run -d --name "$name-pg16" --network "$name" --network-alias pg16 -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=umami postgres:16.10-alpine@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297 >/dev/null
cat > "$tmp/health.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  with open('/data/pings','a') as f: f.write(self.path+'\n')
  self.send_response(500 if self.path == '/broken' else 200); self.end_headers()
HTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
PY
docker run -d --name "$name-health" --network "$name" --network-alias health -v "$tmp:/data" python:3.13-alpine python /data/health.py >/dev/null
for _ in $(seq 1 90); do
  if docker run --rm --network "$name" --entrypoint sh "$minio" -c 'mc alias set local http://minio:9000 testaccess testsecret >/dev/null && mc mb --ignore-existing local/dangus-backups >/dev/null' 2>/dev/null &&
    docker exec "$name-pg" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && docker exec "$name-pg16" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$name-pg" psql -U postgres -d produto -c "CREATE TABLE items (value text); INSERT INTO items VALUES ('backup postgres');" >/dev/null
docker exec "$name-pg16" psql -U postgres -d umami -c "CREATE TABLE items (value text); INSERT INTO items VALUES ('backup postgres 16');" >/dev/null
docker run --rm --entrypoint age-keygen "$name" > "$tmp/identity" 2>/dev/null
pub=$(sed -n 's/^# public key: //p' "$tmp/identity")

# Record argv for each program used by the script to verify secrets do not leak through /proc/*/cmdline.
mkdir -p "$tmp/bin" "$tmp/work"
printf '#!/bin/sh\nprintf "%%s\\n" "$0 $*" >> /data/argv\nexec "/usr/bin/${0##*/}" "$@"\n' > "$tmp/bin/argv-log"
for program in curl pg_dump sqlite3 gzip age; do ln -s argv-log "$tmp/bin/$program"; done
printf '#!/bin/sh\necho "${FAKE_DATE:-$(/usr/bin/date -u "+%%Y%%m%%dT%%H%%M%%SZ %%u %%d")}"\n' > "$tmp/bin/date"
chmod +x "$tmp/bin/argv-log" "$tmp/bin/date"
backup() {
  docker run --rm --network "$name" -v "$tmp:/data" -e PATH=/data/bin:/usr/local/bin:/usr/bin:/bin -e TMPDIR=/data/work \
    -e BACKUP_PRODUCT=example -e AGE_PUBLIC_KEY="$pub" -e R2_ENDPOINT=http://minio:9000 -e R2_ACCESS_KEY_ID=testaccess \
    -e R2_SECRET_ACCESS_KEY=testsecret -e HEALTHCHECKS_URL=http://health:8000/check-uuid "$@" --entrypoint /usr/local/bin/backup.sh "$name"
}
pings() { grep -cx "$1" "$tmp/pings" || true; }
objects() { docker run --rm --network "$name" --entrypoint sh "$minio" -c 'mc alias set local http://minio:9000 testaccess testsecret >/dev/null; mc ls --recursive "local/dangus-backups/$1" | wc -l' _ "$1"; }

docker run --rm -v "$tmp:/data" --entrypoint sqlite3 "$name" /data/input.sqlite "PRAGMA journal_mode=WAL; CREATE TABLE items (value text); INSERT INTO items VALUES ('backup sqlite');" >/dev/null
# SQLite in WAL mode receives writes during Backup.
docker run -d --name "$name-writer" -v "$tmp:/data" --entrypoint bash "$name" -c 'while true; do sqlite3 /data/input.sqlite "PRAGMA busy_timeout=5000; INSERT INTO items VALUES (\"concurrent\");" >/dev/null; done' >/dev/null
sleep 1
backup -e BACKUP_DATABASE=produto -e BACKUP_TYPE=postgres -e PGHOST=pg -e PGUSER=postgres -e PGDATABASE=produto -e PGPASSWORD=testpass
backup -e BACKUP_DATABASE=umami -e BACKUP_TYPE=postgres -e PGHOST=pg16 -e PGUSER=postgres -e PGDATABASE=umami -e PGPASSWORD=testpass
backup -e BACKUP_DATABASE=sqlite -e BACKUP_TYPE=sqlite -e SQLITE_PATH=/data/input.sqlite
docker rm -f "$name-writer" >/dev/null
[[ $(pings /check-uuid/start) == 3 && $(pings /check-uuid) == 3 && $(pings /check-uuid/fail) == 0 ]]

docker run --rm --network "$name" -v "$tmp:/data" --entrypoint sh "$minio" -c 'mc alias set local http://minio:9000 testaccess testsecret >/dev/null; mc cp --recursive local/dangus-backups/daily/example /data/download >/dev/null'
for database in produto umami sqlite; do
  file=$(find "$tmp/download/example/$database" -type f)
  [[ $(wc -l <<< "$file") == 1 && $file =~ /[0-9]{8}T[0-9]{6}Z-[0-9a-f]{24}\.(sql|sqlite)\.gz\.age$ ]]
  docker run --rm -v "$tmp:/data" --entrypoint bash "$name" -c 'age -d -i /data/identity "$1" | gzip -d > "/data/$2.out"' _ "/data/${file#"$tmp/"}" "$database"
done
docker exec "$name-pg" createdb -U postgres restored
docker exec -i "$name-pg" psql -v ON_ERROR_STOP=1 -U postgres -d restored < "$tmp/produto.out" >/dev/null
[[ $(docker exec "$name-pg" psql -U postgres -d restored -tAc 'SELECT value FROM items') == 'backup postgres' ]]
docker exec "$name-pg16" createdb -U postgres restored
# The pg_dump 17 dump includes `SET transaction_timeout`, which version 16 rejects; this is the only accepted error.
errors=$(docker exec -i "$name-pg16" psql -U postgres -d restored < "$tmp/umami.out" 2>&1 >/dev/null)
[[ $errors == 'ERROR:  unrecognized configuration parameter "transaction_timeout"' ]]
[[ $(docker exec "$name-pg16" psql -U postgres -d restored -tAc 'SELECT value FROM items') == 'backup postgres 16' ]]
[[ $(docker run --rm -v "$tmp:/data" --entrypoint sqlite3 "$name" /data/sqlite.out 'PRAGMA integrity_check; SELECT value FROM items LIMIT 1') == $'ok\nbackup sqlite' ]]
# Only the private identity can decrypt.
if docker run --rm -v "$tmp:/data" --entrypoint age "$name" -d -i /dev/null "/data/${file#"$tmp/"}" >/dev/null 2>&1; then exit 1; fi

# Weekly and monthly copies fall on the correct UTC days; two runs in the same second do not collide.
backup -e BACKUP_DATABASE=sunday -e BACKUP_TYPE=sqlite -e SQLITE_PATH=/data/input.sqlite -e 'FAKE_DATE=20261108T030000Z 7 08'
backup -e BACKUP_DATABASE=sunday -e BACKUP_TYPE=sqlite -e SQLITE_PATH=/data/input.sqlite -e 'FAKE_DATE=20261108T030000Z 7 08'
backup -e BACKUP_DATABASE=day1 -e BACKUP_TYPE=sqlite -e SQLITE_PATH=/data/input.sqlite -e 'FAKE_DATE=20261201T030000Z 2 01'
backup -e BACKUP_DATABASE=both -e BACKUP_TYPE=sqlite -e SQLITE_PATH=/data/input.sqlite -e 'FAKE_DATE=20261101T030000Z 7 01'
[[ $(objects daily/example/sunday) == 2 && $(objects weekly/example/sunday) == 2 && $(objects monthly/example/sunday) == 0 ]]
[[ $(objects daily/example/day1) == 1 && $(objects weekly/example/day1) == 0 && $(objects monthly/example/day1) == 1 ]]
[[ $(objects weekly/example/both) == 1 && $(objects monthly/example/both) == 1 ]]
[[ -z $(ls -A "$tmp/work") ]]

# Any failed step exits with an error, pings /fail and leaves no temporary files.
fails=0
for failure in 'SQLITE_PATH=/missing' 'AGE_PUBLIC_KEY=age1invalid' 'R2_SECRET_ACCESS_KEY=wrong' 'PGHOST=missing-host' 'HEALTHCHECKS_URL=http://health:8000/broken'; do
  type=sqlite; [[ $failure == PGHOST=* ]] && type=postgres
  if backup -e BACKUP_DATABASE=failure -e BACKUP_TYPE="$type" -e SQLITE_PATH=/data/input.sqlite -e PGUSER=postgres -e PGDATABASE=produto -e PGPASSWORD=testpass -e "$failure" 2>/dev/null; then
    echo "Backup should fail with $failure." >&2; exit 1
  fi
  fails=$((fails + 1))
  [[ -z $(ls -A "$tmp/work") ]] || { echo "Temporary files remained with $failure." >&2; exit 1; }
done
[[ $(pings /check-uuid/fail) == $((fails - 1)) && $(pings /broken/fail) == 1 ]]
# Only failure of the success ping occurs after upload.
[[ $(objects daily/example/failure) == 1 ]]

# No secret appears in process argv.
docker run --rm -v "$tmp:/data" --entrypoint chmod "$name" 644 /data/argv
grep -q '/curl .*--aws-sigv4' "$tmp/argv" && grep -q '/pg_dump ' "$tmp/argv"
for secret in testsecret testpass check-uuid; do
  if grep -q "$secret" "$tmp/argv"; then echo "Secret $secret in argv: $(grep "$secret" "$tmp/argv" | head -1)" >&2; exit 1; fi
done
printf '%s\n' 'Postgres 17 and 16 and actively written SQLite restored; weekly and monthly copies, failures, cleanup and argv verified.'
