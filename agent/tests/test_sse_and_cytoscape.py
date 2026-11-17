"""Comprehensive pytest + Playwright E2E tests for ADK SSE `/run` streaming & Cytoscape.js Graph UI."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient
from playwright.sync_api import sync_playwright

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import main as server_main  # noqa: E402
from main import app  # noqa: E402


def _parse_sse_body(raw_text: str) -> list[tuple[str, dict[str, Any]]]:
    """Parses raw `text/event-stream` text into `(event_name, json_data)` tuples."""
    frames: list[tuple[str, dict[str, Any]]] = []
    normalized = raw_text.replace("\r\n", "\n")
    for block in normalized.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        ev_type = "message"
        data_lines: list[str] = []
        for line in block.split("\n"):
            if line.startswith("event:"):
                ev_type = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:") :].strip())
        if data_lines:
            frames.append((ev_type, json.loads("\n".join(data_lines))))
    return frames


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_server(base_url: str, timeout_s: float = 25.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/api/health", timeout=2.0) as resp:
                if resp.status == 200:
                    return
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.2)
    raise RuntimeError(f"Server at {base_url} failed to start within {timeout_s}s")


# ---------------------------------------------------------------------------
# 1. Backend SSE `/run`, `/run_sse`, `/api/chat/stream` & Auth Bridge Tests
# ---------------------------------------------------------------------------


def test_sse_run_endpoints_all_three_tracks() -> None:
    client = TestClient(app)

    track_cases = [
        (
            "/run",
            {
                "message": "Route a 32-month-old toddler in tract 28049003500 needing Spanish Autism screen on Medicaid",
                "session_id": "sse-t1",
                "state_code": "MS",
            },
            "triage_pathway_router",
            "find_viable_45d_paths",
        ),
        (
            "/run_sse",
            {
                "message": "Audit >45-day multi-hop bounce hubs in MS and simulate upgrading SYN-PROV-MS-011 from fax",
                "session_id": "sse-t2",
                "state_code": "MS",
            },
            "network_bottleneck_auditor",
            "detect_regional_bottleneck_hubs",
        ),
        (
            "/api/chat/stream",
            {
                "message": "Find hidden EI deserts and mobile developmental screening priority tracts in MS",
                "session_id": "sse-t3",
                "state_code": "MS",
            },
            "equity_and_caregiver_specialist",
            "rank_outreach_zones",
        ),
    ]

    for endpoint, body, expected_sub_agent, expected_tool in track_cases:
        with client.stream("POST", endpoint, json=body) as resp:
            assert resp.status_code == 200
            assert "text/event-stream" in resp.headers.get("content-type", "")
            assert resp.headers.get("cache-control") == "no-cache"
            assert resp.headers.get("x-accel-buffering") == "no"
            raw_sse = "".join(resp.iter_text())

        frames = _parse_sse_body(raw_sse)
        event_names = [name for name, _ in frames]
        for required_event in (
            "agent_start",
            "sub_agent",
            "tool_call",
            "tool_result",
            "token",
            "brief",
            "done",
        ):
            assert required_event in event_names, f"{endpoint} missing {required_event}: {event_names}"

        start_data = next(d for n, d in frames if n == "agent_start")
        assert start_data["agent"] == "first_milestones_coordinator"
        assert start_data["state_code"] == "MS"
        assert start_data["session_id"] == body["session_id"]

        sub_data = next(d for n, d in frames if n == "sub_agent")
        assert sub_data["agent"] == expected_sub_agent
        assert sub_data["model"] == "gemini-2.5-flash"

        tool_calls = [d["tool"] for n, d in frames if n == "tool_call"]
        tool_results = [d["tool"] for n, d in frames if n == "tool_result" and d.get("ok") is True]
        assert expected_tool in tool_calls
        assert expected_tool in tool_results

        streamed_reply = "".join(d["delta"] for n, d in frames if n == "token")
        done_data = next(d for n, d in frames if n == "done")
        assert len(streamed_reply) > 80
        assert streamed_reply == done_data["reply"]
        assert expected_sub_agent in done_data["sub_agents_invoked"]
        assert expected_tool in done_data["tools_invoked"]

        brief_data = next(d["brief"] for n, d in frames if n == "brief")
        assert brief_data["state_code"] == "MS"
        assert brief_data["network_audit"]["network_totals"]["statutory_breaches_over_45d"] == 26


def test_sse_run_accepts_standard_adk_new_message_format_and_ca_fips() -> None:
    client = TestClient(app)
    adk_payload = {
        "app_name": "first_milestones",
        "user_id": "adk_web_evaluator",
        "session_id": "adk-ca-001",
        "state_code": "CA",
        "new_message": {
            "role": "user",
            "parts": [
                {
                    "text": "Route a 30-month-old toddler in California needing Spanish speech evaluation on Medicaid."
                }
            ],
        },
    }

    with client.stream("POST", "/run", json=adk_payload) as resp:
        assert resp.status_code == 200
        frames = _parse_sse_body("".join(resp.iter_text()))

    start_data = next(d for n, d in frames if n == "agent_start")
    assert start_data["state_code"] == "CA"
    assert start_data["session_id"] == "adk-ca-001"

    brief_data = next(d["brief"] for n, d in frames if n == "brief")
    assert brief_data["state_code"] == "CA"
    ca_tract = brief_data["routing"]["child_profile"]["home_tract_geoid"]
    assert len(ca_tract) == 11 and ca_tract.startswith("06")


def test_sse_live_adk_subagent_delegation_and_gcloud_auth_bridge() -> None:
    client = TestClient(app)

    class _FakeLiveStreamingRunner:
        async def run_async(self, **_: object):
            # 1. Sub-agent tool call event
            ev_fc = MagicMock()
            ev_fc.author = "network_bottleneck_auditor"
            fc_obj = MagicMock()
            fc_obj.name = "detect_regional_bottleneck_hubs"
            ev_fc.get_function_calls.return_value = [fc_obj]
            ev_fc.get_function_responses.return_value = []
            ev_fc.partial = False
            ev_fc.is_final_response.return_value = False
            ev_fc.content = None
            yield ev_fc

            # 2. Sub-agent tool result event
            ev_fr = MagicMock()
            ev_fr.author = "network_bottleneck_auditor"
            fr_obj = MagicMock()
            fr_obj.name = "detect_regional_bottleneck_hubs"
            fr_obj.response = None
            ev_fr.get_function_calls.return_value = []
            ev_fr.get_function_responses.return_value = [fr_obj]
            ev_fr.partial = False
            ev_fr.is_final_response.return_value = False
            ev_fr.content = None
            yield ev_fr

            # 3. Partial SSE token chunks
            for chunk in ("### Live ADK Audit\n\n", "- Delegated to `network_bottleneck_auditor`."):
                ev_tok = MagicMock()
                ev_tok.author = "network_bottleneck_auditor"
                ev_tok.get_function_calls.return_value = []
                ev_tok.get_function_responses.return_value = []
                ev_tok.partial = True
                ev_tok.is_final_response.return_value = False
                ev_tok.content = MagicMock(parts=[MagicMock(text=chunk)])
                yield ev_tok

    with patch.dict(
        os.environ,
        {
            "A4I_USE_GCLOUD_AUTH": "1",
            "GOOGLE_GENAI_USE_VERTEXAI": "TRUE",
            "GOOGLE_CLOUD_PROJECT": "demo-a4i-project",
        },
    ):
        with patch.object(server_main, "_fetch_gcloud_access_token", return_value="ya29.mock-gcloud-token"):
            assert server_main._has_llm_credentials() is True
            with patch.object(server_main, "_get_runner", return_value=_FakeLiveStreamingRunner()):
                with client.stream(
                    "POST",
                    "/run",
                    json={"message": "Audit MS bottleneck hubs", "state_code": "MS"},
                ) as resp:
                    assert resp.status_code == 200
                    frames = _parse_sse_body("".join(resp.iter_text()))

    sub_events = [d for n, d in frames if n == "sub_agent"]
    assert any(d["agent"] == "network_bottleneck_auditor" for d in sub_events)
    tokens = "".join(d["delta"] for n, d in frames if n == "token")
    assert "Live ADK Audit" in tokens
    done_ev = next(d for n, d in frames if n == "done")
    assert "adk_gemini_live" in done_ev["mode"]
    assert "network_bottleneck_auditor" in done_ev["sub_agents_invoked"]
    assert "detect_regional_bottleneck_hubs" in done_ev["tools_invoked"]


def test_health_exposes_sub_agent_topology_and_vendored_cytoscape_bundle() -> None:
    vendor_js = AGENT_DIR / "static" / "vendor" / "cytoscape.min.js"
    assert vendor_js.exists()
    assert vendor_js.stat().st_size > 250_000

    client = TestClient(app)
    r_health = client.get("/api/health")
    assert r_health.status_code == 200
    health_json = r_health.json()
    assert "sub_agents" in health_json
    assert isinstance(health_json["sub_agents"], list)
    assert "/run" in health_json["sse_endpoints"]


def test_feat_triage_gatekeeper_slot_ledger_geo_and_thinking_budgets(tmp_path: Path) -> None:
    """Verifies Option B thinking budgets, Packet Gatekeeper, SQLite Slot Ledger, and TIGER GeoJSON coexist with SSE."""
    from first_milestones.agent import root_agent

    # 1. Option B Thinking Budgets: Pro coordinator = 128, Flash sub-agents = 0
    assert root_agent.model == "gemini-2.5-pro"
    assert root_agent.generate_content_config.thinking_config.thinking_budget == 128
    assert len(root_agent.sub_agents) == 3
    for sub in root_agent.sub_agents:
        assert sub.model == "gemini-2.5-flash"
        assert sub.generate_content_config.thinking_config.thinking_budget == 0

    ledger_db = tmp_path / "test_slot_ledger.db"
    with patch.dict(os.environ, {"A4I_SLOT_LEDGER_DB": str(ledger_db)}):
        client = TestClient(app)

        # 2. Packet Gatekeeper ready vs blocked + anti-bias firewall
        r_ready = client.post(
            "/api/gatekeeper",
            json={
                "child_age_months": 30.0,
                "referral_concern": "autism_evaluation",
                "developmental_screen_completed": True,
                "parental_consent_signed": True,
                "audiology_clearance_completed": True,
                "vision_screening_completed": True,
                "pediatric_medical_summary_attached": True,
                "insurance_status": "medicaid",
                "preferred_language": "Spanish",
            },
        )
        assert r_ready.status_code == 200
        ready_json = r_ready.json()
        assert ready_json["ready"] is True
        assert ready_json["packet_status"] == "READY_FOR_EHR_HANDOFF"
        assert ready_json["missing_items"] == []

        r_blocked = client.post(
            "/api/gatekeeper",
            json={
                "child_age_months": 30.0,
                "referral_concern": "speech_delay",
                "developmental_screen_completed": False,
                "parental_consent_signed": False,
                "audiology_clearance_completed": False,
                "insurance_status": "medicaid",
                "preferred_language": "Spanish",
            },
        )
        assert r_blocked.status_code == 200
        blocked_json = r_blocked.json()
        assert blocked_json["ready"] is False
        assert blocked_json["packet_status"] == "BLOCKED_MISSING_PREREQUISITES"
        assert len(blocked_json["missing_items"]) >= 2

        r_firewall = client.post(
            "/api/gatekeeper",
            json={"child_age_months": 30.0, "audit_race_ethnicity": "Black"},
        )
        assert r_firewall.status_code == 422

        # 3. SQLite 48h Slot Hold Ledger reserve + brief cache refresh + release
        r_slots_init = client.get("/api/slots?state=MS")
        assert r_slots_init.status_code == 200
        assert r_slots_init.json()["active_holds_count"] == 0

        r_brief_before = client.get("/api/brief?state=MS")
        assert r_brief_before.status_code == 200
        routing_data = r_brief_before.json().get("routing", {})
        rec_path = routing_data.get("recommended_pathway") or {}
        rec_hub = (
            rec_path.get("hops", [{}, {}])[1].get("target_provider_id")
            if len(rec_path.get("hops", [])) >= 2
            else "SYN-PROV-MS-017"
        )

        r_res = client.post(
            "/api/slots/reserve",
            json={
                "provider_id": rec_hub,
                "state_code": "MS",
                "home_tract_geoid": "28049003500",
                "referral_concern": "autism_evaluation",
                "child_age_months": 30.0,
                "preferred_language": "Spanish",
                "insurance_status": "medicaid",
            },
        )
        assert r_res.status_code == 200
        res_json = r_res.json()
        assert res_json["status"] == "reserved"
        hold_id = res_json["hold"]["hold_id"]
        assert hold_id.startswith("HOLD-MS-")
        assert res_json["capacity_snapshot"]["monthly_slot_capacity"] >= res_json["capacity_snapshot"]["eval_hub_open_slots"]

        r_slots_after = client.get("/api/slots?state=MS")
        assert r_slots_after.json()["active_holds_count"] == 1

        r_rel = client.post("/api/slots/release", json={"hold_id": hold_id})
        assert r_rel.status_code == 200
        assert r_rel.json()["status"] == "released"
        assert client.get("/api/slots?state=MS").json()["active_holds_count"] == 0

        # 4. TIGER GeoJSON endpoint for MS and CA
        for st, prefix in (("MS", "28"), ("CA", "06")):
            r_geo = client.get(f"/api/geo?state={st}")
            assert r_geo.status_code == 200
            geo_json = r_geo.json()
            assert geo_json["type"] == "FeatureCollection"
            assert len(geo_json["features"]) >= 10
            assert all(str(f["properties"]["tract_geoid"]).startswith(prefix) for f in geo_json["features"])


# ---------------------------------------------------------------------------
# 2. Headless Chromium Playwright Tests: Cytoscape.js Graph & Live SSE UI
# ---------------------------------------------------------------------------


def test_playwright_cytoscape_graph_filters_inspector_sse_and_state_switch(tmp_path: Path) -> None:
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    env.pop("GOOGLE_API_KEY", None)
    env.pop("GEMINI_API_KEY", None)
    env.pop("GOOGLE_GENAI_USE_VERTEXAI", None)
    env["A4I_STATE"] = "MS"
    env["A4I_SLOT_LEDGER_DB"] = str(tmp_path / "pw_slot_ledger.db")

    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=str(AGENT_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        _wait_for_server(base_url)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            page = context.new_page()
            page_errors: list[str] = []
            page.on("pageerror", lambda e: page_errors.append(str(e)))

            with page.expect_response(lambda r: "/api/brief" in r.url and r.status == 200, timeout=15000):
                page.goto(base_url, wait_until="domcontentloaded", timeout=15000)

            page.wait_for_selector("#cyTopologyCard #cyGraphCanvas", timeout=10000)
            page.wait_for_selector("#bouncePathCanvas .hop-card", timeout=10000)
            page.wait_for_selector("#recPathCanvas .hop-card", timeout=10000)

            # 1. Verify Cytoscape.js loaded locally and mounted window.__cyInstance
            cy_stats = page.evaluate(
                """() => {
                    const cy = window.__cyInstance;
                    if (!cy || typeof window.cytoscape !== 'function') return null;
                    const bb = cy.elements().boundingBox();
                    return {
                        nodeCount: cy.nodes().length,
                        edgeCount: cy.edges().length,
                        nodeIds: cy.nodes().map((n) => n.id()),
                        bbWidth: bb.w,
                        bbHeight: bb.h,
                    };
                }"""
            )
            assert cy_stats is not None, "window.__cyInstance failed to mount"
            assert cy_stats["nodeCount"] >= 5
            assert cy_stats["edgeCount"] >= 4
            assert cy_stats["bbWidth"] > 50 and cy_stats["bbHeight"] > 20
            assert any(nid.startswith("SYN-PROV-MS-") for nid in cy_stats["nodeIds"])

            # 2. Test Cytoscape filter buttons: <=45d Electronic, >45d Fax Bounce, All Paths, Fit View
            page.locator('[data-cy-filter="compliant"]').click()
            compliant_vis = page.evaluate(
                """() => ({
                    activeFilter: window.__cyInstance.scratch('_activeFilter'),
                    visibleNodes: window.__cyInstance.nodes(':visible').length,
                    visibleBounceEdges: window.__cyInstance.edges('[lane = "bounce"]:visible').length,
                    visibleCompliantEdges: window.__cyInstance.edges('[lane = "compliant"]:visible').length,
                })"""
            )
            assert compliant_vis["activeFilter"] == "compliant"
            assert compliant_vis["visibleNodes"] >= 3
            assert compliant_vis["visibleBounceEdges"] == 0
            assert compliant_vis["visibleCompliantEdges"] >= 2

            page.locator('[data-cy-filter="bounce"]').click()
            bounce_vis = page.evaluate(
                """() => ({
                    activeFilter: window.__cyInstance.scratch('_activeFilter'),
                    visibleNodes: window.__cyInstance.nodes(':visible').length,
                    visibleBounceEdges: window.__cyInstance.edges('[lane = "bounce"]:visible').length,
                    visibleCompliantEdges: window.__cyInstance.edges('[lane = "compliant"]:visible').length,
                })"""
            )
            assert bounce_vis["activeFilter"] == "bounce"
            assert bounce_vis["visibleNodes"] >= 3
            assert bounce_vis["visibleBounceEdges"] >= 3
            assert bounce_vis["visibleCompliantEdges"] == 0

            page.locator('[data-cy-filter="all"]').click()
            all_vis = page.evaluate(
                """() => ({
                    activeFilter: window.__cyInstance.scratch('_activeFilter'),
                    visibleNodes: window.__cyInstance.nodes(':visible').length,
                    visibleEdges: window.__cyInstance.edges(':visible').length,
                })"""
            )
            assert all_vis["activeFilter"] == "all"
            assert all_vis["visibleNodes"] == cy_stats["nodeCount"]
            assert all_vis["visibleEdges"] == cy_stats["edgeCount"]

            page.locator("#cyFitBtn").click()

            # 3. Test clicking a Cytoscape node & edge updates #cyNodeInspector
            tapped_node_id = page.evaluate(
                """() => {
                    const cy = window.__cyInstance;
                    const target = cy.getElementById('SYN-PROV-MS-011').length
                        ? cy.getElementById('SYN-PROV-MS-011')
                        : cy.nodes().first();
                    target.emit('tap');
                    return target.id();
                }"""
            )
            inspector_txt = page.locator("#cyNodeInspector").inner_text()
            assert tapped_node_id in inspector_txt
            assert "Channel:" in inspector_txt
            assert "Medicaid" in inspector_txt

            tapped_edge_info = page.evaluate(
                """() => {
                    const edge = window.__cyInstance.edges('[lane = "bounce"]').first();
                    edge.emit('tap');
                    return { source: edge.data('source'), target: edge.data('target'), channel: edge.data('channel') };
                }"""
            )
            edge_inspector_txt = page.locator("#cyNodeInspector").inner_text()
            assert tapped_edge_info["source"] in edge_inspector_txt
            assert tapped_edge_info["target"] in edge_inspector_txt
            assert tapped_edge_info["channel"] in edge_inspector_txt

            # 4. Verify feat/first-milestones-triage UI cards coexist seamlessly:
            #    Gatekeeper (no [object Object]), SQLite 48h Slot Hold, TIGER SVG maps, and Before-vs-After Equity
            page.wait_for_selector("#tigerCorridorMap svg .tiger-tract", timeout=10000)
            assert page.locator("#tigerCorridorMap svg .tiger-tract").count() >= 10

            page.locator("#gkScreenToggle").uncheck()
            with page.expect_response(lambda r: "/api/gatekeeper" in r.url and r.status == 200, timeout=10000):
                page.locator("#verifyPacketBtn").click()
            gk_txt = page.locator("#gatekeeperResult").inner_text()
            assert "BLOCKED_MISSING_PREREQUISITES" in gk_txt
            assert "[object Object]" not in gk_txt
            assert "M-CHAT-R/F" in gk_txt or "ASQ-3" in gk_txt
            page.locator("#gkScreenToggle").check()
            with page.expect_response(lambda r: "/api/gatekeeper" in r.url and r.status == 200, timeout=10000):
                page.locator("#verifyPacketBtn").click()
            assert "READY_FOR_EHR_HANDOFF" in page.locator("#gatekeeperResult").inner_text()

            with page.expect_response(lambda r: "/api/slots/reserve" in r.url and r.status == 200, timeout=10000):
                page.locator("#reserveSlotBtn").click()
            hold_txt = page.locator("#slotHoldStatus").inner_text()
            assert "HOLD-MS-" in hold_txt
            assert "48-Hour Slot Hold Confirmed" in hold_txt or "48h Slot Hold" in hold_txt

            page.locator('[data-tab="outreach"]').click()
            page.wait_for_selector("#tigerDesertMap svg .tiger-tract", timeout=10000)
            assert page.locator("#beforeAfterSubgroupTable tbody tr").count() >= 3
            page.locator('[data-tab="pathway"]').click()

            # 5. Test live SSE `/run` streaming chat in the browser
            before_agent_bubbles = page.locator("#chatMessages .msg-agent").count()
            page.locator("#chatInput").fill(
                "Route a 32-month-old toddler in tract 28049003500 needing Spanish Autism screen on Medicaid"
            )
            with page.expect_response(
                lambda r: "/run" in r.url and r.status == 200 and "text/event-stream" in (r.headers.get("content-type") or ""),
                timeout=15000,
            ):
                page.locator("#sendBtn").click()

            page.wait_for_function(
                """(prevCount) => {
                    const bubbles = document.querySelectorAll('#chatMessages .msg-agent');
                    if (bubbles.length <= prevCount) return false;
                    const last = bubbles[bubbles.length - 1];
                    return last.innerText.includes('28049003500') && !document.getElementById('sendBtn').disabled;
                }""",
                arg=before_agent_bubbles,
                timeout=10000,
            )

            last_bubble_txt = page.locator("#chatMessages .msg-agent").last.inner_text()
            assert "TriageSub" in last_bubble_txt
            assert "gemini-2.5-flash" in last_bubble_txt
            assert "find_viable_45d_paths" in last_bubble_txt
            assert "28049003500" in last_bubble_txt

            # 6. Test switching MS -> CA re-renders Cytoscape & TIGER map with SYN-PROV-CA-* / 06*
            with page.expect_response(
                lambda r: "/api/brief" in r.url and "state=CA" in r.url and r.status == 200,
                timeout=15000,
            ):
                page.locator("#stateSelect").select_option("CA")

            page.wait_for_function(
                """() => {
                    const cy = window.__cyInstance;
                    return cy && cy.nodes().some((n) => n.id().startsWith('SYN-PROV-CA-'));
                }""",
                timeout=10000,
            )
            ca_cy_nodes = page.evaluate("() => window.__cyInstance.nodes().map((n) => n.id())")
            assert len(ca_cy_nodes) >= 5
            assert all(nid.startswith("SYN-PROV-CA-") for nid in ca_cy_nodes)
            assert page.locator("#tigerCorridorMap svg .tiger-tract").count() >= 10
            assert page_errors == []

            context.close()
            browser.close()
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3.0)
