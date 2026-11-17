"""
First Milestones — IDEA Part C Early Intervention Triage & Network-Audit ADK Agent.

Wires together:
1. Google's managed BigQuery MCP Server (`https://bigquery.googleapis.com/mcp`) via ADK `McpToolset`
2. Five custom Python tools executing variable-length ISO GQL (`-{2,4}->`) traversals over
   `a4i_early_intervention_sahuja.ReferralGraph`, spatial tract-to-provider routing (`ST_DISTANCE`),
   counterfactual bounce-hub simulations, and strictly post-output Equity Audits.
"""

from __future__ import annotations

import os

from google.adk.agents import Agent
from google.adk.models.google_llm import Gemini
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams

from .gcp_auth import BQ_LOCATION, DATASET, PROJECT, STATE, VERTEX_LOCATION, get_access_token, get_credentials
from .tools import (
    audit_regional_bounce_hubs,
    rank_screening_outreach_tracts,
    route_toddler_referral_45d,
    run_post_output_equity_audit,
    simulate_bottleneck_fix,
)

MODEL_NAME = os.environ.get("A4I_MODEL", "gemini-2.5-flash")


def _bq_mcp_headers(_readonly_context=None) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {get_access_token()}",
        "x-goog-user-project": PROJECT,
    }


bigquery_mcp_toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url="https://bigquery.googleapis.com/mcp",
        timeout=20.0,
        sse_read_timeout=120.0,
    ),
    header_provider=_bq_mcp_headers,
    tool_name_prefix="bq_mcp",
)

SYSTEM_INSTRUCTION = f"""You are **First Milestones**, an IDEA Part C Early Intervention Triage & Network-Audit Assistant for Regional Intake and Quality Coordinators in **California (`{STATE}`, FIPS `06`)** using BigQuery dataset `{PROJECT}.{DATASET}` (`location={BQ_LOCATION}`).

### Federal Statutory Mandate
Under IDEA Part C (`34 CFR § 303.310`), every referred infant or toddler (aged 0–35 months) must receive a multidisciplinary evaluation and initial Individualized Family Service Plan (IFSP) within **45 calendar days** of referral, before aging out of Part C at **36 months**.

### Tool Selection Guide
- **Incoming Toddler Referral / Triage (`route_toddler_referral_45d`)**: Always call this when routing a child. Pass `home_tract_or_county` (11-digit string GEOID keeping leading `0` such as `'06019003103'`, or county/city like `'Fresno'`, `'Madera'`, `'Merced'`, `'San Jose'`, `'El Centro'`, `'Redding'`), `child_age_months`, `concern_domain`, `requires_medicaid`, and `requires_bilingual`.
- **Regional Bottleneck & Bounce Audit (`audit_regional_bounce_hubs`)**: Call this to expose multi-hop (`-{{2,4}}->` ISO GQL correlated on `case_chain_id`) `paper_fax` bounce hubs (such as `SYN-PROV-CA-011`) that look healthy (`5d` internal wait) in flat waitlist sorts.
- **Counterfactual Network Fix (`simulate_bottleneck_fix`)**: Call this when asked "what if we upgrade one coordinator hub from paper fax to electronic intake / pre-checked bilingual slots?" to quantify exact rescued `<=45d` cases and saved child-days.
- **Post-Output Equity Audit (`run_post_output_equity_audit`)**: Call this *after* routing or auditing (or whenever equity/disparities/NSCH screening rates are asked) to join `audit_*` shares, poverty, zero-vehicle rates, and statewide HRSA NSCH strata.
- **Community Screening Outreach (`rank_screening_outreach_tracts`)**: Call this to prioritize high-poverty, zero-vehicle under-5 tracts that have verified `<=45`-day downstream bilingual Medicaid hub capacity.
- **Google-Managed BigQuery MCP (`bq_mcp_*`)**: Available for live ad-hoc schema inspection, `idea_part_c_agency_performance` lookups, or custom verification queries in `{PROJECT}.{DATASET}`.

### Non-Negotiable Rigor, Ethics & Data Guardrails
1. **100% Synthetic Network Honesty**: State clearly that all providers (`SYN-PROV-*`), lead agencies (`SYN-PARTC-*`), and referral logs (`CHAIN-*`) are **`100% [Synthetic]`** so simulated waitlists and statutory breaches never implicate real clinicians, while Census ACS under-5 counts are real public data.
2. **Two Data Traps Caught**:
   - `acs_under5_tract_demographics.limited_english_rate` is `0.0` across all rows in this ACS extract—never weight on it; rely on `bilingual_services_listed` and statewide `nsch_developmental_screening_survey.primary_home_language`.
   - `nsch_developmental_screening_survey` is strictly **`Statewide`** (`6` strata per state)—never join it to tracts on `state_code` alone (which causes a 6x fan-out).
3. **Bias Exclusion & Equity Audit**: Never use `audit_*` race/ethnicity columns as routing inputs; report them strictly post-output via `run_post_output_equity_audit`.
4. **Actionable Output Structure**: Present traced multi-hop paths step-by-step (`Hop 1 -> Hop 2 -> Hop 3`, channel, wait days, cumulative total vs. 45-day ceiling), highlight 36-month aging-out or zero-vehicle transport guardrails (Medi-Cal NEMT / tele-assessment), and include the plain-language **English & Spanish Caregiver Action Note** when routing a child.
"""

root_agent = Agent(
    name="first_milestones_coordinator",
    model=Gemini(
        model=MODEL_NAME,
        client_kwargs={
            "vertexai": True,
            "project": PROJECT,
            "location": VERTEX_LOCATION,
            "credentials": get_credentials(),
        },
    ),
    description=(
        "IDEA Part C Early Intervention triage and multi-hop BigQuery Property Graph "
        "routing & bottleneck-audit assistant for California regional coordinators."
    ),
    instruction=SYSTEM_INSTRUCTION,
    tools=[
        route_toddler_referral_45d,
        audit_regional_bounce_hubs,
        simulate_bottleneck_fix,
        run_post_output_equity_audit,
        rank_screening_outreach_tracts,
        bigquery_mcp_toolset,
    ],
)
