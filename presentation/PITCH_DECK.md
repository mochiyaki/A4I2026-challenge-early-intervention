# First Milestones — Executive Pitch Deck & Presenter Notes

**Agents for Impact 2026 · Challenge 04: Early Intervention & Developmental Screening Triage**
**Data Provenance & Stage Safety:** `100% [Synthetic]` providers (`SYN-PROV-*`), agencies (`SYN-PARTC-*`), addresses, and referral chains (`CHAIN-*`), anchored to public US Census Bureau ACS 5-Year tracts and statewide HRSA NSCH screening strata.

---

## Slide 1 — First Milestones: Every Milestone Within 45 Days
- **Statutory Mandate:** Federal IDEA Part C (`34 CFR § 303.310`) guarantees evaluation and an initial Individualized Family Service Plan (IFSP) within **45 calendar days** of referral — before eligibility ends at **36 months**.
- **Headline Ground-Truth Metrics:**
  - **26 / 44 (`59.1%`)** complete referral chains in Mississippi breach the 45-day mandate (`40.9%` timely).
  - **75d -> 34d (`-41 days`):** Prospective routing turns a 4-hop `paper_fax` bounce into a 3-hop `ehr_electronic_portal` corridor for a 32-month toddler.
  - **229 Child-Days Saved:** Upgrading a single upstream intake hub (`SYN-PROV-MS-011`) from `paper_fax` to EHR + slot pre-check eliminates **5 / 7** statutory breaches.
  - **6 Live States (`426` ACS Tracts · `133,667` Under-5 Children):** Instant switching across `MS`, `CA` (`'06...'`), `AL` (`'01...'`), `GA`, `TX`, and `NY`.

> **Presenter Note:** Open with the human stakes: brain plasticity peaks before age 3, and federal law sets a hard 45-day clock. Yet families lose months in invisible multi-hop referral loops. Emphasize upfront that every provider (`SYN-PROV-*`) and referral chain (`CHAIN-*`) is `100% [Synthetic]`.

---

## Slide 2 — Two Unforgiving Clocks: The 45-Day Mandate & The 36-Month Cliff
- **Traced Failure (`CHAIN-MS-023`):**
  - Child profile: **32-month-old** toddler (`Social-Communication / Autism Screen`, Medicaid, Spanish-speaking household, zero vehicle).
  - 4-hop cascade: `SYN-PROV-MS-007 -> SYN-PROV-MS-011 (14d paper_fax) -> SYN-PROV-MS-015 (22d paper_fax) -> SYN-PROV-MS-019 (25d re-referral bounce) -> SYN-PROV-MS-028 (14d EHR)` = **75 calendar days**.
  - Toddler reaches therapy at **34.5 months** — leaving just **6 weeks** before aging out of IDEA Part C at 36 months.
- **Regional & Channel Gaps:**
  - Upper Delta agency `SYN-PARTC-MS-01` achieves only **52.5%** timely 45-day IFSPs (`535 / 1,020`) vs. urban comparator `SYN-PARTC-MS-03` at **65.8%** (`1,210 / 1,840`).
  - `paper_fax` averages **19.7d wait** and **24.4% family drop-off** per hop vs. **13.3d wait** and **9.9% drop-off** on `ehr_electronic_portal`.

> **Presenter Note:** Walk through `CHAIN-MS-023` hop by hop. Every single 4-hop chain in Mississippi (`26 / 26`) breaches 45 days (`72.8d` average wait).

---

## Slide 3 — Why Flat SQL & Spreadsheets Miss the #1 Hidden Bounce Hub
- **What Naive `ORDER BY active_waitlist_count DESC` Shows:**
  - Blames downstream evaluators/vendors: `SYN-PROV-MS-016` (`81` waitlist, `39d`), `SYN-PROV-MS-025` (`80` waitlist, `38d`), `SYN-PROV-MS-015` (`72` waitlist, `34d`).
  - Completely ignores Indianola intake coordinator **`SYN-PROV-MS-011`** because its internal median wait is just **5 days** (`24` active waitlist).
- **What Multi-Hop ISO GQL (`-{2,4}->`) Reveals:**
  - **`SYN-PROV-MS-011`** is the **#1 Hidden Bounce Hub**: **7 / 11 (`63.6%`)** of episodes routed through it breach 45 days (`56.8d` mean episode wait, **198 excess days** over 45) because it dispatches `paper_fax` referrals without pre-checking downstream bilingual and Medicaid slot availability.

> **Presenter Note:** This is the core reason a Property Graph is essential. Single-table SQL sees a 5-day internal wait; ISO GQL sees 198 excess days downstream.

---

## Slide 4 — Cloud-Native Multi-Agent ADK + Managed MCP + Property Graph Architecture
- **Root Orchestrator (`first_milestones_coordinator`):** Gemini Pro / Argon with statutory `34 CFR § 303.310`, 36m cliff, zero-race routing, `guardrails.py` callbacks, and `schemas.py` Pydantic Brief validation.
- **3 Domain Sub-Agents (`gemini-2.5-flash`):**
  1. `triage_pathway_router` — Prospective `<=45d` ISO GQL + `ST_DISTANCE` routing.
  2. `network_bottleneck_auditor` — Correlated `-{2,4}->` bounce detection + counterfactual simulator.
  3. `equity_and_caregiver_specialist` — Hidden EI Deserts, post-output `audit_*` checks, and EN/ES caregiver notes.
- **Google-Managed MCP & Data Plane:** Google MCP Toolbox (`v0.27.0`) + BigQuery Remote MCP (`bigquery.googleapis.com/mcp`) over `a4i_early_intervention.ReferralGraph` and `a4i_early_intervention_multistate.ReferralGraph`.
- **Dual Production Surface:** Cloud Run (`--min-instances=1`, FastAPI SSE `/run` + Cytoscape.js UI) and Vertex AI Agent Engine (`google-adk==2.14.1`).

> **Presenter Note:** Highlight how Gemini Pro/Argon coordinates three fast `gemini-2.5-flash` specialists while streaming live tool traces to the Split-Pane Workbench.

---

## Slide 5 — Track 1: Turning a 75-Day Fax Loop into a 34-Day Electronic Corridor
- **Child Case (`28027950700`, Coahoma County, MS):** 32m toddler, Autism Screen, Medicaid, Spanish-speaking family, zero household vehicle (`57.8%` tract poverty, `20.3%` zero-vehicle).
- **Verified `<=45`-Day Corridor (`34 days`, `+11d` statutory buffer):**
  - Hop 1 (Day 6): `SYN-PROV-MS-007 -> SYN-PROV-MS-011` (`ehr_electronic_portal`)
  - Hop 2 (Day 20): `SYN-PROV-MS-011 -> SYN-PROV-MS-019` (Bilingual Medicaid Eval Hub, `+14d`)
  - Hop 3 (Day 34): `SYN-PROV-MS-019 -> SYN-PROV-MS-028` (Bilingual Medicaid Therapy Vendor, `+14d`)
  - IFSP begins at **33.1 months** (vs. `34.5m`), with automatic **Medicaid NEMT ride / mobile visit** and **English / Español** Caregiver Action Note.

> **Presenter Note:** Show how clinical routing and compassionate family communication happen in one step, in both English and Spanish.

---

## Slide 6 — Track 2: Correlated ISO GQL Audit & Counterfactual Simulator
- **Episode Depth Breakdown (`44` MS Chains):**
  - `2 hops`: `9` episodes · `20.4d` mean wait · `0 / 9` breaches
  - `3 hops`: `9` episodes · `38.4d` mean wait · `0 / 9` breaches
  - `4 hops`: `26` episodes · `72.8d` mean wait · **`26 / 26` (`100%`) breaches**
- **Single-Hub Counterfactual (`SYN-PROV-MS-011` -> EHR + Bilingual/Medicaid Pre-Check):**
  - Breaches drop from **`7 -> 2`** (`5` breaches eliminated, `-71%`).
  - Mean wait drops from **`56.8d -> 36.0d`**, saving **229 delayed child-days** (`CHAIN-MS-023` drops **`75d -> 38d`**, saving `37` days).

> **Presenter Note:** State Part C directors have tight budgets. Our counterfactual simulator proves exact child-days saved before spending a dollar.

---

## Slide 7 — Track 3: Uncovering 21 Hidden EI Deserts & Post-Output Equity Audit
- **Hidden EI Deserts (`21` MS Tracts):**
  - `28011950100` (Bolivar, `254` under-5, `46.8%` poverty, `17.2%` zero-vehicle): clinic **2.1 km** away, yet **0** reachable `<=45d` Medicaid + bilingual pathways within `25 km`.
  - `28011950200` (Bolivar, `1.3 km` to clinic, `0` paths) & `28133950100` (Sunflower, `1.4 km` to clinic, `0` paths).
- **Post-Output Neighborhood Equity Audit (`audit_*` joined strictly *after* routing):**
  - `26` Breached (`>45d`): `72.8d` wait · `31.1%` poverty · `11.9%` zero-vehicle (`75.5%` Black / `1.6%` Hispanic / `21.8%` White neighborhood context).
  - `18` Timely (`<=45d`): `29.4d` wait · `31.5%` poverty · `10.5%` zero-vehicle.
  - Coahoma `28027950100` faces a **222.6 km** trip to the nearest bilingual Medicaid evaluation hub; statewide MS NSCH shows `12.3%` screening in `<100% FPL` non-English homes vs. `33.0%` in `>=400% FPL` English homes.

> **Presenter Note:** Point out why flat clinic-distance maps deceive planners: a clinic 1.3 km away does not help if zero compliant downstream therapy paths exist.

---

## Slide 8 — Verified Data & Graph Rigor: 4 Subtle Evaluation Traps Defeated
1. **Leading-Zero FIPS String Integrity:** Preserves `11`-char `census_tract_geoid` & `5`-char `county_fips` across **California (`'06...'`, `101` tracts, `41,144` under-5 children)** and **Alabama (`'01...'`, `43` tracts, `9,396` under-5 children)**.
2. **All-Zero ACS `limited_english_rate` Trap:** Caught `0.0` across `426 / 426` tracts; excluded from formulas and replaced with `bilingual_services_listed` + statewide HRSA NSCH strata.
3. **Statewide-Only NSCH Grain:** `6` statewide rows per state (`36` total) never cross-joined onto tracts (zero 6x fan-out).
4. **Correlated Prefix-Deduplicated GQL:** `COUNT(DISTINCT h.case_chain_id) = 1` + `QUALIFY ROW_NUMBER() ... ORDER BY total_hops DESC = 1` prevents stitching unrelated hops or double-counting 3-hop Type B prefixes.

> **Presenter Note:** Data rigor builds trust in government AI. Every single trap is guarded by automated regression tests.

---

## Slide 9 — Instant 6-State Portability & Responsible AI Charter
- **6-State Property Graph (`426` Tracts · `133,667` Under-5 · `180` `[Synthetic]` CareNodes · `264` Chains):**
  - `MS` (`28`, `64` tracts, `15,512` `<5`), `CA` (`06`, `101` tracts, `41,144` `<5`), `AL` (`01`, `43` tracts, `9,396` `<5`), `GA` (`13`, `57` tracts, `14,505` `<5`), `TX` (`48`, `72` tracts, `29,599` `<5`), `NY` (`36`, `89` tracts, `23,511` `<5`).
  - In California (`'06...'`), upgrading `SYN-PROV-CA-011` (`5d` flat wait, `7/11` breaches) eliminates **7 / 7 breaches** and saves **223 child-days**.
- **Ethics Charter:** `100% [Synthetic]` organizational nodes, zero race inputs in routing, non-diagnostic coordinator copilot, human-in-the-loop review.

> **Presenter Note:** Demonstrate national scalability while proving leading-zero `'06...'` and `'01...'` FIPS preservation live.

---

## Slide 10 — Production Deployment & Public-Sector Impact
- **Cloud Run (`scripts/deploy_cloud_run.sh`):** Unified MCP Toolbox `v0.27.0` + ADK Multi-Agent + Split-Pane Cytoscape Workbench (`--min-instances=1`).
- **Vertex AI Agent Engine (`scripts/deploy_agent_engine.sh`):** Validated `google-adk==2.14.1` deployment with GCS artifact bucket and OpenTelemetry tracing.
- **Impact Bottom Line:** `-41 days` faster triage for 32m toddlers, `229` child-days saved per upgraded hub, `21` Hidden EI Deserts surfaced, and instant **English + Español** family action plans.

> **Presenter Note:** Close on the mission: helping state coordinators turn statutory 45-day mandates into reality during the brain's fastest window of growth.
