#!/usr/bin/env python3
"""
Live GCP Integration & Conversational Test Suite against `qwiklabs-gcp-04-670e1c9d4f6d`.

Tests:
  1. Standard Track 1 routing (22-month-old Spanish/Medi-Cal toddler in Fresno tract 06019003103)
  2. Edge-case 34-month-old toddler approaching the 36-month IDEA Part C aging-out cliff (`CRITICAL` urgency)
  3. Track 2 multi-hop ISO GQL `-{2,4}->` regional bounce hub diagnosis (`SYN-PROV-CA-011`)
  4. Bonus counterfactual network fix simulation (`paper_fax` -> electronic intake)
  5. Post-output Equity Audit (`audit_*` + 6 statewide NSCH strata) & Outreach tract ranking
  6. Full end-to-end `/api/chat` multi-turn ADK + Gemini + BigQuery MCP conversation

Run in your terminal with:
  /Users/sahuja/.gemini/antigravity/scratch/A4I2026-challenge-early-intervention/.venv/bin/python \
    /Users/sahuja/.gemini/antigravity/scratch/A4I2026-challenge-early-intervention/sahuja/tests/test_live_e2e.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

SAHUJA_DIR = Path(__file__).resolve().parents[1]
for p in (str(SAHUJA_DIR), str(SAHUJA_DIR / "agent")):
    if p not in sys.path:
        sys.path.insert(0, p)

from app.server import app
from early_intervention_agent.tools import (
    audit_regional_bounce_hubs,
    pop_turn_payloads,
    rank_screening_outreach_tracts,
    route_toddler_referral_45d,
    run_post_output_equity_audit,
    simulate_bottleneck_fix,
)


class TestLiveBigQueryGraphAndAgent(unittest.TestCase):
    def setUp(self) -> None:
        pop_turn_payloads()

    def test_01_track1_compliant_45d_routing(self) -> None:
        res = route_toddler_referral_45d(
            home_tract_or_county="06019003103",
            child_age_months=22,
            concern_domain="Expressive Speech/Language",
            requires_medicaid=True,
            requires_bilingual=True,
            caregiver_language="Spanish",
        )
        rec = res["recommended_pathway"]
        self.assertIsNotNone(rec)
        self.assertLessEqual(rec["expected_total_days"], 45, "Pathway must clear 45-day IDEA Part C mandate")
        # Verify every downstream node satisfies Medi-Cal & bilingual requirements
        for node in rec["nodes"][1:]:
            self.assertTrue(node["accepts_medicaid"])
            self.assertTrue(node["bilingual"])
            self.assertTrue(node["part_c_enrolled"])
        self.assertGreater(res["contrasted_broken_bounce_chain"]["total_wait_days"], 45)
        self.assertIn("Medi-Cal", res["caregiver_action_note"]["english"])
        self.assertIn("español", res["caregiver_action_note"]["spanish"])

    def test_02_aging_out_34_month_cliff_guardrail(self) -> None:
        res = route_toddler_referral_45d(
            home_tract_or_county="Merced",
            child_age_months=34,
            concern_domain="Social-Communication / Autism Screen",
            requires_medicaid=True,
            requires_bilingual=True,
        )
        ctx = res["child_case_context"]
        self.assertEqual(ctx["aging_out_urgency"], "CRITICAL")
        self.assertEqual(ctx["months_until_36m_part_c_cliff"], 2)
        self.assertLessEqual(res["recommended_pathway"]["expected_total_days"], 45)

    def test_03_track2_regional_bounce_hub_gql(self) -> None:
        res = audit_regional_bounce_hubs()
        top_hub = res["coordinator_graph_bottleneck_ranking"][0]
        self.assertEqual(top_hub["coordinator_id"], "SYN-PROV-CA-011")
        self.assertEqual(top_hub["flat_spreadsheet_internal_wait_days"], 5)
        self.assertGreaterEqual(top_hub["breached_episodes_over_45d"], 7)

    def test_04_bonus_counterfactual_simulation(self) -> None:
        res = simulate_bottleneck_fix("SYN-PROV-CA-011")
        summary = res["summary"]
        self.assertGreater(summary["breached_episodes_rescued_under_45d"], 0)
        self.assertGreater(summary["total_child_wait_days_saved"], 100)

    def test_05_equity_audit_and_outreach_ranking(self) -> None:
        eq = run_post_output_equity_audit()
        self.assertEqual(len(eq["statewide_nsch_screening_strata"]), 6)
        self.assertEqual(len(eq["breach_vs_timely_tract_demographics"]), 2)

        out = rank_screening_outreach_tracts(limit=5)
        self.assertEqual(len(out["priority_outreach_tracts"]), 5)
        self.assertTrue(out["priority_outreach_tracts"][0]["census_tract_geoid"].startswith("06"))

    def test_06_full_conversational_workbench_turn(self) -> None:
        client = TestClient(app)
        resp = client.post(
            "/api/chat",
            json={
                "message": (
                    "We just got a referral for a 33-month-old Spanish-speaking Medi-Cal toddler in Madera "
                    "with Motor Milestone Delay. Find a <=45-day path and flag any aging-out risk."
                )
            },
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["reply"])
        self.assertTrue(any(tc["name"] == "route_toddler_referral_45d" for tc in body["tool_calls"]))
        self.assertTrue(any(b["kind"] == "route_comparison" for b in body["brief_updates"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
