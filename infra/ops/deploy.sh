#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
: "${SSH_AUTH_SOCK:?SSH agent obrigatório}"
secrets=$(bws secret list)
for name in GRAFANA_ADMIN_PASSWORD UMAMI_APP_SECRET UMAMI_DB_PASSWORD UMAMI_ADMIN_PASSWORD UNLEASH_DB_PASSWORD UNLEASH_ADMIN_PASSWORD UNLEASH_FRONTEND_TOKEN UNLEASH_BACKEND_TOKEN; do
  value=$(printf '%s' "$secrets" | bun -e 'const a=await Bun.stdin.json();const key=`ops__${process.argv[1]}`;const s=a.filter(x=>x.key===key);if(s.length!==1||typeof s[0].value!=="string"||!s[0].value){console.error(`Secret ${key} ausente ou vazio no BWS.`);process.exit(1)}process.stdout.write(s[0].value)' "$name")
  export "$name=$value"
done
unset secrets value
[[ $UNLEASH_ADMIN_PASSWORD != unleash4all ]] || { echo 'Senha admin do Unleash não pode ser a senha inicial.' >&2; exit 1; }
[[ $UMAMI_ADMIN_PASSWORD != umami ]] || { echo 'Senha admin não pode ser a senha inicial.' >&2; exit 1; }
export GF_SECURITY_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD" APP_SECRET="$UMAMI_APP_SECRET" POSTGRES_PASSWORD="$UMAMI_DB_PASSWORD"
export UNLEASH_DEFAULT_ADMIN_PASSWORD="$UNLEASH_ADMIN_PASSWORD" INIT_FRONTEND_API_TOKENS="$UNLEASH_FRONTEND_TOKEN" INIT_CLIENT_API_TOKENS="$UNLEASH_BACKEND_TOKEN" TOKENS="$UNLEASH_BACKEND_TOKEN"
unleash_url="postgresql://unleash:$(bun -e 'process.stdout.write(encodeURIComponent(process.env.UNLEASH_DB_PASSWORD))')@dangus-ops-unleash-db:5432/unleash"
export DATABASE_URL="postgresql://umami:$(bun -e 'process.stdout.write(encodeURIComponent(process.env.UMAMI_DB_PASSWORD))')@dangus-ops-umami-db:5432/umami"
version=$(git rev-parse --verify HEAD)
# O primeiro boot do Umami não tem proxy nem porta publicada. Assim, mesmo que
# a inicialização ou a troca de senha falhe, a senha inicial não fica pública.
private_config=$(mktemp "$PWD/.deploy-private.XXXXXX")
trap 'rm -f "$private_config"' EXIT
awk '
  /^    proxy:$/ { skip=1; next }
  skip && /^    env:$/ { skip=0 }
  !skip { print }
  /^        - DATABASE_URL$/ { print "        - UMAMI_ADMIN_PASSWORD" }
' deploy.yml > "$private_config"
runner() {
  docker run --rm --network host -v "$PWD:/work" -w /work -v "$SSH_AUTH_SOCK:/ssh-agent" \
    -e SSH_AUTH_SOCK=/ssh-agent -e GF_SECURITY_ADMIN_PASSWORD -e APP_SECRET \
    -e POSTGRES_PASSWORD -e DATABASE_URL -e UMAMI_ADMIN_PASSWORD \
    -e UNLEASH_DEFAULT_ADMIN_PASSWORD -e INIT_FRONTEND_API_TOKENS -e INIT_CLIENT_API_TOKENS -e TOKENS \
    ghcr.io/basecamp/kamal:v2.12.0@sha256:7a3893b47dd328955f86fbf9ba887d08d612b74f96867f077750a53312537625 \
    "$@" --version="$version"
}
for accessory in grafana loki prometheus umami-db; do
  runner accessory boot "$accessory" --config-file deploy.yml
done
runner accessory exec umami-db --reuse --config-file deploy.yml "sh -c 'for i in \$(seq 1 120); do pg_isready -U umami && exit 0; sleep 1; done; exit 1'"
private="/work/$(basename "$private_config")"
# A config privada não tem proxy: o stop do Kamal não chama `kamal-proxy remove`,
# que falha quando a rota não existe. A rota antiga aponta para o container removido.
# O boot do Kamal pula container existente; removê-lo garante a rota a cada deploy.
replace() {
  runner accessory stop "$1" --config-file "$private"
  runner accessory remove_container "$1" --config-file "$private"
  runner accessory boot "$1" --config-file "$2"
}
replace umami "$private"
program=$(base64 -w0 admin.js)
runner accessory exec umami --reuse --config-file "$private" "node -e 'eval(Buffer.from(\"$program\",\"base64\").toString())'" ||
  { runner accessory stop umami --config-file "$private"; exit 1; }
# O boot público executa `kamal-proxy deploy`, que cria ou substitui a rota.
replace umami deploy.yml

POSTGRES_PASSWORD="$UNLEASH_DB_PASSWORD" runner accessory boot unleash-db --config-file deploy.yml
runner accessory exec unleash-db --reuse --config-file deploy.yml "sh -c 'for i in \$(seq 1 120); do pg_isready -U unleash && exit 0; sleep 1; done; exit 1'"
DATABASE_URL="$unleash_url" runner accessory boot unleash --config-file deploy.yml
# O Edge encerra se não valida TOKENS no Unleash server ao iniciar.
runner accessory exec unleash --reuse --config-file deploy.yml "sh -c 'for i in \$(seq 1 300); do wget -qO /dev/null http://localhost:4242/health 2>/dev/null && exit 0; sleep 1; done; exit 1'"
replace unleash-edge deploy.yml
