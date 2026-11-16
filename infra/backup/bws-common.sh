#!/usr/bin/env bash
set -euo pipefail
: "${OPS_PROJECT_ID:?Defina OPS_PROJECT_ID com o ID do projeto ops}"

find_secret() {
  bws secret list "$OPS_PROJECT_ID" | jq -er --arg key "$1" '[.[] | select(.key == $key) | .id] | if length > 1 then error("secret duplicado") elif length == 0 then "" else .[0] end'
}

# Imprime o ID se o secret já existe com o mesmo valor; falha se existe com outro.
existing_secret() {
  local id current
  id=$(find_secret "$1")
  [[ -n $id ]] || return 0
  current=$(bws secret get "$id" | jq -er '.value')
  [[ $current == "$2" ]] || { echo "Secret $1 já existe com outro valor." >&2; return 1; }
  echo "$id"
}

create_secret() {
  bws secret create "$1" "$2" "$OPS_PROJECT_ID" -o none >/dev/null
}
