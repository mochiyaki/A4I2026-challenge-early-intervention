# First Milestones — Multi-Agent ADK System, 6-State BigQuery Property Graph & Coordinator Workbench

Built for **Agents for Impact 2026 · Challenge 04: Early Intervention & Developmental Screening Triage**.

## Architecture Summary

### 1. Hierarchical Multi-Agent ADK Architecture (`first_milestones/agent.py`, `schemas.py`, `guardrails.py`)
- **Root Orchestrator (`first_milestones_coordinator`):** Powered by `gemini-2.5-pro` (`A4I_GEMINI_MODEL`, automatic fallback cascade via `A4I_GEMINI_FALLBACK_MODELS` with tuned Gemini 2.5 Pro/Flash thinking budgets), enforcing statutory **45-day IDEA Part C (`34 CFR § 303.310`)**, the **5-tier `34 CFR § 303.209` / `§ 303.21` / `§ 300.800` age transition engine**, zero-vehicle **Medicaid NEMT** + **Natural Environment home visits (`34 CFR § 303.126`)**, zero-race-input routing, and `100% [Synthetic]` stage-safety guardrails.
- **3 Specialist `gemini-2.5-flash` Sub-Agents (`A4I_SUBAGENT_MODEL=gemini-2.5-flash`):**
  1. `triage_pathway_router` — Executes Hop-0 intake packet gatekeeping (`check_intake_packet_readiness`), prospective `<=45`-day multi-hop pathway routing (`find_compliant_45d_pathways`, `find_viable_45d_paths` over `Clinic -> Coordinator -> Eval Hub -> Therapy Vendor` via `CAN_REFER_TO` + `SERVES_AREA` + `ST_DISTANCE`), and hold-aware slot reservation (`reserve_pathway_slot`).
  2. `network_bottleneck_auditor` — Runs variable-length `-{2,4}->` ISO GQL bounce & regional betweenness audits (`audit_multihop_bounce_hubs`, `detect_regional_bottleneck_hubs`, `get_referral_history`) correlated on `case_chain_id` and prefix-deduplicated to eliminate 3-hop Type B double-counting, plus counterfactual `paper_fax -> ehr_electronic_portal` + slot pre-check simulations (`simulate_hub_intervention`).
  3. `equity_and_caregiver_specialist` — Runs strictly post-output neighborhood equity & before-vs-after non-racial re-routing cohort parity audits (`run_post_output_equity_audit`), detects True Hidden EI Deserts paired with public-domain HRSA FQHC BYOD screening sites (`rank_outreach_zones`, `prioritize_community_screening_tracts`, `17 U.S.C. § 105`), preserves 6-row `'Statewide'` HRSA NSCH grain, and composes date-anchored plain-language **English & Español** Caregiver Action Notes (`brief_builder.py`).
- **Pydantic Schema Validation & Runtime Callbacks (`schemas.py`, `guardrails.py`):** Validates structured `PathwayBrief` payloads end-to-end while blocking `audit_*` demographic shares, `limited_english_rate`, and raw PII before tool execution.

### 2. Live SSE Streaming, React Coordinator UI & Cytoscape.js Workbench (`main.py`, `frontend/`, `static/`)
- **Dual UI Surfaces:**
  - `GET /` serves the built **React 19 + Vite + Tailwind v4 Coordinator UI** (`frontend/dist/index.html`) featuring a resizable 3-pane split workspace, 5-Agent Clinical Intelligence Council, interactive 30-node `ReferralGraph` SVG canvas, Google Maps JavaScript/Places SDK clinic routing, and English/Spanish Web Speech Voice & Chat Copilot.
  - `GET /workbench` (or `GET /` when `A4I_CLASSIC_WORKBENCH=1`) serves the **Classic Cytoscape.js Coordinator Workbench** (`static/index.html`) featuring interactive Cytoscape.js multi-hop `CareNode` topology (`static/vendor/cytoscape.min.js`), Census TIGER tract SVG choropleths (`/api/geo`), HRSA FQHC BYOD pins, and Hop-0 Gatekeeper / 48h Slot Hold modals.
- **Live SSE Streaming (`POST /run`, `POST /run_sse`, `POST /api/chat/stream` & `POST /api/chat`):** Streams real-time ADK coordinator/sub-agent delegation events (`agent_start`, `sub_agent`, `tool_call`, `tool_result`, `token`, `brief`, `done`), BigQuery execution telemetry (`job_id`, elapsed ms, bytes processed), and token deltas while synchronizing the right-hand Pathway & Network Brief.

### 3. 6-State BigQuery Property Graph, Governed MCP & Local Auth Bridge (`first_milestones/tools/`, `mcp_integration.py`, `notebooks/`)
- **Live 6-State Property Graph (`a4i_early_intervention_multistate.ReferralGraph` & `a4i_early_intervention.ReferralGraph`):**
  - Supports all 6 challenge states live in BigQuery and in the local GeoParquet mirror: **Mississippi (`MS`, FIPS `28`)**, **California (`CA`, leading-zero FIPS `'06...'`, `41,144` under-5 children across `101` tracts)**, **Alabama (`AL`, leading-zero FIPS `'01...'`)**, **Georgia (`GA`, `13`)**, **Texas (`TX`, `48`)**, and **New York (`NY`, `36`)**.
  - Preserves the shared single-state dataset `A4I_DATASET=a4i_early_intervention` untouched while automatically routing cross-state ISO/IEC 39075 GQL `GRAPH_TABLE` queries (`CareNode`, `Neighborhood`, `ReferralHandoff`, `REFERS_TO`, `CAN_REFER_TO`, `SERVES_AREA`) to `A4I_MULTISTATE_DATASET=a4i_early_intervention_multistate`.
- **4 Verified Data & Graph Rigor Guardrails (proven in `notebooks/c_ei_02_graph_and_audit.ipynb`):**
  1. **Zero-Padding FIPS Preservation:** `census_tract_geoid` (11-char `STRING`) and `county_fips` (5-char `STRING`) preserve `'01...'` (AL) and `'06...'` (CA) leading zeros end-to-end via `LPAD`.
  2. **ACS `limited_english_rate` Trap Caught:** All 426 starter ACS tracts carry `0.0` in `limited_english_rate`; excluded from formulas and replaced with `bilingual_services_listed` + statewide HRSA NSCH language strata.
  3. **Statewide-Only NSCH Grain:** `nsch_developmental_screening_survey` (`6` `'Statewide'` rows per state) is never cross-joined to tracts, preventing 6x row fan-out.
  4. **Correlated Prefix-Deduplicated GQL:** `COUNT(DISTINCT h.case_chain_id) = 1` + `QUALIFY ROW_NUMBER() OVER (PARTITION BY chain_id ORDER BY total_hops DESC) = 1` yields exact `44` complete episodes, `35` 3–4 hop chains, and `26` `>45d` statutory breaches per state.
- **Governed Google-Managed MCP Integration (`tools.yaml` + `mcp_integration.py`):** Connects to **Google MCP Toolbox for Databases** (`googleapis/mcp-toolbox` v0.27.0 via ADK `ToolboxToolset` and `agent/tools.yaml`) or **BigQuery's Built-in Remote Managed MCP Server** (`https://bigquery.googleapis.com/mcp` via ADK `McpToolset` with `GcloudCliCredentials` / Google ADC headers and unrestricted `execute_sql` strictly excluded).

### 4. REST & SSE Endpoints (`main.py`)

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | Serves built React Coordinator UI (`frontend/dist/index.html`) or Classic Workbench if `A4I_CLASSIC_WORKBENCH=1` |
| `/workbench` | `GET` | Serves Classic Cytoscape.js + TIGER Choropleth Coordinator Workbench (`agent/static/index.html`) |
| `/api/health` | `GET` | Agent/sub-agent topology, active/fallback Gemini models, MCP mode, active dataset, `bq_telemetry`, and P50/P95 latency metrics |
| `/api/brief` | `GET` | Generates Pydantic-validated `PathwayBrief` (`state`, `tract_geoid`, `age_months`, `concern_domain`, `needs_medicaid`, `needs_bilingual`, `has_household_vehicle`) |
| `/api/chat` | `POST` | Synchronous multi-turn ADK Runner chat (`message` or `prompt`, `session_id`, `state_code`), returning `reply`, `response`, `brief`, and `bq_telemetry` |
| `/run`, `/run_sse`, `/api/chat/stream` | `POST` | Server-Sent Events (`text/event-stream`) streaming sub-agent handoffs, tool calls, tokens, and updated `PathwayBrief` |
| `/api/simulate` | `POST` | Counterfactual Bounce Hub simulator (`target_provider_id`, `upgrade_fax_to_ehr`, `precheck_bilingual_and_slot_capacity`) |
| `/api/gatekeeper` | `POST` | Hop-0 IDEA Part C intake packet readiness check (`34 CFR § 303.420` consent, screening tool, 5-tier `34 CFR § 303.209` age transition ladder) |
| `/api/geo` | `GET` | Projected `1000x640` SVG Census TIGER tracts, `SYN-PROV-*` CareNodes, and public-domain HRSA FQHC BYOD sites (`state=MS\|AL\|GA\|TX\|CA\|NY`) |
| `/api/slots` | `GET` | Active 48-hour pathway slot holds and per-provider capacity utilization metrics |
| `/api/slots/reserve` | `POST` | Atomic 48-hour pathway capacity reservation across `Coordinator`, `Eval Hub`, and `Vendor` CareNodes (Firestore or SQLite WAL) |

### 5. Programmatic Guardrails, Persistent Sessions & Telemetry (`guardrails.py` + `session_store.py`)
- **Pre-Tool & Post-Model Guardrails (`first_milestones/guardrails.py`):**
  - `guardrail_before_tool_callback` blocks mutating SQL (`DROP/DELETE/UPDATE/INSERT/CREATE`) and illegal `WHERE`/`HAVING`/`ORDER BY` filtering on `audit_*` demographic shares or `limited_english_rate` (`0.0`).
  - `guardrail_after_model_callback` verifies `SYN-PROV-*` IDs against state directories (scrubbing ungrounded IDs), injects `100% [Synthetic]` + 6-row `Statewide` NSCH notices, enforces `36-month` Part B safeguards for `30–35m` toddlers (and removes spurious `36-month` headings for `<27m`), and guarantees clinical diagnosis refusal when diagnosis intent appears.
- **Persistent Session Store & Request Isolation (`session_store.py` + `bq_client.py`):** Thread-safe SQLite session persistence (`SqlitePersistentSessionService`, configurable via `A4I_SESSION_BACKEND=sqlite|memory|vertex`) plus `ContextVar` request-scoped `state_code` isolation (`4/4` concurrent `MS`+`CA` probe pass).
- **Observability & Auth (`main.py`):** In-process `_ObservabilityTracker` exposes P50/P95 latency, fallback rate, and session backend telemetry on `/api/health`; optional `A4I_REQUIRE_AUTH=1` + `A4I_AUTH_BEARER_TOKEN` bearer auth secures write/chat endpoints.

### 6. Automated Agent Evaluation Suite (`agent/eval/`)
- **Benchmark & ADK Compatibility:** `eval/golden_evalset.json` (20 golden + adversarial prompts across `MS`/`CA` and all 3 tracks) with `eval/adk_bridge.py` exporting standard Google ADK `EvalSet` JSON.
- **5 Automated Graders (`eval/graders.py`):** Tool-Trajectory Precision/Recall/F1, Numeric & Entity Faithfulness, Statutory `34 CFR § 303.310` Compliance, 4-Pillar Ethics/Rigor Guardrails, and Concurrent State Consistency (`eval/evaluate_agent.py --target live-http` or `--target local-asgi`).
- **Measured Live Cloud Run Improvement (see [`eval/EVAL_AND_PROD_READINESS.md`](eval/EVAL_AND_PROD_READINESS.md)):** Raising strict zero-tolerance case pass rate from **15.0% → 50.0% (+35.0 pp)**, mean composite from **0.8705 → 0.9289**, post-output equity audit invocation from **10.0% → 75.0%**, Track 3 Outreach to **100%**, Track 1 Routing to **80%**, and **100% (`4/4`)** concurrent multi-state isolation.

---

## Quick Start & Deployment

### 1. Provision All 6 Starter States + `ReferralGraph` in BigQuery
Load all 6 states (`MS`, `AL`, `GA`, `TX`, `CA`, `NY`) and declare `ReferralGraph` views & DDL in `a4i_early_intervention_multistate` without overwriting the shared single-state `a4i_early_intervention` dataset:
```bash
bash scripts/load_multistate.sh
# Or load a single state (or ALL) into A4I_DATASET and declare ReferralGraph:
bash scripts/load.sh MS
bash scripts/setup_graph.sh MS
```

### 2. Local `gcloud` Auth Bridge & Local Workbench (`http://localhost:8080`)
Configure live BigQuery Property Graph + Vertex AI Gemini access from a local shell authenticated via `gcloud auth login` (even before browser ADC file setup):
```bash
source scripts/setup_local_adc.sh       # exports GOOGLE_CLOUD_PROJECT, A4I_USE_GCLOUD_AUTH=1, A4I_DATASET
.venv/bin/python agent/main.py          # launches Coordinator Workbench on :8080 (/ React UI, /workbench Classic UI)
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
Enables required Cloud Run / Vertex AI / BigQuery / MCP APIs, grants least-privilege IAM roles (`bigquery.dataViewer`, `bigquery.jobUser`, `aiplatform.user`, `mcp.toolUser`, `datastore.user`), and deploys with `--min-instances=1`, `A4I_DATASET=a4i_early_intervention`, `A4I_MULTISTATE_DATASET=a4i_early_intervention_multistate`, and `A4I_SUBAGENT_MODEL=gemini-2.5-flash`.

### 4. Deploy ADK Package to Vertex AI Agent Engine (`google-adk==2.14.1`)
Validate flags, staging bucket, and agent importability first with `--dry-run`, then deploy live:
```bash
bash scripts/deploy_agent_engine.sh --dry-run
bash scripts/deploy_agent_engine.sh --project="$GOOGLE_CLOUD_PROJECT" --region=us-central1
```

### 5. Run Automated Verification & Evaluation Suites
```bash
# Run full unit & integration test suite across all 10 test modules:
.venv/bin/pytest -v

# Run 20-case automated evaluation benchmark harness (in-process ASGI or live Cloud Run):
.venv/bin/python agent/eval/evaluate_agent.py --target local-asgi --output /tmp/local_eval.json
```
