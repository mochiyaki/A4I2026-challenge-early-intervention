"""GCP authentication and BigQuery client helpers for sahuja/ First Milestones agent."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import google.auth
from google.auth.credentials import Credentials as BaseCredentials
from google.auth.transport.requests import Request
from google.cloud import bigquery

SAHUJA_DIR = Path(__file__).resolve().parents[2]
CONFIG_PATH = SAHUJA_DIR / "bq_config.json"

_cfg: dict = {}
if CONFIG_PATH.is_file():
    try:
        _cfg = json.loads(CONFIG_PATH.read_text())
    except Exception:
        _cfg = {}

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or _cfg.get("project") or "qwiklabs-gcp-04-670e1c9d4f6d"
DATASET = os.environ.get("A4I_DATASET") or _cfg.get("dataset") or "a4i_early_intervention_sahuja"
BQ_LOCATION = os.environ.get("A4I_BQ_LOCATION") or _cfg.get("location") or "us-central1"
VERTEX_LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
STATE = os.environ.get("A4I_STATE") or _cfg.get("state") or "CA"


def _find_gcloud() -> str | None:
    found = shutil.which("gcloud")
    if found:
        return found
    fallback = "/Users/sahuja/data/genai-code/terraform/google-cloud-sdk/bin/gcloud"
    if os.path.isfile(fallback):
        return fallback
    return None


class GcloudCliCredentials(BaseCredentials):
    """Refreshes OAuth access tokens via gcloud CLI for seamless local Qwiklabs auth."""

    def __init__(self, gcloud_bin: str):
        super().__init__()
        self._gcloud_bin = gcloud_bin
        self._fetched_at = 0.0
        self.refresh(None)

    @property
    def valid(self) -> bool:
        return bool(self.token) and (time.time() - self._fetched_at < 2400)

    @property
    def expired(self) -> bool:
        return not self.valid

    def refresh(self, request) -> None:
        self.token = subprocess.check_output(
            [self._gcloud_bin, "auth", "print-access-token"],
            text=True,
            timeout=20,
        ).strip()
        self._fetched_at = time.time()


_CACHED_CREDS = None


def get_credentials():
    global _CACHED_CREDS
    if _CACHED_CREDS is not None:
        if not _CACHED_CREDS.valid:
            _CACHED_CREDS.refresh(Request())
        return _CACHED_CREDS

    if os.environ.get("K_SERVICE") or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        _CACHED_CREDS = creds
        return creds

    gcloud_bin = _find_gcloud()
    if gcloud_bin:
        try:
            _CACHED_CREDS = GcloudCliCredentials(gcloud_bin)
            return _CACHED_CREDS
        except Exception:
            pass

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    _CACHED_CREDS = creds
    return creds


def get_access_token() -> str:
    creds = get_credentials()
    if not creds.valid or not creds.token:
        creds.refresh(Request())
    return creds.token


def get_bq_client() -> bigquery.Client:
    return bigquery.Client(
        project=PROJECT,
        location=BQ_LOCATION,
        credentials=get_credentials(),
    )
