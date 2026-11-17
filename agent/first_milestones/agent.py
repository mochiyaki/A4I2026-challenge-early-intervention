"""Root Python ADK Coordinator & Multi-Agent Split for First Milestones (`first_milestones`).

Compatible with:
  - `adk web agent` (local & Cloud Shell developer UI)
  - `agent/main.py` (Unified Cloud Run FastAPI + Split-Pane Coordinator Workbench UI)
  - `adk deploy agent_engine` (Vertex AI Agent Engine)

Architecture:
  - Coordinator (`first_milestones_coordinator`, default `gemini-2.5-pro` with Gemini
    fallback chain) holds governed granular tools and delegates multi-track workflows
    across three specialized `gemini-2.5-flash` sub-agents:
      1. `triage_pathway_router` (Track 1 `<=45`-day ISO GQL + spatial routing, zero `audit_*`)
      2. `network_bottleneck_auditor` (Track 2 prefix-deduplicated bounce & counterfactual audit)
      3. `equity_and_caregiver_specialist` (Post-output `audit_*` equity, Track 3 hidden EI
         deserts, 6-row statewide NSCH context, and bilingual EN/ES caregiver action notes)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib
import os
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.tools.base_toolset import BaseToolset
from google.genai import types

from .brief_builder import _compute_statutory_transition_tier, generate_complete_45d_brief
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
    detect_regional_bottleneck_hubs,
    find_compliant_45d_pathways,
    find_viable_45d_paths,
    get_referral_history,
    prioritize_community_screening_tracts,
    rank_outreach_zones,
    run_post_output_equity_audit,
    simulate_hub_intervention,
)
from .tools.bq_client import get_config, load_local_state_frames
from .tools.reference_lookups import (
    lookup_carenode_directory,
    lookup_regional_agency_kpis,
    lookup_statewide_nsch_strata,
    lookup_tract_routing_context,
)

try:
    from .tools.packet_gatekeeper import check_intake_packet_readiness  # type: ignore[import-not-found]
except ImportError:

    def check_intake_packet_readiness(
        child_age_months: int = 32,
        consent_signed: bool = True,
        screening_tool_completed: bool = True,
        primary_language: str = "Spanish",
        insurance_status: str = "Medicaid",
        concern_domain: str = "Social-Communication / Autism Screen",
        has_household_vehicle: bool = False,
        referral_channel: str = "ehr_electronic_portal",
    ) -> dict[str, Any]:
        """Validates Hop-0 IDEA Part C intake packet readiness before referral transmission.

        Args:
            child_age_months: Child age in months (`0-35` Part C, `>=36` Part B § 619).
            consent_signed: Whether caregiver referral consent is signed.
            screening_tool_completed: Whether a standardized developmental screen/concern is attached.
            primary_language: Family preferred language (`English`, `Spanish`, etc.).
            insurance_status: Coverage type (`Medicaid`, `Commercial`, etc.).
            concern_domain: Primary developmental concern domain.
            has_household_vehicle: Whether household has reliable vehicle access.
            referral_channel: Transmission channel (`ehr_electronic_portal` vs `paper_fax`).
        """
        try:
            mod = importlib.import_module("first_milestones.tools.packet_gatekeeper")
            fn = getattr(mod, "check_intake_packet_readiness", None)
            if callable(fn):
                return fn(
                    child_age_months=child_age_months,
                    consent_signed=consent_signed,
                    screening_tool_completed=screening_tool_completed,
                    primary_language=primary_language,
                    insurance_status=insurance_status,
                    concern_domain=concern_domain,
                    has_household_vehicle=has_household_vehicle,
                    referral_channel=referral_channel,
                )
        except Exception:  # noqa: BLE001
            pass

        cfg = get_config()
        missing: list[str] = []
        if not consent_signed:
            missing.append("signed_parental_consent")
        if not screening_tool_completed:
            missing.append("developmental_screening_summary")
        if not str(primary_language or "").strip():
            missing.append("primary_language")
        if not str(insurance_status or "").strip():
            missing.append("insurance_status")
        if not str(concern_domain or "").strip():
            missing.append("concern_domain")

        tier = _compute_statutory_transition_tier(child_age_months)
        aged_out = int(child_age_months) >= 36
        ready = (len(missing) == 0) and (not aged_out)
        warnings: list[str] = []
        if referral_channel == "paper_fax":
            warnings.append("Upgrade paper_fax to ehr_electronic_portal to prevent Hop-1 intake bounce.")
        if not has_household_vehicle:
            warnings.append("Zero-vehicle household: attach Medicaid NEMT or Natural Environment home visit request.")
        if aged_out:
            warnings.append("Child >=36 months is ineligible for Part C; route to IDEA Part B Section 619 via LEA.")

        return {
            "status": "ineligible_part_c_aged_out" if aged_out else ("ready" if ready else "incomplete_packet"),
            "state_code": cfg["state"],
            "ready": ready,
            "missing_items": missing,
            "statutory_transition_tier": tier,
            "warnings": warnings,
            "synthetic_provenance_notice": "100% [Synthetic] Hop-0 gatekeeper telemetry.",
        }


try:
    from .tools.slot_ledger import reserve_pathway_slot  # type: ignore[import-not-found]
except ImportError:
    _FALLBACK_SLOT_HOLDS: list[dict[str, Any]] = []

    def reserve_pathway_slot(
        provider_id: str = "",
        child_tract_geoid: str = "",
        concern_domain: str = "Social-Communication / Autism Screen",
        needs_medicaid: bool = True,
        needs_bilingual: bool = True,
        hold_hours: int = 48,
        case_reference: str = "",
    ) -> dict[str, Any]:
        """Places a soft 48-hour slot hold on a verified Part C evaluation or therapy provider.

        Args:
            provider_id: Target `SYN-PROV-*` ID (defaults to first uncongested Eval Hub in active state).
            child_tract_geoid: Optional 11-digit Census tract GEOID.
            concern_domain: Primary developmental concern domain.
            needs_medicaid: Whether Medicaid enrollment is required.
            needs_bilingual: Whether Spanish-bilingual capacity is required.
            hold_hours: Soft hold duration in hours (`1-168`, defaults to `48`).
            case_reference: Optional coordinator case token.
        """
        try:
            mod = importlib.import_module("first_milestones.tools.slot_ledger")
            fn = getattr(mod, "reserve_pathway_slot", None)
            if callable(fn):
                return fn(
                    provider_id=provider_id,
                    child_tract_geoid=child_tract_geoid,
                    concern_domain=concern_domain,
                    needs_medicaid=needs_medicaid,
                    needs_bilingual=needs_bilingual,
                    hold_hours=hold_hours,
                    case_reference=case_reference,
                )
        except Exception:  # noqa: BLE001
            pass

        cfg = get_config()
        state = cfg["state"]
        prov_df = load_local_state_frames(state)["providers"]
        chosen_pid = provider_id.strip().upper()
        matched = prov_df[prov_df["provider_id"] == chosen_pid] if chosen_pid else prov_df[
            prov_df["node_role"].isin(["Multidisciplinary_Eval_Hub", "EI_Therapy_Vendor"])
        ].head(1)
        if matched.empty:
            return {
                "status": "validation_error",
                "error_code": "PROVIDER_NOT_FOUND",
                "state_code": state,
                "message": f"Provider {chosen_pid or '(none)'} not found in {state}.",
            }
        row = matched.iloc[0]
        pid = str(row["provider_id"])
        now = datetime.now(timezone.utc)
        hours = max(1, min(168, int(hold_hours)))
        hold_record = {
            "hold_id": f"HOLD-{state}-{len(_FALLBACK_SLOT_HOLDS) + 1:03d}",
            "state_code": state,
            "provider_id": pid,
            "provider_name": str(row["synthetic_organization_name"]),
            "node_role": str(row["node_role"]),
            "child_tract_geoid": child_tract_geoid,
            "concern_domain": concern_domain,
            "needs_medicaid": bool(needs_medicaid),
            "needs_bilingual": bool(needs_bilingual),
            "hold_hours": hours,
            "created_at": now.isoformat(),
            "expires_at": (now + timedelta(hours=hours)).isoformat(),
            "status": "active",
            "case_reference": case_reference or "HOP1-PENDING",
        }
        _FALLBACK_SLOT_HOLDS.append(hold_record)
        return {
            "status": "reserved",
            "hold": hold_record,
            "active_holds_count": len(_FALLBACK_SLOT_HOLDS),
            "synthetic_provenance_notice": "100% [Synthetic] CareNode slot ledger.",
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
    """Builds a low-latency GenerateContentConfig with model-appropriate thinking_budget."""
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
    get_referral_history,
    audit_multihop_bounce_hubs,
    detect_regional_bottleneck_hubs,
    simulate_hub_intervention,
    run_post_output_equity_audit,
    prioritize_community_screening_tracts,
    rank_outreach_zones,
    *managed_mcp_tools,
]

SUBAGENT_METADATA: dict[str, dict[str, Any]] = {
    "triage_pathway_router": {
        "name": "triage_pathway_router",
        "role": "Track 1 <=45-Day Pathway & Mobility Router",
        "track": "track_1_routing",
        "model": SUBAGENT_MODEL,
        "tools": [
            "check_intake_packet_readiness",
            "find_compliant_45d_pathways",
            "find_viable_45d_paths",
            "reserve_pathway_slot",
            "lookup_tract_routing_context",
            "lookup_carenode_directory",
        ],
    },
    "network_bottleneck_auditor": {
        "name": "network_bottleneck_auditor",
        "role": "Track 2 Multi-Hop Bounce & Counterfactual Auditor",
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
        "role": "Post-Output Equity, Track 3 Outreach & EN/ES Caregiver Specialist",
        "track": "track_3_equity_and_caregiver",
        "model": SUBAGENT_MODEL,
        "tools": [
            "run_post_output_equity_audit",
            "prioritize_community_screening_tracts",
            "rank_outreach_zones",
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
            "Track 1 specialist for <=45-day IDEA Part C multi-hop ISO GQL + spatial "
            "child referral routing, 36-month aging-out alerts, and zero-vehicle NEMT "
            "(strictly isolated from post-output audit_* demographic columns)."
        ),
        instruction=TRIAGE_SUB_INSTRUCTION,
        tools=[
            check_intake_packet_readiness,
            find_compliant_45d_pathways,
            find_viable_45d_paths,
            reserve_pathway_slot,
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
            "Track 2 specialist for prefix-deduplicated -{2,4}-> ReferralGraph bounce-hub "
            "detection, betweenness flow attribution, OSEP Indicator C7 agency KPIs, and "
            "counterfactual paper_fax-to-EHR intervention simulation."
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
            "Specialist for strictly post-output audit_* neighborhood equity audits, "
            "Track 3 hidden Early Intervention desert & mobile screening prioritization, "
            "6-row Statewide HRSA NSCH screening context, and warm English/Español caregiver notes."
        ),
        instruction=EQUITY_SUB_INSTRUCTION,
        tools=[
            run_post_output_equity_audit,
            prioritize_community_screening_tracts,
            rank_outreach_zones,
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
    "reserve_pathway_slot",
    "root_agent",
]
