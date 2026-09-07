#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -eq 1 ]] || { echo "usage: $0 TARGET_REPOSITORY" >&2; exit 64; }

artifact_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=$1
while IFS= read -r source; do
  relative=$(printf '%s' "$source" | sed "s#^$artifact_dir/original/##")
  mkdir -p "$target/$(dirname "$relative")"
  cp "$source" "$target/$relative"
done < <(find "$artifact_dir/original" -type f | sort)

expected_count=$(wc -l < "$artifact_dir/original.sha256" | tr -d ' ')
actual_count=$(find "$artifact_dir/original" -type f | wc -l | tr -d ' ')
[[ "$actual_count" == "$expected_count" ]] || { echo "rollback file count mismatch" >&2; exit 1; }
printf 'restored Turnstile-enabled configuration (%s files)\n' "$actual_count"
