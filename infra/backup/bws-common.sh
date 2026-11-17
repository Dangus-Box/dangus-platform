#!/usr/bin/env bash
set -euo pipefail
: "${OPS_PROJECT_ID:?Set OPS_PROJECT_ID to the ops project ID}"

find_secret() {
  bws secret list "$OPS_PROJECT_ID" | jq -er --arg key "$1" '[.[] | select(.key == $key) | .id] | if length > 1 then error("duplicate secret") elif length == 0 then "" else .[0] end'
}

# Print the ID if the secret exists with the same value; fail if the value differs.
existing_secret() {
  local id current
  id=$(find_secret "$1")
  [[ -n $id ]] || return 0
  current=$(bws secret get "$id" | jq -er '.value')
  [[ $current == "$2" ]] || { echo "Secret $1 already exists with a different value." >&2; return 1; }
  echo "$id"
}

create_secret() {
  bws secret create "$1" "$2" "$OPS_PROJECT_ID" -o none >/dev/null
}
