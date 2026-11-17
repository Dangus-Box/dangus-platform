#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
: "${SSH_AUTH_SOCK:?SSH agent required}"
secrets=$(bws secret list)
for name in GRAFANA_ADMIN_PASSWORD UMAMI_APP_SECRET UMAMI_DB_PASSWORD UMAMI_ADMIN_PASSWORD UNLEASH_DB_PASSWORD UNLEASH_ADMIN_PASSWORD UNLEASH_FRONTEND_TOKEN UNLEASH_BACKEND_TOKEN R2_BACKUP_ACCESS_KEY_ID R2_BACKUP_SECRET_ACCESS_KEY HEALTHCHECKS_BACKUP_URL BACKUP_AGE_PUBLIC_KEY; do
  value=$(printf '%s' "$secrets" | bun -e 'const a=await Bun.stdin.json();const key=`ops__${process.argv[1]}`;const s=a.filter(x=>x.key===key);if(s.length!==1||typeof s[0].value!=="string"||!s[0].value){console.error(`Secret ${key} missing or empty in BWS.`);process.exit(1)}process.stdout.write(s[0].value)' "$name")
  export "$name=$value"
done
for name in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
  value=$(printf '%s' "$secrets" | bun -e 'const a=await Bun.stdin.json();const key=`platform__${process.argv[1]}`;const s=a.filter(x=>x.key===key);if(s.length!==1||typeof s[0].value!=="string"||!s[0].value){console.error(`Secret ${key} missing or empty in BWS.`);process.exit(1)}process.stdout.write(s[0].value)' "$name")
  export "$name=$value"
done
[[ $TELEGRAM_CHAT_ID =~ ^-?[0-9]+$ ]] || { echo "Invalid Telegram chat ID." >&2; exit 1; }
R2_ENDPOINT=$(printf '%s' "$secrets" | bun -e 'const a=await Bun.stdin.json();const s=a.filter(x=>x.key==="platform__R2_ENDPOINT");if(s.length!==1||!s[0].value)process.exit(1);process.stdout.write(s[0].value)')
export R2_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY_ID" R2_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET_ACCESS_KEY"
export R2_ENDPOINT HEALTHCHECKS_URL="$HEALTHCHECKS_BACKUP_URL"
[[ $BACKUP_AGE_PUBLIC_KEY =~ ^age1[0-9a-z]+$ ]] || { echo 'Invalid age public key in BWS.' >&2; exit 1; }
export AGE_PUBLIC_KEY="$BACKUP_AGE_PUBLIC_KEY"
unset secrets value
[[ $UNLEASH_ADMIN_PASSWORD != unleash4all ]] || { echo 'Unleash admin password cannot be the initial password.' >&2; exit 1; }
[[ $UMAMI_ADMIN_PASSWORD != umami ]] || { echo 'Admin password cannot be the initial password.' >&2; exit 1; }
export GF_SECURITY_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD" APP_SECRET="$UMAMI_APP_SECRET" POSTGRES_PASSWORD="$UMAMI_DB_PASSWORD"
export UNLEASH_DEFAULT_ADMIN_PASSWORD="$UNLEASH_ADMIN_PASSWORD" INIT_FRONTEND_API_TOKENS="$UNLEASH_FRONTEND_TOKEN" INIT_CLIENT_API_TOKENS="$UNLEASH_BACKEND_TOKEN" TOKENS="$UNLEASH_BACKEND_TOKEN"
unleash_url="postgresql://unleash:$(bun -e 'process.stdout.write(encodeURIComponent(process.env.UNLEASH_DB_PASSWORD))')@dangus-ops-unleash-db:5432/unleash"
export DATABASE_URL="postgresql://umami:$(bun -e 'process.stdout.write(encodeURIComponent(process.env.UMAMI_DB_PASSWORD))')@dangus-ops-umami-db:5432/umami"
version=$(git rev-parse --verify HEAD)
# The first Umami boot has no proxy or published port, so even if
# startup or the password change fails, the initial password remains private.
private_config=$(mktemp "$PWD/.deploy-private.XXXXXX")
alert_config="$PWD/.alerts-generated.yml"
trap 'rm -f "$private_config" "$alert_config"' EXIT
umask 077
sed "s/__TELEGRAM_CHAT_ID__/$TELEGRAM_CHAT_ID/" provisioning/alerting/alerts.yml > "$alert_config"
awk '
  /^    proxy:$/ { skip=1; next }
  skip && /^    env:$/ { skip=0 }
  !skip { print }
  /^        - DATABASE_URL$/ { print "        - UMAMI_ADMIN_PASSWORD" }
' deploy.yml > "$private_config"
runner() {
  docker run --rm --network host -v "$PWD:/work" -w /work -v "$SSH_AUTH_SOCK:/ssh-agent" \
    -e SSH_AUTH_SOCK=/ssh-agent -e AGE_PUBLIC_KEY -e R2_ENDPOINT -e R2_ACCESS_KEY_ID -e R2_SECRET_ACCESS_KEY -e HEALTHCHECKS_URL -e UMAMI_DB_PASSWORD -e UNLEASH_DB_PASSWORD -e GF_SECURITY_ADMIN_PASSWORD -e TELEGRAM_BOT_TOKEN -e APP_SECRET \
    -e POSTGRES_PASSWORD -e DATABASE_URL -e UMAMI_ADMIN_PASSWORD \
    -e UNLEASH_DEFAULT_ADMIN_PASSWORD -e INIT_FRONTEND_API_TOKENS -e INIT_CLIENT_API_TOKENS -e TOKENS \
    ghcr.io/basecamp/kamal:v2.12.0@sha256:7a3893b47dd328955f86fbf9ba887d08d612b74f96867f077750a53312537625 \
    "$@" --version="$version"
}
private="/work/$(basename "$private_config")"
# The private config has no proxy: Kamal stop does not call `kamal-proxy remove`,
# which fails if the route does not exist. The old route points to the removed container.
# Kamal boot skips existing containers; removing it ensures the route is created on each deploy.
replace() {
  runner accessory stop "$1" --config-file "$private"
  runner accessory remove_container "$1" --config-file "$private"
  runner accessory boot "$1" --config-file "$2"
}
for accessory in loki prometheus umami-db; do
  runner accessory boot "$accessory" --config-file deploy.yml
done
# Recreated on each deploy to apply alerts, the Telegram contact and token.
replace grafana deploy.yml
runner accessory exec umami-db --reuse --config-file deploy.yml "sh -c 'for i in \$(seq 1 120); do pg_isready -U umami && exit 0; sleep 1; done; exit 1'"
replace umami "$private"
program=$(base64 -w0 admin.js)
runner accessory exec umami --reuse --config-file "$private" "node -e 'eval(Buffer.from(\"$program\",\"base64\").toString())'" ||
  { runner accessory stop umami --config-file "$private"; exit 1; }
# The public boot runs `kamal-proxy deploy`, which creates or replaces the route.
replace umami deploy.yml

POSTGRES_PASSWORD="$UNLEASH_DB_PASSWORD" runner accessory boot unleash-db --config-file deploy.yml
runner accessory exec unleash-db --reuse --config-file deploy.yml "sh -c 'for i in \$(seq 1 120); do pg_isready -U unleash && exit 0; sleep 1; done; exit 1'"
DATABASE_URL="$unleash_url" runner accessory boot unleash --config-file deploy.yml
# Edge exits if it cannot validate TOKENS with the Unleash server at startup.
runner accessory exec unleash --reuse --config-file deploy.yml "sh -c 'for i in \$(seq 1 300); do wget -qO /dev/null http://localhost:4242/health 2>/dev/null && exit 0; sleep 1; done; exit 1'"
replace unleash-edge deploy.yml

for accessory in backup-umami backup-unleash backup-grafana; do
  replace "$accessory" deploy.yml
done
