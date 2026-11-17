#!/usr/bin/env bash
#
# A4I 2026 - First Milestones Multi-State BigQuery + ReferralGraph Provisioner
#
# Safely provisions all 6 pre-staged starter states (MS, AL, GA, TX, CA, NY)
# into a dedicated multi-state dataset (default: a4i_early_intervention_multistate)
# WITHOUT altering or overwriting the shared single-state a4i_early_intervention
# dataset, then declares all Property Graph views and ReferralGraph (ISO/IEC 39075 GQL).
#
# Usage:
#     bash scripts/load_multistate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

MULTISTATE_DATASET="${A4I_MULTISTATE_DATASET:-a4i_early_intervention_multistate}"
LOCATION="${A4I_LOCATION:-US}"

if [[ "${MULTISTATE_DATASET}" == "a4i_early_intervention" && "${A4I_ALLOW_OVERWRITE_SHARED_DATASET:-0}" != "1" ]]; then
  printf 'ERROR: Refusing to overwrite shared dataset a4i_early_intervention.\n' >&2
  printf 'Use A4I_MULTISTATE_DATASET=a4i_early_intervention_multistate (default).\n' >&2
  exit 1
fi

[[ "${MULTISTATE_DATASET}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
  printf 'ERROR: Invalid dataset identifier %s\n' "${MULTISTATE_DATASET}" >&2
  exit 1
}

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
[[ -n "${PROJECT_ID}" && "${PROJECT_ID}" != "(unset)" ]] || {
  printf 'ERROR: No GCP project configured. Set GOOGLE_CLOUD_PROJECT or run gcloud config set project.\n' >&2
  exit 1
}

printf '\033[1mProvisioning Multi-State BigQuery Foundation: %s.%s\033[0m\n\n' \
  "${PROJECT_ID}" "${MULTISTATE_DATASET}"

A4I_DATASET="${MULTISTATE_DATASET}" \
A4I_LOCATION="${LOCATION}" \
A4I_ALLOW_RESERVATION_FALLBACK="${A4I_ALLOW_RESERVATION_FALLBACK:-1}" \
  bash "${SCRIPT_DIR}/load.sh" ALL

printf '\033[1m4/4  Declaring Views & %s.ReferralGraph (ISO/IEC 39075 GQL)\033[0m\n' \
  "${MULTISTATE_DATASET}"

read -r -d '' GRAPH_DDL <<EOF || true
CREATE OR REPLACE VIEW ${MULTISTATE_DATASET}.v_graph_neighborhoods AS
SELECT
  LPAD(census_tract_geoid, 11, '0') AS tract_geoid,
  state_code,
  county_name,
  children_under_5_count,
  poverty_rate,
  no_vehicle_rate,
  assistance_rate,
  median_household_income,
  latitude,
  longitude
FROM ${MULTISTATE_DATASET}.acs_under5_tract_demographics;

CREATE OR REPLACE VIEW ${MULTISTATE_DATASET}.v_graph_refers_to_edges AS
SELECT
  referral_event_id,
  source_provider_id,
  target_provider_id,
  state_code,
  case_chain_id,
  hop_sequence,
  referral_date,
  receiving_agency_id,
  handoff_wait_days,
  transmission_channel,
  handoff_reason,
  concern_domain,
  child_age_months,
  LPAD(child_home_tract_geoid, 11, '0') AS child_home_tract_geoid,
  quarterly_referral_volume,
  dropoff_rate_pct,
  IF(STARTS_WITH(handoff_reason, 'Re-Referral Bounce'), 1.0, 0.0) AS bounce_flag,
  AVG(IF(STARTS_WITH(handoff_reason, 'Re-Referral Bounce'), 1.0, 0.0)) OVER (
    PARTITION BY source_provider_id, target_provider_id
  ) AS pair_bounce_rate
FROM ${MULTISTATE_DATASET}.deidentified_part_c_referral_logs;

CREATE OR REPLACE VIEW ${MULTISTATE_DATASET}.v_graph_can_refer_to_edges AS
WITH clean_ehr_base AS (
  SELECT
    source_provider_id,
    target_provider_id,
    handoff_wait_days,
    concern_domain,
    ROUND(
      PERCENTILE_CONT(handoff_wait_days, 0.5) OVER (
        PARTITION BY source_provider_id, target_provider_id
      ),
      0
    ) AS median_ehr_wait_days
  FROM ${MULTISTATE_DATASET}.deidentified_part_c_referral_logs
  WHERE transmission_channel = 'ehr_electronic_portal'
    AND NOT STARTS_WITH(handoff_reason, 'Re-Referral Bounce')
),
clean_ehr_top_domain AS (
  SELECT
    source_provider_id,
    target_provider_id,
    ARRAY_AGG(
      concern_domain ORDER BY domain_cnt DESC, concern_domain ASC LIMIT 1
    )[OFFSET(0)] AS primary_concern_domain
  FROM (
    SELECT
      source_provider_id,
      target_provider_id,
      concern_domain,
      COUNT(*) AS domain_cnt
    FROM clean_ehr_base
    GROUP BY source_provider_id, target_provider_id, concern_domain
  )
  GROUP BY source_provider_id, target_provider_id
),
clean_ehr_pairs AS (
  SELECT
    b.source_provider_id,
    b.target_provider_id,
    COUNT(*) AS clean_ehr_events,
    CAST(ANY_VALUE(b.median_ehr_wait_days) AS INT64) AS median_ehr_wait_days,
    td.primary_concern_domain
  FROM clean_ehr_base AS b
  LEFT JOIN clean_ehr_top_domain AS td
    ON b.source_provider_id = td.source_provider_id
   AND b.target_provider_id = td.target_provider_id
  GROUP BY b.source_provider_id, b.target_provider_id, td.primary_concern_domain
),
pair_bounces AS (
  SELECT
    source_provider_id,
    target_provider_id,
    AVG(IF(STARTS_WITH(handoff_reason, 'Re-Referral Bounce'), 1.0, 0.0)) AS edge_bounce_rate
  FROM ${MULTISTATE_DATASET}.deidentified_part_c_referral_logs
  GROUP BY source_provider_id, target_provider_id
),
target_outbound_bounces AS (
  SELECT
    source_provider_id,
    AVG(IF(STARTS_WITH(handoff_reason, 'Re-Referral Bounce'), 1.0, 0.0)) AS outbound_bounce_rate
  FROM ${MULTISTATE_DATASET}.deidentified_part_c_referral_logs
  GROUP BY source_provider_id
)
SELECT
  CONCAT(src.provider_id, '_TO_', dst.provider_id) AS can_refer_edge_id,
  src.provider_id AS source_provider_id,
  dst.provider_id AS target_provider_id,
  src.state_code,
  CASE
    WHEN src.node_role = 'Screening_Pediatric_Clinic' AND dst.node_role = 'Part_C_Intake_Coordinator' THEN 'clinic_to_coord'
    WHEN src.node_role = 'Part_C_Intake_Coordinator' AND dst.node_role = 'Multidisciplinary_Eval_Hub' THEN 'coord_to_eval'
    WHEN src.node_role = 'Multidisciplinary_Eval_Hub' AND dst.node_role = 'EI_Therapy_Vendor' THEN 'eval_to_vendor'
    WHEN src.node_role = 'Part_C_Intake_Coordinator' AND dst.node_role = 'EI_Therapy_Vendor' THEN 'coord_to_vendor_fasttrack'
  END AS stage_transition,
  IF(ehr.clean_ehr_events > 0, 'observed_clean_corridor', 'prospective_capability') AS relationship_type,
  CAST(
    COALESCE(
      ehr.median_ehr_wait_days,
      dst.median_internal_wait_days + CASE
        WHEN dst.node_role = 'Part_C_Intake_Coordinator' THEN 0
        WHEN dst.node_role = 'Multidisciplinary_Eval_Hub' THEN 5
        ELSE 6
      END
    ) AS INT64
  ) AS expected_step_days,
  COALESCE(ehr.primary_concern_domain, 'ALL') AS domain_specialization,
  ROUND(SAFE_DIVIDE(dst.active_waitlist_count, dst.monthly_slot_capacity), 2) AS target_congestion_ratio,
  ROUND(COALESCE(out_b.outbound_bounce_rate, 0.0), 4) AS target_outbound_bounce_rate,
  ROUND(COALESCE(pb.edge_bounce_rate, 0.0), 4) AS edge_bounce_rate,
  dst.accepts_medicaid AS target_accepts_medicaid,
  dst.bilingual_services_listed AS target_bilingual
FROM ${MULTISTATE_DATASET}.pediatric_and_ei_provider_directory AS src
JOIN ${MULTISTATE_DATASET}.pediatric_and_ei_provider_directory AS dst
  ON src.state_code = dst.state_code
 AND src.provider_id != dst.provider_id
LEFT JOIN clean_ehr_pairs AS ehr
  ON src.provider_id = ehr.source_provider_id
 AND dst.provider_id = ehr.target_provider_id
LEFT JOIN pair_bounces AS pb
  ON src.provider_id = pb.source_provider_id
 AND dst.provider_id = pb.target_provider_id
LEFT JOIN target_outbound_bounces AS out_b
  ON dst.provider_id = out_b.source_provider_id
WHERE dst.part_c_vendor_enrolled = TRUE
  AND (
    (src.node_role = 'Screening_Pediatric_Clinic' AND dst.node_role = 'Part_C_Intake_Coordinator')
    OR (src.node_role = 'Part_C_Intake_Coordinator' AND dst.node_role = 'Multidisciplinary_Eval_Hub')
    OR (src.node_role = 'Multidisciplinary_Eval_Hub' AND dst.node_role = 'EI_Therapy_Vendor')
    OR (src.node_role = 'Part_C_Intake_Coordinator' AND dst.node_role = 'EI_Therapy_Vendor')
  );

CREATE OR REPLACE VIEW ${MULTISTATE_DATASET}.v_graph_serves_area_edges AS
SELECT
  CONCAT(p.provider_id, '_', LPAD(n.census_tract_geoid, 11, '0')) AS serves_edge_id,
  p.provider_id,
  LPAD(n.census_tract_geoid, 11, '0') AS tract_geoid,
  ROUND(ST_DISTANCE(ST_GEOGPOINT(p.longitude, p.latitude), ST_GEOGPOINT(n.longitude, n.latitude)) / 1000.0, 2) AS travel_distance_km,
  CAST(ROUND((ST_DISTANCE(ST_GEOGPOINT(p.longitude, p.latitude), ST_GEOGPOINT(n.longitude, n.latitude)) / 1000.0) * 1.5, 0) AS INT64) AS estimated_travel_minutes,
  (p.node_role IN ('Multidisciplinary_Eval_Hub', 'EI_Therapy_Vendor') AND p.part_c_vendor_enrolled) AS mobile_visit_capable
FROM ${MULTISTATE_DATASET}.pediatric_and_ei_provider_directory AS p
JOIN ${MULTISTATE_DATASET}.acs_under5_tract_demographics AS n
  ON p.state_code = n.state_code;

CREATE OR REPLACE PROPERTY GRAPH ${MULTISTATE_DATASET}.ReferralGraph
  NODE TABLES (
    ${MULTISTATE_DATASET}.pediatric_and_ei_provider_directory AS CareNode
      KEY (provider_id)
      LABEL CareNode
      PROPERTIES ALL COLUMNS EXCEPT (provider_geom),
    ${MULTISTATE_DATASET}.v_graph_neighborhoods AS Neighborhood
      KEY (tract_geoid)
      LABEL Neighborhood
      PROPERTIES ALL COLUMNS
  )
  EDGE TABLES (
    ${MULTISTATE_DATASET}.deidentified_part_c_referral_logs AS ReferralHandoff
      KEY (referral_event_id)
      SOURCE KEY (source_provider_id) REFERENCES CareNode (provider_id)
      DESTINATION KEY (target_provider_id) REFERENCES CareNode (provider_id)
      LABEL ReferralHandoff
      PROPERTIES ALL COLUMNS,
    ${MULTISTATE_DATASET}.v_graph_refers_to_edges AS REFERS_TO
      KEY (referral_event_id)
      SOURCE KEY (source_provider_id) REFERENCES CareNode (provider_id)
      DESTINATION KEY (target_provider_id) REFERENCES CareNode (provider_id)
      LABEL REFERS_TO
      PROPERTIES ALL COLUMNS,
    ${MULTISTATE_DATASET}.v_graph_can_refer_to_edges AS CAN_REFER_TO
      KEY (can_refer_edge_id)
      SOURCE KEY (source_provider_id) REFERENCES CareNode (provider_id)
      DESTINATION KEY (target_provider_id) REFERENCES CareNode (provider_id)
      LABEL CAN_REFER_TO
      PROPERTIES ALL COLUMNS,
    ${MULTISTATE_DATASET}.v_graph_serves_area_edges AS SERVES_AREA
      KEY (serves_edge_id)
      SOURCE KEY (provider_id) REFERENCES CareNode (provider_id)
      DESTINATION KEY (tract_geoid) REFERENCES Neighborhood (tract_geoid)
      LABEL SERVES_AREA
      PROPERTIES ALL COLUMNS
  );
EOF

bq --project_id="${PROJECT_ID}" --location="${LOCATION}" query \
  --use_legacy_sql=false --format=none "${GRAPH_DDL}" 2>/dev/null

printf '  declared views + %s.ReferralGraph\n\n' "${MULTISTATE_DATASET}"

printf '\033[1mMulti-State ISO GQL Verification (%s.ReferralGraph):\033[0m\n' "${MULTISTATE_DATASET}"
bq --project_id="${PROJECT_ID}" --location="${LOCATION}" query --use_legacy_sql=false "
WITH complete_chains AS (
  SELECT * FROM GRAPH_TABLE(
    ${MULTISTATE_DATASET}.ReferralGraph
    MATCH (c:CareNode {node_role: 'Screening_Pediatric_Clinic'})
          -[r:ReferralHandoff]->{2,4}
          (v:CareNode {node_role: 'EI_Therapy_Vendor'})
    WHERE r[OFFSET(0)].hop_sequence = 1
      AND (SELECT COUNT(DISTINCT h.case_chain_id) FROM UNNEST(r) AS h) = 1
    LET state_code = c.state_code,
        chain_id = r[OFFSET(0)].case_chain_id,
        total_hops = ARRAY_LENGTH(r),
        chain_wait_days = (SELECT SUM(h.handoff_wait_days) FROM UNNEST(r) AS h)
    RETURN state_code, chain_id, total_hops, chain_wait_days
  )
  QUALIFY ROW_NUMBER() OVER (PARTITION BY chain_id ORDER BY total_hops DESC) = 1
)
SELECT
  state_code,
  COUNT(*) AS complete_chains,
  COUNTIF(total_hops >= 3) AS chains_3_4_hops,
  COUNTIF(chain_wait_days > 45) AS breaches_over_45d
FROM complete_chains
GROUP BY state_code
ORDER BY state_code;
" 2>/dev/null

printf '\n\033[1mMulti-State BigQuery + Property Graph Ready: %s.%s.ReferralGraph\033[0m\n' \
  "${PROJECT_ID}" "${MULTISTATE_DATASET}"
