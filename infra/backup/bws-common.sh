#!/usr/bin/env bash
set -euo pipefail
: "${OPS_PROJECT_ID:?Defina OPS_PROJECT_ID com o ID do projeto ops}"

find_secret() {
  bws secret list "$OPS_PROJECT_ID" | jq -er --arg key "$1" '[.[] | select(.key == $key) | .id] | if length > 1 then error("secret duplicado") elif length == 0 then "" else .[0] end'
}

save_secret() {
  local key=$1 value=$2 id current
  id=$(find_secret "$key")
  if [[ -n $id ]]; then
    current=$(bws secret get "$id" | jq -er '.value')
    [[ $current == "$value" ]] || { echo "Secret $key já existe com outro valor." >&2; return 1; }
  else
    bws secret create "$key" "$value" "$OPS_PROJECT_ID" -o none >/dev/null
  fi
}
