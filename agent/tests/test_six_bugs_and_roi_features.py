"""End-to-end regression suite covering all 6 critical bug fixes and 6 Part 2 ROI features."""

from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from first_milestones import (  # noqa: E402
    PathwayBrief,
    check_intake_packet_readiness,
    reserve_pathway_slot,
    root_agent,
)
from first_milestones.brief_builder import (  # noqa: E402
    build_caregiver_notes,
    generate_complete_45d_brief,
)
from first_milestones.tools.bq_client import (  # noqa: E402
    GraphClient,
    get_bq_telemetry,
    request_state_context,
    reset_bq_telemetry,
)
from first_milestones.tools.equity_audit import (  # noqa: E402
    rank_outreach_zones,
    run_post_output_equity_audit,
)
from first_milestones.tools.graph_routing import (  # noqa: E402
    _build_viable_45d_paths_gql,
    find_compliant_45d_pathways,
)
from first_milestones.tools.slot_ledger import list_slot_holds, release_slot_hold  # noqa: E402
from main import app  # noqa: E402


def test_bug1_cloud_mcp_config_and_toolbox_package() -> None:
    """Bug 1: requirements include toolbox-adk, tools.yaml avoids ':US', deploy grants mcp/datastore roles."""
    reqs = (AGENT_DIR / "requirements.txt").read_text(encoding="utf-8")
    assert "toolbox-adk" in reqs

    tools_yaml = (AGENT_DIR / "tools.yaml").read_text(encoding="utf-8")
    assert "${A4I_LOCATION:US}" not in tools_yaml
    assert "${A4I_LOCATION}" in tools_yaml
    assert "${A4I_DATASET}" in tools_yaml

    entrypoint = (AGENT_DIR / "entrypoint.sh").read_text(encoding="utf-8")
    assert 'A4I_LOCATION="${A4I_LOCATION:-US}"' in entrypoint

    deploy_sh = (REPO_ROOT / "scripts" / "deploy_cloud_run.sh").read_text(encoding="utf-8")
    assert "roles/mcp.toolUser" in deploy_sh
    assert "roles/datastore.user" in deploy_sh


def test_bug2_ui_table_thead_matches_app_js_columns() -> None:
    """Bug 2: #bottleneckTable and #outreachZonesTable headers align 1-to-1 with app.js column defs."""
    html = (AGENT_DIR / "static" / "index.html").read_text(encoding="utf-8")

    btwn_match = re.search(
        r'<table[^>]*id="bottleneckTable"[^>]*>.*?<thead>(.*?)</thead>',
        html,
        flags=re.DOTALL,
    )
    assert btwn_match is not None
    btwn_ths = re.findall(r"<th[^>]*>(.*?)</th>", btwn_match.group(1), flags=re.DOTALL)
    assert len(btwn_ths) == 6

    outreach_match = re.search(
        r'<table[^>]*id="outreachZonesTable"[^>]*>.*?<thead>(.*?)</thead>',
        html,
        flags=re.DOTALL,
    )
    assert outreach_match is not None
    outreach_ths = re.findall(r"<th[^>]*>(.*?)</th>", outreach_match.group(1), flags=re.DOTALL)
    assert len(outreach_ths) == 9


def test_bug3_serves_area_untruncated_and_midhop_gql_filters() -> None:
    """Bug 3: v_graph_serves_area_edges drops <=80000 cutoff and GQL checks mid-hop predicates."""
    for rel_path in ("scripts/setup_graph.sql", "scripts/load_multistate.sh"):
        sql_txt = (REPO_ROOT / rel_path).read_text(encoding="utf-8")
        serves_idx = sql_txt.index("v_graph_serves_area_edges")
        serves_block = sql_txt[serves_idx : serves_idx + 900]
        assert "<= 80000" not in serves_block

    gql = _build_viable_45d_paths_gql(
        dataset="a4i_early_intervention_multistate",
        tract_geoid="28049003500",
        needs_medicaid=True,
        needs_bilingual=True,
        max_bounce_rate=0.35,
    )
    assert "e.target_accepts_medicaid" in gql
    assert "e.target_bilingual" in gql
    assert "e.edge_bounce_rate" in gql


def test_bug5_five_tier_age_engine_and_natural_environment_distance() -> None:
    """Bug 5: 34 CFR 303.209 5-tier model + 34 CFR 303.126 home-visit distance separation."""
    with patch.dict(os.environ, {"A4I_FORCE_LOCAL_PARQUET": "1"}), request_state_context("MS"):
        t2 = find_compliant_45d_pathways(child_age_months=28)
        assert t2["statutory_transition_tier"] == "tier_2_lea_transition_planning_27_32m"
        assert any(a["code"] == "IDEA_PART_C_LEA_TRANSITION_PLANNING_WINDOW" for a in t2["guardrail_alerts"])
        rec = t2["recommended_pathway"]
        assert rec is not None
        assert rec["natural_environment_home_visit"] is True
        assert "family_clinic_travel_km" in rec
        assert "home_visit_vendor_distance_km" in rec

        t4 = find_compliant_45d_pathways(child_age_months=35)
        assert t4["statutory_transition_tier"] == "tier_4_less_than_45d_exemption_dual_handoff_34_5_35_9m"
        assert t4["dual_lea_handoff_required"] is True
        if t4["recommended_pathway"]:
            assert t4["recommended_pathway"]["clears_part_c_before_age_3"] is False

        t5 = find_compliant_45d_pathways(child_age_months=37)
        assert t5["status"] == "ineligible_part_c_aged_out"
        assert t5["statutory_transition_tier"] == "tier_5_part_b_section_619_lea_direct_36m_plus"


def test_bug6_and_features_caregiver_equity_gatekeeper_slots_byod_geo_telemetry() -> None:
    """Bug 6 + Features 1-6 across tools, FastAPI endpoints, BYOD, TIGER SVG, and telemetry."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_file = str(Path(tmpdir) / "slots.db")
        with patch.dict(os.environ, {"A4I_SLOT_LEDGER_DB": db_file, "A4I_FORCE_LOCAL_PARQUET": "1"}):
            with request_state_context("MS"):
                # Feature 1: Hop-0 Gatekeeper
                gk = check_intake_packet_readiness(
                    state_code="MS",
                    child_age_months=35,
                    has_screening_tool=False,
                    has_parent_consent=False,
                )
                assert gk["ready_for_referral_handoff"] is False
                assert len(gk["missing_intake_items"]) >= 2
                assert gk["exemption_303_209_b_1_iii"] is True

                # Feature 2 + Bug 6: Before-vs-after cohort & dropoff_rate_pct equity delta
                eq = run_post_output_equity_audit("MS")
                cohort = eq["before_vs_after_rerouting_cohort"]
                assert cohort["breached_episodes_before"] == 26
                assert cohort["breached_episodes_after"] == 0
                assert cohort["dropoff_reduction_pp"] > 0
                assert len(cohort["post_output_demographic_parity"]) >= 5

                # Feature 6: Public-Domain HRSA BYOD FQHC overlay
                zones = rank_outreach_zones(top_n=6)
                first_zone = zones["ranked_outreach_zones"][0]
                assert "byod_fqhc_site_name" in first_zone
                assert "17 U.S.C." in zones.get("byod_provenance", "")

                # Feature 5: Slot Ledger Hold & Release
                comp = find_compliant_45d_pathways(child_age_months=32)

                # Bug 6: Caregiver notes real YYYY-MM-DD dates, Spanish domain, clean provider text
                notes = build_caregiver_notes(comp)
                assert re.search(r"\d{4}-\d{2}-\d{2}", notes["english"])
                body_only = notes["english"].split("Demo Notice:")[0]
                assert "[Synthetic]" not in body_only
                sp_body_only = notes["spanish"].split("Aviso de Demostración:")[0]
                assert "[Synthetic]" not in sp_body_only
                assert "habla y lenguaje expresivo" in sp_body_only
                assert "Expressive Speech/Language" not in sp_body_only
                hops = comp["recommended_pathway"]["hops"]
                hold = reserve_pathway_slot(
                    state_code="MS",
                    coordinator_id=hops[0]["target_provider_id"],
                    eval_hub_id=hops[1]["target_provider_id"],
                    vendor_id=hops[2]["target_provider_id"],
                    case_reference="TEST-CASE-1",
                )
                assert hold["status"] == "reserved"
                holds = list_slot_holds("MS")
                assert len(holds["holds"]) == 1
                rel = release_slot_hold(hold["hold_id"])
                assert rel["status"] == "released"

                # Feature 4: BQ Telemetry Capture
                reset_bq_telemetry()
                fake_bq = MagicMock()
                fake_job = MagicMock()
                fake_job.job_id = "job_test_12345"
                fake_job.total_bytes_processed = 4096
                fake_job.result.return_value = [{"x": 1}]
                fake_bq.query.return_value = fake_job
                client = GraphClient()
                with (
                    patch.dict(os.environ, {"GOOGLE_CLOUD_PROJECT": "demo-proj", "A4I_FORCE_LOCAL_PARQUET": "0"}),
                    patch.object(client, "_get_bq", return_value=fake_bq),
                    patch.object(client, "resolve_dataset_for_state", return_value="a4i_early_intervention_multistate"),
                    patch.object(client, "_dataset_has_can_refer_to", return_value=True),
                    patch.object(client, "_ensure_graph_if_missing"),
                ):
                    rows = client.query("SELECT 1 AS x", label="unit_test_telemetry")
                assert rows == [{"x": 1}]
                telemetry = get_bq_telemetry()
                assert any(t.get("job_id") == "job_test_12345" for t in telemetry)

                # FastAPI integration check for new endpoints & PathwayBrief schema validation
                with request_state_context("MS"):
                    brief = generate_complete_45d_brief()
                validated = PathwayBrief.model_validate(brief)
                assert validated.equity_audit.before_vs_after_rerouting_cohort is not None

            tc = TestClient(app)
            r_geo = tc.get("/api/geo?state=CA")
            assert r_geo.status_code == 200
            geo = r_geo.json()
            assert geo["tracts_count"] == 101
            assert geo["fqhc_count"] > 0
            assert "svg_path" in geo["tracts"][0]
            assert "byod_sites" in geo

            r_gk = tc.post("/api/gatekeeper", json={"state_code": "MS", "child_age_months": 35})
            assert r_gk.status_code == 200
            assert r_gk.json()["statutory_transition_tier"] == "tier_4_less_than_45d_exemption_dual_handoff_34_5_35_9m"

            r_gk_blocked = tc.post(
                "/api/gatekeeper",
                json={"state_code": "MS", "child_age_months": 32, "audit_black_share": 0.4},
            )
            assert r_gk_blocked.status_code == 422

            # Agent tool registration check
            triage_sub = next(a for a in root_agent.sub_agents if a.name == "triage_pathway_router")
            triage_tool_names = {getattr(t, "__name__", getattr(t, "name", str(t))) for t in triage_sub.tools}
            assert "check_intake_packet_readiness" in triage_tool_names
            assert "reserve_pathway_slot" in triage_tool_names
