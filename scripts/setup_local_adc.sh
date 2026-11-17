#!/usr/bin/env bash
#
# A4I 2026 - First Milestones Local GCP / Gcloud Auth Environment Setup
#
# Configures environment variables for 1-command live BigQuery Property Graph
# (ISO GQL), BigQuery Remote MCP, and Vertex AI Gemini execution from macOS /
# Linux workstations authenticated via `gcloud auth login` (even before running
# `gcloud auth application-default login`).
#
# Usage (source into your shell):
#     source scripts/setup_local_adc.sh
#
# Optional: persist standard Google Application Default Credentials on disk:
#     gcloud auth application-default login
#     gcloud auth application-default set-quota-project "$(gcloud config get-value project)"

_detected_project="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "${_detected_project}" || "${_detected_project}" == "(unset)" ]]; then
  _detected_project="qwiklabs-gcp-04-670e1c9d4f6d"
fi

export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-${_detected_project}}"
export GOOGLE_GENAI_USE_VERTEXAI="${GOOGLE_GENAI_USE_VERTEXAI:-TRUE}"
export GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
export A4I_USE_GCLOUD_AUTH="${A4I_USE_GCLOUD_AUTH:-1}"
export A4I_DATASET="${A4I_DATASET:-a4i_early_intervention_multistate}"
export A4I_MULTISTATE_DATASET="${A4I_MULTISTATE_DATASET:-a4i_early_intervention_multistate}"
export A4I_LOCATION="${A4I_LOCATION:-US}"
export A4I_STATE="${A4I_STATE:-MS}"

unset _detected_project

printf 'First Milestones local live GCP environment configured:\n'
printf '  GOOGLE_CLOUD_PROJECT      = %s\n' "${GOOGLE_CLOUD_PROJECT}"
printf '  GOOGLE_GENAI_USE_VERTEXAI = %s\n' "${GOOGLE_GENAI_USE_VERTEXAI}"
printf '  GOOGLE_CLOUD_LOCATION     = %s\n' "${GOOGLE_CLOUD_LOCATION}"
printf '  A4I_USE_GCLOUD_AUTH       = %s (GcloudCliCredentials bridge active if ADC file absent)\n' "${A4I_USE_GCLOUD_AUTH}"
printf '  A4I_DATASET               = %s\n' "${A4I_DATASET}"
printf '  A4I_LOCATION              = %s\n' "${A4I_LOCATION}"
printf '\nTip: For native disk-backed ADC without gcloud subprocess token refresh, run:\n'
printf '  gcloud auth application-default login\n'
