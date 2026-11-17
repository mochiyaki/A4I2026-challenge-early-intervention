"""BigQuery Property Graph (ISO GQL) & Spatial Client with GeoParquet Local Mirror.

In Google Cloud (Cloud Run, Agent Engine, Cloud Shell, Colab Enterprise) and on local
workstations authenticated via ADC or `gcloud auth login`, executes live ISO/IEC 39075
GQL queries (`GRAPH_TABLE` over `ReferralGraph`) and native `ST_DISTANCE` spatial
queries against `<PROJECT>.<DATASET>`.

When running locally without GCP project configuration (or with `A4I_FORCE_LOCAL_PARQUET=1`),
transparently executes the exact equivalent graph & Haversine spatial logic over
the repository's `data/*.parquet` starter files so developers and judges can also
preview and run deterministic unit tests locally in milliseconds.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import functools
import logging
import math
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from typing import Any

import google.auth
import google.auth.credentials
from google.auth.exceptions import DefaultCredentialsError, RefreshError
import pandas as pd

logger = logging.getLogger(__name__)

_ORIG_GOOGLE_AUTH_DEFAULT = google.auth.default
_ADC_BRIDGE_INSTALLED = False

_DATASET_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PROJECT_RE = re.compile(r"^[a-zA-Z0-9._:-]+$")
_REQUEST_STATE_CTX: ContextVar[str | None] = ContextVar("a4i_request_state", default=None)
_REQUEST_TELEMETRY_CTX: ContextVar[list[dict[str, Any]] | None] = ContextVar(
    "a4i_request_bq_telemetry", default=None
)
_TELEMETRY_LOCK = threading.Lock()
_RECENT_TELEMETRY: deque[dict[str, Any]] = deque(maxlen=64)

VALID_STATES = ("MS", "AL", "GA", "TX", "CA", "NY")
STATE_LABELS = {
    "MS": "Mississippi",
    "AL": "Alabama",
    "GA": "Georgia",
    "TX": "Texas",
    "CA": "California",
    "NY": "New York",
}


class GcloudCliCredentials(google.auth.credentials.Credentials):
    """Sanctioned local OAuth2 credentials bridge backed by `gcloud auth print-access-token`.

    Used only when standard Application Default Credentials (`google.auth.default()`)
    are absent on a developer workstation where `gcloud auth login` is active.
    """

    def __init__(self, quota_project_id: str | None = None) -> None:
        super().__init__()
        self._quota_project_id = quota_project_id

    def with_quota_project(self, quota_project_id: str | None) -> GcloudCliCredentials:
        clone = GcloudCliCredentials(quota_project_id=quota_project_id)
        clone.token = self.token
        clone.expiry = self.expiry
        return clone

    def refresh(self, request: Any = None) -> None:  # noqa: ARG002
        try:
            proc = subprocess.run(
                ["gcloud", "auth", "print-access-token"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except Exception as exc:  # noqa: BLE001
            raise RefreshError(f"Failed to invoke gcloud auth print-access-token: {exc}") from exc

        token = (proc.stdout or "").strip()
        if proc.returncode != 0 or not token:
            stderr = (proc.stderr or "").strip()
            raise RefreshError(
                f"gcloud auth print-access-token exited with {proc.returncode}: {stderr}"
            )
        self.token = token
        # google.auth.credentials.Credentials compares `self.expiry` against naive UTC now
        self.expiry = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=45)


@functools.lru_cache(maxsize=1)
def _detect_gcloud_project() -> str:
    """Reads the active project from `gcloud config get-value project` once per process."""
    try:
        proc = subprocess.run(
            ["gcloud", "config", "get-value", "project"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        candidate = (proc.stdout or "").strip()
        if proc.returncode == 0 and candidate and candidate != "(unset)" and _PROJECT_RE.fullmatch(candidate):
            return candidate
    except Exception:  # noqa: BLE001
        pass
    return ""


def resolve_gcp_credentials_and_project(
    scopes: Sequence[str] | None = None,
) -> tuple[Any, str]:
    """Resolves GCP credentials + project via standard ADC, falling back to `gcloud` CLI."""
    target_scopes = list(scopes) if scopes else ["https://www.googleapis.com/auth/cloud-platform"]
    env_project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    if env_project and not _PROJECT_RE.fullmatch(env_project):
        env_project = ""

    try:
        creds, adc_project = _ORIG_GOOGLE_AUTH_DEFAULT(scopes=target_scopes)
        resolved_project = env_project or (adc_project or "").strip() or _detect_gcloud_project()
        return creds, resolved_project
    except DefaultCredentialsError:
        if os.environ.get("A4I_FORCE_LOCAL_PARQUET") == "1":
            raise
        creds = GcloudCliCredentials()
        creds.refresh()
        resolved_project = env_project or _detect_gcloud_project()
        return creds, resolved_project


def install_gcloud_adc_bridge_if_needed() -> bool:
    """Idempotently bridges `google.auth.default` to `GcloudCliCredentials` when ADC file is absent."""
    global _ADC_BRIDGE_INSTALLED  # noqa: PLW0603
    if os.environ.get("A4I_FORCE_LOCAL_PARQUET") == "1":
        return False
    if _ADC_BRIDGE_INSTALLED:
        return True
    try:
        _ORIG_GOOGLE_AUTH_DEFAULT(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        return True
    except DefaultCredentialsError:
        pass

    try:
        _, detected_proj = resolve_gcp_credentials_and_project()
    except Exception as exc:  # noqa: BLE001
        logger.debug("gcloud CLI auth bridge unavailable (%s)", exc)
        return False

    def _patched_default(scopes: Any = None, request: Any = None, quota_project_id: Any = None, **kwargs: Any) -> tuple[Any, str | None]:  # noqa: ARG001
        try:
            return _ORIG_GOOGLE_AUTH_DEFAULT(
                scopes=scopes,
                request=request,
                quota_project_id=quota_project_id,
                **kwargs,
            )
        except DefaultCredentialsError:
            if os.environ.get("A4I_FORCE_LOCAL_PARQUET") == "1":
                raise
            c = GcloudCliCredentials(quota_project_id=quota_project_id)
            c.refresh(request)
            proj = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip() or detected_proj or None
            return c, proj

    google.auth.default = _patched_default  # type: ignore[assignment]
    _ADC_BRIDGE_INSTALLED = True
    return True


@contextmanager
def request_state_context(state_code: str | None) -> Iterator[str]:
    """Binds a concurrency-safe request-scoped state code and telemetry buffer via ContextVar."""
    normalized: str | None = None
    if state_code:
        cleaned = state_code.strip().upper()
        if cleaned in VALID_STATES:
            normalized = cleaned
    state_token = _REQUEST_STATE_CTX.set(normalized)
    telemetry_token = None
    if _REQUEST_TELEMETRY_CTX.get() is None:
        telemetry_token = _REQUEST_TELEMETRY_CTX.set([])
    try:
        yield get_config()["state"]
    finally:
        if telemetry_token is not None:
            _REQUEST_TELEMETRY_CTX.reset(telemetry_token)
        _REQUEST_STATE_CTX.reset(state_token)


def _infer_query_label(sql: str) -> str:
    """Derives a compact human-readable label for a SQL or ISO GQL statement."""
    upper = sql.upper()
    if "GRAPH_TABLE" in upper:
        if "CAN_REFER_TO" in upper:
            return "gql_can_refer_to"
        if "SERVES_AREA" in upper:
            return "gql_serves_area"
        if "REFERS_TO" in upper:
            return "gql_refers_to"
        if "REFERRALHANDOFF" in upper:
            return "gql_referral_handoff"
        return "gql_graph_table"
    if "PEDIATRIC_AND_EI_PROVIDER_DIRECTORY" in upper:
        return "sql_provider_directory"
    if "ACS_UNDER5_TRACT_DEMOGRAPHICS" in upper:
        return "sql_acs_demographics"
    if "NSCH_DEVELOPMENTAL_SCREENING_SURVEY" in upper:
        return "sql_nsch_survey"
    if "IDEA_PART_C_AGENCY_PERFORMANCE" in upper:
        return "sql_agency_performance"
    if "DEIDENTIFIED_PART_C_REFERRAL_LOGS" in upper:
        return "sql_referral_logs"
    return "bigquery_query"


def record_bq_telemetry(
    label: str,
    *,
    job_id: str | None = None,
    elapsed_ms: float = 0.0,
    total_bytes_processed: int | None = None,
    row_count: int = 0,
    dataset: str = "",
    state_code: str = "",
    engine: str = "bigquery",
) -> dict[str, Any]:
    """Records a query telemetry entry in both the request ContextVar list and global ring buffer."""
    entry: dict[str, Any] = {
        "label": str(label or "bigquery_query"),
        "job_id": job_id,
        "elapsed_ms": round(float(elapsed_ms), 2),
        "total_bytes_processed": total_bytes_processed,
        "row_count": int(row_count),
        "dataset": str(dataset),
        "state_code": str(state_code),
        "engine": str(engine),
    }
    ctx_list = _REQUEST_TELEMETRY_CTX.get()
    if ctx_list is not None:
        if len(ctx_list) >= 64:
            del ctx_list[0]
        ctx_list.append(entry)
    with _TELEMETRY_LOCK:
        _RECENT_TELEMETRY.append(entry)
    return entry


def get_bq_telemetry() -> list[dict[str, Any]]:
    """Returns query telemetry for the active request ContextVar, or recent global records."""
    ctx_list = _REQUEST_TELEMETRY_CTX.get()
    if ctx_list is not None:
        return [dict(item) for item in ctx_list]
    with _TELEMETRY_LOCK:
        return [dict(item) for item in _RECENT_TELEMETRY]


def reset_bq_telemetry() -> None:
    """Clears the active request ContextVar telemetry list and the global recent buffer."""
    ctx_list = _REQUEST_TELEMETRY_CTX.get()
    if ctx_list is not None:
        ctx_list.clear()
    with _TELEMETRY_LOCK:
        _RECENT_TELEMETRY.clear()


def get_config() -> dict[str, str]:
    """Returns normalized runtime configuration."""
    raw_state = _REQUEST_STATE_CTX.get() or os.environ.get("A4I_STATE", "MS")
    state = raw_state.strip().upper()
    if state not in VALID_STATES:
        state = "MS"
    dataset = os.environ.get("A4I_DATASET", "a4i_early_intervention").strip()
    if not _DATASET_RE.fullmatch(dataset):
        dataset = "a4i_early_intervention"
    raw_project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    if (
        not raw_project
        and os.environ.get("A4I_USE_GCLOUD_AUTH", "").strip() == "1"
        and os.environ.get("A4I_FORCE_LOCAL_PARQUET") != "1"
    ):
        raw_project = _detect_gcloud_project()
    project = raw_project if (raw_project and _PROJECT_RE.fullmatch(raw_project)) else ""
    return {
        "project": project,
        "dataset": dataset,
        "location": os.environ.get("A4I_LOCATION", "US").strip(),
        "state": state,
        "state_name": STATE_LABELS[state],
    }


def _find_data_dir() -> Path:
    """Locates `data/*.parquet` across repo root or container working dirs."""
    override = os.environ.get("A4I_DATA_DIR", "").strip()
    candidates = []
    if override:
        candidates.append(Path(override))
    here = Path(__file__).resolve()
    candidates.extend([
        here.parents[3] / "data",  # repo_root/data when running from repo
        here.parents[2] / "data",  # /app/data inside Docker container
        Path.cwd() / "data",
        Path.cwd().parent / "data",
    ])
    for cand in candidates:
        if (cand / "pediatric_and_ei_provider_directory.parquet").is_file():
            return cand
    raise FileNotFoundError(
        "Could not locate starter `data/*.parquet` files. Set A4I_DATA_DIR or configure BigQuery."
    )


@functools.lru_cache(maxsize=6)
def load_local_state_frames(state_code: str) -> dict[str, pd.DataFrame]:
    """Loads and normalizes the 5 starter tables for `state_code` from GeoParquet."""
    st = state_code.strip().upper()
    if st not in VALID_STATES:
        raise ValueError(f"Unsupported state_code={state_code!r}. Expected one of {VALID_STATES}.")
    data_dir = _find_data_dir()

    demo = pd.read_parquet(data_dir / "acs_under5_tract_demographics.parquet")
    demo = demo[demo["state_code"] == st].copy()
    demo["census_tract_geoid"] = demo["census_tract_geoid"].astype(str).str.strip().str.zfill(11)
    demo["county_fips"] = demo["county_fips"].astype(str).str.strip().str.zfill(5)

    nsch = pd.read_parquet(data_dir / "nsch_developmental_screening_survey.parquet")
    nsch = nsch[nsch["state_code"] == st].copy()
    if "geographic_level" in nsch.columns:
        nsch = nsch[nsch["geographic_level"] == "Statewide"].copy()

    agencies = pd.read_parquet(data_dir / "idea_part_c_agency_performance.parquet")
    agencies = agencies[agencies["state_code"] == st].copy()

    providers = pd.read_parquet(data_dir / "pediatric_and_ei_provider_directory.parquet")
    providers = providers[providers["state_code"] == st].copy()
    providers["census_tract_geoid"] = (
        providers["census_tract_geoid"].astype(str).str.strip().str.zfill(11)
    )
    providers["county_fips"] = providers["county_fips"].astype(str).str.strip().str.zfill(5)

    logs = pd.read_parquet(data_dir / "deidentified_part_c_referral_logs.parquet")
    logs = logs[logs["state_code"] == st].copy()
    logs["child_home_tract_geoid"] = (
        logs["child_home_tract_geoid"].astype(str).str.strip().str.zfill(11)
    )
    logs = logs.sort_values(["case_chain_id", "hop_sequence"]).reset_index(drop=True)

    return {
        "demo": demo,
        "nsch": nsch,
        "agencies": agencies,
        "providers": providers,
        "logs": logs,
    }


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Spherical distance in kilometers (matches BigQuery ST_DISTANCE / 1000)."""
    r_earth_km = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    return round(2.0 * r_earth_km * math.atan2(math.sqrt(a), math.sqrt(1.0 - a)), 1)


def rewrite_sql_dataset(sql: str, source_ds: str, target_ds: str) -> str:
    """Rewrites `{source_ds}.` references in SQL/GQL to `{target_ds}.` when distinct."""
    if not source_ds or not target_ds or source_ds == target_ds:
        return sql
    return re.sub(rf"(?<![A-Za-z0-9_]){re.escape(source_ds)}\.", f"{target_ds}.", sql)


def _build_property_graph_ddl(ds: str) -> str:
    """Builds the BigQuery Property Graph views + `ReferralGraph` DDL for dataset `ds`."""
    return f"""
    CREATE OR REPLACE VIEW {ds}.v_graph_neighborhoods AS
    SELECT
      LPAD(census_tract_geoid, 11, '0') AS tract_geoid,
      state_code,
      county_name,
      children_under_5_count,
      poverty_rate,
      no_vehicle_rate,
      assistance_rate,
      median_household_income,
      latitude,
      longitude
    FROM {ds}.acs_under5_tract_demographics;

    CREATE OR REPLACE VIEW {ds}.v_graph_refers_to_edges AS
    SELECT
      referral_event_id,
      source_provider_id,
      target_provider_id,
      state_code,
      case_chain_id,
      hop_sequence,
      referral_date,
      receiving_agency_id,
      handoff_wait_days,
      transmission_channel,
      handoff_reason,
      concern_domain,
      child_age_months,
      LPAD(child_home_tract_geoid, 11, '0') AS child_home_tract_geoid,
      quarterly_referral_volume,
      dropoff_rate_pct,
      IF(STARTS_WITH(handoff_reason, 'Re-Referral Bounce'), 1.0, 0.0) AS bounce_flag,
      AVG(IF(STARTS_WITH(handoff_reason, 'Re-Referral Bounce'), 1.0, 0.0)) OVER (
        PARTITION BY source_provider_id, target_provider_id
      ) AS pair_bounce_rate
    FROM {ds}.deidentified_part_c_referral_logs;

    CREATE OR REPLACE VIEW {ds}.v_graph_can_refer_to_edges AS
    WITH clean_ehr_base AS (
      SELECT
        source_provider_id,
        target_provider_id,
        handoff_wait_days,
        concern_domain,
        ROUND(
          PERCENTILE_CONT(handoff_wait_days, 0.5) OVER (
            PARTITION BY source_provider_id, target_provider_id
          ),
          0
        ) AS median_ehr_wait_days
      FROM {ds}.deidentified_part_c_referral_logs
      WHERE transmission_channel = 'ehr_electronic_portal'
        AND NOT STARTS_WITH(handoff_reason, 'Re-Referral Bounce')
    ),
    clean_ehr_top_domain AS (
      SELECT
        source_provider_id,
        target_provider_id,
        ARRAY_AGG(
          concern_domain ORDER BY domain_cnt DESC, concern_domain ASC LIMIT 1
        )[OFFSET(0)] AS primary_concern_domain
      FROM (
        SELECT
          source_provider_id,
          target_provider_id,
          concern_domain,
          COUNT(*) AS domain_cnt
        FROM clean_ehr_base
        GROUP BY source_provider_id, target_provider_id, concern_domain
      )
      GROUP BY source_provider_id, target_provider_id
    ),
    clean_ehr_pairs AS (
      SELECT
        b.source_provider_id,
        b.target_provider_id,
        COUNT(*) AS clean_ehr_events,
        CAST(ANY_VALUE(b.median_ehr_wait_days) AS INT64) AS median_ehr_wait_days,
        td.primary_concern_domain
      FROM clean_ehr_base AS b
      LEFT JOIN clean_ehr_top_domain AS td
        ON b.source_provider_id = td.source_provider_id
       AND b.target_provider_id = td.target_provider_id
      GROUP BY b.source_provider_id, b.target_provider_id, td.primary_concern_domain
    ),
    pair_bounces AS (
      SELECT
        source_provider_id,
        target_provider_id,
        AVG(IF(STARTS_WITH(handoff_reason, 'Re-Referral Bounce'), 1.0, 0.0)) AS edge_bounce_rate
      FROM {ds}.deidentified_part_c_referral_logs
      GROUP BY source_provider_id, target_provider_id
    ),
    target_outbound_bounces AS (
      SELECT
        source_provider_id,
        AVG(IF(STARTS_WITH(handoff_reason, 'Re-Referral Bounce'), 1.0, 0.0)) AS outbound_bounce_rate
      FROM {ds}.deidentified_part_c_referral_logs
      GROUP BY source_provider_id
    )
    SELECT
      CONCAT(src.provider_id, '_TO_', dst.provider_id) AS can_refer_edge_id,
      src.provider_id AS source_provider_id,
      dst.provider_id AS target_provider_id,
      src.state_code,
      CASE
        WHEN src.node_role = 'Screening_Pediatric_Clinic' AND dst.node_role = 'Part_C_Intake_Coordinator' THEN 'clinic_to_coord'
        WHEN src.node_role = 'Part_C_Intake_Coordinator' AND dst.node_role = 'Multidisciplinary_Eval_Hub' THEN 'coord_to_eval'
        WHEN src.node_role = 'Multidisciplinary_Eval_Hub' AND dst.node_role = 'EI_Therapy_Vendor' THEN 'eval_to_vendor'
        WHEN src.node_role = 'Part_C_Intake_Coordinator' AND dst.node_role = 'EI_Therapy_Vendor' THEN 'coord_to_vendor_fasttrack'
      END AS stage_transition,
      IF(ehr.clean_ehr_events > 0, 'observed_clean_corridor', 'prospective_capability') AS relationship_type,
      CAST(
        COALESCE(
          ehr.median_ehr_wait_days,
          dst.median_internal_wait_days + CASE
            WHEN dst.node_role = 'Part_C_Intake_Coordinator' THEN 0
            WHEN dst.node_role = 'Multidisciplinary_Eval_Hub' THEN 5
            ELSE 6
          END
        ) AS INT64
      ) AS expected_step_days,
      COALESCE(ehr.primary_concern_domain, 'ALL') AS domain_specialization,
      ROUND(SAFE_DIVIDE(dst.active_waitlist_count, dst.monthly_slot_capacity), 2) AS target_congestion_ratio,
      ROUND(COALESCE(out_b.outbound_bounce_rate, 0.0), 4) AS target_outbound_bounce_rate,
      ROUND(COALESCE(pb.edge_bounce_rate, 0.0), 4) AS edge_bounce_rate,
      dst.accepts_medicaid AS target_accepts_medicaid,
      dst.bilingual_services_listed AS target_bilingual
    FROM {ds}.pediatric_and_ei_provider_directory AS src
    JOIN {ds}.pediatric_and_ei_provider_directory AS dst
      ON src.state_code = dst.state_code
     AND src.provider_id != dst.provider_id
    LEFT JOIN clean_ehr_pairs AS ehr
      ON src.provider_id = ehr.source_provider_id
     AND dst.provider_id = ehr.target_provider_id
    LEFT JOIN pair_bounces AS pb
      ON src.provider_id = pb.source_provider_id
     AND dst.provider_id = pb.target_provider_id
    LEFT JOIN target_outbound_bounces AS out_b
      ON dst.provider_id = out_b.source_provider_id
    WHERE dst.part_c_vendor_enrolled = TRUE
      AND (
        (src.node_role = 'Screening_Pediatric_Clinic' AND dst.node_role = 'Part_C_Intake_Coordinator')
        OR (src.node_role = 'Part_C_Intake_Coordinator' AND dst.node_role = 'Multidisciplinary_Eval_Hub')
        OR (src.node_role = 'Multidisciplinary_Eval_Hub' AND dst.node_role = 'EI_Therapy_Vendor')
        OR (src.node_role = 'Part_C_Intake_Coordinator' AND dst.node_role = 'EI_Therapy_Vendor')
      );

    CREATE OR REPLACE VIEW {ds}.v_graph_serves_area_edges AS
    SELECT
      CONCAT(p.provider_id, '_', LPAD(n.census_tract_geoid, 11, '0')) AS serves_edge_id,
      p.provider_id,
      LPAD(n.census_tract_geoid, 11, '0') AS tract_geoid,
      ROUND(ST_DISTANCE(ST_GEOGPOINT(p.longitude, p.latitude), ST_GEOGPOINT(n.longitude, n.latitude)) / 1000.0, 2) AS travel_distance_km,
      CAST(ROUND((ST_DISTANCE(ST_GEOGPOINT(p.longitude, p.latitude), ST_GEOGPOINT(n.longitude, n.latitude)) / 1000.0) * 1.5, 0) AS INT64) AS estimated_travel_minutes,
      (p.node_role IN ('Multidisciplinary_Eval_Hub', 'EI_Therapy_Vendor') AND p.part_c_vendor_enrolled) AS mobile_visit_capable
    FROM {ds}.pediatric_and_ei_provider_directory AS p
    JOIN {ds}.acs_under5_tract_demographics AS n
      ON p.state_code = n.state_code;

    CREATE OR REPLACE PROPERTY GRAPH {ds}.ReferralGraph
      NODE TABLES (
        {ds}.pediatric_and_ei_provider_directory AS CareNode
          KEY (provider_id)
          LABEL CareNode
          PROPERTIES ALL COLUMNS EXCEPT (provider_geom),
        {ds}.v_graph_neighborhoods AS Neighborhood
          KEY (tract_geoid)
          LABEL Neighborhood
          PROPERTIES ALL COLUMNS
      )
      EDGE TABLES (
        {ds}.deidentified_part_c_referral_logs AS ReferralHandoff
          KEY (referral_event_id)
          SOURCE KEY (source_provider_id) REFERENCES CareNode (provider_id)
          DESTINATION KEY (target_provider_id) REFERENCES CareNode (provider_id)
          LABEL ReferralHandoff
          PROPERTIES ALL COLUMNS,
        {ds}.v_graph_refers_to_edges AS REFERS_TO
          KEY (referral_event_id)
          SOURCE KEY (source_provider_id) REFERENCES CareNode (provider_id)
          DESTINATION KEY (target_provider_id) REFERENCES CareNode (provider_id)
          LABEL REFERS_TO
          PROPERTIES ALL COLUMNS,
        {ds}.v_graph_can_refer_to_edges AS CAN_REFER_TO
          KEY (can_refer_edge_id)
          SOURCE KEY (source_provider_id) REFERENCES CareNode (provider_id)
          DESTINATION KEY (target_provider_id) REFERENCES CareNode (provider_id)
          LABEL CAN_REFER_TO
          PROPERTIES ALL COLUMNS,
        {ds}.v_graph_serves_area_edges AS SERVES_AREA
          KEY (serves_edge_id)
          SOURCE KEY (provider_id) REFERENCES CareNode (provider_id)
          DESTINATION KEY (tract_geoid) REFERENCES Neighborhood (tract_geoid)
          LABEL SERVES_AREA
          PROPERTIES ALL COLUMNS
      );
    """


class DualBackendGraphClient:
    """Executes BigQuery ISO GQL + GIS queries when GCP is active, with local fallback."""

    def __init__(self) -> None:
        self._bq_client: Any = None
        self._bq_clients_by_key: dict[tuple[str, str], Any] = {}
        self._graph_ensured = False
        self._ensured_datasets: set[tuple[str, str]] = set()
        self._resolved_dataset_cache: dict[tuple[str, str, str], str] = {}
        self._dataset_has_can_refer_cache: dict[tuple[str, str], bool] = {}
        self._last_resolution: tuple[str, str, str, str] | None = None
        self._query_cache: dict[
            tuple[str, str, str, str], tuple[list[dict[str, Any]], str | None, int | None]
        ] = {}
        self._query_cache_lock = threading.Lock()

    @staticmethod
    def _get_multistate_dataset_name() -> str:
        raw = os.environ.get("A4I_MULTISTATE_DATASET", "a4i_early_intervention_multistate").strip()
        return raw if _DATASET_RE.fullmatch(raw) else "a4i_early_intervention_multistate"

    def _get_bq(self) -> Any | None:
        if os.environ.get("A4I_FORCE_LOCAL_PARQUET") == "1":
            return None
        cfg = get_config()
        if not cfg["project"]:
            return None
        cache_key = (cfg["project"], cfg["location"])
        if cache_key in self._bq_clients_by_key:
            self._bq_client = self._bq_clients_by_key[cache_key]
            return self._bq_client
        try:
            from google.cloud import bigquery

            creds, _ = resolve_gcp_credentials_and_project()
            client = bigquery.Client(
                project=cfg["project"],
                location=cfg["location"],
                credentials=creds,
            )
            # Probe either the configured dataset or the multi-state dataset
            try:
                client.get_dataset(f"{cfg['project']}.{cfg['dataset']}")
            except Exception:  # noqa: BLE001
                ms_ds = self._get_multistate_dataset_name()
                client.get_dataset(f"{cfg['project']}.{ms_ds}")
            self._bq_clients_by_key[cache_key] = client
            self._bq_client = client
            return client
        except Exception as exc:  # noqa: BLE001
            logger.info("BigQuery client unavailable (%s); using local GeoParquet mirror.", exc)
            self._bq_clients_by_key[cache_key] = None
            self._bq_client = None
            return None

    def _count_state_providers(self, bq: Any, project: str, ds: str, state: str) -> int | None:
        """Returns row count for `state` in `ds.pediatric_and_ei_provider_directory`, or None on mock/error."""
        sql = (
            f"SELECT COUNT(*) AS cnt "
            f"FROM `{project}.{ds}.pediatric_and_ei_provider_directory` "
            f"WHERE state_code = '{state}'"
        )
        try:
            rows = list(bq.query(sql).result())
            if not rows:
                return 0
            first = rows[0]
            val = first["cnt"] if isinstance(first, dict) else getattr(first, "cnt", None)
            if val is None and hasattr(first, "get"):
                val = first.get("cnt")
            return int(val) if isinstance(val, (int, float)) else None
        except Exception:  # noqa: BLE001
            return 0

    def resolve_dataset_for_state(self, state: str | None = None) -> str:
        """Resolves `cfg['dataset']` or falls back to `A4I_MULTISTATE_DATASET` when `state` has 0 rows."""
        cfg = get_config()
        ds = cfg["dataset"]
        st = (state or cfg["state"]).strip().upper()
        if st not in VALID_STATES:
            st = cfg["state"]
        bq = self._get_bq()
        if bq is None or not cfg["project"]:
            return ds

        cache_key = (cfg["project"], ds, st)
        if cache_key in self._resolved_dataset_cache:
            return self._resolved_dataset_cache[cache_key]

        cnt = self._count_state_providers(bq, cfg["project"], ds, st)
        if cnt is None or cnt > 0:
            self._resolved_dataset_cache[cache_key] = ds
            return ds

        ms_ds = self._get_multistate_dataset_name()
        if ms_ds and ms_ds != ds:
            ms_cnt = self._count_state_providers(bq, cfg["project"], ms_ds, st)
            if ms_cnt is not None and ms_cnt > 0:
                logger.info(
                    "State %s has 0 rows in %s; routing live BigQuery queries to %s.",
                    st,
                    ds,
                    ms_ds,
                )
                self._resolved_dataset_cache[cache_key] = ms_ds
                return ms_ds

        self._resolved_dataset_cache[cache_key] = ds
        return ds

    def get_last_resolved_dataset(self, cfg: dict[str, str] | None = None) -> str:
        """Returns the effective BigQuery dataset used by the latest query for `cfg`."""
        cur = cfg or get_config()
        if (
            self._last_resolution is not None
            and self._last_resolution[0] == cur["project"]
            and self._last_resolution[1] == cur["dataset"]
            and self._last_resolution[2] == cur["state"]
        ):
            return self._last_resolution[3]
        return cur["dataset"]

    def _dataset_has_can_refer_to(self, bq: Any, project: str, ds: str) -> bool:
        key = (project, ds)
        if key in self._dataset_has_can_refer_cache:
            return self._dataset_has_can_refer_cache[key]
        try:
            bq.get_table(f"{project}.{ds}.v_graph_can_refer_to_edges")
            self._dataset_has_can_refer_cache[key] = True
            return True
        except Exception:  # noqa: BLE001
            self._dataset_has_can_refer_cache[key] = False
            return False

    def _ensure_graph_if_missing(self, bq: Any, project: str, ds: str) -> None:
        key = (project, ds)
        if key in self._ensured_datasets:
            return
        # Never mutate the shared single-state dataset `a4i_early_intervention` if ReferralGraph exists
        try:
            check_sql = (
                f"SELECT property_graph_name "
                f"FROM `{project}.{ds}.INFORMATION_SCHEMA.PROPERTY_GRAPHS` "
                f"WHERE property_graph_name = 'ReferralGraph'"
            )
            existing = list(bq.query(check_sql).result())
            if existing:
                self._ensured_datasets.add(key)
                return
        except Exception:  # noqa: BLE001
            pass

        if ds == "a4i_early_intervention":
            self._ensured_datasets.add(key)
            return

        if self.ensure_property_graph(dataset=ds):
            self._ensured_datasets.add(key)

    def ensure_property_graph(self, dataset: str | None = None) -> bool:
        """Idempotently declares `ReferralGraph` in BigQuery if not already created."""
        bq = self._get_bq()
        if bq is None:
            return False
        cfg = get_config()
        ds = (dataset or cfg["dataset"]).strip()
        if not _DATASET_RE.fullmatch(ds):
            ds = cfg["dataset"]
        if dataset is None and self._graph_ensured:
            return True
        ddl = _build_property_graph_ddl(ds)
        try:
            bq.query(ddl).result()
            if dataset is None:
                self._graph_ensured = True
            if cfg["project"]:
                self._ensured_datasets.add((cfg["project"], ds))
                self._dataset_has_can_refer_cache[(cfg["project"], ds)] = True
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not ensure ReferralGraph DDL (%s)", exc)
            return False

    def query(
        self,
        sql: str,
        job_config: Any = None,
        *,
        label: str | None = None,
        bq_client_override: Any = None,
        project_override: str | None = None,
    ) -> list[dict[str, Any]] | None:
        """Alias for `query_bq_or_none` with optional telemetry label and test overrides."""
        return self.query_bq_or_none(
            sql,
            job_config=job_config,
            label=label,
            bq_client_override=bq_client_override,
            project_override=project_override,
        )

    def query_bq_or_none(
        self,
        sql: str,
        job_config: Any = None,
        *,
        label: str | None = None,
        bq_client_override: Any = None,
        project_override: str | None = None,
    ) -> list[dict[str, Any]] | None:
        """Runs `sql` on BigQuery (with multi-state dataset routing) or returns `None` if offline."""
        t0 = time.perf_counter()
        cfg = get_config()
        effective_project = project_override if project_override is not None else cfg["project"]
        resolved_label = label or _infer_query_label(sql)
        bq = bq_client_override if bq_client_override is not None else self._get_bq()
        if bq is None:
            record_bq_telemetry(
                resolved_label,
                job_id=None,
                elapsed_ms=(time.perf_counter() - t0) * 1000.0,
                total_bytes_processed=None,
                row_count=0,
                dataset=cfg["dataset"],
                state_code=cfg["state"],
                engine="local_parquet",
            )
            return None
        configured_ds = cfg["dataset"]
        target_ds = (
            configured_ds
            if bq_client_override is not None
            else self.resolve_dataset_for_state(cfg["state"])
        )

        # If querying CAN_REFER_TO against a shared dataset that predates v_graph_can_refer_to_edges,
        # route cleanly to A4I_MULTISTATE_DATASET without altering the shared dataset.
        if (
            bq_client_override is None
            and effective_project
            and "CAN_REFER_TO" in sql
            and not self._dataset_has_can_refer_to(bq, effective_project, target_ds)
        ):
            ms_ds = self._get_multistate_dataset_name()
            if ms_ds != target_ds and self._dataset_has_can_refer_to(bq, effective_project, ms_ds):
                ms_cnt = self._count_state_providers(bq, effective_project, ms_ds, cfg["state"])
                if ms_cnt is not None and ms_cnt > 0:
                    target_ds = ms_ds

        try:
            if bq_client_override is None:
                if effective_project:
                    self._ensure_graph_if_missing(bq, effective_project, target_ds)
                else:
                    self.ensure_property_graph(dataset=target_ds)
            exec_sql = rewrite_sql_dataset(sql, configured_ds, target_ds)
            can_use_cache = (
                bq_client_override is None
                and job_config is None
                and bool(effective_project)
                and type(bq).__module__.startswith("google.cloud.bigquery")
            )
            cache_key = (effective_project, target_ds, cfg["state"], exec_sql)
            if can_use_cache:
                with self._query_cache_lock:
                    cached_hit = self._query_cache.get(cache_key)
                if cached_hit is not None:
                    cached_rows, cached_job_id, cached_bytes = cached_hit
                    result_rows = [dict(r) for r in cached_rows]
                    self._last_resolution = (effective_project, configured_ds, cfg["state"], target_ds)
                    record_bq_telemetry(
                        resolved_label,
                        job_id=cached_job_id,
                        elapsed_ms=(time.perf_counter() - t0) * 1000.0,
                        total_bytes_processed=cached_bytes,
                        row_count=len(result_rows),
                        dataset=target_ds,
                        state_code=cfg["state"],
                        engine="bigquery",
                    )
                    return result_rows

            job = bq.query(exec_sql, job_config=job_config)
            rows = job.result()
            result_rows = [dict(row.items()) for row in rows]
            self._last_resolution = (effective_project, configured_ds, cfg["state"], target_ds)
            raw_job_id = getattr(job, "job_id", None)
            job_id = str(raw_job_id) if isinstance(raw_job_id, (str, int)) else None
            raw_bytes = getattr(job, "total_bytes_processed", None)
            total_bytes = int(raw_bytes) if isinstance(raw_bytes, (int, float)) else None
            if can_use_cache and job_id is not None:
                with self._query_cache_lock:
                    if len(self._query_cache) >= 512:
                        self._query_cache.clear()
                    self._query_cache[cache_key] = (
                        [dict(r) for r in result_rows],
                        job_id,
                        total_bytes,
                    )
            record_bq_telemetry(
                resolved_label,
                job_id=job_id,
                elapsed_ms=(time.perf_counter() - t0) * 1000.0,
                total_bytes_processed=total_bytes,
                row_count=len(result_rows),
                dataset=target_ds,
                state_code=cfg["state"],
                engine="bigquery",
            )
            return result_rows
        except Exception as exc:  # noqa: BLE001
            logger.warning("BigQuery query failed (%s); falling back to local mirror.", exc)
            record_bq_telemetry(
                resolved_label,
                job_id=None,
                elapsed_ms=(time.perf_counter() - t0) * 1000.0,
                total_bytes_processed=None,
                row_count=0,
                dataset=target_ds,
                state_code=cfg["state"],
                engine="local_parquet",
            )
            return None


GraphClient = DualBackendGraphClient


if os.environ.get("A4I_USE_GCLOUD_AUTH", "").strip() == "1":
    install_gcloud_adc_bridge_if_needed()

graph_client = DualBackendGraphClient()
