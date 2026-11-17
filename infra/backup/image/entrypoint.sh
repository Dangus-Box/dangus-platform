#!/bin/bash
set -euo pipefail
export TZ=UTC
umask 077
# Cron does not inherit the container environment; the file is restricted to root.
: > /etc/backup-env
for name in BACKUP_PRODUCT BACKUP_DATABASE BACKUP_TYPE PGHOST PGUSER PGDATABASE PGPASSWORD SQLITE_PATH AGE_PUBLIC_KEY R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY HEALTHCHECKS_URL; do
  printf 'export %s=%q\n' "$name" "${!name-}" >> /etc/backup-env
done
printf 'SHELL=/bin/bash\nTZ=UTC\n0 3 * * * . /etc/backup-env; /usr/local/bin/backup.sh >> /proc/1/fd/1 2>> /proc/1/fd/2\n' | crontab -
exec cron -f
