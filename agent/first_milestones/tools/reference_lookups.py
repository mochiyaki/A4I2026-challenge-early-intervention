"""Reference lookup tools mirroring `agent/tools.yaml` with strict input validation."""

from __future__ import annotations

import functools
from typing import Any

import pandas as pd

from .bq_client import (
    VALID_STATES,
    _find_data_dir,
    get_config,
    graph_client,
    load_local_state_frames,
)

VALID_NODE_ROLES: tuple[str, ...] = (
    "ALL",
    "Screening_Pediatric_Clinic",
    "Part_C_Intake_Coordinator",
    "Multidisciplinary_Eval_Hub",
    "EI_Therapy_Vendor",
)
_ROLE_BY_LOWER: dict[str, str] = {role.lower(): role for role in VALID_NODE_ROLES}


def lookup_regional_agency_kpis() -> dict[str, Any]:
    """Fetches regional IDEA Part C lead agency 45-day IFSP compliance KPIs.

    Returns 100% [Synthetic] regional lead agencies (`SYN-PARTC-*`) calibrated to
    US Department of Education OSEP Indicator C7 reports.
    """
    cfg = get_config()
    clean_state = cfg["state"] if cfg["state"] in VALID_STATES else "MS"

    bq_rows: list[dict[str, Any]] | None = None
    if cfg["project"]:
        sql = f"""
        SELECT
          agency_id,
          state_code,
          served_counties,
          synthetic_agency_name,
          reporting_fiscal_year,
          annual_referrals_received,
          evaluations_completed_count,
          initial_ifsp_within_45_days_count,
          ROUND(
            SAFE_DIVIDE(initial_ifsp_within_45_days_count, GREATEST(evaluations_completed_count, 1)) * 100.0,
            1
          ) AS timely_45d_ifsp_pct,
          ifsp_delayed_capacity_count,
          ifsp_delayed_family_count
        FROM `{cfg['project']}.{cfg['dataset']}.idea_part_c_agency_performance`
        WHERE state_code = '{clean_state}'
        ORDER BY timely_45d_ifsp_pct ASC, agency_id ASC;
        """.strip()
        raw = graph_client.query_bq_or_none(sql)
        if raw and "agency_id" in raw[0] and "timely_45d_ifsp_pct" in raw[0]:
            bq_rows = raw

    active_ds = (
        graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    )
    engine = (
        f"bigquery_sql ({cfg['project']}.{active_ds})"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({clean_state} starter tables)"
    )

    if bq_rows is not None:
        agencies_out = [
            {
                "agency_id": str(r["agency_id"]),
                "state_code": str(r["state_code"]),
                "served_counties": str(r["served_counties"]),
                "synthetic_agency_name": str(r["synthetic_agency_name"]),
                "reporting_fiscal_year": str(r["reporting_fiscal_year"]),
                "annual_referrals_received": int(r["annual_referrals_received"]),
                "evaluations_completed_count": int(r["evaluations_completed_count"]),
                "initial_ifsp_within_45_days_count": int(r["initial_ifsp_within_45_days_count"]),
                "timely_45d_ifsp_pct": round(float(r["timely_45d_ifsp_pct"]), 1),
                "ifsp_delayed_capacity_count": int(r["ifsp_delayed_capacity_count"]),
                "ifsp_delayed_family_count": int(r["ifsp_delayed_family_count"]),
            }
            for r in bq_rows
        ]
    else:
        ag = load_local_state_frames(clean_state)["agencies"].copy()
        ag["timely_45d_ifsp_pct"] = (
            ag["initial_ifsp_within_45_days_count"]
            / ag["evaluations_completed_count"].clip(lower=1)
            * 100.0
        ).round(1)
        ag = ag.sort_values("timely_45d_ifsp_pct", ascending=True)
        cols = [
            "agency_id",
            "state_code",
            "served_counties",
            "synthetic_agency_name",
            "reporting_fiscal_year",
            "annual_referrals_received",
            "evaluations_completed_count",
            "initial_ifsp_within_45_days_count",
            "timely_45d_ifsp_pct",
            "ifsp_delayed_capacity_count",
            "ifsp_delayed_family_count",
        ]
        agencies_out = ag[cols].to_dict(orient="records")

    return {
        "status": "ok",
        "execution_engine": engine,
        "state_code": clean_state,
        "provenance": "100% [Synthetic] regional IDEA Part C hubs calibrated to OSEP Indicator C7",
        "agencies": agencies_out,
    }


def lookup_statewide_nsch_strata() -> dict[str, Any]:
    """Retrieves statewide-only HRSA NSCH developmental screening strata (6 rows/state).

    Grain guardrail: `geographic_level = 'Statewide'` across all 6 rows. Never join
    directly to census tracts on `state_code` alone (prevents 6x tract fan-out).
    """
    cfg = get_config()
    clean_state = cfg["state"] if cfg["state"] in VALID_STATES else "MS"

    bq_rows: list[dict[str, Any]] | None = None
    if cfg["project"]:
        sql = f"""
        SELECT
          survey_stratum_id,
          geographic_level,
          household_income_fpl_band,
          primary_home_language,
          ROUND(standardized_screening_rate_pct * 100.0, 1) AS standardized_screening_rate_pct,
          ROUND(followup_requested_pct * 100.0, 1) AS followup_requested_pct,
          ROUND(margin_of_error_pct * 100.0, 1) AS margin_of_error_pct
        FROM `{cfg['project']}.{cfg['dataset']}.nsch_developmental_screening_survey`
        WHERE state_code = '{clean_state}'
          AND geographic_level = 'Statewide'
        ORDER BY standardized_screening_rate_pct ASC, survey_stratum_id ASC;
        """.strip()
        raw = graph_client.query_bq_or_none(sql)
        if raw and "survey_stratum_id" in raw[0]:
            bq_rows = raw

    active_ds = (
        graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    )
    engine = (
        f"bigquery_sql ({cfg['project']}.{active_ds})"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({clean_state} starter tables)"
    )

    if bq_rows is not None:
        strata_out = [
            {
                "survey_stratum_id": str(r["survey_stratum_id"]),
                "geographic_level": str(r["geographic_level"]),
                "household_income_fpl_band": str(r["household_income_fpl_band"]),
                "primary_home_language": str(r["primary_home_language"]),
                "standardized_screening_rate_pct": round(
                    float(r["standardized_screening_rate_pct"]), 1
                ),
                "followup_requested_pct": round(float(r["followup_requested_pct"]), 1),
                "margin_of_error_pct": round(float(r["margin_of_error_pct"]), 1),
            }
            for r in bq_rows
        ]
    else:
        nsch = load_local_state_frames(clean_state)["nsch"].copy()
        nsch["standardized_screening_rate_pct"] = (
            nsch["standardized_screening_rate_pct"] * 100.0
        ).round(1)
        nsch["followup_requested_pct"] = (nsch["followup_requested_pct"] * 100.0).round(1)
        nsch["margin_of_error_pct"] = (nsch["margin_of_error_pct"] * 100.0).round(1)
        nsch = nsch.sort_values("standardized_screening_rate_pct", ascending=True)
        cols = [
            "survey_stratum_id",
            "geographic_level",
            "household_income_fpl_band",
            "primary_home_language",
            "standardized_screening_rate_pct",
            "followup_requested_pct",
            "margin_of_error_pct",
        ]
        strata_out = nsch[cols].to_dict(orient="records")

    return {
        "status": "ok",
        "execution_engine": engine,
        "state_code": clean_state,
        "grain_guardrail": "Strictly Statewide (6 strata/state). Never raw-join to census tracts on state_code.",
        "acs_lep_trap_note": "Used instead of acs_under5_tract_demographics.limited_english_rate (which is 0.0 across all tracts in this extract).",
        "strata": strata_out,
    }


def lookup_tract_routing_context(tract_geoid: str = "ALL") -> dict[str, Any]:
    """Looks up non-racial Census ACS under-5 tract context (`audit_*` excluded).

    Args:
        tract_geoid: 11-character census_tract_geoid (preserving leading zeros),
            or 'ALL' for the top 10 highest-poverty under-5 tracts.
    """
    cfg = get_config()
    clean_state = cfg["state"] if cfg["state"] in VALID_STATES else "MS"
    demo = load_local_state_frames(clean_state)["demo"].copy()
    sorted_demo = demo.sort_values(
        ["poverty_rate", "children_under_5_count"], ascending=False
    )

    raw_tract = "" if tract_geoid is None else str(tract_geoid).strip()
    is_all = not raw_tract or raw_tract.upper() == "ALL"
    padded = ""
    if not is_all:
        padded = raw_tract.zfill(11) if raw_tract.isdigit() and len(raw_tract) <= 11 else ""
        if not padded:
            sample_tracts = sorted_demo["census_tract_geoid"].head(5).astype(str).tolist()
            return {
                "status": "validation_error",
                "state_code": clean_state,
                "requested_tract_geoid": raw_tract,
                "valid_sample_tract_geoids": sample_tracts,
                "hint": (
                    f"Tract {raw_tract!r} was not found in active state {clean_state}. "
                    f"Pass 'ALL' for the top 10 high-need tracts or a valid 11-digit GEOID "
                    f"in {clean_state} such as {sample_tracts[:3]}."
                ),
                "tracts": [],
            }

    bq_rows: list[dict[str, Any]] | None = None
    if cfg["project"]:
        tract_pred = (
            ""
            if is_all
            else f" AND LPAD(census_tract_geoid, 11, '0') = '{padded}'"
        )
        limit_clause = "LIMIT 10" if is_all else "LIMIT 1"
        sql = f"""
        SELECT
          LPAD(census_tract_geoid, 11, '0') AS census_tract_geoid,
          county_name,
          children_under_5_count,
          ROUND(poverty_rate * 100.0, 1) AS poverty_pct,
          ROUND(no_vehicle_rate * 100.0, 1) AS zero_vehicle_pct,
          ROUND(assistance_rate * 100.0, 1) AS public_assistance_pct,
          ROUND(median_household_income, 0) AS median_household_income,
          limited_english_rate AS acs_limited_english_rate_trap_all_zero
        FROM `{cfg['project']}.{cfg['dataset']}.acs_under5_tract_demographics`
        WHERE state_code = '{clean_state}'{tract_pred}
        ORDER BY poverty_rate DESC, children_under_5_count DESC, census_tract_geoid ASC
        {limit_clause};
        """.strip()
        raw = graph_client.query_bq_or_none(sql)
        if raw is not None:
            if not raw and not is_all:
                sample_tracts = sorted_demo["census_tract_geoid"].head(5).astype(str).tolist()
                return {
                    "status": "validation_error",
                    "state_code": clean_state,
                    "requested_tract_geoid": raw_tract,
                    "valid_sample_tract_geoids": sample_tracts,
                    "hint": (
                        f"Tract {raw_tract!r} was not found in active state {clean_state}. "
                        f"Pass 'ALL' for the top 10 high-need tracts or a valid 11-digit GEOID "
                        f"in {clean_state} such as {sample_tracts[:3]}."
                    ),
                    "tracts": [],
                }
            if raw and "census_tract_geoid" in raw[0] and "poverty_pct" in raw[0]:
                bq_rows = raw

    active_ds = (
        graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    )
    engine = (
        f"bigquery_sql ({cfg['project']}.{active_ds})"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({clean_state} starter tables)"
    )

    if bq_rows is not None:
        rows = [
            {
                "census_tract_geoid": str(r["census_tract_geoid"]).strip().zfill(11),
                "county_name": str(r["county_name"]),
                "children_under_5_count": int(r["children_under_5_count"]),
                "poverty_pct": round(float(r["poverty_pct"]), 1),
                "zero_vehicle_pct": round(float(r["zero_vehicle_pct"]), 1),
                "public_assistance_pct": round(float(r["public_assistance_pct"]), 1),
                "median_household_income": round(float(r["median_household_income"]), 0),
                "acs_limited_english_rate_trap_all_zero": float(
                    r["acs_limited_english_rate_trap_all_zero"]
                ),
            }
            for r in bq_rows
        ]
    else:
        if is_all:
            selected = sorted_demo.head(10)
        else:
            selected = sorted_demo[sorted_demo["census_tract_geoid"] == padded]
            if selected.empty:
                sample_tracts = sorted_demo["census_tract_geoid"].head(5).astype(str).tolist()
                return {
                    "status": "validation_error",
                    "state_code": clean_state,
                    "requested_tract_geoid": raw_tract,
                    "valid_sample_tract_geoids": sample_tracts,
                    "hint": (
                        f"Tract {raw_tract!r} was not found in active state {clean_state}. "
                        f"Pass 'ALL' for the top 10 high-need tracts or a valid 11-digit GEOID "
                        f"in {clean_state} such as {sample_tracts[:3]}."
                    ),
                    "tracts": [],
                }

        rows = []
        for _, r in selected.iterrows():
            rows.append({
                "census_tract_geoid": str(r["census_tract_geoid"]).strip().zfill(11),
                "county_name": str(r["county_name"]),
                "children_under_5_count": int(r["children_under_5_count"]),
                "poverty_pct": round(float(r["poverty_rate"]) * 100.0, 1),
                "zero_vehicle_pct": round(float(r["no_vehicle_rate"]) * 100.0, 1),
                "public_assistance_pct": round(float(r["assistance_rate"]) * 100.0, 1),
                "median_household_income": round(float(r["median_household_income"]), 0),
                "acs_limited_english_rate_trap_all_zero": float(r["limited_english_rate"]),
            })

    return {
        "status": "ok",
        "execution_engine": engine,
        "state_code": clean_state,
        "provenance": "Real public US Census ACS 5-Year under-5 demographics (audit_* excluded from routing)",
        "tracts": rows,
    }


def lookup_carenode_directory(role_filter: str = "ALL", top_n: int = 12) -> dict[str, Any]:
    """Lists 100% [Synthetic] CareNode providers sorted by flat active_waitlist_count.

    Args:
        role_filter: One of 'ALL', 'Screening_Pediatric_Clinic',
            'Part_C_Intake_Coordinator', 'Multidisciplinary_Eval_Hub', or
            'EI_Therapy_Vendor'.
        top_n: Maximum number of provider records to return (clamped to 1..30; default 12).
    """
    cfg = get_config()
    clean_state = cfg["state"] if cfg["state"] in VALID_STATES else "MS"
    raw_role = "ALL" if role_filter is None or not str(role_filter).strip() else str(role_filter).strip()
    canonical_role = _ROLE_BY_LOWER.get(raw_role.lower())
    if canonical_role is None:
        return {
            "status": "validation_error",
            "state_code": clean_state,
            "invalid_role_filter": raw_role,
            "valid_roles": list(VALID_NODE_ROLES),
            "hint": (
                f"Unsupported role_filter={raw_role!r}. Expected one of {list(VALID_NODE_ROLES)}."
            ),
            "providers": [],
        }

    try:
        limit = 12 if top_n is None else max(1, min(int(top_n), 30))
    except (TypeError, ValueError):
        limit = 12

    bq_rows: list[dict[str, Any]] | None = None
    bq_total: int | None = None
    if cfg["project"]:
        role_pred = "" if canonical_role == "ALL" else f" AND node_role = '{canonical_role}'"
        sql = f"""
        SELECT
          COUNT(*) OVER () AS total_matching,
          provider_id,
          node_role,
          city,
          synthetic_organization_name,
          part_c_vendor_enrolled,
          accepts_medicaid,
          bilingual_services_listed,
          active_waitlist_count,
          median_internal_wait_days
        FROM `{cfg['project']}.{cfg['dataset']}.pediatric_and_ei_provider_directory`
        WHERE state_code = '{clean_state}'{role_pred}
        ORDER BY active_waitlist_count DESC, provider_id ASC
        LIMIT {limit};
        """.strip()
        raw = graph_client.query_bq_or_none(sql)
        if raw and "provider_id" in raw[0]:
            bq_rows = raw
            bq_total = int(raw[0].get("total_matching", len(raw)))

    active_ds = (
        graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    )
    engine = (
        f"bigquery_sql ({cfg['project']}.{active_ds})"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({clean_state} starter tables)"
    )

    if bq_rows is not None:
        total_matching = bq_total if bq_total is not None else len(bq_rows)
        records = [
            {
                "provider_id": str(r["provider_id"]),
                "node_role": str(r["node_role"]),
                "city": str(r["city"]),
                "synthetic_organization_name": str(r["synthetic_organization_name"]),
                "part_c_vendor_enrolled": bool(r["part_c_vendor_enrolled"]),
                "accepts_medicaid": bool(r["accepts_medicaid"]),
                "bilingual_services_listed": bool(r["bilingual_services_listed"]),
                "active_waitlist_count": int(r["active_waitlist_count"]),
                "median_internal_wait_days": int(r["median_internal_wait_days"]),
            }
            for r in bq_rows
        ]
    else:
        prov = load_local_state_frames(clean_state)["providers"].copy()
        if canonical_role != "ALL":
            prov = prov[prov["node_role"] == canonical_role]
        total_matching = int(len(prov))
        prov = prov.sort_values("active_waitlist_count", ascending=False).head(limit)
        cols = [
            "provider_id",
            "node_role",
            "city",
            "synthetic_organization_name",
            "part_c_vendor_enrolled",
            "accepts_medicaid",
            "bilingual_services_listed",
            "active_waitlist_count",
            "median_internal_wait_days",
        ]
        records = prov[cols].to_dict(orient="records")

    return {
        "status": "ok",
        "execution_engine": engine,
        "state_code": clean_state,
        "role_filter": canonical_role,
        "total_matching": total_matching,
        "returned_count": len(records),
        "provenance": "100% [Synthetic] CareNode vertices (SYN-PROV-*, zero real clinicians)",
        "providers": records,
    }


BYOD_HRSA_PROVENANCE = (
    "Real Public-Domain BYOD: HRSA Health Center Service Delivery Sites "
    "(17 U.S.C. § 105 US Government Work)"
)
_BYOD_HRSA_COLUMNS = [
    "hrsa_site_id",
    "site_name",
    "health_center_name",
    "health_center_type",
    "location_type",
    "location_setting",
    "site_address",
    "site_city",
    "state_code",
    "postal_code",
    "county_fips",
    "county_name",
    "latitude",
    "longitude",
    "operating_hours_per_week",
    "data_provenance",
]


@functools.lru_cache(maxsize=8)
def _load_byod_hrsa_sites_cached(state_code: str) -> pd.DataFrame:
    """Loads and caches public-domain HRSA FQHC / Look-Alike sites for `state_code`."""
    try:
        data_dir = _find_data_dir()
    except FileNotFoundError:
        return pd.DataFrame(columns=_BYOD_HRSA_COLUMNS)
    parquet_path = data_dir / "byod_hrsa_fqhc_screening_sites.parquet"
    if not parquet_path.is_file():
        return pd.DataFrame(columns=_BYOD_HRSA_COLUMNS)
    df = pd.read_parquet(parquet_path)
    df = df[df["state_code"].astype(str).str.strip().str.upper() == state_code].copy()
    if df.empty:
        return pd.DataFrame(columns=_BYOD_HRSA_COLUMNS)
    df["state_code"] = df["state_code"].astype(str).str.strip().str.upper()
    df["county_fips"] = df["county_fips"].astype(str).str.strip().str.zfill(5)
    df["latitude"] = pd.to_numeric(df["latitude"], errors="coerce")
    df["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
    df = df.dropna(subset=["latitude", "longitude"]).reset_index(drop=True)
    return df


def load_byod_hrsa_sites(state_code: str = "") -> pd.DataFrame:
    """Returns real public-domain HRSA FQHC delivery sites (`17 U.S.C. § 105`) for `state_code`.

    Never contains synthetic waitlists or `audit_*` demographic shares; used strictly for
    spatial community-screening proximity overlays in Track 3 outreach tools.
    """
    raw_state = (state_code or get_config()["state"]).strip().upper()
    clean_state = raw_state if raw_state in VALID_STATES else get_config()["state"]
    return _load_byod_hrsa_sites_cached(clean_state).copy()
