#!/bin/bash
set -euo pipefail
export TZ=UTC
: "${BACKUP_PRODUCT:?}" "${BACKUP_DATABASE:?}" "${BACKUP_TYPE:?}" "${AGE_PUBLIC_KEY:?}" "${R2_ENDPOINT:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${HEALTHCHECKS_URL:?}"
[[ $BACKUP_PRODUCT =~ ^[a-zA-Z0-9_-]+$ && $BACKUP_DATABASE =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Nome de Produto ou banco inválido.' >&2; exit 1; }
ping() { curl --silent --show-error --max-time 10 --retry 2 "$1" >/dev/null || true; }
ping "${HEALTHCHECKS_URL%/}/start"
tmp=$(mktemp -d)
trap 'status=$?; rm -rf "$tmp"; if (( status )); then ping "${HEALTHCHECKS_URL%/}/fail"; fi' EXIT
case "$BACKUP_TYPE" in
  postgres) : "${DATABASE_URL:?}"; pg_dump --no-owner --no-privileges "$DATABASE_URL" > "$tmp/data.sql"; ext=sql ;;
  sqlite) : "${SQLITE_PATH:?}"; test -f "$SQLITE_PATH"; sqlite3 "$SQLITE_PATH" ".backup '$tmp/data.sqlite'"; ext=sqlite ;;
  *) echo 'Tipo de banco inválido.' >&2; exit 1 ;;
esac
gzip -c "$tmp/data.$ext" | age -r "$AGE_PUBLIC_KEY" > "$tmp/backup.gz.age"
name="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n').$ext.gz.age"
for prefix in daily $([[ $(date -u +%u) == 7 ]] && printf weekly) $([[ $(date -u +%d) == 01 ]] && printf monthly); do
  curl --fail --silent --show-error --retry 3 --aws-sigv4 'aws:amz:auto:s3' --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" --upload-file "$tmp/backup.gz.age" "${R2_ENDPOINT%/}/dangus-backups/$prefix/$BACKUP_PRODUCT/$BACKUP_DATABASE/$name"
done
ping "$HEALTHCHECKS_URL"
