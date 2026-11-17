#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SAHUJA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SAHUJA_DIR}/.." && pwd)"
VENV_PY="${REPO_ROOT}/.venv/bin/python"

PORT="${PORT:-8080}"
echo "Starting First Milestones Coordinator Workbench on http://localhost:${PORT} ..."
cd "${SAHUJA_DIR}"
exec "${VENV_PY}" -m uvicorn app.server:app --host 127.0.0.1 --port "${PORT}"
