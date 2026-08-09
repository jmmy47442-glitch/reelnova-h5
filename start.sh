#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"

cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed or is not in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not installed or is not in PATH." >&2
  exit 1
fi

if [[ ! -x node_modules/.bin/nuxt ]]; then
  echo "Dependencies are missing; installing them now..."
  npm install
fi

echo "Starting ReelNova frontend and API server..."
echo "Frontend: http://localhost:${PORT}/"
echo "Admin:    http://localhost:${PORT}/admin"
echo "API:      http://localhost:${PORT}/api"

exec npm run dev -- --host "$HOST" --port "$PORT"
