#!/usr/bin/env bash
set -euo pipefail
ops=$(cd "$(dirname "$0")/.." && pwd)
id="alert-e2e-$$"
tmp=$(mktemp -d)
cleanup() { docker rm -f "$id-grafana" "$id-prometheus" "$id-fake" >/dev/null 2>&1 || true; docker network rm "$id" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
chmod 755 "$tmp"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 1 -subj '/CN=api.telegram.org' -addext 'subjectAltName=DNS:api.telegram.org' >/dev/null 2>&1
chmod 644 "$tmp/key.pem" "$tmp/cert.pem"
cat > "$tmp/fake.js" <<'JS'
Bun.serve({port: 8080, fetch() {
  // Host root at 90%; another full mountpoint must not trigger the alert.
  return new Response('node_filesystem_size_bytes{mountpoint="/"} 100\nnode_filesystem_avail_bytes{mountpoint="/"} 10\nnode_filesystem_size_bytes{mountpoint="/boot"} 100\nnode_filesystem_avail_bytes{mountpoint="/boot"} 1\n');
}});
Bun.serve({port: 443, tls: {key: Bun.file('/tmp/key.pem'), cert: Bun.file('/tmp/cert.pem')}, async fetch(request) {
  if (new URL(request.url).pathname !== '/botfake-token/sendMessage') return new Response('unexpected path', {status: 404});
  const form = await request.formData();
  if (form.get('chat_id') !== '123') return new Response('wrong chat ID', {status: 400});
  await Bun.write('/tmp/received', `${form.get('chat_id')} ${form.get('text')}`);
  return Response.json({ok: true, result: {message_id: 1, date: 1, chat: {id: 123, type: 'group'}, text: 'ok'}});
}});
JS
cat > "$tmp/prometheus.yml" <<EOF2
global:
  scrape_interval: 2s
scrape_configs:
  - job_name: host
    static_configs:
      - targets: ['$id-fake:8080']
EOF2
python3 - "$ops/provisioning/alerting/alerts.yml" "$tmp/alerts.yml" "$id" <<'PY'
import sys
s=open(sys.argv[1]).read().replace('__TELEGRAM_CHAT_ID__', '123').replace('interval: 1m', 'interval: 10s').replace('for: 1m', 'for: 0s').replace('group_wait: 10s', 'group_wait: 1s')
open(sys.argv[2], 'w').write(s)
PY
docker network create "$id" >/dev/null
docker run -d --name "$id-fake" --network "$id" --network-alias api.telegram.org -v "$tmp/fake.js:/tmp/fake.js:ro" -v "$tmp/key.pem:/tmp/key.pem:ro" -v "$tmp/cert.pem:/tmp/cert.pem:ro" oven/bun:1.3.5 bun /tmp/fake.js >/dev/null
docker run -d --name "$id-prometheus" --network "$id" --network-alias dangus-ops-prometheus -v "$tmp/prometheus.yml:/etc/prometheus/prometheus.yml:ro" prom/prometheus:v3.3.1 >/dev/null
docker run -d --name "$id-grafana" --network "$id" -e GF_UNIFIED_ALERTING_ALERTMANAGER_CONFIG_POLL_INTERVAL=5s -e GF_SECURITY_ADMIN_PASSWORD=test -e TELEGRAM_BOT_TOKEN=fake-token -e SSL_CERT_FILE=/tmp/test-ca.pem -v "$tmp/cert.pem:/tmp/test-ca.pem:ro" -v "$ops/provisioning/datasources/datasources.yml:/etc/grafana/provisioning/datasources/datasources.yml:ro" -v "$tmp/alerts.yml:/etc/grafana/provisioning/alerting/alerts.yml:ro" grafana/grafana:11.6.3 >/dev/null
for _ in {1..90}; do
  if docker exec "$id-fake" test -s /tmp/received; then
    received=$(docker exec "$id-fake" cat /tmp/received)
    grep -q '^123 ' <<<"$received"
    grep -q 'Host disk usage above 85%' <<<"$received"
    grep -q 'mountpoint = /$' <<<"$received"
    if grep -q '/boot' <<<"$received"; then echo "Alert included another mountpoint: $received" >&2; exit 1; fi
    echo 'Grafana evaluated disk usage and sent a Telegram message to the local server.'
    exit 0
  fi
  sleep 2
done
docker logs "$id-grafana" | tail -50 >&2
exit 1
