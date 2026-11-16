#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp "$root/infra/ops/test/native-e2e-XXXXXX.sh")
trap 'rm -f "$tmp"' EXIT
case "${1:-}" in
  umami) source_script=umami-e2e; native_script=umami-e2e ;;
  unleash) source_script=unleash-e2e; native_script=unleash-e2e ;;
  *) echo 'Uso: packages/native/e2e.sh umami|unleash' >&2; exit 1 ;;
esac
cp "$root/infra/ops/test/$source_script.sh" "$tmp"
printf '\nbun --preload "$root/packages/native/test/react-native.ts" "$root/packages/native/src/%s.ts"\n' "$native_script" >> "$tmp"
bash "$tmp"
