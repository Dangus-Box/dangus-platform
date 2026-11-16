#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./bws-common.sh
[[ ! -e age.pub ]] || { echo 'age.pub já existe; recusando sobrescrever.' >&2; exit 1; }
[[ -z $(find_secret ops__BACKUP_AGE_PRIVATE_KEY) ]] || { echo 'Chave privada já existe no BWS; recusando sobrescrever.' >&2; exit 1; }
command -v age-keygen >/dev/null || { echo 'Instale age-keygen antes de continuar.' >&2; exit 1; }
identity=$(age-keygen 2>/dev/null)
public=$(printf '%s\n' "$identity" | sed -n 's/^# public key: //p')
[[ $public == age1* && $identity == *AGE-SECRET-KEY-* ]] || { echo 'Saída de age-keygen inválida.' >&2; exit 1; }
bws secret create ops__BACKUP_AGE_PRIVATE_KEY "$identity" "$OPS_PROJECT_ID" -o none >/dev/null
# noclobber impede sobrescrever se outro processo criar o arquivo.
(set -o noclobber; printf '%s\n' "$public" > age.pub) || { echo 'Chave no BWS; recupere a chave pública antes de continuar.' >&2; exit 1; }
echo 'Chave privada guardada no BWS; chave pública escrita em infra/backup/age.pub.'
