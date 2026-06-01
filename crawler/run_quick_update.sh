#!/bin/zsh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
mkdir -p logs

LOCK_DIR="/tmp/crawler-quick-update.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') quick update already running; skipping"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR"
}
trap cleanup EXIT

PYTHON="${PYTHON:-python3}"
echo "$(date '+%Y-%m-%d %H:%M:%S') starting quick update"
"$PYTHON" main.py --quick-update
echo "$(date '+%Y-%m-%d %H:%M:%S') finished quick update"
