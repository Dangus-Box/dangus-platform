FROM postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929
RUN apt-get update && apt-get install -y --no-install-recommends \
    age=1.2.1-1+b5 sqlite3=3.46.1-7+deb13u2 curl=8.14.1-2+deb13u7 cron=3.0pl1-197 \
    && rm -rf /var/lib/apt/lists/*
COPY backup.sh entrypoint.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
