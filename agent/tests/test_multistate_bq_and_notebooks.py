"""Unit & Live BigQuery Multi-State Integration Tests (Auth Bridge, 6 States, Notebooks)."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import MagicMock, patch

from google.auth.exceptions import DefaultCredentialsError, RefreshError
import pytest

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from first_milestones.mcp_integration import _get_adc_headers  # noqa: E402
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
from first_milestones.tools import bq_client as bq_mod  # noqa: E402
from first_milestones.tools.bq_client import (  # noqa: E402
    VALID_STATES,
    DualBackendGraphClient,
    GcloudCliCredentials,
    get_config,
    graph_client,
    request_state_context,
    resolve_gcp_credentials_and_project,
    rewrite_sql_dataset,
)
from first_milestones.tools.reference_lookups import (  # noqa: E402
    lookup_carenode_directory,
    lookup_regional_agency_kpis,
    lookup_statewide_nsch_strata,
    lookup_tract_routing_context,
)


def _live_gcp_project_or_none() -> str | None:
    """Auto-detects whether live gcloud auth to qwiklabs-gcp-04-670e1c9d4f6d is active."""
    if os.environ.get("A4I_SKIP_LIVE_BQ_TESTS") == "1":
        return None
    try:
        creds, proj = resolve_gcp_credentials_and_project()
        if creds and proj:
            return proj
    except Exception:  # noqa: BLE001
        return None
    return None


LIVE_GCP_PROJECT = _live_gcp_project_or_none()


def test_gcloud_cli_credentials_and_project_resolution_unit() -> None:
    # 1. GcloudCliCredentials refresh success + quota project clone
    fake_ok = subprocess.CompletedProcess(
        args=["gcloud", "auth", "print-access-token"],
        returncode=0,
        stdout="ya29.unit-test-token\n",
        stderr="",
    )
    with patch("subprocess.run", return_value=fake_ok):
        creds = GcloudCliCredentials(quota_project_id="demo-proj")
        creds.refresh()
        assert creds.token == "ya29.unit-test-token"
        assert creds.expiry is not None
        assert creds.valid is True
        cloned = creds.with_quota_project("other-proj")
        assert cloned.token == "ya29.unit-test-token"
        assert cloned.quota_project_id == "other-proj"

    # 2. GcloudCliCredentials refresh failure raises RefreshError
    fake_err = subprocess.CompletedProcess(
        args=["gcloud", "auth", "print-access-token"],
        returncode=1,
        stdout="",
        stderr="not logged in",
    )
    with patch("subprocess.run", return_value=fake_err):
        bad_creds = GcloudCliCredentials()
        with pytest.raises(RefreshError):
            bad_creds.refresh()

    # 3. resolve_gcp_credentials_and_project falls back to GcloudCliCredentials when ADC missing
    with (
        patch.dict(os.environ, {"GOOGLE_CLOUD_PROJECT": ""}, clear=False),
        patch.object(bq_mod, "_ORIG_GOOGLE_AUTH_DEFAULT", side_effect=DefaultCredentialsError("no adc")),
        patch.object(bq_mod, "_detect_gcloud_project", return_value="unit-gcloud-proj"),
        patch("subprocess.run", return_value=fake_ok),
    ):
        os.environ.pop("A4I_FORCE_LOCAL_PARQUET", None)
        resolved_creds, resolved_proj = resolve_gcp_credentials_and_project()
        assert isinstance(resolved_creds, GcloudCliCredentials)
        assert resolved_creds.token == "ya29.unit-test-token"
        assert resolved_proj == "unit-gcloud-proj"

    # 4. A4I_FORCE_LOCAL_PARQUET=1 suppresses gcloud CLI fallback
    with (
        patch.dict(os.environ, {"A4I_FORCE_LOCAL_PARQUET": "1"}, clear=False),
        patch.object(bq_mod, "_ORIG_GOOGLE_AUTH_DEFAULT", side_effect=DefaultCredentialsError("no adc")),
    ):
        with pytest.raises(DefaultCredentialsError):
            resolve_gcp_credentials_and_project()

    # 5. Unit test isolation: get_config()["project"] is empty unless GOOGLE_CLOUD_PROJECT or A4I_USE_GCLOUD_AUTH=1
    with patch.dict(
        os.environ,
        {"GOOGLE_CLOUD_PROJECT": "", "A4I_USE_GCLOUD_AUTH": ""},
        clear=False,
    ):
        assert get_config()["project"] == ""

    with (
        patch.dict(
            os.environ,
            {"GOOGLE_CLOUD_PROJECT": "", "A4I_USE_GCLOUD_AUTH": "1"},
            clear=False,
        ),
        patch.object(bq_mod, "_detect_gcloud_project", return_value="auto-detected-proj"),
    ):
        os.environ.pop("A4I_FORCE_LOCAL_PARQUET", None)
        assert get_config()["project"] == "auto-detected-proj"


def test_mcp_adc_headers_uses_gcloud_bridge_unit() -> None:
    with (
        patch.dict(
            os.environ,
            {"GOOGLE_CLOUD_PROJECT": "", "A4I_USE_GCLOUD_AUTH": "", "A4I_MCP_MODE": "in_process"},
            clear=False,
        ),
        patch("google.auth.default", side_effect=DefaultCredentialsError("no adc")),
    ):
        assert _get_adc_headers() == {}

    fake_creds = MagicMock()
    fake_creds.valid = True
    fake_creds.token = "ya29.mcp-bridge-token"
    with (
        patch.dict(
            os.environ,
            {"GOOGLE_CLOUD_PROJECT": "", "A4I_USE_GCLOUD_AUTH": "1"},
            clear=False,
        ),
        patch(
            "first_milestones.tools.bq_client.resolve_gcp_credentials_and_project",
            return_value=(fake_creds, "qwiklabs-unit-proj"),
        ),
    ):
        hdrs = _get_adc_headers()
        assert hdrs["Authorization"] == "Bearer ya29.mcp-bridge-token"
        assert hdrs["x-goog-user-project"] == "qwiklabs-unit-proj"


def test_dual_backend_dataset_routing_and_shared_dataset_protection_unit() -> None:
    sql_in = (
        "SELECT * FROM GRAPH_TABLE(`proj.a4i_early_intervention.ReferralGraph` MATCH (n:CareNode) RETURN n.provider_id) "
        "JOIN `proj.a4i_early_intervention_multistate.other` ON TRUE"
    )
    rewritten = rewrite_sql_dataset(
        sql_in, "a4i_early_intervention", "a4i_early_intervention_multistate"
    )
    assert "`proj.a4i_early_intervention_multistate.ReferralGraph`" in rewritten
    assert "a4i_early_intervention_multistate_multistate" not in rewritten

    client = DualBackendGraphClient()
    mock_bq = MagicMock()

    def _fake_count(_bq: object, _proj: str, ds: str, st: str) -> int:
        if ds == "a4i_early_intervention":
            return 30 if st == "MS" else 0
        if ds == "a4i_early_intervention_multistate":
            return 30
        return 0

    with (
        patch.dict(
            os.environ,
            {
                "GOOGLE_CLOUD_PROJECT": "demo-proj",
                "A4I_DATASET": "a4i_early_intervention",
                "A4I_MULTISTATE_DATASET": "a4i_early_intervention_multistate",
            },
            clear=False,
        ),
        patch.object(client, "_get_bq", return_value=mock_bq),
        patch.object(client, "_count_state_providers", side_effect=_fake_count),
    ):
        assert client.resolve_dataset_for_state("MS") == "a4i_early_intervention"
        assert client.resolve_dataset_for_state("CA") == "a4i_early_intervention_multistate"
        assert client.resolve_dataset_for_state("AL") == "a4i_early_intervention_multistate"

        # Shared `a4i_early_intervention` must never run CREATE OR REPLACE PROPERTY GRAPH in _ensure_graph_if_missing
        mock_bq.query.return_value.result.return_value = []
        with patch.object(client, "ensure_property_graph") as mock_ensure:
            client._ensure_graph_if_missing(mock_bq, "demo-proj", "a4i_early_intervention")
            mock_ensure.assert_not_called()


def test_scripts_load_multistate_and_local_adc_exist_and_safe() -> None:
    load_sh = (REPO_ROOT / "scripts" / "load.sh").read_text(encoding="utf-8")
    assert '"${STATE}" == "ALL"' in load_sh
    assert "LPAD(census_tract_geoid, 11," in load_sh
    assert "LPAD(county_fips, 5," in load_sh
    assert "LPAD(child_home_tract_geoid, 11," in load_sh

    list_proc = subprocess.run(
        ["bash", str(REPO_ROOT / "scripts" / "load.sh"), "--list"],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    assert "ALL" in list_proc.stdout
    for st in VALID_STATES:
        assert st in list_proc.stdout

    ms_sh = (REPO_ROOT / "scripts" / "load_multistate.sh").read_text(encoding="utf-8")
    assert "a4i_early_intervention_multistate" in ms_sh
    assert '"${MULTISTATE_DATASET}" == "a4i_early_intervention"' in ms_sh
    assert "CREATE OR REPLACE PROPERTY GRAPH" in ms_sh
    assert "v_graph_can_refer_to_edges" in ms_sh
    assert "edge_bounce_rate" in ms_sh

    adc_sh = (REPO_ROOT / "scripts" / "setup_local_adc.sh").read_text(encoding="utf-8")
    for required_export in (
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "TRUE",
        "GOOGLE_CLOUD_LOCATION",
        "A4I_USE_GCLOUD_AUTH",
        "a4i_early_intervention_multistate",
    ):
        assert required_export in adc_sh


def test_notebook_c_ei_02_executed_cleanly_with_outputs() -> None:
    nb_path = REPO_ROOT / "notebooks" / "c_ei_02_graph_and_audit.ipynb"
    nb = json.loads(nb_path.read_text(encoding="utf-8"))
    assert nb["nbformat"] == 4

    code_cells = [c for c in nb["cells"] if c["cell_type"] == "code"]
    assert len(code_cells) >= 7

    combined_text_outputs: list[str] = []
    for cell in code_cells:
        cell_id = cell.get("id", "<unnamed>")
        assert cell.get("execution_count") is not None and cell["execution_count"] >= 1, (
            f"Notebook cell {cell_id} was not executed"
        )
        outputs = cell.get("outputs", [])
        assert len(outputs) >= 1, f"Notebook cell {cell_id} has empty outputs"
        for out in outputs:
            assert out.get("output_type") != "error", (
                f"Notebook cell {cell_id} contains error output: {out}"
            )
            if "text" in out:
                txt = "".join(out["text"]) if isinstance(out["text"], list) else str(out["text"])
                combined_text_outputs.append(txt)
            data = out.get("data", {})
            if "text/plain" in data:
                tp = data["text/plain"]
                combined_text_outputs.append("".join(tp) if isinstance(tp, list) else str(tp))

    joined = "\n".join(combined_text_outputs)
    assert "ReferralGraph" in joined
    assert "26" in joined
    assert "Statewide" in joined


@pytest.mark.skipif(
    LIVE_GCP_PROJECT is None,
    reason="Live GCP credentials not detected in current environment",
)
@pytest.mark.parametrize("state_code", VALID_STATES)
def test_live_bigquery_all_six_states_iso_gql_audit_and_routing(state_code: str) -> None:
    assert LIVE_GCP_PROJECT is not None
    with (
        patch.dict(
            os.environ,
            {
                "GOOGLE_CLOUD_PROJECT": LIVE_GCP_PROJECT,
                "A4I_USE_GCLOUD_AUTH": "1",
                "A4I_DATASET": "a4i_early_intervention_multistate",
            },
            clear=False,
        ),
        request_state_context(state_code),
    ):
        os.environ.pop("A4I_FORCE_LOCAL_PARQUET", None)

        # 1. Prefix-deduplicated variable-length ISO GQL breach audit
        audit = audit_multihop_bounce_hubs(only_breaches=True, limit_chains=10)
        assert "bigquery_property_graph_iso_gql" in audit["execution_engine"]
        assert "a4i_early_intervention_multistate.ReferralGraph" in audit["execution_engine"]
        assert audit["network_totals"]["total_complete_chains"] == 44
        assert audit["network_totals"]["chains_3_to_4_hops"] == 35
        assert audit["network_totals"]["statutory_breaches_over_45d"] == 26
        chain_ids = [c["case_chain_id"] for c in audit["sample_traced_episodes"]]
        assert len(chain_ids) == len(set(chain_ids))
        assert all(cid.startswith(f"CHAIN-{state_code}-") for cid in chain_ids)

        # 2. Betweenness bottleneck hub detector on live ReferralGraph
        btwn = detect_regional_bottleneck_hubs(region="ALL", max_days=45, top_n=4)
        assert "bigquery_property_graph_iso_gql" in btwn["engine"]
        assert btwn["total_breached_multihop_chains"] == 26
        assert all(
            h["provider_id"].startswith(f"SYN-PROV-{state_code}-")
            for h in btwn["bottleneck_hubs"]
        )

        # 3. Prospective <=45-day routing (both tools) with zero audit_* leakage
        comp = find_compliant_45d_pathways(child_age_months=32)
        assert "bigquery_property_graph_iso_gql" in comp["execution_engine"]
        assert comp["recommended_pathway"] is not None
        assert comp["recommended_pathway"]["expected_cumulative_days"] <= 45
        for forbidden in (
            "audit_black_share",
            "audit_hispanic_share",
            "audit_asian_share",
            "audit_indigenous_share",
            "audit_white_share",
        ):
            assert forbidden not in json.dumps(comp["child_profile"])
            assert forbidden not in json.dumps(comp["recommended_pathway"])

        viable = find_viable_45d_paths()
        assert "bigquery_property_graph_iso_gql" in viable["engine"]
        assert len(viable["viable_paths"]) >= 1
        assert all(p["total_expected_days"] <= 45 for p in viable["viable_paths"])
        assert "audit_black_share" not in json.dumps(viable["tract_context"])

        # 4. Counterfactual simulator + referral history + post-output equity + outreach zones
        sim = simulate_hub_intervention(target_provider_id="ALL")
        assert "bigquery_property_graph_iso_gql" in sim["execution_engine"]
        assert sim["impact_summary"]["baseline_breaches_over_45d"] == 26

        hist = get_referral_history()
        assert "bigquery_property_graph_iso_gql" in hist["engine"]

        eq = run_post_output_equity_audit()
        assert "bigquery_sql" in eq["execution_engine"]
        assert sum(r["episodes"] for r in eq["breach_vs_timely_neighborhood_equity"]) == 44

        zones = rank_outreach_zones(top_n=5)
        assert "bigquery_property_graph_iso_gql" in zones["engine"]
        assert len(zones["ranked_outreach_zones"]) == 5


@pytest.mark.skipif(
    LIVE_GCP_PROJECT is None,
    reason="Live GCP credentials not detected in current environment",
)
def test_live_bigquery_ca_and_al_leading_zeros_and_auto_dataset_routing() -> None:
    assert LIVE_GCP_PROJECT is not None
    # Point A4I_DATASET at the single-state dataset `a4i_early_intervention` (MS only)
    # and verify CA ('06...') and AL ('01...') automatically route live to `a4i_early_intervention_multistate`!
    with patch.dict(
        os.environ,
        {
            "GOOGLE_CLOUD_PROJECT": LIVE_GCP_PROJECT,
            "A4I_USE_GCLOUD_AUTH": "1",
            "A4I_DATASET": "a4i_early_intervention",
            "A4I_MULTISTATE_DATASET": "a4i_early_intervention_multistate",
        },
        clear=False,
    ):
        os.environ.pop("A4I_FORCE_LOCAL_PARQUET", None)

        with request_state_context("CA"):
            assert graph_client.resolve_dataset_for_state("CA") == "a4i_early_intervention_multistate"
            ca_tracts = lookup_tract_routing_context("ALL")
            assert "bigquery_sql" in ca_tracts["execution_engine"]
            assert "a4i_early_intervention_multistate" in ca_tracts["execution_engine"]
            assert len(ca_tracts["tracts"]) == 10
            assert all(
                len(t["census_tract_geoid"]) == 11 and t["census_tract_geoid"].startswith("06")
                for t in ca_tracts["tracts"]
            )

            ca_viable = find_viable_45d_paths(zip_or_tract="06047000801")
            assert "bigquery_property_graph_iso_gql" in ca_viable["engine"]
            assert "a4i_early_intervention_multistate" in ca_viable["engine"]
            assert ca_viable["tract_context"]["census_tract_geoid"] == "06047000801"
            assert all(
                p["tract_geoid"] == "06047000801" and p["tract_geoid"].startswith("06")
                for p in ca_viable["viable_paths"]
            )

            ca_screen = prioritize_community_screening_tracts(top_n=4)
            assert "bigquery_sql" in ca_screen["execution_engine"]
            assert all(
                len(t["census_tract_geoid"]) == 11 and t["census_tract_geoid"].startswith("06")
                for t in ca_screen["priority_screening_tracts"]
            )

        with request_state_context("AL"):
            assert graph_client.resolve_dataset_for_state("AL") == "a4i_early_intervention_multistate"
            al_tracts = lookup_tract_routing_context("ALL")
            assert "bigquery_sql" in al_tracts["execution_engine"]
            assert len(al_tracts["tracts"]) == 10
            assert all(
                len(t["census_tract_geoid"]) == 11 and t["census_tract_geoid"].startswith("01")
                for t in al_tracts["tracts"]
            )

            al_comp = find_compliant_45d_pathways(child_age_months=28)
            assert "bigquery_property_graph_iso_gql" in al_comp["execution_engine"]
            al_geoid = al_comp["child_profile"]["home_tract_geoid"]
            assert len(al_geoid) == 11 and al_geoid.startswith("01")

            al_kpis = lookup_regional_agency_kpis()
            al_nsch = lookup_statewide_nsch_strata()
            al_dir = lookup_carenode_directory("ALL", top_n=6)
            assert "bigquery_sql" in al_kpis["execution_engine"] and len(al_kpis["agencies"]) == 3
            assert "bigquery_sql" in al_nsch["execution_engine"] and len(al_nsch["strata"]) == 6
            assert "bigquery_sql" in al_dir["execution_engine"] and al_dir["total_matching"] == 30

        # Verify shared `a4i_early_intervention` still holds exact 30 MS providers untouched
        with request_state_context("MS"):
            assert graph_client.resolve_dataset_for_state("MS") == "a4i_early_intervention"
            ms_dir = lookup_carenode_directory("ALL", top_n=5)
            assert (
                f"bigquery_sql ({LIVE_GCP_PROJECT}.a4i_early_intervention)"
                == ms_dir["execution_engine"]
            )
            assert ms_dir["total_matching"] == 30
