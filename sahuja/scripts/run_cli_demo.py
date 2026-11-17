#!/usr/bin/env python3
"""
Interactive / Automated 4-Act CLI Demo Runner for First Milestones (`sahuja/`).

Runs a 4-turn live coordinator session against the ADK agent + BigQuery Property Graph:
  Act 1: Route a 22-month-old Spanish/Medi-Cal toddler in Fresno tract 06019003103 (<=45d)
  Act 2: Expose why SYN-PROV-CA-011 breaks the 45-day mandate despite a 5-day internal wait
  Act 3: Simulate upgrading SYN-PROV-CA-011 from paper_fax to electronic e-referral (+10 Bonus)
  Act 4: Run Post-Output Equity Audit (`audit_*` + Statewide NSCH) & Outreach Tract Ranking
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

SAHUJA_DIR = Path(__file__).resolve().parents[1]
for p in (str(SAHUJA_DIR), str(SAHUJA_DIR / "agent")):
    if p not in sys.path:
        sys.path.insert(0, p)

from early_intervention_agent.agent import root_agent
from early_intervention_agent.tools import pop_turn_payloads

DEMO_TURNS = [
    (
        "ACT 1 · TRACK 1 — Today's Toddler Referral (Fresno Tract 06019003103)",
        "A rural clinic referred a 22-month-old Spanish-speaking Medi-Cal toddler in tract 06019003103 "
        "for Expressive Speech/Language. Find a <=45-day pathway, show the bounce loop we avoid, and "
        "write a brief English/Spanish caregiver action note.",
    ),
    (
        "ACT 2 · TRACK 2 — Quarterly Multi-Hop Bounce Hub Audit",
        "Across 2-to-4-hop referral chains in ReferralGraph, why does Fresno Coordinator SYN-PROV-CA-011 "
        "look healthy in a flat spreadsheet yet drive >45-day breaches?",
    ),
    (
        "ACT 3 · +10 BONUS — Counterfactual Electronic Intake Fix",
        "Simulate switching SYN-PROV-CA-011 from paper_fax to electronic intake with pre-checked "
        "bilingual Medi-Cal evaluation slots. How many breached chains drop <=45 days?",
    ),
    (
        "ACT 4 · RIGOR — Post-Output Equity Audit & Community Screening Priority",
        "Run our Post-Output Equity Audit (including statewide NSCH strata and 36-month aging-out checks) "
        "and list the top 3 California tracts for mobile developmental screening days.",
    ),
]


async def run_demo() -> None:
    runner = Runner(
        app_name="first_milestones_cli_demo",
        agent=root_agent,
        session_service=InMemorySessionService(),
        auto_create_session=True,
    )
    session_id = "demo-session-ca"

    for title, prompt in DEMO_TURNS:
        print("\n" + "=" * 88)
        print(f"  {title}")
        print("=" * 88)
        print(f"COORDINATOR > {prompt}\n")

        pop_turn_payloads()
        content = types.Content(role="user", parts=[types.Part.from_text(text=prompt)])
        tools_called = []
        replies = []

        async for event in runner.run_async(user_id="demo_coordinator", session_id=session_id, new_message=content):
            if getattr(event, "content", None) and getattr(event.content, "parts", None):
                for part in event.content.parts:
                    if getattr(part, "function_call", None):
                        tools_called.append(part.function_call.name)
                    if getattr(part, "text", None) and event.is_final_response():
                        replies.append(part.text)

        payloads = pop_turn_payloads()
        print(f"[Tools Executed]: {tools_called}")
        print(f"[Brief Cards Updated]: {[p['kind'] for p in payloads]}\n")
        print("\n".join(replies))


if __name__ == "__main__":
    asyncio.run(run_demo())
