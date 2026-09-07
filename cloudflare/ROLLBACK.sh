#!/bin/sh
set -eu

[ "$#" -eq 1 ] || { echo "usage: $0 TARGET_REPOSITORY" >&2; exit 64; }

artifact_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=$1
expected=$(awk '$2 == "cloudflare/src/index.js" { print $1 }' "$artifact_dir/.issue-3/original.sha256")
[ -n "$expected" ] || { echo "missing original source hash" >&2; exit 65; }

cp "$artifact_dir/.issue-3/index.before.js" "$target/cloudflare/src/index.js"
actual=$(shasum -a 256 "$target/cloudflare/src/index.js" | awk '{ print $1 }')
[ "$actual" = "$expected" ] || { echo "rollback hash mismatch" >&2; exit 1; }
printf 'restored cloudflare/src/index.js %s\n' "$actual"
