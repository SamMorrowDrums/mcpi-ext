#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN environment variable is required" >&2
  exit 1
fi

if [ $# -eq 0 ]; then
  echo "ERROR: No task provided. Pass the task as arguments." >&2
  echo "Usage: docker run -e GITHUB_TOKEN=... IMAGE \"your task here\"" >&2
  exit 1
fi

TASK="$*"

PI_ARGS=(
  -e /app/dist/index.js
  --provider github-copilot
  --mode json
  -p
  --no-session
)

if [ -n "${PI_MODEL:-}" ]; then
  PI_ARGS+=(--model "$PI_MODEL")
fi

exec npx pi "${PI_ARGS[@]}" "$TASK"
