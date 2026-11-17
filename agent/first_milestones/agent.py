"""Root Python ADK Coordinator & Multi-Agent Split for First Milestones (`first_milestones`).

Compatible with:
  - `adk web agent` (local & Cloud Shell developer UI)
  - `agent/main.py` (Unified Cloud Run FastAPI + Split-Pane Coordinator Workbench UI)
  - `adk deploy agent_engine` (Vertex AI Agent Engine)

Architecture:
  - Coordinator (`first_milestones_coordinator`, default `gemini-2.5-pro` with Option B
    `thinking_budget=128` and Gemini fallback chain) holds governed granular tools and
    delegates multi-track workflows across three specialized `gemini-2.5-flash`
    sub-agents (`thinking_budget=0` for low-latency specialist tool execution):
      1. `triage_pathway_router` (Track 1 Hop-0 packet gatekeeper, `<=45`-day ISO GQL +
         spatial routing, and 48h slot-hold ledger — strictly zero `audit_*`)
      2. `network_bottleneck_auditor` (Track 2 `REFERS_TO` chain history, prefix-deduplicated
         bounce/betweenness audit, agency KPIs, and counterfactual simulation)
      3. `equity_and_caregiver_specialist` (Post-output `audit_*` equity & cohort parity,
         Track 3 hidden EI deserts, public-domain BYOD HRSA FQHC sites, 6-row statewide
         NSCH context, and bilingual EN/ES caregiver action notes)
"""

from __future__ import annotations

import os
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.tools.base_toolset import BaseToolset
from google.genai import types

from .brief_builder import generate_complete_45d_brief
from .guardrails import guardrail_after_model_callback, guardrail_before_tool_callback
from .mcp_integration import load_managed_mcp_tools
from .prompts import (
    AUDIT_SUB_INSTRUCTION,
    EQUITY_SUB_INSTRUCTION,
    SYSTEM_INSTRUCTION,
    TRIAGE_SUB_INSTRUCTION,
)
from .tools import (
    audit_multihop_bounce_hubs,
    check_intake_packet_readiness,
    detect_regional_bottleneck_hubs,
    find_compliant_45d_pathways,
    find_viable_45d_paths,
    get_referral_history,
    list_slot_holds,
    load_byod_hrsa_sites,
    prioritize_community_screening_tracts,
    rank_outreach_zones,
    release_slot_hold,
    reserve_pathway_slot,
    run_post_output_equity_audit,
    simulate_hub_intervention,
)
from .tools.bq_client import VALID_STATES, get_config
from .tools.reference_lookups import (
    BYOD_HRSA_PROVENANCE,
    lookup_carenode_directory,
    lookup_regional_agency_kpis,
    lookup_statewide_nsch_strata,
    lookup_tract_routing_context,
)


def lookup_byod_hrsa_screening_sites(
    state_code: str = "",
    top_n: int = 8,
) -> dict[str, Any]:
    """Lists real public-domain HRSA FQHC / Look-Alike community screening sites (`17 U.S.C. § 105`).

    Wraps `load_byod_hrsa_sites` into a compact JSON-serializable tool response for Track 3
    mobile developmental screening outreach planning (strictly free of `audit_*` columns).

    Args:
        state_code: Optional 2-letter state code (`MS`, `AL`, `GA`, `TX`, `CA`, `NY`);
            defaults to active request state.
        top_n: Maximum HRSA delivery sites to return (`1-15`, default `8`).
    """
    cfg = get_config()
    raw_state = (state_code or cfg["state"]).strip().upper()
    if raw_state not in VALID_STATES:
        return {
            "status": "validation_error",
            "error_code": "INVALID_STATE_CODE",
            "state_code": raw_state,
            "message": f"Unsupported state_code={state_code!r}. Valid states: {sorted(VALID_STATES)}.",
            "sites": [],
        }
    try:
        limit = 8 if top_n is None else max(1, min(int(top_n), 15))
    except (TypeError, ValueError):
        limit = 8

    df = load_byod_hrsa_sites(raw_state)
    total_sites = int(len(df))
    keep_cols = [
        c
        for c in (
            "hrsa_site_id",
            "site_name",
            "health_center_name",
            "site_city",
            "state_code",
            "county_fips",
            "county_name",
            "latitude",
            "longitude",
            "operating_hours_per_week",
        )
        if c in df.columns
    ]
    records = df[keep_cols].head(limit).to_dict(orient="records") if not df.empty else []
    return {
        "status": "ok",
        "state_code": raw_state,
        "provenance": BYOD_HRSA_PROVENANCE,
        "total_sites_in_state": total_sites,
        "returned_count": len(records),
        "sites": records,
    }


DEFAULT_MODEL = os.environ.get("A4I_GEMINI_MODEL", "gemini-2.5-pro").strip() or "gemini-2.5-pro"
_DEFAULT_FALLBACK_STR = "gemini-2.5-flash,gemini-3-flash-preview,gemini-3.1-pro-preview"
FALLBACK_MODELS: list[str] = [
    m.strip()
    for m in os.environ.get("A4I_GEMINI_FALLBACK_MODELS", _DEFAULT_FALLBACK_STR).split(",")
    if m.strip()
]
SUBAGENT_MODEL = os.environ.get("A4I_SUBAGENT_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"


def _build_generate_content_config(model_name: Any) -> types.GenerateContentConfig:
    """Builds a low-latency GenerateContentConfig with Option B model-appropriate thinking_budget."""
    raw_name = model_name if isinstance(model_name, str) else str(getattr(model_name, "model", ""))
    low = (raw_name or "").strip().lower()
    if "2.5-pro" in low:
        return types.GenerateContentConfig(
            temperature=0.1,
            top_p=0.9,
            thinking_config=types.ThinkingConfig(thinking_budget=128),
        )
    if "2.5-flash" in low:
        return types.GenerateContentConfig(
            temperature=0.1,
            top_p=0.9,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        )
    return types.GenerateContentConfig(
        temperature=0.1,
        top_p=0.9,
    )


def get_model_candidates() -> list[str]:
    """Returns ordered, deduplicated Gemini model chain `[primary, *backups]`."""
    seen: set[str] = set()
    ordered: list[str] = []
    for candidate in [DEFAULT_MODEL, *FALLBACK_MODELS]:
        if candidate and candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)
    return ordered


managed_mcp_tools, ACTIVE_MCP_MODE = load_managed_mcp_tools()
_managed_toolsets: list[BaseToolset] = [
    t for t in managed_mcp_tools if isinstance(t, BaseToolset)
]

triage_mcp_tools: list[Any] = [
    *_managed_toolsets,
    lookup_tract_routing_context,
    lookup_carenode_directory,
]
audit_mcp_tools: list[Any] = [
    *_managed_toolsets,
    lookup_regional_agency_kpis,
    lookup_carenode_directory,
]
equity_mcp_tools: list[Any] = [
    *_managed_toolsets,
    lookup_statewide_nsch_strata,
    lookup_tract_routing_context,
]

SHARED_TOOLS: list[Any] = [
    check_intake_packet_readiness,
    find_compliant_45d_pathways,
    find_viable_45d_paths,
    reserve_pathway_slot,
    list_slot_holds,
    get_referral_history,
    audit_multihop_bounce_hubs,
    detect_regional_bottleneck_hubs,
    simulate_hub_intervention,
    run_post_output_equity_audit,
    prioritize_community_screening_tracts,
    rank_outreach_zones,
    lookup_byod_hrsa_screening_sites,
    *managed_mcp_tools,
]

SUBAGENT_METADATA: dict[str, dict[str, Any]] = {
    "triage_pathway_router": {
        "name": "triage_pathway_router",
        "role": "Track 1 <=45-Day Pathway, Gatekeeper & Slot-Hold Router",
        "track": "track_1_routing",
        "model": SUBAGENT_MODEL,
        "tools": [
            "check_intake_packet_readiness",
            "find_compliant_45d_pathways",
            "find_viable_45d_paths",
            "reserve_pathway_slot",
            "list_slot_holds",
            "lookup_tract_routing_context",
            "lookup_carenode_directory",
        ],
    },
    "network_bottleneck_auditor": {
        "name": "network_bottleneck_auditor",
        "role": "Track 2 Multi-Hop Bounce, History & Counterfactual Auditor",
        "track": "track_2_audit",
        "model": SUBAGENT_MODEL,
        "tools": [
            "get_referral_history",
            "audit_multihop_bounce_hubs",
            "detect_regional_bottleneck_hubs",
            "simulate_hub_intervention",
            "lookup_regional_agency_kpis",
            "lookup_carenode_directory",
        ],
    },
    "equity_and_caregiver_specialist": {
        "name": "equity_and_caregiver_specialist",
        "role": "Post-Output Equity, Track 3 BYOD Outreach & EN/ES Caregiver Specialist",
        "track": "track_3_equity_and_caregiver",
        "model": SUBAGENT_MODEL,
        "tools": [
            "run_post_output_equity_audit",
            "prioritize_community_screening_tracts",
            "rank_outreach_zones",
            "lookup_byod_hrsa_screening_sites",
            "generate_complete_45d_brief",
            "lookup_statewide_nsch_strata",
            "lookup_tract_routing_context",
        ],
    },
}


def create_triage_sub_agent(model_name: str = SUBAGENT_MODEL) -> LlmAgent:
    """Instantiates a fresh Track 1 `triage_pathway_router` Flash sub-agent."""
    return LlmAgent(
        name="triage_pathway_router",
        model=model_name,
        description=(
            "Track 1 specialist for Hop-0 packet readiness, <=45-day IDEA Part C multi-hop "
            "ISO GQL + spatial child referral routing, 48h slot holds, 5-tier 36-month "
            "transition rules, and zero-vehicle NEMT (strictly isolated from audit_* columns)."
        ),
        instruction=TRIAGE_SUB_INSTRUCTION,
        tools=[
            check_intake_packet_readiness,
            find_compliant_45d_pathways,
            find_viable_45d_paths,
            reserve_pathway_slot,
            list_slot_holds,
            *triage_mcp_tools,
        ],
        generate_content_config=_build_generate_content_config(model_name),
        before_tool_callback=guardrail_before_tool_callback,
        after_model_callback=guardrail_after_model_callback,
    )


def create_audit_sub_agent(model_name: str = SUBAGENT_MODEL) -> LlmAgent:
    """Instantiates a fresh Track 2 `network_bottleneck_auditor` Flash sub-agent."""
    return LlmAgent(
        name="network_bottleneck_auditor",
        model=model_name,
        description=(
            "Track 2 specialist for REFERS_TO chain history, prefix-deduplicated -{2,4}-> "
            "ReferralGraph bounce-hub detection, betweenness flow attribution, OSEP Indicator C7 "
            "agency KPIs, and counterfactual paper_fax-to-EHR intervention simulation."
        ),
        instruction=AUDIT_SUB_INSTRUCTION,
        tools=[
            get_referral_history,
            audit_multihop_bounce_hubs,
            detect_regional_bottleneck_hubs,
            simulate_hub_intervention,
            *audit_mcp_tools,
        ],
        generate_content_config=_build_generate_content_config(model_name),
        before_tool_callback=guardrail_before_tool_callback,
        after_model_callback=guardrail_after_model_callback,
    )


def create_equity_sub_agent(model_name: str = SUBAGENT_MODEL) -> LlmAgent:
    """Instantiates a fresh `equity_and_caregiver_specialist` Flash sub-agent."""
    return LlmAgent(
        name="equity_and_caregiver_specialist",
        model=model_name,
        description=(
            "Specialist for strictly post-output audit_* neighborhood equity & cohort parity audits, "
            "Track 3 hidden Early Intervention desert & public-domain HRSA FQHC screening outreach, "
            "6-row Statewide HRSA NSCH screening context, and warm English/Español caregiver notes."
        ),
        instruction=EQUITY_SUB_INSTRUCTION,
        tools=[
            run_post_output_equity_audit,
            prioritize_community_screening_tracts,
            rank_outreach_zones,
            lookup_byod_hrsa_screening_sites,
            generate_complete_45d_brief,
            *equity_mcp_tools,
        ],
        generate_content_config=_build_generate_content_config(model_name),
        before_tool_callback=guardrail_before_tool_callback,
        after_model_callback=guardrail_after_model_callback,
    )


def create_sub_agents(model_name: str = SUBAGENT_MODEL) -> list[LlmAgent]:
    """Creates fresh instances of all three specialist Flash sub-agents."""
    return [
        create_triage_sub_agent(model_name=model_name),
        create_audit_sub_agent(model_name=model_name),
        create_equity_sub_agent(model_name=model_name),
    ]


def create_coordinator_agent(
    model_name: str = DEFAULT_MODEL,
    subagent_model: str = SUBAGENT_MODEL,
) -> LlmAgent:
    """Instantiates the First Milestones coordinator agent with fresh specialist sub-agents."""
    return LlmAgent(
        name="first_milestones_coordinator",
        model=model_name,
        description=(
            "IDEA Part C Early Intervention Triage & Multi-Hop Referral Network Audit "
            "Assistant powered by BigQuery Property Graphs (ISO GQL), Google-managed MCP, "
            "and Gemini."
        ),
        instruction=SYSTEM_INSTRUCTION,
        tools=SHARED_TOOLS,
        sub_agents=create_sub_agents(model_name=subagent_model),
        generate_content_config=_build_generate_content_config(model_name),
        before_tool_callback=guardrail_before_tool_callback,
        after_model_callback=guardrail_after_model_callback,
    )


root_agent = create_coordinator_agent(DEFAULT_MODEL, SUBAGENT_MODEL)

__all__ = [
    "ACTIVE_MCP_MODE",
    "DEFAULT_MODEL",
    "FALLBACK_MODELS",
    "SHARED_TOOLS",
    "SUBAGENT_METADATA",
    "SUBAGENT_MODEL",
    "check_intake_packet_readiness",
    "create_audit_sub_agent",
    "create_coordinator_agent",
    "create_equity_sub_agent",
    "create_sub_agents",
    "create_triage_sub_agent",
    "get_model_candidates",
    "get_referral_history",
    "list_slot_holds",
    "load_byod_hrsa_sites",
    "lookup_byod_hrsa_screening_sites",
    "release_slot_hold",
    "reserve_pathway_slot",
    "root_agent",
]
