#!/usr/bin/env bash
#
# A4I 2026 - Early Intervention Triage ("First Milestones")
# Vertex AI Agent Engine Deployment Script (google-adk == 2.14.1)
#
# Usage:
#   bash scripts/deploy_agent_engine.sh --dry-run
#   bash scripts/deploy_agent_engine.sh
#   bash scripts/deploy_agent_engine.sh --project=YOUR_PROJECT_ID --region=us-central1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=false
PROJECT_OVERRIDE=""
REGION_OVERRIDE=""
STAGING_BUCKET_OVERRIDE=""
AGENT_ENGINE_ID="${A4I_AGENT_ENGINE_ID:-}"

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy_agent_engine.sh [OPTIONS]

Deploys ./agent/first_milestones to Vertex AI Agent Engine using google-adk (v2.14.1).

Options:
  --dry-run, -n             Validate CLI flags, agent importability, GCP config, and print exact command without mutating cloud resources.
  --project=PROJECT_ID      Override GCP project (default: gcloud config get-value project).
  --region=REGION           Override Agent Engine region (default: us-central1).
  --staging-bucket=gs://... Override GCS staging/artifact bucket (default: gs://${PROJECT_ID}-a4i-agent-engine).
  --agent-engine-id=ID      Optional existing ReasoningEngine/AgentEngine resource ID to update in place.
  --help, -h                Show this help message and exit.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run|-n)
      DRY_RUN=true
      ;;
    --project=*)
      PROJECT_OVERRIDE="${arg#*=}"
      ;;
    --region=*)
      REGION_OVERRIDE="${arg#*=}"
      ;;
    --staging-bucket=*)
      STAGING_BUCKET_OVERRIDE="${arg#*=}"
      ;;
    --agent-engine-id=*)
      AGENT_ENGINE_ID="${arg#*=}"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument '${arg}'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*" >&2; }

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

command -v gcloud >/dev/null 2>&1 || { echo "ERROR: 'gcloud' CLI not found." >&2; exit 1; }

if [[ -x "${REPO_ROOT}/.venv/bin/python" ]]; then
  PYTHON_BIN="${REPO_ROOT}/.venv/bin/python"
else
  PYTHON_BIN="$(command -v python3 || true)"
fi
[[ -n "${PYTHON_BIN}" ]] || { echo "ERROR: Python interpreter not found." >&2; exit 1; }

if [[ -x "${REPO_ROOT}/.venv/bin/adk" ]]; then
  ADK_BIN="${REPO_ROOT}/.venv/bin/adk"
else
  ADK_BIN="$(command -v adk || true)"
fi
[[ -n "${ADK_BIN}" ]] || { echo "ERROR: 'adk' CLI not found. Install google-adk==2.14.1." >&2; exit 1; }

PROJECT_ID="${PROJECT_OVERRIDE:-${A4I_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}}"
[[ -n "${PROJECT_ID}" && "${PROJECT_ID}" != "(unset)" ]] || {
  echo "ERROR: GCP project is unset. Run 'gcloud config set project YOUR_PROJECT_ID' or pass --project=..." >&2
  exit 1
}

REGION="${REGION_OVERRIDE:-${A4I_AGENT_ENGINE_REGION:-us-central1}}"
STAGING_BUCKET="${STAGING_BUCKET_OVERRIDE:-${A4I_STAGING_BUCKET:-gs://${PROJECT_ID}-a4i-agent-engine}}"
if [[ "${STAGING_BUCKET}" != gs://* ]]; then
  STAGING_BUCKET="gs://${STAGING_BUCKET}"
fi

AGENT_DIR="${REPO_ROOT}/agent/first_milestones"
DATA_DIR="${REPO_ROOT}/data"
DISPLAY_NAME="${A4I_AGENT_ENGINE_DISPLAY_NAME:-First Milestones IDEA Part C Triage Coordinator}"
DESCRIPTION="IDEA Part C 45-Day Early Intervention Triage & Multi-Hop Referral Graph Coordinator (100% Synthetic Providers)"
DATASET="${A4I_DATASET:-a4i_early_intervention}"
MULTISTATE_DATASET="${A4I_MULTISTATE_DATASET:-a4i_early_intervention_multistate}"
BQ_LOCATION="${A4I_LOCATION:-US}"
STATE="${A4I_STATE:-MS}"
GEMINI_MODEL="${A4I_GEMINI_MODEL:-gemini-2.5-pro}"
SUBAGENT_MODEL="${A4I_SUBAGENT_MODEL:-gemini-2.5-flash}"

[[ -d "${AGENT_DIR}" && -f "${AGENT_DIR}/agent.py" ]] || {
  echo "ERROR: ADK agent package not found at ${AGENT_DIR}" >&2
  exit 1
}

TEMP_STAGE_DIR="/tmp/first_milestones_ae_stage_$$"
TEMP_CONFIG_FILE="/tmp/first_milestones_ae_config_$$.json"
TEMP_LAUNCHER="/tmp/first_milestones_ae_launcher_$$.py"

cleanup() {
  rm -rf "${TEMP_STAGE_DIR}" "${TEMP_CONFIG_FILE}" "${TEMP_LAUNCHER}" 2>/dev/null || true
}
trap cleanup EXIT

bold "=== Vertex AI Agent Engine Deployment (${PROJECT_ID} · ${REGION}) ==="
info "Mode            : $( [[ "${DRY_RUN}" == "true" ]] && echo "DRY-RUN (no cloud mutations)" || echo "LIVE DEPLOYMENT" )"
info "Agent Package   : ${AGENT_DIR}"
info "Staging Bucket  : ${STAGING_BUCKET}"
info "Coordinator Mdl : ${GEMINI_MODEL} (Sub-agents: ${SUBAGENT_MODEL})"

bold "1/4  Validating google-adk CLI flags & First Milestones agent importability"
HELP_OUT="$("${ADK_BIN}" deploy agent_engine --help)"
for required_flag in "--project" "--region" "--display_name" "--description" "--python_version" "--otel_to_cloud" "--artifact_service_uri" "--extra_packages" "--agent_engine_config_file" "--temp_folder"; do
  if ! grep -q -- "${required_flag}" <<<"${HELP_OUT}"; then
    echo "ERROR: Installed 'adk deploy agent_engine' does not support expected flag '${required_flag}'." >&2
    exit 1
  fi
done

IMPORT_SUMMARY="$(
  A4I_FORCE_LOCAL_FALLBACK=1 PYTHONPATH="${REPO_ROOT}/agent" "${PYTHON_BIN}" -c "
from first_milestones.agent import root_agent
sub_names = [getattr(s, 'name', str(s)) for s in getattr(root_agent, 'sub_agents', []) or []]
print(f'root_agent={root_agent.name} tools={len(getattr(root_agent, \"tools\", []) or [])} sub_agents={sub_names}')
"
)"
info "Verified ADK import: ${IMPORT_SUMMARY}"

cat >"${TEMP_CONFIG_FILE}" <<EOF
{
  "display_name": "${DISPLAY_NAME}",
  "description": "${DESCRIPTION}",
  "python_version": "3.12",
  "env_vars": {
    "A4I_DATASET": "${DATASET}",
    "A4I_MULTISTATE_DATASET": "${MULTISTATE_DATASET}",
    "A4I_LOCATION": "${BQ_LOCATION}",
    "A4I_STATE": "${STATE}",
    "A4I_GEMINI_MODEL": "${GEMINI_MODEL}",
    "A4I_SUBAGENT_MODEL": "${SUBAGENT_MODEL}",
    "A4I_MCP_MODE": "auto"
  }
}
EOF

ADK_CMD=(
  "${ADK_BIN}" deploy agent_engine
  "--project=${PROJECT_ID}"
  "--region=${REGION}"
  "--display_name=${DISPLAY_NAME}"
  "--description=${DESCRIPTION}"
  "--python_version=3.12"
  "--otel_to_cloud"
  "--artifact_service_uri=${STAGING_BUCKET}"
  "--extra_packages=${DATA_DIR}"
  "--agent_engine_config_file=${TEMP_CONFIG_FILE}"
  "--temp_folder=${TEMP_STAGE_DIR}"
)
if [[ -n "${AGENT_ENGINE_ID}" ]]; then
  ADK_CMD+=("--agent_engine_id=${AGENT_ENGINE_ID}")
fi
ADK_CMD+=("${AGENT_DIR}")

if [[ "${DRY_RUN}" == "true" ]]; then
  bold "2/4  Checking GCP API readiness (read-only dry-run check)"
  ENABLED_SVCS="$(gcloud services list --enabled --project="${PROJECT_ID}" --format="value(config.name)" 2>/dev/null || true)"
  for svc in aiplatform.googleapis.com storage.googleapis.com; do
    if grep -qx "${svc}" <<<"${ENABLED_SVCS}"; then
      info "API enabled: ${svc}"
    else
      info "API will be enabled on live run: ${svc}"
    fi
  done

  bold "3/4  Staging & Agent Engine Runtime Configuration (.agent_engine_config.json)"
  cat "${TEMP_CONFIG_FILE}"

  bold "4/4  Validated Vertex AI Agent Engine Command (--dry-run)"
  printf '  '
  printf '%q ' "${ADK_CMD[@]}"
  printf '\n'
  bold "Dry-run validation succeeded."
  exit 0
fi

bold "2/4  Ensuring Vertex AI & Cloud Storage APIs are enabled"
gcloud services enable \
  aiplatform.googleapis.com \
  storage.googleapis.com \
  cloudbuild.googleapis.com \
  --project="${PROJECT_ID}" \
  --quiet

bold "3/4  Ensuring regional GCS staging/artifact bucket exists (${STAGING_BUCKET})"
if gcloud storage buckets describe "${STAGING_BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  info "Bucket already exists: ${STAGING_BUCKET}"
else
  info "Creating regional bucket ${STAGING_BUCKET} in ${REGION}..."
  gcloud storage buckets create "${STAGING_BUCKET}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --quiet
  info "Created ${STAGING_BUCKET}."
fi

bold "4/4  Deploying './agent/first_milestones' to Vertex AI Agent Engine"

# Build a resilient Python launcher that:
# 1. Uses existing Application Default Credentials if configured, OR bridges `gcloud auth print-access-token`
#    in-memory when running in a local/Qwiklabs shell without application_default_credentials.json.
# 2. Invokes google.adk.cli.cli_tools_click.main with the exact validated flags.
cat >"${TEMP_LAUNCHER}" <<'PYEOF'
import os
import subprocess
import sys
import google.auth
from google.oauth2 import credentials as oauth2_credentials

try:
    creds, proj = google.auth.default()
except Exception:
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
    proj = os.environ.get("GOOGLE_CLOUD_PROJECT") or subprocess.check_output(
        ["gcloud", "config", "get-value", "project"], text=True
    ).strip()
    _fallback_creds = oauth2_credentials.Credentials(token=token, quota_project_id=proj)
    _orig_default = google.auth.default

    def _patched_default(scopes=None, request=None, quota_project_id=None, default_scopes=None):
        return _fallback_creds, (quota_project_id or proj)

    google.auth.default = _patched_default

from google.adk.cli.cli_tools_click import main

if __name__ == "__main__":
    sys.exit(main())
PYEOF

LAUNCH_ARGS=("${ADK_CMD[@]:1}")

set +e
if "${PYTHON_BIN}" -c "import agentplatform" >/dev/null 2>&1; then
  CI=true GOOGLE_CLOUD_PROJECT="${PROJECT_ID}" "${PYTHON_BIN}" "${TEMP_LAUNCHER}" "${LAUNCH_ARGS[@]}" </dev/null
  DEPLOY_EXIT=$?
elif command -v uv >/dev/null 2>&1; then
  info "Using ephemeral 'uv run --with google-cloud-agentplatform' for Agent Platform v2 SDK..."
  CI=true GOOGLE_CLOUD_PROJECT="${PROJECT_ID}" uv run --python "${PYTHON_BIN}" --with "google-cloud-agentplatform>=2.2" python "${TEMP_LAUNCHER}" "${LAUNCH_ARGS[@]}" </dev/null
  DEPLOY_EXIT=$?
else
  warn "Python module 'agentplatform' (google-cloud-agentplatform>=2.2) is not installed in ${PYTHON_BIN}."
  warn "Install with: pip install 'google-cloud-agentplatform>=2.2' and re-run."
  DEPLOY_EXIT=2
fi
set -e

if [[ "${DEPLOY_EXIT}" -ne 0 ]]; then
  warn "Agent Engine live deployment exited with code ${DEPLOY_EXIT}."
  warn "Note: google-adk automatically cleans up newly created partial runtime instances on deployment failure."
  warn "If running in a restricted Qwiklabs sandbox (IAM/org-policy/quota), use Cloud Run ('bash scripts/deploy_cloud_run.sh') as primary runtime."
  exit "${DEPLOY_EXIT}"
fi

bold "Vertex AI Agent Engine Deployment Complete!"
