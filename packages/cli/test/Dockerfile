FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y systemd systemd-sysv && apt-get clean
CMD ["/lib/systemd/systemd"]
