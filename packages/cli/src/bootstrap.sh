#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
changed=0
mark() { changed=1; }
pending=/var/lib/dangus/pending
# Grava o arquivo se mudou. Com uma unit, registra que ela precisa ser recarregada;
# o registro sobrevive a uma falha antes do recarregamento e é aplicado na próxima execução.
write_file() {
  local path="$1" unit="${2:-}" temp
  temp=$(mktemp)
  cat > "$temp"
  if cmp -s "$temp" "$path"; then
    rm -f "$temp"
    return 1
  fi
  if [[ -n $unit ]]; then mkdir -p "$pending"; touch "$pending/$unit"; fi
  install -D -m 644 "$temp" "$path"
  rm -f "$temp"
  mark
}
apply_pending() {
  [[ -e $pending/$2 ]] || return 0
  systemctl "$1" "$2"
  rm -f "$pending/$2"
}
service_on() {
  if ! systemctl is-enabled --quiet "$1"; then systemctl enable "$1"; mark; fi
  if ! systemctl is-active --quiet "$1"; then systemctl start "$1"; mark; fi
}
[[ $EUID == 0 ]] || { echo 'Execute como root.' >&2; exit 1; }
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Requer Ubuntu 24.04.' >&2; exit 1; }
skip_join=${DANGUS_TEST_SKIP_TAILSCALE_JOIN:-0}
if [[ $skip_join == 1 ]]; then
  # Sem a tailnet, fechar o SSH público trancaria o Host: só o container de teste pode pular.
  systemd-detect-virt --quiet --container || { echo 'DANGUS_TEST_SKIP_TAILSCALE_JOIN só é aceito em container de teste.' >&2; exit 1; }
  echo 'Aviso: entrada na tailnet ignorada (teste).' >&2
fi
packages=(openssh-server fail2ban unattended-upgrades ufw curl ca-certificates)
missing=()
for package in "${packages[@]}"; do
  dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -qx installed || missing+=("$package")
done
# Um Docker já instalado (por exemplo, docker-ce do repositório oficial) é mantido:
# instalar docker.io por cima removeria o docker-ce e o containerd.io.
if ! command -v docker >/dev/null || ! command -v dockerd >/dev/null; then missing+=(docker.io); fi
if ((${#missing[@]})); then
  apt-get update
  apt-get install -y "${missing[@]}"
  mark
fi
if ! command -v tailscale >/dev/null; then
  keyring=$(mktemp)
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o "$keyring"
  # Chave de assinatura 2596A99EAAB33821893C0A79458CA832957F5868 da Tailscale.
  sha256sum -c --quiet <<< "3e03dacf222698c60b8e2f990b809ca1b3e104de127767864284e6c228f1fb39  $keyring"
  install -m 644 "$keyring" /usr/share/keyrings/tailscale-archive-keyring.gpg
  rm -f "$keyring"
  echo 'deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main' > /etc/apt/sources.list.d/tailscale.list
  apt-get update
  apt-get install -y tailscale
  mark
fi
service_on tailscaled.service
tailscale_running() { [[ $(tailscale status --json) == *'"BackendState": "Running"'* ]]; }
if [[ $skip_join != 1 ]]; then
  if ! tailscale_running; then
    [[ -n ${DANGUS_TAILSCALE_AUTH_KEY:-} ]] || { echo 'Chave Tailscale ausente.' >&2; exit 1; }
    tailscale up --auth-key=file:/dev/stdin <<< "$DANGUS_TAILSCALE_AUTH_KEY"
    mark
  fi
  tailscale_running || { echo 'Tailscale não está conectado.' >&2; exit 1; }
fi
unset DANGUS_TAILSCALE_AUTH_KEY
mkdir -p /run/sshd
service_on ssh.service
write_file /etc/ssh/sshd_config.d/00-dangus.conf ssh.service <<'CONFIG' || true
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
CONFIG
/usr/sbin/sshd -t
ssh_effective=$(/usr/sbin/sshd -T)
for setting in "passwordauthentication no" "kbdinteractiveauthentication no" "pubkeyauthentication yes" "authenticationmethods publickey"; do
  grep -qx "$setting" <<< "$ssh_effective" || { echo "Configuração SSH conflitante: $setting" >&2; exit 1; }
done
apply_pending reload ssh.service
write_file /etc/apt/apt.conf.d/20auto-upgrades <<'CONFIG' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONFIG
write_file /etc/fail2ban/jail.d/dangus.local fail2ban.service <<'CONFIG' || true
[sshd]
enabled = true
backend = systemd
CONFIG
apply_pending restart fail2ban.service
service_on fail2ban.service
service_on unattended-upgrades.service
service_on docker.service
rules=$'ufw allow 80/tcp\nufw allow 443/tcp\nufw allow in on tailscale0'
added=$(ufw show added)
if [[ $added != "Added user rules (see 'ufw status' for running firewall):"$'\n'"$rules" ]]; then
  discarded=$(tail -n +2 <<< "$added" | grep -vxF -e '(None)' -f <(printf '%s\n' "$rules") || true)
  if [[ -n $discarded ]]; then printf 'Regras do ufw descartadas pelo reset:\n%s\n' "$discarded" >&2; fi
  ufw --force reset
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow in on tailscale0
  mark
fi
if ! grep -q '^DEFAULT_INPUT_POLICY="DROP"' /etc/default/ufw; then ufw default deny incoming; mark; fi
if ! ufw status | grep -q '^Status: active'; then ufw --force enable; mark; fi
# Docker publica portas antes das regras normais do UFW. Proteja o encaminhamento
# para bridges também, inclusive quando o firewall do provedor ainda não foi aplicado.
if write_file /usr/local/sbin/dangus-docker-firewall dangus-docker-firewall.service <<'CONFIG'
#!/bin/bash
set -eu
for ipt in iptables ip6tables; do
  "$ipt" -w -nL DOCKER-USER >/dev/null 2>&1 || continue
  "$ipt" -w -nL DANGUS-DOCKER >/dev/null 2>&1 || "$ipt" -w -N DANGUS-DOCKER
  "$ipt" -w -F DANGUS-DOCKER
  "$ipt" -w -A DANGUS-DOCKER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
  "$ipt" -w -A DANGUS-DOCKER -i tailscale0 -j RETURN
  "$ipt" -w -A DANGUS-DOCKER -i docker+ -j RETURN
  "$ipt" -w -A DANGUS-DOCKER -i br+ -j RETURN
  "$ipt" -w -A DANGUS-DOCKER -p tcp -m conntrack --ctorigdstport 80 -j RETURN
  "$ipt" -w -A DANGUS-DOCKER -p tcp -m conntrack --ctorigdstport 443 -j RETURN
  "$ipt" -w -A DANGUS-DOCKER -o docker+ -j DROP
  "$ipt" -w -A DANGUS-DOCKER -o br+ -j DROP
  "$ipt" -w -C DOCKER-USER -j DANGUS-DOCKER 2>/dev/null || "$ipt" -w -I DOCKER-USER 1 -j DANGUS-DOCKER
done
CONFIG
then chmod 755 /usr/local/sbin/dangus-docker-firewall; fi
if write_file /etc/systemd/system/dangus-docker-firewall.service dangus-docker-firewall.service <<'CONFIG'
[Unit]
Description=Protege portas publicadas pelo Docker
Requires=docker.service
After=docker.service
PartOf=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/dangus-docker-firewall
RemainAfterExit=yes
[Install]
WantedBy=docker.service
CONFIG
then systemctl daemon-reload; fi
apply_pending restart dangus-docker-firewall.service
service_on dangus-docker-firewall.service
mkdir -p /etc/dangus
write_file /etc/dangus/alloy.alloy dangus-alloy.service <<'CONFIG' || true
discovery.docker "containers" {
  host = "unix:///var/run/docker.sock"
}
loki.source.docker "logs" {
  host       = "unix:///var/run/docker.sock"
  targets    = discovery.docker.containers.targets
  forward_to = []
}
prometheus.exporter.unix "host" {
  rootfs_path = "/rootfs"
  procfs_path = "/rootfs/proc"
  sysfs_path = "/rootfs/sys"
}
prometheus.exporter.cadvisor "containers" {}
prometheus.relabel "discard" {
  forward_to = []
}
prometheus.scrape "host" {
  targets    = prometheus.exporter.unix.host.targets
  forward_to = [prometheus.relabel.discard.receiver]
}
prometheus.scrape "containers" {
  targets    = prometheus.exporter.cadvisor.containers.targets
  forward_to = [prometheus.relabel.discard.receiver]
}
discovery.relabel "metrics" {
  targets = discovery.docker.containers.targets
  rule {
    source_labels = ["__meta_docker_container_label_prometheus_io_scrape"]
    regex = "true"
    action = "keep"
  }
  rule {
    source_labels = ["__meta_docker_network_ip", "__meta_docker_container_label_prometheus_io_port"]
    separator = ";"
    regex = "(.+);([0-9]+)"
    replacement = "$1:$2"
    target_label = "__address__"
  }
}
prometheus.scrape "apps" {
  targets = discovery.relabel.metrics.output
  forward_to = [prometheus.relabel.discard.receiver]
}
CONFIG
if write_file /etc/systemd/system/dangus-alloy.service dangus-alloy.service <<'CONFIG'
[Unit]
Description=Grafana Alloy
Requires=docker.service
After=docker.service
[Service]
Restart=always
ExecStartPre=-/usr/bin/docker rm -f dangus-alloy
ExecStart=/usr/bin/docker run --name dangus-alloy --privileged --network host -v /:/rootfs:ro -v /var/run:/var/run -v /sys:/sys:ro -v /var/lib/docker:/var/lib/docker:ro -v /etc/dangus/alloy.alloy:/etc/alloy/config.alloy:ro grafana/alloy:v1.8.3@sha256:ab04df3936e4d71d31b6f55e0c58a7e749091f59635dd8c2bc731ba1b6c93701 run --server.http.listen-addr=127.0.0.1:12345 /etc/alloy/config.alloy
ExecStop=/usr/bin/docker stop dangus-alloy
[Install]
WantedBy=multi-user.target
CONFIG
then systemctl daemon-reload; fi
if ! docker image inspect grafana/alloy:v1.8.3@sha256:ab04df3936e4d71d31b6f55e0c58a7e749091f59635dd8c2bc731ba1b6c93701 >/dev/null 2>&1; then
  docker pull grafana/alloy:v1.8.3@sha256:ab04df3936e4d71d31b6f55e0c58a7e749091f59635dd8c2bc731ba1b6c93701
  mark
fi
apply_pending restart dangus-alloy.service
service_on dangus-alloy.service
for _ in {1..60}; do
  curl -fsS http://127.0.0.1:12345/-/ready >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:12345/-/ready >/dev/null || { echo 'Alloy não iniciou.' >&2; exit 1; }
if write_file /etc/systemd/system/dangus-docker-prune.service <<'CONFIG'
[Unit]
Description=Remove imagens Docker antigas não utilizadas
[Service]
Type=oneshot
ExecStart=/usr/bin/docker image prune -af --filter until=168h
CONFIG
then systemctl daemon-reload; fi
if write_file /etc/systemd/system/dangus-docker-prune.timer <<'CONFIG'
[Unit]
Description=Limpeza periódica de imagens Docker
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
CONFIG
then systemctl daemon-reload; fi
service_on dangus-docker-prune.timer
if ((changed)); then echo 'Provisionamento concluído: houve alterações.'; else echo 'Provisionamento concluído: nenhuma alteração.'; fi
