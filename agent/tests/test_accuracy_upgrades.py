"""Targeted verification tests for the 6 ADK Agent Accuracy Upgrades."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from google.adk.models.llm_response import LlmResponse
from google.genai import types

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from first_milestones.agent import create_coordinator_agent  # noqa: E402
from first_milestones.guardrails import (  # noqa: E402
    guardrail_after_model_callback,
    guardrail_before_tool_callback,
)
from first_milestones.prompts import SYSTEM_INSTRUCTION  # noqa: E402
from first_milestones.tools.bq_client import get_config, request_state_context  # noqa: E402
from first_milestones.tools.graph_routing import find_viable_45d_paths  # noqa: E402
from main import app  # noqa: E402


@pytest.mark.asyncio
async def test_contextvar_concurrent_state_isolation() -> None:
    """Interleaved async tasks for MS and CA must have zero state bleed and never mutate env."""
    prev_env = os.environ.get("A4I_STATE")
    os.environ["A4I_STATE"] = "MS"
    try:
        ms_seen: list[str] = []
        ca_seen: list[str] = []

        async def run_ms() -> None:
            with request_state_context("MS") as st:
                ms_seen.append(st)
                await asyncio.sleep(0.01)
                ms_seen.append(get_config()["state"])
                res = find_viable_45d_paths(
                    zip_or_tract="28049003500",
                    languages="Spanish",
                    insurance="Medicaid",
                    specialty="Speech",
                )
                ms_seen.append(res["tract_context"]["state_code"])

        async def run_ca() -> None:
            with request_state_context("CA") as st:
                ca_seen.append(st)
                await asyncio.sleep(0.005)
                ca_seen.append(get_config()["state"])
                res = find_viable_45d_paths(
                    zip_or_tract="06047000801",
                    languages="Spanish",
                    insurance="Medicaid",
                    specialty="Speech",
                )
                ca_seen.append(res["tract_context"]["state_code"])
                await asyncio.sleep(0.01)
                ca_seen.append(get_config()["state"])

        await asyncio.gather(run_ms(), run_ca())

        assert ms_seen == ["MS", "MS", "MS"]
        assert ca_seen == ["CA", "CA", "CA", "CA"]
        assert os.environ.get("A4I_STATE") == "MS"
        assert get_config()["state"] == "MS"
    finally:
        if prev_env is None:
            os.environ.pop("A4I_STATE", None)
        else:
            os.environ["A4I_STATE"] = prev_env


def test_http_endpoints_do_not_mutate_global_state_env() -> None:
    prev_env = os.environ.get("A4I_STATE")
    os.environ["A4I_STATE"] = "MS"
    try:
        client = TestClient(app)
        r_brief = client.get("/api/brief?state=CA")
        assert r_brief.status_code == 200
        assert r_brief.json()["state_code"] == "CA"
        assert r_brief.json()["runtime"]["state_code"] == "CA"
        assert os.environ.get("A4I_STATE") == "MS"

        r_sim = client.post("/api/simulate", json={"state_code": "NY"})
        assert r_sim.status_code == 200
        assert r_sim.json()["state_code"] == "NY"
        assert os.environ.get("A4I_STATE") == "MS"

        r_chat = client.post(
            "/api/chat",
            json={"message": "Check bounce hubs", "state_code": "TX"},
        )
        assert r_chat.status_code == 200
        assert r_chat.json()["brief"]["state_code"] == "TX"
        assert os.environ.get("A4I_STATE") == "MS"
    finally:
        if prev_env is None:
            os.environ.pop("A4I_STATE", None)
        else:
            os.environ["A4I_STATE"] = prev_env


@pytest.mark.parametrize(
    "sql",
    [
        "DROP TABLE a4i_early_intervention.pediatric_and_ei_provider_directory;",
        "DELETE FROM a4i_early_intervention.deidentified_part_c_referral_logs WHERE 1=1;",
        "TRUNCATE TABLE a4i_early_intervention.acs_under5_tract_demographics;",
        "INSERT INTO a4i_early_intervention.t VALUES (1);",
        "UPDATE a4i_early_intervention.t SET x = 1;",
        "ALTER TABLE a4i_early_intervention.t ADD COLUMN y STRING;",
        "CREATE TABLE a4i_early_intervention.evil AS SELECT 1;",
        "/* stealth */ DROP TABLE a4i_early_intervention.t;",
    ],
)
def test_before_tool_blocks_destructive_sql(sql: str) -> None:
    tool = MagicMock()
    tool.name = "execute_sql"
    res = guardrail_before_tool_callback(tool, {"query": sql}, MagicMock())
    assert isinstance(res, dict)
    assert res["blocked"] is True
    assert res["error"] == "GUARDRAIL_BLOCKED_DESTRUCTIVE_SQL"


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT census_tract_geoid FROM acs_under5_tract_demographics ORDER BY audit_hispanic_share DESC LIMIT 5",
        "SELECT provider_id FROM t WHERE audit_black_share > 0.3",
        "SELECT provider_id FROM t WHERE (state_code = 'MS') AND audit_indigenous_share >= 0.1",
        "SELECT state_code FROM t GROUP BY state_code HAVING AVG(audit_white_share) < 0.5",
        "SELECT census_tract_geoid, ROW_NUMBER() OVER (ORDER BY audit_asian_share DESC) FROM t",
    ],
)
def test_before_tool_blocks_audit_sort_or_filter(sql: str) -> None:
    tool = MagicMock()
    tool.name = "execute_sql"
    res = guardrail_before_tool_callback(tool, {"query": sql}, MagicMock())
    assert isinstance(res, dict)
    assert res["blocked"] is True
    assert res["error"] == "GUARDRAIL_BLOCKED_AUDIT_SORT_OR_FILTER"


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT census_tract_geoid FROM acs_under5_tract_demographics WHERE limited_english_rate > 0",
        "SELECT census_tract_geoid FROM acs_under5_tract_demographics ORDER BY limited_english_rate DESC",
        "SELECT census_tract_geoid, poverty_rate + 0.5 * limited_english_rate AS score FROM t",
    ],
)
def test_before_tool_blocks_limited_english_rate_trap(sql: str) -> None:
    tool = MagicMock()
    tool.name = "execute_sql"
    res = guardrail_before_tool_callback(tool, {"sql": sql}, MagicMock())
    assert isinstance(res, dict)
    assert res["blocked"] is True
    assert res["error"] == "GUARDRAIL_BLOCKED_LEP_ZERO_TRAP"


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT AVG(audit_black_share) AS black_pct, AVG(audit_hispanic_share) AS hisp_pct FROM acs_under5_tract_demographics WHERE state_code = 'MS' GROUP BY county_name",
        "SELECT census_tract_geoid, limited_english_rate FROM acs_under5_tract_demographics WHERE state_code = 'MS' LIMIT 5",
        "SELECT * FROM GRAPH_TABLE(a4i_early_intervention.ReferralGraph MATCH (c:CareNode)-[r:REFERS_TO]->(e:CareNode) RETURN c.provider_id, e.provider_id) LIMIT 10",
    ],
)
def test_before_tool_allows_safe_readonly_equity_and_gql_reads(sql: str) -> None:
    tool = MagicMock()
    tool.name = "execute_sql"
    res = guardrail_before_tool_callback(tool, {"query": sql}, MagicMock())
    assert res is None


def test_after_model_appends_provenance_and_36m_safeguard(caplog: pytest.LogCaptureFixture) -> None:
    # 1. Substantive response omitting both provenance and 36-month transition callout
    resp1 = LlmResponse(
        content=types.Content(
            role="model",
            parts=[
                types.Part.from_text(
                    text=(
                        "Recommended <=45-day electronic pathway for a 32 months child: "
                        "SYN-PROV-MS-001 -> SYN-PROV-MS-014 (24 days)."
                    )
                )
            ],
        )
    )
    out1 = guardrail_after_model_callback(MagicMock(), resp1)
    assert out1 is not None
    txt1 = out1.content.parts[0].text
    assert "100% [Synthetic]" in txt1
    assert "36-month" in txt1.lower()
    assert "part b" in txt1.lower()

    # 2. Already compliant response must be preserved untouched (returns None)
    resp2 = LlmResponse(
        content=types.Content(
            role="model",
            parts=[
                types.Part.from_text(
                    text=(
                        "Recommended 24-day route via SYN-PROV-MS-001 -> SYN-PROV-MS-014 for a "
                        "32 months toddler. Because the child is near the 36-month Part C cutoff, "
                        "initiate Part B notice. All providers are 100% [Synthetic]."
                    )
                )
            ],
        )
    )
    out2 = guardrail_after_model_callback(MagicMock(), resp2)
    assert out2 is None

    # 3. Malformed SYN-PROV-* ID logs structured warning
    caplog.set_level(logging.WARNING, logger="first_milestones.guardrails")
    resp3 = LlmResponse(
        content=types.Content(
            role="model",
            parts=[types.Part.from_text(text="Checking SYN-PROV-ZZ-9999 (100% [Synthetic]).")],
        )
    )
    guardrail_after_model_callback(MagicMock(), resp3)
    assert any("SYN-PROV-ZZ-9999" in rec.message for rec in caplog.records)

    # 4. Function-call-only response with no text parts returns None cleanly
    resp4 = LlmResponse(
        content=types.Content(
            role="model",
            parts=[types.Part.from_function_call(name="find_viable_45d_paths", args={})],
        )
    )
    assert guardrail_after_model_callback(MagicMock(), resp4) is None


def test_coordinator_agent_sampling_tools_and_callbacks() -> None:
    agent = create_coordinator_agent()
    assert agent.generate_content_config is not None
    assert agent.generate_content_config.temperature == pytest.approx(0.1)
    assert agent.generate_content_config.top_p == pytest.approx(0.9)

    tool_names = {getattr(t, "__name__", getattr(t, "name", str(t))) for t in agent.tools}
    assert "generate_complete_45d_brief" not in tool_names
    for expected_tool in (
        "find_viable_45d_paths",
        "find_compliant_45d_pathways",
        "detect_regional_bottleneck_hubs",
        "audit_multihop_bounce_hubs",
        "simulate_hub_intervention",
        "rank_outreach_zones",
        "prioritize_community_screening_tracts",
        "run_post_output_equity_audit",
    ):
        assert expected_tool in tool_names

    assert agent.before_tool_callback is guardrail_before_tool_callback
    assert agent.after_model_callback is guardrail_after_model_callback

    # Verify prompt alignment symbols
    for phrase in (
        "Never provide a medical diagnosis",
        "limited_english_rate = 0.0",
        "6 `Statewide` rows",
        "100% `[Synthetic]`",
        "run_post_output_equity_audit",
        "find_viable_45d_paths",
        "detect_regional_bottleneck_hubs",
        "rank_outreach_zones",
    ):
        assert phrase in SYSTEM_INSTRUCTION
