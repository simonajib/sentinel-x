#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf 'Install Node.js 22.13 or newer, then retry.\n' >&2
  exit 1
fi
exec node "$ROOT/scripts/project.mjs" stop "$@"
