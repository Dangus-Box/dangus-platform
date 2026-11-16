#!/usr/bin/env bash
# Prova, com o provider real e uma API falsa local, que importar o Host existente
# não o altera, recria nem reinstala.
set -euo pipefail

TESTS=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'kill "${API_PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=fake-ca \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign \
  -keyout "$WORK/ca.key" -out "$WORK/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=developers.hostinger.com \
  -keyout "$WORK/srv.key" -out "$WORK/srv.csr" 2>/dev/null
openssl x509 -req -days 1 -in "$WORK/srv.csr" -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial \
  -extfile <(printf 'subjectAltName=DNS:developers.hostinger.com\nextendedKeyUsage=serverAuth\n') \
  -out "$WORK/srv.pem" 2>/dev/null

python3 -I "$TESTS/fake_hostinger_api.py" "$WORK" "$WORK/port" "$WORK/api.log" &
API_PID=$!
for _ in $(seq 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done

# Mesma configuração, com state local no lugar do backend R2.
mkdir "$WORK/tofu"
cp "$TESTS"/../{main.tf,variables.tf,.terraform.lock.hcl} "$WORK/tofu/"
python3 -I -c 'import re,sys; p=sys.argv[1]; s=open(p).read(); open(p,"w").write(re.sub(r"  backend \"s3\" \{.*?\n  \}\n", "", s, flags=re.S))' "$WORK/tofu/main.tf"
cd "$WORK/tofu"
export TF_IN_AUTOMATION=1 TF_INPUT=0 TF_VAR_state_passphrase=frase-de-teste-sem-segredo
tofu init >/dev/null

# Daqui em diante, toda chamada à Hostinger vai para a API falsa.
export HTTPS_PROXY="http://127.0.0.1:$(cat "$WORK/port")" NO_PROXY= no_proxy=
export SSL_CERT_FILE="$WORK/ca.pem" HOSTINGER_API_TOKEN=falso
export TF_VAR_data_center_id=17
# Template diferente do instalado: sem ignore_changes, reinstalaria o sistema.
export TF_VAR_template_id=9999

tofu import hostinger_vps.host 777 >/dev/null
tofu plan -out=plan.tfplan >/dev/null
changes=$(tofu show -json plan.tfplan | python3 -I -c '
import json, sys
for c in json.load(sys.stdin)["resource_changes"]:
    if c["address"] == "hostinger_vps.host":
        ch = c["change"]
        before, after, unknown = ch["before"], ch["after"], ch["after_unknown"]
        changed = sorted(k for k in after.keys() | unknown.keys() if before.get(k) != after.get(k) or unknown.get(k))
        print(",".join(ch["actions"]) + ":" + ",".join(changed))')

fail=0
# Nenhuma alteração no Host é aceitável.
[ "$changes" = "no-op:" ] || { echo "FALHOU: mudanças planejadas no Host: '$changes' (esperado: no-op:)"; fail=1; }
if grep -v '^GET ' "$WORK/api.log"; then echo "FALHOU: chamadas acima não são leitura"; fail=1; fi
[ "$fail" = 0 ] && echo "ok: import do Host existente sem recriar nem reinstalar"
exit "$fail"
