#!/bin/sh
# Roda a retenção do Umami ao iniciar e depois a cada 24 h. Uma falha é registrada
# no log (Loki) e a próxima execução tenta de novo.
set -u
: "${UMAMI_RETENTION:?UMAMI_RETENTION required, e.g. '6 months'}"
while true; do
  echo "umami-retention: deleting data older than $UMAMI_RETENTION"
  psql -X -v retention="$UMAMI_RETENTION" -f /etc/umami-retention/retention.sql ||
    echo "umami-retention: failed" >&2
  sleep 86400
done
