#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../tofu"
source ../backup/bws-common.sh
access=$(tofu output -raw r2_backup_access_key_id)
secret=$(tofu output -raw r2_backup_secret_access_key)
[[ -n $access && -n $secret ]] || { echo 'Credenciais ausentes no state.' >&2; exit 1; }
# Confira ambos antes de criar qualquer secret.
access_id=$(existing_secret ops__R2_BACKUP_ACCESS_KEY_ID "$access")
secret_id=$(existing_secret ops__R2_BACKUP_SECRET_ACCESS_KEY "$secret")
[[ -n $access_id ]] || create_secret ops__R2_BACKUP_ACCESS_KEY_ID "$access"
[[ -n $secret_id ]] || create_secret ops__R2_BACKUP_SECRET_ACCESS_KEY "$secret"
echo 'Credenciais de Backup conferidas no BWS.'
