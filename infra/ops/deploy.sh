#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
: "${SSH_AUTH_SOCK:?SSH agent obrigatório}"
secret=$(bws secret list | bun -e 'const a=await Bun.stdin.json();const s=a.filter(x=>x.key==="ops__GRAFANA_ADMIN_PASSWORD");if(s.length!==1||typeof s[0].value!=="string")process.exit(1);process.stdout.write(s[0].value)')
export GF_SECURITY_ADMIN_PASSWORD="$secret" KAMAL_REGISTRY_PASSWORD=unused
unset secret
version=$(git rev-parse --verify HEAD)
docker run --rm --network host -v "$PWD:/work" -w /work -v /var/run/docker.sock:/var/run/docker.sock -v "$SSH_AUTH_SOCK:/ssh-agent" -e SSH_AUTH_SOCK=/ssh-agent -e GF_SECURITY_ADMIN_PASSWORD -e KAMAL_REGISTRY_PASSWORD ghcr.io/basecamp/kamal:v2.12.0@sha256:7a3893b47dd328955f86fbf9ba887d08d612b74f96867f077750a53312537625 accessory boot all --config-file deploy.yml --version="$version"
