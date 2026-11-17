#!/usr/bin/env bash
#
# A4I 2026 - Early Intervention Triage ("First Milestones")
# Loads the chosen state (if needed), declares BigQuery Property Graph
# `a4i_early_intervention.ReferralGraph`, and runs a prefix-deduplicated
# ISO GQL smoke test verifying multi-hop `-{2,4}->` traversals.
#
# Usage (in Google Cloud Shell from repo root):
#   bash scripts/setup_graph.sh          # defaults to MS (Mississippi)
#   bash scripts/setup_graph.sh CA       # California (leading-zero FIPS 06)
#   bash scripts/setup_graph.sh --graph-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

load_dotenv() {
  local env_file="${REPO_ROOT}/.env" line_no=0 line key val
  [[ -f "${env_file}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line_no=$((line_no + 1))
    [[ "${line_no}" -le 200 ]] || { echo "ERROR: .env exceeds 200 lines." >&2; exit 1; }
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    if [[ "${line}" =~ ^(A4I_[A-Z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      val="${val%$'\r'}"
      if [[ "${val}" =~ ^\"(.*)\"$ || "${val}" =~ ^\'(.*)\'$ ]]; then
        val="${BASH_REMATCH[1]}"
      fi
      if [[ -z "${!key:-}" ]]; then
        export "${key}=${val}"
      fi
    fi
  done < "${env_file}"
}

load_dotenv

DATASET="${A4I_DATASET:-a4i_early_intervention}"
LOCATION="${A4I_LOCATION:-US}"
ARG="${1:-MS}"

if [[ ! "${DATASET}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ || ${#DATASET} -gt 1024 ]]; then
  echo "ERROR: Invalid dataset identifier '${DATASET}'. Must match ^[a-zA-Z_][a-zA-Z0-9_]*$." >&2
  exit 1
fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

command -v bq >/dev/null 2>&1 || { echo "ERROR: 'bq' CLI not found. Run in Google Cloud Shell."; exit 1; }
command -v gcloud >/dev/null 2>&1 || { echo "ERROR: 'gcloud' CLI not found. Run in Google Cloud Shell."; exit 1; }

PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
[[ -n "${PROJECT_ID}" && "${PROJECT_ID}" != "(unset)" ]] || {
  echo "ERROR: No GCP project configured. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
}

if [[ "${ARG}" != "--graph-only" ]]; then
  bold "Step 1/3  Provisioning reservation & loading state data (${ARG})"
  A4I_ALLOW_RESERVATION_FALLBACK=1 bash "${SCRIPT_DIR}/load.sh" "${ARG}"
fi

bold "Step 2/3  Creating BigQuery Property Graph: ${DATASET}.ReferralGraph"
DDL="$(sed "s/a4i_early_intervention/${DATASET}/g" "${SCRIPT_DIR}/setup_graph.sql")"
printf '%s\n' "${DDL}" | bq --project_id="${PROJECT_ID}" --location="${LOCATION}" query --use_legacy_sql=false
info "Created ${PROJECT_ID}.${DATASET}.ReferralGraph"
echo

bold "Step 3/3  Smoke-testing ISO GQL variable-length -{2,4}-> traversal (prefix-deduplicated)"
bq --project_id="${PROJECT_ID}" --location="${LOCATION}" query --use_legacy_sql=false --format=pretty "
WITH traversed AS (
  SELECT *
  FROM GRAPH_TABLE(
    ${DATASET}.ReferralGraph
    MATCH (clinic:CareNode {node_role: 'Screening_Pediatric_Clinic'})
          -[hops:ReferralHandoff]->{2,4}
          (vendor:CareNode {node_role: 'EI_Therapy_Vendor'})
    WHERE hops[OFFSET(0)].hop_sequence = 1
      AND (SELECT COUNT(DISTINCT h.case_chain_id) FROM UNNEST(hops) AS h) = 1
    LET total_hops = ARRAY_LENGTH(hops),
        chain_id = hops[OFFSET(0)].case_chain_id,
        child_age_months = hops[OFFSET(0)].child_age_months,
        intake_coord_id = hops[OFFSET(0)].target_provider_id,
        chain_wait_days = (SELECT SUM(h.handoff_wait_days) FROM UNNEST(hops) AS h),
        fax_hops = (SELECT COUNTIF(h.transmission_channel = 'paper_fax') FROM UNNEST(hops) AS h)
    RETURN
      chain_id,
      child_age_months,
      clinic.synthetic_organization_name AS origin_clinic,
      intake_coord_id,
      vendor.synthetic_organization_name AS final_vendor,
      total_hops,
      fax_hops,
      chain_wait_days
  )
  QUALIFY ROW_NUMBER() OVER (PARTITION BY chain_id ORDER BY total_hops DESC) = 1
)
SELECT
  COUNT(*) AS total_complete_chains,
  COUNTIF(total_hops >= 3) AS chains_3_to_4_hops,
  COUNTIF(chain_wait_days > 45) AS statutory_45d_breaches,
  MAX(chain_wait_days) AS worst_episode_wait_days
FROM traversed;
"

info "Verifying Neighborhood, SERVES_AREA, REFERS_TO, and CAN_REFER_TO graph tables"
bq --project_id="${PROJECT_ID}" --location="${LOCATION}" query --use_legacy_sql=false --format=pretty "
WITH serves AS (
  SELECT *
  FROM GRAPH_TABLE(
    ${DATASET}.ReferralGraph
    MATCH (p:CareNode)-[s:SERVES_AREA]->(n:Neighborhood)
    RETURN p.provider_id, n.tract_geoid, s.travel_distance_km
  )
),
refers AS (
  SELECT *
  FROM GRAPH_TABLE(
    ${DATASET}.ReferralGraph
    MATCH (a:CareNode)-[r:REFERS_TO]->(b:CareNode)
    RETURN r.referral_event_id, r.bounce_flag
  )
),
can_refer AS (
  SELECT *
  FROM GRAPH_TABLE(
    ${DATASET}.ReferralGraph
    MATCH (a:CareNode)-[c:CAN_REFER_TO]->(b:CareNode)
    RETURN c.can_refer_edge_id, c.relationship_type, c.expected_step_days
  )
)
SELECT
  (SELECT COUNT(DISTINCT tract_geoid) FROM serves) AS served_neighborhoods,
  (SELECT COUNT(*) FROM serves) AS total_serves_area_edges,
  (SELECT COUNT(*) FROM refers) AS total_refers_to_edges,
  (SELECT CAST(SUM(bounce_flag) AS INT64) FROM refers) AS bounce_edges,
  (SELECT COUNT(*) FROM can_refer) AS total_can_refer_to_edges,
  (SELECT COUNTIF(relationship_type = 'observed_clean_corridor') FROM can_refer) AS observed_clean_corridor_edges;
"

bold "BigQuery Property Graph ${DATASET}.ReferralGraph is live and verified."
