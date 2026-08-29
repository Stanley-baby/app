#!/bin/sh
set -eu

ROOT=${1:?usage: ROLLBACK.sh <copy-root>}
case "$ROOT" in
    /|/*/..|*/../*) echo 'refusing unsafe root' >&2; exit 2 ;;
esac

for path in \
    build/common.js \
    build/extension.js \
    build/web.js \
    .gitignore \
    package.json \
    src/data/constants/app.js \
    src/index.ejs \
    src/target/extension/manifest/index.js
do
    if [ -f "$ROOT/$path.orig" ]; then
        mv "$ROOT/$path.orig" "$ROOT/$path"
    elif git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git -C "$ROOT" checkout -- "$path"
    fi
done

for path in \
    cloudflare/environments.json \
    cloudflare/package.json \
    cloudflare/src/index.js \
    cloudflare/contracts/v1-routes.json \
    cloudflare/contracts/openapi.yaml \
    cloudflare/test/contract.test.js \
    cloudflare/test/build-config.test.js \
    cloudflare/.dev.vars.example \
    cloudflare/README.md \
    cloudflare/migrations/0001_initial.sql \
    cloudflare/wrangler.toml \
    cloudflare/CF_ENVIRONMENT.diff \
    cloudflare/VERIFICATION.txt \
    cloudflare/ROLLBACK.sh \
    build/environments.js
do
    rm -f "$ROOT/$path"
done
