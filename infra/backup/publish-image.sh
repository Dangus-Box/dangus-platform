#!/usr/bin/env bash
# Publishes the Backup image under the tag in image/VERSION. Tags are immutable:
# an existing tag, or a registry that cannot be checked, stops the publication.
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
version=$(<"$dir/image/VERSION")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid Backup image version: '$version'." >&2; exit 1; }
image="ghcr.io/dangus-box/backup:$version"
if out=$(docker manifest inspect "$image" 2>&1); then
  echo "$image already exists; bump infra/backup/image/VERSION." >&2
  exit 1
elif [[ $out != *"manifest unknown"* && $out != *"no such manifest"* ]]; then
  echo "Cannot check whether $image exists: $out" >&2
  exit 1
fi
docker build -t "$image" "$dir/image"
docker push "$image"
