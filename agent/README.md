# First Milestones — Multi-Agent ADK System, BigQuery Property Graph & Coordinator Workbench

Built for **Agents for Impact 2026 · Challenge 04: Early Intervention & Developmental Screening Triage**.

## Architecture Summary

### 1. Hierarchical Multi-Agent ADK Architecture (`first_milestones/agent.py` + `schemas.py`)
- **Root Orchestrator (`first_milestones_coordinator`):** Powered by Gemini Pro / Argon (`A4I_GEMINI_MODEL`, automatic fallback cascade via `A4I_GEMINI_FALLBACK_MODELS`), enforcing statutory **45-day IDEA Part C (`34 CFR § 303.310`)**, **36-month aging-out cliff**, zero-vehicle **Medicaid NEMT**, zero-race-input routing, and `100% [Synthetic]` stage-safety guardrails.
- **3 Specialist `gemini-2.5-flash` Sub-Agents (`A4I_SUBAGENT_MODEL=gemini-2.5-flash`):**
  1. `triage_pathway_router` — Executes prospective `<=45`-day multi-hop pathway routing (`Clinic -> Coordinator -> Eval Hub -> Therapy Vendor`) with spatial `ST_DISTANCE`, Medicaid/Part C/bilingual hard filters, and 36-month cliff buffers.
  2. `network_bottleneck_auditor` — Runs variable-length `-{2,4}->` ISO GQL bounce audits correlated on `case_chain_id` (prefix-deduplicated to eliminate 3-hop Type B double-counting) and simulates `paper_fax -> ehr_electronic_portal` counterfactual interventions.
  3. `equity_and_caregiver_specialist` — Performs strictly post-output neighborhood equity audits (`audit_*` ACS shares joined *after* routing), ranks Hidden EI Deserts for mobile screening without 6x NSCH fan-out, and composes plain-language **English & Español** Caregiver Action Notes.
- **Pydantic Schema Validation (`first_milestones/schemas.py`):** Validates structured 45-Day Pathway & Network Brief payloads across ADK tool outputs, REST endpoints, and UI artifacts.

### 2. Multi-State BigQuery Property Graph & Data Rigor (`first_milestones/tools/`)
- **Live 6-State Property Graph (`a4i_early_intervention_multistate.ReferralGraph` & `a4i_early_intervention.ReferralGraph`):**
  - Supports all 6 challenge states out of the box: **Mississippi (`MS`, FIPS `28`)**, **California (`CA`, leading-zero FIPS `'06...'`, `41,144` under-5 children across `101` tracts)**, **Alabama (`AL`, leading-zero FIPS `'01...'`)**, **Georgia (`GA`, `13`)**, **Texas (`TX`, `48`)**, and **New York (`NY`, `36`)**.
  - `A4I_DATASET=a4i_early_intervention` remains preserved as the primary single-state dataset while `A4I_MULTISTATE_DATASET=a4i_early_intervention_multistate` serves live cross-state ISO/IEC 39075 GQL `GRAPH_TABLE` switching without reloading tables.
- **4 Verified Data & Graph Rigor Guardrails:**
  1. **Zero-Padding FIPS Preservation:** `census_tract_geoid` (11-char `STRING`) and `county_fips` (5-char `STRING`) preserve `'01...'` (AL) and `'06...'` (CA) leading zeros end-to-end.
  2. **ACS `limited_english_rate` Trap Caught:** All 426 starter ACS tracts carry `0.0` in `limited_english_rate`; excluded from formulas and replaced with `bilingual_services_listed` + statewide HRSA NSCH language strata.
  3. **Statewide-Only NSCH Grain:** `nsch_developmental_screening_survey` (`6` statewide rows per state) is never cross-joined to tracts, preventing 6x row fan-out.
  4. **Correlated Prefix-Deduplicated GQL:** `COUNT(DISTINCT h.case_chain_id) = 1` + `QUALIFY ROW_NUMBER() OVER (PARTITION BY chain_id ORDER BY total_hops DESC) = 1` yields exact 44 episodes and 26 `>45d` breaches in MS.

### 3. Google-Managed MCP Integration (`tools.yaml` + `mcp_integration.py`)
- Connects automatically to **Google MCP Toolbox for Databases** (`googleapis/mcp-toolbox` `v0.27.0` via ADK `ToolboxToolset` using `agent/tools.yaml`) inside Cloud Run, or to **BigQuery's Built-in Remote Managed MCP Server** (`https://bigquery.googleapis.com/mcp` via ADK `McpToolset` + Google ADC headers).

### 4. Interactive Cytoscape.js Graph & SSE Streaming Workbench (`main.py` + `static/`)
- **Live SSE Streaming (`POST /run` & `/api/chat`):** Streams real-time ADK agent/sub-agent delegation events, tool invocations, and token deltas to the Coordinator Assistant pane while simultaneously synchronizing the right-hand Pathway & Network Brief.
- **Interactive Cytoscape.js Referral Topology (`static/vendor/cytoscape.min.js`):** Renders interactive multi-hop provider nodes (`Screening_Pediatric_Clinic`, `Part_C_Intake_Coordinator`, `Multidisciplinary_Eval_Hub`, `EI_Therapy_Vendor`), crimson `paper_fax` bounce loops (`>45d`), and emerald `ehr_electronic_portal` compliant corridors (`<=45d`) with filter toggles, hover tooltips, and click-to-inspect details.

- **Multi-Frontend Support (`frontend/` React UI + `/workbench` Classic UI):** Multi-stage `Dockerfile` builds the React + Vite workbench (`frontend/` → `/app/frontend/dist`, served at `/`), while `/workbench` (or `A4I_CLASSIC_WORKBENCH=1`) serves the Cytoscape.js workbench (`static/index.html`). `POST /api/chat` accepts both `message` and `prompt` and returns both `reply` and `response`.

### 5. Programmatic Guardrails, Persistent Sessions & Telemetry (`guardrails.py` + `session_store.py`)
- **Pre-Tool & Post-Model Guardrails (`first_milestones/guardrails.py`):**
  - `guardrail_before_tool_callback` blocks mutating SQL (`DROP/DELETE/UPDATE/INSERT/CREATE`) and illegal `WHERE`/`HAVING`/`ORDER BY` filtering on `audit_*` demographic shares or `limited_english_rate` (`0.0`).
  - `guardrail_after_model_callback` verifies `SYN-PROV-*` IDs against state directories (scrubbing ungrounded IDs), injects `100% [Synthetic]` + 6-row `Statewide` NSCH notices, enforces `36-month` Part B safeguards for `30–35m` toddlers (and removes spurious `36-month` headings for `<27m`), and guarantees clinical diagnosis refusal when diagnosis intent appears.
- **Persistent Session Store & Request Isolation (`session_store.py` + `bq_client.py`):** Thread-safe SQLite session persistence (`SqlitePersistentSessionService`, configurable via `A4I_SESSION_BACKEND`) plus `ContextVar` request-scoped `state_code` isolation (`4/4` concurrent `MS`+`CA` probe pass).
- **Observability & Auth (`main.py`):** In-process `_ObservabilityTracker` exposes P50/P95 latency, fallback rate, and session backend telemetry on `/api/health`; optional `A4I_API_TOKEN` bearer auth secures write/chat endpoints.

### 6. Automated Agent Evaluation Suite (`agent/eval/`)
- **Benchmark & ADK Compatibility:** `eval/golden_evalset.json` (20 golden + adversarial prompts across `MS`/`CA` and all 3 tracks) with `eval/adk_bridge.py` exporting standard Google ADK `EvalSet` JSON.
- **5 Automated Graders (`eval/graders.py`):** Tool-Trajectory Precision/Recall/F1, Numeric & Entity Faithfulness, Statutory `34 CFR § 303.310` Compliance, 4-Pillar Ethics/Rigor Guardrails, and Concurrent State Consistency (`eval/evaluate_agent.py --target live-http` or `--target local-asgi`).
- **Measured Live Cloud Run Improvement (see [`eval/EVAL_AND_PROD_READINESS.md`](eval/EVAL_AND_PROD_READINESS.md)):** Raising strict zero-tolerance case pass rate from **15.0% → 50.0% (+35.0 pp)**, mean composite from **0.8705 → 0.9289**, post-output equity audit invocation from **10.0% → 75.0%**, Track 3 Outreach to **100%**, Track 1 Routing to **80%**, and **100% (`4/4`)** concurrent multi-state isolation.

---

## Quick Start

### 1. Run Evaluation & Unit Test Suites
```bash
PYTHONPATH=agent uv run --python 3.12 --with-requirements agent/requirements.txt --with pytest --with pytest-asyncio --with httpx \
  pytest -q agent/tests/test_first_milestones.py agent/tests/test_eval_graders.py agent/tests/test_accuracy_upgrades.py agent/tests/test_p0_p1_fixes.py
# Run offline/ASGI benchmark sweep:
PYTHONPATH=agent uv run --python 3.12 --with-requirements agent/requirements.txt --with httpx \
  python agent/eval/evaluate_agent.py --target local-asgi
```

### 2. Local `gcloud` ADC Bridge & Local Workbench (`http://localhost:8080`)
If running locally with an active `gcloud auth login` session (without browser ADC setup):
```bash
bash scripts/setup_local_adc.sh         # bridges gcloud CLI credentials for BigQuery + Vertex AI
.venv/bin/python agent/main.py          # launches Split-Pane Coordinator Workbench on :8080
```
Or launch the built-in ADK Developer Web UI:
```bash
.venv/bin/adk web agent
```

### 3. Deploy Unified Workbench + MCP Toolbox to Google Cloud Run
From the repository root:
```bash
bash scripts/deploy_cloud_run.sh MS     # or CA, AL, GA, TX, NY (pass --skip-data for code-only redeploy)
```
Configures `--min-instances=1`, `A4I_DATASET=a4i_early_intervention`, `A4I_MULTISTATE_DATASET=a4i_early_intervention_multistate`, and `A4I_SUBAGENT_MODEL=gemini-2.5-flash` for zero-cold-start live demos.

### 4. Deploy ADK Package to Vertex AI Agent Engine (`google-adk==2.14.1`)
Validate flags, staging bucket, and agent importability first with `--dry-run`, then deploy live:
```bash
bash scripts/deploy_agent_engine.sh --dry-run
bash scripts/deploy_agent_engine.sh --project="$GOOGLE_CLOUD_PROJECT" --region=us-central1
```
