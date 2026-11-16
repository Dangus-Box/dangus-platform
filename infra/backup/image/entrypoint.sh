#!/bin/bash
set -euo pipefail
umask 077
: > /etc/backup-env
for name in BACKUP_PRODUCT BACKUP_DATABASE BACKUP_TYPE DATABASE_URL SQLITE_PATH AGE_PUBLIC_KEY R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY HEALTHCHECKS_URL; do
  printf 'export %s=%q\n' "$name" "${!name-}" >> /etc/backup-env
done
printf '0 3 * * * . /etc/backup-env; /usr/local/bin/backup.sh >> /proc/1/fd/1 2>> /proc/1/fd/2\n' | crontab -
exec cron -f
