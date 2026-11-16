#!/usr/bin/env bash
# Sobe a Stack Ops, o Alloy do provisionamento e o Produto de exemplo SQLite numa
# rede Docker descartável e confere, pelo Grafana, os sinais do dashboard padrão.
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
# Mesma configuração do Alloy no Host, filtrando pela rede de teste em vez da `kamal`.
awk '/^write_file \/etc\/dangus\/alloy.alloy/{f=1;next} /^CONFIG/{f=0} f' "$root/packages/cli/src/bootstrap.sh" |
  sed "s/regex = \"kamal\"/regex = \"$net\"/" > "$tmp/config.alloy"
grep -q "regex = \"$net\"" "$tmp/config.alloy"
docker build -q -t "$product" -f "$root/examples/sqlite/apps/api/Dockerfile" "$root" >/dev/null
docker network create "$net" >/dev/null
# Os aliases são os nomes dos accessories do Kamal, usados nos datasources e no Alloy.
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
    { echo "$name publica porta no Host." >&2; exit 1; }
done
grafana="http://admin:e2e@$(docker port "$id-grafana" 3000)"
# Consulta pelo proxy de datasource do Grafana até a série aparecer (até 5 minutos).
until_data() {
  local uid=$1 path=$2 query=$3
  for _ in {1..60}; do
    docker exec "$product" bun -e "fetch('http://localhost:3000/mensagens')" >/dev/null 2>&1 || true
    result=$(curl -fsS -G "$grafana/api/datasources/proxy/uid/$uid/$path" --data-urlencode "query=$query" 2>/dev/null || true)
    if [[ $result == *'"values"'* || $result == *'"value"'* ]]; then printf '%s\n' "$result"; return; fi
    sleep 5
  done
  echo "Sem dados para $query" >&2
  exit 1
}
until_data prometheus api/v1/query 'node_filesystem_avail_bytes{mountpoint="/"}' >/dev/null
until_data prometheus api/v1/query 'node_filesystem_size_bytes{mountpoint="/"}' >/dev/null
until_data loki loki/api/v1/query_range "{product=\"$id\"}" >/dev/null
until_data prometheus api/v1/query "http_server_requests_total{product=\"$id\"}" >/dev/null
until_data prometheus api/v1/query "container_memory_working_set_bytes{product=\"$id\",name=\"$product\"}" >/dev/null
until_data prometheus api/v1/query "rate(container_cpu_usage_seconds_total{product=\"$id\",name=\"$product\"}[5m])" >/dev/null
p95=$(until_data prometheus api/v1/query \
  "histogram_quantile(0.95, sum by (le) (rate(http_server_duration_seconds_bucket{product=\"$id\"}[5m])))" |
  grep -o '"value":\[[^]]*\]' | grep -o '"[0-9.e+-]*"\]' | tr -d '"]')
awk -v v="$p95" 'BEGIN { exit !(v < 1) }' || { echo "Latência p95 implausível: $p95 s" >&2; exit 1; }
curl -fsS "$grafana/api/dashboards/uid/stack-ops" | grep -q '"title":"Stack Ops"'
echo "Stack Ops: logs, requisições, CPU, RAM e latência ($p95 s) do Produto $id no Grafana."
