#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
git show 38766b86:cloudflare/src/index.js > cloudflare/src/index.js
