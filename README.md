# Early Intervention & Developmental Screening Triage ("First Milestones")

**Agents for Impact 2026**

---

## Why this one matters

Federal law gives states **forty-five calendar days** from the moment an infant or toddler is referred for a developmental concern to deliver an evaluation and an initial Individualized Family Service Plan (IFSP). Under Part C of the Individuals with Disabilities Education Act (IDEA), that clock exists because speech, motor, or autism intervention at twenty months changes a child's developmental trajectory far more than starting the same support in kindergarten.

Yet across rural and high-poverty regions, thousands of two-year-olds blow past day forty-five without ever seeing an evaluator. When regional coordinators inspect a flat provider spreadsheet, the problem hides in plain sight: a pediatric screening clinic refers a toddler to an intake hub whose internal wait time looks healthy (five days), which faxes the packet to a backlogged evaluation hub, which bounces the family a third time when Spanish-language or Medicaid credentials are missing. By hop three, seventy days have vanished.

This is a **multi-hop network routing and bottleneck problem under a federal statutory clock**. A flat SQL sort points at whichever downstream clinic has the longest waitlist today. Only traversing the referral graph exposes the low-wait intake hub whose paper-fax handoffs silently trigger multi-hop breaches across an entire region.

**Your job today is to build the triage and network-audit assistant that finds a <=45-day pathway for today's child and exposes the multi-hop bounce hubs breaking the clock.**

You will build it for **one state**, chosen by your team a few sections down.

---

## How to read this

**This is a reference for your whole afternoon, not something to read end to end right now.** Here is what each lane needs in the first fifteen minutes.

| If you are... | Read now | Come back for |
|---|---|---|
| **Everyone, together** | [The four things](#the-four-things-youre-working-with) · [Three tracks](#three-tracks-one-architecture) · [What you're building](#what-youre-building) · [Now pick your state](#now-pick-your-state) | Agree on these before anyone opens a keyboard |
| **Team lead** | [Step 0](#step-0-organize-your-team) · [How you'll be judged](#how-youll-be-judged) | [Going further](#going-further) (read it *before* writing code, not right before the demo) |
| **Data lane** | [Step 4, load the data](#step-4-load-the-data) · [What you'll have](#what-youll-have) | [The data, and why we chose it](#the-data-and-why-we-chose-it) · Section 13 of the notebook |
| **Agent lane** | [What you're building](#what-youre-building) · [The technology](#the-technology-youll-use) | [`agent/README.md`](agent/README.md) · [Questions that need more than we gave you](#questions-that-need-more-than-we-gave-you) |
| **Front end lane** | [Front end lane](#front-end-lane-2-people) | [Your output artifact](#your-output-artifact-the-45-day-pathway--bottleneck-brief) |
| **Story lane** | [Your output artifact](#your-output-artifact-the-45-day-pathway--bottleneck-brief) | [The data](#the-data-and-why-we-chose-it) (know why providers & logs are 100% synthetic, because judges check) |

**Four things everybody should know by the end of hour one**, whatever lane you are in:

1. **Every provider, agency, and referral row is 100% `[Synthetic]` on purpose.** Under-five neighborhood counts (`acs_under5_tract_demographics`) are real US Census ACS data, and `nsch_developmental_screening_survey` is calibrated to statewide HRSA NSCH totals, while `pediatric_and_ei_provider_directory` (`SYN-PROV-*`), `idea_part_c_agency_performance` (`SYN-PARTC-*`), and `deidentified_part_c_referral_logs` use fictional organizations so fabricated waitlists or 45-day statutory violations are never attached to real clinicians. State this plainly in your deck and video.
2. **BigQuery Graph requires the zero-baseline Enterprise reservation (`a4i-graph`).** Both `notebooks/c_ei_01_load_explore.ipynb` (Section 1b) and `scripts/load.sh` create and assign this automatically (`0` baseline slots, autoscale to `50`). Do not skip it.
3. **Watch two planted data traps:** `limited_english_rate` in `acs_under5_tract_demographics` is `0.0` across this ACS extract (use `primary_home_language` and `bilingual_services_listed` instead), and `nsch_developmental_screening_survey` is strictly **statewide** (`6` strata per state, so joining on `state_code` alone duplicates tracts 6x).
4. **Correlate `case_chain_id` across variable-length graph hops.** In ISO GQL (`-{2,4}->`), always correlate `case_chain_id` across hops so Child A's inbound referral is not stitched to Child B's outbound referral through the same coordinator.

---

## The four things you're working with

| Term | What it means |
|---|---|
| **`CareNode`** | One organizational vertex in `pediatric_and_ei_provider_directory` (`Screening_Pediatric_Clinic`, `Part_C_Intake_Coordinator`, `Multidisciplinary_Eval_Hub`, or `EI_Therapy_Vendor`), carrying waitlists, internal wait days, Medicaid enrollment, and bilingual capability |
| **`ReferralHandoff`** | One directed edge in `deidentified_part_c_referral_logs`, linking `source_provider_id` to `target_provider_id` along a toddler's `case_chain_id` (`hop_sequence` 1 through 4, `transmission_channel`, `handoff_wait_days`) |
| **Bounce Hub** | An intermediary `CareNode` whose own internal wait looks modest in a flat table, yet whose `paper_fax` or mismatched handoffs repeatedly trigger 3-to-4-hop re-referral chains exceeding the 45-day federal IDEA Part C limit |
| **45-Day Pathway & Bottleneck Brief** | A traced multi-hop graph diagnosis paired with a compliant <=45-day provider sequence for an incoming child, the regional hub intervention that saves the most child-days, Equity Audit findings, and a caregiver action note |

---

## Three tracks, one architecture

Every team shares the same spine: one BigQuery Property Graph (`a4i_early_intervention.ReferralGraph`) declared in ISO GQL, variable-length `-{2,4}->` path traversals, census-tract neighborhood context, and an ADK triage agent. **What changes between tracks is the coordinator's question, not the graph.**

**These are starting points, not a cage.** Pick one, combine two, or define a sharper IDEA Part C early-childhood triage workflow in the same vein if you can defend why it matters.

| Track | What arrives | Primary user action | What makes it hard |
|---|---|---|---|
| 🧭 **Today's toddler referral** | A 20-month-old from a specific census tract needs Medicaid-accepted, Spanish-bilingual speech/autism evaluation under the 45-day clock | Intake coordinator routing an active case | Avoiding routing through historically bouncing edges while respecting travel distance (`ST_DISTANCE`), Medicaid acceptance, and bilingual availability |
| 🕸️ **This quarter's network audit** | Regional IDEA Part C quality lead investigating why 45-day timely IFSP compliance dropped below 60% | Fixing systemic re-referral bottlenecks (replacing `paper_fax` intake links or adding bilingual eval slots) | Distinguishing downstream queue symptoms (`active_waitlist_count = 75`) from upstream routing hubs that cause 3-to-4-hop re-referrals |
| 📋 **This community screening season** | Early-childhood coalition placing mobile developmental screening days across underserved neighborhoods | Prioritizing under-5 high-poverty, zero-vehicle tracts with clear downstream <=45-day referral capacity | Screening toddlers without verifying a working <=45-day evaluation pathway creates waitlists rather than services |

---

## What you're building

**An Early Intervention triage and network-audit assistant.** Not a static provider directory, and not a flat SQL join disguised as graph language, but a conversational ADK agent an IDEA Part C coordinator can work with live.

Picture a Thursday afternoon at a regional Part C intake hub:

> **3:15pm, Thursday.** A rural pediatric clinic refers a 22-month-old toddler with speech-delay concerns. The family speaks Spanish at home, relies on Medicaid, has no household vehicle, and lives in a high-poverty tract where regional 45-day IFSP compliance has slipped to 53%.

Over the next thirty minutes the coordinator asks your agent:

| What they ask | What answers it |
|---|---|
| *"Trace the 3-to-4-hop referral chains in our state that breached the 45-day IDEA Part C limit. Where are cases actually bouncing?"* | Variable-length ISO GQL `GRAPH ... MATCH (a:CareNode)-[hops:ReferralHandoff]->{2,4}(b:CareNode)` correlated on `case_chain_id` |
| *"Why does Coordinator Hub 012 look healthy in a spreadsheet yet appear in nine breached 45-day episodes?"* | Comparing flat `median_internal_wait_days` (`5` to `6` days) against downstream `paper_fax` and `missing_bilingual_evaluator` bounce paths |
| *"Which valid Clinic -> Coordinator -> Eval Hub -> Therapy Vendor pathway clears 45 days for a Medicaid, Spanish-speaking family near this tract?"* | Multi-hop graph candidate traversal filtered on `accepts_medicaid = TRUE`, `bilingual_services_listed = TRUE`, `part_c_vendor_enrolled = TRUE`, and spatial distance |
| *"If we upgrade one intake hub from paper fax to electronic e-referral or fund one bilingual evaluator, which node saves the most delayed child-days?"* | Counterfactual path aggregation over traversed `ReferralHandoff` chains |
| *"Why didn't you filter tracts using `limited_english_rate` in the ACS table?"* | Catching the all-zero `limited_english_rate` column trap in validation and using `nsch_developmental_screening_survey` + `bilingual_services_listed` honestly |
| *"Which neighborhoods bear the brunt of >45-day breaches in our state?"* | Post-output Equity Audit joining `child_home_tract_geoid` to `acs_under5_tract_demographics` (`audit_*` shares, poverty, zero-vehicle rates) |
| *"Write a plain-language caregiver action note (in English and Spanish) confirming each step and expected timeline."* | Gemini translating the chosen <=45-day pathway into respectful family communication |

### Questions that need more than we gave you

| The question | What you'd need to add |
|---|---|
| *"Can a zero-vehicle caregiver reach the evaluation hub by public bus?"* | Google Maps transit routing or public GTFS feeds |
| *"Where are licensed Head Start or WIC sites located for community screening days?"* | Federal Head Start / state WIC public directories (verify [BYOD license rules](#bringing-your-own-data) first) |
| *"Reserve an evaluation slot in real time so two coordinators don't double-book"* | Transactional state in Firestore, AlloyDB, or Cloud SQL |

---

## Now pick your state

Every state below carries **30 synthetic `CareNode` organizations** and **149 directed `ReferralHandoff` edges** across **44 child referral chains** (`35` multi-hop chains of `3` to `4` hops, with `26` breaching the `45`-day federal limit), anchored to real US Census tracts:

| State | `FIPS` | Tracts | Children under 5 | Regional 45-day IFSP range | `CareNode`s | Referral chains (`3+` hops / `>45d`) |
|---|---|---:|---:|---|---:|---|
| **MS** *(default)* | `28` | 64 | 15,512 | `52.5%` to `65.8%` | 30 | 44 (`35` / `26`) |
| **AL** | `01` | 43 | 9,396 | `54.5%` to `71.6%` | 30 | 44 (`35` / `26`) |
| **GA** | `13` | 57 | 14,505 | `56.4%` to `70.7%` | 30 | 44 (`35` / `26`) |
| **TX** | `48` | 72 | 29,599 | `57.6%` to `70.9%` | 30 | 44 (`35` / `26`) |
| **CA** | `06` | 101 | 41,144 | `61.7%` to `74.9%` | 30 | 44 (`35` / `26`) |
| **NY** | `36` | 89 | 23,511 | `55.2%` to `58.3%` | 30 | 44 (`35` / `26`) |

Keep two state nuances in mind:
1. **Leading-zero FIPS (`AL` = `01`, `CA` = `06`):** Keep `census_tract_geoid` (11 chars), `child_home_tract_geoid` (11 chars), and `county_fips` (5 chars) as `STRING` everywhere.
2. **Rural vs. urban strain:** Mississippi (`MS`) exhibits the steepest rural Delta compliance deficit (`52.5%`), while California (`CA`, `41,144` children under 5 across `101` tracts) and New York (`NY`, where urban Bronx catch-up strain rivals rural northern counties) let you test high-volume triage trade-offs.

Write down your state, your track, and your scenario before writing code:

> *"We coordinate IDEA Part C Early Intervention in ______. When ______ arrives, flat waitlists hide ______ across multi-hop referrals. Here is the <=45-day route our graph finds, and here is the regional bounce hub we fix first."*

---

## The technology you'll use

| Component | Role |
|---|---|
| **ADK** (Agent Development Kit) | Build your agent in Python with ADK |
| **Gemini** | Reasoning over multi-hop graph paths, counterfactual fixes, and bilingual caregiver communications |
| **BigQuery** | Hosts `a4i_early_intervention` and executes ISO GQL queries over `ReferralGraph` |
| **A Google-managed MCP server** | Consume at least one (BigQuery built-in MCP server or MCP Toolbox for Databases) |
| **At least one tool you built** | A Python function tool or custom MCP Toolbox tool executing multi-hop ISO GQL `GRAPH` queries |
| **Deployed to Google Cloud** | Live service running on **Agent Runtime** or **Cloud Run** |

**Also already set up for you, and worth ten seconds now rather than later: Antigravity.** Your Google Skills lab environment includes a button that launches the **Antigravity IDE**, and the **Antigravity CLI** is one word away in Cloud Shell (`agy`). Neither is required, and nothing here depends on them, so do not lose time fighting one if it is not helping, though we strongly recommend using at least one because every lane has tedious boilerplate a coding agent will happily absorb. [Details in Step 3](#strongly-recommended-antigravity-the-ide-and-the-cli).

### Choosing your MCP server

Use **BigQuery's built-in MCP server** or **[MCP Toolbox for Databases](https://github.com/googleapis/mcp-toolbox)** (if deploying Toolbox on Cloud Run, set `--min-instances=1` to eliminate cold starts during your recorded walkthrough).

### What "a tool you built" means, and why we ask

Your team must author at least one custom tool (Python function tool or parameterized MCP Toolbox tool) that executes real multi-hop graph analysis and applies routing constraints (45-day cumulative wait budget, Medicaid/Part C vendor status, bilingual capability, and tract proximity).

### And one required differentiator: **BigQuery Property Graphs (`CREATE PROPERTY GRAPH` + ISO `GQL`)**

Why a property graph is essential here rather than decorative:
- A fixed single-hop lookup is just a `JOIN`. Real IDEA Part C breakdowns vary between `2`, `3`, and `4` hops as packets bounce across screening clinics, intake coordinators, evaluation hubs, and therapy vendors.
- BigQuery implements **ISO/IEC 39075 GQL** (not Neo4j Cypher). Remember three syntax rules documented in Section 13 of [`notebooks/c_ei_01_load_explore.ipynb`](notebooks/c_ei_01_load_explore.ipynb):
  1. Ensure your project is assigned to the zero-baseline Enterprise reservation (`a4i-graph`, handled automatically by Section 1b and `scripts/load.sh`).
  2. Exclude `GEOGRAPHY` columns from graph properties (`PROPERTIES ALL COLUMNS EXCEPT (provider_geom)`).
  3. Correlate `case_chain_id` across every hop in variable-length patterns (`-{2,4}->`) and use GQL `LET` + `FILTER` (never SQL `HAVING` inside a `GRAPH` block).

---

## Getting started

### Step 0: Organize your team

1. **Pick a team lead** and **a repo owner**.
2. **Choose your state and track** in five minutes.
3. **Split into four parallel lanes:**

#### Data lane (2 to 3 people)

- Run `notebooks/c_ei_01_load_explore.ipynb` (or `bash scripts/load.sh <STATE>`) to provision the `a4i-graph` Enterprise reservation and load all five tables into `a4i_early_intervention`.
- Run `CREATE OR REPLACE PROPERTY GRAPH a4i_early_intervention.ReferralGraph` (`Section 13`) and verify variable-length `-{2,4}->` GQL queries for both historical breach diagnosis and prospective <=45-day routing.
- Document the two data traps (`limited_english_rate = 0.0` in ACS and the 6x statewide grain on `nsch_developmental_screening_survey`).
- Run the post-output **Equity Audit** (`Section 11`) joining `child_home_tract_geoid` to `audit_*` demographic shares.

#### Agent lane (2 to 3 people)

- Build your Python ADK agent in `agent/` wired to a Google-managed MCP server and your custom ISO GQL graph tools.
- Make sure the agent explicitly refuses paths that breach 45 cumulative days or lack required Medicaid/language capabilities when a compliant path exists, or escalates honestly when no local path clears 45 days without transport support.
- Deploy early to **Cloud Run** or **Agent Runtime**.

#### Front end lane (2 people)

Three routes. **Pick deliberately and be ready to say why**, because your interface choice tells judges who you think the user is.

| Option | Strength | Trade-off |
|---|---|---|
| **`adk web`** | Fastest. Built in, works immediately, and where you should start | Developer tool look and feel. Fine while building, weak as a final product story unless justified |
| **Gemini Enterprise** | Clean internal staff UX over Agent Runtime with minimal front-end code | Serves **internal** staff rather than the public (which fits a regional IDEA Part C coordinator persona well if stated on purpose) |
| **Custom web UI** | Full control: visually rendering the multi-hop referral path and cumulative 45-day clock beats prose alone | Most work by far. Scope tightly so it finishes on time |

- **Do not wait for a working agent.** Mock the response schema now, build against it, and swap in the live endpoint once the agent lane deploys.
- **Whatever you build, the recorded demo runs on it.** Test it end to end before recording.

#### Story lane (1 to 2 people, starting at minute zero)

Upload **four required artifacts** to https://portal.angelhack.com/a4i-console before deadline:

1. **Public GitHub repository link**
2. **Google Skills project link** (with live deployed agent)
3. **Pitch deck** (problem, chosen state & track, visual multi-hop graph findings, explicit statement that providers/logs are 100% synthetic, `audit_*` Equity Audit numbers, and limitations)
4. **Pitch video (maximum 3 minutes)**: narrated screen-share walkthrough of a live run of your deployed agent

Judges grade asynchronously from those four artifacts with no live table Q&A.

### Your output artifact: the 45-Day Pathway & Bottleneck Brief

Your agent should produce a concrete brief an Early Intervention coordinator can act on immediately:

- **Visual or explicitly traced multi-hop path** (`Hop 1 -> Hop 2 -> Hop 3`, transmission channel, wait days at each step, and cumulative total against the 45-day IDEA Part C ceiling)
- **Recommended <=45-day provider sequence** for an incoming referral (verifying Medicaid, Part C vendor status, bilingual match, and distance)
- **Top regional bounce hub diagnosis** (why flat waitlist sorting missed it, and how many breached cases pass through it)
- **Post-output Equity Audit summary** showing which neighborhoods experience multi-hop >45-day breaches
- **Plain-language caregiver action note** explaining next steps without bureaucratic jargon

### Step 1: Create the team repository

**Repo owner only.**

1. At the top of this page, click the green **Use this template** button -> **Create a new repository**. *(No button? Use **Fork** and tell a coach.)*
2. Name it after your team, choose **Public**, and click **Create repository**.
3. Go to **Settings -> Collaborators** and add every teammate's GitHub username.
4. Paste the repo URL where everyone on your team can see it.

### Step 2: Get into your Google Cloud project

Follow your facilitator's instructions to open your shared Google Skills project. **There is one project per team.** You all share Owner access and see the same BigQuery datasets. Remember that reservation assignment (`a4i-graph`) applies at the project level (`region-us`) and takes roughly 60 seconds after creation to propagate.

### Step 3: Everyone: get into Cloud Shell

**Cloud Shell is where you will work** (alongside your preconfigured Antigravity workstation if provided at your venue). It already has `gcloud`, `bq`, Python, Node, `git`, Docker, and the Antigravity CLI (`agy`) installed.

1. In the Google Cloud console, click the **terminal icon (`>_`) in the top right** so Cloud Shell opens attached to *this* project and browser session.
2. Clone your team's repository and enter it:

   ```bash
   git clone https://github.com/YOUR-TEAM/YOUR-REPO.git
   cd YOUR-REPO
   ```

3. Open the repository as a workspace in Cloud Shell Editor:

   ```bash
   cloudshell workspace .
   ```

#### One repo, one branch per lane

Eight to ten people committing straight to `main` will collide right before submission. Create a branch per lane from minute one:

```bash
git checkout -b data        # or agent, frontend, story
```

Merge into `main` whenever your lane has something another lane needs (such as your ISO GQL `GRAPH` queries or the deployed agent URL). Keep your files inside `$HOME` (your cloned repo), because `$HOME` persists across Cloud Shell restarts while directories outside it do not.

Helpful references:
[Using Cloud Shell](https://docs.cloud.google.com/shell/docs/using-cloud-shell)
·
[Cloud Shell Editor overview](https://docs.cloud.google.com/shell/docs/editor-overview)

#### Strongly recommended: Antigravity, the IDE and the CLI

Antigravity is Google's agentic coding environment, already available in two forms:

- **The Antigravity IDE:** Launched from the button in your Google Skills lab environment. It reads your repository, proposes multi-file edits you review before accepting, runs terminal commands, and tests in a browser.
- **The Antigravity CLI (`agy`):** Preinstalled in Cloud Shell with zero setup:

  ```bash
  agy
  ```

  Where it saves the most time in a 4.5-hour sprint:
  - **Agent lane:** scaffolding ADK boilerplate, wrapping your `GRAPH ... MATCH` queries inside Python tools, and drafting Cloud Run deployment configs.
  - **Data lane:** iterating on ISO GQL syntax (`LET`, `FILTER`, `NEXT`, `case_chain_id` correlation) and post-output Equity Audit SQL.
  - **Anyone stuck on an error:** paste the traceback and let it inspect your actual files. Use `/diff` to review pending edits before accepting and `/permissions` to control autonomy.

[Antigravity: getting started](https://antigravity.google/docs/getting-started)
·
[IDE overview](https://antigravity.google/docs/ide/overview/)
·
[CLI install and auth](https://antigravity.google/docs/cli/install)
·
[CLI hands-on codelab](https://codelabs.developers.google.com/antigravity-cli-hands-on)

### Step 4: Load the data

**Data lane's job.** One person runs it while the other lanes start immediately.

1. In the Google Cloud console, search for **Colab Enterprise** and open it.
2. **You will be prompted to enable required APIs. Accept them.** When the Colab Enterprise home page loads, it often displays a *second* **Enable APIs** banner at the top. Click that too. Seeing two prompts on a fresh project is expected.
3. Go to **My Notebooks** -> **Import** -> source **URL**, and paste this raw notebook URL:

   ```text
   https://raw.githubusercontent.com/Bornism/A4I2026-challenge-early-intervention/main/notebooks/c_ei_01_load_explore.ipynb
   ```

   *(If your team modifies the notebook later, get your own copy's raw URL by opening the file on GitHub and clicking **Raw**.)*
4. Click **Import**, open the notebook, set `STATE` (`MS`, `AL`, `GA`, `TX`, `CA`, or `NY`) in the first code cell, and run the cells top to bottom. Section 1b automatically enables the Reservation API if needed and sets up the `a4i-graph` Enterprise reservation, Section 2 proves why flat waitlist sorting misses coordinator fax bottlenecks, Sections 4 and 5 expose the ACS zero-column and NSCH 6x grain traps, and Section 12 runs 28 foreign-key and graph integrity checks.

**Headless CLI Fallback (`scripts/load.sh`):**
If Colab Enterprise is slow or unavailable, run the headless loader from your cloned repository root in Cloud Shell:

```bash
bash scripts/load.sh                 # defaults to MS (Mississippi)
bash scripts/load.sh CA              # or AL, GA, TX, NY
bash scripts/load.sh --list          # list all six pre-staged states
```

Invoke it with `bash` rather than `./scripts/load.sh` so file permissions never block you. Every run replaces tables cleanly (`--replace`), so switching states or re-running is completely safe.

### What you'll have

Five validated tables in `<your-project>.a4i_early_intervention` for your selected state (all inside one dataset, ready for `CREATE PROPERTY GRAPH`, with default `MS` counts shown alongside the 6-state starter pack total):

| Table | Grain | Loaded rows (`MS` default) | 6-state pack total | Provenance summary |
|---|---|---:|---:|---|
| `acs_under5_tract_demographics` | 1 row / census tract | 64 | 426 | **Real public** US Census ACS under-5 counts, poverty, zero-vehicle, TIGER polygons & `audit_*` shares (`limited_english_rate` is `0.0`) |
| `nsch_developmental_screening_survey` | 1 row / state income-language stratum | 6 | 36 | **Modeled state-level only** (`geographic_level = 'Statewide'`), calibrated to HRSA NSCH NPM-6 totals |
| `idea_part_c_agency_performance` | 1 row / synthetic regional hub | 3 | 18 | **100% `[Synthetic]`** regional Part C lead agencies calibrated to OSEP 45-day IFSP state reports |
| `pediatric_and_ei_provider_directory` | 1 row / `CareNode` vertex | 30 | 180 | **100% `[Synthetic]`** clinics, coordinators, eval hubs & therapy vendors (`SYN-PROV-*`, zero real clinicians) |
| `deidentified_part_c_referral_logs` | 1 row / `ReferralHandoff` edge | 149 | 894 | **100% `[Synthetic]`** variable-length (`2` to `4` hop) referral & re-referral chains (`44` chains/state) |

---

## The data, and why we chose it

- **Why the provider network and referral logs are 100% synthetic:** Putting generated waitlists, paper-fax bottlenecks, and blown 45-day federal statutory deadlines onto real pediatricians or real clinic street addresses from NPPES would defame real clinicians on a public stage. Every organization in `pediatric_and_ei_provider_directory` (`SYN-PROV-*`) and `idea_part_c_agency_performance` (`SYN-PARTC-*`) is fictional, anchored spatially to real US Census tracts (`acs_under5_tract_demographics`) and calibrated to real federal OSEP state compliance rates.
- **Why NSCH is state-level only:** HRSA's National Survey of Children's Health does not publish county or census-tract rates. Never present `standardized_screening_rate_pct` as a neighborhood measurement, and never join it to tracts on `state_code` without filtering or aggregating its 6 strata first.

### One thing we deliberately excluded from routing

Never use `audit_black_share`, `audit_hispanic_share`, `audit_asian_share`, `audit_indigenous_share`, or `audit_white_share` inside routing priority rules. Route strictly on clinical urgency, cumulative wait days, Medicaid/vendor eligibility, language service match, and travel distance, then join `audit_*` afterward to audit equity impacts.

### What "auditing the outcome" actually means

1. Trace which `case_chain_id` episodes in your state breached 45 days (and compare against your agent's re-routed pathways).
2. Join `child_home_tract_geoid` to `acs_under5_tract_demographics` (`audit_*` columns, `poverty_rate`, `no_vehicle_rate`).
3. Quantify both baseline disparity and post-routing impact: **do >45-day referral bounce loops disproportionately hit high-poverty, zero-vehicle neighborhoods, and does your re-routing close the 45-day gap without forcing zero-vehicle families into 60-kilometer trips?**

---

## Going further

### What will set yours apart

- **Simulate a single network fix.** Use your graph tool to compute exactly how many breached cases drop under 45 days if one `paper_fax` intake coordinator switches to electronic intake with pre-checked bilingual availability.
- **Render the multi-hop graph visually.** Showing a 4-hop paper-fax bounce chain collapsing into a 2-hop 24-day electronic route on screen lands in five seconds during a 3-minute video.
- **Zero-vehicle travel guardrails.** Flag when the only <=45-day bilingual evaluation hub sits far from a high `no_vehicle_rate` tract, recommending tele-assessment or mobile developmental evaluation where permitted.

### The add-on we'd build if we had another four hours

**A pre-handoff eligibility & packet completeness checker.** Before a pediatric screening clinic sends a referral, have an intake sub-agent validate insurance/Medicaid status, home language, child age in months (particularly toddlers approaching the 36-month Part C aging-out cliff!), and live downstream hub waitlists so incomplete fax packets never enter a bounce loop in the first place.

---

## Bringing your own data

**Augment, do not replace.** Any external dataset you bring must clear all six licensing rules:

| Rule | Why |
|---|---|
| ❌ No **NonCommercial** (`CC BY-NC`) | Winning projects are promoted publicly |
| ❌ No **NoDerivatives** (`CC BY-ND`) | Derived tools and outputs are the goal |
| ❌ No **Share-Alike** (`ODbL`, `CC BY-SA`) | Encumbers your team's repository |
| ❌ No **individual-level personal data (PII)** or real clinician defamation | Never attach synthetic waitlists or statutory breaches to real individual providers |
| ❌ No **unstated license** | Unlicensed directories cannot be loaded |
| ✅ **Public domain, CC0, US Government works** | Safe |

**The license trap most likely to catch you:** anything derived from **OpenStreetMap carries the `ODbL` share-alike license**, and private pediatric provider directories or commercial care-finder websites are all-rights-reserved (and hold real clinician PII). Check the license before loading, and ask a coach if you are unsure.

---

## What's in this repository

```text
README.md                                    This challenge brief and team runbook.
agent/                                       Python ADK multi-agent workbench (`first_milestones`), FastAPI server, and tests (see agent/README.md).
agent/eval/                                  20-case golden/adversarial benchmark, ADK EvalSet bridge, 5 graders, and EVAL_AND_PROD_READINESS.md.
frontend/                                    React + Vite Split-Pane Coordinator UI & Google Maps clinic view (built into Cloud Run Dockerfile).
notebooks/c_ei_01_load_explore.ipynb         Step 1: Provision graph reservation, load, explore & validate.
notebooks/c_ei_02_graph_and_audit.ipynb      Step 2: ISO GQL multi-hop audit, counterfactuals, and Equity Audit notebook.
notebooks/c_ei_90_publish_snapshot.ipynb     Maintainers only (publishes snapshots to Cloud Storage).
presentation/                                Executive Pitch Deck (HTML/PDF/MD), 3-min demo script/video, and technical changelog.
scripts/                                     Loaders (`load.sh`, `load_multistate.sh`), graph setup, Cloud Run & Agent Engine deploy scripts.
data/*.parquet                               Pre-staged 6-state GeoParquet starter tables + BYOD HRSA FQHC sites (see data/README.md).
```

---

## How you'll be judged

**"Finished" is not the goalpost.** Almost nobody completes every stretch idea in 4.5 hours. A team that gets three quarters of the way with genuine multi-hop ISO GQL traversals, verified graph integrity, and honest synthetic-data framing will beat a team that demos something polished and hollow.

**You are judged against the track you chose**, not against a fixed answer key. State your chosen state and track right at the start of your deck and video.

**Judges score your submission asynchronously, not a live Q&A.** Put the answers to the questions below directly into your deck and your **<=3-minute pitch video**:

| Dimension | Weight | The question judges are asking |
|---|---:|---|
| **Impact & insight** | 30 | Would an IDEA Part C coordinator actually use this to route referrals under 45 days and fix regional bottlenecks? |
| **Technical execution** | 30 | Does the deployed ADK agent work end to end, using MCP, a custom tool, and genuine variable-length ISO `GQL` traversal over `CREATE PROPERTY GRAPH`? |
| **Rigor & judgment** | 25 | Did you correlate `case_chain_id`, catch the all-zero `limited_english_rate` and 6x NSCH grain traps, state 100% synthetic provider provenance honestly, and run the `audit_*` Equity Audit? |
| **Craft & communication** | 15 | Does your <=3-minute video show multi-hop paths clearly on screen during a live run, and can you defend your UI choice? |
| **Bonus: range** | **+10** | Counterfactual bottleneck simulation, aging-out triage (`child_age_months`), or compliant BYOD enrichment |

Bonus sits **on top** of the 100, so ambition never cannibalizes the fundamentals. Nail the core workflow and add nothing extra, and you can still win.

### What "Rigor and judgment" actually means

This is a quarter of your score and the easiest place to stand out:

1. **Data and synthetic-ethics honesty:** State clearly that `SYN-PROV-*` / `SYN-PARTC-*` nodes and referral chains are **100% `[Synthetic]`** (so made-up waitlists or federal 45-day breaches never touch real clinicians), while ACS under-5 counts are real public Census data and HRSA NSCH strata are `Statewide`-only.
2. **Validation and grain discipline:** Show that you caught `limited_english_rate = 0.0` in the ACS extract (`Section 4`), avoided the 6x statewide NSCH fan-out (`Section 5`), and correlated `case_chain_id` across variable-length hops (`Section 13`).
3. **Bias handling:** Keep `audit_*` columns out of routing rules, run the post-output Equity Audit (`Section 11`), and report actual numbers on which neighborhoods suffer `>45`-day breaches and how zero-vehicle families are supported.
4. **Knowing what a graph cannot do alone:** A property graph exposes where packets bounce, while clinical eligibility, aging-out urgency (`36` months), and caregiver transport still require explicit operational judgment.

### A note on decisions generally

Which state you pick, how you trade off travel distance against waitlist days for zero-vehicle families, and whether you build an internal staff UI or a custom path visualizer have no single answer key. Judges reward teams who make those choices deliberately and explain why.

---

## Getting help

Ask your **Table Captain** first, then the **ROI facilitator** on the floor and the event Discord channel. If a graph query or table check fails, run **Section 14 (Diagnostic summary)** at the bottom of `notebooks/c_ei_01_load_explore.ipynb` and share the printed summary block.
