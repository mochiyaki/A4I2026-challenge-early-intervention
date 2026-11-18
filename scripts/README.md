# scripts/ — BigQuery Graph Provisioning, Local Auth, Deployment & Video Automation

Headless CLI utilities for provisioning the BigQuery Enterprise Property Graph (`ReferralGraph`), bridging local `gcloud` credentials, deploying to **Google Cloud Run** and **Vertex AI Agent Engine**, and generating the narrated `<3:00` walkthrough video.

---

## Script Inventory

| Script | Purpose |
|---|---|
| `scripts/load.sh` | Provisions the zero-baseline BigQuery Enterprise reservation (`a4i-graph`, \$0 when idle) and loads a single state (`MS`, `AL`, `GA`, `TX`, `CA`, `NY`) or all 6 states (`ALL`) into `a4i_early_intervention` with native `GEOGRAPHY` columns and zero-padded `STRING` FIPS/GEOIDs. |
| `scripts/setup_graph.sh` + `scripts/setup_graph.sql` | Runs `load.sh` (unless `--graph-only` is passed), creates the 4 helper graph views (`v_graph_neighborhoods`, `v_graph_refers_to_edges`, `v_graph_can_refer_to_edges`, `v_graph_serves_area_edges`), runs `CREATE OR REPLACE PROPERTY GRAPH <dataset>.ReferralGraph`, and executes prefix-deduplicated ISO/IEC 39075 GQL smoke tests. |
| `scripts/load_multistate.sh` | Loads all 6 states simultaneously into the dedicated `a4i_early_intervention_multistate` dataset (preserving the shared `a4i_early_intervention` dataset untouched), declares `ReferralGraph`, and verifies exact per-state chain (`44`) and breach (`26`) counts. |
| `scripts/setup_local_adc.sh` | Shell script (`source scripts/setup_local_adc.sh`) that configures environment variables and the `A4I_USE_GCLOUD_AUTH=1` token bridge so local Python processes can query BigQuery Property Graphs, BigQuery Remote MCP, and Vertex AI Gemini directly from an active `gcloud auth login` session. |
| `scripts/deploy_cloud_run.sh` | End-to-end deployment of the unified multi-stage Docker container (React Coordinator UI + Classic Cytoscape Workbench + Google MCP Toolbox v0.27.0 sidecar + FastAPI/ADK server) to Google Cloud Run (`--min-instances=1`). |
| `scripts/deploy_agent_engine.sh` | Packages and deploys `agent/first_milestones` (`root_agent`) to **Vertex AI Agent Engine** via `adk deploy agent_engine` (`google-adk==2.14.1`), supporting `--dry-run` validation. |
| `scripts/record_demo_video.py` | Automated Playwright + macOS `/usr/bin/say` + `ffmpeg` recorder that captures a live 1440×900 multi-track walkthrough of the workbench and muxes H.264 video + AAC narration into `presentation/first_milestones_demo.mp4` (`< 3:00`). |

---

## 1. Loading Data & Creating `ReferralGraph` in BigQuery

### Single-State Table Load (`scripts/load.sh`)

`load.sh` reaches the same end state as `notebooks/c_ei_01_load_explore.ipynb`: provisioning the zero-baseline Enterprise reservation (`a4i-graph`, `0` baseline slots, `50` autoscale max slots) and rebuilding all five BigQuery tables in `a4i_early_intervention` with native `GEOGRAPHY` columns (`tract_geom`, `intake_geom`, `provider_geom`) and leading-zero-safe 11-digit tract GEOIDs (`LPAD(census_tract_geoid, 11, '0')`).

```bash
bash scripts/load.sh              # loads Mississippi (MS) — default
bash scripts/load.sh AL           # Alabama (leading-zero FIPS 01)
bash scripts/load.sh CA           # California (leading-zero FIPS 06)
bash scripts/load.sh ALL          # loads all 6 starter states into a4i_early_intervention
bash scripts/load.sh --list       # show every pre-staged state
bash scripts/load.sh --help       # usage
```

### Single-State Property Graph DDL + ISO GQL Verification (`scripts/setup_graph.sh`)

```bash
bash scripts/setup_graph.sh               # runs load.sh MS + setup_graph.sql + ISO GQL smoke tests
bash scripts/setup_graph.sh CA            # runs load.sh CA + setup_graph.sql + ISO GQL smoke tests
bash scripts/setup_graph.sh --graph-only  # skips table reload and applies setup_graph.sql to existing tables
```

### Dedicated 6-State Property Graph (`scripts/load_multistate.sh`)

Loads all 6 states (`MS`, `AL`, `GA`, `TX`, `CA`, `NY`) into `a4i_early_intervention_multistate` so the live agent can switch states instantaneously without overwriting the single-state `a4i_early_intervention` dataset:

```bash
bash scripts/load_multistate.sh
```

---

## 2. Local Authentication Bridge (`scripts/setup_local_adc.sh`)

When running locally on macOS or Linux where `gcloud auth login` is active (even if `application_default_credentials.json` is not configured), source this script before starting `agent/main.py`:

```bash
source scripts/setup_local_adc.sh
.venv/bin/python agent/main.py
```

Exports:
- `GOOGLE_CLOUD_PROJECT` (detected from `gcloud config get-value project`)
- `GOOGLE_GENAI_USE_VERTEXAI=TRUE`
- `GOOGLE_CLOUD_LOCATION=us-central1`
- `A4I_USE_GCLOUD_AUTH=1` (enables `GcloudCliCredentials` in `bq_client.py` and `mcp_integration.py`)
- `A4I_DATASET=a4i_early_intervention_multistate`
- `A4I_MULTISTATE_DATASET=a4i_early_intervention_multistate`
- `A4I_LOCATION=US`
- `A4I_STATE=MS`

---

## 3. Deploying to Google Cloud

### Google Cloud Run (`scripts/deploy_cloud_run.sh`)

Enables required GCP & MCP APIs, provisions data/graph (unless `--skip-data` is passed), grants least-privilege IAM roles (`roles/bigquery.dataViewer`, `roles/bigquery.jobUser`, `roles/aiplatform.user`, `roles/mcp.toolUser`, `roles/datastore.user`), and builds/deploys from the repo root `Dockerfile`:

```bash
bash scripts/deploy_cloud_run.sh              # provisions MS + deploys Cloud Run service
bash scripts/deploy_cloud_run.sh CA           # provisions CA + deploys Cloud Run service
bash scripts/deploy_cloud_run.sh --skip-data  # code-only redeploy using existing BigQuery dataset
```

### Vertex AI Agent Engine (`scripts/deploy_agent_engine.sh`)

Validates and deploys `agent/first_milestones` (`root_agent`) to Vertex AI Agent Engine with `--otel_to_cloud` and `--extra_packages=data`:

```bash
bash scripts/deploy_agent_engine.sh --dry-run
bash scripts/deploy_agent_engine.sh --project="$GOOGLE_CLOUD_PROJECT" --region=us-central1
```

---

## 4. Recording the Narrated Demo Video (`scripts/record_demo_video.py`)

Generates the narrated 1440×900 H.264/AAC walkthrough (`presentation/first_milestones_demo.mp4`):

```bash
.venv/bin/python scripts/record_demo_video.py --help
.venv/bin/python scripts/record_demo_video.py --output presentation/first_milestones_demo.mp4
```
