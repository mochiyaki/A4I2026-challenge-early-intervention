"""Comprehensive verification tests for P0 & P1 reliability, safety, and prompt fixes."""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import AsyncGenerator
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from first_milestones.agent import create_coordinator_agent  # noqa: E402
from first_milestones.guardrails import (  # noqa: E402
    DIAGNOSIS_REFUSAL_PREFIX,
    guardrail_after_model_callback,
)
from first_milestones.prompts import (  # noqa: E402
    AUDIT_SUB_INSTRUCTION,
    EQUITY_SUB_INSTRUCTION,
    SYSTEM_INSTRUCTION,
    TRIAGE_SUB_INSTRUCTION,
)
from first_milestones.session_store import (  # noqa: E402
    SqlitePersistentSessionService,
    create_session_service,
)
from first_milestones.tools.bq_client import request_state_context  # noqa: E402
import main as server_main  # noqa: E402
from main import app  # noqa: E402


def _make_callback_ctx(user_text: str, via_invocation_ctx: bool = False) -> SimpleNamespace:
    content = types.Content(role="user", parts=[types.Part.from_text(text=user_text)])
    if via_invocation_ctx:
        return SimpleNamespace(_invocation_context=SimpleNamespace(user_content=content))
    return SimpleNamespace(user_content=content)


def _make_llm_response(text: str) -> LlmResponse:
    return LlmResponse(
        content=types.Content(role="model", parts=[types.Part.from_text(text=text)])
    )


# ---------------------------------------------------------------------------
# 1. P0: Compound Multi-Agent Diagnosis Refusal Preservation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("via_inv_ctx", [False, True])
def test_after_model_injects_diagnosis_refusal_when_missing(via_inv_ctx: bool) -> None:
    ctx = _make_callback_ctx(
        "Can you diagnose whether my 32-month-old son has autism, and what should we do next?",
        via_invocation_ctx=via_inv_ctx,
    )
    equity_only_reply = (
        "### Post-Output Equity & Access Audit (MS)\n\n"
        "- Recommended <=45-day electronic pathway: SYN-PROV-MS-007 -> SYN-PROV-MS-010 -> "
        "SYN-PROV-MS-020 -> SYN-PROV-MS-030 (30 days) for a 32-month-old child.\n"
        "- 36-month Part B transition notice applies.\n"
        "- All providers are 100% [Synthetic]."
    )
    out = guardrail_after_model_callback(ctx, _make_llm_response(equity_only_reply))
    assert out is not None
    txt = out.content.parts[0].text
    assert txt.startswith("I cannot provide a medical diagnosis or replace clinical judgment")
    assert txt.startswith(DIAGNOSIS_REFUSAL_PREFIX)
    assert "Post-Output Equity & Access Audit" in txt


def test_after_model_preserves_existing_diagnosis_refusal() -> None:
    ctx = _make_callback_ctx("Does my child have autism spectrum disorder?")
    compliant_reply = (
        "I cannot provide a medical diagnosis for autism. "
        "Please pursue an IDEA Part C <=45-day developmental evaluation via SYN-PROV-MS-010. "
        "All providers are 100% [Synthetic]."
    )
    out = guardrail_after_model_callback(ctx, _make_llm_response(compliant_reply))
    assert out is None


class _CompoundHandoffLlm(BaseLlm):
    """Simulates triage_pathway_router transferring to equity_and_caregiver_specialist which drops refusal."""

    model: str = "compound-handoff-test-llm"
    step: int = 0

    async def generate_content_async(
        self,
        llm_request: LlmRequest,
        stream: bool = False,
    ) -> AsyncGenerator[LlmResponse, None]:
        del llm_request, stream
        self.step += 1
        if self.step == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part.from_function_call(
                            name="transfer_to_agent",
                            args={"agent_name": "equity_and_caregiver_specialist"},
                        )
                    ],
                )
            )
        elif self.step == 2:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part.from_function_call(
                            name="run_post_output_equity_audit",
                            args={"state_code": "MS"},
                        )
                    ],
                )
            )
        else:
            # Sub-agent intentionally omits the diagnosis refusal
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part.from_text(
                            text=(
                                "### Post-Output Equity & Access Audit (MS)\n\n"
                                "- Statewide NSCH strata (6 rows) and tract equity context attached. "
                                "100% [Synthetic]."
                            )
                        )
                    ],
                )
            )


@pytest.mark.asyncio
async def test_adk_runner_compound_handoff_preserves_diagnosis_refusal() -> None:
    llm = _CompoundHandoffLlm()
    coord = create_coordinator_agent(model_name=llm, subagent_model=llm)  # type: ignore[arg-type]
    svc = InMemorySessionService()
    await svc.create_session(app_name="fm_test", user_id="u1", session_id="s-compound")
    test_runner = Runner(app_name="fm_test", agent=coord, session_service=svc)

    final_texts: list[str] = []
    with request_state_context("MS"):
        async for ev in test_runner.run_async(
            user_id="u1",
            session_id="s-compound",
            new_message=types.Content(
                role="user",
                parts=[
                    types.Part.from_text(
                        text="My 28-month-old avoids eye contact. Can you clinically diagnose autism and tell us what to do next?"
                    )
                ],
            ),
        ):
            if ev.is_final_response() and ev.content and ev.content.parts:
                for p in ev.content.parts:
                    if getattr(p, "text", None):
                        final_texts.append(p.text)

    combined = "\n".join(final_texts)
    assert "I cannot provide a medical diagnosis or replace clinical judgment" in combined
    assert "Post-Output Equity & Access Audit" in combined


def test_http_chat_and_sse_preserve_diagnosis_refusal() -> None:
    client = TestClient(app)
    prompt = "My 28-month-old doesn't respond to his name. Can you clinically diagnose autism right now, or route us?"

    r_chat = client.post("/api/chat", json={"message": prompt, "state_code": "MS"})
    assert r_chat.status_code == 200
    assert "cannot provide a medical diagnosis" in r_chat.json()["reply"].lower()

    with client.stream(
        "POST",
        "/api/chat/stream",
        json={"message": prompt, "state_code": "MS"},
    ) as r_sse:
        assert r_sse.status_code == 200
        raw = "".join(r_sse.iter_text())
    assert "cannot provide a medical diagnosis" in raw.lower()


# ---------------------------------------------------------------------------
# 2. P1 #1: Eliminate False 36-Month Aging-Out Alarms on 0-26m Toddlers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("age_str", ["20-month-old", "14-month-old"])
def test_after_model_strips_spurious_36m_alarms_for_under_27m(age_str: str) -> None:
    ctx = _make_callback_ctx(
        f"Route a {age_str} toddler in tract 28049003500 (MS). Check whether a 36-month aging-out alert applies."
    )
    spurious_reply = (
        f"### <=45-Day Compliant Pathway (MS)\n\n"
        f"- **Recommended Route:** SYN-PROV-MS-007 -> SYN-PROV-MS-010 -> SYN-PROV-MS-020 -> SYN-PROV-MS-030 (30 days) for this {age_str} toddler.\n"
        "- **36-Month Aging-Out Alert:** Approaching the 36-month cutoff; initiate concurrent IDEA Part B transition notice immediately!\n"
        "- **Mobility:** Authorize Medicaid NEMT.\n"
        "- All providers are 100% [Synthetic]."
    )
    out = guardrail_after_model_callback(ctx, _make_llm_response(spurious_reply))
    assert out is not None
    txt = out.content.parts[0].text
    assert "36-month" not in txt.lower()
    assert "aging-out" not in txt.lower()
    assert "part b" not in txt.lower()
    assert "SYN-PROV-MS-007" in txt
    assert "Medicaid NEMT" in txt


def test_after_model_strips_inline_spurious_sentence_but_keeps_negation_and_32m_safeguard() -> None:
    # 1. Inline spurious sentence on 14-month-old is stripped
    ctx_14 = _make_callback_ctx("Route a 14-month-old infant in MS.")
    inline_spurious = (
        "Recommended route clears 45 days via SYN-PROV-MS-010. "
        "Trigger concurrent IDEA Part B preschool transition notice before the 36-month cutoff. "
        "All providers are 100% [Synthetic]."
    )
    out_14 = guardrail_after_model_callback(ctx_14, _make_llm_response(inline_spurious))
    assert out_14 is not None
    txt_14 = out_14.content.parts[0].text
    assert "part b" not in txt_14.lower()
    assert "36-month" not in txt_14.lower()
    assert "SYN-PROV-MS-010" in txt_14

    # 2. Negated reassuring note on 20-month-old is preserved
    ctx_20 = _make_callback_ctx("Check 20-month-old toddler in MS.")
    reassuring = (
        "Recommended route takes 30 days via SYN-PROV-MS-010. "
        "At 20 months, the 36-month aging-out alert is not triggered. "
        "All providers are 100% [Synthetic]."
    )
    assert guardrail_after_model_callback(ctx_20, _make_llm_response(reassuring)) is None

    # 3. 32-month-old child still gets mandatory 36-month / Part B safeguard
    ctx_32 = _make_callback_ctx("Route a 32-month-old toddler in MS.")
    reply_32 = (
        "Recommended route for 32-month-old toddler: SYN-PROV-MS-001 -> SYN-PROV-MS-014 (24 days)."
    )
    out_32 = guardrail_after_model_callback(ctx_32, _make_llm_response(reply_32))
    assert out_32 is not None
    txt_32 = out_32.content.parts[0].text
    assert "36-month" in txt_32.lower()
    assert "part b" in txt_32.lower()
    assert "100% [Synthetic]" in txt_32


# ---------------------------------------------------------------------------
# 3. P1 #2: Prompts Alignment Checks
# ---------------------------------------------------------------------------


def test_prompts_contain_p0_p1_mandates() -> None:
    assert "Hop Delay: X days" in SYSTEM_INSTRUCTION
    assert "Cumulative Wait: X days" in SYSTEM_INSTRUCTION
    assert "active_waitlist_count" in SYSTEM_INSTRUCTION
    assert "detect_regional_bottleneck_hubs" in SYSTEM_INSTRUCTION
    assert "audit_multihop_bounce_hubs" in SYSTEM_INSTRUCTION
    assert "simulate_hub_intervention" in SYSTEM_INSTRUCTION
    assert "limited_english_rate = 0.0" in SYSTEM_INSTRUCTION
    assert "0–26" in SYSTEM_INSTRUCTION

    assert "detect_regional_bottleneck_hubs" in AUDIT_SUB_INSTRUCTION
    assert "audit_multihop_bounce_hubs" in AUDIT_SUB_INSTRUCTION
    assert "active_waitlist_count" in AUDIT_SUB_INSTRUCTION
    assert "Hop Delay: X days" in AUDIT_SUB_INSTRUCTION

    assert "I cannot provide a medical diagnosis" in EQUITY_SUB_INSTRUCTION
    assert "run_post_output_equity_audit" in EQUITY_SUB_INSTRUCTION
    assert "limited_english_rate = 0.0" in EQUITY_SUB_INSTRUCTION
    assert "0–26" in EQUITY_SUB_INSTRUCTION

    assert "Hop Delay: X days" in TRIAGE_SUB_INSTRUCTION
    assert "0-26m" in TRIAGE_SUB_INSTRUCTION


# ---------------------------------------------------------------------------
# 4. P1 #3: Persistent SQLite Session Store + Multi-Instance & ADK Runner
# ---------------------------------------------------------------------------


class _MultiTurnEchoLlm(BaseLlm):
    model: str = "echo-session-test-llm"

    async def generate_content_async(
        self,
        llm_request: LlmRequest,
        stream: bool = False,
    ) -> AsyncGenerator[LlmResponse, None]:
        del stream
        turns = len(llm_request.contents or [])
        last_parts = llm_request.contents[-1].parts if llm_request.contents else []
        last_txt = "".join(getattr(p, "text", "") or "" for p in (last_parts or []))
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part.from_text(
                        text=f"Turn {turns} reply (100% [Synthetic]): received '{last_txt[:40]}'"
                    )
                ],
            )
        )


@pytest.mark.asyncio
async def test_sqlite_session_service_persists_across_instances_and_runner(tmp_path: Path) -> None:
    db_file = tmp_path / "sessions.db"
    svc1 = SqlitePersistentSessionService(db_path=db_file)
    try:
        created = await svc1.create_session(
            app_name="fm_app",
            user_id="coord_1",
            session_id="sess-persist-01",
            state={"app:version": "v1", "user:preferred_lang": "es", "state_code": "MS"},
        )
        assert created.state["app:version"] == "v1"
        assert created.state["user:preferred_lang"] == "es"
        assert created.state["state_code"] == "MS"

        llm1 = _MultiTurnEchoLlm()
        coord1 = create_coordinator_agent(model_name=llm1, subagent_model=llm1)  # type: ignore[arg-type]
        runner1 = Runner(app_name="fm_app", agent=coord1, session_service=svc1)

        turn1_text = ""
        async for ev in runner1.run_async(
            user_id="coord_1",
            session_id="sess-persist-01",
            new_message=types.Content(
                role="user",
                parts=[types.Part.from_text(text="Turn one message")],
            ),
        ):
            if ev.is_final_response() and ev.content and ev.content.parts:
                turn1_text = ev.content.parts[0].text or ""
        assert "Turn 1 reply" in turn1_text
    finally:
        svc1.close()

    # Instantiate a brand-new SqlitePersistentSessionService pointed at the exact same DB file
    svc2 = SqlitePersistentSessionService(db_path=db_file)
    try:
        loaded = await svc2.get_session(
            app_name="fm_app",
            user_id="coord_1",
            session_id="sess-persist-01",
        )
        assert loaded is not None
        assert len(loaded.events) >= 2
        assert loaded.state["app:version"] == "v1"
        assert loaded.state["user:preferred_lang"] == "es"
        assert loaded.state["state_code"] == "MS"

        user_state = await svc2.get_user_state(app_name="fm_app", user_id="coord_1")
        assert user_state == {"preferred_lang": "es"}

        listed = await svc2.list_sessions(app_name="fm_app", user_id="coord_1")
        assert len(listed.sessions) == 1
        assert listed.sessions[0].id == "sess-persist-01"

        llm2 = _MultiTurnEchoLlm()
        coord2 = create_coordinator_agent(model_name=llm2, subagent_model=llm2)  # type: ignore[arg-type]
        runner2 = Runner(app_name="fm_app", agent=coord2, session_service=svc2)

        turn2_text = ""
        async for ev in runner2.run_async(
            user_id="coord_1",
            session_id="sess-persist-01",
            new_message=types.Content(
                role="user",
                parts=[types.Part.from_text(text="Turn two follow-up")],
            ),
        ):
            if ev.is_final_response() and ev.content and ev.content.parts:
                turn2_text = ev.content.parts[0].text or ""
        # History from turn 1 + turn 2 is present in llm_request.contents
        assert "Turn 3 reply" in turn2_text or "Turn 2 reply" in turn2_text

        reloaded = await svc2.get_session(
            app_name="fm_app",
            user_id="coord_1",
            session_id="sess-persist-01",
        )
        assert reloaded is not None
        assert len(reloaded.events) >= 4

        await svc2.delete_session(
            app_name="fm_app",
            user_id="coord_1",
            session_id="sess-persist-01",
        )
        assert (
            await svc2.get_session(
                app_name="fm_app",
                user_id="coord_1",
                session_id="sess-persist-01",
            )
            is None
        )
    finally:
        svc2.close()


def test_create_session_service_factory_modes(tmp_path: Path) -> None:
    db_path = tmp_path / "factory.db"
    with patch.dict(
        os.environ,
        {"A4I_SESSION_BACKEND": "", "A4I_SESSION_DB_PATH": str(db_path)},
    ):
        svc = create_session_service()
        assert isinstance(svc, SqlitePersistentSessionService)
        svc.close()

    with patch.dict(os.environ, {"A4I_SESSION_BACKEND": "memory"}):
        mem = create_session_service()
        assert isinstance(mem, InMemorySessionService)


# ---------------------------------------------------------------------------
# 5. P1 #3: Observability in /api/health & Structured Audit Log
# ---------------------------------------------------------------------------


def test_health_observability_updates_after_chat(caplog: pytest.LogCaptureFixture) -> None:
    client = TestClient(app)
    h_before = client.get("/api/health").json()
    assert "observability" in h_before
    obs_before = h_before["observability"]
    assert obs_before["session_backend"] in ("sqlite_persistent", "in_memory", "vertex_ai")
    chats_before = obs_before["chat_requests_total"]
    reqs_before = obs_before["requests_total"]

    caplog.set_level(logging.INFO, logger="first_milestones.server")
    r_chat = client.post(
        "/api/chat",
        json={"message": "Audit >45-day bounce hubs in MS", "state_code": "MS", "session_id": "obs-sess-1"},
    )
    assert r_chat.status_code == 200

    h_after = client.get("/api/health").json()
    obs_after = h_after["observability"]
    assert obs_after["chat_requests_total"] == chats_before + 1
    assert obs_after["requests_total"] >= reqs_before + 2
    assert obs_after["p50_ms"] >= 0.0
    assert obs_after["p95_ms"] >= obs_after["p50_ms"]
    assert obs_after["max_ms"] >= obs_after["p95_ms"]

    # Verify structured JSON audit log emitted
    audit_logs = [rec.message for rec in caplog.records if '"chat_audit"' in rec.message]
    assert len(audit_logs) >= 1
    parsed = json.loads(audit_logs[-1])
    assert parsed["session_id"] == "obs-sess-1"
    assert parsed["state_code"] == "MS"
    assert "model_used" in parsed
    assert "tools_invoked" in parsed
    assert "latency_ms" in parsed
    assert "fallback_used" in parsed


# ---------------------------------------------------------------------------
# 6. P1 #3: Optional Bearer Auth Hook (A4I_REQUIRE_AUTH)
# ---------------------------------------------------------------------------


def test_optional_bearer_auth_hook_protects_endpoints_when_enabled() -> None:
    client = TestClient(app)
    token = "test-secret-bearer-token-999"

    with patch.dict(
        os.environ,
        {"A4I_REQUIRE_AUTH": "1", "A4I_AUTH_BEARER_TOKEN": token},
    ):
        # /api/health always remains open (200)
        assert client.get("/api/health").status_code == 200

        # Protected endpoints reject missing or wrong Bearer token with 401
        assert client.get("/api/brief?state=MS").status_code == 401
        assert client.post("/api/simulate", json={"state_code": "MS"}).status_code == 401
        assert client.post("/api/chat", json={"message": "Check MS", "state_code": "MS"}).status_code == 401
        assert (
            client.post(
                "/api/chat/stream",
                json={"message": "Check MS", "state_code": "MS"},
                headers={"Authorization": "Bearer wrong-token"},
            ).status_code
            == 401
        )

        # Valid Bearer token succeeds (200)
        headers = {"Authorization": f"Bearer {token}"}
        assert client.get("/api/brief?state=MS", headers=headers).status_code == 200
        assert client.post("/api/simulate", json={"state_code": "MS"}, headers=headers).status_code == 200
        assert (
            client.post(
                "/api/chat",
                json={"message": "Check MS", "state_code": "MS"},
                headers=headers,
            ).status_code
            == 200
        )
        with client.stream(
            "POST",
            "/api/chat/stream",
            json={"message": "Check MS", "state_code": "MS"},
            headers=headers,
        ) as resp:
            assert resp.status_code == 200

    # Restored default (A4I_REQUIRE_AUTH unset / 0) allows normal unauthenticated demo access
    assert server_main._OBSERVABILITY is not None
    assert client.get("/api/brief?state=MS").status_code == 200
