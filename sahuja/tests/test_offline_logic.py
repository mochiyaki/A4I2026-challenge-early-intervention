#!/usr/bin/env python3
"""
Fast offline unit & data-rigor tests (runs in <2s with zero network calls).

Run with:
  /Users/sahuja/.gemini/antigravity/scratch/A4I2026-challenge-early-intervention/.venv/bin/python \
    /Users/sahuja/.gemini/antigravity/scratch/A4I2026-challenge-early-intervention/sahuja/tests/test_offline_logic.py
"""

from __future__ import annotations

import inspect
import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
import pandas as pd

SAHUJA_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SAHUJA_DIR.parent
DATA_DIR = REPO_ROOT / "data"

for p in (str(SAHUJA_DIR), str(SAHUJA_DIR / "agent")):
    if p not in sys.path:
        sys.path.insert(0, p)

from app.server import app
from early_intervention_agent import tools


class TestStarterDataRigorGuardrails(unittest.TestCase):
    """Verifies the 4 rubric 'Rigor & Judgment' checks on California (CA, FIPS 06) data."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.acs = pd.read_parquet(DATA_DIR / "acs_under5_tract_demographics.parquet").query("state_code == 'CA'")
        cls.nsch = pd.read_parquet(DATA_DIR / "nsch_developmental_screening_survey.parquet").query("state_code == 'CA'")
        cls.provs = pd.read_parquet(DATA_DIR / "pediatric_and_ei_provider_directory.parquet").query("state_code == 'CA'")
        cls.logs = pd.read_parquet(DATA_DIR / "deidentified_part_c_referral_logs.parquet").query("state_code == 'CA'")

    def test_leading_zero_fips_preserved(self) -> None:
        geoids = self.acs["census_tract_geoid"].astype(str).str.zfill(11)
        self.assertEqual(len(geoids), 101)
        self.assertTrue((geoids.str.len() == 11).all())
        self.assertTrue((geoids.str.startswith("06")).all())

    def test_acs_limited_english_rate_zero_trap_detected(self) -> None:
        # Planted Trap #1: limited_english_rate is 0.0 across all rows in this ACS extract
        self.assertTrue((self.acs["limited_english_rate"] == 0.0).all())

    def test_nsch_statewide_grain_trap(self) -> None:
        # Planted Trap #2: 6 statewide strata per state (joining on state_code alone duplicates tracts 6x)
        self.assertEqual(len(self.nsch), 6)
        self.assertTrue((self.nsch["geographic_level"] == "Statewide").all())
        naive_join_rows = len(self.acs.merge(self.nsch, on="state_code"))
        self.assertEqual(naive_join_rows, len(self.acs) * 6)

    def test_hundred_percent_synthetic_provider_provenance(self) -> None:
        self.assertEqual(len(self.provs), 30)
        self.assertTrue(self.provs["provider_id"].str.startswith("SYN-PROV-CA-").all())
        self.assertTrue(self.provs["synthetic_organization_name"].str.contains(r"\[Synthetic\]").all())

    def test_audit_columns_never_used_in_routing_tool(self) -> None:
        src = inspect.getsource(tools.route_toddler_referral_45d)
        for banned_col in (
            "audit_black_share",
            "audit_hispanic_share",
            "audit_asian_share",
            "audit_indigenous_share",
            "audit_white_share",
        ):
            self.assertNotIn(banned_col, src, f"{banned_col} must never appear in routing logic!")


class TestWorkbenchHttpEndpoints(unittest.TestCase):
    """Tests FastAPI Workbench static UI, health check, and coordinator scenario endpoints."""

    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_health_endpoint(self) -> None:
        resp = self.client.get("/api/health")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["state"], "CA")
        self.assertIn("a4i_early_intervention_sahuja", body["dataset"])
        self.assertEqual(body["mcp_server"], "https://bigquery.googleapis.com/mcp")

    def test_scenarios_endpoint(self) -> None:
        resp = self.client.get("/api/scenarios")
        self.assertEqual(resp.status_code, 200)
        scenarios = resp.json()["scenarios"]
        self.assertEqual(len(scenarios), 4)
        ids = [s["id"] for s in scenarios]
        self.assertIn("track1_triage", ids)
        self.assertIn("track2_audit", ids)

    def test_workbench_html_served(self) -> None:
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("45-Day Pathway", resp.text)
        self.assertIn("100% [Synthetic]", resp.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
