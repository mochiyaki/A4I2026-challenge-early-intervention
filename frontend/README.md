# First Milestones · California (`CA`) Early Start 45-Day Triage UI

Custom React + Vite + TypeScript + Tailwind CSS frontend built for **Track 1: Today's Toddler Referral** in **California (`CA`, FIPS `'06'`)**.

## Why a Custom Web UI?

Our target user is a **Regional IDEA Part C (California Early Start) Intake & Quality Coordinator** triaging an active referral—such as a **20-month-old needing a Spanish-bilingual developmental evaluation under Medi-Cal**—before the federal **45-day statutory IFSP clock (`34 CFR § 303.310`)** expires.

Prose chat alone hides multi-hop cumulative wait budgets. Rendering the **4-hop 72-day paper-fax bounce chain collapsing into a 35-day electronic portal route** side-by-side against the Day-45 statutory deadline lets a coordinator verify Medi-Cal, bilingual capability, travel distance (`ST_DISTANCE`), zero-vehicle NEMT/tele-eval guardrails, and the 36-month Part C aging-out cliff in seconds.

## Quick Start

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## Connecting Your Live ADK / Cloud Run Agent

1. Start your Python ADK backend with CORS enabled:
   ```bash
   adk api_server --allow_origins="*" --port=8000
   ```
   *(Or deploy your ADK / FastAPI service to Cloud Run and copy the `https://*.run.app` URL.)*
2. Click **"Ask ADK Agent"** -> **"Endpoint"** in the top-right header of the UI.
3. Switch from **Local CA Graph** to **Live ADK / Cloud Run** and paste your URL. If the remote endpoint is offline during development, the client gracefully falls back to the pre-loaded California starter dataset (`src/data/caData.json`, extracted from `../data/*.parquet`).

## Built-In Rigor & Data Guardrails

- **100% `[Synthetic]` Provider & Referral Provenance:** Prominently badged across the UI (`SYN-PROV-CA-*`, `SYN-PARTC-CA-*`).
- **Leading-Zero FIPS Preserved:** All 101 California `census_tract_geoid` values remain 11-character `'06...'` strings.
- **Data Traps Caught:** Excludes the all-zero `limited_english_rate` ACS column and prevents 6× statewide fan-out on `nsch_developmental_screening_survey`.
- **Post-Output Equity Audit:** `audit_*` demographic columns have **0% weight** in pathway ranking and are joined strictly post-output.
