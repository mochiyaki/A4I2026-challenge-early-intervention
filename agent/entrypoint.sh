#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PORT="${PORT:-8080}"
export A4I_LOCATION="${A4I_LOCATION:-US}"
export A4I_DATASET="${A4I_DATASET:-${A4I_MULTISTATE_DATASET:-a4i_early_intervention_multistate}}"
export A4I_STATE="${A4I_STATE:-MS}"

# Start Google MCP Toolbox for Databases in the background when GOOGLE_CLOUD_PROJECT is set
if [[ -n "${GOOGLE_CLOUD_PROJECT:-}" ]] && command -v toolbox >/dev/null 2>&1; then
  TOOLS_TEMPLATE="${SCRIPT_DIR}/tools.yaml"
  RENDERED_TOOLS="/tmp/tools.rendered.yaml"
  export TOOLS_TEMPLATE RENDERED_TOOLS
  python3 - <<'PY'
import os
from pathlib import Path

template_path = Path(os.environ["TOOLS_TEMPLATE"])
rendered_path = Path(os.environ["RENDERED_TOOLS"])
content = template_path.read_text(encoding="utf-8")
replacements = {
    "${GOOGLE_CLOUD_PROJECT}": os.environ.get("GOOGLE_CLOUD_PROJECT", ""),
    "${A4I_LOCATION}": os.environ.get("A4I_LOCATION", "US"),
    "${A4I_DATASET}": os.environ.get("A4I_DATASET", "a4i_early_intervention_multistate"),
}
for placeholder, value in replacements.items():
    content = content.replace(placeholder, value)
rendered_path.write_text(content, encoding="utf-8")
PY

  echo "[entrypoint] Starting Google MCP Toolbox for Databases on 127.0.0.1:5000 (project=${GOOGLE_CLOUD_PROJECT}, location=${A4I_LOCATION}, dataset=${A4I_DATASET})..."
  toolbox --tools-file "${RENDERED_TOOLS}" --address 127.0.0.1 --port 5000 &

  # Wait briefly so ADK's ToolboxToolset sees port 5000 active at import time
  for _ in {1..15}; do
    if python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/api/toolset', timeout=0.5)" >/dev/null 2>&1; then
      echo "[entrypoint] MCP Toolbox ready on http://127.0.0.1:5000"
      break
    fi
    sleep 0.3
  done
fi

echo "[entrypoint] Starting First Milestones ADK + Workbench server on 0.0.0.0:${PORT}..."
exec uvicorn main:app --app-dir "${SCRIPT_DIR}" --host 0.0.0.0 --port "${PORT}"
