#!/bin/zsh
# Runs the same as: npm run crawl:quick (from repo root).
set -eu
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec npm run crawl:quick
