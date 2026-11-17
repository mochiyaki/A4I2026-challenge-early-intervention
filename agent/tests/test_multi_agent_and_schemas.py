"""Comprehensive test suite for Multi-Agent Flash Sub-Agents & Pydantic v2 Brief/API Schemas."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import AsyncGenerator

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import ValidationError

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import first_milestones  # noqa: E402
from first_milestones import (  # noqa: E402
    PathwayBrief,
    SUBAGENT_MODEL,
    create_coordinator_agent,
    create_sub_agents,
    root_agent,
)
from first_milestones.agent import (  # noqa: E402
    DEFAULT_MODEL,
    SUBAGENT_METADATA,
    create_audit_sub_agent,
    create_equity_sub_agent,
    create_triage_sub_agent,
    get_model_candidates,
)
from first_milestones.brief_builder import (  # noqa: E402
    build_caregiver_notes,
    build_validated_45d_brief_model,
    generate_complete_45d_brief,
)
from first_milestones.guardrails import (  # noqa: E402
    guardrail_after_model_callback,
    guardrail_before_tool_callback,
)
from first_milestones.prompts import (  # noqa: E402
    AUDIT_SUB_INSTRUCTION,
    EQUITY_SUB_INSTRUCTION,
    SYSTEM_INSTRUCTION,
    TRIAGE_SUB_INSTRUCTION,
)
from first_milestones.schemas import (  # noqa: E402
    CaregiverNotes,
    ChatRequestModel,
    ChildProfile,
    GovernanceAttestation,
    HopStep,
    NschStratum,
    OutreachZoneRow,
    RecommendedPathway,
    RunStreamRequestModel,
    SSEStreamEvent,
    ScreeningPriorityTract,
    SimulateRequestModel,
    ViablePathCandidate,
    ViablePathsResult,
)
from first_milestones.tools.bq_client import VALID_STATES, request_state_context  # noqa: E402


def _tool_names(agent_obj: object) -> set[str]:
    tools = getattr(agent_obj, "tools", [])
    return {getattr(t, "__name__", getattr(t, "name", str(t))) for t in tools}


@pytest.mark.parametrize(
    ("state_code", "expected_geoid_prefix"),
    [
        ("MS", "28"),
        ("AL", "01"),
        ("GA", "13"),
        ("TX", "48"),
        ("CA", "06"),
        ("NY", "36"),
    ],
)
def test_pathway_brief_validates_all_six_starter_states_and_leading_zeros(
    state_code: str,
    expected_geoid_prefix: str,
) -> None:
    """Validates `PathwayBrief` across all 6 starter states including '01...' and '06...' GEOIDs."""
    assert state_code in VALID_STATES
    with request_state_context(state_code):
        model = build_validated_45d_brief_model(
            child_tract_geoid="",
            child_age_months=32,
            concern_domain="Social-Communication / Autism Screen",
            needs_medicaid=True,
            needs_bilingual=True,
            has_household_vehicle=False,
        )
        dumped = generate_complete_45d_brief(
            child_tract_geoid="",
            child_age_months=32,
            concern_domain="Social-Communication / Autism Screen",
            needs_medicaid=True,
            needs_bilingual=True,
            has_household_vehicle=False,
        )

    assert isinstance(model, PathwayBrief)
    assert model.state_code == state_code
    assert dumped["state_code"] == state_code

    geoid = model.routing.child_profile.home_tract_geoid
    assert len(geoid) == 11
    assert geoid.startswith(expected_geoid_prefix)

    viable_geoid = model.viable_45d_paths.tract_context["census_tract_geoid"]
    assert len(viable_geoid) == 11
    assert viable_geoid.startswith(expected_geoid_prefix)

    assert model.routing.recommended_pathway is not None
    assert model.routing.recommended_pathway.clears_45_day_clock is True
    assert model.routing.recommended_pathway.expected_cumulative_days <= 45
    assert len(model.equity_audit.statewide_nsch_screening_context) == 6
    assert len(model.caregiver_notes.english) > 80
    assert len(model.caregiver_notes.spanish) > 80


def test_pathway_brief_handles_aged_out_36_month_part_b_referral_cleanly() -> None:
    """Children aged >=36 months trigger structured Part B Section 619 early return that still validates."""
    with request_state_context("MS"):
        model = build_validated_45d_brief_model(
            child_tract_geoid="28049003500",
            child_age_months=37,
        )
    assert model.routing.status == "ineligible_part_c_aged_out"
    assert model.routing.recommended_pathway is None
    alert_codes = {a.code for a in model.routing.guardrail_alerts}
    assert "IDEA_PART_C_AGED_OUT_REFER_PART_B_619" in alert_codes
    assert len(model.caregiver_notes.english) > 40
    assert len(model.caregiver_notes.spanish) > 40


@pytest.mark.parametrize(
    "forbidden_audit_col",
    [
        "audit_black_share",
        "audit_hispanic_share",
        "audit_asian_share",
        "audit_indigenous_share",
        "audit_white_share",
        "audit_custom_demographic_pct",
    ],
)
def test_child_profile_anti_bias_firewall_rejects_all_audit_columns(
    forbidden_audit_col: str,
) -> None:
    """`ChildProfile` must raise `ValidationError` if any `audit_*` column is injected."""
    base_profile = {
        "state_code": "MS",
        "home_tract_geoid": "28049003500",
        "county_name": "Hinds County",
        "tract_children_under_5": 310,
        "tract_poverty_pct": 38.4,
        "tract_zero_vehicle_pct": 16.2,
        "child_age_months": 31,
        forbidden_audit_col: 0.42,
    }
    with pytest.raises(ValidationError, match="Anti-Bias Routing Firewall"):
        ChildProfile.model_validate(base_profile)


def test_recommended_pathway_and_routing_models_reject_audit_keys() -> None:
    """`RecommendedPathway`, `HopStep`, `ViablePathCandidate`, `ViablePathsResult`, and `ScreeningPriorityTract` reject `audit_*`."""
    valid_hop = {
        "hop_sequence": 1,
        "source_provider_id": "SYN-PROV-MS-001",
        "target_provider_id": "SYN-PROV-MS-010",
        "target_name": "Magnolia Intake Desk [Synthetic]",
        "target_role": "Part_C_Intake_Coordinator",
        "transmission_channel": "ehr_electronic_portal",
        "handoff_wait_days": 6,
        "cumulative_wait_days": 6,
    }
    assert HopStep.model_validate(valid_hop).hop_sequence == 1

    with pytest.raises(ValidationError, match="Anti-Bias Routing Firewall"):
        HopStep.model_validate({**valid_hop, "audit_hispanic_share": 0.35})

    valid_pathway = {
        "pathway_type": "3-Hop Evaluation + IFSP Route",
        "total_hops": 3,
        "expected_cumulative_days": 28,
        "clears_45_day_clock": True,
        "hops": [valid_hop],
    }
    assert RecommendedPathway.model_validate(valid_pathway).expected_cumulative_days == 28

    # Top-level audit_* injection on RecommendedPathway
    with pytest.raises(ValidationError, match="Anti-Bias Routing Firewall"):
        RecommendedPathway.model_validate({**valid_pathway, "audit_black_share": 0.61})

    # Nested hop audit_* injection inside RecommendedPathway
    with pytest.raises(ValidationError, match="Anti-Bias Routing Firewall"):
        RecommendedPathway.model_validate(
            {**valid_pathway, "hops": [{**valid_hop, "audit_white_share": 0.22}]}
        )

    # ViablePathCandidate & ViablePathsResult.tract_context
    with pytest.raises(ValidationError, match="Anti-Bias Routing Firewall"):
        ViablePathCandidate.model_validate(
            {
                "start_provider_id": "SYN-PROV-MS-001",
                "start_name": "Clinic [Synthetic]",
                "eval_provider_id": "SYN-PROV-MS-028",
                "eval_name": "Therapy [Synthetic]",
                "eval_role": "EI_Therapy_Vendor",
                "hop_count": 3,
                "intake_lag_days": 6,
                "handoff_days": 11,
                "evaluator_backlog_days": 10,
                "total_expected_days": 27,
                "audit_indigenous_share": 0.08,
            }
        )

    with pytest.raises(ValidationError, match="Anti-Bias Routing Firewall"):
        ViablePathsResult.model_validate(
            {
                "engine": "local_geoparquet_mirror",
                "synthetic_provenance_notice": "100% [Synthetic]",
                "tract_context": {
                    "state_code": "CA",
                    "census_tract_geoid": "06047000801",
                    "audit_asian_share": 0.19,
                },
            }
        )

    with pytest.raises(ValidationError, match="Anti-Bias Routing Firewall"):
        ScreeningPriorityTract.model_validate(
            {
                "census_tract_geoid": "01073001200",
                "county_name": "Jefferson County",
                "children_under_5_count": 250,
                "poverty_pct": 34.0,
                "zero_vehicle_pct": 14.0,
                "non_racial_outreach_priority_score": 41.2,
                "verified_downstream_45d_pathway": {"clears_45d_mandate": True},
                "audit_black_share": 0.55,
            }
        )


def test_outreach_zone_row_allows_post_output_equity_context_but_blocks_top_level_audit() -> None:
    """`OutreachZoneRow` permits `audit_*` inside `post_output_equity_context` only."""
    valid_zone = {
        "census_tract_geoid": "06047000801",
        "county_name": "Merced County",
        "children_under_5_count": 410,
        "poverty_pct": 39.5,
        "zero_vehicle_pct": 15.1,
        "nearest_any_clinic_km": 7.2,
        "reachable_45d_paths_count": 0,
        "is_hidden_ei_desert": True,
        "mobility_support_recommended": True,
        "outreach_priority_score": 61.4,
        "post_output_equity_context": {
            "audit_hispanic_pct": 68.4,
            "audit_black_pct": 7.2,
        },
    }
    parsed = OutreachZoneRow.model_validate(valid_zone)
    assert parsed.is_hidden_ei_desert is True
    assert parsed.post_output_equity_context["audit_hispanic_pct"] == 68.4

    with pytest.raises(ValidationError, match="Anti-Bias Routing Firewall"):
        OutreachZoneRow.model_validate({**valid_zone, "audit_hispanic_share": 0.684})


def test_statutory_45_day_clock_invariant_on_recommended_and_viable_pathways() -> None:
    """`RecommendedPathway` and `ViablePathCandidate` enforce `<= 45` days when `clears_45_day_clock=True`."""
    # Exact boundary = 45 days is compliant
    boundary_ok = RecommendedPathway.model_validate(
        {
            "pathway_type": "3-Hop Evaluation + IFSP Route",
            "total_hops": 3,
            "expected_cumulative_days": 45,
            "clears_45_day_clock": True,
        }
    )
    assert boundary_ok.expected_cumulative_days == 45

    # > 45 days while claiming clears_45_day_clock=True must raise ValidationError
    with pytest.raises(ValidationError, match="45-Day Clock"):
        RecommendedPathway.model_validate(
            {
                "pathway_type": "3-Hop Evaluation + IFSP Route",
                "total_hops": 3,
                "expected_cumulative_days": 46,
                "clears_45_day_clock": True,
            }
        )

    # Non-compliant pathway explicitly marked clears_45_day_clock=False is representable
    explicit_non_compliant = RecommendedPathway.model_validate(
        {
            "pathway_type": "Unverified Slow Route",
            "total_hops": 3,
            "expected_cumulative_days": 54,
            "clears_45_day_clock": False,
        }
    )
    assert explicit_non_compliant.clears_45_day_clock is False

    # ViablePathCandidate also enforces <= 45 days when clears_45d_clock=True
    with pytest.raises(ValidationError, match="exceeds 45 days"):
        ViablePathCandidate.model_validate(
            {
                "start_provider_id": "SYN-PROV-MS-001",
                "start_name": "Clinic [Synthetic]",
                "eval_provider_id": "SYN-PROV-MS-028",
                "eval_name": "Vendor [Synthetic]",
                "eval_role": "EI_Therapy_Vendor",
                "hop_count": 3,
                "intake_lag_days": 15,
                "handoff_days": 20,
                "evaluator_backlog_days": 14,
                "total_expected_days": 49,
                "clears_45d_clock": True,
            }
        )


def test_nsch_stratum_and_governance_attestation_invariants() -> None:
    """Enforces `'Statewide'` HRSA NSCH grain and affirmative anti-bias governance flags."""
    ok_nsch = NschStratum.model_validate(
        {
            "survey_stratum_id": "NSCH-MS-01",
            "geographic_level": "Statewide",
            "household_income_fpl_band": "0-99% FPL",
            "primary_home_language": "Non-English",
            "standardized_screening_rate_pct": 24.5,
            "followup_requested_pct": 16.2,
        }
    )
    assert ok_nsch.geographic_level == "Statewide"

    with pytest.raises(ValidationError, match="HRSA NSCH grain violation"):
        NschStratum.model_validate(
            {
                "survey_stratum_id": "NSCH-BAD-TRACT",
                "geographic_level": "Census_Tract",
                "household_income_fpl_band": "0-99% FPL",
                "primary_home_language": "Spanish",
                "standardized_screening_rate_pct": 24.5,
                "followup_requested_pct": 16.2,
            }
        )

    with pytest.raises(ValidationError, match="GovernanceAttestation"):
        GovernanceAttestation.model_validate(
            {
                "audit_columns_excluded_from_routing": False,
                "acs_limited_english_rate_trap_caught": "20/20 zero",
                "nsch_statewide_grain_preserved": "6 Statewide rows",
            }
        )


def test_caregiver_notes_bilingual_validation() -> None:
    """`CaregiverNotes` requires non-empty English and Spanish strings."""
    with pytest.raises(ValidationError, match="English and Spanish must be non-empty"):
        CaregiverNotes(english="", spanish="Nota en español válida.")

    with pytest.raises(ValidationError, match="English and Spanish must be non-empty"):
        CaregiverNotes(english="Valid English note.", spanish="   ")

    fallback_notes = build_caregiver_notes({"child_profile": {}, "recommended_pathway": None})
    validated = CaregiverNotes.model_validate(fallback_notes)
    assert "45-day" in validated.english
    assert "45 días" in validated.spanish


def test_api_and_sse_stream_event_schemas() -> None:
    """Validates `ChatRequestModel`, `SimulateRequestModel`, `RunStreamRequestModel`, and `SSEStreamEvent`."""
    chat_req = ChatRequestModel(message="Check MS bounce hubs", state_code="MS")
    assert chat_req.state_code == "MS"
    with pytest.raises(ValidationError):
        ChatRequestModel(message="   ")

    sim_req = SimulateRequestModel(target_provider_id="SYN-PROV-MS-011")
    assert sim_req.upgrade_fax_to_ehr is True

    stream_req = RunStreamRequestModel(
        message="Route 32m toddler in 28049003500",
        state_code="MS",
        child_age_months=32,
    )
    assert stream_req.child_age_months == 32
    with pytest.raises(ValidationError):
        RunStreamRequestModel(message="Aged out check", child_age_months=36)

    for ev_type in (
        "agent_start",
        "sub_agent_delegate",
        "tool_call",
        "tool_result",
        "token",
        "brief",
        "error",
        "done",
    ):
        ev = SSEStreamEvent(
            event_type=ev_type,
            agent_name="first_milestones_coordinator",
            sub_agent_name="triage_pathway_router" if ev_type == "sub_agent_delegate" else None,
            model_used="gemini-2.5-flash",
        )
        wire = ev.to_sse_frame()
        assert wire.startswith(f"event: {ev_type}\ndata: ")
        assert wire.endswith("\n\n")
        decoded = json.loads(wire.splitlines()[1].removeprefix("data: "))
        assert decoded["event_type"] == ev_type

    with pytest.raises(ValidationError):
        SSEStreamEvent(event_type="unsupported_event_kind")  # type: ignore[arg-type]


def test_package_root_exports_and_subagent_metadata() -> None:
    """Verifies top-level `first_milestones` exports and `SUBAGENT_METADATA` introspection registry."""
    for symbol in (
        "root_agent",
        "PathwayBrief",
        "SUBAGENT_MODEL",
        "create_coordinator_agent",
        "create_sub_agents",
        "ACTIVE_MCP_MODE",
    ):
        assert hasattr(first_milestones, symbol)

    assert set(SUBAGENT_METADATA.keys()) == {
        "triage_pathway_router",
        "network_bottleneck_auditor",
        "equity_and_caregiver_specialist",
    }
    assert DEFAULT_MODEL == "gemini-2.5-pro"
    assert SUBAGENT_MODEL == "gemini-2.5-flash"
    assert get_model_candidates()[0] == DEFAULT_MODEL


def test_multi_agent_topology_and_flash_subagent_models() -> None:
    """`root_agent.sub_agents` has exact 3 specialist Flash sub-agents with prompts & guardrails."""
    assert root_agent.name == "first_milestones_coordinator"
    assert len(root_agent.tools) >= 6
    assert len(root_agent.sub_agents) == 3

    names = [sa.name for sa in root_agent.sub_agents]
    assert names == [
        "triage_pathway_router",
        "network_bottleneck_auditor",
        "equity_and_caregiver_specialist",
    ]

    for sa in root_agent.sub_agents:
        assert sa.model == "gemini-2.5-flash"
        assert sa.parent_agent is root_agent
        assert sa.before_tool_callback is guardrail_before_tool_callback
        assert sa.after_model_callback is guardrail_after_model_callback

    assert root_agent.sub_agents[0].instruction == TRIAGE_SUB_INSTRUCTION
    assert root_agent.sub_agents[1].instruction == AUDIT_SUB_INSTRUCTION
    assert root_agent.sub_agents[2].instruction == EQUITY_SUB_INSTRUCTION
    assert "triage_pathway_router" in SYSTEM_INSTRUCTION
    assert "network_bottleneck_auditor" in SYSTEM_INSTRUCTION
    assert "equity_and_caregiver_specialist" in SYSTEM_INSTRUCTION


def test_strict_subagent_tool_separation_and_anti_bias_isolation() -> None:
    """Proves strict tool separation across the 3 specialist sub-agents (firewall isolation)."""
    triage_tools = _tool_names(create_triage_sub_agent())
    audit_tools = _tool_names(create_audit_sub_agent())
    equity_tools = _tool_names(create_equity_sub_agent())

    # 1. Triage router owns Track 1 routing tools and NEVER sees post-output equity or NSCH tools
    assert {"find_compliant_45d_pathways", "find_viable_45d_paths"} <= triage_tools
    assert "run_post_output_equity_audit" not in triage_tools
    assert "lookup_statewide_nsch_strata" not in triage_tools
    assert "audit_multihop_bounce_hubs" not in triage_tools
    assert "generate_complete_45d_brief" not in triage_tools

    # 2. Network bottleneck auditor owns Track 2 graph audit + counterfactual + agency KPIs
    assert {
        "audit_multihop_bounce_hubs",
        "detect_regional_bottleneck_hubs",
        "simulate_hub_intervention",
        "lookup_regional_agency_kpis",
    } <= audit_tools
    assert "run_post_output_equity_audit" not in audit_tools
    assert "find_compliant_45d_pathways" not in audit_tools

    # 3. Equity & caregiver specialist owns post-output equity, Track 3 outreach, NSCH, and brief builder
    assert {
        "run_post_output_equity_audit",
        "prioritize_community_screening_tracts",
        "rank_outreach_zones",
        "generate_complete_45d_brief",
        "lookup_statewide_nsch_strata",
    } <= equity_tools
    assert "simulate_hub_intervention" not in equity_tools


def test_multiple_create_coordinator_agent_calls_have_zero_parent_agent_collision() -> None:
    """Repeated `create_coordinator_agent()` calls instantiate fresh sub-agents without ADK parent collision."""
    coord_a = create_coordinator_agent("gemini-3.1-pro-preview", subagent_model="gemini-2.5-flash")
    coord_b = create_coordinator_agent("gemini-2.5-pro", subagent_model="gemini-2.5-flash")
    standalone_subs = create_sub_agents("gemini-2.5-flash")

    assert coord_a is not coord_b
    assert len(coord_a.sub_agents) == 3
    assert len(coord_b.sub_agents) == 3
    assert len(standalone_subs) == 3

    for sa_a, sa_b in zip(coord_a.sub_agents, coord_b.sub_agents, strict=True):
        assert sa_a is not sa_b
        assert sa_a.parent_agent is coord_a
        assert sa_b.parent_agent is coord_b


class _DeterministicMultiAgentLlm(BaseLlm):
    """In-memory deterministic ADK `BaseLlm` exercising coordinator -> sub-agent delegation & tool execution."""

    model: str = "deterministic-adk-test-llm"
    step: int = 0

    async def generate_content_async(
        self,
        llm_request: LlmRequest,
        stream: bool = False,
    ) -> AsyncGenerator[LlmResponse, None]:
        del llm_request, stream
        self.step += 1
        if self.step == 1:
            # Coordinator delegates Track 1 query to `triage_pathway_router` via ADK's built-in transfer_to_agent
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part.from_function_call(
                            name="transfer_to_agent",
                            args={"agent_name": "triage_pathway_router"},
                        )
                    ],
                )
            )
        elif self.step == 2:
            # `triage_pathway_router` invokes real `find_compliant_45d_pathways` tool
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part.from_function_call(
                            name="find_compliant_45d_pathways",
                            args={
                                "child_tract_geoid": "28049003500",
                                "child_age_months": 32,
                                "concern_domain": "Social-Communication / Autism Screen",
                                "needs_medicaid": True,
                                "needs_bilingual": True,
                                "has_household_vehicle": False,
                            },
                        )
                    ],
                )
            )
        else:
            # Sub-agent synthesizes final response (intentionally omitting provenance & 36m notice
            # so `guardrail_after_model_callback` deterministically appends both!)
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part.from_text(
                            text=(
                                "Routed 32 months toddler in tract 28049003500 via "
                                "SYN-PROV-MS-007 -> SYN-PROV-MS-010 -> SYN-PROV-MS-020 -> SYN-PROV-MS-030 "
                                "within 45 days."
                            )
                        )
                    ],
                )
            )


@pytest.mark.asyncio
async def test_live_adk_runner_multi_agent_delegation_and_tool_capture() -> None:
    """Executes genuine ADK `Runner` transferring from coordinator -> `triage_pathway_router` -> tool -> guardrails."""
    mock_llm = _DeterministicMultiAgentLlm()
    coord = create_coordinator_agent(model_name=mock_llm, subagent_model=mock_llm)  # type: ignore[arg-type]

    session_service = InMemorySessionService()
    await session_service.create_session(
        app_name="first_milestones_test",
        user_id="test_coord",
        session_id="sess-multi-agent-01",
    )
    adk_runner = Runner(
        app_name="first_milestones_test",
        agent=coord,
        session_service=session_service,
    )

    authors_seen: list[str] = []
    function_calls: list[str] = []
    captured_responses: dict[str, dict] = {}
    final_texts: list[str] = []

    with request_state_context("MS"):
        async for event in adk_runner.run_async(
            user_id="test_coord",
            session_id="sess-multi-agent-01",
            new_message=types.Content(
                role="user",
                parts=[
                    types.Part.from_text(
                        text="Route a 32-month-old toddler in 28049003500 needing Spanish Autism evaluation"
                    )
                ],
            ),
        ):
            if getattr(event, "author", None):
                authors_seen.append(event.author)
            for fc in event.get_function_calls() or []:
                if fc.name:
                    function_calls.append(fc.name)
            for fr in event.get_function_responses() or []:
                if fr.name and isinstance(fr.response, dict):
                    captured_responses[fr.name] = fr.response
            if event.is_final_response() and event.content and event.content.parts:
                for p in event.content.parts:
                    if getattr(p, "text", None):
                        final_texts.append(p.text)

    assert "first_milestones_coordinator" in authors_seen
    assert "triage_pathway_router" in authors_seen
    assert "transfer_to_agent" in function_calls
    assert "find_compliant_45d_pathways" in function_calls
    assert "find_compliant_45d_pathways" in captured_responses

    routed = captured_responses["find_compliant_45d_pathways"]
    assert routed["recommended_pathway"]["clears_45_day_clock"] is True
    assert routed["recommended_pathway"]["expected_cumulative_days"] <= 45

    reply = "\n".join(final_texts)
    # Sub-agent's guardrail_after_model_callback must have enforced provenance + 36m Part B notice
    assert "100% [Synthetic]" in reply
    assert "36-month" in reply.lower()
    assert "part b" in reply.lower()
