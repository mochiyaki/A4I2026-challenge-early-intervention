#!/usr/bin/env bash
#
# A4I 2026 - Early Intervention & Developmental Screening Triage
# Headless fallback for notebooks/c_ei_01_load_explore.ipynb
#
# Provisions an idempotent zero-baseline Enterprise reservation for BigQuery
# Graph (GQL) and rebuilds the same five BigQuery tables the notebook produces,
# either from a pre-staged Cloud Storage snapshot (when A4I_SNAPSHOT_BUCKET is
# set in .env or the environment) or directly from repo data/*.parquet via bq.
#
# Run it from the repo root in Cloud Shell (no chmod needed - invoke with bash):
#     bash scripts/load.sh                 # defaults to MS (Mississippi)
#     bash scripts/load.sh AL              # Alabama (leading-zero FIPS 01)
#     bash scripts/load.sh CA              # California (leading-zero FIPS 06)
#     bash scripts/load.sh ALL             # all 6 starter states (MS, AL, GA, TX, CA, NY)
#     bash scripts/load.sh --list          # show available states
#
# You still want the notebook if you can run it. Section 2 proves why sorting
# flat provider waitlists misses multi-hop paper-fax referral bottlenecks, and
# Sections 4-5 expose the all-zero ACS limited_english_rate column and 6x
# statewide NSCH grain traps. This script gets you the tables without that.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TABLES=(
  acs_under5_tract_demographics
  nsch_developmental_screening_survey
  idea_part_c_agency_performance
  pediatric_and_ei_provider_directory
  deidentified_part_c_referral_logs
)
REQUIRED=("${TABLES[@]}")
SCOPE_ORDER=(MS AL GA TX CA NY)

declare -A STATE_NAMES=(
  [MS]="Mississippi (FIPS 28) - the notebook default"
  [AL]="Alabama (FIPS 01 - leading-zero state)"
  [GA]="Georgia (FIPS 13)"
  [TX]="Texas (FIPS 48)"
  [CA]="California (FIPS 06 - leading-zero state)"
  [NY]="New York (FIPS 36)"
)

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() {
  printf '\n\033[1mERROR:\033[0m %s\n\n%s\n\n' "$*" \
    "This script is safe to run again - every table load replaces whatever was there." >&2
  exit 1
}

on_interrupt() {
  printf '\n\n\033[1mInterrupted.\033[0m Nothing is broken.\n'
  printf 'Every load replaces the whole table, so run this script again:\n'
  printf '    bash scripts/load.sh %s\n\n' "${STATE:-<STATE>}"
  exit 130
}
trap on_interrupt INT TERM

load_dotenv() {
  local env_file="${REPO_ROOT}/.env" line_no=0 line key val
  [[ -f "${env_file}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line_no=$((line_no + 1))
    [[ "${line_no}" -le 200 ]] || fail ".env exceeds 200 lines."
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
        declare -gx "${key}=${val}"
      fi
    fi
  done < "${env_file}"
}

run_timed() {
  [[ $# -ge 1 ]] || fail "Internal error: run_timed called without command."
  [[ "${CMD_TIMEOUT_SEC}" =~ ^[1-9][0-9]{0,3}$ ]] \
    || fail "Invalid A4I_CMD_TIMEOUT_SEC='${CMD_TIMEOUT_SEC}' (expected 1..9999)."
  if command -v timeout >/dev/null 2>&1; then
    timeout "${CMD_TIMEOUT_SEC}s" "$@"
  else
    "$@"
  fi
}

validate_config() {
  SNAPSHOT_BUCKET="${A4I_SNAPSHOT_BUCKET:-}"
  SNAPSHOT_BUCKET="${SNAPSHOT_BUCKET#gs://}"
  SNAPSHOT_BUCKET="${SNAPSHOT_BUCKET%/}"
  SNAPSHOT_PREFIX="${A4I_SNAPSHOT_PREFIX:-a4i-2026/challenge-early-intervention}"
  SNAPSHOT_PREFIX="${SNAPSHOT_PREFIX#/}"
  SNAPSHOT_PREFIX="${SNAPSHOT_PREFIX%/}"
  DATASET="${A4I_DATASET:-a4i_early_intervention}"
  LOCATION="${A4I_LOCATION:-US}"
  RESERVATION="${A4I_GRAPH_RESERVATION:-a4i-graph}"
  CMD_TIMEOUT_SEC="${A4I_CMD_TIMEOUT_SEC:-180}"

  [[ "${CMD_TIMEOUT_SEC}" =~ ^[1-9][0-9]{0,3}$ ]] \
    || fail "Invalid A4I_CMD_TIMEOUT_SEC='${CMD_TIMEOUT_SEC}' (expected 1..9999)."
  [[ "${DATASET}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ && ${#DATASET} -le 1024 ]] \
    || fail "Invalid dataset identifier '${DATASET}'."
  [[ "${LOCATION}" =~ ^[A-Za-z0-9-]+$ ]] \
    || fail "Invalid BigQuery location '${LOCATION}'."
  [[ "${RESERVATION}" =~ ^[a-z][a-z0-9-]{1,62}$ ]] \
    || fail "Invalid reservation name '${RESERVATION}'."
  if [[ -n "${SNAPSHOT_BUCKET}" ]] && [[ ! "${SNAPSHOT_BUCKET}" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]]; then
    fail "Invalid A4I_SNAPSHOT_BUCKET='${SNAPSHOT_BUCKET}'."
  fi
}

list_states() {
  bold "States available for Early Intervention & Developmental Screening Triage"
  local found=0 code label
  if [[ -n "${SNAPSHOT_BUCKET}" ]]; then
    local base_uri="gs://${SNAPSHOT_BUCKET}/${SNAPSHOT_PREFIX}"
    while read -r code; do
      [[ -z "${code}" || "${code}" == "starter" ]] && continue
      found=1
      label="${STATE_NAMES[${code}]:-(in snapshot bucket)}"
      printf '  %-6s %s\n' "${code}" "${label}"
    done < <(run_timed gcloud storage ls "${base_uri}/" 2>/dev/null | sed 's|.*/\([^/]*\)/$|\1|')
    [[ "${found}" -eq 1 ]] || fail "Could not list ${base_uri}/. Check network access and authentication."
  else
    for code in "${SCOPE_ORDER[@]}"; do
      printf '  %-6s %s\n' "${code}" "${STATE_NAMES[${code}]}"
    done
    printf '  %-6s %s\n' "ALL" "All 6 starter states (MS, AL, GA, TX, CA, NY)"
  fi
  echo
  echo "Usage: bash scripts/load.sh <STATE|ALL>"
}

resolve_state() {
  local raw="${1:-MS}"
  if [[ "${raw}" == "--list" || "${raw}" == "-l" ]]; then
    list_states
    exit 0
  fi
  if [[ "${raw}" == "--help" || "${raw}" == "-h" ]]; then
    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
  fi
  [[ "${raw}" != *".."* && "${raw}" != *"/"* ]] \
    || fail "Invalid state argument '${raw}'."
  STATE="$(printf '%s' "${raw}" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
  if [[ "${STATE}" == "ALL" ]]; then
    STATE_LABEL="All 6 starter states (MS, AL, GA, TX, CA, NY)"
    if [[ -n "${SNAPSHOT_BUCKET}" ]]; then
      SRC="gs://${SNAPSHOT_BUCKET}/${SNAPSHOT_PREFIX}/{MS,AL,GA,TX,CA,NY}"
    else
      SRC="${REPO_ROOT}/data (all 6 starter states: MS, AL, GA, TX, CA, NY)"
    fi
    return 0
  fi
  [[ "${STATE}" =~ ^[A-Z]{2}$ ]] \
    || fail "'${raw}' is not a two-letter state abbreviation or ALL. Try: bash scripts/load.sh MS"
  STATE_LABEL="${STATE_NAMES[${STATE}]:-${STATE}}"
  if [[ -n "${SNAPSHOT_BUCKET}" ]]; then
    SRC="gs://${SNAPSHOT_BUCKET}/${SNAPSHOT_PREFIX}/${STATE}"
  else
    [[ -n "${STATE_NAMES[${STATE}]:-}" ]] || {
      echo
      bold "State '${STATE}' is not in the six pre-staged starter states."
      echo
      list_states
      exit 1
    }
    SRC="${REPO_ROOT}/data (filtered to ${STATE})"
  fi
}

preflight_checks() {
  bold "A4I Early Intervention Triage - loading data for: ${STATE} — ${STATE_LABEL}"
  echo
  command -v bq     >/dev/null 2>&1 || fail "'bq' not found. Run this in Cloud Shell."
  command -v gcloud >/dev/null 2>&1 || fail "'gcloud' not found. Run this in Cloud Shell."

  PROJECT_ID="$(run_timed gcloud config get-value project 2>/dev/null || true)"
  [[ -n "${PROJECT_ID}" && "${PROJECT_ID}" != "(unset)" ]] \
    || fail "No project set. Run: gcloud config set project YOUR_PROJECT_ID"
  [[ "${PROJECT_ID}" =~ ^[a-z][a-z0-9.:-]{4,60}$ ]] \
    || fail "Invalid GCP project ID '${PROJECT_ID}'."

  info "Project : ${PROJECT_ID}"
  info "State   : ${STATE}"
  info "Source  : ${SRC}"
  info "Dataset : ${DATASET} (${LOCATION})"
  echo

  if [[ -n "${SNAPSHOT_BUCKET}" ]]; then
    if [[ "${STATE}" == "ALL" ]]; then
      local st_chk
      for st_chk in "${SCOPE_ORDER[@]}"; do
        if ! run_timed gcloud storage ls "gs://${SNAPSHOT_BUCKET}/${SNAPSHOT_PREFIX}/${st_chk}/" >/dev/null 2>&1; then
          fail "No snapshot found for '${st_chk}' in gs://${SNAPSHOT_BUCKET}/${SNAPSHOT_PREFIX}/."
        fi
      done
    elif ! run_timed gcloud storage ls "${SRC}/" >/dev/null 2>&1; then
      echo
      bold "No snapshot found for '${STATE}'."
      echo
      list_states
      exit 1
    fi
  else
    local tbl
    for tbl in "${REQUIRED[@]}"; do
      [[ -f "${REPO_ROOT}/data/${tbl}.parquet" ]] \
        || fail "Missing ${REPO_ROOT}/data/${tbl}.parquet. Run from the cloned repo root or set A4I_SNAPSHOT_BUCKET."
    done
  fi
}

ensure_graph_reservation() {
  bold "0/3  Graph-capable reservation"
  run_timed gcloud services enable bigqueryreservation.googleapis.com \
    --project="${PROJECT_ID}" --quiet >/dev/null 2>&1 \
    || info "could not enable bigqueryreservation.googleapis.com (may already be on)"

  local res_out=""
  if run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" \
       show --reservation "${RESERVATION}" >/dev/null 2>&1; then
    info "reservation ${RESERVATION} already exists - reusing it"
  elif res_out="$(run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" mk --reservation \
         --edition=ENTERPRISE --slots=0 --autoscale_max_slots=50 \
         --ignore_idle_slots=true "${RESERVATION}" 2>&1)"; then
    info "created reservation ${RESERVATION} (Enterprise, 0 baseline, autoscale to 50)"
  elif [[ "${A4I_ALLOW_RESERVATION_FALLBACK:-0}" == "1" ]] || grep -qi "TotalAdminProjectsPerOrganization" <<<"${res_out}"; then
    info "WARNING: could not create project reservation ${RESERVATION} (org reservation quota full) - continuing with org/existing Graph support"
    echo
    return 0
  else
    printf '%s\n' "${res_out}" >&2
    fail "could not create reservation ${RESERVATION}. Graph queries require Enterprise edition; tell a coach."
  fi

  if run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" \
       ls --reservation_assignment 2>/dev/null | grep -q "${RESERVATION}"; then
    info "this project is already assigned to ${RESERVATION}"
  elif run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" mk --reservation_assignment \
         --reservation_id="${PROJECT_ID}:${LOCATION}.${RESERVATION}" \
         --assignee_type=PROJECT --assignee_id="${PROJECT_ID}" --job_type=QUERY; then
    info "assigned this project's queries to ${RESERVATION} (takes ~1 minute to apply)"
  else
    info "assignment not created (may already exist) - if graph queries fail, tell a coach"
  fi
  echo
}

ensure_dataset() {
  bold "1/3  Creating dataset"
  if run_timed bq --project_id="${PROJECT_ID}" show --dataset --format=none \
       "${PROJECT_ID}:${DATASET}" >/dev/null 2>&1; then
    info "${DATASET} already exists - reusing it"
    local existing_loc
    existing_loc="$(run_timed bq --project_id="${PROJECT_ID}" --format=json show --dataset \
                      "${PROJECT_ID}:${DATASET}" 2>/dev/null \
                    | tr ',' '\n' | grep -i '"location"' | head -1 \
                    | sed 's/.*: *"\([^"]*\)".*/\1/' || true)"
    if [[ -n "${existing_loc}" && "${existing_loc^^}" != "${LOCATION^^}" ]]; then
      fail "Dataset ${DATASET} already exists in '${existing_loc}', but this script loads into
       '${LOCATION}'. BigQuery cannot load across regions, and a property graph must live in
       the same location as its tables. Either delete the dataset (bq rm -r -d ${DATASET})
       or set A4I_LOCATION to match."
    fi
  else
    local mk_out
    if mk_out="$(run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" \
                   mk --dataset "${PROJECT_ID}:${DATASET}" 2>&1)"; then
      info "created ${DATASET}"
    elif grep -qi "already exists" <<<"${mk_out}"; then
      info "${DATASET} already exists - reusing it"
    else
      fail "Could not create dataset ${DATASET}: ${mk_out}"
    fi
  fi
  echo
}

build_local_filter_sql() {
  local table="$1"
  local fq_dest="\`${PROJECT_ID}.${DATASET}.${table}\`"
  local fq_raw="\`${PROJECT_ID}.${DATASET}._raw_${table}\`"
  local where_sql=""
  if [[ "${STATE}" == "ALL" ]]; then
    where_sql="WHERE state_code IN ('MS', 'AL', 'GA', 'TX', 'CA', 'NY')"
  else
    where_sql="WHERE state_code = '${STATE}'"
  fi
  case "${table}" in
    acs_under5_tract_demographics|pediatric_and_ei_provider_directory)
      printf 'CREATE OR REPLACE TABLE %s AS SELECT * REPLACE (LPAD(census_tract_geoid, 11, '\''0'\'') AS census_tract_geoid, LPAD(county_fips, 5, '\''0'\'') AS county_fips) FROM %s %s' \
        "${fq_dest}" "${fq_raw}" "${where_sql}"
      ;;
    deidentified_part_c_referral_logs)
      printf 'CREATE OR REPLACE TABLE %s AS SELECT * REPLACE (LPAD(child_home_tract_geoid, 11, '\''0'\'') AS child_home_tract_geoid) FROM %s %s' \
        "${fq_dest}" "${fq_raw}" "${where_sql}"
      ;;
    *)
      printf 'CREATE OR REPLACE TABLE %s AS SELECT * FROM %s %s' \
        "${fq_dest}" "${fq_raw}" "${where_sql}"
      ;;
  esac
}

load_all_tables() {
  bold "2/3  Loading tables"
  local table uri sql st_code first_st
  for table in "${TABLES[@]}"; do
    info "loading ${table}..."
    if [[ -n "${SNAPSHOT_BUCKET}" ]]; then
      if [[ "${STATE}" == "ALL" ]]; then
        first_st=1
        for st_code in "${SCOPE_ORDER[@]}"; do
          local st_src="gs://${SNAPSHOT_BUCKET}/${SNAPSHOT_PREFIX}/${st_code}"
          uri="${st_src}/${table}/data.parquet"
          if ! run_timed gcloud storage ls "${uri}" >/dev/null 2>&1; then
            uri="${st_src}/${table}/*.parquet"
            run_timed gcloud storage ls "${st_src}/${table}/" >/dev/null 2>&1 \
              || fail "Missing ${st_src}/${table}/. The snapshot for '${st_code}' looks incomplete - tell a coach."
          fi
          if [[ "${first_st}" -eq 1 ]]; then
            run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" load \
              --source_format=PARQUET --replace "${DATASET}._raw_${table}" "${uri}" >/dev/null 2>&1
            first_st=0
          else
            run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" load \
              --source_format=PARQUET --noreplace "${DATASET}._raw_${table}" "${uri}" >/dev/null 2>&1
          fi
        done
        sql="$(build_local_filter_sql "${table}")"
        run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" query \
          --use_legacy_sql=false --format=none "${sql}" >/dev/null 2>&1
        run_timed bq --project_id="${PROJECT_ID}" rm -f -t \
          "${PROJECT_ID}:${DATASET}._raw_${table}" >/dev/null 2>&1
      else
        uri="${SRC}/${table}/data.parquet"
        if ! run_timed gcloud storage ls "${uri}" >/dev/null 2>&1; then
          uri="${SRC}/${table}/*.parquet"
          run_timed gcloud storage ls "${SRC}/${table}/" >/dev/null 2>&1 \
            || fail "Missing ${SRC}/${table}/. The snapshot for '${STATE}' looks incomplete - tell a coach."
        fi
        run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" load \
          --source_format=PARQUET --replace "${DATASET}.${table}" "${uri}" >/dev/null 2>&1
      fi
    else
      run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" load \
        --source_format=PARQUET --replace \
        "${DATASET}._raw_${table}" "${REPO_ROOT}/data/${table}.parquet" >/dev/null 2>&1
      sql="$(build_local_filter_sql "${table}")"
      run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" query \
        --use_legacy_sql=false --format=none "${sql}" >/dev/null 2>&1
      run_timed bq --project_id="${PROJECT_ID}" rm -f -t \
        "${PROJECT_ID}:${DATASET}._raw_${table}" >/dev/null 2>&1
    fi
    info "  done"
  done
  echo
}

verify_tables() {
  bold "3/3  Verifying"
  FAILED=0
  local table rows
  for table in "${TABLES[@]}"; do
    rows="$(run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" \
              query --use_legacy_sql=false --format=csv \
              "SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET}.${table}\`" 2>/dev/null \
            | tail -n 1)"
    if [[ "${rows}" == "0" ]]; then
      printf '  %-38s %s\n' "${table}" "0 rows  <-- EMPTY"
      FAILED=1
    else
      printf '  %-38s %s rows\n' "${table}" "${rows}"
    fi
  done
  echo
}

verify_challenge_signals() {
  bold "Does this dataset support the referral property graph?"
  local tracts providers biling handoffs chains multihop breaches orphans states_loaded bad_pad
  read -r tracts providers biling handoffs chains multihop breaches orphans states_loaded bad_pad <<<"$(
    run_timed bq --project_id="${PROJECT_ID}" --location="${LOCATION}" \
      query --use_legacy_sql=false --format=csv \
      "SELECT
         (SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET}.acs_under5_tract_demographics\`),
         (SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET}.pediatric_and_ei_provider_directory\`),
         (SELECT IFNULL(COUNTIF(bilingual_services_listed), 0)
            FROM \`${PROJECT_ID}.${DATASET}.pediatric_and_ei_provider_directory\`),
         (SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET}.deidentified_part_c_referral_logs\`),
         (SELECT COUNT(DISTINCT case_chain_id)
            FROM \`${PROJECT_ID}.${DATASET}.deidentified_part_c_referral_logs\`),
         (SELECT COUNT(*) FROM (
            SELECT case_chain_id
            FROM \`${PROJECT_ID}.${DATASET}.deidentified_part_c_referral_logs\`
            GROUP BY case_chain_id HAVING MAX(hop_sequence) >= 2)),
         (SELECT COUNT(*) FROM (
            SELECT case_chain_id
            FROM \`${PROJECT_ID}.${DATASET}.deidentified_part_c_referral_logs\`
            GROUP BY case_chain_id HAVING SUM(handoff_wait_days) > 45)),
         (SELECT IFNULL(COUNTIF(source_provider_id NOT IN (
                   SELECT provider_id FROM \`${PROJECT_ID}.${DATASET}.pediatric_and_ei_provider_directory\`)
                 OR target_provider_id NOT IN (
                   SELECT provider_id FROM \`${PROJECT_ID}.${DATASET}.pediatric_and_ei_provider_directory\`)), 0)
            FROM \`${PROJECT_ID}.${DATASET}.deidentified_part_c_referral_logs\`),
         (SELECT COUNT(DISTINCT state_code)
            FROM \`${PROJECT_ID}.${DATASET}.pediatric_and_ei_provider_directory\`),
         (SELECT IFNULL(COUNTIF(LENGTH(census_tract_geoid) != 11 OR LENGTH(county_fips) != 5), 0)
            FROM \`${PROJECT_ID}.${DATASET}.acs_under5_tract_demographics\`)" 2>/dev/null \
    | tail -n 1 | tr ',' ' '
  )"

  printf '  %-46s %s\n' "distinct states loaded"                        "${states_loaded}"
  printf '  %-46s %s\n' "census tracts (under-5 demographics)"          "${tracts}"
  printf '  %-46s %s (%s bilingual)\n' "CareNode providers"               "${providers}" "${biling}"
  printf '  %-46s %s across %s chains\n' "ReferralHandoff edges"          "${handoffs}" "${chains}"
  printf '  %-46s %s\n' "multi-hop chains (>= 2 hops)"                  "${multihop}"
  printf '  %-46s %s\n' "chains breaching 45-day IDEA Part C limit"     "${breaches}"
  printf '  %-46s %s\n' "orphan edge endpoints missing from CareNode"   "${orphans}"
  printf '  %-46s %s\n' "unpadded tract/county FIPS keys"               "${bad_pad}"
  echo

  if [[ "${multihop}" == "0" || "${breaches}" == "0" || "${orphans}" != "0" || "${bad_pad}" != "0" ]]; then
    FAILED=1
    info "  <-- Graph has zero multi-hop depth, zero >45d breaches, unpadded FIPS, or broken FK endpoints."
  fi
  if [[ "${STATE}" == "ALL" && "${states_loaded}" != "6" ]]; then
    FAILED=1
    info "  <-- Expected all 6 starter states, found ${states_loaded}."
  fi

  if [[ "${FAILED}" -eq 1 ]]; then
    fail "One or more required tables loaded empty, or graph integrity failed. Tell a coach."
  fi
}

print_ready_footer() {
  bold "Ready."
  echo
  echo "  Your tables are in ${PROJECT_ID}.${DATASET}"
  echo "  Enterprise graph reservation: ${RESERVATION} (0 baseline slots, autoscale 50)"
  echo "  Safe to re-run at any time - each load replaces the whole table."
  echo
  echo "  FOUR TRAPS THAT COST TEAMS CREDIT IF SKIPPED:"
  echo "    1. ALL-ZERO COLUMN: limited_english_rate in acs_under5_tract_demographics is"
  echo "       0.0 in this ACS extract - use nsch_developmental_screening_survey."
  echo "       primary_home_language and bilingual_services_listed instead."
  echo "    2. 6x STATEWIDE GRAIN: nsch_developmental_screening_survey is statewide (6"
  echo "       strata/state) - never join on state_code alone or tracts duplicate 6x."
  echo "    3. GRAPH DDL: exclude GEOGRAPHY columns (PROPERTIES ALL COLUMNS EXCEPT"
  echo "       (provider_geom)) and correlate case_chain_id across variable-length hops."
  echo "    4. STAGE-SAFE ETHICS: provider/agency/referral tables are 100% [Synthetic];"
  echo "       exclude audit_* shares from routing and use them post-output only."
  echo
  echo "  Next: CREATE PROPERTY GRAPH over pediatric_and_ei_provider_directory +"
  echo "  deidentified_part_c_referral_logs and traverse -{2,4}-> in ISO GQL."
  echo "  See Section 13 of notebooks/c_ei_01_load_explore.ipynb."
  echo
}

load_dotenv
validate_config
resolve_state "${1:-MS}"
preflight_checks
ensure_graph_reservation
ensure_dataset
load_all_tables
verify_tables
verify_challenge_signals
print_ready_footer
