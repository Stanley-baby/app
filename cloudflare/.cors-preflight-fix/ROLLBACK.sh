#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -eq 1 ]] || { echo "usage: $0 TARGET_REPOSITORY" >&2; exit 64; }

artifact_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=$1
expected=$(awk '{ print $1 }' "$artifact_dir/original.sha256")
cp "$artifact_dir/index.before.js" "$target/cloudflare/src/index.js"
actual=$(shasum -a 256 "$target/cloudflare/src/index.js" | awk '{ print $1 }')
[[ "$actual" == "$expected" ]] || { echo "rollback hash mismatch" >&2; exit 1; }
printf 'restored preflight source hash %s\n' "$actual"
