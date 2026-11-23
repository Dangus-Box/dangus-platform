#!/usr/bin/env bash
# Sobe o Umami real (as migrations criam o schema), grava linhas antigas e recentes e roda
# o accessory umami-retention uma vez. Só as antigas devem sumir.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
ops="$root/infra/ops"
id="test-retention-$$"
cleanup() { docker rm -f "$id-umami" "$id-db" "$id-job" >/dev/null 2>&1 || true; docker network rm "$id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
image() { grep -o "$1:[^ ]*" "$ops/deploy.yml" | head -1; }
docker network create "$id" >/dev/null
docker run -d --name "$id-db" --network "$id" --network-alias db -e POSTGRES_DB=umami -e POSTGRES_USER=umami -e POSTGRES_PASSWORD=test "$(image postgres)" >/dev/null
for _ in {1..60}; do docker exec "$id-db" pg_isready -U umami >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name "$id-umami" --network "$id" -e DATABASE_URL=postgresql://umami:test@db:5432/umami -e APP_SECRET=test-secret "$(image ghcr.io/umami-software/umami)" >/dev/null
for _ in {1..180}; do docker exec "$id-db" psql -U umami -tAc "select to_regclass('public.revenue') is not null" 2>/dev/null | grep -q t && break; sleep 1; done
sql() { docker exec -i "$id-db" psql -U umami -v ON_ERROR_STOP=1 -tA "$@"; }
sql <<'SQL'
insert into session (session_id, website_id, created_at) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ff', now() - interval '7 months'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000ff', now() - interval '7 months'),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000ff', now() - interval '1 day');
insert into website_event (event_id, website_id, session_id, visit_id, url_path, event_type, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', '/', 1, now() - interval '7 months'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000a2', '/', 1, now() - interval '7 months'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000a3', '/', 1, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000a4', '/', 1, now() - interval '1 day');
insert into event_data (event_data_id, website_id, website_event_id, data_key, data_type, created_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-0000000000e1', 'k', 1, now() - interval '7 months'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-0000000000e4', 'k', 1, now() - interval '1 day');
insert into session_data (session_data_id, website_id, session_id, data_key, data_type, created_at) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000a', 'k', 1, now() - interval '7 months'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000c', 'k', 1, now() - interval '1 day');
SQL
# The accessory as deployed: same image, files, env and command; stopped after the first pass.
docker run -d --name "$id-job" --network "$id" -e UMAMI_RETENTION="$(grep -o 'UMAMI_RETENTION: .*' "$ops/deploy.yml" | cut -d' ' -f2-)" \
  -e PGHOST=db -e PGUSER=umami -e PGDATABASE=umami -e PGPASSWORD=test \
  -v "$ops/umami-retention.sh:/etc/umami-retention/run.sh:ro" -v "$ops/umami-retention.sql:/etc/umami-retention/retention.sql:ro" \
  "$(image postgres)" sh /etc/umami-retention/run.sh >/dev/null
for _ in {1..30}; do docker logs "$id-job" 2>&1 | grep -q COMMIT && break; sleep 1; done
docker logs "$id-job" 2>&1
! docker logs "$id-job" 2>&1 | grep -q failed
got=$(sql -c "select (select string_agg(right(session_id::text,1), '' order by session_id) from session),
  (select string_agg(right(event_id::text,1), '' order by event_id) from website_event),
  (select string_agg(right(event_data_id::text,1), '' order by event_data_id) from event_data),
  (select string_agg(right(session_data_id::text,1), '' order by session_data_id) from session_data)")
echo "kept: $got"
[[ $got == "bc|34|2|2" ]] || { echo "unexpected rows kept: $got" >&2; exit 1; }
echo 'Retention OK'
