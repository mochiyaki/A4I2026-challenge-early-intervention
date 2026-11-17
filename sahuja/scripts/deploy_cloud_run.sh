#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SAHUJA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-qwiklabs-gcp-04-670e1c9d4f6d}"
REGION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
SERVICE_NAME="${A4I_SERVICE_NAME:-first-milestones-sahuja}"
DATASET="${A4I_DATASET:-a4i_early_intervention_sahuja}"
BQ_LOCATION="${A4I_BQ_LOCATION:-us-central1}"
STATE="${A4I_STATE:-CA}"
MODEL="${A4I_MODEL:-gemini-2.5-flash}"

GCLOUD_BIN="$(command -v gcloud || echo /Users/sahuja/data/genai-code/terraform/google-cloud-sdk/bin/gcloud)"

echo "Deploying ${SERVICE_NAME} to Cloud Run in ${PROJECT_ID} (${REGION})..."
"${GCLOUD_BIN}" run deploy "${SERVICE_NAME}" \
  --source "${SAHUJA_DIR}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --min-instances=1 \
  --memory=1Gi \
  --timeout=300 \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},GOOGLE_GENAI_USE_VERTEXAI=TRUE,A4I_DATASET=${DATASET},A4I_BQ_LOCATION=${BQ_LOCATION},A4I_STATE=${STATE},A4I_MODEL=${MODEL}" \
  --quiet
