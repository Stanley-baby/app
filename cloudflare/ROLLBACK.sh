#!/bin/sh
set -eu

ROOT=${1:?usage: ROLLBACK.sh <copy-root>}
case "$ROOT" in
    /|/*/..|*/../*) echo 'refusing unsafe root' >&2; exit 2 ;;
esac

restore_or_remove() {
    path=$1
    if [ -f "$ROOT/$path.orig" ]; then
        /bin/mv "$ROOT/$path.orig" "$ROOT/$path"
    elif /usr/bin/git -C "$ROOT" ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
        /usr/bin/git -C "$ROOT" checkout -- "$path"
    else
        /bin/rm -f "$ROOT/$path"
    fi
}

for path in \
    build/common.js \
    build/extension.js \
    build/web.js \
    .gitignore \
    package.json \
    src/data/constants/app.js \
    src/index.ejs \
    src/target/extension/manifest/index.js \
    build/environments.js \
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
    cloudflare/ROLLBACK.sh
do
    restore_or_remove "$path"
done
