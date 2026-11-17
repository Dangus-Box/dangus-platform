#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./bws-common.sh
[[ ! -e age.pub ]] || { echo 'age.pub already exists; refusing to overwrite.' >&2; exit 1; }
for key in ops__BACKUP_AGE_PRIVATE_KEY ops__BACKUP_AGE_PUBLIC_KEY; do
  existing=$(find_secret "$key")
  [[ -z $existing ]] || { echo "$key already exists in BWS; refusing to overwrite." >&2; exit 1; }
done
command -v age-keygen >/dev/null || { echo 'Install age-keygen before continuing.' >&2; exit 1; }
identity=$(age-keygen 2>/dev/null)
public=$(printf '%s\n' "$identity" | sed -n 's/^# public key: //p')
[[ $public == age1* && $identity == *AGE-SECRET-KEY-* ]] || { echo 'Invalid age-keygen output.' >&2; exit 1; }
create_secret ops__BACKUP_AGE_PRIVATE_KEY "$identity"
# Products deploy from their own repositories and read the public key from BWS.
create_secret ops__BACKUP_AGE_PUBLIC_KEY "$public" || { echo 'Private key is in BWS; save its public key in ops__BACKUP_AGE_PUBLIC_KEY.' >&2; exit 1; }
# noclobber prevents overwriting if another process creates the file.
(set -o noclobber; printf '%s\n' "$public" > age.pub) || { echo 'Key is in BWS; recover the public key before continuing.' >&2; exit 1; }
echo 'Private and public keys stored in BWS; public key written to infra/backup/age.pub.'
