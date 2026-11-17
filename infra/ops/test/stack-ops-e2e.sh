#!/usr/bin/env bash
# Start the Ops Stack, provisioned Alloy and SQLite example Product on a
# disposable Docker network and check the default dashboard signals through Grafana.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
ops="$root/infra/ops"
id="dangus-ops-e2e-$$"
net="$id"
product="$id-produto"
tmp=$(mktemp -d)
cleanup() {
  docker rm -f "$id-loki" "$id-prometheus" "$id-grafana" "$id-alloy" "$product" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
image() { grep -o "$1:[^ ]*" "$2" | head -1; }
# Same Alloy configuration as the Host, filtering by the test network instead of `kamal`.
awk '/^write_file \/etc\/dangus\/alloy.alloy/{f=1;next} /^CONFIG/{f=0} f' "$root/packages/cli/src/bootstrap.sh" |
  sed "s/regex = \"kamal\"/regex = \"$net\"/" > "$tmp/config.alloy"
grep -q "regex = \"$net\"" "$tmp/config.alloy"
docker build -q -t "$product" -f "$root/examples/sqlite/apps/api/Dockerfile" "$root" >/dev/null
docker network create "$net" >/dev/null
# Aliases are Kamal accessory names used in datasources and Alloy.
docker run -d --name "$id-loki" --network "$net" --network-alias dangus-ops-loki \
  -v "$ops/loki.yml:/etc/loki/config.yml:ro" "$(image grafana/loki "$ops/deploy.yml")" \
  -config.file=/etc/loki/config.yml >/dev/null
docker run -d --name "$id-prometheus" --network "$net" --network-alias dangus-ops-prometheus \
  -v "$ops/prometheus.yml:/etc/prometheus/prometheus.yml:ro" "$(image prom/prometheus "$ops/deploy.yml")" \
  --config.file=/etc/prometheus/prometheus.yml --web.enable-remote-write-receiver >/dev/null
docker run -d --name "$id-grafana" --network "$net" -p 127.0.0.1::3000 -e GF_SECURITY_ADMIN_PASSWORD=e2e \
  -v "$ops/provisioning/datasources/datasources.yml:/etc/grafana/provisioning/datasources/datasources.yml:ro" \
  -v "$ops/provisioning/dashboards/dashboards.yml:/etc/grafana/provisioning/dashboards/dashboards.yml:ro" \
  -v "$ops/dashboards/stack-ops.json:/etc/grafana/dashboards/stack-ops.json:ro" \
  "$(image grafana/grafana "$ops/deploy.yml")" >/dev/null
docker run -d --name "$id-alloy" --privileged --network "$net" -v /:/rootfs:ro -v /var/run:/var/run \
  -v /sys:/sys:ro -v /var/lib/docker:/var/lib/docker:ro -v "$tmp/config.alloy:/etc/alloy/config.alloy:ro" \
  "$(image grafana/alloy "$root/packages/cli/src/bootstrap.sh")" run /etc/alloy/config.alloy >/dev/null
docker run -d --name "$product" --network "$net" -e SQLITE_PATH=/tmp/produto.sqlite \
  -l "product=$id" -l app=api -l prometheus.io.scrape=true -l prometheus.io.port=3000 "$product" >/dev/null

for name in loki prometheus; do
  [[ $(docker inspect -f '{{json .NetworkSettings.Ports}}' "$id-$name") != *HostPort* ]] ||
    { echo "$name publishes a port on the Host." >&2; exit 1; }
done
grafana="http://admin:e2e@$(docker port "$id-grafana" 3000)"
# Query through the Grafana datasource proxy until the series appears (up to 5 minutes).
until_data() {
  local uid=$1 path=$2 query=$3
  for _ in {1..60}; do
    docker exec "$product" bun -e "fetch('http://localhost:3000/mensagens')" >/dev/null 2>&1 || true
    result=$(curl -fsS -G "$grafana/api/datasources/proxy/uid/$uid/$path" --data-urlencode "query=$query" 2>/dev/null || true)
    if [[ $result == *'"values"'* || $result == *'"value"'* ]]; then printf '%s\n' "$result"; return; fi
    sleep 5
  done
  echo "No data for $query" >&2
  exit 1
}
# The disk rule must see only the Host `/` (Alloy reads /rootfs), not the container overlay.
disk_expr=$(grep -o "expr: '.*'" "$ops/provisioning/alerting/alerts.yml" | sed "s/^expr: '//;s/'$//")
disk=$(until_data prometheus api/v1/query "$disk_expr" | bun -e 'const r=(await Bun.stdin.json()).data.result;if(r.length!==1){console.error(JSON.stringify(r));process.exit(1)}console.log(r[0].value[1])')
host_disk=$(df -B1 --output=size,avail / | awk 'NR==2{print 100*(1-$2/$1)}')
awk -v a="$disk" -v b="$host_disk" 'BEGIN{d=a-b; exit !(d<1 && d>-1)}' ||
  { echo "Rule disk usage ($disk%) differs from the Host root ($host_disk%)." >&2; exit 1; }
until_data loki loki/api/v1/query_range "{product=\"$id\"}" >/dev/null
until_data prometheus api/v1/query "http_server_requests_total{product=\"$id\"}" >/dev/null
until_data prometheus api/v1/query "container_memory_working_set_bytes{product=\"$id\",name=\"$product\"}" >/dev/null
until_data prometheus api/v1/query "rate(container_cpu_usage_seconds_total{product=\"$id\",name=\"$product\"}[5m])" >/dev/null
p95=$(until_data prometheus api/v1/query \
  "histogram_quantile(0.95, sum by (le) (rate(http_server_duration_seconds_bucket{product=\"$id\"}[5m])))" |
  grep -o '"value":\[[^]]*\]' | grep -o '"[0-9.e+-]*"\]' | tr -d '"]')
awk -v v="$p95" 'BEGIN { exit !(v < 1) }' || { echo "Implausible p95 latency: $p95 s" >&2; exit 1; }
curl -fsS "$grafana/api/dashboards/uid/stack-ops" | grep -q '"title":"Stack Ops"'
echo "Ops Stack: logs, requests, CPU, RAM and latency ($p95 s) for Product $id in Grafana."
