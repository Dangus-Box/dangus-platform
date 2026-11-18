FROM postgres:18.1@sha256:1090bc3a8ccfb0b55f78a494d76f8d603434f7e4553543d6e807bc7bd6bbd17f
RUN apt-get update && apt-get install -y --no-install-recommends \
    age=1.2.1-1+b5 ca-certificates=20250419+deb13u1 sqlite3=3.46.1-7+deb13u2 curl=8.14.1-2+deb13u7 cron=3.0pl1-197 \
    && rm -rf /var/lib/apt/lists/*
COPY backup.sh entrypoint.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
