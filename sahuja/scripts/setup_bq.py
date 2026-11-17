#!/usr/bin/env python3
"""
Isolated Setup for sahuja/ subfolder:
- Uses isolated BigQuery dataset `a4i_early_intervention_sahuja` so teammates' `a4i_early_intervention` is never overwritten.
- Handles Qwiklabs org-level `TotalAdminProjectsPerOrganization (us)` quota gracefully:
  1) Tries `US` first (reusing any inherited/existing Enterprise reservation if present),
  2) Automatically falls back to `us-central1` (separate regional quota bucket, matching Cloud Run & Colab!) if `US` has hit the 10-project Qwiklabs org cap and lacks an inherited reservation.
- Loads all 5 California (CA, FIPS 06) GeoParquet starter tables with native GEOGRAPHY & 11-char GEOIDs,
  declares `ReferralGraph`, and verifies variable-length `-{2,4}->` ISO GQL traversal.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import google.auth
from google.auth.credentials import Credentials as BaseCredentials
from google.auth.transport.requests import AuthorizedSession
from google.cloud import bigquery
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "qwiklabs-gcp-04-670e1c9d4f6d")
STATE = os.environ.get("A4I_STATE", "CA")
DATASET = os.environ.get("A4I_DATASET", "a4i_early_intervention_sahuja")
RESERVATION = os.environ.get("A4I_GRAPH_RESERVATION", "a4i-graph-sahuja")

STATES = {
    "MS": ("Mississippi", "28"),
    "AL": ("Alabama", "01"),
    "GA": ("Georgia", "13"),
    "TX": ("Texas", "48"),
    "CA": ("California", "06"),
    "NY": ("New York", "36"),
}

SAHUJA_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SAHUJA_DIR.parent
DATA_DIR = REPO_ROOT / "data"
CONFIG_OUT = SAHUJA_DIR / "bq_config.json"


def _find_gcloud() -> str:
    found = shutil.which("gcloud")
    if found:
        return found
    fallback = "/Users/sahuja/data/genai-code/terraform/google-cloud-sdk/bin/gcloud"
    if os.path.isfile(fallback):
        return fallback
    raise RuntimeError("gcloud binary not found")


class GcloudCliCredentials(BaseCredentials):
    def __init__(self, gcloud_bin: str):
        super().__init__()
        self._gcloud_bin = gcloud_bin
        self.refresh(None)

    def refresh(self, request) -> None:
        self.token = subprocess.check_output(
            [self._gcloud_bin, "auth", "print-access-token"],
            text=True,
            timeout=20,
        ).strip()


def get_credentials():
    if os.environ.get("K_SERVICE") or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        return creds
    try:
        return GcloudCliCredentials(_find_gcloud())
    except Exception:
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        return creds


def safe_str(s: pd.Series, width: int | None = None) -> pd.Series:
    out = s.astype("string")
    if width:
        out = out.str.strip().str.zfill(width)
    return out.where(out.notna(), None)


def _to_geoparquet_buffer(df: pd.DataFrame, geom_col: str | None = None) -> io.BytesIO:
    table = pa.Table.from_pandas(df, preserve_index=False)
    if geom_col and geom_col in df.columns:
        geo_meta = {
            "version": "1.0.0",
            "primary_column": geom_col,
            "columns": {
                geom_col: {
                    "encoding": "WKB",
                    "geometry_types": [],
                    "crs": None,
                    "orientation": "counterclockwise",
                    "edges": "spherical",
                }
            },
        }
        meta = dict(table.schema.metadata or {})
        meta[b"geo"] = json.dumps(geo_meta).encode("utf-8")
        table = table.replace_schema_metadata(meta)
    buf = io.BytesIO()
    pq.write_table(table, buf)
    buf.seek(0)
    return buf


def load_table(bq: bigquery.Client, location: str, df: pd.DataFrame, table_name: str, geom_col: str | None = None, description: str = ""):
    ref = f"{PROJECT}.{DATASET}.{table_name}"
    buf = _to_geoparquet_buffer(df, geom_col=geom_col)
    cfg = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.PARQUET,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
    )
    bq.load_table_from_file(buf, ref, location=location, job_config=cfg).result()
    tbl = bq.get_table(ref)
    if description:
        tbl.description = description
        bq.update_table(tbl, ["description"])
    print(f"  loaded {table_name:<38} {tbl.num_rows:>6,} rows")
    return tbl


def try_provision_reservation(creds, location: str) -> tuple[bool, bool, str]:
    """Returns (ok, newly_created, detail) for Enterprise reservation in `location`."""
    bq = bigquery.Client(project=PROJECT, location=location, credentials=creds)
    region = f"region-{location.lower()}"
    res_path = f"`{PROJECT}.{region}.{RESERVATION}`"
    asg_path = f"`{PROJECT}.{region}.{RESERVATION}.{RESERVATION}-query`"

    newly_created = False
    for sql, label in [
        (
            f"CREATE RESERVATION {res_path} OPTIONS (edition = 'ENTERPRISE', slot_capacity = 0, autoscale_max_slots = 50)",
            f"reservation {RESERVATION} ({region})",
        ),
        (
            f"CREATE ASSIGNMENT {asg_path} OPTIONS (assignee = 'projects/{PROJECT}', job_type = 'QUERY')",
            f"QUERY assignment ({region})",
        ),
    ]:
        try:
            bq.query(sql, location=location).result()
            print(f"  created {label}")
            newly_created = True
        except Exception as exc:
            msg = str(exc)
            if "already" in msg.lower():
                print(f"  {label}: already in place")
            elif "TotalAdminProjectsPerOrganization" in msg or "Insufficient quota" in msg:
                return False, False, msg
            else:
                raise
    return True, newly_created, "ok"


def setup_in_location(creds, location: str) -> bool:
    state_name, state_fips = STATES[STATE]
    print(f"\n=== Attempting BigQuery Graph setup in location={location} (dataset={DATASET}) ===")
    ok_res, newly_created, detail = try_provision_reservation(creds, location)
    if not ok_res:
        print(f"  [Note] Could not create project reservation in {location} (org quota full); will test if inherited reservation exists, else try fallback region.")

    t_res = time.time()
    bq = bigquery.Client(project=PROJECT, location=location, credentials=creds)

    # Recreate dataset if existing location mismatches
    try:
        existing_ds = bq.get_dataset(f"{PROJECT}.{DATASET}")
        if existing_ds.location.lower() != location.lower():
            print(f"  Recreating {DATASET} in {location} (was {existing_ds.location})...")
            bq.delete_dataset(f"{PROJECT}.{DATASET}", delete_contents=True, not_found_ok=True)
            ds_ref = bigquery.Dataset(f"{PROJECT}.{DATASET}")
            ds_ref.location = location
            bq.create_dataset(ds_ref, exists_ok=True)
    except Exception:
        ds_ref = bigquery.Dataset(f"{PROJECT}.{DATASET}")
        ds_ref.location = location
        bq.create_dataset(ds_ref, exists_ok=True)

    print(f"[1/4] Loading 5 starter tables for {STATE} ({state_name}, FIPS {state_fips}) into {PROJECT}.{DATASET}...")
    demo = pd.read_parquet(DATA_DIR / "acs_under5_tract_demographics.parquet")
    demo = demo[demo["state_code"] == STATE].copy()
    demo["census_tract_geoid"] = safe_str(demo["census_tract_geoid"], width=11)
    demo["county_fips"] = safe_str(demo["county_fips"], width=5)
    load_table(bq, location, demo, "acs_under5_tract_demographics", geom_col="tract_geom")

    nsch = pd.read_parquet(DATA_DIR / "nsch_developmental_screening_survey.parquet")
    nsch = nsch[nsch["state_code"] == STATE].copy()
    load_table(bq, location, nsch, "nsch_developmental_screening_survey")

    agencies = pd.read_parquet(DATA_DIR / "idea_part_c_agency_performance.parquet")
    agencies = agencies[agencies["state_code"] == STATE].copy()
    load_table(bq, location, agencies, "idea_part_c_agency_performance", geom_col="intake_geom")

    provs = pd.read_parquet(DATA_DIR / "pediatric_and_ei_provider_directory.parquet")
    provs = provs[provs["state_code"] == STATE].copy()
    provs["census_tract_geoid"] = safe_str(provs["census_tract_geoid"], width=11)
    provs["county_fips"] = safe_str(provs["county_fips"], width=5)
    load_table(bq, location, provs, "pediatric_and_ei_provider_directory", geom_col="provider_geom")

    logs = pd.read_parquet(DATA_DIR / "deidentified_part_c_referral_logs.parquet")
    logs = logs[logs["state_code"] == STATE].copy()
    logs["child_home_tract_geoid"] = safe_str(logs["child_home_tract_geoid"], width=11)
    logs["referral_date"] = pd.to_datetime(logs["referral_date"]).dt.date
    load_table(bq, location, logs, "deidentified_part_c_referral_logs")

    print("[2/4] Verifying leading-zero FIPS & native GEOGRAPHY columns...")
    S = f"{PROJECT}.{DATASET}"
    stats = list(
        bq.query(
            f"""
            SELECT
              (SELECT COUNT(*) FROM `{S}.acs_under5_tract_demographics`) AS n_tracts,
              (SELECT COUNTIF(LENGTH(census_tract_geoid) != 11 OR SUBSTR(census_tract_geoid, 1, 2) != '{state_fips}') FROM `{S}.acs_under5_tract_demographics`) AS bad_geoids,
              (SELECT COUNT(*) FROM `{S}.INFORMATION_SCHEMA.COLUMNS` WHERE data_type = 'GEOGRAPHY') AS n_geog
            """,
            location=location,
        ).result()
    )[0]
    assert stats.bad_geoids == 0 and stats.n_geog == 3, f"Validation failed: {stats}"
    print(f"  Verified {stats.n_tracts} tracts (0 bad GEOIDs) and {stats.n_geog}/3 native GEOGRAPHY columns.")

    print(f"[3/4] Creating Property Graph {DATASET}.ReferralGraph...")
    ddl = f"""
    CREATE OR REPLACE PROPERTY GRAPH {DATASET}.ReferralGraph
      NODE TABLES (
        {DATASET}.pediatric_and_ei_provider_directory AS CareNode
          KEY (provider_id)
          LABEL CareNode
          PROPERTIES ALL COLUMNS EXCEPT (provider_geom)
      )
      EDGE TABLES (
        {DATASET}.deidentified_part_c_referral_logs AS ReferralHandoff
          KEY (referral_event_id)
          SOURCE KEY (source_provider_id) REFERENCES CareNode (provider_id)
          DESTINATION KEY (target_provider_id) REFERENCES CareNode (provider_id)
          LABEL ReferralHandoff
          PROPERTIES ALL COLUMNS
      );
    """
    bq.query(ddl, location=location).result()
    print(f"  Created {PROJECT}.{DATASET}.ReferralGraph!")

    if newly_created:
        elapsed = time.time() - t_res
        if elapsed < 45:
            wait_s = int(45 - elapsed)
            print(f"  Waiting {wait_s}s for new reservation assignment in {location} to propagate...")
            time.sleep(wait_s)

    print("[4/4] Smoke-testing variable-length -{2,4}-> ISO GQL traversal...")
    gql_test = f"""
    GRAPH {DATASET}.ReferralGraph
    MATCH (clinic:CareNode {{node_role: 'Screening_Pediatric_Clinic'}})
          -[hops:ReferralHandoff]->{{2,4}}
          (vendor:CareNode {{node_role: 'EI_Therapy_Vendor'}})
    WHERE ARRAY_LENGTH(hops) >= 3
      AND (SELECT COUNT(DISTINCT h.case_chain_id) FROM UNNEST(hops) AS h) = 1
    LET total_hops = ARRAY_LENGTH(hops),
        chain_id = hops[OFFSET(0)].case_chain_id,
        chain_wait_days = (SELECT SUM(h.handoff_wait_days) FROM UNNEST(hops) AS h),
        fax_hops = (SELECT COUNTIF(h.transmission_channel = 'paper_fax') FROM UNNEST(hops) AS h)
    FILTER chain_wait_days > 45
    RETURN
      chain_id,
      clinic.synthetic_organization_name AS origin_clinic,
      hops[OFFSET(0)].target_provider_id AS intake_coordinator_id,
      vendor.synthetic_organization_name AS final_vendor,
      total_hops,
      fax_hops,
      chain_wait_days
    ORDER BY chain_wait_days DESC
    LIMIT 5;
    """
    max_attempts = 5 if ok_res else 1
    for attempt in range(max_attempts):
        try:
            df_gql = bq.query(gql_test, location=location).to_dataframe()
            print(f"  SUCCESS in {location}! Top 5 breached multi-hop chains:")
            print(df_gql.to_string(index=False))
            CONFIG_OUT.write_text(
                json.dumps(
                    {
                        "project": PROJECT,
                        "dataset": DATASET,
                        "location": location,
                        "state": STATE,
                        "reservation": RESERVATION if ok_res else "inherited",
                    },
                    indent=2,
                )
            )
            return True
        except Exception as exc:
            msg = str(exc)
            if ("enterprise" in msg.lower() or "reservation" in msg.lower()) and attempt < max_attempts - 1:
                print(f"  Reservation propagating (attempt {attempt + 1}/{max_attempts}), sleeping 15s...")
                time.sleep(15)
            elif "enterprise" in msg.lower() or "reservation" in msg.lower():
                print(f"  GQL requires Enterprise reservation not active in {location}: {msg}")
                return False
            else:
                raise
    return False


def main() -> None:
    creds = get_credentials()
    for loc in ["us-central1", "US", "us-east4"]:
        if setup_in_location(creds, loc):
            print(f"\nSaved active BigQuery config to {CONFIG_OUT}")
            return
    raise RuntimeError("Could not execute GQL in us-central1, US, or us-east4.")


if __name__ == "__main__":
    main()
