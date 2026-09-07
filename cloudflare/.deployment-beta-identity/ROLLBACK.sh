#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -eq 1 ]] || { echo "usage: $0 TARGET_REPOSITORY" >&2; exit 64; }

artifact_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=$1
cp "$artifact_dir/environments.before.json" "$target/cloudflare/environments.json"
cp "$artifact_dir/wrangler.before.toml" "$target/cloudflare/wrangler.toml"

for file in environments.before.json wrangler.before.toml; do
  expected=$(awk -v name="$file" '$2 ~ name { print $1 }' "$artifact_dir/original.sha256")
  actual=$(shasum -a 256 "$artifact_dir/$file" | awk '{ print $1 }')
  [[ "$actual" == "$expected" ]] || { echo "rollback hash mismatch: $file" >&2; exit 1; }
done
printf 'restored Beta Pages configuration\n'
