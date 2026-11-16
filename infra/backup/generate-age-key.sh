#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./bws-common.sh
[[ ! -e age.pub ]] || { echo 'age.pub já existe; recusando sobrescrever.' >&2; exit 1; }
for key in ops__BACKUP_AGE_PRIVATE_KEY ops__BACKUP_AGE_PUBLIC_KEY; do
  existing=$(find_secret "$key")
  [[ -z $existing ]] || { echo "$key já existe no BWS; recusando sobrescrever." >&2; exit 1; }
done
command -v age-keygen >/dev/null || { echo 'Instale age-keygen antes de continuar.' >&2; exit 1; }
identity=$(age-keygen 2>/dev/null)
public=$(printf '%s\n' "$identity" | sed -n 's/^# public key: //p')
[[ $public == age1* && $identity == *AGE-SECRET-KEY-* ]] || { echo 'Saída de age-keygen inválida.' >&2; exit 1; }
create_secret ops__BACKUP_AGE_PRIVATE_KEY "$identity"
# Produtos fazem deploy do próprio repositório e leem a chave pública do BWS.
create_secret ops__BACKUP_AGE_PUBLIC_KEY "$public" || { echo 'Chave privada no BWS; grave a chave pública dela em ops__BACKUP_AGE_PUBLIC_KEY.' >&2; exit 1; }
# noclobber impede sobrescrever se outro processo criar o arquivo.
(set -o noclobber; printf '%s\n' "$public" > age.pub) || { echo 'Chave no BWS; recupere a chave pública antes de continuar.' >&2; exit 1; }
echo 'Chave privada e pública guardadas no BWS; chave pública escrita em infra/backup/age.pub.'
