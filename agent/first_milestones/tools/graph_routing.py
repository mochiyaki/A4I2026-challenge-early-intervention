"""Custom ISO GQL + Spatial Routing Tools (`find_compliant_45d_pathways` & `find_viable_45d_paths`).

Finds IDEA Part C <=45-day compliant stage-valid multi-hop provider sequences for an
incoming infant or toddler referral while contrasting against historical 3-to-4-hop
bounce loops in `a4i_early_intervention.ReferralGraph`.

Strict Governance & Clinical Rigor Guardrails:
  - Uses BigQuery Property Graph ISO GQL (`GRAPH_TABLE` over `ReferralGraph`) +
    `ST_DISTANCE` spatial proximity when connected to GCP (with exact local
    GeoParquet parity fallback).
  - Separates prospective capability (`CAN_REFER_TO`: observed clean EHR corridors +
    prospective stage-valid capability transitions) from historical event logs (`REFERS_TO`).
  - Day 0 of the 45-day IDEA Part C clock starts at referral transmission
    (`34 CFR § 303.310`) — pre-referral `Screening_Pediatric_Clinic` internal wait is
    not double-counted onto the Part C timeline.
  - Prunes congested nodes (`congestion_ratio > 1.0`) and operational bounce traps
    (`outbound_bounce_rate > max_bounce_rate`).
  - Enforces strict IDEA Part C statutory age eligibility (`0-35` months, `34 CFR § 303.21`;
    `>=36` months triggers immediate IDEA Part B Section 619 LEA referral under
    `34 CFR § 300.800` instead of silent clamping) and active-state tract/county FIPS
    validation (zero silent wrong-neighborhood substitution).
  - Never touches `audit_*` demographic columns or the all-zero ACS
    `limited_english_rate` column.
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
from .slot_ledger import get_active_hold_counts

_FIPS_PREFIX_TO_STATE: dict[str, str] = {
    "01": "AL",
    "06": "CA",
    "13": "GA",
    "28": "MS",
    "36": "NY",
    "48": "TX",
}

_SYNTHETIC_NOTICE = (
    "100% [Synthetic] CareNode (SYN-PROV-*) & ReferralGraph; real US Census ACS tracts."
)

_NON_ENGLISH_HINTS = (
    "spanish",
    "español",
    "espanol",
    "vietnamese",
    "arabic",
    "mandarin",
    "cantonese",
    "chinese",
    "french",
    "creole",
    "haitian",
    "tagalog",
    "korean",
    "russian",
    "portuguese",
    "somali",
    "amharic",
    "bilingual",
    "non-english",
    "asl",
)


def _normalize_concern_domain(raw_domain: str | None) -> str:
    """Maps clinical specialty or concern strings to the 4 canonical Part C domains."""
    if raw_domain is None:
        return "Expressive Speech/Language"
    low = str(raw_domain).strip().lower()
    if not low:
        return "Expressive Speech/Language"
    if any(k in low for k in ("autism", "asd", "social", "m-chat", "behavior")):
        return "Social-Communication / Autism Screen"
    if any(k in low for k in ("motor", "pt", "physical therapy", "gross", "mobility")):
        return "Motor Milestone Delay"
    if any(k in low for k in ("feed", "sensory", "swallow", "dysphagia", "ot", "occupational")):
        return "Feeding & Sensory"
    if any(k in low for k in ("speech", "lang", "slp", "expressive", "articulation")):
        return "Expressive Speech/Language"
    return "Expressive Speech/Language"


def _parse_insurance_medicaid(insurance: str | None) -> tuple[str, bool]:
    """Parses insurance text with negation safety (`non-Medicaid`, `no Medicaid`, `Commercial`)."""
    ins_clean = "Medicaid" if insurance is None else str(insurance).strip()
    ins_low = ins_clean.lower()
    if any(
        neg in ins_low
        for neg in (
            "no medicaid",
            "non-medicaid",
            "non_medicaid",
            "not medicaid",
            "without medicaid",
            "commercial",
            "private",
            "uninsured",
            "self-pay",
        )
    ):
        return ins_clean, False
    if "medicaid" in ins_low or "chip" in ins_low:
        return ins_clean, True
    return ins_clean, False


def _parse_language_bilingual(languages: str | None) -> tuple[str, bool, dict[str, str] | None]:
    """Parses preferred language (`English only` -> False; non-Spanish -> interpreter alert)."""
    lang_clean = "Spanish" if languages is None else str(languages).strip()
    lang_low = lang_clean.lower()
    has_non_en = any(tok in lang_low for tok in _NON_ENGLISH_HINTS)
    if not has_non_en and (
        lang_low in ("", "english", "english only", "en", "en-us", "en_us", "none")
        or lang_low.startswith("english")
    ):
        return lang_clean, False, None

    alert: dict[str, str] | None = None
    if (
        "spanish" not in lang_low
        and "español" not in lang_low
        and "espanol" not in lang_low
        and lang_low not in ("bilingual", "non-english")
    ):
        alert = {
            "code": "LANGUAGE_SPECIFIC_INTERPRETER_VERIFICATION",
            "severity": "MEDIUM",
            "message": (
                f"Requested language '{lang_clean}' enabled bilingual provider filtering, "
                "but `bilingual_services_listed` is a boolean without per-language breakdown. "
                f"Verify dedicated '{lang_clean}' interpreter availability at intake (34 CFR § 303.321(a)(5))."
            ),
        }
    return lang_clean, True, alert


def _parse_age_months(raw_age: Any) -> int | float | None:
    """Parses `child_age_months` (`int` or finite `float >= 0`, preserving `int` when whole)."""
    if isinstance(raw_age, bool):
        return None
    if isinstance(raw_age, int):
        return raw_age if raw_age >= 0 else None
    if isinstance(raw_age, float):
        if not math.isfinite(raw_age) or raw_age < 0.0:
            return None
        return int(raw_age) if raw_age.is_integer() else round(raw_age, 2)
    if isinstance(raw_age, str):
        s_age = raw_age.strip()
        if re.fullmatch(r"[+-]?\d+", s_age):
            val_i = int(s_age)
            return val_i if val_i >= 0 else None
        if re.fullmatch(r"[+-]?\d+\.\d+", s_age):
            val_f = float(s_age)
            if math.isfinite(val_f) and val_f >= 0.0:
                return int(val_f) if val_f.is_integer() else round(val_f, 2)
    return None


def classify_part_c_age_tier(raw_age: Any) -> dict[str, Any] | None:
    """Classifies a child's age under the 5-tier IDEA `34 CFR § 303.209` / `§ 303.21` engine.

    Tiers:
      1. `0-26m`: Standard 45-day IDEA Part C (`tier_1_standard_part_c_45d`).
      2. `27-32m`: LEA Part B Transition Planning Window (`34 CFR § 303.209`).
      3. `33.0-34.4m`: Tightened transition window (<91d to age 3); checks `est_age >= 36.0m`.
      4. `34.5-35.9m`: `<45 days to age 3` (`34 CFR § 303.209(b)(1)(iii)` exemption) +
         dual Part C / LEA Part B warm handoff.
      5. `>=36m`: Direct IDEA Part B Section 619 LEA referral (`34 CFR § 300.800`).
    """
    age_val = _parse_age_months(22 if raw_age is None else raw_age)
    if age_val is None:
        return None

    age_f = float(age_val)
    days_until_age_3 = 0 if age_f >= 36.0 else max(1, int(round((36.0 - age_f) * 30.44)))

    if age_f >= 36.0:
        return {
            "age_months": age_val,
            "age_float": age_f,
            "statutory_transition_tier": "tier_5_part_b_section_619_lea_direct_36m_plus",
            "tier_label": "Direct IDEA Part B Section 619 LEA Referral (>=36m)",
            "days_until_age_3": 0,
            "effective_deadline_days": 0,
            "dual_lea_handoff_required": True,
            "part_c_eligible": False,
            "exemption_303_209_b_1_iii": False,
            "statutory_citations": ["34 CFR § 303.21", "34 CFR § 300.800"],
        }
    if age_f >= 34.5:
        return {
            "age_months": age_val,
            "age_float": age_f,
            "statutory_transition_tier": "tier_4_less_than_45d_exemption_dual_handoff_34_5_35_9m",
            "tier_label": "<45 Days to Age 3: 34 CFR § 303.209(b)(1)(iii) Exemption + Dual Part C/LEA B Handoff",
            "days_until_age_3": min(44, days_until_age_3),
            "effective_deadline_days": min(44, days_until_age_3),
            "dual_lea_handoff_required": True,
            "part_c_eligible": True,
            "exemption_303_209_b_1_iii": True,
            "statutory_citations": [
                "34 CFR § 303.310",
                "34 CFR § 303.209(b)(1)(iii)",
                "34 CFR § 300.800",
            ],
        }
    if age_f >= 33.0:
        return {
            "age_months": age_val,
            "age_float": age_f,
            "statutory_transition_tier": "tier_3_tightened_transition_33_34m",
            "tier_label": "Tightened Part C->B Transition Window (33.0-34.4m)",
            "days_until_age_3": days_until_age_3,
            "effective_deadline_days": min(45, days_until_age_3),
            "dual_lea_handoff_required": True,
            "part_c_eligible": True,
            "exemption_303_209_b_1_iii": False,
            "statutory_citations": ["34 CFR § 303.310", "34 CFR § 303.209"],
        }
    if age_f >= 27.0:
        return {
            "age_months": age_val,
            "age_float": age_f,
            "statutory_transition_tier": "tier_2_lea_transition_planning_27_32m",
            "tier_label": "LEA Part B Transition Planning Window (27-32m, 34 CFR § 303.209)",
            "days_until_age_3": days_until_age_3,
            "effective_deadline_days": 45,
            "dual_lea_handoff_required": True,
            "part_c_eligible": True,
            "exemption_303_209_b_1_iii": False,
            "statutory_citations": ["34 CFR § 303.310", "34 CFR § 303.209"],
        }
    return {
        "age_months": age_val,
        "age_float": age_f,
        "statutory_transition_tier": "tier_1_standard_part_c_45d",
        "tier_label": "Standard 45-Day IDEA Part C Track (0-26m)",
        "days_until_age_3": days_until_age_3,
        "effective_deadline_days": 45,
        "dual_lea_handoff_required": False,
        "part_c_eligible": True,
        "exemption_303_209_b_1_iii": False,
        "statutory_citations": ["34 CFR § 303.310"],
    }


def _build_age_transition_alerts(
    age_info: dict[str, Any],
    *,
    est_age_recommended: float | None = None,
    est_age_bounce: float | None = None,
    cautionary_wait_days: int | None = None,
) -> list[dict[str, str]]:
    """Builds statutory `34 CFR § 303.209` transition alerts across the 5 age tiers."""
    alerts: list[dict[str, str]] = []
    tier = age_info["statutory_transition_tier"]
    age_m = age_info["age_months"]
    age_f = age_info["age_float"]
    days_left = age_info["days_until_age_3"]

    if tier == "tier_2_lea_transition_planning_27_32m":
        alerts.append({
            "code": "IDEA_PART_C_LEA_TRANSITION_PLANNING_WINDOW",
            "severity": "MEDIUM" if age_f < 30.0 else "HIGH",
            "message": (
                f"Age {age_m}m ({days_left}d to age 3) is inside the LEA Part B Transition Planning "
                "Window (34 CFR § 303.209); coordinate opt-out/referral readiness with the Local Educational Agency."
            ),
        })
    elif tier == "tier_3_tightened_transition_33_34m":
        exceeds = est_age_recommended is not None and est_age_recommended >= 36.0
        alerts.append({
            "code": "IDEA_PART_C_TIGHTENED_TRANSITION_WINDOW",
            "severity": "CRITICAL" if exceeds else "HIGH",
            "message": (
                f"Age {age_m}m leaves ~{days_left}d until age 3 (effective deadline {age_info['effective_deadline_days']}d). "
                + (
                    f"Projected IFSP age {est_age_recommended}m reaches >=36.0m; initiate dual LEA Part B evaluation immediately."
                    if exceeds
                    else "Expedite 45d Part C evaluation alongside LEA Part B transition conference (34 CFR § 303.209)."
                )
            ),
        })
    elif tier == "tier_4_less_than_45d_exemption_dual_handoff_34_5_35_9m":
        alerts.append({
            "code": "IDEA_PART_C_303_209_EXEMPTION_DUAL_HANDOFF",
            "severity": "CRITICAL",
            "message": (
                f"Age {age_m}m leaves only {days_left}d (<45d) before age 3: 34 CFR § 303.209(b)(1)(iii) "
                "exemption applies; execute immediate dual Part C / IDEA Part B LEA warm handoff."
            ),
        })

    if age_f >= 30.0 and age_f < 36.0:
        bounce_note = (
            f" {cautionary_wait_days or 75}d bounce delays IFSP to ~{est_age_bounce}m."
            if est_age_bounce is not None
            else ""
        )
        alerts.append({
            "code": "IDEA_PART_C_36M_AGING_OUT_CLIFF",
            "severity": "HIGH",
            "message": (
                f"Age {age_m}m nears 36m Part C cutoff;{bounce_note} "
                "send concurrent IDEA Part B notice (34 CFR § 303.209)."
            ),
        })

    if est_age_recommended is not None and est_age_recommended >= 36.0 and age_f < 36.0:
        alerts.append({
            "code": "IDEA_PART_C_IFSP_EXCEEDS_AGE_3_CUTOFF",
            "severity": "CRITICAL",
            "message": (
                f"Projected completion at {est_age_recommended}m crosses the 36.0m Part C cutoff; "
                "cannot claim timely Part C IFSP before age 3—route via dual Part C / Part B LEA warm handoff."
            ),
        })

    return alerts


def _make_structured_early_return(
    *,
    status: str,
    error_code: str,
    message: str,
    state_code: str,
    age_m: int | float | None = None,
    guardrail_alerts: list[dict[str, str]] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Builds a compact, None-safe structured error or statutory ineligibility payload."""
    default_engine = f"local_geoparquet_mirror ({state_code} starter tables)"
    age_int = int(age_m) if age_m is not None else None
    child_prof: dict[str, Any] = {
        "state_code": state_code,
        "home_tract_geoid": "",
        "child_age_months": age_int,
        "tract_zero_vehicle_pct": 0.0,
    }
    if isinstance(age_m, float):
        child_prof["child_age_exact_months"] = age_m
    payload: dict[str, Any] = {
        "status": status,
        "error_code": error_code,
        "message": message,
        "engine": default_engine,
        "execution_engine": default_engine,
        "synthetic_provenance_notice": _SYNTHETIC_NOTICE,
        "child_profile": child_prof,
        "tract_context": {
            "state_code": state_code,
            "census_tract_geoid": "",
            "county_fips": "",
        },
        "viable_paths": [],
        "recommended_pathway": None,
        "alternative_compliant_pathways": [],
        "cautionary_historical_bounce_chain": None,
        "days_saved_vs_bounce_loop": None,
        "pruned_high_bounce_edges_count": 0,
        "guardrail_alerts": guardrail_alerts or [],
    }
    if age_m is not None:
        payload["child_age_months"] = age_m
    if extra:
        payload.update(extra)
    return payload


def _validate_and_resolve_common_inputs(
    *,
    raw_location: str | None,
    child_age_months: Any,
    max_bounce_rate: Any,
    max_travel_km: Any,
    demo: Any,
    state_code: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Validates statutory age, numeric thresholds, and active-state Census location.

    Returns `(resolved_dict, None)` when valid, or `(None, structured_error_payload)`
    when input fails validation or exceeds IDEA Part C statutory age (`>= 36` months).
    """
    # 1. Validate child_age_months via 5-tier 34 CFR § 303.209 / § 303.21 engine
    age_info = classify_part_c_age_tier(child_age_months)
    if age_info is None:
        return None, _make_structured_early_return(
            status="validation_error",
            error_code="INVALID_AGE_MONTHS",
            message="child_age_months must be a finite number >= 0.",
            state_code=state_code,
            age_m=None,
        )
    age_m = age_info["age_months"]

    if not age_info["part_c_eligible"]:
        aged_out_msg = (
            f"At {age_m} months, the child has aged out of IDEA Part C (0-35 months, 34 CFR § 303.21). "
            "Refer directly to IDEA Part B Section 619 Preschool Special Education "
            "(ages 3-5, 34 CFR § 300.800) via the Local Educational Agency (LEA)."
        )
        return None, _make_structured_early_return(
            status="ineligible_part_c_aged_out",
            error_code="IDEA_PART_C_AGE_INELIGIBLE_REFER_PART_B_619",
            message=aged_out_msg,
            state_code=state_code,
            age_m=age_m,
            guardrail_alerts=[
                {
                    "code": "IDEA_PART_C_AGED_OUT_REFER_PART_B_619",
                    "severity": "CRITICAL",
                    "message": aged_out_msg,
                }
            ],
            extra={
                "statutory_transition_tier": age_info["statutory_transition_tier"],
                "days_until_age_3": 0,
                "effective_deadline_days": 0,
                "dual_lea_handoff_required": True,
            },
        )

    # 2. Validate max_bounce_rate & max_travel_km
    raw_mb = 0.25 if max_bounce_rate is None else max_bounce_rate
    if isinstance(raw_mb, bool):
        return None, _make_structured_early_return(
            status="validation_error",
            error_code="INVALID_MAX_BOUNCE_RATE",
            message="max_bounce_rate must be a finite number >= 0.0.",
            state_code=state_code,
            age_m=age_m,
        )
    try:
        mb_val = float(raw_mb)
    except (TypeError, ValueError):
        mb_val = float("nan")
    if not math.isfinite(mb_val) or mb_val < 0.0:
        return None, _make_structured_early_return(
            status="validation_error",
            error_code="INVALID_MAX_BOUNCE_RATE",
            message="max_bounce_rate must be a finite number >= 0.0.",
            state_code=state_code,
            age_m=age_m,
        )
    clean_max_bounce = min(mb_val, 1.0)

    raw_km = 65.0 if max_travel_km is None else max_travel_km
    if isinstance(raw_km, bool):
        return None, _make_structured_early_return(
            status="validation_error",
            error_code="INVALID_MAX_TRAVEL_KM",
            message="max_travel_km must be a finite number > 0.",
            state_code=state_code,
            age_m=age_m,
        )
    try:
        km_val = float(raw_km)
    except (TypeError, ValueError):
        km_val = float("nan")
    if not math.isfinite(km_val) or km_val <= 0.0:
        return None, _make_structured_early_return(
            status="validation_error",
            error_code="INVALID_MAX_TRAVEL_KM",
            message="max_travel_km must be a finite number > 0.",
            state_code=state_code,
            age_m=age_m,
        )

    # 3. Validate & resolve Census tract / county FIPS in active state (zero silent cross-state fallback)
    raw_loc = "" if raw_location is None else str(raw_location).strip()
    if not raw_loc:
        tract_row = demo.sort_values(
            ["poverty_rate", "children_under_5_count", "census_tract_geoid"],
            ascending=[False, False, True],
        ).iloc[0]
        tract_resolution = "state_default_highest_poverty"
    else:
        tract_match = demo.iloc[0:0]
        tract_resolution = ""
        if re.fullmatch(r"\d{10,11}", raw_loc):
            padded_geoid = raw_loc.zfill(11)
            tract_match = demo[demo["census_tract_geoid"] == padded_geoid]
            tract_resolution = "exact_census_tract_geoid"
        elif re.fullmatch(r"\d{4,5}", raw_loc):
            padded_fips = raw_loc.zfill(5)
            tract_match = demo[demo["county_fips"] == padded_fips]
            tract_resolution = "county_fips_highest_poverty_tract"

        if tract_match.empty:
            prefix2 = ""
            if re.fullmatch(r"\d{10,11}", raw_loc):
                prefix2 = raw_loc.zfill(11)[:2]
            elif re.fullmatch(r"\d{4,5}", raw_loc):
                prefix2 = raw_loc.zfill(5)[:2]
            hint_state = _FIPS_PREFIX_TO_STATE.get(prefix2, "")
            cross_hint = (
                f" FIPS prefix '{prefix2}' belongs to state '{hint_state}', whereas active state is '{state_code}'."
                if (hint_state and hint_state != state_code)
                else ""
            )
            loc_msg = (
                f"Location '{raw_loc}' did not match any 11-digit Census tract GEOID or 5-digit county FIPS "
                f"in active state '{state_code}'.{cross_hint} Starter ACS tables use 11-digit Census tracts or "
                "5-digit county FIPS (postal ZIP/ZCTA codes are not directly indexed)."
            )
            return None, _make_structured_early_return(
                status="validation_error",
                error_code="LOCATION_NOT_FOUND_IN_ACTIVE_STATE",
                message=loc_msg,
                state_code=state_code,
                age_m=age_m,
                extra={
                    "requested_location": raw_loc,
                    "active_state": state_code,
                    "sample_valid_tracts": demo["census_tract_geoid"].head(3).tolist(),
                    "sample_valid_county_fips": sorted(demo["county_fips"].unique().tolist()),
                },
            )

        tract_row = tract_match.sort_values(
            ["poverty_rate", "children_under_5_count", "census_tract_geoid"],
            ascending=[False, False, True],
        ).iloc[0]

    return {
        "age_m": age_m,
        "age_info": age_info,
        "max_bounce": clean_max_bounce,
        "max_travel_km": km_val,
        "raw_loc": raw_loc,
        "tract_row": tract_row,
        "tract_resolution": tract_resolution,
    }, None


def _compute_network_telemetry(
    prov: Any,
    logs: Any,
    max_bounce: float,
    state_code: str = "",
) -> dict[str, Any]:
    """Computes clean EHR edge medians, domain maps, edge bounce rates, and hold-aware node congestion."""
    edge_stats: dict[tuple[str, str], dict[str, Any]] = {}
    clean_ehr_wait: dict[tuple[str, str], int] = {}
    clean_ehr_domains: dict[tuple[str, str], set[str]] = {}
    outbound_stats: dict[str, tuple[int, int, float]] = {}

    eff_bounce = 0.0 if max_bounce <= 0.0 else min(float(max_bounce), 0.35)

    if not logs.empty:
        for src_id, grp in logs.groupby("source_provider_id"):
            tot = len(grp)
            b_cnt = int(grp["handoff_reason"].astype(str).str.startswith("Re-Referral Bounce").sum())
            b_rate = round(b_cnt / tot, 4) if tot > 0 else 0.0
            outbound_stats[str(src_id)] = (tot, b_cnt, b_rate)

        for (s_id, t_id), grp in logs.groupby(["source_provider_id", "target_provider_id"]):
            total_cnt = len(grp)
            bounce_mask = grp["handoff_reason"].astype(str).str.startswith("Re-Referral Bounce")
            bounce_cnt = int(bounce_mask.sum())
            bounce_rate = bounce_cnt / total_cnt if total_cnt > 0 else 0.0
            is_high_bounce = (bounce_cnt > 0) if eff_bounce <= 0.0 else (bounce_rate > eff_bounce)

            non_b = grp[~bounce_mask]
            ehr_clean = non_b[non_b["transmission_channel"] == "ehr_electronic_portal"]
            if not ehr_clean.empty:
                pair_key = (str(s_id), str(t_id))
                clean_ehr_wait[pair_key] = int(round(float(ehr_clean["handoff_wait_days"].median())))
                clean_ehr_domains[pair_key] = set(ehr_clean["concern_domain"].astype(str).tolist())

            edge_stats[(str(s_id), str(t_id))] = {
                "total": total_cnt,
                "bounce_count": bounce_cnt,
                "bounce_rate": round(bounce_rate, 4),
                "is_high_bounce": is_high_bounce,
            }

    resolved_state = state_code.strip().upper()
    if not resolved_state and not prov.empty and "state_code" in prov.columns:
        resolved_state = str(prov["state_code"].iloc[0]).strip().upper()
    hold_counts = get_active_hold_counts(resolved_state) if resolved_state in VALID_STATES else {}

    node_telemetry: dict[str, dict[str, Any]] = {}
    pruned_nodes_count = 0
    part_c_roles = {"Part_C_Intake_Coordinator", "Multidisciplinary_Eval_Hub", "EI_Therapy_Vendor"}

    for _, r in prov.iterrows():
        pid = str(r["provider_id"])
        role = str(r["node_role"])
        wl = int(r["active_waitlist_count"])
        active_holds = int(hold_counts.get(pid, 0))
        eff_wl = wl + active_holds
        cap = max(1, int(r["monthly_slot_capacity"]))
        cong_ratio = round(eff_wl / cap, 2)
        _, out_b_cnt, out_b_rate = outbound_stats.get(pid, (0, 0, 0.0))
        exceeds_bounce = (out_b_cnt > 0) if eff_bounce <= 0.0 else (out_b_rate > eff_bounce)
        is_pruned_part_c = role in part_c_roles and (cong_ratio > 1.0 or exceeds_bounce)
        if is_pruned_part_c:
            pruned_nodes_count += 1
        node_telemetry[pid] = {
            "congestion_ratio": cong_ratio,
            "active_hold_count": active_holds,
            "effective_waitlist_count": eff_wl,
            "outbound_bounce_rate": out_b_rate,
            "is_pruned": is_pruned_part_c,
        }

    pruned_high_bounce_edges_count = sum(1 for v in edge_stats.values() if v["is_high_bounce"])
    return {
        "edge_stats": edge_stats,
        "clean_ehr_wait": clean_ehr_wait,
        "clean_ehr_domains": clean_ehr_domains,
        "node_telemetry": node_telemetry,
        "pruned_nodes_count": pruned_nodes_count,
        "pruned_high_bounce_edges_count": pruned_high_bounce_edges_count,
        "active_slot_holds_total": sum(hold_counts.values()),
        "active_slot_holds_by_provider": hold_counts,
    }


def _step_delay_days(
    u_id: str,
    v_row: Any,
    clean_ehr_wait: dict[tuple[str, str], int],
    edge_stats: dict[tuple[str, str], dict[str, Any]],
) -> tuple[int, str] | None:
    """Computes ground-truth step delay (`expected_step_days`) and relationship semantics."""
    v_id = str(v_row["provider_id"])
    e_info = edge_stats.get((u_id, v_id))
    if e_info is not None and e_info["is_high_bounce"]:
        return None
    observed = clean_ehr_wait.get((u_id, v_id))
    if observed is not None:
        return observed, "observed_clean_corridor"
    v_role = str(v_row["node_role"])
    overhead = (
        0
        if v_role == "Part_C_Intake_Coordinator"
        else (5 if v_role == "Multidisciplinary_Eval_Hub" else 6)
    )
    return int(v_row["median_internal_wait_days"]) + overhead, "prospective_capability"


def _evaluate_candidate_corridors(
    *,
    prov: Any,
    telemetry: dict[str, Any],
    home_lat: float,
    home_lon: float,
    canonical_domain: str,
    needs_medicaid: bool,
    needs_bilingual: bool,
    prior_diagnostic_completed: bool,
) -> list[dict[str, Any]]:
    """Evaluates stage-valid <=45-day Part C corridors with congestion & bounce pruning."""
    node_tel = telemetry["node_telemetry"]
    clean_ehr_wait = telemetry["clean_ehr_wait"]
    clean_ehr_domains = telemetry["clean_ehr_domains"]
    edge_stats = telemetry["edge_stats"]

    dist_by_id: dict[str, float] = {}
    for _, r in prov.iterrows():
        dist_by_id[str(r["provider_id"])] = haversine_km(
            home_lat, home_lon, float(r["latitude"]), float(r["longitude"])
        )

    clinics = prov[prov["node_role"] == "Screening_Pediatric_Clinic"].copy()
    if needs_medicaid:
        clinics = clinics[clinics["accepts_medicaid"]]

    def _eligible_part_c(role_name: str) -> list[Any]:
        sub = prov[(prov["node_role"] == role_name) & (prov["part_c_vendor_enrolled"])]
        if needs_medicaid:
            sub = sub[sub["accepts_medicaid"]]
        if needs_bilingual:
            sub = sub[sub["bilingual_services_listed"]]
        return [
            row
            for _, row in sub.iterrows()
            if not node_tel[str(row["provider_id"])]["is_pruned"]
        ]

    clinic_rows = [row for _, row in clinics.iterrows()]
    coord_rows = _eligible_part_c("Part_C_Intake_Coordinator")
    eval_rows = _eligible_part_c("Multidisciplinary_Eval_Hub")
    vendor_rows = _eligible_part_c("EI_Therapy_Vendor")

    corridors: list[dict[str, Any]] = []

    # Standard 3-hop stage-valid corridor: Clinic -> Coordinator -> Eval Hub -> Therapy Vendor
    for cl in clinic_rows:
        cl_id = str(cl["provider_id"])
        cl_km = dist_by_id[cl_id]
        for co in coord_rows:
            co_id = str(co["provider_id"])
            step1 = _step_delay_days(cl_id, co, clean_ehr_wait, edge_stats)
            if step1 is None:
                continue
            w1, rel1 = step1
            co_km = dist_by_id[co_id]

            for ev in eval_rows:
                ev_id = str(ev["provider_id"])
                step2 = _step_delay_days(co_id, ev, clean_ehr_wait, edge_stats)
                if step2 is None:
                    continue
                w2, rel2 = step2
                if w1 + w2 > 45:
                    continue
                ev_km = dist_by_id[ev_id]
                dom_matched = canonical_domain in clean_ehr_domains.get((co_id, ev_id), set())

                for vn in vendor_rows:
                    vn_id = str(vn["provider_id"])
                    step3 = _step_delay_days(ev_id, vn, clean_ehr_wait, edge_stats)
                    if step3 is None:
                        continue
                    w3, rel3 = step3
                    total_days = w1 + w2 + w3
                    if total_days > 45:
                        continue
                    vn_km = dist_by_id[vn_id]
                    mean_ev_vn_km = round((ev_km + vn_km) / 2.0, 2)
                    mobile_capable = (
                        bool(vn["mobile_visit_capable"])
                        if "mobile_visit_capable" in vn.index
                        else True
                    )
                    family_clinic_km = round(ev_km, 1)
                    max_fam_km = family_clinic_km if mobile_capable else round(max(ev_km, vn_km), 1)
                    path_nodes = [cl_id, co_id, ev_id, vn_id]
                    holds_on_path = sum(int(node_tel[n].get("active_hold_count", 0)) for n in path_nodes)
                    max_util = max(float(node_tel[n].get("congestion_ratio", 0.0)) for n in path_nodes)
                    obs_hops = int(
                        (rel1 == "observed_clean_corridor")
                        + (rel2 == "observed_clean_corridor")
                        + (rel3 == "observed_clean_corridor")
                    )
                    corridors.append({
                        "hop_count": 3,
                        "clinic": cl,
                        "coord": co,
                        "eval_hub": ev,
                        "vendor": vn,
                        "w1": w1,
                        "w2": w2,
                        "w3": w3,
                        "rel1": rel1,
                        "rel2": rel2,
                        "rel3": rel3,
                        "total_days": total_days,
                        "domain_matched": dom_matched,
                        "observed_corridor_hops": obs_hops,
                        "clinic_km": cl_km,
                        "coord_km": co_km,
                        "eval_km": ev_km,
                        "vendor_km": vn_km,
                        "eval_vendor_distance_km": mean_ev_vn_km,
                        "family_clinic_travel_km": family_clinic_km,
                        "home_visit_vendor_distance_km": round(vn_km, 1),
                        "mobile_visit_capable": mobile_capable,
                        "max_family_km": max_fam_km,
                        "holds_on_path": holds_on_path,
                        "max_utilization_ratio": max_util,
                        "dedup_key": (ev_id, vn_id, 3),
                        "nodes": path_nodes,
                    })

    # Optional 2-hop fast-track ONLY when prior diagnostic eligibility is already complete
    if prior_diagnostic_completed:
        for cl in clinic_rows:
            cl_id = str(cl["provider_id"])
            cl_km = dist_by_id[cl_id]
            for co in coord_rows:
                co_id = str(co["provider_id"])
                step1 = _step_delay_days(cl_id, co, clean_ehr_wait, edge_stats)
                if step1 is None:
                    continue
                w1, rel1 = step1
                co_km = dist_by_id[co_id]
                for vn in vendor_rows:
                    vn_id = str(vn["provider_id"])
                    step2 = _step_delay_days(co_id, vn, clean_ehr_wait, edge_stats)
                    if step2 is None:
                        continue
                    w2, rel2 = step2
                    total_days = w1 + w2
                    if total_days > 45:
                        continue
                    vn_km = dist_by_id[vn_id]
                    mobile_capable = (
                        bool(vn["mobile_visit_capable"])
                        if "mobile_visit_capable" in vn.index
                        else True
                    )
                    family_clinic_km = round(cl_km, 1)
                    max_fam_km = family_clinic_km if mobile_capable else round(max(cl_km, vn_km), 1)
                    path_nodes = [cl_id, co_id, vn_id]
                    holds_on_path = sum(int(node_tel[n].get("active_hold_count", 0)) for n in path_nodes)
                    max_util = max(float(node_tel[n].get("congestion_ratio", 0.0)) for n in path_nodes)
                    dom_matched = canonical_domain in clean_ehr_domains.get((co_id, vn_id), set())
                    obs_hops = int(
                        (rel1 == "observed_clean_corridor")
                        + (rel2 == "observed_clean_corridor")
                    )
                    corridors.append({
                        "hop_count": 2,
                        "clinic": cl,
                        "coord": co,
                        "eval_hub": None,
                        "vendor": vn,
                        "w1": w1,
                        "w2": w2,
                        "w3": 0,
                        "rel1": rel1,
                        "rel2": rel2,
                        "rel3": None,
                        "total_days": total_days,
                        "domain_matched": dom_matched,
                        "observed_corridor_hops": obs_hops,
                        "clinic_km": cl_km,
                        "coord_km": co_km,
                        "eval_km": 0.0,
                        "vendor_km": vn_km,
                        "eval_vendor_distance_km": round(vn_km, 2),
                        "family_clinic_travel_km": family_clinic_km,
                        "home_visit_vendor_distance_km": round(vn_km, 1),
                        "mobile_visit_capable": mobile_capable,
                        "max_family_km": max_fam_km,
                        "holds_on_path": holds_on_path,
                        "max_utilization_ratio": max_util,
                        "dedup_key": (co_id, vn_id, 2),
                        "nodes": path_nodes,
                    })

    # Prioritize domain-specialized corridor -> observed clean EHR hops DESC -> expected days ASC -> holds -> travel km ASC
    corridors.sort(
        key=lambda c: (
            not c["domain_matched"],
            -c["observed_corridor_hops"],
            c["total_days"],
            c["holds_on_path"] > 0,
            c["eval_vendor_distance_km"],
            c["max_utilization_ratio"],
            c["clinic_km"],
        )
    )
    return corridors


def _build_routing_gql_preview(
    dataset: str,
    needs_medicaid: bool,
    needs_bilingual: bool,
    tract_geoid: str = "",
    state_code: str = "",
) -> str:
    """Returns the concise BigQuery ISO GQL + SERVES_AREA query for <=45-day routing."""
    clean_ds = (
        dataset.strip()
        if re.fullmatch(r"[A-Za-z0-9_]+", dataset.strip())
        else "a4i_early_intervention"
    )
    clean_state = state_code.strip().upper() if state_code and state_code.strip().upper() in VALID_STATES else ""
    state_f = f" AND c.state_code='{clean_state}'" if clean_state else ""
    tract_f = f" AND n.tract_geoid='{tract_geoid}'" if re.fullmatch(r"\d{11}", tract_geoid) else ""
    med_f = " AND c.accepts_medicaid AND vn.accepts_medicaid" if needs_medicaid else ""
    bil_f = " AND vn.bilingual_services_listed" if needs_bilingual else ""
    hop_checks = [
        "COALESCE(e.target_congestion_ratio,0.0)<=1.0",
        "COALESCE(e.edge_bounce_rate,0.0)<=0.35",
        "COALESCE(e.target_outbound_bounce_rate,0.0)<=0.35",
    ]
    if needs_medicaid:
        hop_checks.append("e.target_accepts_medicaid=TRUE")
    if needs_bilingual:
        hop_checks.append("e.target_bilingual=TRUE")
    mid_hop_f = f" AND (SELECT LOGICAL_AND({' AND '.join(hop_checks)}) FROM UNNEST(h) e)"
    return f"""SELECT * FROM GRAPH_TABLE({clean_ds}.ReferralGraph
 MATCH (c:CareNode {{node_role:'Screening_Pediatric_Clinic'}})-[h:CAN_REFER_TO]->{{3,3}}
  (vn:CareNode {{node_role:'EI_Therapy_Vendor',part_c_vendor_enrolled:TRUE}})-[s:SERVES_AREA]->(n:Neighborhood)
 WHERE vn.active_waitlist_count<=vn.monthly_slot_capacity{state_f}{tract_f}{med_f}{bil_f}{mid_hop_f}
 LET expected_days=h[OFFSET(0)].expected_step_days+h[OFFSET(1)].expected_step_days+h[OFFSET(2)].expected_step_days
 FILTER expected_days<=45
 RETURN c.provider_id AS clinic_id, h[OFFSET(0)].target_provider_id AS coord_id,
  h[OFFSET(1)].target_provider_id AS eval_id, vn.provider_id AS vendor_id,
  expected_days, ROUND(s.travel_distance_km,1) AS vendor_km
) ORDER BY expected_days, vendor_km LIMIT 3;""".strip()


def find_compliant_45d_pathways(
    child_tract_geoid: str = "",
    child_age_months: int = 22,
    concern_domain: str = "Expressive Speech/Language",
    needs_medicaid: bool = True,
    needs_bilingual: bool = True,
    has_household_vehicle: bool = False,
    prior_diagnostic_completed: bool = False,
    max_travel_km: float = 65.0,
    max_bounce_rate: float = 0.25,
) -> dict[str, Any]:
    """Finds <=45-day IDEA Part C compliant multi-hop referral pathways for an incoming child.

    Evaluates stage-valid 3-hop `Clinic -> Part_C_Intake_Coordinator ->
    Multidisciplinary_Eval_Hub -> EI_Therapy_Vendor` pathways (plus 2-hop fast-track
    paths when `prior_diagnostic_completed=True`), enforcing Day-0 referral-transmission
    delay math (`34 CFR § 303.310`), slot-congestion & bounce-trap pruning, statutory
    `0-35` month eligibility (`34 CFR § 303.21`), and active-state location validation.
    Never touches `audit_*` demographic columns or `limited_english_rate`.
    """
    cfg = get_config()
    frames = load_local_state_frames(cfg["state"])
    demo = frames["demo"]
    prov = frames["providers"]
    logs = frames["logs"]

    resolved, err_payload = _validate_and_resolve_common_inputs(
        raw_location=child_tract_geoid,
        child_age_months=child_age_months,
        max_bounce_rate=max_bounce_rate,
        max_travel_km=max_travel_km,
        demo=demo,
        state_code=cfg["state"],
    )
    if err_payload is not None:
        return err_payload
    assert resolved is not None

    age_m = resolved["age_m"]
    age_info = resolved["age_info"]
    age_float = float(age_info["age_float"])
    clean_max_bounce = float(resolved["max_bounce"])
    clean_max_km = float(resolved["max_travel_km"])
    tract_row = resolved["tract_row"]
    tract_resolution = str(resolved["tract_resolution"])

    med_req = True if needs_medicaid is None else bool(needs_medicaid)
    bil_req = True if needs_bilingual is None else bool(needs_bilingual)
    veh_avail = False if has_household_vehicle is None else bool(has_household_vehicle)
    prior_diag = False if prior_diagnostic_completed is None else bool(prior_diagnostic_completed)
    domain_clean = (
        "Expressive Speech/Language"
        if not concern_domain
        else str(concern_domain).strip()
    )
    canonical_domain = _normalize_concern_domain(domain_clean)

    home_tract = str(tract_row["census_tract_geoid"])
    home_lat = float(tract_row["latitude"])
    home_lon = float(tract_row["longitude"])
    tract_poverty_pct = round(float(tract_row["poverty_rate"]) * 100.0, 1)
    tract_no_veh_pct = round(float(tract_row["no_vehicle_rate"]) * 100.0, 1)

    clean_state = cfg["state"] if cfg["state"] in VALID_STATES else "MS"
    gql_preview = _build_routing_gql_preview(
        cfg["dataset"], med_req, bil_req, home_tract, state_code=clean_state
    )
    bq_probe_rows = graph_client.query_bq_or_none(
        f"""
        SELECT chain_id, total_hops, chain_wait_days
        FROM GRAPH_TABLE(
          {cfg['dataset']}.ReferralGraph
          MATCH (c:CareNode {{node_role: 'Screening_Pediatric_Clinic'}})
                -[hops:ReferralHandoff]->{{2,4}}
                (v:CareNode {{node_role: 'EI_Therapy_Vendor'}})
          WHERE c.state_code = '{clean_state}'
            AND hops[OFFSET(0)].hop_sequence = 1
            AND (SELECT COUNT(DISTINCT h.case_chain_id) FROM UNNEST(hops) AS h) = 1
          LET chain_id = hops[OFFSET(0)].case_chain_id,
              total_hops = ARRAY_LENGTH(hops),
              chain_wait_days = (SELECT SUM(h.handoff_wait_days) FROM UNNEST(hops) AS h)
          RETURN chain_id, total_hops, chain_wait_days
        )
        QUALIFY ROW_NUMBER() OVER (PARTITION BY chain_id ORDER BY total_hops DESC) = 1
        """
    )
    active_ds = graph_client.get_last_resolved_dataset(cfg) if bq_probe_rows is not None else cfg["dataset"]
    gql_preview = rewrite_sql_dataset(gql_preview, cfg["dataset"], active_ds)
    engine = (
        f"bigquery_property_graph_iso_gql ({cfg['project']}.{active_ds}.ReferralGraph)"
        if bq_probe_rows is not None
        else f"local_geoparquet_mirror ({cfg['state']} starter tables)"
    )

    prov_by_id = {str(r["provider_id"]): r for _, r in prov.iterrows()}

    # 1. Identify nearest cautionary historical >45-day 4-hop bounce chain for comparison
    chain_groups = []
    for cid, grp in logs.groupby("case_chain_id"):
        grp_s = grp.sort_values("hop_sequence")
        total_w = int(grp_s["handoff_wait_days"].sum())
        if total_w > 45 and len(grp_s) >= 4:
            c_tract = str(grp_s.iloc[0]["child_home_tract_geoid"])
            t_match = demo[demo["census_tract_geoid"] == c_tract]
            dist_to_case = (
                haversine_km(
                    home_lat,
                    home_lon,
                    float(t_match.iloc[0]["latitude"]),
                    float(t_match.iloc[0]["longitude"]),
                )
                if not t_match.empty
                else 50.0
            )
            same_tract_bonus = -1000.0 if c_tract == home_tract else 0.0
            domain_bonus = (
                -150.0
                if canonical_domain.lower() == str(grp_s.iloc[0]["concern_domain"]).lower()
                else 0.0
            )
            age_diff = abs(int(grp_s.iloc[0]["child_age_months"]) - age_float)
            chain_groups.append((same_tract_bonus + domain_bonus + dist_to_case + age_diff, cid, grp_s))

    chain_groups.sort(key=lambda x: x[0])
    cautionary_chain = None
    if chain_groups:
        _, bad_cid, bad_grp = chain_groups[0]
        cum_bad = 0
        bad_hops = []
        for idx_h, (_, h) in enumerate(bad_grp.iterrows()):
            src = prov_by_id[str(h["source_provider_id"])]
            dst = prov_by_id[str(h["target_provider_id"])]
            w = int(h["handoff_wait_days"])
            cum_bad += w
            reason_str = str(h["handoff_reason"])
            is_b = reason_str.startswith("Re-Referral Bounce")
            hop_item: dict[str, Any] = {
                "hop_sequence": int(h["hop_sequence"]),
                "source_provider_id": str(h["source_provider_id"]),
                "target_provider_id": str(h["target_provider_id"]),
                "target_name": str(dst["synthetic_organization_name"]),
                "target_role": str(dst["node_role"]),
                "transmission_channel": str(h["transmission_channel"]),
                "handoff_wait_days": w,
                "cumulative_wait_days": cum_bad,
                "is_bounce_hop": is_b,
            }
            if is_b:
                hop_item["handoff_reason"] = reason_str
            if idx_h == 0:
                hop_item["source_name"] = str(src["synthetic_organization_name"])
                hop_item["source_role"] = str(src["node_role"])
            bad_hops.append(hop_item)
        cautionary_chain = {
            "case_chain_id": str(bad_cid),
            "total_hops": len(bad_hops),
            "total_wait_days": cum_bad,
            "days_over_45d_limit": cum_bad - 45,
            "paper_fax_hops": sum(1 for x in bad_hops if x["transmission_channel"] == "paper_fax"),
            "hops": bad_hops,
        }

    # 2. Evaluate stage-valid, congestion-pruned, hold-aware, bounce-pruned <=45-day corridors
    telemetry = _compute_network_telemetry(prov, logs, clean_max_bounce, state_code=cfg["state"])
    node_tel = telemetry["node_telemetry"]
    corridors = _evaluate_candidate_corridors(
        prov=prov,
        telemetry=telemetry,
        home_lat=home_lat,
        home_lon=home_lon,
        canonical_domain=canonical_domain,
        needs_medicaid=med_req,
        needs_bilingual=bil_req,
        prior_diagnostic_completed=prior_diag,
    )

    seen_keys: set[tuple[str, str, int]] = set()
    top_corridors: list[dict[str, Any]] = []
    for c in corridors:
        if c["dedup_key"] in seen_keys:
            continue
        seen_keys.add(c["dedup_key"])
        top_corridors.append(c)
        if len(top_corridors) >= 3:
            break

    def _format_full_pathway(c: dict[str, Any]) -> dict[str, Any]:
        cl = c["clinic"]
        co = c["coord"]
        ev = c["eval_hub"]
        vn = c["vendor"]
        cl_id = str(cl["provider_id"])
        co_id = str(co["provider_id"])
        vn_id = str(vn["provider_id"])
        w1, w2, w3 = int(c["w1"]), int(c["w2"]), int(c["w3"])
        total_days = int(c["total_days"])
        mean_km = round(float(c["eval_vendor_distance_km"]), 1)
        max_fam_km = float(c["max_family_km"])
        fam_clinic_km = float(c["family_clinic_travel_km"])
        home_vendor_km = float(c["home_visit_vendor_distance_km"])
        mobile_capable = bool(c["mobile_visit_capable"])
        holds_on_path = int(c.get("holds_on_path", 0))
        max_util = float(c.get("max_utilization_ratio", 0.0))
        est_age_path = round(age_float + total_days / 30.44, 1)
        clears_before_age_3 = est_age_path < 36.0
        clears_clock = (total_days <= 45) and clears_before_age_3
        rank_score = round(
            total_days
            + (0.0 if c["domain_matched"] else 15.0)
            - (2.0 * c["observed_corridor_hops"])
            + 0.25 * mean_km
            + (2.0 * holds_on_path),
            2,
        )
        if c["hop_count"] == 3 and ev is not None:
            ev_id = str(ev["provider_id"])
            hops = [
                {
                    "hop_sequence": 1,
                    "source_provider_id": cl_id,
                    "source_name": str(cl["synthetic_organization_name"]),
                    "source_role": "Screening_Pediatric_Clinic",
                    "target_provider_id": co_id,
                    "target_name": str(co["synthetic_organization_name"]),
                    "target_role": "Part_C_Intake_Coordinator",
                    "transmission_channel": "ehr_electronic_portal",
                    "relationship_type": c["rel1"],
                    "handoff_wait_days": w1,
                    "cumulative_wait_days": w1,
                    "distance_from_home_km": c["coord_km"],
                },
                {
                    "hop_sequence": 2,
                    "source_provider_id": co_id,
                    "target_provider_id": ev_id,
                    "target_name": str(ev["synthetic_organization_name"]),
                    "target_role": "Multidisciplinary_Eval_Hub",
                    "transmission_channel": "ehr_electronic_portal",
                    "relationship_type": c["rel2"],
                    "handoff_wait_days": w2,
                    "cumulative_wait_days": w1 + w2,
                    "distance_from_home_km": c["eval_km"],
                },
                {
                    "hop_sequence": 3,
                    "source_provider_id": ev_id,
                    "target_provider_id": vn_id,
                    "target_name": str(vn["synthetic_organization_name"]),
                    "target_role": "EI_Therapy_Vendor",
                    "transmission_channel": "ehr_electronic_portal",
                    "relationship_type": c["rel3"],
                    "handoff_wait_days": w3,
                    "cumulative_wait_days": total_days,
                    "distance_from_home_km": c["vendor_km"],
                },
            ]
            p_type = "3-Hop Evaluation + IFSP Route"
        else:
            hops = [
                {
                    "hop_sequence": 1,
                    "source_provider_id": cl_id,
                    "source_name": str(cl["synthetic_organization_name"]),
                    "source_role": "Screening_Pediatric_Clinic",
                    "target_provider_id": co_id,
                    "target_name": str(co["synthetic_organization_name"]),
                    "target_role": "Part_C_Intake_Coordinator",
                    "transmission_channel": "ehr_electronic_portal",
                    "relationship_type": c["rel1"],
                    "handoff_wait_days": w1,
                    "cumulative_wait_days": w1,
                    "distance_from_home_km": c["coord_km"],
                },
                {
                    "hop_sequence": 2,
                    "source_provider_id": co_id,
                    "target_provider_id": vn_id,
                    "target_name": str(vn["synthetic_organization_name"]),
                    "target_role": "EI_Therapy_Vendor",
                    "transmission_channel": "ehr_electronic_portal",
                    "relationship_type": c["rel2"],
                    "handoff_wait_days": w2,
                    "cumulative_wait_days": total_days,
                    "distance_from_home_km": c["vendor_km"],
                },
            ]
            p_type = "2-Hop Fast-Track IFSP Route"

        if not clears_before_age_3:
            p_type = f"{p_type} — Dual Part C / LEA Part B 619 Handoff (Reaches 36m Before IFSP)"

        return {
            "pathway_type": p_type,
            "rank_score": rank_score,
            "total_hops": int(c["hop_count"]),
            "expected_cumulative_days": total_days,
            "statutory_45d_headroom_days": 45 - total_days,
            "clears_45_day_clock": clears_clock,
            "clears_part_c_before_age_3": clears_before_age_3,
            "timely_part_c_ifsp_feasible": clears_clock,
            "requires_dual_lea_part_b_handoff": bool(age_info["dual_lea_handoff_required"] or not clears_before_age_3),
            "domain_matched": bool(c["domain_matched"]),
            "observed_corridor_hops": int(c["observed_corridor_hops"]),
            "within_preferred_travel_km": fam_clinic_km <= clean_max_km,
            "eval_vendor_distance_km": mean_km,
            "eval_hub_distance_km": round(float(c["eval_km"]), 1),
            "therapy_vendor_distance_km": home_vendor_km,
            "family_clinic_travel_km": fam_clinic_km,
            "home_visit_vendor_distance_km": home_vendor_km,
            "mobile_visit_capable": mobile_capable,
            "natural_environment_home_visit": mobile_capable,
            "max_family_travel_km": max_fam_km,
            "active_holds_on_path": holds_on_path,
            "max_node_utilization_ratio": max_util,
            "all_nodes_medicaid_enrolled": True if med_req else None,
            "all_care_nodes_bilingual": True if bil_req else None,
            "nodes": c["nodes"],
            "hops": hops,
        }

    def _format_compact_alternative(c: dict[str, Any]) -> dict[str, Any]:
        total_days = int(c["total_days"])
        mean_km = round(float(c["eval_vendor_distance_km"]), 1)
        est_age_alt = round(age_float + total_days / 30.44, 1)
        clears_alt = (total_days <= 45) and (est_age_alt < 36.0)
        step_days = [int(c["w1"]), int(c["w2"])] + ([int(c["w3"])] if c["hop_count"] == 3 else [])
        return {
            "total_hops": int(c["hop_count"]),
            "expected_cumulative_days": total_days,
            "clears_45_day_clock": clears_alt,
            "clears_part_c_before_age_3": est_age_alt < 36.0,
            "domain_matched": bool(c["domain_matched"]),
            "observed_corridor_hops": int(c["observed_corridor_hops"]),
            "eval_vendor_distance_km": mean_km,
            "family_clinic_travel_km": float(c["family_clinic_travel_km"]),
            "home_visit_vendor_distance_km": float(c["home_visit_vendor_distance_km"]),
            "nodes": c["nodes"],
            "step_days": step_days,
        }

    recommended = _format_full_pathway(top_corridors[0]) if top_corridors else None
    alternatives = [_format_compact_alternative(c) for c in top_corridors[1:3]]

    # 3. Guardrail alerts: 5-Tier 34 CFR § 303.209 Statutory Transition + Zero-Vehicle Mobility Support
    guardrail_alerts: list[dict[str, str]] = []
    est_age_recommended = (
        round(age_float + recommended["expected_cumulative_days"] / 30.44, 1)
        if recommended
        else round(age_float + 1.5, 1)
    )
    est_age_bounce = (
        round(age_float + cautionary_chain["total_wait_days"] / 30.44, 1)
        if cautionary_chain
        else None
    )

    guardrail_alerts.extend(
        _build_age_transition_alerts(
            age_info,
            est_age_recommended=est_age_recommended,
            est_age_bounce=est_age_bounce,
            cautionary_wait_days=(cautionary_chain["total_wait_days"] if cautionary_chain else None),
        )
    )

    if recommended and (
        not veh_avail
        or tract_no_veh_pct >= 10.0
        or recommended["family_clinic_travel_km"] > 25.0
    ):
        guardrail_alerts.append({
            "code": "ZERO_VEHICLE_MOBILITY_SUPPORT",
            "severity": "MEDIUM",
            "message": (
                f"Tract {home_tract} zero-vehicle={tract_no_veh_pct}%, "
                f"clinic/eval travel={recommended['family_clinic_travel_km']} km "
                f"(home-visit vendor={recommended['home_visit_vendor_distance_km']} km via 34 CFR § 303.126); "
                "authorize Medicaid NEMT or home/mobile evaluation."
            ),
        })

    child_profile_payload: dict[str, Any] = {
        "state_code": cfg["state"],
        "home_tract_geoid": home_tract,
        "county_name": str(tract_row["county_name"]),
        "tract_children_under_5": int(tract_row["children_under_5_count"]),
        "tract_poverty_pct": tract_poverty_pct,
        "tract_zero_vehicle_pct": tract_no_veh_pct,
        "child_age_months": int(age_m),
        "concern_domain": domain_clean,
        "needs_medicaid": med_req,
        "needs_bilingual": bil_req,
        "has_household_vehicle": veh_avail,
        "est_age_at_ifsp_recommended_months": est_age_recommended,
        "est_age_at_ifsp_if_bounced_months": est_age_bounce,
        "statutory_transition_tier": age_info["statutory_transition_tier"],
    }
    if isinstance(age_m, float):
        child_profile_payload["child_age_exact_months"] = age_m

    return {
        "status": "ok",
        "tract_resolution": tract_resolution,
        "execution_engine": engine,
        "synthetic_provenance_notice": _SYNTHETIC_NOTICE,
        "bias_firewall_verified": "audit_* & limited_english_rate excluded.",
        "iso_gql_query": gql_preview,
        "statutory_transition_tier": age_info["statutory_transition_tier"],
        "days_until_age_3": age_info["days_until_age_3"],
        "effective_deadline_days": age_info["effective_deadline_days"],
        "dual_lea_handoff_required": bool(
            age_info["dual_lea_handoff_required"] or (est_age_recommended >= 36.0)
        ),
        "active_slot_holds_in_state": int(telemetry["active_slot_holds_total"]),
        "child_profile": child_profile_payload,
        "recommended_pathway": recommended,
        "alternative_compliant_pathways": alternatives,
        "cautionary_historical_bounce_chain": cautionary_chain,
        "days_saved_vs_bounce_loop": (
            cautionary_chain["total_wait_days"] - recommended["expected_cumulative_days"]
            if (cautionary_chain and recommended)
            else None
        ),
        "guardrail_alerts": guardrail_alerts,
    }


def _build_viable_45d_paths_gql(
    dataset: str,
    tract_geoid: str,
    needs_medicaid: bool,
    needs_bilingual: bool,
    max_bounce_rate: float,
    state_code: str = "",
    prior_diagnostic_completed: bool = False,
    concern_domain: str = "",
) -> str:
    """Returns a concise ISO/IEC 39075 GQL GRAPH_TABLE query for <=45-day viable paths.

    Combines `CAN_REFER_TO` stage-valid capability traversal + downstream `SERVES_AREA`
    spatial proximity (with `ST_DISTANCE` statewide mobile/telehealth fallback for rural
    tracts >80 km) and `REFERS_TO` historical bounce-source pruning, enforcing Day-0
    referral transmission delay (`expected_step_days`, `34 CFR § 303.310`) <= 45d.
    """
    clean_dataset = (
        dataset.strip()
        if re.fullmatch(r"[A-Za-z0-9_]+", dataset.strip())
        else "a4i_early_intervention"
    )
    raw_tract = tract_geoid.strip() if tract_geoid else ""
    clean_tract = raw_tract.zfill(11) if re.fullmatch(r"\d{10,11}", raw_tract) else ""
    raw_state = state_code.strip().upper() if state_code else ""
    clean_state = raw_state if raw_state in VALID_STATES else ""
    max_bounce = max(0.0, min(float(max_bounce_rate), 1.0))
    eff_bounce = 0.0 if max_bounce <= 0.0 else min(max_bounce, 0.35)
    min_hops = 2 if prior_diagnostic_completed else 3
    safe_dom = re.sub(r"[^A-Za-z0-9 /_-]", "", concern_domain or "Expressive Speech/Language")

    bs_where = (
        f"WHERE u.state_code='{clean_state}' AND u.node_role!='Screening_Pediatric_Clinic'"
        if clean_state
        else "WHERE u.node_role!='Screening_Pediatric_Clinic'"
    )
    bs_having = "AVG(b)>0.0" if eff_bounce <= 0.0 else f"AVG(b)>{eff_bounce:.4f}"

    t_clauses = [c for c in (
        f"n.tract_geoid='{clean_tract}'" if clean_tract else "",
        f"n.state_code='{clean_state}'" if clean_state else "",
    ) if c]
    tract_where = " AND ".join(t_clauses) if t_clauses else "TRUE"

    hop_checks = ["COALESCE(e.target_congestion_ratio,0.0)<=1.0"]
    hop_checks.append(
        "COALESCE(e.edge_bounce_rate,0.0)=0.0"
        if eff_bounce <= 0.0
        else f"COALESCE(e.edge_bounce_rate,0.0)<={eff_bounce:.4f}"
    )
    hop_checks.append(
        "COALESCE(e.target_outbound_bounce_rate,0.0)=0.0"
        if eff_bounce <= 0.0
        else f"COALESCE(e.target_outbound_bounce_rate,0.0)<={eff_bounce:.4f}"
    )
    if needs_medicaid:
        hop_checks.append("e.target_accepts_medicaid=TRUE")
    if needs_bilingual:
        hop_checks.append("e.target_bilingual=TRUE")

    c_clauses = []
    if clean_state:
        c_clauses.append(f"c.state_code='{clean_state}'")
    c_clauses.append("v.active_waitlist_count<=v.monthly_slot_capacity")
    if needs_medicaid:
        c_clauses.append("c.accepts_medicaid AND v.accepts_medicaid")
    if needs_bilingual:
        c_clauses.append("v.bilingual_services_listed")
    c_clauses.append(f"(SELECT LOGICAL_AND({' AND '.join(hop_checks)}) FROM UNNEST(h) e)")
    corridor_where = " AND ".join(c_clauses)

    return f"""WITH bs AS (SELECT s FROM GRAPH_TABLE({clean_dataset}.ReferralGraph
 MATCH (u:CareNode)-[r:REFERS_TO]->(:CareNode) {bs_where} RETURN u.provider_id AS s, r.bounce_flag AS b)
 GROUP BY s HAVING {bs_having}),
tt AS (SELECT * FROM GRAPH_TABLE({clean_dataset}.ReferralGraph
 MATCH (n:Neighborhood) WHERE {tract_where}
 RETURN n.tract_geoid, n.latitude AS t_lat, n.longitude AS t_lon) LIMIT 1),
sa AS (SELECT * FROM GRAPH_TABLE({clean_dataset}.ReferralGraph
 MATCH (v:CareNode {{node_role:'EI_Therapy_Vendor'}})-[s:SERVES_AREA]->(n:Neighborhood) WHERE {tract_where}
 RETURN v.provider_id AS vid, s.travel_distance_km AS skm)),
cr AS (SELECT * FROM GRAPH_TABLE({clean_dataset}.ReferralGraph
 MATCH (c:CareNode {{node_role:'Screening_Pediatric_Clinic'}})-[h:CAN_REFER_TO]->{{{min_hops},3}}
  (v:CareNode {{node_role:'EI_Therapy_Vendor',part_c_vendor_enrolled:TRUE}}) WHERE {corridor_where}
 LET d0=h[OFFSET(0)].expected_step_days,d1=h[OFFSET(1)].expected_step_days,
  d2=IF(ARRAY_LENGTH(h)=3,h[OFFSET(2)].expected_step_days,0),
  obs=(SELECT COUNTIF(e.relationship_type='observed_clean_corridor') FROM UNNEST(h) e),
  dom=(SELECT LOGICAL_OR(e.domain_specialization='{safe_dom}') FROM UNNEST(h) e),
  mid=IF(ARRAY_LENGTH(h)=3,h[OFFSET(1)].target_provider_id,h[OFFSET(0)].target_provider_id),
  nodes=ARRAY_CONCAT([c.provider_id],ARRAY(SELECT e.target_provider_id FROM UNNEST(h) e WITH OFFSET i ORDER BY i))
 FILTER d0+d1+d2<=45
 RETURN c.provider_id AS start_provider_id,c.synthetic_organization_name AS start_name,
  v.provider_id AS eval_provider_id,v.synthetic_organization_name AS eval_name,v.node_role AS eval_role,
  v.latitude AS v_lat,v.longitude AS v_lon,ARRAY_LENGTH(h) AS hop_count,
  d0 AS intake_lag_days,d1 AS handoff_days,d2 AS evaluator_backlog_days,
  d0+d1+d2 AS total_expected_days,v.accepts_medicaid,v.bilingual_services_listed,
  dom AS domain_matched,obs AS observed_corridor_hops,mid,nodes
) WHERE NOT EXISTS (SELECT 1 FROM UNNEST(nodes) x JOIN bs ON x=bs.s))
SELECT tt.tract_geoid,cr.start_provider_id,cr.start_name,cr.eval_provider_id,cr.eval_name,cr.eval_role,
 cr.hop_count,cr.intake_lag_days,cr.handoff_days,cr.evaluator_backlog_days,cr.total_expected_days,
 COALESCE(sa.skm,ROUND(ST_DISTANCE(ST_GEOGPOINT(cr.v_lon,cr.v_lat),ST_GEOGPOINT(tt.t_lon,tt.t_lat))/1000.0,1)) AS distance_km,
 cr.accepts_medicaid,cr.bilingual_services_listed,cr.domain_matched,cr.observed_corridor_hops,cr.nodes
FROM cr CROSS JOIN tt LEFT JOIN sa ON cr.eval_provider_id=sa.vid
QUALIFY ROW_NUMBER() OVER (PARTITION BY cr.mid,cr.eval_provider_id,cr.hop_count
 ORDER BY cr.domain_matched DESC,cr.observed_corridor_hops DESC,cr.total_expected_days,distance_km)=1
ORDER BY cr.domain_matched DESC,cr.observed_corridor_hops DESC,cr.total_expected_days,distance_km LIMIT 3;""".strip()


def find_viable_45d_paths(
    zip_or_tract: str = "",
    languages: str = "Spanish",
    insurance: str = "Medicaid",
    specialty: str = "Speech",
    child_age_months: int = 22,
    has_household_vehicle: bool = False,
    max_bounce_rate: float = 0.25,
    prior_diagnostic_completed: bool = False,
    max_travel_km: float = 65.0,
) -> dict[str, Any]:
    """Finds viable <=45-day IDEA Part C referral paths with congestion & bounce pruning.

    Validates IDEA Part C statutory age (`0-35` months, `34 CFR § 303.21`) and active-state
    11-digit Census tract GEOID or 5-digit county FIPS, parses insurance/language with
    negation safety, executes or mirrors the ISO/IEC 39075 GQL `CAN_REFER_TO` + `REFERS_TO`
    traversal over `ReferralGraph`, prunes congested (`congestion_ratio > 1.0`) and
    high-bounce (`outbound_bounce_rate > max_bounce_rate`) nodes, and prioritizes
    domain-specialized observed clean EHR corridors. Never uses `audit_*` or
    `limited_english_rate`.
    """
    cfg = get_config()
    frames = load_local_state_frames(cfg["state"])
    demo = frames["demo"]
    prov = frames["providers"]
    logs = frames["logs"]

    resolved, err_payload = _validate_and_resolve_common_inputs(
        raw_location=zip_or_tract,
        child_age_months=child_age_months,
        max_bounce_rate=max_bounce_rate,
        max_travel_km=max_travel_km,
        demo=demo,
        state_code=cfg["state"],
    )
    if err_payload is not None:
        return err_payload
    assert resolved is not None

    age_m = resolved["age_m"]
    age_info = resolved["age_info"]
    age_float = float(age_info["age_float"])
    max_bounce = float(resolved["max_bounce"])
    clean_max_km = float(resolved["max_travel_km"])
    raw_loc = str(resolved["raw_loc"])
    tract_row = resolved["tract_row"]
    tract_resolution = str(resolved["tract_resolution"])

    ins_clean, needs_medicaid = _parse_insurance_medicaid(insurance)
    lang_clean, needs_bilingual, lang_alert = _parse_language_bilingual(languages)
    spec_clean = "Speech" if specialty is None or not str(specialty).strip() else str(specialty).strip()
    canonical_domain = _normalize_concern_domain(spec_clean)
    veh_avail = False if has_household_vehicle is None else bool(has_household_vehicle)
    prior_diag = False if prior_diagnostic_completed is None else bool(prior_diagnostic_completed)

    home_tract = str(tract_row["census_tract_geoid"])
    home_lat = float(tract_row["latitude"])
    home_lon = float(tract_row["longitude"])
    tract_poverty_pct = round(float(tract_row["poverty_rate"]) * 100.0, 1)
    tract_no_veh_pct = round(float(tract_row["no_vehicle_rate"]) * 100.0, 1)

    tract_context = {
        "state_code": cfg["state"],
        "census_tract_geoid": home_tract,
        "tract_resolution": tract_resolution,
        "county_fips": str(tract_row["county_fips"]),
        "county_name": str(tract_row["county_name"]),
        "children_under_5_count": int(tract_row["children_under_5_count"]),
        "poverty_pct": tract_poverty_pct,
        "no_vehicle_pct": tract_no_veh_pct,
        "latitude": home_lat,
        "longitude": home_lon,
    }

    gql_query = _build_viable_45d_paths_gql(
        dataset=cfg["dataset"],
        tract_geoid=home_tract,
        needs_medicaid=needs_medicaid,
        needs_bilingual=needs_bilingual,
        max_bounce_rate=max_bounce,
        state_code=cfg["state"],
        prior_diagnostic_completed=prior_diag,
        concern_domain=canonical_domain,
    )
    bq_rows = graph_client.query_bq_or_none(gql_query)
    active_ds = graph_client.get_last_resolved_dataset(cfg) if bq_rows is not None else cfg["dataset"]
    gql_query = rewrite_sql_dataset(gql_query, cfg["dataset"], active_ds)
    engine = (
        f"bigquery_property_graph_iso_gql ({cfg['project']}.{active_ds}.ReferralGraph)"
        if bq_rows is not None
        else f"local_geoparquet_mirror ({cfg['state']} starter tables)"
    )

    telemetry = _compute_network_telemetry(prov, logs, max_bounce, state_code=cfg["state"])
    node_tel = telemetry["node_telemetry"]
    pruned_high_bounce_edges_count = int(telemetry["pruned_high_bounce_edges_count"])
    pruned_nodes_count = int(telemetry["pruned_nodes_count"])
    prov_by_id = {str(r["provider_id"]): r for _, r in prov.iterrows()}

    viable_paths: list[dict[str, Any]] = []
    if bq_rows is not None:
        for row in bq_rows:
            total_days = int(row["total_expected_days"])
            if total_days <= 45:
                st_id = str(row["start_provider_id"])
                ev_id = str(row["eval_provider_id"])
                ev_meta = prov_by_id.get(ev_id)
                raw_nodes = row.get("nodes")
                node_list = (
                    [str(n_id) for n_id in raw_nodes]
                    if isinstance(raw_nodes, (list, tuple)) and len(raw_nodes) >= 2
                    else [st_id, ev_id]
                )
                if any(
                    node_tel.get(nid, {}).get("active_hold_count", 0) > 0
                    and node_tel.get(nid, {}).get("congestion_ratio", 0.0) > 1.0
                    for nid in node_list
                ):
                    continue

                if row.get("distance_km") is not None:
                    dist_km = round(float(row["distance_km"]), 2)
                elif ev_meta is not None:
                    dist_km = round(
                        haversine_km(
                            home_lat,
                            home_lon,
                            float(ev_meta["latitude"]),
                            float(ev_meta["longitude"]),
                        ),
                        2,
                    )
                else:
                    dist_km = 0.0

                acc_med = (
                    bool(row["accepts_medicaid"])
                    if row.get("accepts_medicaid") is not None
                    else (bool(ev_meta["accepts_medicaid"]) if ev_meta is not None else bool(needs_medicaid))
                )
                bil_listed = (
                    bool(row["bilingual_services_listed"])
                    if row.get("bilingual_services_listed") is not None
                    else (bool(ev_meta["bilingual_services_listed"]) if ev_meta is not None else bool(needs_bilingual))
                )
                est_age_path = round(age_float + total_days / 30.44, 1)
                clears_before_age_3 = est_age_path < 36.0
                holds_on_path = sum(int(node_tel.get(nid, {}).get("active_hold_count", 0)) for nid in node_list)
                max_util = max((float(node_tel.get(nid, {}).get("congestion_ratio", 0.0)) for nid in node_list), default=0.0)
                eval_hub_km = dist_km
                if len(node_list) >= 4 and node_list[2] in prov_by_id:
                    hub_meta = prov_by_id[node_list[2]]
                    eval_hub_km = round(
                        haversine_km(home_lat, home_lon, float(hub_meta["latitude"]), float(hub_meta["longitude"])),
                        1,
                    )

                viable_paths.append({
                    "tract_geoid": (
                        str(row["tract_geoid"]).strip().zfill(11)
                        if row.get("tract_geoid")
                        else home_tract
                    ),
                    "start_provider_id": st_id,
                    "start_name": str(row["start_name"]),
                    "eval_provider_id": ev_id,
                    "eval_name": str(row["eval_name"]),
                    "eval_role": str(row["eval_role"]),
                    "hop_count": int(row["hop_count"]),
                    "intake_lag_days": int(row["intake_lag_days"]),
                    "handoff_days": int(row["handoff_days"]),
                    "evaluator_backlog_days": int(row["evaluator_backlog_days"]),
                    "total_expected_days": total_days,
                    "clears_45d_clock": (total_days <= 45) and clears_before_age_3,
                    "clears_part_c_before_age_3": clears_before_age_3,
                    "distance_km": dist_km,
                    "family_clinic_travel_km": eval_hub_km,
                    "home_visit_vendor_distance_km": round(dist_km, 1),
                    "natural_environment_home_visit": True,
                    "active_holds_on_path": holds_on_path,
                    "max_node_utilization_ratio": max_util,
                    "within_preferred_travel_km": eval_hub_km <= clean_max_km,
                    "accepts_medicaid": acc_med,
                    "bilingual_services_listed": bil_listed,
                    "domain_matched": bool(row.get("domain_matched", True)),
                    "observed_corridor_hops": int(row.get("observed_corridor_hops", int(row["hop_count"]))),
                    "relationship_type": (
                        "observed_clean_corridor"
                        if int(row.get("observed_corridor_hops", int(row["hop_count"]))) == int(row["hop_count"])
                        else "prospective_capability"
                    ),
                    "specialty_requested": spec_clean,
                    "nodes": node_list,
                })
                if len(viable_paths) >= 3:
                    break
    else:
        corridors = _evaluate_candidate_corridors(
            prov=prov,
            telemetry=telemetry,
            home_lat=home_lat,
            home_lon=home_lon,
            canonical_domain=canonical_domain,
            needs_medicaid=needs_medicaid,
            needs_bilingual=needs_bilingual,
            prior_diagnostic_completed=prior_diag,
        )
        seen_keys: set[tuple[str, str, int]] = set()
        for c in corridors:
            if c["dedup_key"] in seen_keys:
                continue
            seen_keys.add(c["dedup_key"])
            cl = c["clinic"]
            co = c["coord"]
            ev = c["eval_hub"]
            vn = c["vendor"]
            total_days = int(c["total_days"])
            est_age_path = round(age_float + total_days / 30.44, 1)
            clears_before_age_3 = est_age_path < 36.0
            acc_med = bool(
                co["accepts_medicaid"]
                and vn["accepts_medicaid"]
                and (ev["accepts_medicaid"] if ev is not None else True)
            )
            bil_listed = bool(
                co["bilingual_services_listed"]
                and vn["bilingual_services_listed"]
                and (ev["bilingual_services_listed"] if ev is not None else True)
            )
            viable_paths.append({
                "tract_geoid": home_tract,
                "start_provider_id": str(cl["provider_id"]),
                "start_name": str(cl["synthetic_organization_name"]),
                "eval_provider_id": str(vn["provider_id"]),
                "eval_name": str(vn["synthetic_organization_name"]),
                "eval_role": str(vn["node_role"]),
                "hop_count": int(c["hop_count"]),
                "intake_lag_days": int(c["w1"]),
                "handoff_days": int(c["w2"]),
                "evaluator_backlog_days": int(c["w3"]),
                "total_expected_days": total_days,
                "clears_45d_clock": (total_days <= 45) and clears_before_age_3,
                "clears_part_c_before_age_3": clears_before_age_3,
                "distance_km": float(c["eval_vendor_distance_km"]),
                "family_clinic_travel_km": float(c["family_clinic_travel_km"]),
                "home_visit_vendor_distance_km": float(c["home_visit_vendor_distance_km"]),
                "natural_environment_home_visit": bool(c["mobile_visit_capable"]),
                "active_holds_on_path": int(c["holds_on_path"]),
                "max_node_utilization_ratio": float(c["max_utilization_ratio"]),
                "within_preferred_travel_km": float(c["family_clinic_travel_km"]) <= clean_max_km,
                "accepts_medicaid": acc_med,
                "bilingual_services_listed": bil_listed,
                "domain_matched": bool(c["domain_matched"]),
                "observed_corridor_hops": int(c["observed_corridor_hops"]),
                "relationship_type": (
                    "observed_clean_corridor"
                    if int(c["observed_corridor_hops"]) == int(c["hop_count"])
                    else "prospective_capability"
                ),
                "nodes": c["nodes"],
            })
            if len(viable_paths) >= 3:
                break

    guardrail_alerts: list[dict[str, str]] = []
    if lang_alert is not None:
        guardrail_alerts.append(lang_alert)

    est_age_top = (
        round(age_float + viable_paths[0]["total_expected_days"] / 30.44, 1)
        if viable_paths
        else round(age_float + 1.5, 1)
    )
    guardrail_alerts.extend(
        _build_age_transition_alerts(
            age_info,
            est_age_recommended=est_age_top,
        )
    )

    top_dist_km = float(viable_paths[0]["family_clinic_travel_km"]) if viable_paths else 0.0
    if (not veh_avail) or tract_no_veh_pct >= 10.0 or top_dist_km > 25.0:
        guardrail_alerts.append({
            "code": "ZERO_VEHICLE_MOBILITY_SUPPORT",
            "severity": "MEDIUM",
            "message": (
                f"Tract {home_tract} zero-vehicle={tract_no_veh_pct}%, travel={top_dist_km} km; "
                "use Medicaid NEMT or home evaluation."
            ),
        })

    return {
        "status": "ok",
        "tract_resolution": tract_resolution,
        "engine": engine,
        "synthetic_provenance_notice": _SYNTHETIC_NOTICE,
        "iso_gql_query": gql_query,
        "statutory_transition_tier": age_info["statutory_transition_tier"],
        "days_until_age_3": age_info["days_until_age_3"],
        "effective_deadline_days": age_info["effective_deadline_days"],
        "dual_lea_handoff_required": bool(
            age_info["dual_lea_handoff_required"] or (est_age_top >= 36.0)
        ),
        "active_slot_holds_in_state": int(telemetry["active_slot_holds_total"]),
        "query_parameters": {
            "zip_or_tract": raw_loc,
            "normalized_tract_geoid": home_tract,
            "tract_resolution": tract_resolution,
            "languages": lang_clean,
            "insurance": ins_clean,
            "specialty": spec_clean,
            "canonical_concern_domain": canonical_domain,
            "child_age_months": age_m,
            "has_household_vehicle": veh_avail,
            "prior_diagnostic_completed": prior_diag,
            "needs_medicaid": needs_medicaid,
            "needs_bilingual": needs_bilingual,
            "max_bounce_rate": max_bounce,
            "max_travel_km": clean_max_km,
        },
        "tract_context": tract_context,
        "viable_paths": viable_paths,
        "pruned_high_bounce_edges_count": pruned_high_bounce_edges_count,
        "pruned_congested_or_bounce_nodes_count": pruned_nodes_count,
        "guardrail_alerts": guardrail_alerts,
    }
