"""Hop-0 Pre-Handoff Eligibility, Completeness & Bounce-Prevention Gatekeeper.

Validates intake packet readiness BEFORE launching multi-hop provider handoffs so
children are never bounced (`Re-Referral Bounce`) due to missing parental consent,
missing validated developmental screening scores (ASQ-3 / M-CHAT-R/F), unflagged
interpreter needs, insurance mismatches, or missed `34 CFR § 303.209` Part B
transition timelines.

Privacy & anti-bias firewall: NEVER accepts `audit_*` arguments and NEVER reads
`audit_*` or `limited_english_rate` columns.
"""

from __future__ import annotations

import re
from typing import Any

from .bq_client import VALID_STATES, get_config, load_local_state_frames
from .graph_routing import (
    _FIPS_PREFIX_TO_STATE,
    _build_age_transition_alerts,
    _normalize_concern_domain,
    _parse_insurance_medicaid,
    _parse_language_bilingual,
    classify_part_c_age_tier,
)


def check_intake_packet_readiness(
    state_code: str = "MS",
    child_age_months: int = 32,
    concern_domain: str = "Social-Communication / Autism Screen",
    has_screening_tool: bool = True,
    has_parent_consent: bool = True,
    preferred_language: str = "Spanish",
    needs_medicaid: bool = True,
    insurance_type: str = "Medicaid",
    has_household_vehicle: bool = False,
    home_tract_geoid: str = "",
) -> dict[str, Any]:
    """Evaluates Hop-0 intake packet completeness, statutory age tier, and bounce risks.

    Args:
        state_code: Two-letter state code (`MS`, `AL`, `GA`, `TX`, `CA`, `NY`).
        child_age_months: Child age in months (`0-35` Part C, `>=36` Part B § 619).
        concern_domain: Developmental concern domain (e.g., Speech, Autism/M-CHAT, Motor).
        has_screening_tool: Whether a validated screen score (ASQ-3 / M-CHAT-R/F) is attached.
        has_parent_consent: Whether signed parental referral/evaluation consent (`34 CFR § 303.420`) is on file.
        preferred_language: Caregiver's preferred language (e.g., `English`, `Spanish`).
        needs_medicaid: Whether Medicaid-enrolled providers are required.
        insurance_type: Insurance string (`Medicaid`, `CHIP`, `Private`, `Uninsured`, etc.).
        has_household_vehicle: Whether caregiver has reliable household vehicle access.
        home_tract_geoid: Optional 11-digit Census tract GEOID or 5-digit county FIPS.

    Returns:
        Structured Hop-0 gatekeeper report with `readiness_score` (`0-100`),
        `packet_status`, `missing_intake_items`, `statutory_transition_tier`,
        `days_until_age_3`, `effective_deadline_days`, `dual_lea_handoff_required`,
        `interpreter_language_flag`, `nemt_eligibility`, and `bounce_prevention_warnings`.
    """
    cfg = get_config()
    raw_state = (state_code or cfg["state"]).strip().upper()
    if raw_state not in VALID_STATES:
        return {
            "status": "validation_error",
            "error_code": "INVALID_STATE_CODE",
            "message": f"Unsupported state_code={state_code!r}. Valid states: {sorted(VALID_STATES)}.",
            "ready_for_referral_handoff": False,
            "readiness_score": 0,
        }

    age_info = classify_part_c_age_tier(child_age_months)
    if age_info is None:
        return {
            "status": "validation_error",
            "error_code": "INVALID_AGE_MONTHS",
            "message": "child_age_months must be a finite number >= 0.",
            "state_code": raw_state,
            "ready_for_referral_handoff": False,
            "readiness_score": 0,
        }

    age_m = age_info["age_months"]
    age_float = float(age_info["age_float"])

    ins_clean, ins_medicaid = _parse_insurance_medicaid(insurance_type)
    med_req = bool(needs_medicaid) or ins_medicaid
    if ins_clean.strip().lower() in {"private", "commercial", "tricare"} and needs_medicaid is False:
        med_req = False

    lang_clean, bil_req, lang_alert = _parse_language_bilingual(preferred_language)
    domain_raw = (concern_domain or "Expressive Speech/Language").strip()
    canonical_domain = _normalize_concern_domain(domain_raw)

    # Resolve optional tract/county strictly without audit_* or limited_english_rate
    clean_loc = (home_tract_geoid or "").strip()
    tract_no_veh_pct = 0.0
    resolved_tract = ""
    county_name = ""
    loc_warning: str | None = None

    if clean_loc:
        if re.fullmatch(r"\d{10,11}", clean_loc):
            clean_tract = clean_loc.zfill(11)
            fips_state = _FIPS_PREFIX_TO_STATE.get(clean_tract[:2])
            if fips_state and fips_state != raw_state:
                loc_warning = (
                    f"Tract {clean_tract} belongs to state {fips_state}, not active state {raw_state}."
                )
            else:
                frames = load_local_state_frames(raw_state)
                demo = frames["demo"]
                hit = demo[demo["census_tract_geoid"] == clean_tract]
                if not hit.empty:
                    row = hit.iloc[0]
                    resolved_tract = str(row["census_tract_geoid"])
                    county_name = str(row["county_name"])
                    tract_no_veh_pct = round(float(row["no_vehicle_rate"]) * 100.0, 1)
                else:
                    loc_warning = f"Tract {clean_tract} was not found in {raw_state} starter tables."
        elif re.fullmatch(r"\d{4,5}", clean_loc):
            clean_fips = clean_loc.zfill(5)
            frames = load_local_state_frames(raw_state)
            demo = frames["demo"]
            hit = demo[demo["county_fips"] == clean_fips]
            if not hit.empty:
                row = hit.sort_values("poverty_rate", ascending=False).iloc[0]
                resolved_tract = str(row["census_tract_geoid"])
                county_name = str(row["county_name"])
                tract_no_veh_pct = round(float(row["no_vehicle_rate"]) * 100.0, 1)
            else:
                loc_warning = f"County FIPS {clean_fips} was not found in {raw_state} starter tables."
        else:
            loc_warning = (
                f"Location {clean_loc!r} is not an 11-digit Census tract GEOID or 5-digit county FIPS."
            )

    score = 100
    missing_items: list[dict[str, Any]] = []
    bounce_warnings: list[dict[str, str]] = []

    if not bool(has_parent_consent):
        score -= 35
        missing_items.append({
            "item_code": "PARENT_CONSENT_MISSING",
            "severity": "BLOCKER",
            "citation": "34 CFR § 303.420",
            "action": "Obtain written/electronic parental consent prior to evaluation handoff.",
        })
        bounce_warnings.append({
            "code": "BOUNCE_RISK_NO_CONSENT",
            "severity": "HIGH",
            "message": "Coordinators/Evaluators reject intake packets lacking signed 34 CFR § 303.420 consent.",
        })

    if not bool(has_screening_tool):
        score -= 25
        recommended_tool = (
            "M-CHAT-R/F"
            if "autism" in domain_raw.lower() or "social" in domain_raw.lower()
            else "ASQ-3 / SWYC"
        )
        missing_items.append({
            "item_code": "DEVELOPMENTAL_SCREENING_TOOL_MISSING",
            "severity": "BLOCKER",
            "citation": "AAP Bright Futures / 34 CFR § 303.303",
            "action": f"Attach scored {recommended_tool} screening summary for {canonical_domain}.",
        })
        bounce_warnings.append({
            "code": "BOUNCE_RISK_MISSING_SCREENING",
            "severity": "HIGH",
            "message": (
                f"Historical Part C logs show Re-Referral Bounces when {recommended_tool} results are missing; "
                "attach screening score before EHR transmission."
            ),
        })

    ins_lower = ins_clean.strip().lower()
    if not ins_lower or ins_lower in {"unknown", "pending", "unverified", "none", "uninsured"}:
        score -= 15
        missing_items.append({
            "item_code": "INSURANCE_VERIFICATION_REQUIRED",
            "severity": "ACTION_REQUIRED",
            "citation": "34 CFR § 303.520",
            "action": (
                "Verify Medicaid/CHIP ID or document Part C system-of-payments / sliding-scale waiver "
                "(no family may be turned away for inability to pay)."
            ),
        })
    elif med_req and not ins_medicaid and ins_lower in {"private", "commercial"}:
        score -= 10
        bounce_warnings.append({
            "code": "INSURANCE_MISMATCH_CHECK",
            "severity": "MEDIUM",
            "message": "needs_medicaid=True conflicts with Private insurance_type; confirm Medicaid/secondary coverage.",
        })

    if loc_warning:
        score -= 10
        missing_items.append({
            "item_code": "TRACT_LOCATION_UNVERIFIED",
            "severity": "ACTION_REQUIRED",
            "citation": "34 CFR § 303.126",
            "action": loc_warning,
        })

    # Statutory age checks & Part B 619 handling
    if not age_info["part_c_eligible"]:
        bounce_warnings.append({
            "code": "IDEA_PART_C_AGED_OUT_REFER_PART_B_619",
            "severity": "CRITICAL",
            "message": (
                f"Child is {age_m}m (>=36m). Do NOT route into Part C; generate direct IDEA Part B "
                "Section 619 LEA referral packet (34 CFR § 300.800)."
            ),
        })
    else:
        age_alerts = _build_age_transition_alerts(
            age_info,
            est_age_recommended=round(age_float + 1.0, 1),
        )
        bounce_warnings.extend(age_alerts)

    if lang_alert is not None:
        bounce_warnings.append(lang_alert)

    # Paper-fax bounce prevention guidance
    bounce_warnings.append({
        "code": "TRANSMIT_VIA_EHR_PORTAL_ONLY",
        "severity": "INFO",
        "message": (
            f"Submit packet via ehr_electronic_portal (never paper_fax) to a {canonical_domain}-capable, "
            f"{'Medicaid-enrolled ' if med_req else ''}{'bilingual ' if bil_req else ''}corridor."
        ),
    })

    veh_avail = bool(has_household_vehicle)
    nemt_eligible = bool(med_req and ((not veh_avail) or tract_no_veh_pct >= 10.0))
    if (not veh_avail) or tract_no_veh_pct >= 10.0:
        bounce_warnings.append({
            "code": "NEMT_OR_HOME_VISIT_PREAUTH",
            "severity": "MEDIUM",
            "message": (
                f"Household vehicle={veh_avail}, tract zero-vehicle={tract_no_veh_pct}%; "
                "flag Medicaid NEMT trip pre-authorization and prioritize 34 CFR § 303.126 Natural Environment home visits."
            ),
        })

    score = max(0, min(100, score))
    has_blockers = any(item["severity"] == "BLOCKER" for item in missing_items)

    if not age_info["part_c_eligible"]:
        packet_status = "REDIRECT_TO_IDEA_PART_B_LEA"
        ready_for_handoff = False
    elif has_blockers:
        packet_status = "BLOCKED_MISSING_PREREQUISITES"
        ready_for_handoff = False
    elif missing_items:
        packet_status = "CONDITIONAL_VERIFY_DETAILS"
        ready_for_handoff = True
    else:
        packet_status = "READY_FOR_EHR_HANDOFF"
        ready_for_handoff = True

    return {
        "status": "ok",
        "packet_status": packet_status,
        "ready_for_referral_handoff": ready_for_handoff,
        "readiness_score": score,
        "bias_firewall_verified": "audit_* & limited_english_rate excluded.",
        "intake_summary": {
            "state_code": raw_state,
            "home_tract_geoid": resolved_tract or clean_loc,
            "county_name": county_name,
            "child_age_months": age_m,
            "concern_domain": domain_raw,
            "canonical_concern_domain": canonical_domain,
            "has_parent_consent": bool(has_parent_consent),
            "has_screening_tool": bool(has_screening_tool),
            "preferred_language": lang_clean,
            "insurance_type": ins_clean,
            "needs_medicaid": med_req,
            "has_household_vehicle": veh_avail,
        },
        "statutory_transition_tier": age_info["statutory_transition_tier"],
        "days_until_age_3": age_info["days_until_age_3"],
        "effective_deadline_days": age_info["effective_deadline_days"],
        "dual_lea_handoff_required": bool(age_info["dual_lea_handoff_required"]),
        "exemption_303_209_b_1_iii": bool(age_info["exemption_303_209_b_1_iii"]),
        "interpreter_language_flag": {
            "preferred_language": lang_clean,
            "interpreter_required": bil_req,
            "bilingual_provider_required": bil_req,
        },
        "insurance_verification": {
            "insurance_type": ins_clean,
            "medicaid_enrolled_provider_required": med_req,
            "verification_status": (
                "NEEDS_VERIFICATION"
                if any(m["item_code"] == "INSURANCE_VERIFICATION_REQUIRED" for m in missing_items)
                else "VERIFIED_FOR_ROUTING"
            ),
        },
        "nemt_eligibility": {
            "nemt_recommended": (not veh_avail) or tract_no_veh_pct >= 10.0,
            "medicaid_nemt_eligible": nemt_eligible,
            "natural_environment_home_visit_preferred": (not veh_avail) or tract_no_veh_pct >= 10.0,
        },
        "missing_intake_items": missing_items,
        "bounce_prevention_warnings": bounce_warnings,
    }
