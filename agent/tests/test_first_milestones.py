"""End-to-end verification tests for First Milestones ADK Agent, Tools & Workbench API."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import yaml
from fastapi.testclient import TestClient

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from first_milestones import root_agent  # noqa: E402
from first_milestones.brief_builder import generate_complete_45d_brief  # noqa: E402
from first_milestones.tools import (  # noqa: E402
    audit_multihop_bounce_hubs,
    detect_regional_bottleneck_hubs,
    find_compliant_45d_pathways,
    find_viable_45d_paths,
    get_referral_history,
    prioritize_community_screening_tracts,
    rank_outreach_zones,
    run_post_output_equity_audit,
    simulate_hub_intervention,
)
from first_milestones.tools.bq_client import (  # noqa: E402
    DualBackendGraphClient,
    graph_client,
    load_local_state_frames,
    request_state_context,
)
from first_milestones.tools.equity_audit import _build_outreach_zones_gql  # noqa: E402
from main import app  # noqa: E402


def test_tools_yaml_and_notebook_valid() -> None:
    tools_cfg = yaml.safe_load((AGENT_DIR / "tools.yaml").read_text(encoding="utf-8"))
    assert "ei_bigquery" in tools_cfg["sources"]
    assert tools_cfg["sources"]["ei_bigquery"]["kind"] == "bigquery"
    assert len(tools_cfg["tools"]) == 4
    assert "first_milestones_bq" in tools_cfg["toolsets"]

    nb = json.loads((REPO_ROOT / "notebooks" / "c_ei_02_graph_and_audit.ipynb").read_text(encoding="utf-8"))
    assert nb["nbformat"] == 4
    assert any("CREATE OR REPLACE PROPERTY GRAPH" in "".join(c["source"]) for c in nb["cells"])


def test_adk_root_agent_loaded() -> None:
    assert root_agent.name == "first_milestones_coordinator"
    assert len(root_agent.tools) >= 6


def test_prefix_deduplicated_audit_and_counterfactual() -> None:
    audit = audit_multihop_bounce_hubs(only_breaches=True, limit_chains=5)
    totals = audit["network_totals"]
    # Exact challenge ground truth: 44 chains, 35 multi-hop (3-4), 26 >45d breaches (zero prefix duplicates!)
    assert totals["total_complete_chains"] == 44
    assert totals["chains_3_to_4_hops"] == 35
    assert totals["statutory_breaches_over_45d"] == 26
    assert "GRAPH_TABLE" in audit["iso_gql_query"]

    top_hub = audit["top_hidden_bounce_hub"]
    assert top_hub is not None
    assert top_hub["flat_median_internal_wait_days"] <= 6
    assert top_hub["breached_over_45d"] >= 7

    sim = simulate_hub_intervention(target_provider_id=top_hub["provider_id"])
    assert sim["impact_summary"]["total_delayed_child_days_saved"] > 100
    assert (
        sim["impact_summary"]["simulated_breaches_over_45d"]
        < sim["impact_summary"]["baseline_breaches_over_45d"]
    )


def test_routing_45d_guardrails_and_zero_audit_leakage() -> None:
    res = find_compliant_45d_pathways(
        child_tract_geoid="28049003500",
        child_age_months=32,
        concern_domain="Social-Communication / Autism Screen",
        needs_medicaid=True,
        needs_bilingual=True,
        has_household_vehicle=False,
    )
    serialized = json.dumps(res)
    for forbidden_col in (
        "audit_black_share",
        "audit_hispanic_share",
        "audit_asian_share",
        "audit_indigenous_share",
        "audit_white_share",
    ):
        assert forbidden_col not in res["child_profile"]
        assert forbidden_col not in json.dumps(res["recommended_pathway"])

    rec = res["recommended_pathway"]
    assert rec is not None
    assert rec["clears_45_day_clock"] is True
    assert rec["expected_cumulative_days"] <= 45
    assert res["cautionary_historical_bounce_chain"]["total_wait_days"] > 45

    alert_codes = {a["code"] for a in res["guardrail_alerts"]}
    assert "IDEA_PART_C_36M_AGING_OUT_CLIFF" in alert_codes
    assert "ZERO_VEHICLE_MOBILITY_SUPPORT" in alert_codes


def test_post_output_equity_and_nsch_grain_discipline() -> None:
    eq = run_post_output_equity_audit()
    assert eq["governance_attestation"]["audit_columns_excluded_from_routing"] is True
    assert len(eq["statewide_nsch_screening_context"]) == 6
    assert all(
        r["geographic_level"] == "Statewide" for r in eq["statewide_nsch_screening_context"]
    )
    assert len(eq["breach_vs_timely_neighborhood_equity"]) == 2

    outreach = prioritize_community_screening_tracts(top_n=4)
    assert len(outreach["priority_screening_tracts"]) == 4
    assert all(
        t["verified_downstream_45d_pathway"]["clears_45d_mandate"]
        for t in outreach["priority_screening_tracts"]
    )


def test_fastapi_workbench_and_leading_zero_states() -> None:
    client = TestClient(app)

    r_home = client.get("/")
    assert r_home.status_code == 200
    assert "First Milestones" in r_home.text

    r_ca = client.get("/api/brief?state=CA")
    assert r_ca.status_code == 200
    ca_data = r_ca.json()
    assert ca_data["state_code"] == "CA"
    # Verify leading-zero 11-character California FIPS ('06...')
    ca_tract = ca_data["routing"]["child_profile"]["home_tract_geoid"]
    assert len(ca_tract) == 11 and ca_tract.startswith("06")
    assert "Español" in r_home.text
    assert len(ca_data["caregiver_notes"]["spanish"]) > 80

    # Test all 3 track intents over /api/chat
    for prompt in (
        "Route a 32-month-old toddler in tract 28049003500 needing Spanish Autism screen on Medicaid",
        "Audit >45-day multi-hop bounce hubs in MS and simulate upgrading SYN-PROV-MS-011 from fax",
        "Which high-poverty zero-vehicle tracts should mobile developmental screening visit first?",
    ):
        r_chat = client.post("/api/chat", json={"message": prompt, "state_code": "MS"})
        assert r_chat.status_code == 200
        payload = r_chat.json()
        assert len(payload["reply"]) > 50
        assert len(payload["tools_invoked"]) >= 1
        assert payload["brief"]["network_audit"]["network_totals"]["statutory_breaches_over_45d"] == 26


def test_three_killer_gql_tools_and_property_graph_ddl() -> None:
    ddl_sql = (REPO_ROOT / "scripts" / "setup_graph.sql").read_text(encoding="utf-8")
    for required_symbol in (
        "v_graph_neighborhoods",
        "v_graph_refers_to_edges",
        "v_graph_serves_area_edges",
        "AS Neighborhood",
        "AS REFERS_TO",
        "AS SERVES_AREA",
    ):
        assert required_symbol in ddl_sql

    # Track 1: find_viable_45d_paths
    t1 = find_viable_45d_paths(
        zip_or_tract="28049003500",
        languages="Spanish",
        insurance="Medicaid",
        specialty="Speech",
        child_age_months=31,
        has_household_vehicle=False,
    )
    assert "GRAPH_TABLE" in t1["iso_gql_query"]
    assert "SERVES_AREA" in t1["iso_gql_query"]
    assert "REFERS_TO" in t1["iso_gql_query"]
    assert "audit_black_share" not in json.dumps(t1["tract_context"])
    assert all(p["total_expected_days"] <= 45 for p in t1["viable_paths"])

    # Track 2: detect_regional_bottleneck_hubs
    t2 = detect_regional_bottleneck_hubs(region="ALL", max_days=45, top_n=5)
    assert "GRAPH_TABLE" in t2["iso_gql_query"]
    assert "REFERS_TO" in t2["iso_gql_query"]
    assert t2["total_breached_multihop_chains"] == 26
    assert len(t2["bottleneck_hubs"]) >= 1
    assert t2["bottleneck_hubs"][0]["betweenness_flow_share_pct"] > 0

    # Track 3: rank_outreach_zones
    t3 = rank_outreach_zones(needs_medicaid=True, needs_bilingual=True, top_n=6)
    assert "GRAPH_TABLE" in t3["iso_gql_query"]
    assert "SERVES_AREA" in t3["iso_gql_query"]
    assert len(t3["ranked_outreach_zones"]) == 6
    assert t3["governance_attestation"]["audit_columns_excluded_from_scoring"] is True

    # Synthetic provenance notice must be present on all 3 new tools
    for tool_out in (t1, t2, t3):
        assert "synthetic_provenance_notice" in tool_out
        assert "[Synthetic]" in tool_out["synthetic_provenance_notice"]


def test_bq_client_ensure_property_graph_ddl_and_outreach_25km_radius() -> None:
    # Prevent P0-1 regression: runtime ensure_property_graph() DDL must declare all views & labels
    bq_backend = DualBackendGraphClient()
    mock_bq = MagicMock()
    with patch.object(bq_backend, "_get_bq", return_value=mock_bq):
        assert bq_backend.ensure_property_graph() is True
    assert mock_bq.query.called
    runtime_ddl = "\n".join(str(c.args[0]) for c in mock_bq.query.call_args_list)
    for required_symbol in (
        "v_graph_neighborhoods",
        "v_graph_refers_to_edges",
        "v_graph_serves_area_edges",
        "AS Neighborhood",
        "AS REFERS_TO",
        "AS SERVES_AREA",
    ):
        assert required_symbol in runtime_ddl

    # Verify _build_outreach_zones_gql enforces 25.0 km SERVES_AREA radius in GQL
    outreach_gql = _build_outreach_zones_gql(
        "a4i_early_intervention",
        needs_medicaid=True,
        needs_bilingual=True,
        project="demo-project",
        state_code="MS",
    )
    assert "s.travel_distance_km <= 25.0" in outreach_gql


def test_mocked_bq_rows_execution_paths() -> None:
    os.environ["A4I_STATE"] = "MS"
    with patch.dict(os.environ, {"GOOGLE_CLOUD_PROJECT": "demo-project"}):
        # Empty bq_rows=[] on find_viable_45d_paths must return viable_paths == [] (no local fallback)
        with patch.object(graph_client, "query_bq_or_none", return_value=[]):
            empty_res = find_viable_45d_paths(
                zip_or_tract="28049003500",
                languages="Spanish",
                insurance="Medicaid",
                specialty="Speech",
            )
        assert empty_res["viable_paths"] == []
        assert "bigquery_property_graph_iso_gql" in empty_res["engine"]
        assert "[Synthetic]" in empty_res["synthetic_provenance_notice"]

        # Non-empty bq_rows on find_viable_45d_paths
        sample_bq_paths = [
            {
                "tract_geoid": "28049003500",
                "start_provider_id": "SYN-PROV-MS-001",
                "start_name": "Magnolia Pediatric Clinic [Synthetic]",
                "eval_provider_id": "SYN-PROV-MS-014",
                "eval_name": "Delta Eval Hub [Synthetic]",
                "eval_role": "Multidisciplinary_Eval_Hub",
                "hop_count": 2,
                "intake_lag_days": 5,
                "handoff_days": 10,
                "evaluator_backlog_days": 9,
                "total_expected_days": 24,
            }
        ]
        with patch.object(graph_client, "query_bq_or_none", return_value=sample_bq_paths):
            non_empty_res = find_viable_45d_paths(
                zip_or_tract="28049003500",
                languages="Spanish",
                insurance="Medicaid",
                specialty="Speech",
            )
        assert len(non_empty_res["viable_paths"]) == 1
        assert non_empty_res["viable_paths"][0]["total_expected_days"] == 24
        assert "bigquery_property_graph_iso_gql" in non_empty_res["engine"]

        # Mocked bq_rows on detect_regional_bottleneck_hubs
        local_btwn = detect_regional_bottleneck_hubs(region="ALL", max_days=45, top_n=3)
        top_pid = local_btwn["bottleneck_hubs"][0]["provider_id"]
        mock_hub_rows = [
            {
                "provider_id": top_pid,
                "breached_paths_through_hub": 11,
                "betweenness_flow_share_pct": 42.3,
                "bounce_rate_pct": 81.8,
                "paper_fax_share_pct": 90.9,
                "primary_bounce_reason": "Re-Referral Bounce: Missing Bilingual Evaluator",
            }
        ]
        with patch.object(graph_client, "query_bq_or_none", return_value=mock_hub_rows):
            bq_btwn = detect_regional_bottleneck_hubs(region="ALL", max_days=45, top_n=3)
        assert "bigquery_property_graph_iso_gql" in bq_btwn["engine"]
        assert len(bq_btwn["bottleneck_hubs"]) == 1
        assert bq_btwn["bottleneck_hubs"][0]["provider_id"] == top_pid
        assert bq_btwn["bottleneck_hubs"][0]["betweenness_flow_share_pct"] == 42.3

        # Mocked bq_rows on rank_outreach_zones
        mock_zone_rows = [
            {
                "census_tract_geoid": "28049003500",
                "nearest_any_clinic_km": 6.4,
                "reachable_45d_compliant_paths": 0,
            }
        ]
        with patch.object(graph_client, "query_bq_or_none", return_value=mock_zone_rows):
            bq_zones = rank_outreach_zones(needs_medicaid=True, needs_bilingual=True, top_n=10)
        assert "bigquery_property_graph_iso_gql" in bq_zones["engine"]
        assert bq_zones["hidden_ei_deserts_count"] >= 1


def test_brief_hydration_and_new_chat_intents() -> None:
    os.environ["A4I_STATE"] = "MS"
    brief = generate_complete_45d_brief(child_tract_geoid="28049003500")
    for key in (
        "routing",
        "viable_45d_paths",
        "network_audit",
        "bottleneck_hubs",
        "counterfactual_simulation",
        "equity_audit",
        "screening_outreach",
        "outreach_zones",
        "caregiver_notes",
        "agencies",
    ):
        assert key in brief

    client = TestClient(app)

    # 1. Hidden EI deserts / outreach prompt
    r_deserts = client.post(
        "/api/chat",
        json={"message": "Find hidden EI deserts for mobile outreach", "state_code": "MS"},
    )
    assert r_deserts.status_code == 200
    p_deserts = r_deserts.json()
    assert "rank_outreach_zones" in p_deserts["tools_invoked"]
    assert "hidden early intervention deserts" in p_deserts["reply"].lower()
    assert "outreach_zones" in p_deserts["brief"]

    # 2. Viable 45d paths + prune high-bounce edges (must NOT collide with Track 2 bounce audit!)
    r_viable = client.post(
        "/api/chat",
        json={
            "message": "Find viable 45d paths in 28049003500 and prune high-bounce edges",
            "state_code": "MS",
        },
    )
    assert r_viable.status_code == 200
    p_viable = r_viable.json()
    assert "find_viable_45d_paths" in p_viable["tools_invoked"]
    assert "detect_regional_bottleneck_hubs" not in p_viable["tools_invoked"]
    assert "28049003500" in p_viable["reply"]
    assert "viable_45d_paths" in p_viable["brief"]

    # 3. Regional bottleneck hubs by betweenness
    r_btwn = client.post(
        "/api/chat",
        json={"message": "Detect regional bottleneck hubs by betweenness", "state_code": "MS"},
    )
    assert r_btwn.status_code == 200
    p_btwn = r_btwn.json()
    assert "detect_regional_bottleneck_hubs" in p_btwn["tools_invoked"]
    assert "betweenness" in p_btwn["reply"].lower()
    assert "bottleneck_hubs" in p_btwn["brief"]

    # 4. 5-digit county FIPS prefix extraction in /api/chat
    r_prefix = client.post(
        "/api/chat",
        json={"message": "Find viable 45d paths in 28049 for a 24-month-old toddler", "state_code": "MS"},
    )
    assert r_prefix.status_code == 200
    assert r_prefix.json()["brief"]["viable_45d_paths"]["tract_context"]["county_fips"] == "28049"


def test_gemini_model_fallback_chain() -> None:
    import main as server_main
    from first_milestones.agent import DEFAULT_MODEL, get_model_candidates

    candidates = get_model_candidates()
    assert DEFAULT_MODEL == "gemini-2.5-pro"
    assert candidates[0] == "gemini-2.5-pro"
    assert "gemini-2.5-flash" in candidates
    assert "gemini-3-flash-preview" in candidates

    client = TestClient(app)

    class _FakeRunner:
        def __init__(self, model_name: str, should_fail: bool) -> None:
            self.model_name = model_name
            self.should_fail = should_fail

        async def run_async(self, **_: object):
            if self.should_fail:
                raise RuntimeError(f"Simulated capacity error on {self.model_name}")
            part = MagicMock(text=f"Backup response from {self.model_name}")
            ev = MagicMock()
            ev.get_function_calls.return_value = []
            ev.get_function_responses.return_value = []
            ev.is_final_response.return_value = True
            ev.content = MagicMock(parts=[part])
            yield ev

    fake_runners = {
        candidates[0]: _FakeRunner(candidates[0], should_fail=True),
        candidates[1]: _FakeRunner(candidates[1], should_fail=False),
    }

    with patch.dict(os.environ, {"GOOGLE_API_KEY": "fake-test-key"}):
        with patch.object(server_main, "_get_runner", side_effect=lambda m: fake_runners[m]):
            r = client.post(
                "/api/chat",
                json={"message": "Check MS bounce hubs", "state_code": "MS"},
            )
    assert r.status_code == 200
    body = r.json()
    assert body["model_used"] == candidates[1]
    assert body["fallback_used"] is True
    assert candidates[1] in body["mode"]
    assert f"Backup response from {candidates[1]}" in body["reply"]


def test_referral_history_delay_math_validation_and_compactness() -> None:
    os.environ["A4I_STATE"] = "MS"

    # 1. Historical referral chain retrieval & exact referral_date -> next_step_date delay math
    with request_state_context("MS"):
        h2 = get_referral_history(case_chain_id="CHAIN-MS-002")
        assert h2["status"] == "ok"
        assert len(h2["chains"]) == 1
        ch2 = h2["chains"][0]
        assert ch2["total_hops"] == 3
        assert ch2["total_wait_days"] == 41
        assert ch2["clears_45d_clock"] is True
        for idx in range(len(ch2["hops"]) - 1):
            assert ch2["hops"][idx]["next_step_date"] == ch2["hops"][idx + 1]["referral_date"]

        h5 = get_referral_history(case_chain_id="CHAIN-MS-005")
        assert h5["status"] == "ok"
        assert len(h5["chains"]) == 1
        ch5 = h5["chains"][0]
        assert ch5["total_hops"] == 4
        assert ch5["total_wait_days"] == 77
        assert ch5["clears_45d_clock"] is False
        for idx in range(len(ch5["hops"]) - 1):
            assert ch5["hops"][idx]["next_step_date"] == ch5["hops"][idx + 1]["referral_date"]

        # 2. Viable <=45d 3-hop Autism paths, zero 1-hop shortcuts, zero congested hubs, explicit relationship_type
        res = find_viable_45d_paths(
            zip_or_tract="28049003500",
            specialty="Autism",
            child_age_months=32,
        )
        assert res["status"] == "ok"
        assert len(res["viable_paths"]) >= 1
        assert any(
            p["hop_count"] == 3 and p["total_expected_days"] <= 45
            for p in res["viable_paths"]
        )
        assert all(p["hop_count"] >= 2 for p in res["viable_paths"])
        assert all(
            p.get("relationship_type") in ("observed_clean_corridor", "prospective_capability")
            for p in res["viable_paths"]
        )

        prov_df = load_local_state_frames("MS")["providers"]
        congestion_by_id = {
            str(r["provider_id"]): int(r["active_waitlist_count"]) / max(1, int(r["monthly_slot_capacity"]))
            for _, r in prov_df.iterrows()
        }
        for p in res["viable_paths"]:
            # All Part C nodes along the corridor (coordinator, eval hub, therapy vendor) must be uncongested
            max_node_congestion_ratio = max(congestion_by_id[nid] for nid in p["nodes"][1:])
            assert max_node_congestion_ratio <= 1.0

        # 3. Parameter validation: >=36m statutory gate, cross-state tract, negated insurance/language, top_n
        aged_out_viable = find_viable_45d_paths(zip_or_tract="28049003500", child_age_months=38)
        assert aged_out_viable["status"] == "ineligible_part_c_aged_out"
        assert aged_out_viable["child_age_months"] == 38

        aged_out_route = find_compliant_45d_pathways(
            child_tract_geoid="28049003500", child_age_months=38
        )
        assert aged_out_route["status"] == "ineligible_part_c_aged_out"

        cross_state = find_viable_45d_paths(zip_or_tract="06047000801")
        assert cross_state["status"] == "validation_error"

        no_med = find_viable_45d_paths(zip_or_tract="28049003500", insurance="No Medicaid")
        assert no_med["query_parameters"]["needs_medicaid"] is False

        eng_only = find_viable_45d_paths(zip_or_tract="28049003500", languages="English only")
        assert eng_only["query_parameters"]["needs_bilingual"] is False

        bad_top_n = rank_outreach_zones(top_n=0)
        assert bad_top_n["status"] == "validation_error"
        assert bad_top_n["error_code"] == "INVALID_TOP_N"

    # True care-delivery Hidden EI Deserts across AL (Jefferson not desert) & TX (Starr is desert)
    with request_state_context("AL"):
        al_zones = rank_outreach_zones(top_n=12)["ranked_outreach_zones"]
        assert all(
            not z["is_hidden_ei_desert"]
            for z in al_zones
            if z["county_name"] == "Jefferson County"
        )
    with request_state_context("TX"):
        tx_zones = rank_outreach_zones(top_n=12)["ranked_outreach_zones"]
        starr_zones = [z for z in tx_zones if z["county_name"] == "Starr County"]
        assert len(starr_zones) >= 1 and all(z["is_hidden_ei_desert"] for z in starr_zones)

    # Workbench /api/chat routing to get_referral_history & graceful /api/brief cross-state validation
    client = TestClient(app)
    r_chat_chain = client.post(
        "/api/chat",
        json={"message": "Trace CHAIN-MS-005 referral history", "state_code": "MS"},
    )
    assert r_chat_chain.status_code == 200
    chat_body = r_chat_chain.json()
    assert "get_referral_history" in chat_body["tools_invoked"]
    assert "CHAIN-MS-005" in chat_body["reply"]
    assert "77" in chat_body["reply"]

    r_brief_cross = client.get("/api/brief?state=MS&tract_geoid=06047000801")
    assert r_brief_cross.status_code == 200
    assert r_brief_cross.json()["routing"]["status"] == "validation_error"

    # 4. Compactness: generate_complete_45d_brief excluded from root_agent.tools, all tools < 9,000 bytes
    tool_names = [getattr(t, "__name__", getattr(t, "name", str(t))) for t in root_agent.tools]
    assert "generate_complete_45d_brief" not in tool_names
    assert "get_referral_history" in tool_names
    assert len(root_agent.tools) >= 9

    with request_state_context("MS"):
        assert len(json.dumps(rank_outreach_zones(top_n=8))) < 6000
        callable_tools = [t for t in root_agent.tools if callable(t)]
        assert len(callable_tools) >= 9
        for tool_fn in callable_tools:
            out = tool_fn()
            serialized_len = len(json.dumps(out))
            assert serialized_len < 9000, (
                f"Tool {tool_fn.__name__} returned {serialized_len} bytes (>= 9000 limit)"
            )
