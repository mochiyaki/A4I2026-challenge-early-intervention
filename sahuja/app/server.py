"""
FastAPI backend for the First Milestones Split-Screen Coordinator Workbench.

Wraps the Python ADK `root_agent` (powered by Vertex AI Gemini + Google-managed BigQuery MCP
+ custom ISO GQL Property Graph tools) and returns both conversational Markdown and structured
45-Day Pathway & Bottleneck Brief payloads for live visual rendering.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel

SAHUJA_DIR = Path(__file__).resolve().parent.parent
AGENT_DIR = SAHUJA_DIR / "agent"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from early_intervention_agent.agent import MODEL_NAME, root_agent
from early_intervention_agent.gcp_auth import BQ_LOCATION, DATASET, PROJECT, STATE, VERTEX_LOCATION
from early_intervention_agent.tools import pop_turn_payloads

APP_NAME = "first_milestones_sahuja"
STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(
    title="First Milestones — IDEA Part C Early Intervention Triage Workbench",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

session_service = InMemorySessionService()
runner = Runner(
    app_name=APP_NAME,
    agent=root_agent,
    session_service=session_service,
    auto_create_session=True,
)
_turn_lock = asyncio.Lock()

SCENARIOS = [
    {
        "id": "track1_triage",
        "badge": "Track 1 · Today's Referral",
        "title": "Route 22m Spanish/Medi-Cal Toddler (Fresno Tract 06019003103)",
        "prompt": (
            "A pediatric clinic referred a 22-month-old toddler in Census tract 06019003103 (Fresno County) "
            "with Expressive Speech/Language delay concerns. The family speaks Spanish at home, relies on Medi-Cal, "
            "and lives in a high zero-vehicle tract. Find a compliant Clinic -> Coordinator -> Eval Hub -> Therapy Vendor "
            "pathway that clears the 45-day IDEA Part C clock, show which bounce chain we avoid, and draft the bilingual caregiver action note."
        ),
    },
    {
        "id": "track2_audit",
        "badge": "Track 2 · Quarterly Graph Audit",
        "title": "Expose Hidden Multi-Hop Paper-Fax Bounce Hub",
        "prompt": (
            "Run our regional multi-hop network audit across 2-to-4-hop referral chains in ReferralGraph. "
            "Why does Fresno Intake Coordinator SYN-PROV-CA-011 look like our healthiest hub in a flat waitlist spreadsheet, "
            "yet break the 45-day federal mandate across the region?"
        ),
    },
    {
        "id": "bonus_counterfactual",
        "badge": "Bonus · Counterfactual Fix",
        "title": "Simulate Upgrading SYN-PROV-CA-011 to Electronic Intake",
        "prompt": (
            "Simulate upgrading coordinator hub SYN-PROV-CA-011 from paper_fax to electronic e-referral with "
            "pre-checked bilingual and Medi-Cal evaluation slot matching. How many breached cases drop under 45 days "
            "and how many delayed child-days do we save?"
        ),
    },
    {
        "id": "equity_outreach",
        "badge": "Rigor · Equity & Outreach",
        "title": "Run Post-Output Equity Audit & Rank Screening Outreach Tracts",
        "prompt": (
            "Run the Post-Output Equity Audit (including statewide NSCH screening strata and aging-out toddlers near 36 months) "
            "and rank our top 5 high-poverty, zero-vehicle California tracts for mobile developmental screening days "
            "that have verified <=45-day bilingual Medi-Cal capacity."
        ),
    },
]


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    user_id: str = "dds_intake_coordinator"


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "project": PROJECT,
        "dataset": DATASET,
        "bq_location": BQ_LOCATION,
        "vertex_location": VERTEX_LOCATION,
        "state": STATE,
        "model": MODEL_NAME,
        "mcp_server": "https://bigquery.googleapis.com/mcp",
        "property_graph": f"{PROJECT}.{DATASET}.ReferralGraph",
        "data_provenance": "100% [Synthetic] CareNode & ReferralHandoff network; real US Census ACS under-5 tracts; Statewide HRSA NSCH strata.",
    }


@app.get("/api/scenarios")
async def scenarios() -> dict[str, Any]:
    return {"scenarios": SCENARIOS}


@app.post("/api/chat")
async def chat(req: ChatRequest) -> dict[str, Any]:
    msg = (req.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    session_id = req.session_id or f"sess-{uuid.uuid4().hex[:10]}"
    content = types.Content(role="user", parts=[types.Part.from_text(text=msg)])

    tool_calls_log: list[dict[str, Any]] = []
    final_texts: list[str] = []

    async with _turn_lock:
        pop_turn_payloads()
        try:
            async for event in runner.run_async(
                user_id=req.user_id,
                session_id=session_id,
                new_message=content,
            ):
                if getattr(event, "content", None) and getattr(event.content, "parts", None):
                    for part in event.content.parts:
                        fc = getattr(part, "function_call", None)
                        if fc and getattr(fc, "name", None):
                            tool_calls_log.append(
                                {
                                    "name": fc.name,
                                    "args": dict(fc.args) if getattr(fc, "args", None) else {},
                                    "source": "Google BigQuery MCP" if fc.name.startswith("bq_mcp") else "ISO GQL / Spatial Tool",
                                }
                            )
                        txt = getattr(part, "text", None)
                        if txt and event.is_final_response():
                            final_texts.append(txt)
            payloads = pop_turn_payloads()
        except Exception as exc:
            pop_turn_payloads()
            raise HTTPException(status_code=500, detail=f"Agent execution error: {exc}") from exc

    reply = "\n\n".join(t.strip() for t in final_texts if t.strip())
    if not reply:
        reply = "Completed graph analysis—review the updated 45-Day Pathway & Bottleneck Brief on the right."

    return {
        "session_id": session_id,
        "reply": reply,
        "tool_calls": tool_calls_log,
        "brief_updates": payloads,
    }


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))
