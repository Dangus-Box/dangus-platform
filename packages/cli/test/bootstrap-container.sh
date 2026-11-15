#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
name="dangus-bootstrap-test-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker build -t dangus-bootstrap-test -f "$root/packages/cli/test/Dockerfile" "$root/packages/cli/test"
docker run -d --privileged --name "$name" --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw dangus-bootstrap-test >/dev/null
docker exec "$name" sh -c 'mkdir -p /etc/docker; printf "%s\n" '\''{"storage-driver":"vfs","features":{"containerd-snapshotter":false}}'\'' > /etc/docker/daemon.json'
# Envia o script pela entrada padrão, como o CLI faz via SSH.
run() {
  docker exec -i -e DANGUS_TEST_SKIP_TAILSCALE_JOIN=1 "$name" bash -s \
    < <(printf "DANGUS_TAILSCALE_AUTH_KEY='tskey-auth-teste'\n"; cat "$root/packages/cli/src/bootstrap.sh")
}
run
# Espere o Docker baixar e executar o Alloy antes da segunda execução.
for _ in {1..180}; do
  if docker exec "$name" docker inspect -f '{{.State.Running}}' dangus-alloy 2>/dev/null | grep -qx true; then break; fi
  sleep 1
done
docker exec "$name" docker inspect -f '{{.State.Running}}' dangus-alloy | grep -qx true
output=$(run)
printf '%s\n' "$output"
[[ $output == 'Provisionamento concluído: nenhuma alteração.' ]]
ssh_config=$(docker exec "$name" sshd -T)
for setting in 'passwordauthentication no' 'kbdinteractiveauthentication no' 'pubkeyauthentication yes' 'authenticationmethods publickey'; do
  grep -qx "$setting" <<< "$ssh_config"
done
printf '%s\n' "$ssh_config" | grep -E '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|authenticationmethods) '
ufw_status=$(docker exec "$name" ufw status verbose)
for rule in 'Status: active' 'Default: deny (incoming)' '80/tcp ' '443/tcp ' '22/tcp on tailscale0' '80/tcp (v6)' '443/tcp (v6)' '22/tcp (v6) on tailscale0'; do
  grep -Fq "$rule" <<< "$ufw_status"
done
printf '%s\n' "$ufw_status"
docker exec "$name" iptables -S DANGUS-DOCKER
docker exec "$name" systemctl is-active fail2ban unattended-upgrades docker tailscaled dangus-alloy dangus-docker-prune.timer
docker exec "$name" curl -fsS http://127.0.0.1:12345/-/ready

# O atalho de teste não pode pular a tailnet fora de um container.
docker exec "$name" sh -c 'printf "#!/bin/sh\nexit 1\n" > /usr/local/bin/systemd-detect-virt; chmod 755 /usr/local/bin/systemd-detect-virt'
if run 2>/dev/null; then echo 'DANGUS_TEST_SKIP_TAILSCALE_JOIN aceito fora de container.' >&2; exit 1; fi
docker exec "$name" rm /usr/local/bin/systemd-detect-virt
# Depois de uma falha entre gravar e recarregar o sshd, a próxima execução ainda recarrega.
docker exec "$name" sh -c 'rm /etc/ssh/sshd_config.d/00-dangus.conf; printf "PasswordAuthentication yes\nAuthenticationMethods any\n" > /etc/ssh/sshd_config.d/00-aaa.conf; systemctl reload ssh'
if run >/dev/null 2>&1; then echo 'Configuração SSH conflitante aceita.' >&2; exit 1; fi
docker exec "$name" rm /etc/ssh/sshd_config.d/00-aaa.conf
run >/dev/null
ssh_methods=$(docker exec "$name" ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null nobody@127.0.0.1 true 2>&1 || true)
grep -Fq 'Permission denied (publickey).' <<< "$ssh_methods" || { printf 'sshd em execução aceita outros métodos: %s\n' "$ssh_methods" >&2; exit 1; }
# Reiniciar o Docker mantém a proteção das portas publicadas.
docker exec "$name" systemctl restart docker
docker exec "$name" iptables -C DOCKER-USER -j DANGUS-DOCKER
[[ $(run) == 'Provisionamento concluído: nenhuma alteração.' ]]
