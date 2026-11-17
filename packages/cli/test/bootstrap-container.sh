#!/usr/bin/env bash
# Usage: bootstrap-container.sh [docker-ce]
# With docker-ce, the container simulates an existing Host: Docker from the official repository
# and active ufw with a rule outside provisioning.
set -euo pipefail
scenario=${1:-}
root=$(cd "$(dirname "$0")/../../.." && pwd)
name="dangus-bootstrap-test-$$"
errlog=$(mktemp)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -f "$errlog"' EXIT
docker build -t dangus-bootstrap-test -f "$root/packages/cli/test/Dockerfile" "$root/packages/cli/test"
docker run -d --privileged --name "$name" --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw dangus-bootstrap-test >/dev/null
docker exec "$name" sh -c 'mkdir -p /etc/docker; printf "%s\n" '\''{"storage-driver":"vfs","features":{"containerd-snapshotter":false}}'\'' > /etc/docker/daemon.json'
# Send the script through stdin as the CLI does over SSH.
run() {
  docker exec -i -e DANGUS_TEST_SKIP_TAILSCALE_JOIN=1 "$name" bash -s \
    < <(printf "DANGUS_TAILSCALE_AUTH_KEY='tskey-auth-test'\n"; cat "$root/packages/cli/src/bootstrap.sh")
}
if [[ $scenario == docker-ce ]]; then
  docker exec "$name" bash -euc '
    apt-get update
    apt-get install -y ca-certificates curl ufw
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    ufw allow 8080/tcp
    ufw --force enable'
fi
run 2>"$errlog"
cat "$errlog" >&2
if [[ $scenario == docker-ce ]]; then
  # Existing Docker is kept and discarded ufw rules are shown before reset.
  docker exec "$name" dpkg-query -W -f='${db:Status-Status}\n' docker-ce containerd.io | grep -cx installed | grep -qx 2
  if docker exec "$name" dpkg-query -W -f='${db:Status-Status}' docker.io 2>/dev/null | grep -qx installed; then
    echo 'docker.io installed over docker-ce.' >&2; exit 1
  fi
  grep -Fqx 'ufw allow 8080/tcp' "$errlog"
fi
# Wait for Docker to pull and run Alloy before the second run.
for _ in {1..180}; do
  if docker exec "$name" docker inspect -f '{{.State.Running}}' dangus-alloy 2>/dev/null | grep -qx true; then break; fi
  sleep 1
done
docker exec "$name" docker inspect -f '{{.State.Running}}' dangus-alloy | grep -qx true
output=$(run)
printf '%s\n' "$output"
[[ $output == 'Provisioning complete: no changes.' ]]
ssh_config=$(docker exec "$name" sshd -T)
for setting in 'passwordauthentication no' 'kbdinteractiveauthentication no' 'pubkeyauthentication yes' 'authenticationmethods publickey'; do
  grep -qx "$setting" <<< "$ssh_config"
done
printf '%s\n' "$ssh_config" | grep -E '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|authenticationmethods) '
ufw_status=$(docker exec "$name" ufw status verbose)
for rule in 'Status: active' 'Default: deny (incoming)' '80/tcp ' '443/tcp ' "Anywhere on tailscale0" '80/tcp (v6)' '443/tcp (v6)' 'Anywhere (v6) on tailscale0'; do
  grep -Fq "$rule" <<< "$ufw_status"
done
printf '%s\n' "$ufw_status"
docker exec "$name" iptables -S DANGUS-DOCKER
docker exec "$name" systemctl is-active fail2ban unattended-upgrades docker tailscaled dangus-alloy dangus-docker-prune.timer
docker exec "$name" curl -fsS http://127.0.0.1:12345/-/ready

# The test shortcut cannot skip the tailnet outside a container.
docker exec "$name" sh -c 'printf "#!/bin/sh\nexit 1\n" > /usr/local/bin/systemd-detect-virt; chmod 755 /usr/local/bin/systemd-detect-virt'
if run 2>/dev/null; then echo 'DANGUS_TEST_SKIP_TAILSCALE_JOIN accepted outside a container.' >&2; exit 1; fi
docker exec "$name" rm /usr/local/bin/systemd-detect-virt
# After a failure between writing and reloading sshd, the next run still reloads.
docker exec "$name" sh -c 'rm /etc/ssh/sshd_config.d/00-dangus.conf; printf "PasswordAuthentication yes\nAuthenticationMethods any\n" > /etc/ssh/sshd_config.d/00-aaa.conf; systemctl reload ssh'
if run >/dev/null 2>&1; then echo 'Conflicting SSH configuration accepted.' >&2; exit 1; fi
docker exec "$name" rm /etc/ssh/sshd_config.d/00-aaa.conf
run >/dev/null
ssh_methods=$(docker exec "$name" ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null nobody@127.0.0.1 true 2>&1 || true)
grep -Fq 'Permission denied (publickey).' <<< "$ssh_methods" || { printf 'running sshd accepts other methods: %s\n' "$ssh_methods" >&2; exit 1; }
# Restarting Docker preserves protection for published ports.
docker exec "$name" systemctl restart docker
docker exec "$name" iptables -C DOCKER-USER -j DANGUS-DOCKER
# Restarting Docker also restarts Alloy (Requires=); wait for it before comparing.
for _ in {1..60}; do docker exec "$name" systemctl is-active --quiet dangus-alloy && break; sleep 1; done
output=$(run)
[[ $output == 'Provisioning complete: no changes.' ]] || { printf 'After Docker restart: %s\n' "$output" >&2; exit 1; }
