#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
for file in cloudflare/src/index.js cloudflare/test/identity.test.js cloudflare/test/build-config.test.js src/assets/_redirects; do
    git show 36246ef6:"$file" > "$file"
done
rm -f cloudflare/migrations/0003_bookmark_lifecycle.sql
