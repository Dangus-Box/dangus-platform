#!/bin/bash
set -euo pipefail
umask 077
: "${BACKUP_PRODUCT:?}" "${BACKUP_DATABASE:?}" "${BACKUP_TYPE:?}" "${AGE_PUBLIC_KEY:?}" "${R2_ENDPOINT:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${HEALTHCHECKS_URL:?}"
[[ $BACKUP_PRODUCT =~ ^[a-zA-Z0-9_-]+$ && $BACKUP_DATABASE =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid Product or database name.' >&2; exit 1; }
# URLs and credentials go through curl stdin (--config -), never argv visible in /proc/*/cmdline.
ping() { printf 'url = "%s"\n' "${HEALTHCHECKS_URL%/}$1" | curl --fail --silent --show-error --max-time 10 --retry 2 --config - >/dev/null; }
ping /start || true
tmp=$(mktemp -d)
trap 'status=$?; rm -rf "$tmp"; if (( status )); then ping /fail || true; fi' EXIT
case "$BACKUP_TYPE" in
  postgres)
    # pg_dump reads PGHOST, PGUSER, PGDATABASE and PGPASSWORD from the environment; the plain-text dump never touches disk.
    : "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}" "${PGPASSWORD:?}"
    ext=sql
    pg_dump --no-owner --no-privileges | gzip | age -r "$AGE_PUBLIC_KEY" > "$tmp/backup" ;;
  sqlite)
    : "${SQLITE_PATH:?}"
    test -f "$SQLITE_PATH"
    ext=sqlite
    sqlite3 -cmd '.timeout 10000' "$SQLITE_PATH" ".backup '$tmp/data.sqlite'"
    gzip -c "$tmp/data.sqlite" | age -r "$AGE_PUBLIC_KEY" > "$tmp/backup"
    rm "$tmp/data.sqlite" ;;
  *) echo 'Invalid database type.' >&2; exit 1 ;;
esac
# Read the clock once so the name and prefixes agree across midnight.
now=$(date -u '+%Y%m%dT%H%M%SZ %u %d')
read -r stamp weekday day <<< "$now"
name="$stamp-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n').$ext.gz.age"
for prefix in daily $([[ $weekday == 7 ]] && printf weekly) $([[ $day == 01 ]] && printf monthly); do
  printf 'user = "%s:%s"\n' "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" |
    curl --fail --silent --show-error --retry 3 --aws-sigv4 'aws:amz:auto:s3' --config - --upload-file "$tmp/backup" "${R2_ENDPOINT%/}/dangus-backups/$prefix/$BACKUP_PRODUCT/$BACKUP_DATABASE/$name"
done
ping ""
