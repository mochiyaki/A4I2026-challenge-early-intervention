"""Google-managed MCP server integration for First Milestones ADK Agent.

Supports two sanctioned Google-managed MCP backends out of the box:
  1. Google MCP Toolbox for Databases (`googleapis/mcp-toolbox` running via
     `tools.yaml` on `TOOLBOX_URL`, default `http://127.0.0.1:5000`), consumed
     through ADK's built-in `ToolboxToolset`.
  2. Google BigQuery Built-in Remote MCP Server (`https://bigquery.googleapis.com/mcp`),
     consumed through ADK's `McpToolset` + `StreamableHTTPConnectionParams` with
     automatic Google Application Default Credentials (ADC) token refresh.
     Governance guardrail: unrestricted raw `execute_sql` is strictly excluded from
     the BigQuery MCP tool filter so the LLM cannot query `audit_*` demographic
     shares or `limited_english_rate` directly during routing.

When running locally without a live Toolbox process or GCP credentials (e.g.,
offline laptop preview), returns local parity reference tools backed by the
starter GeoParquet files so `adk web` and unit tests never crash on startup.
"""

from __future__ import annotations

import logging
import os
import urllib.request
from typing import Any

from .tools import bq_client as _bq_client

logger = logging.getLogger(__name__)

BIGQUERY_MCP_URL = "https://bigquery.googleapis.com/mcp"

# Governed read-only metadata tools allowed on BigQuery's remote MCP server.
# `execute_sql` is intentionally excluded so the LLM cannot bypass the anti-bias
# `audit_*` and all-zero `limited_english_rate` routing firewall.
BQ_MCP_READONLY_TOOL_ALLOWLIST: tuple[str, ...] = (
    "list_dataset_ids",
    "get_dataset_info",
    "list_table_ids",
    "get_table_info",
)
FORBIDDEN_UNRESTRICTED_BQ_MCP_TOOLS: frozenset[str] = frozenset({"execute_sql"})


def filter_governed_bq_mcp_tools(
    candidate_tools: list[str] | tuple[str, ...] | None = None,
) -> list[str]:
    """Filters BigQuery MCP tool names, strictly excluding unrestricted `execute_sql`."""
    source = candidate_tools if candidate_tools is not None else BQ_MCP_READONLY_TOOL_ALLOWLIST
    allowed = set(BQ_MCP_READONLY_TOOL_ALLOWLIST)
    return [
        t
        for t in source
        if t in allowed and t not in FORBIDDEN_UNRESTRICTED_BQ_MCP_TOOLS
    ]


def _is_toolbox_reachable(url: str, timeout: float = 1.2) -> bool:
    """Checks whether the MCP Toolbox HTTP server is listening."""
    try:
        req = urllib.request.Request(url.rstrip("/") + "/api/toolset", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 500
    except Exception:  # noqa: BLE001
        return False


def _get_adc_headers(_context: Any = None) -> dict[str, str]:
    """Supplies refreshed OAuth2 bearer headers for BigQuery's remote MCP server."""
    import google.auth
    import google.auth.transport.requests

    use_gcloud_bridge = bool(
        os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
        or os.environ.get("A4I_USE_GCLOUD_AUTH", "").strip() == "1"
        or os.environ.get("A4I_MCP_MODE", "").strip().lower() == "bigquery_mcp"
    )
    if use_gcloud_bridge:
        credentials, project_id = _bq_client.resolve_gcp_credentials_and_project(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
    else:
        from google.auth.exceptions import DefaultCredentialsError

        try:
            credentials, project_id = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
        except DefaultCredentialsError:
            return {}

    if not getattr(credentials, "valid", False):
        auth_req = google.auth.transport.requests.Request()
        credentials.refresh(auth_req)
    resolved_project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip() or project_id or ""
    headers = {
        "Authorization": f"Bearer {credentials.token}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if resolved_project:
        headers["x-goog-user-project"] = resolved_project
    return headers


def load_managed_mcp_tools() -> tuple[list[Any], str]:
    """Returns `(tools_list, mcp_mode_label)` for the root ADK agent.

    Controlled by `A4I_MCP_MODE`:
      - `auto` (default): Prefer local/sidecar MCP Toolbox if reachable, else
        BigQuery remote managed MCP server if GCP ADC credentials are active,
        else offline local parity fallback tools.
      - `toolbox`: Force `ToolboxToolset` against `TOOLBOX_URL`.
      - `bigquery_mcp`: Force remote `https://bigquery.googleapis.com/mcp`
        (read-only metadata tools + governed lookup tools; `execute_sql` excluded).
      - `fallback`: Use local GeoParquet parity reference tools.
    """
    mode = os.environ.get("A4I_MCP_MODE", "auto").strip().lower()
    toolbox_url = os.environ.get("TOOLBOX_URL", "http://127.0.0.1:5000").strip()

    from .tools.reference_lookups import (
        lookup_carenode_directory,
        lookup_regional_agency_kpis,
        lookup_statewide_nsch_strata,
        lookup_tract_routing_context,
    )

    governed_lookup_tools = [
        lookup_regional_agency_kpis,
        lookup_statewide_nsch_strata,
        lookup_tract_routing_context,
        lookup_carenode_directory,
    ]

    # 1. MCP Toolbox for Databases (Google-managed binary configured via tools.yaml)
    if mode in ("auto", "toolbox"):
        if _is_toolbox_reachable(toolbox_url):
            try:
                try:
                    from google.adk.tools.toolbox_toolset import ToolboxToolset
                except ImportError:
                    from toolbox_adk import ToolboxToolset  # type: ignore[assignment]

                toolset = ToolboxToolset(
                    server_url=toolbox_url,
                    toolset_name="first_milestones_bq",
                )
                logger.info("Connected to Google MCP Toolbox for Databases at %s", toolbox_url)
                return [toolset], f"mcp_toolbox ({toolbox_url})"
            except Exception as exc:  # noqa: BLE001
                logger.warning("MCP Toolbox initialization skipped (%s); falling back.", exc)
        elif mode == "toolbox":
            logger.warning(
                "A4I_MCP_MODE=toolbox requested but MCP Toolbox at %s is unreachable; falling back.",
                toolbox_url,
            )

    # 2. BigQuery Built-in Remote Managed MCP Server (bigquery.googleapis.com/mcp)
    #    Excludes raw `execute_sql` so the LLM cannot bypass the `audit_*` /
    #    `limited_english_rate` firewall; pairs read-only metadata inspection
    #    with governed lookup tools.
    if mode in ("auto", "bigquery_mcp") and os.environ.get("A4I_FORCE_LOCAL_PARQUET") != "1":
        try:
            initial_headers = _get_adc_headers()
            if initial_headers.get("x-goog-user-project"):
                from google.adk.tools.mcp_tool.mcp_session_manager import (
                    StreamableHTTPConnectionParams,
                )
                from google.adk.tools.mcp_tool.mcp_toolset import McpToolset

                bq_mcp = McpToolset(
                    connection_params=StreamableHTTPConnectionParams(
                        url=BIGQUERY_MCP_URL,
                        headers=initial_headers,
                    ),
                    tool_filter=filter_governed_bq_mcp_tools(),
                    header_provider=_get_adc_headers,
                )
                logger.info(
                    "Connected to Google-managed BigQuery Remote MCP Server (%s) with governed read-only tool filter",
                    BIGQUERY_MCP_URL,
                )
                return [bq_mcp, *governed_lookup_tools], (
                    "google_bigquery_remote_mcp (bigquery.googleapis.com/mcp, execute_sql excluded)"
                )
        except Exception as exc:  # noqa: BLE001
            logger.info("Remote BigQuery MCP not active locally (%s); using parity lookup tools.", exc)
            if mode == "bigquery_mcp":
                raise

    # 3. Local parity fallback tools (when previewing without GCP credentials)
    return (
        governed_lookup_tools,
        "local_parquet_parity_tools (configure GOOGLE_CLOUD_PROJECT or start toolbox for live MCP)",
    )


def build_mcp_toolsets() -> tuple[list[Any], str]:
    """Builds Google-managed MCP toolsets (`ToolboxToolset` / `McpToolset`) with local fallback."""
    return load_managed_mcp_tools()


__all__ = [
    "BIGQUERY_MCP_URL",
    "BQ_MCP_READONLY_TOOL_ALLOWLIST",
    "FORBIDDEN_UNRESTRICTED_BQ_MCP_TOOLS",
    "build_mcp_toolsets",
    "filter_governed_bq_mcp_tools",
    "load_managed_mcp_tools",
]
