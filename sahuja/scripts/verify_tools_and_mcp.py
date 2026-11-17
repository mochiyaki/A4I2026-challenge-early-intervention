#!/usr/bin/env python3
"""Tests all 5 custom BigQuery Property Graph (ISO GQL) tools, BigQuery MCP, and a live ADK Runner turn."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import requests
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

SAHUJA_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SAHUJA_DIR / "agent"))

from early_intervention_agent.agent import root_agent
from early_intervention_agent.gcp_auth import PROJECT, get_access_token
from early_intervention_agent.tools import (
    audit_regional_bounce_hubs,
    pop_turn_payloads,
    rank_screening_outreach_tracts,
    route_toddler_referral_45d,
    run_post_output_equity_audit,
    simulate_bottleneck_fix,
)


def check_bigquery_mcp() -> None:
    print("=== 0) Testing Google-Managed BigQuery MCP Server (https://bigquery.googleapis.com/mcp) ===")
    tok = get_access_token()
    resp = requests.post(
        "https://bigquery.googleapis.com/mcp",
        headers={
            "Authorization": f"Bearer {tok}",
            "x-goog-user-project": PROJECT,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "first-milestones-test", "version": "1.0.0"},
            },
        },
        timeout=20,
    )
    assert resp.status_code == 200, f"BigQuery MCP failed: {resp.status_code} {resp.text}"
    print("  MCP HTTP 200 OK:", resp.text[:180])


async def check_adk_runner() -> None:
    print("\n=== 6) Testing Live ADK Runner (Gemini + BigQuery MCP + ISO GQL Tools) ===")
    pop_turn_payloads()
    runner = Runner(
        app_name="test_sahuja",
        agent=root_agent,
        session_service=InMemorySessionService(),
        auto_create_session=True,
    )
    msg = types.Content(
        role="user",
        parts=[
            types.Part.from_text(
                text=(
                    "Route a 22-month-old Spanish-speaking Medi-Cal toddler in tract 06019003103 "
                    "for Expressive Speech/Language under the 45-day IDEA Part C clock."
                )
            )
        ],
    )
    calls = []
    texts = []
    async for ev in runner.run_async(user_id="tester", session_id="s1", new_message=msg):
        if getattr(ev, "content", None) and getattr(ev.content, "parts", None):
            for part in ev.content.parts:
                if getattr(part, "function_call", None):
                    calls.append(part.function_call.name)
                if getattr(part, "text", None) and ev.is_final_response():
                    texts.append(part.text)
    payloads = pop_turn_payloads()
    print("  ADK tool calls invoked:", calls)
    print("  Structured brief payloads captured:", [p["kind"] for p in payloads])
    print("  Final response preview:", (texts[-1][:320] if texts else "NONE"))
    assert calls, "Expected ADK agent to invoke at least one tool"
    assert texts, "Expected ADK agent to return a final response"


def main() -> None:
    check_bigquery_mcp()

    print("\n=== 1) Testing route_toddler_referral_45d ===")
    r1 = route_toddler_referral_45d("06019003103", 22, "Expressive Speech/Language", True, True, "Spanish")
    rec = r1["recommended_pathway"]
    print("  Recommended:", rec["pathway_type"], "| total_days:", rec["expected_total_days"], "| nodes:", [n["provider_id"] for n in rec["nodes"]])
    print("  Contrasted broken chain:", r1["contrasted_broken_bounce_chain"]["case_chain_id"], r1["contrasted_broken_bounce_chain"]["total_wait_days"], "days")

    print("\n=== 2) Testing audit_regional_bounce_hubs ===")
    r2 = audit_regional_bounce_hubs()
    print("  Key finding:", r2["key_finding"])

    print("\n=== 3) Testing simulate_bottleneck_fix ===")
    r3 = simulate_bottleneck_fix("SYN-PROV-CA-011")
    print("  Summary:", json.dumps(r3["summary"]))

    print("\n=== 4) Testing run_post_output_equity_audit ===")
    r4 = run_post_output_equity_audit()
    print("  Equity rows:", json.dumps(r4["breach_vs_timely_tract_demographics"]))
    print("  Aging-out breached cases (30m+):", len(r4["toddlers_near_36m_aging_out_cliff_in_breached_chains"]))

    print("\n=== 5) Testing rank_screening_outreach_tracts ===")
    r5 = rank_screening_outreach_tracts(4)
    print("  Top tract:", r5["priority_outreach_tracts"][0]["census_tract_geoid"], r5["priority_outreach_tracts"][0]["county_name"])

    asyncio.run(check_adk_runner())
    print("\nALL 6 VERIFICATION CHECKS PASSED!")


if __name__ == "__main__":
    main()
