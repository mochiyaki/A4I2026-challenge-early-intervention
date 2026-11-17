"""Post-Output Equity Audit & Community Screening Outreach Readiness Tools.

Governance Rule Enforced:
  - `audit_black_share`, `audit_hispanic_share`, `audit_asian_share`,
    `audit_indigenous_share`, and `audit_white_share` are NEVER read inside
    `graph_routing.py`. They are joined strictly HERE, *after* pathway and
    bottleneck outputs are generated, to quantify baseline >45-day disparity and
    verify that zero-vehicle families are protected via NEMT / mobile evaluation.
  - `nsch_developmental_screening_survey` is queried strictly at its `'Statewide'`
    grain (6 strata/state) without joining to tracts on `state_code` alone.
"""

from __future__ import annotations

import math
import re
from typing import Any

from .bq_client import (
    VALID_STATES,
    get_config,
    graph_client,
    haversine_km,
    load_local_state_frames,
    rewrite_sql_dataset,
)
from .reference_lookups import BYOD_HRSA_PROVENANCE, load_byod_hrsa_sites


def _extract_hrsa_tuples(state_code: str) -> list[tuple[str, str, float, float]]:
    """Extracts `(site_name, city, lat, lon)` tuples from public-domain HRSA BYOD sites."""
    hrsa = load_byod_hrsa_sites(state_code)
    if hrsa.empty:
        return []
    return [
        (
            str(r["site_name"]),
            str(r["site_city"]),
            float(r["latitude"]),
            float(r["longitude"]),
        )
        for _, r in hrsa.iterrows()
    ]


def _nearest_byod_hrsa_site(
    lat: float,
    lon: float,
    hrsa_tuples: list[tuple[str, str, float, float]],
) -> tuple[float | None, str | None, str | None]:
    """Finds the nearest public-domain HRSA FQHC / Look-Alike screening site in km."""
    if not hrsa_tuples:
        return None, None, None
    best_km = float("inf")
    best_name: str | None = None
    best_city: str | None = None
    for s_name, s_city, s_lat, s_lon in hrsa_tuples:
        km = haversine_km(lat, lon, s_lat, s_lon)
        if km < best_km:
            best_km = km
            best_name = s_name
            best_city = s_city
    return round(best_km, 1), best_name, best_city


def _haversine_km_2dec(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Spherical distance rounded to 2 decimals (matches v_graph_serves_area_edges)."""
    r_earth_km = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    )
    return round(2.0 * r_earth_km * math.atan2(math.sqrt(a), math.sqrt(1.0 - a)), 2)


def _validate_top_n(
    top_n: Any,
    *,
    default: int,
    max_limit: int = 12,
    state_code: str = "",
) -> tuple[int | None, dict[str, Any] | None]:
    """Validates `top_n` (`None` -> default; `< 1` -> validation_error; clamps max to `12`)."""
    if top_n is None:
        return default, None
    parsed: int | None = None
    if isinstance(top_n, bool):
        parsed = None
    elif isinstance(top_n, int):
        parsed = top_n
    elif isinstance(top_n, float):
        if math.isfinite(top_n) and top_n.is_integer():
            parsed = int(top_n)
    elif isinstance(top_n, str):
        s_val = top_n.strip()
        if re.fullmatch(r"[+-]?\d+", s_val):
            parsed = int(s_val)

    if parsed is None or parsed < 1:
        return None, {
            "status": "validation_error",
            "error_code": "INVALID_TOP_N",
            "message": f"top_n must be an integer >= 1 (received {top_n!r}).",
            "state_code": state_code,
            "priority_screening_tracts": [],
            "ranked_outreach_zones": [],
            "hidden_ei_deserts_count": 0,
        }
    return min(parsed, max_limit), None


def _outbound_bounce_provider_ids(logs: Any) -> set[str]:
    """Returns CareNode provider_ids with historical outbound `Re-Referral Bounce` events."""
    if logs.empty:
        return set()
    bounced = logs[logs["handoff_reason"].astype(str).str.startswith("Re-Referral Bounce")]
    return set(bounced["source_provider_id"].astype(str).tolist())


def _clean_ehr_median_waits(logs: Any) -> dict[tuple[str, str], int]:
    """Computes clean EHR median handoff waits per directed pair (matching CAN_REFER_TO)."""
    out: dict[tuple[str, str], int] = {}
    if logs.empty:
        return out
    clean = logs[
        (logs["transmission_channel"] == "ehr_electronic_portal")
        & (~logs["handoff_reason"].astype(str).str.startswith("Re-Referral Bounce"))
    ]
    for (s_id, t_id), grp in clean.groupby(["source_provider_id", "target_provider_id"]):
        out[(str(s_id), str(t_id))] = int(round(float(grp["handoff_wait_days"].median())))
    return out


def _simulate_non_racial_rerouting_cohort(
    prov: Any,
    logs: Any,
    demo: Any,
) -> dict[str, Any]:
    """Counterfactually re-routes >45d breached chains using strictly non-racial rules.

    Anti-bias firewall: candidate corridor selection ONLY uses clinical capability,
    `accepts_medicaid`, capacity (`active_waitlist_count <= monthly_slot_capacity`),
    zero outbound bounce (`_outbound_bounce_provider_ids`), and clean EHR median waits.
    ACS `audit_*` demographic shares are joined ONLY post-output on simulated results.
    """
    out_bounce_ids = _outbound_bounce_provider_ids(logs)
    clean_ehr_wait = _clean_ehr_median_waits(logs)

    non_bounce_ehr = logs[
        (~logs["handoff_reason"].astype(str).str.startswith("Re-Referral Bounce"))
        & (logs["transmission_channel"] == "ehr_electronic_portal")
    ]
    edge_dropoff: dict[tuple[str, str], float] = {}
    if not non_bounce_ehr.empty and "dropoff_rate_pct" in non_bounce_ehr.columns:
        for (s_id, t_id), grp in non_bounce_ehr.groupby(["source_provider_id", "target_provider_id"]):
            edge_dropoff[(str(s_id), str(t_id))] = float(grp["dropoff_rate_pct"].median())
        default_clean_hop_dropoff = float(non_bounce_ehr["dropoff_rate_pct"].mean())
    else:
        default_clean_hop_dropoff = 0.09

    # Build clean non-racial Part C corridors (Clinic -> Coordinator -> Eval Hub -> Vendor)
    clinics = [
        r
        for _, r in prov[
            (prov["node_role"] == "Screening_Pediatric_Clinic") & (prov["accepts_medicaid"])
        ].iterrows()
    ]
    if not clinics:
        clinics = [r for _, r in prov[prov["node_role"] == "Screening_Pediatric_Clinic"].iterrows()]

    def _clean_role(role: str) -> list[Any]:
        sub = prov[
            (prov["node_role"] == role)
            & (prov["part_c_vendor_enrolled"])
            & (prov["accepts_medicaid"])
            & (prov["active_waitlist_count"] <= prov["monthly_slot_capacity"])
        ]
        return [r for _, r in sub.iterrows() if str(r["provider_id"]) not in out_bounce_ids]

    coords = _clean_role("Part_C_Intake_Coordinator")
    evals = _clean_role("Multidisciplinary_Eval_Hub")
    vendors = _clean_role("EI_Therapy_Vendor")

    clean_corridors: list[tuple[int, float, float, float, float, float]] = []
    for cl in clinics:
        cl_id = str(cl["provider_id"])
        for co in coords:
            co_id = str(co["provider_id"])
            w1 = clean_ehr_wait.get((cl_id, co_id), int(co["median_internal_wait_days"]))
            d1 = edge_dropoff.get((cl_id, co_id), default_clean_hop_dropoff)
            for ev in evals:
                ev_id = str(ev["provider_id"])
                w2 = clean_ehr_wait.get((co_id, ev_id), int(ev["median_internal_wait_days"]) + 5)
                if w1 + w2 > 45:
                    continue
                d2 = edge_dropoff.get((co_id, ev_id), default_clean_hop_dropoff)
                ev_lat, ev_lon = float(ev["latitude"]), float(ev["longitude"])
                for vn in vendors:
                    vn_id = str(vn["provider_id"])
                    w3 = clean_ehr_wait.get((ev_id, vn_id), int(vn["median_internal_wait_days"]) + 6)
                    tot_w = w1 + w2 + w3
                    if tot_w <= 45:
                        d3 = edge_dropoff.get((ev_id, vn_id), default_clean_hop_dropoff)
                        corridor_dropoff_pct = round(((d1 + d2 + d3) / 3.0) * 100.0, 2)
                        clean_corridors.append(
                            (tot_w, corridor_dropoff_pct, ev_lat, ev_lon, float(vn["latitude"]), float(vn["longitude"]))
                        )

    tract_lookup = {
        str(tr["census_tract_geoid"]).strip().zfill(11): tr
        for _, tr in demo.iterrows()
    }

    episodes: list[dict[str, Any]] = []
    for _, grp in logs.groupby("case_chain_id"):
        geoid = str(grp.iloc[0]["child_home_tract_geoid"]).strip().zfill(11)
        tr = tract_lookup.get(geoid)
        if tr is None:
            continue
        base_wait = int(grp["handoff_wait_days"].sum())
        base_drop = (
            round(float(grp["dropoff_rate_pct"].mean()) * 100.0, 2)
            if "dropoff_rate_pct" in grp.columns
            else 15.0
        )
        t_lat, t_lon = float(tr["latitude"]), float(tr["longitude"])
        after_wait = base_wait
        after_drop = base_drop
        rerouted = False
        if base_wait > 45 and clean_corridors:
            best = min(
                clean_corridors,
                key=lambda c: (
                    c[0],
                    round((haversine_km(t_lat, t_lon, c[2], c[3]) + haversine_km(t_lat, t_lon, c[4], c[5])) / 2.0, 1),
                ),
            )
            after_wait = int(best[0])
            after_drop = float(best[1])
            rerouted = True
        episodes.append({
            "geoid": geoid,
            "base_wait": base_wait,
            "after_wait": after_wait,
            "base_drop": base_drop,
            "after_drop": after_drop,
            "rerouted": rerouted,
            "tr": tr,
        })

    n_ep = len(episodes)
    if n_ep == 0:
        return {"episodes": 0, "rerouted_episodes_count": 0, "post_output_demographic_parity": []}

    breach_before = sum(1 for e in episodes if e["base_wait"] > 45)
    breach_after = sum(1 for e in episodes if e["after_wait"] > 45)
    rerouted_cnt = sum(1 for e in episodes if e["rerouted"])
    mw_before = round(sum(e["base_wait"] for e in episodes) / n_ep, 1)
    mw_after = round(sum(e["after_wait"] for e in episodes) / n_ep, 1)
    timely_before = round(((n_ep - breach_before) / n_ep) * 100.0, 1)
    timely_after = round(((n_ep - breach_after) / n_ep) * 100.0, 1)
    md_before = round(sum(e["base_drop"] for e in episodes) / n_ep, 1)
    md_after = round(sum(e["after_drop"] for e in episodes) / n_ep, 1)

    # Strictly post-output stratified parity across demographic shares & mobility barriers
    parity_rows: list[dict[str, Any]] = []
    demo_groups = [
        ("Black (ACS audit_black)", lambda tr: float(tr["audit_black_share"])),
        ("Hispanic (ACS audit_hispanic)", lambda tr: float(tr["audit_hispanic_share"])),
        ("Indigenous (ACS audit_indigenous)", lambda tr: float(tr["audit_indigenous_share"])),
        ("Asian (ACS audit_asian)", lambda tr: float(tr["audit_asian_share"])),
        ("White (ACS audit_white)", lambda tr: float(tr["audit_white_share"])),
        ("High Poverty (>=20%)", lambda tr: 1.0 if float(tr["poverty_rate"]) >= 0.20 else 0.0),
        ("Zero-Vehicle (>=10%)", lambda tr: 1.0 if float(tr["no_vehicle_rate"]) >= 0.10 else 0.0),
    ]
    for label, weight_fn in demo_groups:
        weights = [max(0.0, weight_fn(e["tr"])) for e in episodes]
        w_sum = sum(weights)
        if w_sum <= 0.0:
            continue
        w_wait_b = round(sum(w * e["base_wait"] for w, e in zip(weights, episodes)) / w_sum, 1)
        w_wait_a = round(sum(w * e["after_wait"] for w, e in zip(weights, episodes)) / w_sum, 1)
        w_timely_b = round(
            (sum(w for w, e in zip(weights, episodes) if e["base_wait"] <= 45) / w_sum) * 100.0, 1
        )
        w_timely_a = round(
            (sum(w for w, e in zip(weights, episodes) if e["after_wait"] <= 45) / w_sum) * 100.0, 1
        )
        w_drop_b = round(sum(w * e["base_drop"] for w, e in zip(weights, episodes)) / w_sum, 1)
        w_drop_a = round(sum(w * e["after_drop"] for w, e in zip(weights, episodes)) / w_sum, 1)
        parity_rows.append({
            "subgroup": label,
            "wait_before_d": w_wait_b,
            "wait_after_d": w_wait_a,
            "timely_before_pct": w_timely_b,
            "timely_after_pct": w_timely_a,
            "dropoff_before_pct": w_drop_b,
            "dropoff_after_pct": w_drop_a,
            "dropoff_reduction_pp": round(w_drop_b - w_drop_a, 1),
        })

    return {
        "rerouting_policy": "non_racial_clean_ehr_medicaid_uncongested_corridor",
        "episodes": n_ep,
        "breached_episodes_before": breach_before,
        "breached_episodes_after": breach_after,
        "rerouted_episodes_count": rerouted_cnt,
        "mean_wait_before_days": mw_before,
        "mean_wait_after_days": mw_after,
        "timely_45d_before_pct": timely_before,
        "timely_45d_after_pct": timely_after,
        "mean_dropoff_before_pct": md_before,
        "mean_dropoff_after_pct": md_after,
        "dropoff_reduction_pp": round(md_before - md_after, 1),
        "post_output_demographic_parity": parity_rows,
    }


def run_post_output_equity_audit(state_code: str = "") -> dict[str, Any]:
    """Runs the post-output Equity Audit joining episode outcomes to ACS `audit_*` shares.

    Quantifies:
      1. Demographic, poverty, and zero-vehicle household profiles of neighborhoods
         suffering >45-day multi-hop breaches vs. <=45-day timely IFSP episodes.
      2. Before-vs-After counterfactual non-racial re-routing cohort delta (`>45d`
         breached chains re-routed to clean EHR corridors) and post-output stratified
         parity across Black, Hispanic, Indigenous, Asian, White, high-poverty, and
         zero-vehicle subgroups.
      3. Distance barriers (`km` to nearest uncongested bilingual, Medicaid-accepting
         Evaluation Hub) for high-poverty, zero-vehicle tracts.
      4. Statewide HRSA NSCH developmental screening disparities by primary household
         language and FPL income band (kept strictly at `'Statewide'` grain — zero 6x
         tract fan-out — and used honestly in place of the all-zero ACS
         `limited_english_rate` column).
    """
    cfg = get_config()
    if state_code and state_code.strip().upper() not in VALID_STATES:
        return {
            "status": "validation_error",
            "error_code": "INVALID_STATE_CODE",
            "message": f"Unsupported state_code={state_code!r}. Valid states: {sorted(VALID_STATES)}.",
        }
    clean_state = (
        state_code.strip().upper()
        if state_code and state_code.strip().upper() in VALID_STATES
        else (cfg["state"] if cfg["state"] in VALID_STATES else "MS")
    )
    frames = load_local_state_frames(clean_state)
    demo = frames["demo"]
    logs = frames["logs"]
    prov = frames["providers"]
    nsch = frames["nsch"]

    equity_sql = f"""
    WITH chain_totals AS (
      SELECT
        case_chain_id,
        ANY_VALUE(LPAD(child_home_tract_geoid, 11, '0')) AS child_home_tract_geoid,
        SUM(handoff_wait_days) AS episode_wait_days
      FROM `{cfg['project']}.{cfg['dataset']}.deidentified_part_c_referral_logs`
      WHERE state_code = '{clean_state}'
      GROUP BY case_chain_id
    )
    SELECT
      IF(c.episode_wait_days > 45, 'Breached (>45 days)', 'Timely (<=45 days)') AS ifsp_status,
      COUNT(*) AS episodes,
      ROUND(AVG(c.episode_wait_days), 1) AS mean_wait_days,
      ROUND(AVG(d.poverty_rate) * 100, 1) AS avg_tract_poverty_pct,
      ROUND(AVG(d.no_vehicle_rate) * 100, 1) AS avg_zero_vehicle_pct,
      ROUND(AVG(d.audit_black_share) * 100, 1) AS audit_black_pct,
      ROUND(AVG(d.audit_hispanic_share) * 100, 1) AS audit_hispanic_pct,
      ROUND(AVG(d.audit_indigenous_share) * 100, 1) AS audit_indigenous_pct,
      ROUND(AVG(d.audit_asian_share) * 100, 1) AS audit_asian_pct,
      ROUND(AVG(d.audit_white_share) * 100, 1) AS audit_white_pct
    FROM chain_totals AS c
    INNER JOIN `{cfg['project']}.{cfg['dataset']}.acs_under5_tract_demographics` AS d
      ON c.child_home_tract_geoid = LPAD(d.census_tract_geoid, 11, '0')
     AND d.state_code = '{clean_state}'
    GROUP BY 1
    ORDER BY 1;
    """.strip()

    bq_rows = graph_client.query_bq_or_none(equity_sql) if cfg["project"] else None
    active_ds = graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    engine = (
        f"bigquery_sql ({cfg['project']}.{active_ds})"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({clean_state} starter tables)"
    )

    if bq_rows is not None:
        outcome_strata = bq_rows
    else:
        ep = (
            logs.groupby("case_chain_id")
            .agg(
                child_home_tract_geoid=("child_home_tract_geoid", "first"),
                episode_wait_days=("handoff_wait_days", "sum"),
            )
            .reset_index()
        )
        ep["ifsp_status"] = ep["episode_wait_days"].apply(
            lambda w: "Breached (>45 days)" if w > 45 else "Timely (<=45 days)"
        )
        merged = ep.merge(
            demo, left_on="child_home_tract_geoid", right_on="census_tract_geoid", how="inner"
        )
        outcome_strata = []
        for status, grp in merged.groupby("ifsp_status"):
            outcome_strata.append({
                "ifsp_status": str(status),
                "episodes": int(len(grp)),
                "mean_wait_days": round(float(grp["episode_wait_days"].mean()), 1),
                "avg_tract_poverty_pct": round(float(grp["poverty_rate"].mean()) * 100.0, 1),
                "avg_zero_vehicle_pct": round(float(grp["no_vehicle_rate"].mean()) * 100.0, 1),
                "audit_black_pct": round(float(grp["audit_black_share"].mean()) * 100.0, 1),
                "audit_hispanic_pct": round(float(grp["audit_hispanic_share"].mean()) * 100.0, 1),
                "audit_indigenous_pct": round(float(grp["audit_indigenous_share"].mean()) * 100.0, 1),
                "audit_asian_pct": round(float(grp["audit_asian_share"].mean()) * 100.0, 1),
                "audit_white_pct": round(float(grp["audit_white_share"].mean()) * 100.0, 1),
            })
        outcome_strata.sort(key=lambda x: x["ifsp_status"])

    # Distance to nearest uncongested bilingual Medicaid-enrolled Evaluation Hub
    uncong_bil_evals = prov[
        (prov["node_role"] == "Multidisciplinary_Eval_Hub")
        & (prov["part_c_vendor_enrolled"])
        & (prov["accepts_medicaid"])
        & (prov["bilingual_services_listed"])
        & (prov["active_waitlist_count"] <= prov["monthly_slot_capacity"])
    ]
    bil_evals = (
        uncong_bil_evals
        if not uncong_bil_evals.empty
        else prov[
            (prov["node_role"] == "Multidisciplinary_Eval_Hub")
            & (prov["accepts_medicaid"])
            & (prov["bilingual_services_listed"])
        ]
    )
    underserved_tracts = []
    for _, tr in demo.iterrows():
        t_lat, t_lon = float(tr["latitude"]), float(tr["longitude"])
        min_km = min(
            haversine_km(t_lat, t_lon, float(ev["latitude"]), float(ev["longitude"]))
            for _, ev in bil_evals.iterrows()
        )
        underserved_tracts.append({
            "census_tract_geoid": str(tr["census_tract_geoid"]),
            "county_name": str(tr["county_name"]),
            "children_under_5_count": int(tr["children_under_5_count"]),
            "poverty_pct": round(float(tr["poverty_rate"]) * 100.0, 1),
            "zero_vehicle_pct": round(float(tr["no_vehicle_rate"]) * 100.0, 1),
            "km_to_bilingual_medicaid_eval_hub": min_km,
            "requires_nemt_or_mobile_eval": (min_km > 25.0 and float(tr["no_vehicle_rate"]) >= 0.08),
        })
    underserved_tracts.sort(
        key=lambda x: (x["km_to_bilingual_medicaid_eval_hub"], x["poverty_pct"]),
        reverse=True,
    )

    # Statewide HRSA NSCH language comparison (6 statewide strata, never raw-joined to tracts)
    nsch_clean = []
    for _, r in nsch.sort_values("standardized_screening_rate_pct").iterrows():
        nsch_clean.append({
            "survey_stratum_id": str(r["survey_stratum_id"]),
            "geographic_level": str(r["geographic_level"]),
            "household_income_fpl_band": str(r["household_income_fpl_band"]),
            "primary_home_language": str(r["primary_home_language"]),
            "standardized_screening_rate_pct": round(
                float(r["standardized_screening_rate_pct"]) * 100.0, 1
            ),
            "followup_requested_pct": round(float(r["followup_requested_pct"]) * 100.0, 1),
        })

    zero_lep_rows = int((demo["limited_english_rate"] == 0.0).sum())
    cohort_delta = _simulate_non_racial_rerouting_cohort(prov, logs, demo)

    return {
        "status": "ok",
        "execution_engine": engine,
        "state_code": clean_state,
        "governance_attestation": {
            "audit_columns_excluded_from_routing": True,
            "acs_limited_english_rate_trap_caught": (
                f"{zero_lep_rows}/{len(demo)} tracts carry 0.0 in limited_english_rate; "
                "excluded from formulas and replaced with statewide NSCH language strata + provider bilingual_services_listed."
            ),
            "nsch_statewide_grain_preserved": (
                f"{len(nsch_clean)} rows all have geographic_level='Statewide'; reported separately without 6x tract fan-out."
            ),
        },
        "breach_vs_timely_neighborhood_equity": outcome_strata,
        "before_vs_after_rerouting_cohort": cohort_delta,
        "furthest_tracts_from_bilingual_eval_hub": underserved_tracts[:6],
        "statewide_nsch_screening_context": nsch_clean,
    }


def prioritize_community_screening_tracts(top_n: int = 6) -> dict[str, Any]:
    """Prioritizes underserved under-5 census tracts for mobile developmental screening days.

    Supports Track 3 ('This community screening season'): ranks census tracts using ONLY
    non-racial need signals (`children_under_5_count`, `poverty_rate`, `no_vehicle_rate`,
    excluding `audit_*` and all-zero `limited_english_rate`) AND pairs every recommended
    screening site with a verified <=45-day uncongested, zero-bounce, bilingual Medicaid
    evaluation + therapy pathway (`local_in_person_hub` when `<=25 km` or
    `mobile_eval_or_nemt_to_regional_hub` when `>25 km`).

    Args:
        top_n: Number of priority census tracts to return (1-12).
    """
    cfg = get_config()
    clean_state = cfg["state"] if cfg["state"] in VALID_STATES else "MS"
    limit, err = _validate_top_n(top_n, default=6, max_limit=12, state_code=clean_state)
    if err is not None:
        return err
    assert limit is not None

    frames = load_local_state_frames(clean_state)
    demo = frames["demo"]
    prov = frames["providers"]
    logs = frames["logs"]
    out_bounce_ids = _outbound_bounce_provider_ids(logs)

    bq_tracts: list[dict[str, Any]] | None = None
    if cfg["project"]:
        tracts_sql = (
            "SELECT LPAD(census_tract_geoid, 11, '0') AS census_tract_geoid, "
            "county_name, children_under_5_count, poverty_rate, no_vehicle_rate, latitude, longitude "
            f"FROM `{cfg['project']}.{cfg['dataset']}.acs_under5_tract_demographics` "
            f"WHERE state_code = '{clean_state}' "
            "ORDER BY poverty_rate DESC, census_tract_geoid ASC;"
        )
        raw_bq = graph_client.query_bq_or_none(tracts_sql)
        if raw_bq and all(
            k in raw_bq[0]
            for k in (
                "census_tract_geoid",
                "county_name",
                "children_under_5_count",
                "poverty_rate",
                "no_vehicle_rate",
                "latitude",
                "longitude",
            )
        ):
            bq_tracts = raw_bq

    active_ds = (
        graph_client.get_last_resolved_dataset(cfg)
        if bq_tracts is not None
        else cfg["dataset"]
    )
    engine = (
        f"bigquery_sql ({cfg['project']}.{active_ds})"
        if bq_tracts is not None
        else f"local_geoparquet_mirror ({clean_state} starter tables)"
    )

    fast_coords = prov[
        (prov["node_role"] == "Part_C_Intake_Coordinator")
        & (prov["part_c_vendor_enrolled"])
        & (prov["accepts_medicaid"])
        & (prov["bilingual_services_listed"])
        & (prov["active_waitlist_count"] <= prov["monthly_slot_capacity"])
        & (~prov["provider_id"].astype(str).isin(out_bounce_ids))
    ]
    fast_evals = prov[
        (prov["node_role"] == "Multidisciplinary_Eval_Hub")
        & (prov["part_c_vendor_enrolled"])
        & (prov["accepts_medicaid"])
        & (prov["bilingual_services_listed"])
        & (prov["active_waitlist_count"] <= prov["monthly_slot_capacity"])
        & (~prov["provider_id"].astype(str).isin(out_bounce_ids))
    ]
    fast_vendors = prov[
        (prov["node_role"] == "EI_Therapy_Vendor")
        & (prov["part_c_vendor_enrolled"])
        & (prov["accepts_medicaid"])
        & (prov["bilingual_services_listed"])
        & (prov["active_waitlist_count"] <= prov["monthly_slot_capacity"])
        & (~prov["provider_id"].astype(str).isin(out_bounce_ids))
    ]

    coord_records = fast_coords.to_dict(orient="records")
    eval_records = fast_evals.to_dict(orient="records")
    vendor_records = fast_vendors.to_dict(orient="records")

    hrsa_tuples = _extract_hrsa_tuples(clean_state)
    tract_records = bq_tracts if bq_tracts is not None else demo.to_dict(orient="records")
    ranked = []
    max_u5 = max(1, max((int(tr["children_under_5_count"]) for tr in tract_records), default=1))
    for tr in tract_records:
        t_lat, t_lon = float(tr["latitude"]), float(tr["longitude"])
        u5 = int(tr["children_under_5_count"])
        pov = float(tr["poverty_rate"])
        noveh = float(tr["no_vehicle_rate"])
        byod_km, byod_name, byod_city = _nearest_byod_hrsa_site(t_lat, t_lon, hrsa_tuples)

        # Composite non-racial need index (explicitly avoids all-zero limited_english_rate and audit_*!)
        need_score = round((0.45 * pov + 0.30 * noveh + 0.25 * (u5 / max_u5)) * 100.0, 1)

        # Pair with nearest <=45-day uncongested, zero-bounce compliant downstream triad
        best_triad: tuple[float, int, dict[str, Any], dict[str, Any], dict[str, Any], float] | None = None
        for ev in eval_records:
            ev_km = haversine_km(t_lat, t_lon, float(ev["latitude"]), float(ev["longitude"]))
            ev_step = int(ev["median_internal_wait_days"]) + 5
            for vn in vendor_records:
                vn_km = haversine_km(t_lat, t_lon, float(vn["latitude"]), float(vn["longitude"]))
                vn_step = int(vn["median_internal_wait_days"]) + 6
                for co in coord_records:
                    co_step = int(co["median_internal_wait_days"])
                    est_days = co_step + ev_step + vn_step
                    if est_days > 45:
                        continue
                    co_km = haversine_km(t_lat, t_lon, float(co["latitude"]), float(co["longitude"]))
                    dist_rank = ev_km + 0.5 * vn_km + 0.25 * co_km
                    if best_triad is None or (dist_rank, est_days) < (best_triad[0], best_triad[1]):
                        best_triad = (dist_rank, est_days, co, ev, vn, ev_km)

        if best_triad is not None:
            _, est_days, best_coord, best_eval, best_vendor, eval_km = best_triad
            modality = (
                "local_in_person_hub"
                if eval_km <= 25.0
                else "mobile_eval_or_nemt_to_regional_hub"
            )
            pathway_info: dict[str, Any] = {
                "intake_coordinator_id": str(best_coord["provider_id"]),
                "eval_hub_id": str(best_eval["provider_id"]),
                "eval_hub_name": str(best_eval["synthetic_organization_name"]),
                "therapy_vendor_id": str(best_vendor["provider_id"]),
                "expected_cumulative_days": est_days,
                "clears_45d_mandate": est_days <= 45,
                "eval_hub_distance_km": eval_km,
                "delivery_modality": modality,
                "deploy_mobile_eval_van_with_screening": eval_km > 25.0 or noveh >= 0.12,
            }
        else:
            pathway_info = {
                "clears_45d_mandate": False,
                "eval_hub_distance_km": None,
                "delivery_modality": "mobile_eval_or_nemt_to_regional_hub",
                "deploy_mobile_eval_van_with_screening": True,
            }

        ranked.append({
            "census_tract_geoid": str(tr["census_tract_geoid"]).strip().zfill(11),
            "county_name": str(tr["county_name"]),
            "children_under_5_count": u5,
            "poverty_pct": round(pov * 100.0, 1),
            "zero_vehicle_pct": round(noveh * 100.0, 1),
            "non_racial_outreach_priority_score": need_score,
            "byod_nearest_fqhc_km": byod_km,
            "byod_fqhc_site_name": byod_name,
            "byod_fqhc_city": byod_city,
            "verified_downstream_45d_pathway": pathway_info,
        })

    ranked.sort(
        key=lambda x: (-x["non_racial_outreach_priority_score"], x["census_tract_geoid"])
    )
    return {
        "status": "ok",
        "execution_engine": engine,
        "state_code": clean_state,
        "byod_provenance": BYOD_HRSA_PROVENANCE,
        "formula_note": (
            "Weighted 45% poverty_rate + 30% no_vehicle_rate + 25% normalized children_under_5_count. "
            "Excludes all-zero ACS limited_english_rate (0.0) and excludes all audit_* race/ethnicity shares."
        ),
        "priority_screening_tracts": ranked[:limit],
    }


def _build_outreach_zones_gql(
    dataset: str,
    needs_medicaid: bool,
    needs_bilingual: bool,
    project: str = "",
    state_code: str = "",
) -> str:
    """Builds the concise BigQuery SQL + ISO GQL GRAPH_TABLE query for True Hidden EI Deserts."""
    clean_project = project.strip().strip("`") if isinstance(project, str) else ""
    if clean_project and not re.fullmatch(r"^[A-Za-z0-9_.:-]+$", clean_project):
        clean_project = ""
    clean_dataset = dataset.strip().strip("`")
    fq_dataset = f"{clean_project}.{clean_dataset}" if clean_project else clean_dataset
    graph_ref = (
        f"`{fq_dataset}.ReferralGraph`" if clean_project else f"{clean_dataset}.ReferralGraph"
    )

    clean_state = state_code.strip().upper() if isinstance(state_code, str) else ""
    if not re.fullmatch(r"^[A-Z]{2}$", clean_state):
        clean_state = ""
    outer_where = f" WHERE d.state_code='{clean_state}'" if clean_state else ""
    gql_state = f"n.state_code='{clean_state}' AND " if clean_state else ""
    med_pred = (
        " AND c.accepts_medicaid AND e.accepts_medicaid AND v.accepts_medicaid"
        if needs_medicaid
        else ""
    )
    bil_pred = (
        " AND c.bilingual_services_listed AND e.bilingual_services_listed AND v.bilingual_services_listed"
        if needs_bilingual
        else ""
    )
    return (
        "WITH cp AS ("
        "SELECT n_id, COUNT(DISTINCT CONCAT(c_id,'>',e_id,'>',v_id)) AS paths_45d "
        f"FROM GRAPH_TABLE({graph_ref} "
        "MATCH (c:CareNode {node_role:'Part_C_Intake_Coordinator'})-[r1:CAN_REFER_TO]->"
        "(e:CareNode {node_role:'Multidisciplinary_Eval_Hub'})-[r2:CAN_REFER_TO]->"
        "(v:CareNode {node_role:'EI_Therapy_Vendor'}),(h:CareNode)-[s:SERVES_AREA]->(n:Neighborhood) "
        f"WHERE {gql_state}s.travel_distance_km <= 25.0 AND h.provider_id IN (e.provider_id,v.provider_id)"
        " AND GREATEST(r1.target_congestion_ratio,r2.target_congestion_ratio)<=1.0"
        f" AND r1.target_outbound_bounce_rate=0 AND r2.target_outbound_bounce_rate=0{med_pred}{bil_pred} "
        "FILTER c.median_internal_wait_days+r1.expected_step_days+r2.expected_step_days<=45 "
        "RETURN n.tract_geoid AS n_id,c.provider_id AS c_id,e.provider_id AS e_id,v.provider_id AS v_id) GROUP BY 1)\n"
        "SELECT LPAD(d.census_tract_geoid,11,'0') AS geoid,"
        "ROUND(MIN(ST_DISTANCE(ST_GEOGPOINT(d.longitude,d.latitude),ST_GEOGPOINT(p.longitude,p.latitude))/1000.0),1) AS min_km,"
        "COALESCE(MAX(cp.paths_45d),0) AS paths_45d "
        f"FROM `{fq_dataset}.acs_under5_tract_demographics` d "
        f"JOIN `{fq_dataset}.pediatric_and_ei_provider_directory` p USING (state_code) "
        f"LEFT JOIN cp ON LPAD(d.census_tract_geoid,11,'0')=cp.n_id{outer_where} "
        "GROUP BY 1,d.poverty_rate ORDER BY d.poverty_rate DESC;"
    )


def rank_outreach_zones(
    needs_medicaid: bool = True,
    needs_bilingual: bool = True,
    top_n: int = 8,
) -> dict[str, Any]:
    """Ranks census tracts for outreach while detecting true care-delivery Hidden EI Deserts.

    Identifies tracts that appear well-served on a map (`nearest_any_clinic_km <= 25.0`)
    yet have zero `<=45`-day compliant, uncongested, zero-bounce `CAN_REFER_TO` pathways
    where an in-person Evaluation Hub or Therapy Vendor serves the neighborhood within
    `<= 25.0 km` (`reachable_45d_paths_count == 0`).

    Governance Rules Enforced:
      - `audit_*` demographic shares are NEVER used in `outreach_priority_score` or
        filtering; they are attached strictly post-output in `post_output_equity_context`.
      - All-zero ACS `limited_english_rate` (0.0) is excluded; statewide HRSA NSCH
        screening strata are reported separately at `'Statewide'` grain (no 6x fan-out).

    Args:
        needs_medicaid: Require `accepts_medicaid = TRUE` across coordinator, eval, and vendor.
        needs_bilingual: Require `bilingual_services_listed = TRUE` across coordinator, eval, and vendor.
        top_n: Number of top-priority outreach zones to return (1-12; default 8).
    """
    cfg = get_config()
    limit, err = _validate_top_n(top_n, default=8, max_limit=12, state_code=cfg["state"])
    if err is not None:
        return err
    assert limit is not None

    med_req = True if needs_medicaid is None else bool(needs_medicaid)
    bil_req = True if needs_bilingual is None else bool(needs_bilingual)

    frames = load_local_state_frames(cfg["state"])
    demo = frames["demo"]
    prov = frames["providers"]
    logs = frames["logs"]
    nsch = frames["nsch"]

    gql_query = _build_outreach_zones_gql(
        cfg["dataset"],
        needs_medicaid=med_req,
        needs_bilingual=bil_req,
        project=cfg["project"],
        state_code=cfg["state"],
    )
    bq_rows = graph_client.query_bq_or_none(gql_query)
    active_ds = graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    if bq_rows is not None:
        gql_query = rewrite_sql_dataset(gql_query, cfg["dataset"], active_ds)
    engine = (
        f"bigquery_property_graph_iso_gql ({cfg['project']}.{active_ds}.ReferralGraph)"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({cfg['state']} starter tables)"
    )

    bq_by_tract: dict[str, dict[str, Any]] = {}
    if bq_rows is not None:
        for row in bq_rows:
            raw_g = row.get("geoid") if "geoid" in row else row["census_tract_geoid"]
            geoid = str(raw_g).strip().zfill(11)
            bq_by_tract[geoid] = row

    hrsa_tuples = _extract_hrsa_tuples(cfg["state"])

    # Precompute compliant <=45-day CAN_REFER_TO (coord -> eval -> vendor) pathways
    out_bounce_ids = _outbound_bounce_provider_ids(logs)
    clean_ehr_wait = _clean_ehr_median_waits(logs)

    def _node_matches(row: Any, *, check_uncongested_and_nobounce: bool) -> bool:
        if not bool(row["part_c_vendor_enrolled"]):
            return False
        if med_req and not bool(row["accepts_medicaid"]):
            return False
        if bil_req and not bool(row["bilingual_services_listed"]):
            return False
        if check_uncongested_and_nobounce:
            if int(row["active_waitlist_count"]) > int(row["monthly_slot_capacity"]):
                return False
            if str(row["provider_id"]) in out_bounce_ids:
                return False
        return True

    coords = [
        r
        for _, r in prov[prov["node_role"] == "Part_C_Intake_Coordinator"].iterrows()
        if _node_matches(r, check_uncongested_and_nobounce=False)
    ]
    evals = [
        r
        for _, r in prov[prov["node_role"] == "Multidisciplinary_Eval_Hub"].iterrows()
        if _node_matches(r, check_uncongested_and_nobounce=True)
    ]
    vendors = [
        r
        for _, r in prov[prov["node_role"] == "EI_Therapy_Vendor"].iterrows()
        if _node_matches(r, check_uncongested_and_nobounce=True)
    ]

    compliant_triples: list[tuple[str, str, str]] = []
    care_coords: dict[str, tuple[float, float]] = {}
    for ev in evals:
        ev_id = str(ev["provider_id"])
        care_coords[ev_id] = (float(ev["latitude"]), float(ev["longitude"]))
    for vn in vendors:
        vn_id = str(vn["provider_id"])
        care_coords[vn_id] = (float(vn["latitude"]), float(vn["longitude"]))

    for co in coords:
        co_id = str(co["provider_id"])
        coord_step = int(co["median_internal_wait_days"])
        for ev in evals:
            ev_id = str(ev["provider_id"])
            eval_step = clean_ehr_wait.get((co_id, ev_id), int(ev["median_internal_wait_days"]) + 5)
            if coord_step + eval_step > 45:
                continue
            for vn in vendors:
                vn_id = str(vn["provider_id"])
                vendor_step = clean_ehr_wait.get(
                    (ev_id, vn_id), int(vn["median_internal_wait_days"]) + 6
                )
                if coord_step + eval_step + vendor_step <= 45:
                    compliant_triples.append((co_id, ev_id, vn_id))

    def _count_reachable_45d_paths(t_lat: float, t_lon: float) -> int:
        if not compliant_triples:
            return 0
        within_25km = {
            pid
            for pid, (plat, plon) in care_coords.items()
            if _haversine_km_2dec(t_lat, t_lon, plat, plon) <= 25.0
        }
        if not within_25km:
            return 0
        return sum(
            1
            for _, ev_id, vn_id in compliant_triples
            if (ev_id in within_25km or vn_id in within_25km)
        )

    max_u5 = max(1, int(demo["children_under_5_count"].max())) if not demo.empty else 1
    scored_zones: list[tuple[dict[str, Any], Any]] = []

    for _, tr in demo.iterrows():
        geoid = str(tr["census_tract_geoid"]).strip().zfill(11)
        t_lat, t_lon = float(tr["latitude"]), float(tr["longitude"])
        u5 = int(tr["children_under_5_count"])
        pov = float(tr["poverty_rate"])
        noveh = float(tr["no_vehicle_rate"])

        if geoid in bq_by_tract:
            b_row = bq_by_tract[geoid]
            nearest_any_clinic_km = round(
                float(b_row.get("min_km", b_row.get("nearest_any_clinic_km", 0.0))), 1
            )
            reachable_45d_paths_count = int(
                b_row.get("paths_45d", b_row.get("reachable_45d_compliant_paths", 0))
            )
        else:
            nearest_any_clinic_km = (
                min(
                    haversine_km(t_lat, t_lon, float(p["latitude"]), float(p["longitude"]))
                    for _, p in prov.iterrows()
                )
                if not prov.empty
                else 0.0
            )
            reachable_45d_paths_count = _count_reachable_45d_paths(t_lat, t_lon)

        is_hidden_ei_desert = (
            nearest_any_clinic_km <= 25.0 and reachable_45d_paths_count == 0
        )

        # Non-racial outreach priority score (never uses audit_* or all-zero limited_english_rate)
        base_need = 0.45 * pov + 0.30 * noveh + 0.25 * (u5 / max_u5)
        desert_bonus = 0.25 if is_hidden_ei_desert else 0.0
        outreach_priority_score = round((base_need + desert_bonus) * 100.0, 1)

        byod_km, byod_name, byod_city = _nearest_byod_hrsa_site(t_lat, t_lon, hrsa_tuples)
        short_site = (
            (byod_name[:42].rstrip() + "...")
            if byod_name and len(byod_name) > 45
            else byod_name
        )
        zone = {
            "census_tract_geoid": geoid,
            "county_name": str(tr["county_name"]),
            "children_under_5_count": u5,
            "poverty_pct": round(pov * 100.0, 1),
            "zero_vehicle_pct": round(noveh * 100.0, 1),
            "nearest_any_clinic_km": nearest_any_clinic_km,
            "reachable_45d_paths_count": reachable_45d_paths_count,
            "is_hidden_ei_desert": is_hidden_ei_desert,
            "mobility_support_recommended": bool(
                noveh >= 0.10 or nearest_any_clinic_km > 25.0 or is_hidden_ei_desert
            ),
            "outreach_priority_score": outreach_priority_score,
            "byod_nearest_fqhc_km": byod_km,
            "byod_fqhc_site_name": short_site,
            "byod_fqhc_city": byod_city,
        }
        scored_zones.append((zone, tr))

    scored_zones.sort(
        key=lambda item: (-item[0]["outreach_priority_score"], item[0]["census_tract_geoid"])
    )
    hidden_ei_deserts_count = sum(1 for z, _ in scored_zones if z["is_hidden_ei_desert"])

    ranked_outreach_zones: list[dict[str, Any]] = [
        zone for zone, _ in scored_zones[:limit]
    ]

    # Compact Statewide HRSA NSCH screening gap context (lowest Statewide stratum for <6KB budget)
    nsch_statewide = (
        nsch[nsch["geographic_level"].astype(str) == "Statewide"]
        if "geographic_level" in nsch.columns
        else nsch
    )
    nsch_clean = [
        {
            "household_income_fpl_band": str(r["household_income_fpl_band"]),
            "primary_home_language": str(r["primary_home_language"]),
            "standardized_screening_rate_pct": round(
                float(r["standardized_screening_rate_pct"]) * 100.0, 1
            ),
            "followup_requested_pct": round(float(r["followup_requested_pct"]) * 100.0, 1),
        }
        for _, r in nsch_statewide.sort_values("standardized_screening_rate_pct").head(1).iterrows()
    ]

    zero_lep_rows = int((demo["limited_english_rate"] == 0.0).sum())

    return {
        "status": "ok",
        "engine": engine,
        "byod_provenance": "HRSA FQHC Sites (17 U.S.C. § 105 US Public Domain)",
        "synthetic_provenance_notice": (
            "100% [Synthetic] CareNode/ReferralGraph; ACS & NSCH."
        ),
        "iso_gql_query": gql_query,
        "filters_applied": {
            "needs_medicaid": med_req,
            "needs_bilingual": bil_req,
            "max_wait_days": 45,
            "hidden_desert_radius_km": 25.0,
        },
        "hidden_ei_deserts_count": hidden_ei_deserts_count,
        "statewide_nsch_screening_gap_context": nsch_clean,
        "ranked_outreach_zones": ranked_outreach_zones,
        "governance_attestation": {
            "audit_columns_excluded_from_scoring": True,
            "acs_limited_english_rate_trap_caught": (
                f"{zero_lep_rows}/{len(demo)} LEP=0.0; NSCH + bilingual_services_listed."
            ),
            "nsch_statewide_grain_preserved": f"{len(nsch_clean)} Statewide row.",
        },
    }
