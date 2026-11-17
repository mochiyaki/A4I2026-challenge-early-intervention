# First Milestones (`sahuja/` Isolated Workspace)

**IDEA Part C Early Intervention & Developmental Screening Triage Workbench**  
*Agents for Impact 2026 · California (`CA`, FIPS `06`) · GCP Project `qwiklabs-gcp-04-670e1c9d4f6d`*

Everything in this `sahuja/` subfolder (and its GCP resources) is isolated from teammates' files and datasets:

| Resource | Name | Location |
|---|---|---|
| **BigQuery Dataset** | `a4i_early_intervention_sahuja` | `us-central1` |
| **BigQuery Enterprise Reservation** | `a4i-graph-sahuja` (`0` baseline, `50` autoscale) | `region-us-central1` |
| **BigQuery Property Graph** | `a4i_early_intervention_sahuja.ReferralGraph` | `us-central1` |
| **Managed MCP Server** | Google BigQuery MCP (`https://bigquery.googleapis.com/mcp`) | Global / `us-central1` |
| **Cloud Run Service** | `first-milestones-sahuja` | `us-central1` |

---

## Plain-Words Data Provenance & Rigor Guardrails

1. **`100% [Synthetic]` Network Ethics:** Every provider (`SYN-PROV-*`), lead agency (`SYN-PARTC-*`), and referral handoff (`CHAIN-*`) is fictional on purpose so simulated waitlists, paper-fax delays, and 45-day IDEA Part C statutory breaches never implicate real clinicians.
2. **Real Census + Modeled Statewide Survey:** `acs_under5_tract_demographics` contains real public US Census ACS 5-Year under-5 counts, poverty, zero-vehicle shares, and `tract_geom` (`GEOGRAPHY`). `nsch_developmental_screening_survey` is calibrated to HRSA NSCH at the **`Statewide`** level (`6` strata/state—queried without `state_code`-only joins to prevent 6x tract duplication).
3. **Caught ACS All-Zero Trap:** `limited_english_rate` is `0.0` across all rows in this ACS extract; language routing uses `bilingual_services_listed` and NSCH `primary_home_language` instead.
4. **Correlated Variable-Length ISO GQL (`-{2,4}->`):** Episode breach audits correlate `case_chain_id` (`COUNT(DISTINCT h.case_chain_id) = 1`) across hops so Child A's inbound referral is never stitched to Child B's outbound referral.
5. **Zero Race-in-Routing:** `audit_*` race/ethnicity share columns are strictly excluded from routing and outreach scoring, and joined only post-output in `run_post_output_equity_audit`.

---

## Quick Start

### 1. Run Locally (Split-Screen Visual Workbench)
```bash
cd sahuja
../.venv/bin/uvicorn app.server:app --host 127.0.0.1 --port 8080 --reload
```
Open http://127.0.0.1:8080 in your browser.

### 2. Run with ADK Developer UI (`adk web`)
```bash
cd sahuja/agent
../../.venv/bin/adk web
```

### 3. Deploy Live to Cloud Run (`first-milestones-sahuja`)
```bash
bash sahuja/scripts/deploy_cloud_run.sh
```
