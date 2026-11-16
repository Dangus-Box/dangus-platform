#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../tofu"
source ../backup/bws-common.sh
access=$(tofu output -raw r2_backup_access_key_id)
secret=$(tofu output -raw r2_backup_secret_access_key)
[[ -n $access && -n $secret ]] || { echo 'Credenciais ausentes no state.' >&2; exit 1; }
# Confira ambos antes de criar qualquer secret.
for key in ops__R2_BACKUP_ACCESS_KEY_ID ops__R2_BACKUP_SECRET_ACCESS_KEY; do
  id=$(find_secret "$key")
  if [[ -n $id ]]; then
    current=$(bws secret get "$id" | jq -er '.value')
    expected=$access
    [[ $key == ops__R2_BACKUP_SECRET_ACCESS_KEY ]] && expected=$secret
    [[ $current == "$expected" ]] || { echo "Secret $key já existe com outro valor." >&2; exit 1; }
  fi
done
save_secret ops__R2_BACKUP_ACCESS_KEY_ID "$access"
save_secret ops__R2_BACKUP_SECRET_ACCESS_KEY "$secret"
echo 'Credenciais de Backup conferidas no BWS.'
