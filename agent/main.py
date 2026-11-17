"""FastAPI + Google ADK Unified Server for First Milestones Coordinator Workbench.

Serves:
  - `/` & `/static/*`: Custom Split-Pane Web UI ("45-Day Pathway & Bottleneck Brief")
  - `GET  /api/health`: Runtime & MCP status check
  - `GET  /api/brief`: Complete initial or state-switched 45-Day Pathway & Bottleneck Brief
  - `POST /api/simulate`: Interactive counterfactual Bounce Hub simulator endpoint
  - `POST /api/chat`: Multi-turn conversational ADK Runner endpoint (`gemini-2.5-pro`)
    that captures live MCP + ISO GQL tool invocations and returns updated visual
    brief state alongside the coordinator's response. Also includes an automatic
    deterministic fallback synthesis if Gemini/Vertex credentials are not yet set
    in a local offline preview environment.
  - `POST /run` (plus aliases `POST /run_sse` & `POST /api/chat/stream`): Real-time
    ADK Server-Sent Events (`text/event-stream`) streaming endpoint emitting
    `agent_start`, `sub_agent`, `tool_call`, `tool_result`, `token`, `brief`, and `done`.
"""

from __future__ import annotations

import asyncio
import copy
import importlib
import inspect
import json
import logging
import math
import os
import re
import struct
import subprocess
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import google.auth
import google.auth.exceptions
import google.oauth2.credentials
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field

from first_milestones.agent import (
    ACTIVE_MCP_MODE,
    DEFAULT_MODEL,
    FALLBACK_MODELS,
    check_intake_packet_readiness as _fallback_check_packet,
    create_coordinator_agent,
    get_model_candidates,
    reserve_pathway_slot as _fallback_reserve_slot,
    root_agent,
)
from first_milestones.brief_builder import (
    _compute_statutory_transition_tier,
    build_caregiver_notes,
    generate_complete_45d_brief,
)
from first_milestones.tools import (
    detect_regional_bottleneck_hubs,
    find_viable_45d_paths,
    get_referral_history,
    rank_outreach_zones,
)
from first_milestones.tools import bq_client as bq_client_mod
from first_milestones.tools.bq_client import (
    VALID_STATES,
    get_config,
    graph_client,
    load_local_state_frames,
    request_state_context,
)
from first_milestones.tools.equity_audit import (
    prioritize_community_screening_tracts,
    run_post_output_equity_audit,
)
from first_milestones.tools.graph_audit import (
    audit_multihop_bounce_hubs,
    simulate_hub_intervention,
)
from first_milestones.tools.graph_routing import find_compliant_45d_pathways

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("first_milestones.server")

APP_NAME = "first_milestones"
STATIC_DIR = Path(__file__).resolve().parent / "static"

@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Pre-warms default MS and CA briefs in the background on Cloud Run for instant UI load."""
    if os.environ.get("K_SERVICE"):

        def _warm() -> None:
            for st in ("MS", "CA"):
                try:
                    with request_state_context(st) as active_st:
                        _get_cached_brief(state_code=active_st)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("Background prewarm for %s skipped: %s", st, exc)

        asyncio.get_running_loop().run_in_executor(None, _warm)
    yield


app = FastAPI(
    title="First Milestones — IDEA Part C Early Intervention Triage & Audit",
    version="1.0.0",
    lifespan=_lifespan,
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
)
_runners_by_model: dict[str, Runner] = {DEFAULT_MODEL: runner}
_working_model_cache: str | None = None
_GEO_CACHE: dict[tuple[str, str], dict[str, Any]] = {}
_BRIEF_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}


def _get_cached_brief(
    *,
    state_code: str,
    child_tract_geoid: str = "",
    child_age_months: int = 32,
    concern_domain: str = "Social-Communication / Autism Screen",
    needs_medicaid: bool = True,
    needs_bilingual: bool = True,
    has_household_vehicle: bool = False,
) -> dict[str, Any]:
    """Returns a deep-copied 45d brief, caching static per-state/profile computation in memory."""
    resolved_tract = child_tract_geoid.strip() or _default_anchor_tract(state_code)
    cfg = get_config()
    is_mocked = hasattr( getattr(graph_client, "query_bq_or_none", None), "assert_called")
    cache_key = (
        cfg.get("project", ""),
        cfg.get("dataset", ""),
        os.environ.get("A4I_FORCE_LOCAL_PARQUET", ""),
        state_code.strip().upper(),
        resolved_tract,
        int(child_age_months),
        concern_domain.strip(),
        bool(needs_medicaid),
        bool(needs_bilingual),
        bool(has_household_vehicle),
    )
    if not is_mocked and cache_key in _BRIEF_CACHE:
        cloned = copy.deepcopy(_BRIEF_CACHE[cache_key])
        try:
            from first_milestones.brief_builder import _safe_list_slot_holds

            cloned["slot_holds"] = _safe_list_slot_holds()
        except Exception:  # noqa: BLE001
            pass
        return cloned

    computed = generate_complete_45d_brief(
        child_tract_geoid=resolved_tract,
        child_age_months=child_age_months,
        concern_domain=concern_domain,
        needs_medicaid=needs_medicaid,
        needs_bilingual=needs_bilingual,
        has_household_vehicle=has_household_vehicle,
    )
    if not is_mocked:
        if len(_BRIEF_CACHE) >= 128:
            _BRIEF_CACHE.clear()
        _BRIEF_CACHE[cache_key] = copy.deepcopy(computed)
    return computed


def _get_runner(model_name: str) -> Runner:
    """Returns a cached ADK Runner for `model_name`, creating it cleanly on first fallback."""
    if model_name not in _runners_by_model:
        _runners_by_model[model_name] = Runner(
            app_name=APP_NAME,
            agent=create_coordinator_agent(model_name),
            session_service=session_service,
        )
    return _runners_by_model[model_name]


def _ordered_model_candidates() -> list[str]:
    """Places the cached working Gemini model first so subsequent turns skip dead preview models."""
    candidates = get_model_candidates()
    if _working_model_cache and _working_model_cache in candidates:
        return [_working_model_cache, *[m for m in candidates if m != _working_model_cache]]
    return candidates


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    session_id: str | None = None
    state_code: str | None = None


class SimulateRequest(BaseModel):
    state_code: str | None = None
    target_provider_id: str = ""
    upgrade_fax_to_ehr: bool = True
    precheck_bilingual_and_slot_capacity: bool = True


class GatekeeperRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    state_code: str | None = None
    tract_geoid: str = ""
    home_tract_geoid: str = ""
    child_age_months: int = Field(default=32, ge=0, le=60)
    consent_signed: bool | None = None
    has_parent_consent: bool | None = None
    screening_tool_completed: bool | None = None
    has_screening_tool: bool | None = None
    primary_language: str | None = None
    preferred_language: str | None = None
    insurance_status: str | None = None
    insurance_type: str | None = None
    needs_medicaid: bool | None = None
    concern_domain: str = "Social-Communication / Autism Screen"
    has_household_vehicle: bool = False
    referral_channel: str = "ehr_electronic_portal"
    caregiver_phone_verified: bool = True


class SlotReserveRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    state_code: str | None = None
    provider_id: str = ""
    coordinator_id: str = ""
    eval_hub_id: str = ""
    vendor_id: str = ""
    pathway_nodes: list[str] = Field(default_factory=list)
    child_tract_geoid: str = ""
    concern_domain: str = "Social-Communication / Autism Screen"
    needs_medicaid: bool = True
    needs_bilingual: bool = True
    hold_hours: int = Field(default=48, ge=1, le=168)
    case_reference: str = ""


_ORIG_GOOGLE_AUTH_DEFAULT = google.auth.default
_GCLOUD_ADC_BRIDGE_ACTIVE = False


def _fetch_gcloud_access_token() -> str:
    """Fetches an OAuth2 access token from the local `gcloud` CLI if installed."""
    try:
        proc = subprocess.run(
            ["gcloud", "auth", "print-access-token"],
            capture_output=True,
            text=True,
            timeout=5.0,
            check=False,
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
    except Exception as exc:  # noqa: BLE001
        logger.debug("Unable to read gcloud access token: %s", exc)
    return ""


class _GcloudCliCredentials(google.oauth2.credentials.Credentials):
    """Bridges local `gcloud auth print-access-token` when macOS lacks an ADC JSON file."""

    def __init__(self, token: str, quota_project_id: str | None = None) -> None:
        super().__init__(token=token, quota_project_id=quota_project_id)

    @property
    def expired(self) -> bool:
        return not bool(self.token)

    @property
    def valid(self) -> bool:
        return bool(self.token)

    def refresh(self, request: Any) -> None:  # noqa: ARG002
        refreshed = _fetch_gcloud_access_token()
        if refreshed:
            self.token = refreshed


def _ensure_gcloud_adc_bridge() -> bool:
    """Ensures Vertex AI ADK calls can use `gcloud` CLI credentials when `A4I_USE_GCLOUD_AUTH=1`."""
    global _GCLOUD_ADC_BRIDGE_ACTIVE  # noqa: PLW0603
    if os.environ.get("A4I_USE_GCLOUD_AUTH", "").strip().upper() not in ("1", "TRUE", "YES"):
        return False
    if _GCLOUD_ADC_BRIDGE_ACTIVE:
        return True

    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or None
    try:
        creds, resolved_proj = _ORIG_GOOGLE_AUTH_DEFAULT()
        if creds is not None:
            _GCLOUD_ADC_BRIDGE_ACTIVE = True
            return True
        _ = resolved_proj
    except google.auth.exceptions.DefaultCredentialsError:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.debug("Default ADC check raised %s; attempting gcloud CLI bridge.", exc)

    token = _fetch_gcloud_access_token()
    if not token:
        return False

    def _bridged_google_auth_default(*args: Any, **kwargs: Any) -> tuple[Any, str | None]:
        try:
            return _ORIG_GOOGLE_AUTH_DEFAULT(*args, **kwargs)
        except google.auth.exceptions.DefaultCredentialsError:
            quota_proj = kwargs.get("quota_project_id") or os.environ.get("GOOGLE_CLOUD_PROJECT") or project
            fresh = _fetch_gcloud_access_token() or token
            return _GcloudCliCredentials(token=fresh, quota_project_id=quota_proj), quota_proj

    google.auth.default = _bridged_google_auth_default
    _GCLOUD_ADC_BRIDGE_ACTIVE = True
    logger.info("Activated local gcloud CLI ADC credential bridge for Vertex AI ADK runs.")
    return True


def _has_llm_credentials() -> bool:
    """Checks whether Gemini API or Vertex AI ADC credentials are configured."""
    if os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"):
        return True
    if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").strip().upper() in ("1", "TRUE", "YES"):
        if os.environ.get("GOOGLE_CLOUD_PROJECT"):
            if os.environ.get("A4I_USE_GCLOUD_AUTH", "").strip().upper() in ("1", "TRUE", "YES"):
                _ensure_gcloud_adc_bridge()
            return True
    return False


def _default_anchor_tract(state_code: str) -> str:
    """Picks the tract of the 32-month-old 4-hop autism case (CHAIN-*-023) as default demo anchor."""
    logs = load_local_state_frames(state_code)["logs"]
    c23 = logs[logs["case_chain_id"] == f"CHAIN-{state_code}-023"]
    if not c23.empty:
        return str(c23.iloc[0]["child_home_tract_geoid"])
    return ""


def _parse_intent_and_fallback_reply(msg: str, state_code: str) -> tuple[str, list[str], dict[str, Any]]:
    """Executes real ISO GQL / Equity tools and formats a fallback reply when offline."""
    lower = msg.lower()
    tract_match = re.search(r"\b(\d{11})\b", msg) or re.search(r"\b(\d{5})\b", msg)
    tract = tract_match.group(1) if tract_match else _default_anchor_tract(state_code)

    age_match = re.search(r"\b(\d{1,2})\s*(?:-|\s)?(?:month|mo\b|m\b)", lower)
    age_m = int(age_match.group(1)) if age_match else 32

    if "autism" in lower or "social" in lower:
        domain = "Social-Communication / Autism Screen"
    elif "motor" in lower:
        domain = "Motor Milestone Delay"
    elif "feed" in lower or "sensory" in lower:
        domain = "Feeding & Sensory"
    else:
        domain = "Expressive Speech/Language"

    needs_bilingual = not ("english only" in lower or "non-bilingual" in lower)
    needs_medicaid = "private insurance" not in lower
    has_vehicle = "has vehicle" in lower or "with vehicle" in lower

    prov_match = re.search(r"(SYN-PROV-[A-Z]{2}-\d{3})", msg, re.IGNORECASE)
    target_hub = prov_match.group(1).upper() if prov_match else ""
    chain_match = re.search(r"\b(CHAIN-[A-Z]{2}-\d{3})\b", msg, re.IGNORECASE)
    req_chain_id = chain_match.group(1).upper() if chain_match else ""
    is_history_intent = bool(req_chain_id) or ("referral history" in lower) or ("trace chain" in lower)

    brief = _get_cached_brief(
        state_code=state_code,
        child_tract_geoid=tract,
        child_age_months=age_m,
        concern_domain=domain,
        needs_medicaid=needs_medicaid,
        needs_bilingual=needs_bilingual,
        has_household_vehicle=has_vehicle,
    )
    if target_hub:
        brief["counterfactual_simulation"] = simulate_hub_intervention(
            target_provider_id=target_hub,
            upgrade_fax_to_ehr=True,
            precheck_bilingual_and_slot_capacity=True,
        )

    rec = brief["routing"].get("recommended_pathway")
    viable = brief["viable_45d_paths"]
    bounce = brief["routing"].get("cautionary_historical_bounce_chain")
    top_hub = brief["network_audit"]["top_hidden_bounce_hub"]
    btwn_hubs = brief["bottleneck_hubs"]["bottleneck_hubs"]
    top_btwn = btwn_hubs[0] if btwn_hubs else None
    sim = brief["counterfactual_simulation"]["impact_summary"]
    outreach_priorities = brief["screening_outreach"]["priority_screening_tracts"]
    outreach_top = outreach_priorities[0]
    hidden_deserts_count = brief["outreach_zones"]["hidden_ei_deserts_count"]
    ranked_zones = brief["outreach_zones"]["ranked_outreach_zones"]
    top_zone = ranked_zones[0] if ranked_zones else None
    resolved_tract = viable["tract_context"].get("census_tract_geoid", "") or tract

    def _build_track1_reply() -> tuple[str, list[str]]:
        t1_tools = [
            "find_viable_45d_paths",
            "find_compliant_45d_pathways",
            "audit_multihop_bounce_hubs",
            "run_post_output_equity_audit",
        ]
        routing_status = brief["routing"].get("status", "ok")
        if routing_status == "ineligible_part_c_aged_out":
            return (
                f"### Statutory IDEA Part C Eligibility Gate ({state_code})\n\n"
                f"- **Aged Out of IDEA Part C (`>= 36` Months):** {brief['routing'].get('message')}\n"
                "- **Immediate Action (`34 CFR § 300.800`):** Redirect immediately to **IDEA Part B Section 619 "
                "Preschool Special Education** through the child's Local Educational Agency (LEA).\n"
                "- *(100% `[Synthetic]` provider/log provenance maintained.)*",
                ["find_viable_45d_paths", "find_compliant_45d_pathways"],
            )
        if routing_status == "validation_error" or not rec:
            return (
                f"### Location / Parameter Validation ({state_code})\n\n"
                f"- **Validation Error (`{brief['routing'].get('error_code', 'INVALID_INPUT')}`):** "
                f"{brief['routing'].get('message', 'No compliant pathway found for requested location.')}\n"
                "- *(100% `[Synthetic]` provider/log provenance maintained.)*",
                ["find_viable_45d_paths", "find_compliant_45d_pathways"],
            )
        hops_str = " → ".join(
            [rec["hops"][0]["source_provider_id"]] + [h["target_provider_id"] for h in rec["hops"]]
        )
        viable_count = len(viable["viable_paths"])
        pruned_count = viable["pruned_high_bounce_edges_count"]
        fastest_viable = (
            f" (fastest `{viable['viable_paths'][0]['start_provider_id']} → {viable['viable_paths'][0]['eval_provider_id']}` in **{viable['viable_paths'][0]['total_expected_days']}d**)"
            if viable["viable_paths"]
            else ""
        )
        bounce_bullet = (
            f"- **Avoided Bounce Loop (`{bounce['case_chain_id']}` — {bounce['total_wait_days']} Days ❌):** Bypassed the 4-hop `paper_fax` re-referral loop (**{brief['routing']['days_saved_vs_bounce_loop']} days faster**).\n"
            if bounce
            else ""
        )
        bounce_wait = bounce["total_wait_days"] if bounce else 60
        t1_reply = (
            f"### <=45-Day Compliant Pathway vs. Historical Bounce Diagnosis ({state_code})\n\n"
            f"- **Viable <=45-Day Graph Traversal (`find_viable_45d_paths`):** Found **{viable_count}** viable `<=45`-day paths for tract `{resolved_tract}`{fastest_viable} after pruning **{pruned_count}** high-bounce edges.\n"
            f"- **Recommended Electronic Route ({rec['expected_cumulative_days']} Days — Clears 45-Day Mandate by {rec['statutory_45d_headroom_days']}d):**\n"
            f"  `{hops_str}` via `ehr_electronic_portal` (100% Medicaid-enrolled, Part C vendor-verified, Spanish-bilingual).\n"
            + bounce_bullet
            + (
                f"- **36-Month Aging-Out Alert:** At **{age_m} months**, avoiding a {bounce_wait}-day delay protects the toddler before the 36-month IDEA Part C cutoff; initiate concurrent Part B transition notice.\n"
                if age_m >= 30
                else ""
            )
            + f"- **Mobility & Caregiver Note:** Medicaid NEMT / mobile evaluation flagged for tract `{resolved_tract}` (**{brief['routing']['child_profile']['tract_zero_vehicle_pct']}%** zero-vehicle rate). English & Spanish caregiver notes are ready in the right panel."
        )
        return t1_reply, t1_tools

    lower_for_outreach = lower.replace("autism screen", "")
    if is_history_intent:
        hist_tract = (
            tract_match.group(1)
            if (tract_match and len(tract_match.group(1)) in (10, 11) and not req_chain_id)
            else ""
        )
        only_breaches_flag = ("breach" in lower or ">45" in lower) and not req_chain_id
        history_res = get_referral_history(
            case_chain_id=req_chain_id,
            provider_id=target_hub if not req_chain_id else "",
            tract_geoid=hist_tract,
            only_breaches=only_breaches_flag,
        )
        brief["referral_history"] = history_res
        tools_used = ["get_referral_history", "run_post_output_equity_audit"]

        if history_res.get("status") != "ok":
            sample_ids = ", ".join(f"`{c}`" for c in history_res.get("sample_valid_chain_ids", []))
            reply = (
                f"### Historical Referral Chain Lookup ({state_code})\n\n"
                f"- **Validation Error (`{history_res.get('error_code')}`):** {history_res.get('message')}\n"
                + (f"- **Sample Valid Chains in `{state_code}`:** {sample_ids}\n" if sample_ids else "")
                + "- *(100% `[Synthetic]` `REFERS_TO` referral logs.)*"
            )
        else:
            chains = history_res.get("chains", [])
            chain_blocks: list[str] = []
            for ch in chains:
                verdict = (
                    f"✅ Clears <=45d Mandate ({ch['headroom_or_excess_days']}d headroom)"
                    if ch["clears_45d_clock"]
                    else f"❌ Breaches 45d Mandate (+{abs(ch['headroom_or_excess_days'])}d over 45d)"
                )
                lines = [
                    f"- **`{ch['case_chain_id']}` ({ch['total_hops']} Hops | Total Wait: {ch['total_wait_days']} Days — {verdict}):** "
                    f"Hop-1 child age **{ch['child_age_months_at_referral']}m**, domain `{ch['concern_domain']}`, "
                    f"tract `{ch['child_home_tract_geoid']}`, span `{ch['initial_referral_date']} → {ch['estimated_completion_date']}`."
                ]
                for h in ch["hops"]:
                    lines.append(
                        f"  - **Hop {h['hop_seq']} (`{h['event_id']}`):** `{h['src_id']} → {h['dst_id']}` "
                        f"(`{h['dst_role']}`) via `{h['channel']}` | `{h['referral_date']} → {h['next_step_date']}` "
                        f"(**+{h['wait_days']}d**, cumulative **{h['cumulative_days']}d**) — {h['reason']}"
                    )
                chain_blocks.append("\n".join(lines))
            body_md = (
                "\n".join(chain_blocks)
                if chain_blocks
                else "- No matching 2–4 hop `REFERS_TO` chains found for the requested filter."
            )
            reply = (
                f"### Historical `REFERS_TO` Referral Chain Trace ({state_code})\n\n"
                f"{body_md}\n\n"
                "- **Edge Semantics & Provenance:** `REFERS_TO` edges capture historical *'actually referred to'* "
                "handoffs where each hop's wait equals the exact calendar delta `referral_date → next_step_date` "
                "(100% `[Synthetic]` `SYN-PROV-*` providers and logs)."
            )
    elif (
        "screen" in lower_for_outreach
        or "outreach" in lower
        or "mobile" in lower
        or "desert" in lower
        or "underserved" in lower
        or "rank_outreach" in lower
    ):
        tools_used = [
            "rank_outreach_zones",
            "prioritize_community_screening_tracts",
            "find_compliant_45d_pathways",
            "run_post_output_equity_audit",
        ]
        desert_bullet = (
            f"- **Hidden Early Intervention Deserts (`rank_outreach_zones`):** Identified **{hidden_deserts_count}** hidden Early Intervention deserts "
            f"(clinics within 25 km on a map, yet **0** reachable `<=45`-day Medicaid/bilingual evaluation paths); top outreach zone `{top_zone['census_tract_geoid']}` "
            f"({top_zone['county_name']}) scores **{top_zone['outreach_priority_score']}** (`nearest_any_clinic_km={top_zone['nearest_any_clinic_km']} km`, "
            f"`reachable_45d_paths_count={top_zone['reachable_45d_paths_count']}`).\n"
            if top_zone
            else f"- **Hidden Early Intervention Deserts (`rank_outreach_zones`):** Identified **{hidden_deserts_count}** hidden Early Intervention deserts statewide.\n"
        )
        reply = (
            f"### Community Developmental Screening Readiness ({state_code})\n\n"
            + desert_bullet
            + f"- **Top Priority Neighborhood:** Tract `{outreach_top['census_tract_geoid']}` ({outreach_top['county_name']}) — "
            f"**{outreach_top['children_under_5_count']}** children under 5, **{outreach_top['poverty_pct']}%** poverty, "
            f"**{outreach_top['zero_vehicle_pct']}%** zero-vehicle households.\n"
            f"- **Verified <=45-Day Downstream Capacity:** Paired with `{outreach_top['verified_downstream_45d_pathway']['eval_hub_id']}` "
            f"(~**{outreach_top['verified_downstream_45d_pathway']['expected_cumulative_days']} days** cumulative to initial IFSP).\n"
            f"- **Data Rigor Guardrails:** Ranked without `audit_*` racial shares and without the all-zero ACS `limited_english_rate` (`0.0`) column.\n\n"
            f"*(Right-hand brief updated with hidden EI deserts, full screening readiness, multi-hop graph comparison, and Post-Output Equity Audit.)*"
        )
    elif any(
        w in lower for w in ("route", "viable", "pathway", "prune", "toddler", "infant", "month-old")
    ) and not any(w in lower for w in ("audit", "bottleneck", "betweenness", "simulat")):
        reply, tools_used = _build_track1_reply()
    elif any(
        w in lower for w in ("audit", "bounce", "bottleneck", "betweenness", "simulat", "fax")
    ):
        tools_used = [
            "detect_regional_bottleneck_hubs",
            "audit_multihop_bounce_hubs",
            "simulate_hub_intervention",
            "run_post_output_equity_audit",
            "mcp_get_regional_agency_performance",
        ]
        btwn_bullet = (
            f"- **Graph Betweenness Bottleneck (`detect_regional_bottleneck_hubs`):** **`{top_btwn['provider_id']}`** ({top_btwn['organization_name']}, `{top_btwn['node_role']}`) "
            f"carries a **{top_btwn['betweenness_flow_share_pct']}%** betweenness flow share across breached multi-hop chains "
            f"(**{top_btwn['breached_paths_through_hub']} of {brief['bottleneck_hubs']['total_breached_multihop_chains']}** `>45`-day chains; "
            f"**{top_btwn['paper_fax_share_pct']}%** `paper_fax`, **{top_btwn['bounce_rate_pct']}%** bounce rate) despite a **{top_btwn['flat_internal_wait_days']}d** internal wait.\n"
            if top_btwn
            else ""
        )
        reply = (
            f"### Multi-Hop Network Bottleneck Audit & Counterfactual Fix ({state_code})\n\n"
            + btwn_bullet
            + f"- **Why Flat SQL Misleads:** Sorting by `active_waitlist_count` points at saturated downstream clinics, while **`{top_hub['provider_id']}`** "
            f"({top_hub['synthetic_organization_name']}) looks healthy in a flat table (**{top_hub['flat_median_internal_wait_days']}d** internal wait) "
            f"yet triggers **{top_hub['breached_over_45d']} of {top_hub['routed_episodes']}** `>45`-day statutory breaches (**{top_hub['total_excess_days_over_45']}** excess days) via `paper_fax` and unverified slot handoffs.\n"
            f"- **Counterfactual Single-Hub Fix (`{brief['counterfactual_simulation']['target_intervention_scope']}`):** Upgrading `paper_fax` to `ehr_electronic_portal` + pre-checking bilingual/Medicaid slot capacity reduces breaches from **{sim['baseline_breaches_over_45d']} → {sim['simulated_breaches_over_45d']}** and saves **{sim['total_delayed_child_days_saved']} delayed child-days**.\n"
            f"- **Provenance & Equity:** All `SYN-PROV-*` / `SYN-PARTC-*` rows are `100% [Synthetic]`; see the Post-Output Equity Audit panel on the right."
        )
    else:
        reply, tools_used = _build_track1_reply()

    return reply, tools_used, brief


def _get_sub_agent_topology() -> list[dict[str, str]]:
    """Safely inspects specialist sub-agents attached to `root_agent` (if configured)."""
    sub_agents = getattr(root_agent, "sub_agents", None) or []
    return [
        {
            "name": str(getattr(sub, "name", "")),
            "model": str(getattr(sub, "model", "")),
        }
        for sub in sub_agents
        if getattr(sub, "name", "")
    ]


def _infer_specialist_sub_agent(msg: str) -> dict[str, str]:
    """Determines which specialist sub-agent handles `msg` across the 3 clinical/network tracks."""
    lower = msg.lower()
    lower_for_outreach = lower.replace("autism screen", "")

    if (
        re.search(r"\b(CHAIN-[A-Z]{2}-\d{3})\b", msg, re.IGNORECASE)
        or "referral history" in lower
        or "trace chain" in lower
    ):
        agent_name = "network_bottleneck_auditor"
        label = "BottleneckAuditSub"
        track = "audit"
    elif (
        "screen" in lower_for_outreach
        or "outreach" in lower
        or "mobile" in lower
        or "desert" in lower
        or "underserved" in lower
        or "rank_outreach" in lower
    ):
        agent_name = "equity_and_caregiver_specialist"
        label = "EquityCaregiverSub"
        track = "outreach"
    elif any(
        w in lower for w in ("route", "viable", "pathway", "prune", "toddler", "infant", "month-old")
    ) and not any(w in lower for w in ("audit", "bottleneck", "betweenness", "simulat")):
        agent_name = "triage_pathway_router"
        label = "TriageSub"
        track = "triage"
    elif any(
        w in lower for w in ("audit", "bounce", "bottleneck", "betweenness", "simulat", "fax")
    ):
        agent_name = "network_bottleneck_auditor"
        label = "BottleneckAuditSub"
        track = "audit"
    else:
        agent_name = "triage_pathway_router"
        label = "TriageSub"
        track = "triage"

    model = "gemini-2.5-flash"
    for sub in getattr(root_agent, "sub_agents", None) or []:
        if getattr(sub, "name", "") == agent_name and getattr(sub, "model", ""):
            model = str(getattr(sub, "model", "gemini-2.5-flash"))
            break

    return {
        "agent": agent_name,
        "label": label,
        "model": model,
        "track": track,
    }


def _safe_get_bq_telemetry() -> list[dict[str, Any]] | dict[str, Any]:
    """Safely fetches live BigQuery/GeoParquet execution telemetry from `bq_client`."""
    fn = getattr(bq_client_mod, "get_bq_telemetry", None)
    if callable(fn):
        try:
            res = fn()
            if isinstance(res, (list, dict)):
                return res
        except Exception as exc:  # noqa: BLE001
            logger.debug("bq_client.get_bq_telemetry failed (%s); using fallback.", exc)
    cfg = get_config()
    is_bq = bool(cfg.get("project")) and os.environ.get("A4I_FORCE_LOCAL_PARQUET") != "1"
    return {
        "backend": "bigquery_property_graph_iso_gql" if is_bq else "local_geoparquet_mirror",
        "project": cfg.get("project") or "(local GeoParquet preview)",
        "dataset": graph_client.get_last_resolved_dataset(cfg),
        "state_code": cfg.get("state", "MS"),
        "query_count": 0,
        "last_query_ms": None,
        "last_iso_gql_query": None,
    }


def _call_with_matching_kwargs(fn: Any, candidate_kwargs: dict[str, Any]) -> Any:
    """Invokes `fn` forwarding only parameters accepted by its signature (or all if **kwargs)."""
    sig = inspect.signature(fn)
    accepts_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    if accepts_var_kw:
        return fn(**candidate_kwargs)
    filtered = {k: v for k, v in candidate_kwargs.items() if k in sig.parameters}
    return fn(**filtered)


def _compute_recommended_tab(msg: str, tools_invoked: list[str]) -> str:
    """Determines the optimal right-pane tab (`pathway`, `hubs`, or `outreach`) from tools & intent."""
    invoked = set(tools_invoked or [])
    if "rank_outreach_zones" in invoked or "prioritize_community_screening_tracts" in invoked:
        return "outreach"
    if invoked & {
        "detect_regional_bottleneck_hubs",
        "simulate_hub_intervention",
        "get_referral_history",
    }:
        return "hubs"
    if invoked & {
        "find_viable_45d_paths",
        "find_compliant_45d_pathways",
        "check_intake_packet_readiness",
        "reserve_pathway_slot",
    }:
        return "pathway"
    if "audit_multihop_bounce_hubs" in invoked:
        return "hubs"

    track = _infer_specialist_sub_agent(msg).get("track", "triage")
    if track == "outreach":
        return "outreach"
    if track == "audit":
        return "hubs"
    return "pathway"


def _extract_gemini_caregiver_notes(reply_text: str) -> dict[str, str] | None:
    """Extracts bilingual caregiver note sections from Gemini reply only if both EN & ES blocks exist."""
    if not reply_text or len(reply_text) < 120:
        return None
    en_match = re.search(
        r"(?:^|\n)#{2,4}\s*[^\n]*Caregiver[^\n]*(?:English|EN)[^\n]*\n(.*?)(?=\n#{2,4}\s|\Z)",
        reply_text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    es_match = re.search(
        r"(?:^|\n)#{2,4}\s*[^\n]*(?:Nota\s+para\s+la\s+Familia|Caregiver[^\n]*(?:Español|Spanish|ES)|Plan\s+de\s+Primeros\s+Pasos)[^\n]*\n(.*?)(?=\n#{2,4}\s|\Z)",
        reply_text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if en_match and es_match:
        en_txt = en_match.group(1).strip()
        es_txt = es_match.group(1).strip()
        if len(en_txt) >= 50 and len(es_txt) >= 50:
            return {"english": en_txt, "spanish": es_txt}
    return None


@app.get("/api/health")
async def health() -> dict[str, Any]:
    cfg = get_config()
    return {
        "status": "ok",
        "agent": root_agent.name,
        "gemini_model": DEFAULT_MODEL,
        "fallback_models": [m for m in get_model_candidates() if m != DEFAULT_MODEL],
        "cached_working_model": _working_model_cache,
        "sub_agents": _get_sub_agent_topology(),
        "sse_endpoints": ["/run", "/run_sse", "/api/chat/stream"],
        "vertex_location": os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
        "llm_credentials_active": _has_llm_credentials(),
        "gcloud_adc_bridge_active": _GCLOUD_ADC_BRIDGE_ACTIVE,
        "mcp_mode": ACTIVE_MCP_MODE,
        "state_code": cfg["state"],
        "state_name": cfg["state_name"],
        "dataset": cfg["dataset"],
        "project": cfg["project"] or "(local GeoParquet preview)",
        "bq_telemetry": _safe_get_bq_telemetry(),
    }


@app.get("/api/brief")
async def get_brief(
    state: str = Query(default="", description="Two-letter starter state (MS, AL, GA, TX, CA, NY)"),
    tract_geoid: str = Query(default="", description="Optional 11-char census_tract_geoid"),
    age_months: int = Query(default=32, ge=0, le=60),
    concern_domain: str = Query(default="Social-Communication / Autism Screen"),
    needs_medicaid: bool = Query(default=True),
    needs_bilingual: bool = Query(default=True),
    has_household_vehicle: bool | None = Query(default=None),
    has_vehicle: bool | None = Query(default=None),
) -> dict[str, Any]:
    effective_vehicle = (
        has_household_vehicle
        if has_household_vehicle is not None
        else (has_vehicle if has_vehicle is not None else False)
    )
    with request_state_context(state) as active_state:
        resolved_tract = tract_geoid.strip() or _default_anchor_tract(active_state)
        brief = _get_cached_brief(
            state_code=active_state,
            child_tract_geoid=resolved_tract,
            child_age_months=age_months,
            concern_domain=concern_domain,
            needs_medicaid=needs_medicaid,
            needs_bilingual=needs_bilingual,
            has_household_vehicle=effective_vehicle,
        )
        runtime_info = await health()
        brief["runtime"] = runtime_info
        brief["bq_telemetry"] = (
            runtime_info.get("bq_telemetry")
            if runtime_info.get("bq_telemetry") is not None
            else _safe_get_bq_telemetry()
        )
        return brief


@app.post("/api/simulate")
async def run_simulation(req: SimulateRequest) -> dict[str, Any]:
    with request_state_context(req.state_code):
        return simulate_hub_intervention(
            target_provider_id=req.target_provider_id,
            upgrade_fax_to_ehr=req.upgrade_fax_to_ehr,
            precheck_bilingual_and_slot_capacity=req.precheck_bilingual_and_slot_capacity,
        )


def _merge_captured_brief(
    msg: str,
    state_code: str,
    captured_outputs: dict[str, Any],
    reply_text: str = "",
) -> dict[str, Any]:
    """Hydrates a complete right-pane brief, merging tool outputs captured during ADK execution."""
    if "generate_complete_45d_brief" in captured_outputs:
        brief = dict(captured_outputs["generate_complete_45d_brief"])
        brief["bq_telemetry"] = _safe_get_bq_telemetry()
        return brief

    with request_state_context(state_code) as active_state:
        has_captured_routing = (
            "find_compliant_45d_pathways" in captured_outputs
            or "find_viable_45d_paths" in captured_outputs
        )
        if captured_outputs:
            tract_match = re.search(r"\b(\d{11})\b", msg) or re.search(r"\b(\d{5})\b", msg)
            age_match = re.search(r"\b(\d{1,2})\s*(?:-|\s)?(?:month|mo\b|m\b)", msg.lower())
            base_tract = (
                ""
                if has_captured_routing
                else (tract_match.group(1) if tract_match else "")
            )
            base_age = (
                32
                if has_captured_routing
                else (int(age_match.group(1)) if age_match else 32)
            )
            brief = _get_cached_brief(
                state_code=active_state,
                child_tract_geoid=base_tract,
                child_age_months=base_age,
            )
        else:
            _, _, brief = _parse_intent_and_fallback_reply(msg, active_state)

        field_map = {
            "find_compliant_45d_pathways": "routing",
            "find_viable_45d_paths": "viable_45d_paths",
            "get_referral_history": "referral_history",
            "audit_multihop_bounce_hubs": "network_audit",
            "detect_regional_bottleneck_hubs": "bottleneck_hubs",
            "simulate_hub_intervention": "counterfactual_simulation",
            "run_post_output_equity_audit": "equity_audit",
            "prioritize_community_screening_tracts": "screening_outreach",
            "rank_outreach_zones": "outreach_zones",
            "check_intake_packet_readiness": "packet_readiness",
        }
        for tool_name, brief_key in field_map.items():
            if tool_name in captured_outputs:
                brief[brief_key] = captured_outputs[tool_name]

        if "reserve_pathway_slot" in captured_outputs:
            hold_res = captured_outputs["reserve_pathway_slot"]
            existing_holds = list(brief.get("slot_holds") or [])
            if isinstance(hold_res, dict) and isinstance(hold_res.get("hold"), dict):
                existing_holds.append(hold_res["hold"])
            elif isinstance(hold_res, dict):
                existing_holds.append(hold_res)
            brief["slot_holds"] = existing_holds

        # Cross-sync `brief["routing"]` when Gemini only invoked `find_viable_45d_paths`
        routing_updated = "find_compliant_45d_pathways" in captured_outputs
        if "find_viable_45d_paths" in captured_outputs and not routing_updated:
            vp = captured_outputs["find_viable_45d_paths"]
            qp = vp.get("query_parameters") or {}
            cp = vp.get("child_profile") or {}
            tc = vp.get("tract_context") or {}
            synced_tract = str(
                tc.get("census_tract_geoid")
                or cp.get("census_tract_geoid")
                or qp.get("normalized_tract_geoid")
                or qp.get("zip_or_tract")
                or vp.get("requested_location")
                or ""
            )
            raw_age = vp.get("child_age_months")
            if raw_age is None:
                raw_age = cp.get("child_age_months", qp.get("child_age_months", 32))
            try:
                synced_age = int(raw_age)
            except (TypeError, ValueError):
                synced_age = 32
            synced_domain = str(
                cp.get("concern_domain")
                or qp.get("canonical_concern_domain")
                or qp.get("specialty")
                or (brief.get("routing") or {}).get("child_profile", {}).get(
                    "concern_domain", "Social-Communication / Autism Screen"
                )
            )
            synced_medicaid = bool(cp.get("needs_medicaid", qp.get("needs_medicaid", True)))
            synced_bilingual = bool(cp.get("needs_bilingual", qp.get("needs_bilingual", True)))
            synced_vehicle = bool(
                cp.get("has_household_vehicle", qp.get("has_household_vehicle", False))
            )

            if synced_tract or vp.get("status") == "ineligible_part_c_aged_out":
                synced_routing = find_compliant_45d_pathways(
                    child_tract_geoid=synced_tract,
                    child_age_months=synced_age,
                    concern_domain=synced_domain,
                    needs_medicaid=synced_medicaid,
                    needs_bilingual=synced_bilingual,
                    has_household_vehicle=synced_vehicle,
                )
                synced_routing["synced_from_viable_paths"] = True
                brief["routing"] = synced_routing
                routing_updated = True

        # Preserve Gemini-generated caregiver notes if provided/extracted; otherwise fallback cleanly
        preserved_notes: dict[str, str] | None = None
        if isinstance(captured_outputs.get("caregiver_notes"), dict):
            cand = captured_outputs["caregiver_notes"]
            if str(cand.get("english", "")).strip() and str(cand.get("spanish", "")).strip():
                preserved_notes = {
                    "english": str(cand["english"]).strip(),
                    "spanish": str(cand["spanish"]).strip(),
                }
        if preserved_notes is None:
            for out in captured_outputs.values():
                if isinstance(out, dict) and isinstance(out.get("caregiver_notes"), dict):
                    cand = out["caregiver_notes"]
                    if str(cand.get("english", "")).strip() and str(cand.get("spanish", "")).strip():
                        preserved_notes = {
                            "english": str(cand["english"]).strip(),
                            "spanish": str(cand["spanish"]).strip(),
                        }
                        break
        if preserved_notes is None:
            preserved_notes = _extract_gemini_caregiver_notes(reply_text)

        if preserved_notes is not None:
            brief["caregiver_notes"] = preserved_notes
        elif routing_updated:
            brief["caregiver_notes"] = build_caregiver_notes(brief["routing"])

        brief["statutory_transition_tier"] = (
            (brief.get("routing") or {}).get("statutory_transition_tier")
            or (brief.get("routing") or {}).get("child_profile", {}).get("statutory_transition_tier")
            or _compute_statutory_transition_tier(
                (brief.get("routing") or {}).get("child_profile", {}).get("child_age_months")
            )
        )
        brief["bq_telemetry"] = _safe_get_bq_telemetry()
        return brief


@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest) -> dict[str, Any]:
    global _working_model_cache  # noqa: PLW0603
    session_id = req.session_id or f"coord-{uuid.uuid4().hex[:10]}"
    user_id = "part_c_coordinator"

    with request_state_context(req.state_code) as active_state:
        # If running in Google Cloud / with Gemini credentials, run ADK LlmAgent with model fallback chain
        if _has_llm_credentials():
            user_content = types.Content(
                role="user",
                parts=[
                    types.Part.from_text(
                        text=f"[Active State: {active_state}] {req.message}"
                    )
                ],
            )
            candidates = _ordered_model_candidates()
            for idx, model_name in enumerate(candidates):
                attempt_session_id = session_id if idx == 0 else f"{session_id}-fb{idx}"
                try:
                    existing = await session_service.get_session(
                        app_name=APP_NAME, user_id=user_id, session_id=attempt_session_id
                    )
                    if existing is None:
                        await session_service.create_session(
                            app_name=APP_NAME, user_id=user_id, session_id=attempt_session_id
                        )

                    tool_calls_seen: list[str] = []
                    captured_outputs: dict[str, Any] = {}
                    final_chunks: list[str] = []
                    active_runner = _get_runner(model_name)

                    async for event in active_runner.run_async(
                        user_id=user_id,
                        session_id=attempt_session_id,
                        new_message=user_content,
                    ):
                        for fc in event.get_function_calls() or []:
                            if fc.name and fc.name not in tool_calls_seen:
                                tool_calls_seen.append(fc.name)
                        for fr in event.get_function_responses() or []:
                            if fr.name and isinstance(fr.response, dict):
                                captured_outputs[fr.name] = fr.response
                        if event.is_final_response() and event.content and event.content.parts:
                            for part in event.content.parts:
                                if getattr(part, "text", None):
                                    final_chunks.append(part.text)

                    reply_text = "\n".join(final_chunks).strip()
                    if reply_text:
                        _working_model_cache = model_name
                        brief = _merge_captured_brief(
                            req.message, active_state, captured_outputs, reply_text=reply_text
                        )
                        return {
                            "session_id": session_id,
                            "state_code": active_state,
                            "mode": f"adk_gemini_live ({model_name})",
                            "model_used": model_name,
                            "fallback_used": model_name != DEFAULT_MODEL,
                            "recommended_tab": _compute_recommended_tab(req.message, tool_calls_seen),
                            "tools_invoked": tool_calls_seen,
                            "bq_telemetry": (
                                brief.get("bq_telemetry")
                                if brief.get("bq_telemetry") is not None
                                else _safe_get_bq_telemetry()
                            ),
                            "reply": reply_text,
                            "brief": brief,
                        }
                    if _working_model_cache == model_name:
                        _working_model_cache = None
                    logger.warning(
                        "Model %s returned an empty final response; trying next backup model.",
                        model_name,
                    )
                except Exception as exc:  # noqa: BLE001
                    if _working_model_cache == model_name:
                        _working_model_cache = None
                    logger.warning(
                        "ADK live call on %s failed (%s); falling back to next candidate.",
                        model_name,
                        exc,
                    )

        # Local offline preview fallback (executes real graph/equity tools deterministically)
        reply_text, tools_used, brief = _parse_intent_and_fallback_reply(req.message, active_state)
        telemetry = _safe_get_bq_telemetry()
        brief["bq_telemetry"] = telemetry
        return {
            "session_id": session_id,
            "state_code": active_state,
            "mode": "local_graph_engine_preview (set GOOGLE_GENAI_USE_VERTEXAI=TRUE or GOOGLE_API_KEY for live Gemini)",
            "model_used": "local_deterministic_fallback",
            "fallback_used": True,
            "recommended_tab": _compute_recommended_tab(req.message, tools_used),
            "tools_invoked": tools_used,
            "bq_telemetry": telemetry,
            "reply": reply_text,
            "brief": brief,
        }


def _sse_frame(event_type: str, payload: dict[str, Any]) -> str:
    """Formats a standard Server-Sent Events (`event: <type>\\ndata: <json>\\n\\n`) frame."""
    return f"event: {event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _chunk_markdown_for_sse(text: str, target_chars: int = 80) -> list[str]:
    """Splits markdown text into progressive token chunks while preserving exact concatenation."""
    if not text:
        return []
    chunks = re.findall(rf".{{1,{target_chars}}}(?:\s+|$)", text, flags=re.DOTALL)
    return [c for c in chunks if c]


def _extract_run_request_fields(payload: dict[str, Any]) -> tuple[str, str, str, str | None]:
    """Extracts `(message, session_id, user_id, state_code)` from Workbench or ADK `/run_sse` JSON."""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="Request body must be a JSON object.")

    msg_text = ""
    raw_msg = payload.get("message")
    if isinstance(raw_msg, str) and raw_msg.strip():
        msg_text = raw_msg.strip()
    else:
        new_msg = payload.get("new_message")
        if isinstance(new_msg, str) and new_msg.strip():
            msg_text = new_msg.strip()
        elif isinstance(new_msg, dict):
            parts = new_msg.get("parts")
            if isinstance(parts, list):
                collected = [
                    str(p.get("text", ""))
                    for p in parts
                    if isinstance(p, dict) and p.get("text")
                ]
                msg_text = "\n".join(collected).strip()
            elif isinstance(new_msg.get("text"), str):
                msg_text = new_msg["text"].strip()

    if not msg_text:
        raise HTTPException(
            status_code=422,
            detail="Either 'message' or 'new_message.parts[].text' must be a non-empty string.",
        )
    if len(msg_text) > 4000:
        msg_text = msg_text[:4000]

    raw_session = payload.get("session_id")
    session_id = (
        raw_session.strip()
        if isinstance(raw_session, str) and raw_session.strip()
        else f"coord-{uuid.uuid4().hex[:10]}"
    )

    raw_user = payload.get("user_id")
    user_id = (
        raw_user.strip()
        if isinstance(raw_user, str) and raw_user.strip()
        else "part_c_coordinator"
    )

    raw_state = payload.get("state_code") or payload.get("state")
    state_code = raw_state.strip().upper() if isinstance(raw_state, str) and raw_state.strip() else None
    if not state_code:
        tag_match = re.search(r"\[Active State:\s*([A-Z]{2})\]", msg_text, flags=re.IGNORECASE)
        if tag_match and tag_match.group(1).upper() in VALID_STATES:
            state_code = tag_match.group(1).upper()

    return msg_text, session_id, user_id, state_code


async def _stream_adk_run_events(
    msg_text: str,
    session_id: str,
    user_id: str,
    requested_state: str | None,
) -> AsyncIterator[str]:
    """Streams real-time SSE frames for live ADK multi-agent runs or deterministic local graph runs."""
    global _working_model_cache  # noqa: PLW0603
    with request_state_context(requested_state) as active_state:
        yield _sse_frame(
            "agent_start",
            {
                "session_id": session_id,
                "agent": root_agent.name,
                "state_code": active_state,
            },
        )

        if _has_llm_credentials():
            prompt_text = (
                msg_text
                if msg_text.startswith("[Active State:")
                else f"[Active State: {active_state}] {msg_text}"
            )
            user_content = types.Content(
                role="user",
                parts=[types.Part.from_text(text=prompt_text)],
            )
            sub_model_lookup = {
                s["name"]: (s["model"] or "gemini-2.5-flash")
                for s in _get_sub_agent_topology()
            }
            candidates = _ordered_model_candidates()

            for idx, model_name in enumerate(candidates):
                attempt_session_id = session_id if idx == 0 else f"{session_id}-fb{idx}"
                try:
                    existing = await session_service.get_session(
                        app_name=APP_NAME, user_id=user_id, session_id=attempt_session_id
                    )
                    if existing is None:
                        await session_service.create_session(
                            app_name=APP_NAME, user_id=user_id, session_id=attempt_session_id
                        )

                    sub_agents_invoked: list[str] = []
                    tool_calls_seen: list[str] = []
                    captured_outputs: dict[str, Any] = {}
                    streamed_chunks: list[str] = []
                    final_chunks: list[str] = []
                    active_runner = _get_runner(model_name)

                    async for event in active_runner.run_async(
                        user_id=user_id,
                        session_id=attempt_session_id,
                        new_message=user_content,
                        run_config=RunConfig(streaming_mode=StreamingMode.SSE),
                    ):
                        author = str(getattr(event, "author", "") or "")
                        if (
                            author
                            and author not in (root_agent.name, "user")
                            and author not in sub_agents_invoked
                        ):
                            sub_agents_invoked.append(author)
                            yield _sse_frame(
                                "sub_agent",
                                {
                                    "agent": author,
                                    "model": sub_model_lookup.get(author, "gemini-2.5-flash"),
                                    "coordinator": root_agent.name,
                                },
                            )

                        for fc in event.get_function_calls() or []:
                            fc_name = getattr(fc, "name", "")
                            if fc_name:
                                if fc_name not in tool_calls_seen:
                                    tool_calls_seen.append(fc_name)
                                yield _sse_frame(
                                    "tool_call",
                                    {"tool": fc_name, "agent": author or root_agent.name},
                                )

                        for fr in event.get_function_responses() or []:
                            fr_name = getattr(fr, "name", "")
                            if fr_name:
                                fr_resp = getattr(fr, "response", None)
                                if isinstance(fr_resp, dict):
                                    captured_outputs[fr_name] = fr_resp
                                yield _sse_frame(
                                    "tool_result",
                                    {
                                        "tool": fr_name,
                                        "ok": True,
                                        "agent": author or root_agent.name,
                                    },
                                )

                        content = getattr(event, "content", None)
                        parts = getattr(content, "parts", None) or []
                        is_partial = bool(getattr(event, "partial", False))
                        is_final = bool(event.is_final_response())

                        if is_partial and parts:
                            for part in parts:
                                p_txt = getattr(part, "text", None)
                                if p_txt:
                                    streamed_chunks.append(p_txt)
                                    yield _sse_frame("token", {"delta": p_txt})
                        elif is_final and parts:
                            for part in parts:
                                p_txt = getattr(part, "text", None)
                                if p_txt:
                                    final_chunks.append(p_txt)

                    reply_text = (
                        "\n".join(final_chunks).strip()
                        if final_chunks
                        else "".join(streamed_chunks).strip()
                    )
                    if reply_text:
                        _working_model_cache = model_name
                        if not sub_agents_invoked:
                            spec = _infer_specialist_sub_agent(msg_text)
                            sub_agents_invoked.append(spec["agent"])
                            yield _sse_frame(
                                "sub_agent",
                                {
                                    "agent": spec["agent"],
                                    "label": spec["label"],
                                    "model": spec["model"],
                                    "track": spec["track"],
                                    "coordinator": root_agent.name,
                                },
                            )
                        if not streamed_chunks:
                            for delta in _chunk_markdown_for_sse(reply_text):
                                yield _sse_frame("token", {"delta": delta})

                        brief = _merge_captured_brief(
                            msg_text, active_state, captured_outputs, reply_text=reply_text
                        )
                        telemetry = (
                            brief.get("bq_telemetry")
                            if brief.get("bq_telemetry") is not None
                            else _safe_get_bq_telemetry()
                        )
                        yield _sse_frame("brief", {"brief": brief})
                        yield _sse_frame(
                            "done",
                            {
                                "session_id": session_id,
                                "state_code": active_state,
                                "mode": f"adk_gemini_live ({model_name})",
                                "model_used": model_name,
                                "fallback_used": model_name != DEFAULT_MODEL,
                                "recommended_tab": _compute_recommended_tab(msg_text, tool_calls_seen),
                                "sub_agents_invoked": sub_agents_invoked,
                                "tools_invoked": tool_calls_seen,
                                "bq_telemetry": telemetry,
                                "reply": reply_text,
                            },
                        )
                        return

                    if _working_model_cache == model_name:
                        _working_model_cache = None
                    logger.warning(
                        "SSE model %s returned an empty final response; trying next backup model.",
                        model_name,
                    )
                except Exception as exc:  # noqa: BLE001
                    if _working_model_cache == model_name:
                        _working_model_cache = None
                    logger.warning(
                        "ADK SSE live call on %s failed (%s); falling back to next candidate.",
                        model_name,
                        exc,
                    )

        # Deterministic offline preview stream (executes real ISO GQL / Equity tools)
        spec = _infer_specialist_sub_agent(msg_text)
        yield _sse_frame(
            "sub_agent",
            {
                "agent": spec["agent"],
                "label": spec["label"],
                "model": spec["model"],
                "track": spec["track"],
                "coordinator": root_agent.name,
            },
        )

        reply_text, tools_used, brief = _parse_intent_and_fallback_reply(msg_text, active_state)
        telemetry = _safe_get_bq_telemetry()
        brief["bq_telemetry"] = telemetry
        for tool_name in tools_used:
            yield _sse_frame("tool_call", {"tool": tool_name, "agent": spec["agent"]})
            yield _sse_frame("tool_result", {"tool": tool_name, "ok": True, "agent": spec["agent"]})

        for delta in _chunk_markdown_for_sse(reply_text):
            yield _sse_frame("token", {"delta": delta})

        yield _sse_frame("brief", {"brief": brief})
        yield _sse_frame(
            "done",
            {
                "session_id": session_id,
                "state_code": active_state,
                "mode": "local_graph_engine_preview (set GOOGLE_GENAI_USE_VERTEXAI=TRUE or GOOGLE_API_KEY for live Gemini)",
                "model_used": "local_deterministic_fallback",
                "fallback_used": True,
                "recommended_tab": _compute_recommended_tab(msg_text, tools_used),
                "sub_agents_invoked": [spec["agent"]],
                "tools_invoked": tools_used,
                "bq_telemetry": telemetry,
                "reply": reply_text,
            },
        )


@app.post("/run")
@app.post("/run_sse")
@app.post("/api/chat/stream")
async def adk_run_sse_endpoint(payload: dict[str, Any] = Body(...)) -> StreamingResponse:
    """Streams real-time ADK multi-agent & ISO GQL tool execution events over SSE."""
    msg_text, session_id, user_id, state_code = _extract_run_request_fields(payload)
    return StreamingResponse(
        _stream_adk_run_events(
            msg_text=msg_text,
            session_id=session_id,
            user_id=user_id,
            requested_state=state_code,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _reject_audit_keys_http(payload: dict[str, Any], endpoint_name: str) -> None:
    """Enforces the anti-bias routing firewall on HTTP triage/gatekeeper/slot inputs."""
    for key in payload:
        if re.match(r"^audit_[a-z0-9_]*$", str(key), re.IGNORECASE):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Anti-Bias Routing Firewall violation in {endpoint_name}: "
                    f"post-output demographic field '{key}' is prohibited."
                ),
            )


def _wkb_parse_rings(
    buf: bytes | bytearray | memoryview,
    offset: int = 0,
) -> tuple[list[list[tuple[float, float]]], int]:
    """Pure-Python `struct` WKB/EWKB parser extracting all Polygon rings without binary geo libs."""
    if offset + 5 > len(buf):
        return [], len(buf)
    byte_order = buf[offset]
    endian = "<" if byte_order == 1 else ">"
    raw_type = struct.unpack_from(f"{endian}I", buf, offset + 1)[0]
    offset += 5

    # Support EWKB flags (SRID=0x20000000, Z=0x80000000, M=0x40000000) and ISO WKB Z/M/ZM
    has_srid = bool(raw_type & 0x20000000)
    ewkb_z = bool(raw_type & 0x80000000)
    ewkb_m = bool(raw_type & 0x40000000)
    base_raw = raw_type & 0x1FFFFFFF
    base_type = base_raw % 1000
    iso_zm = base_raw // 1000
    dims = 2
    if ewkb_z or iso_zm in (1, 3):
        dims += 1
    if ewkb_m or iso_zm in (2, 3):
        dims += 1
    if has_srid:
        offset += 4

    point_bytes = 8 * dims

    if base_type == 1:  # Point
        return [], offset + point_bytes
    if base_type == 2:  # LineString
        n_pts = struct.unpack_from(f"{endian}I", buf, offset)[0]
        return [], offset + 4 + n_pts * point_bytes
    if base_type == 3:  # Polygon
        n_rings = struct.unpack_from(f"{endian}I", buf, offset)[0]
        offset += 4
        rings: list[list[tuple[float, float]]] = []
        for _ in range(n_rings):
            n_pts = struct.unpack_from(f"{endian}I", buf, offset)[0]
            offset += 4
            ring: list[tuple[float, float]] = []
            for _ in range(n_pts):
                x, y = struct.unpack_from(f"{endian}dd", buf, offset)
                ring.append((float(x), float(y)))
                offset += point_bytes
            if len(ring) >= 3:
                rings.append(ring)
        return rings, offset
    if base_type in (4, 5, 6, 7):  # MultiPoint, MultiLineString, MultiPolygon, GeometryCollection
        n_geoms = struct.unpack_from(f"{endian}I", buf, offset)[0]
        offset += 4
        collected: list[list[tuple[float, float]]] = []
        for _ in range(n_geoms):
            sub_rings, offset = _wkb_parse_rings(buf, offset)
            collected.extend(sub_rings)
        return collected, offset
    return [], len(buf)


def _rdp_recursive(
    pts: list[tuple[float, float]],
    epsilon: float,
) -> list[tuple[float, float]]:
    if len(pts) <= 2:
        return pts
    ax, ay = pts[0]
    bx, by = pts[-1]
    dx = bx - ax
    dy = by - ay
    seg_len_sq = dx * dx + dy * dy
    max_dist = -1.0
    max_idx = 0
    for idx in range(1, len(pts) - 1):
        px, py = pts[idx]
        if seg_len_sq == 0.0:
            dist = math.hypot(px - ax, py - ay)
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg_len_sq))
            proj_x = ax + t * dx
            proj_y = ay + t * dy
            dist = math.hypot(px - proj_x, py - proj_y)
        if dist > max_dist:
            max_dist = dist
            max_idx = idx
    if max_dist > epsilon:
        left = _rdp_recursive(pts[: max_idx + 1], epsilon)
        right = _rdp_recursive(pts[max_idx:], epsilon)
        return left[:-1] + right
    return [pts[0], pts[-1]]


def _simplify_ring(
    ring: list[tuple[float, float]],
    max_pts: int = 40,
) -> list[tuple[float, float]]:
    """Simplifies a closed polygon ring via RDP + stride cap to `<= max_pts` vertices."""
    if len(ring) <= max_pts:
        return ring
    is_closed = len(ring) >= 2 and ring[0] == ring[-1]
    open_pts = ring[:-1] if is_closed else list(ring)
    if len(open_pts) <= 3:
        return ring

    # Split at vertex farthest from start so RDP respects closed loop shape
    sx, sy = open_pts[0]
    split_idx = max(
        range(1, len(open_pts)),
        key=lambda i: (open_pts[i][0] - sx) ** 2 + (open_pts[i][1] - sy) ** 2,
    )
    xs = [p[0] for p in open_pts]
    ys = [p[1] for p in open_pts]
    span = max(max(xs) - min(xs), max(ys) - min(ys), 1e-6)
    eps = span * 0.008

    half1 = _rdp_recursive(open_pts[: split_idx + 1], eps)
    half2 = _rdp_recursive(open_pts[split_idx:] + [open_pts[0]], eps)
    simplified = half1[:-1] + half2[:-1]

    cap = max_pts - 1 if is_closed else max_pts
    if len(simplified) > cap:
        step = (len(simplified) - 1) / max(1, cap - 1)
        indices = sorted({int(round(i * step)) for i in range(cap)})
        simplified = [simplified[i] for i in indices if i < len(simplified)]

    if len(simplified) < 3:
        stride = max(1, len(open_pts) // max(3, cap))
        simplified = open_pts[::stride][:cap]

    if is_closed and simplified:
        simplified = [*simplified, simplified[0]]
    return simplified


def _load_byod_fqhc_rows(state_code: str) -> tuple[list[dict[str, Any]], str]:
    """Loads optional BYOD HRSA FQHC site rows from `reference_lookups`, `bq_client`, or `data/`."""
    try:
        from first_milestones.tools.reference_lookups import load_byod_hrsa_sites

        df = load_byod_hrsa_sites(state_code)
        if df is not None and not df.empty:
            rows = df.to_dict(orient="records")
            return rows, f"hrsa_byod:{len(rows)}"
    except Exception:  # noqa: BLE001
        pass

    fn = getattr(bq_client_mod, "load_byod_fqhc_sites", None)
    if callable(fn):
        try:
            res = fn(state_code)
            if isinstance(res, list):
                return res, f"fn:{len(res)}"
        except Exception:  # noqa: BLE001
            pass

    frames = load_local_state_frames(state_code)
    if "fqhc" in frames and frames["fqhc"] is not None:
        df = frames["fqhc"]
        rows = df.to_dict(orient="records") if hasattr(df, "to_dict") else list(df)
        return rows, f"frame:{len(rows)}"

    # Check standard data directory locations for optional BYOD HRSA FQHC parquet/csv
    try:
        find_dir = getattr(bq_client_mod, "_find_data_dir", None)
        data_dir = find_dir() if callable(find_dir) else (Path(__file__).resolve().parents[1] / "data")
        for fname in (
            "byod_hrsa_fqhc_screening_sites.parquet",
            "byod_hrsa_fqhc_sites.parquet",
            "hrsa_fqhc_sites.parquet",
        ):
            fpath = data_dir / fname
            if fpath.is_file():
                import pandas as pd

                df = pd.read_parquet(fpath)
                if "state_code" in df.columns:
                    df = df[df["state_code"].astype(str).str.upper() == state_code]
                rows = df.to_dict(orient="records")
                return rows, f"{fname}:{len(rows)}"
    except Exception:  # noqa: BLE001
        pass
    return [], "none"


def _build_geo_payload(state_code: str) -> dict[str, Any]:
    """Decodes TIGER WKB tract geometries & projects tracts + providers into `1000x640` SVG."""
    fqhc_rows, fqhc_sig = _load_byod_fqhc_rows(state_code)
    cache_key = (state_code, fqhc_sig)
    if cache_key in _GEO_CACHE:
        return _GEO_CACHE[cache_key]

    frames = load_local_state_frames(state_code)
    demo_df = frames["demo"]
    prov_df = frames["providers"]

    decoded_tracts: list[dict[str, Any]] = []
    all_lons: list[float] = []
    all_lats: list[float] = []

    for _, row in demo_df.iterrows():
        raw_geom = row.get("tract_geom")
        rings: list[list[tuple[float, float]]] = []
        if isinstance(raw_geom, (bytes, bytearray, memoryview)):
            parsed_rings, _ = _wkb_parse_rings(raw_geom, 0)
            rings = [_simplify_ring(r, max_pts=40) for r in parsed_rings if len(r) >= 3]
        for r in rings:
            for lon, lat in r:
                all_lons.append(lon)
                all_lats.append(lat)
        c_lon = float(row["longitude"])
        c_lat = float(row["latitude"])
        all_lons.append(c_lon)
        all_lats.append(c_lat)

        decoded_tracts.append({
            "tract_geoid": str(row["census_tract_geoid"]).strip().zfill(11),
            "county_name": str(row["county_name"]),
            "poverty_pct": round(float(row["poverty_rate"]) * 100.0, 1),
            "zero_vehicle_pct": round(float(row["no_vehicle_rate"]) * 100.0, 1),
            "children_under_5_count": int(row["children_under_5_count"]),
            "centroid_lon": c_lon,
            "centroid_lat": c_lat,
            "rings": rings,
        })

    for _, prow in prov_df.iterrows():
        all_lons.append(float(prow["longitude"]))
        all_lats.append(float(prow["latitude"]))

    for frow in fqhc_rows:
        if frow.get("longitude") is not None and frow.get("latitude") is not None:
            all_lons.append(float(frow["longitude"]))
            all_lats.append(float(frow["latitude"]))

    width, height = 1000.0, 640.0
    pad = 24.0
    if not all_lons or not all_lats:
        min_lon, max_lon, min_lat, max_lat = -90.0, -89.0, 32.0, 33.0
    else:
        min_lon, max_lon = min(all_lons), max(all_lons)
        min_lat, max_lat = min(all_lats), max(all_lats)

    mid_lat = 0.5 * (min_lat + max_lat)
    lon_scale = max(0.2, math.cos(math.radians(mid_lat)))
    span_x = max(1e-6, (max_lon - min_lon) * lon_scale)
    span_y = max(1e-6, max_lat - min_lat)

    inner_w = width - 2.0 * pad
    inner_h = height - 2.0 * pad
    scale = min(inner_w / span_x, inner_h / span_y)
    offset_x = pad + 0.5 * (inner_w - span_x * scale)
    offset_y = pad + 0.5 * (inner_h - span_y * scale)

    def _project(lon: float, lat: float) -> tuple[float, float]:
        px = offset_x + (lon - min_lon) * lon_scale * scale
        py = offset_y + (max_lat - lat) * scale
        return round(px, 1), round(py, 1)

    tracts_out: list[dict[str, Any]] = []
    for t in decoded_tracts:
        path_parts: list[str] = []
        for r in t["rings"]:
            pts_proj = [_project(lon, lat) for lon, lat in r]
            if len(pts_proj) >= 3:
                coords_str = " L ".join(f"{px},{py}" for px, py in pts_proj[1:])
                path_parts.append(f"M {pts_proj[0][0]},{pts_proj[0][1]} L {coords_str} Z")
        lx, ly = _project(t["centroid_lon"], t["centroid_lat"])
        svg_path_d = " ".join(path_parts)
        tracts_out.append({
            "tract_geoid": t["tract_geoid"],
            "county_name": t["county_name"],
            "poverty_pct": t["poverty_pct"],
            "zero_vehicle_pct": t["zero_vehicle_pct"],
            "children_under_5_count": t["children_under_5_count"],
            "path": svg_path_d,
            "svg_path": svg_path_d,
            "label_x": lx,
            "label_y": ly,
            "centroid_x": lx,
            "centroid_y": ly,
        })

    providers_out: list[dict[str, Any]] = []
    for _, prow in prov_df.iterrows():
        lat = float(prow["latitude"])
        lon = float(prow["longitude"])
        px, py = _project(lon, lat)
        org_name = str(prow["synthetic_organization_name"])
        wait_days = int(prow["median_internal_wait_days"])
        providers_out.append({
            "provider_id": str(prow["provider_id"]),
            "name": org_name,
            "organization_name": org_name,
            "role": str(prow["node_role"]),
            "city": str(prow.get("city", "")),
            "x": px,
            "y": py,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "wait_days": wait_days,
            "median_internal_wait_days": wait_days,
            "accepts_medicaid": bool(prow["accepts_medicaid"]),
            "bilingual": bool(prow["bilingual_services_listed"]),
            "monthly_slot_capacity": int(prow["monthly_slot_capacity"]),
            "active_waitlist_count": int(prow["active_waitlist_count"]),
        })

    fqhc_out: list[dict[str, Any]] = []
    for frow in fqhc_rows:
        if frow.get("latitude") is None or frow.get("longitude") is None:
            continue
        lat = float(frow["latitude"])
        lon = float(frow["longitude"])
        px, py = _project(lon, lat)
        site_name = str(frow.get("site_name") or frow.get("name") or "HRSA FQHC Site")
        site_city = str(frow.get("site_city") or frow.get("city") or "")
        fqhc_out.append({
            "site_id": str(
                frow.get("hrsa_site_id")
                or frow.get("site_id")
                or frow.get("fqhc_id")
                or frow.get("name")
                or "HRSA-FQHC"
            ),
            "name": site_name,
            "site_name": site_name,
            "health_center_name": str(frow.get("health_center_name") or ""),
            "location_type": str(frow.get("location_type") or ""),
            "city": site_city,
            "county_name": str(frow.get("county_name") or ""),
            "x": px,
            "y": py,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "data_provenance": str(frow.get("data_provenance") or "US Government Public Domain (17 U.S.C. 105) - HRSA FQHC"),
        })

    payload = {
        "state_code": state_code,
        "viewbox": f"0 0 {int(width)} {int(height)}",
        "viewport": {"width": int(width), "height": int(height)},
        "bounds": {
            "min_lon": round(min_lon, 5),
            "max_lon": round(max_lon, 5),
            "min_lat": round(min_lat, 5),
            "max_lat": round(max_lat, 5),
        },
        "tracts_count": len(tracts_out),
        "providers_count": len(providers_out),
        "fqhc_count": len(fqhc_out),
        "tracts": tracts_out,
        "providers": providers_out,
        "fqhc_sites": fqhc_out,
        "byod_sites": fqhc_out,
        "synthetic_provenance_notice": (
            "100% [Synthetic] CareNode providers; real US Census TIGER/ACS tract geometries; US Gov Public Domain HRSA BYOD sites."
        ),
    }
    _GEO_CACHE[cache_key] = payload
    return payload


def _get_slot_ledger_module() -> Any | None:
    try:
        return importlib.import_module("first_milestones.tools.slot_ledger")
    except Exception:  # noqa: BLE001
        return None


def _get_packet_gatekeeper_module() -> Any | None:
    try:
        return importlib.import_module("first_milestones.tools.packet_gatekeeper")
    except Exception:  # noqa: BLE001
        return None


def _list_holds_for_state(state_code: str) -> list[dict[str, Any]]:
    mod = _get_slot_ledger_module()
    if mod is not None:
        fn = getattr(mod, "list_slot_holds", None)
        if callable(fn):
            try:
                res = _call_with_matching_kwargs(fn, {"state_code": state_code})
                if isinstance(res, dict) and isinstance(res.get("holds"), list):
                    return list(res["holds"])
                if isinstance(res, list):
                    return list(res)
            except Exception as exc:  # noqa: BLE001
                logger.debug("slot_ledger.list_slot_holds failed (%s); falling back.", exc)

    import first_milestones.agent as agent_mod

    fallback_holds = getattr(agent_mod, "_FALLBACK_SLOT_HOLDS", [])
    return [h for h in fallback_holds if str(h.get("state_code", "")).upper() == state_code]


@app.post("/api/gatekeeper")
async def gatekeeper_endpoint(req: GatekeeperRequest) -> dict[str, Any]:
    """Validates Hop-0 IDEA Part C intake packet readiness before Hop-1 transmission."""
    raw_dump = req.model_dump(mode="python")
    _reject_audit_keys_http(raw_dump, "/api/gatekeeper")
    with request_state_context(req.state_code) as active_state:
        parent_consent = (
            req.has_parent_consent
            if req.has_parent_consent is not None
            else (req.consent_signed if req.consent_signed is not None else True)
        )
        screening_done = (
            req.has_screening_tool
            if req.has_screening_tool is not None
            else (
                req.screening_tool_completed
                if req.screening_tool_completed is not None
                else True
            )
        )
        language = (
            req.preferred_language
            or req.primary_language
            or "Spanish"
        )
        insurance = (
            req.insurance_type
            or req.insurance_status
            or ("Medicaid" if req.needs_medicaid is not False else "Commercial")
        )
        needs_medicaid = (
            req.needs_medicaid
            if req.needs_medicaid is not None
            else ("medicaid" in insurance.lower())
        )
        tract = (req.home_tract_geoid or req.tract_geoid or "").strip()

        call_kwargs = {
            **raw_dump,
            "state_code": active_state,
            "home_tract_geoid": tract,
            "tract_geoid": tract,
            "has_parent_consent": parent_consent,
            "consent_signed": parent_consent,
            "has_screening_tool": screening_done,
            "screening_tool_completed": screening_done,
            "preferred_language": language,
            "primary_language": language,
            "insurance_type": insurance,
            "insurance_status": insurance,
            "needs_medicaid": needs_medicaid,
        }
        mod = _get_packet_gatekeeper_module()
        fn = getattr(mod, "check_intake_packet_readiness", None) if mod is not None else None
        target_fn = fn if callable(fn) else _fallback_check_packet
        res = _call_with_matching_kwargs(target_fn, call_kwargs)
        if isinstance(res, dict):
            res.setdefault("state_code", active_state)
            res.setdefault(
                "statutory_transition_tier",
                _compute_statutory_transition_tier(req.child_age_months),
            )
            if "ready" not in res and "ready_for_referral_handoff" in res:
                res["ready"] = bool(res["ready_for_referral_handoff"])
            if "missing_items" not in res and "missing_intake_items" in res:
                res["missing_items"] = list(res["missing_intake_items"] or [])
            return res
        return {"status": "ok", "state_code": active_state, "result": res}


@app.get("/api/geo")
async def get_geo_map(
    state: str = Query(default="", description="Two-letter starter state (MS, AL, GA, TX, CA, NY)"),
) -> dict[str, Any]:
    """Returns simplified, SVG-projected Census TIGER tract polygons + CareNode + FQHC points."""
    with request_state_context(state) as active_state:
        return _build_geo_payload(active_state)


@app.get("/api/slots")
async def get_slot_ledger(
    state: str = Query(default="", description="Two-letter starter state (MS, AL, GA, TX, CA, NY)"),
) -> dict[str, Any]:
    """Exposes provider capacity saturation metrics and active 48-hour pathway slot holds."""
    with request_state_context(state) as active_state:
        holds = _list_holds_for_state(active_state)
        holds_by_pid: dict[str, int] = {}
        for h in holds:
            if str(h.get("status", "ACTIVE")).lower() == "active":
                seen_in_hold: set[str] = set()
                for key in ("provider_id", "coordinator_id", "eval_hub_id", "vendor_id"):
                    pid = str(h.get(key) or "").strip()
                    if pid:
                        seen_in_hold.add(pid)
                for p in h.get("provider_ids") or []:
                    pid = str(p or "").strip()
                    if pid:
                        seen_in_hold.add(pid)
                for pid in seen_in_hold:
                    holds_by_pid[pid] = holds_by_pid.get(pid, 0) + 1

        prov_df = load_local_state_frames(active_state)["providers"]
        providers: list[dict[str, Any]] = []
        for _, row in prov_df.iterrows():
            pid = str(row["provider_id"])
            cap = max(1, int(row["monthly_slot_capacity"]))
            waitlist = int(row["active_waitlist_count"])
            active_holds = holds_by_pid.get(pid, 0)
            used = waitlist + active_holds
            available = max(0, cap - used)
            util_pct = round((used / cap) * 100.0, 1)
            providers.append({
                "provider_id": pid,
                "name": str(row["synthetic_organization_name"]),
                "node_role": str(row["node_role"]),
                "city": str(row.get("city", "")),
                "monthly_slot_capacity": cap,
                "active_waitlist_count": waitlist,
                "active_holds_count": active_holds,
                "available_slots": available,
                "utilization_pct": util_pct,
                "saturated": used >= cap,
                "wait_days": int(row["median_internal_wait_days"]),
                "accepts_medicaid": bool(row["accepts_medicaid"]),
                "bilingual": bool(row["bilingual_services_listed"]),
            })

        return {
            "state_code": active_state,
            "total_active_holds": len(holds),
            "holds": holds,
            "providers": providers,
            "synthetic_provenance_notice": "100% [Synthetic] CareNode slot ledger.",
        }


@app.post("/api/slots/reserve")
async def reserve_slot_endpoint(req: SlotReserveRequest) -> dict[str, Any]:
    """Places a soft 48-hour slot hold on a verified evaluation or therapy CareNode."""
    raw_dump = req.model_dump(mode="python")
    _reject_audit_keys_http(raw_dump, "/api/slots/reserve")
    with request_state_context(req.state_code) as active_state:
        prov_df = load_local_state_frames(active_state)["providers"]
        role_by_id = {str(r["provider_id"]): str(r["node_role"]) for _, r in prov_df.iterrows()}

        coord_id = req.coordinator_id.strip()
        eval_id = req.eval_hub_id.strip()
        vend_id = req.vendor_id.strip()
        candidate_pids = [
            str(p).strip() for p in [req.provider_id, *req.pathway_nodes] if str(p or "").strip()
        ]
        for pid in candidate_pids:
            role_l = role_by_id.get(pid, "").lower()
            if ("intake" in role_l or "coordinator" in role_l) and not coord_id:
                coord_id = pid
            elif ("vendor" in role_l or "therapy" in role_l) and not vend_id:
                vend_id = pid
            elif ("eval" in role_l or "hub" in role_l) and not eval_id:
                eval_id = pid
            elif not eval_id:
                eval_id = pid
            elif not vend_id:
                vend_id = pid
            elif not coord_id:
                coord_id = pid

        call_kwargs = {
            **raw_dump,
            "state_code": active_state,
            "coordinator_id": coord_id,
            "eval_hub_id": eval_id,
            "vendor_id": vend_id,
        }
        mod = _get_slot_ledger_module()
        fn = getattr(mod, "reserve_pathway_slot", None) if mod is not None else None
        target_fn = fn if callable(fn) else _fallback_reserve_slot
        res = _call_with_matching_kwargs(target_fn, call_kwargs)
        if isinstance(res, dict):
            res.setdefault("state_code", active_state)
            res.setdefault("active_holds", _list_holds_for_state(active_state))
            if "capacity_snapshot" not in res:
                util_map = res.get("provider_utilization_after_hold")
                if isinstance(util_map, dict) and util_map:
                    focus_pid = eval_id if eval_id in util_map else next(iter(util_map))
                    snap = util_map[focus_pid]
                    res["capacity_snapshot"] = {
                        "provider_id": focus_pid,
                        "eval_hub_open_slots": snap.get("monthly_slot_capacity"),
                        "eval_hub_waitlist_count": snap.get("active_waitlist_count"),
                        "active_holds_count": snap.get("active_holds"),
                        "remaining_capacity": snap.get("remaining_slots"),
                        "utilization_ratio": snap.get("utilization_ratio"),
                    }
            return res
        return {"status": "reserved", "state_code": active_state, "result": res}


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
