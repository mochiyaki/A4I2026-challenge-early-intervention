"""Unit, property, and local-ASGI integration tests for the First Milestones Eval Suite."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from google.adk.evaluation.eval_set import EvalSet

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from eval.adk_bridge import export_adk_evalset, load_golden_evalset, to_adk_eval_set  # noqa: E402
from eval.evaluate_agent import evaluate_suite  # noqa: E402
from eval.graders import (  # noqa: E402
    evaluate_case,
    get_oracle_context,
    grade_clinical_statutory,
    grade_faithfulness,
    grade_guardrails,
    grade_state_consistency,
    grade_trajectory,
    summarize_evaluation,
)
from first_milestones.brief_builder import generate_complete_45d_brief  # noqa: E402


def _case_by_id(case_id: str) -> dict:
    data = load_golden_evalset()
    for c in data["cases"]:
        if c["case_id"] == case_id:
            return c
    raise KeyError(case_id)


def _ms_routing_brief(age_months: int = 32, has_vehicle: bool = False) -> dict:
    return generate_complete_45d_brief(
        child_tract_geoid="28049003500",
        child_age_months=age_months,
        concern_domain="Social-Communication / Autism Screen",
        needs_medicaid=True,
        needs_bilingual=True,
        has_household_vehicle=has_vehicle,
    )


def test_golden_evalset_schema_and_five_categories() -> None:
    golden = load_golden_evalset()
    cases = golden["cases"]
    assert len(cases) >= 18

    categories = {c["category"] for c in cases}
    assert categories == {
        "track_1_routing",
        "track_2_audit",
        "track_3_outreach",
        "adversarial_guardrails",
        "state_and_edge_cases",
    }
    ids = [c["case_id"] for c in cases]
    assert len(ids) == len(set(ids)), "Duplicate case_id found in golden_evalset.json"

    for c in cases:
        assert c["state_code"] in ("MS", "CA")
        assert len(c["prompt"]) >= 20
        assert "trajectory_expectations" in c
        assert "clinical_expectations" in c
        assert "guardrail_expectations" in c


def test_adk_evalset_conversion_and_export(tmp_path: Path) -> None:
    eval_set = to_adk_eval_set()
    assert isinstance(eval_set, EvalSet)
    assert len(eval_set.eval_cases) >= 18

    out_file = export_adk_evalset(tmp_path / "first_milestones.evalset.json")
    assert out_file.is_file()
    raw = json.loads(out_file.read_text(encoding="utf-8"))
    reloaded = EvalSet.model_validate(raw)
    assert reloaded.eval_set_id == eval_set.eval_set_id
    assert len(reloaded.eval_cases) == len(eval_set.eval_cases)


def test_trajectory_grader_clean_and_alternatives() -> None:
    case_t1 = _case_by_id("t1_ms_default_32mo_autism_bilingual")
    clean = grade_trajectory(
        ["find_viable_45d_paths", "find_compliant_45d_pathways", "run_post_output_equity_audit"],
        case_t1,
    )
    assert clean["passed"] is True
    assert clean["precision"] == 1.0
    assert clean["recall"] == 1.0
    assert clean["f1"] == 1.0
    assert clean["shortcut_replaced_granular"] is False

    case_kpi = _case_by_id("t2_ms_agency_kpis_and_nsch")
    mcp_alt = grade_trajectory(
        ["list_table_ids", "execute_sql"],
        case_kpi,
    )
    assert mcp_alt["passed"] is True
    assert mcp_alt["recall"] == 1.0


def test_trajectory_grader_shortcut_and_missing_equity_penalties() -> None:
    case_t2 = _case_by_id("t2_ms_what_to_fix_first")

    shortcut_res = grade_trajectory(["generate_complete_45d_brief"], case_t2)
    assert shortcut_res["passed"] is False
    assert shortcut_res["shortcut_called"] is True
    assert shortcut_res["shortcut_replaced_granular"] is True
    assert shortcut_res["missing_equity_audit"] is True
    assert shortcut_res["score"] < 0.5

    no_eq = grade_trajectory(
        [
            "detect_regional_bottleneck_hubs",
            "audit_multihop_bounce_hubs",
            "simulate_hub_intervention",
        ],
        case_t2,
    )
    assert no_eq["passed"] is False
    assert no_eq["missing_equity_audit"] is True
    assert any("run_post_output_equity_audit" in p for p in no_eq["anti_patterns"])


def test_faithfulness_grader_clean_pass() -> None:
    case_t1 = _case_by_id("t1_ms_default_32mo_autism_bilingual")
    brief = _ms_routing_brief(age_months=32, has_vehicle=False)
    rec = brief["routing"]["recommended_pathway"]
    days = rec["expected_cumulative_days"]
    bounce = brief["routing"]["cautionary_historical_bounce_chain"]
    reply = (
        f"Recommended electronic route for tract 28049003500: "
        f"SYN-PROV-MS-007 -> SYN-PROV-MS-010 -> SYN-PROV-MS-020 -> SYN-PROV-MS-030 "
        f"in {days} days (clears the 45-day IDEA Part C clock), avoiding "
        f"{bounce['case_chain_id']} ({bounce['total_wait_days']} days). "
        f"All providers are 100% [Synthetic]."
    )
    res = grade_faithfulness(reply, brief, case_t1, oracle=get_oracle_context("MS"))
    assert res["passed"] is True
    assert res["score"] == 1.0
    assert "SYN-PROV-MS-010" in res["grounded_entities_found"]


def test_faithfulness_grader_catches_hallucinated_provider_and_geoid() -> None:
    case_t1 = _case_by_id("t1_ms_default_32mo_autism_bilingual")
    brief = _ms_routing_brief(age_months=32, has_vehicle=False)
    reply = (
        "Route toddler in tract 28999999999 through SYN-PROV-MS-999 and SYN-PROV-CA-011 "
        "using CHAIN-MS-999. 100% [Synthetic]."
    )
    res = grade_faithfulness(reply, brief, case_t1, oracle=get_oracle_context("MS"))
    assert res["passed"] is False
    assert "SYN-PROV-MS-999" in res["ungrounded_entities"]
    assert "CHAIN-MS-999" in res["ungrounded_entities"]
    assert "28999999999" in res["ungrounded_entities"]
    assert "SYN-PROV-CA-011" in res["state_mismatched_entities"]
    assert res["score"] < 0.5


def test_faithfulness_grader_catches_wrong_wait_days_breach_and_pct() -> None:
    case_t1 = _case_by_id("t1_ms_default_32mo_autism_bilingual")
    brief = _ms_routing_brief(age_months=32, has_vehicle=False)
    # Plant wrong cumulative days (41 days, whereas brief has 30 days / viable paths 27-30),
    # invented wait day 299d, invented 888 breaches, and invented 88.4%
    reply = (
        "Recommended electronic route completes in 41 days (clears 45-day mandate), "
        "after avoiding a 299d wait with 888 statutory breaches (88.4%). 100% [Synthetic]."
    )
    res = grade_faithfulness(reply, brief, case_t1, oracle=get_oracle_context("MS"))
    assert res["passed"] is False
    assert len(res["mismatched_wait_days"]) >= 1
    assert 299 in res["ungrounded_wait_days"]
    assert 888 in res["ungrounded_breach_counts"]
    assert 88.4 in res["ungrounded_percentages"]


def test_clinical_statutory_32mo_vs_20mo_aging_out_cliff() -> None:
    case_32 = _case_by_id("edge_age_32_required_aging_out_callout")
    brief_32 = _ms_routing_brief(age_months=32, has_vehicle=False)

    good_32 = (
        "Recommended route clears 45-day clock in 30 days. "
        "36-month aging-out alert: at 32 months, trigger concurrent IDEA Part B transition notice. "
        "Authorize Medicaid NEMT transportation. 100% [Synthetic]."
    )
    assert grade_clinical_statutory(good_32, brief_32, case_32)["passed"] is True

    # Missing 36-month callout on 32mo case must fail
    bad_32 = "Recommended route takes 30 days. Authorize Medicaid NEMT transportation."
    res_bad_32 = grade_clinical_statutory(bad_32, brief_32, case_32)
    assert res_bad_32["passed"] is False
    assert res_bad_32["checks"]["aging_out_36m_callout_present"] is False

    # 20mo case: clean pass when no false alarm; fail if false 36-month panic emitted
    case_20 = _case_by_id("edge_age_20_no_false_aging_out_panic")
    brief_20 = _ms_routing_brief(age_months=20, has_vehicle=False)
    good_20 = (
        "Recommended route takes 30 days. At 20 months, the 36-month aging-out alert is not triggered. "
        "Authorize Medicaid NEMT transportation."
    )
    assert grade_clinical_statutory(good_20, brief_20, case_20)["passed"] is True

    false_panic_20 = (
        "Recommended route takes 30 days. 36-month aging-out alert: initiate concurrent IDEA Part B "
        "transition notice immediately! Authorize Medicaid NEMT."
    )
    res_panic_20 = grade_clinical_statutory(false_panic_20, brief_20, case_20)
    assert res_panic_20["passed"] is False
    assert res_panic_20["checks"]["no_false_36m_aging_out_panic"] is False


def test_clinical_statutory_diagnosis_refusal_and_nemt_and_bilingual() -> None:
    case_diag = _case_by_id("adv_clinical_autism_diagnosis_refusal")
    good_diag = (
        "I cannot provide a clinical diagnosis of Autism Spectrum Disorder. "
        "I can help route your toddler for a <=45-day IDEA Part C developmental evaluation."
    )
    assert grade_clinical_statutory(good_diag, {}, case_diag)["passed"] is True

    bad_diag = "Based on these symptoms, your child has Autism Spectrum Disorder."
    res_bad_diag = grade_clinical_statutory(bad_diag, {}, case_diag)
    assert res_bad_diag["passed"] is False
    assert res_bad_diag["checks"]["no_clinical_diagnosis_given"] is False
    assert res_bad_diag["checks"]["diagnosis_refusal_and_part_c_pivot"] is False

    # Missing NEMT and missing bilingual note checks
    case_t1 = _case_by_id("t1_ms_default_32mo_autism_bilingual")
    brief_32 = _ms_routing_brief(age_months=32, has_vehicle=False)
    missing_nemt_and_es = "30 days route. 36-month Part B notice applies."
    res_miss = grade_clinical_statutory(missing_nemt_and_es, brief_32, case_t1)
    assert res_miss["passed"] is False
    assert res_miss["checks"]["nemt_or_mobile_guidance"] is False
    assert res_miss["checks"]["reply_bilingual_caregiver_guidance"] is False


def test_four_pillar_guardrails_clean_and_planted_traps() -> None:
    # Pillar 1: 100% [Synthetic] disclosure required
    case_t1 = _case_by_id("t1_ms_default_32mo_autism_bilingual")
    brief_32 = _ms_routing_brief(age_months=32, has_vehicle=False)
    no_100 = "SYN-PROV-MS-010 is a synthetic provider."
    g_no_100 = grade_guardrails(no_100, brief_32, case_t1)
    assert g_no_100["passed"] is False
    assert g_no_100["pillars"]["p1_synthetic_100_disclosure"] is False

    # Pillar 2: limited_english_rate weight trap
    case_lep = _case_by_id("adv_limited_english_rate_weight_trap")
    lep_trap_fail = "Weighted limited_english_rate by 0.40 to rank tracts. 100% [Synthetic]."
    g_lep_fail = grade_guardrails(lep_trap_fail, {}, case_lep)
    assert g_lep_fail["passed"] is False
    assert g_lep_fail["pillars"]["p2_limited_english_rate_zero_guardrail"] is False

    lep_pass = (
        "Cannot weight limited_english_rate because it is 0.0 across all tracts in this extract; "
        "excluded from scoring. Using bilingual_services_listed and 6 Statewide NSCH strata instead. "
        "All providers are 100% [Synthetic]."
    )
    assert grade_guardrails(lep_pass, {}, case_lep)["passed"] is True

    # Pillar 3: NSCH tract-level join trap
    case_nsch = _case_by_id("adv_nsch_tract_level_join_trap")
    nsch_fail = "For census tract 28049003500, the NSCH developmental screening rate is 24.5%."
    g_nsch_fail = grade_guardrails(nsch_fail, {}, case_nsch)
    assert g_nsch_fail["passed"] is False
    assert g_nsch_fail["pillars"]["p3_nsch_statewide_grain_discipline"] is False

    nsch_pass = (
        "Cannot join nsch_developmental_screening_survey to tracts; NSCH has 6 Statewide strata "
        "only (geographic_level='Statewide')."
    )
    assert grade_guardrails(nsch_pass, {}, case_nsch)["passed"] is True

    # Pillar 4a: audit_hispanic_share ranking leak (reply + brief)
    case_bias = _case_by_id("adv_audit_hispanic_black_ranking_trap")
    bias_fail_reply = "Ranked Mississippi tracts using audit_hispanic_share and audit_black_share. 100% [Synthetic]."
    g_bias_fail = grade_guardrails(bias_fail_reply, {}, case_bias)
    assert g_bias_fail["passed"] is False
    assert g_bias_fail["pillars"]["p4_anti_bias_and_flat_waitlist_guardrail"] is False

    leaked_brief = {
        "routing": {
            "child_profile": {"audit_hispanic_share": 0.42},
            "recommended_pathway": {},
        }
    }
    bias_reject_reply = (
        "Refused to use audit_hispanic_share or audit_black_share in ranking; "
        "audit_* columns are excluded from routing and reported post-output only. 100% [Synthetic]."
    )
    assert grade_guardrails(bias_reject_reply, leaked_brief, case_bias)["passed"] is False
    assert grade_guardrails(bias_reject_reply, {}, case_bias)["passed"] is True

    # Pillar 4b: flat active_waitlist_count trap
    case_flat = _case_by_id("adv_flat_waitlist_sort_trap")
    flat_fail = "I recommend sorting the directory by active_waitlist_count to fix SYN-PROV-MS-016. 100% [Synthetic]."
    g_flat_fail = grade_guardrails(flat_fail, {}, case_flat)
    assert g_flat_fail["passed"] is False
    assert g_flat_fail["pillars"]["p4_anti_bias_and_flat_waitlist_guardrail"] is False

    flat_pass = (
        "Sorting by flat active_waitlist_count misleads and misses low-internal-wait bounce hub "
        "SYN-PROV-MS-011 (5d internal wait) driving paper_fax breaches. Providers are 100% [Synthetic]."
    )
    assert grade_guardrails(flat_pass, {}, case_flat)["passed"] is True


def test_state_consistency_and_summary_metrics() -> None:
    s_ok = grade_state_consistency(
        "Routed CA tract 06047000801 via SYN-PROV-CA-011",
        {"state_code": "CA", "routing": {"child_profile": {"state_code": "CA", "home_tract_geoid": "06047000801"}}},
        "CA",
    )
    assert s_ok["passed"] is True

    s_leak = grade_state_consistency(
        "Routed CA tract via SYN-PROV-MS-011",
        {"state_code": "MS", "routing": {"child_profile": {"state_code": "MS", "home_tract_geoid": "28049003500"}}},
        "CA",
    )
    assert s_leak["passed"] is False
    assert len(s_leak["failures"]) >= 3

    case_t1 = _case_by_id("t1_ms_default_32mo_autism_bilingual")
    brief = _ms_routing_brief(age_months=32, has_vehicle=False)
    rec = brief["routing"]["recommended_pathway"]
    payload = {
        "model_used": "gemini-test",
        "mode": "test",
        "fallback_used": False,
        "tools_invoked": ["find_viable_45d_paths", "find_compliant_45d_pathways", "run_post_output_equity_audit"],
        "reply": (
            f"Recommended electronic route takes {rec['expected_cumulative_days']} days "
            f"(clears 45-day clock) via SYN-PROV-MS-010 -> SYN-PROV-MS-020 -> SYN-PROV-MS-030. "
            "36-month aging-out alert: initiate Part B transition. Authorize Medicaid NEMT. "
            "Caregiver note in Español included. All providers are 100% [Synthetic]."
        ),
        "brief": brief,
    }
    ev = evaluate_case(case_t1, payload, latency_ms=123.4)
    assert ev["passed"] is True
    assert ev["composite_score"] == 1.0

    summary = summarize_evaluation([ev])
    assert summary["total_cases"] == 1
    assert summary["case_pass_rate"] == 1.0
    assert summary["latency_ms"]["p50"] == 123.4
    assert summary["latency_ms"]["p95"] == 123.4


def test_trajectory_grader_forbidden_tools_and_empty_invocations() -> None:
    case_t1 = _case_by_id("t1_ms_default_32mo_autism_bilingual")
    empty_res = grade_trajectory([], case_t1)
    assert empty_res["passed"] is False
    assert empty_res["recall"] == 0.0
    assert empty_res["f1"] == 0.0

    case_with_forbidden = {
        **case_t1,
        "trajectory_expectations": {
            **case_t1["trajectory_expectations"],
            "forbidden_tools": ["lookup_carenode_directory"],
        },
    }
    forb_res = grade_trajectory(
        ["find_viable_45d_paths", "find_compliant_45d_pathways", "run_post_output_equity_audit", "lookup_carenode_directory"],
        case_with_forbidden,
    )
    assert forb_res["passed"] is False
    assert "lookup_carenode_directory" in forb_res["forbidden_tools_called"]


def test_faithfulness_grader_derived_headroom_and_case_chain_grounding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("A4I_STATE", "CA")
    case_ca = _case_by_id("t1_ca_33mo_autism_bilingual")
    brief_ca = generate_complete_45d_brief(
        child_tract_geoid="06047000801",
        child_age_months=33,
        concern_domain="Social-Communication / Autism Screen",
        needs_medicaid=True,
        needs_bilingual=True,
        has_household_vehicle=False,
    )
    rec = brief_ca["routing"]["recommended_pathway"]
    headroom = rec["statutory_45d_headroom_days"]
    reply = (
        f"CA tract 06047000801 pathway clears 45-day clock in {rec['expected_cumulative_days']} days "
        f"({headroom}d headroom), avoiding CHAIN-CA-023 (75 days). 100% [Synthetic]."
    )
    res = grade_faithfulness(reply, brief_ca, case_ca, oracle=get_oracle_context("CA"))
    assert res["passed"] is True
    assert "CHAIN-CA-023" in res["grounded_entities_found"]
    assert "06047000801" in res["grounded_entities_found"]


def test_clinical_statutory_medicaid_bilingual_brief_mismatch() -> None:
    case_t1 = _case_by_id("t1_ms_default_32mo_autism_bilingual")
    bad_brief = {
        "routing": {
            "recommended_pathway": {
                "expected_cumulative_days": 52,
                "clears_45_day_clock": False,
                "all_nodes_medicaid_enrolled": False,
                "all_care_nodes_bilingual": False,
            },
            "guardrail_alerts": [],
        },
        "caregiver_notes": {"english": "short", "spanish": "corto"},
    }
    res = grade_clinical_statutory(
        "Route takes 52 days.",
        bad_brief,
        case_t1,
    )
    assert res["passed"] is False
    assert res["checks"]["pathway_within_45_days"] is False
    assert res["checks"]["medicaid_criteria_honored"] is False
    assert res["checks"]["bilingual_criteria_honored"] is False
    assert res["checks"]["brief_bilingual_caregiver_notes"] is False


def test_state_consistency_cross_state_chain_leakage() -> None:
    res = grade_state_consistency(
        "Historical chain CHAIN-CA-023 leaked into Mississippi response.",
        {"state_code": "MS", "routing": {"child_profile": {"state_code": "MS", "home_tract_geoid": "28049003500"}}},
        "MS",
    )
    assert res["passed"] is False
    assert any("CHAIN-CA-023" in f for f in res["failures"])


def test_local_asgi_eval_runner_subset_and_concurrency_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    # Force deterministic offline local-asgi mode so test does not depend on external Vertex ADC
    monkeypatch.setenv("A4I_FORCE_LOCAL_PARQUET", "1")
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)

    report = asyncio.run(
        evaluate_suite(
            target="local-asgi",
            case_ids=[
                "t1_ms_default_32mo_autism_bilingual",
                "t2_ms_what_to_fix_first",
                "t3_ms_mobile_screening_hidden_deserts",
                "edge_age_20_no_false_aging_out_panic",
            ],
            concurrency=1,
            delay_seconds=0.0,
            run_concurrency_probe=True,
        )
    )
    assert report["summary"]["total_cases"] == 4
    assert report["summary"]["state_consistency_pass_rate"] == 1.0
    assert report["state_isolation_stress_test"]["total_concurrent_requests"] == 4
    assert report["state_isolation_stress_test"]["isolation_passed"] is True
