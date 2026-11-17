# First Milestones — 3-Minute Demo Narration Script (`02:40` Total · `<= 3:00`)

**Target Runtime:** `02:40` (`160` seconds — strictly `<= 03:00` / `180` seconds)
**Spoken Word Budget:** `368` spoken words (`~138 WPM` natural clinical pacing, strictly `<= 450` words)
**Ethics & Data Provenance:** Explicitly states `100% [Synthetic]` provider (`SYN-PROV-*`), agency (`SYN-PARTC-*`), and referral (`CHAIN-*`) governance alongside public US Census ACS and statewide HRSA NSCH data.

---

## Scene 1 (`00:00 – 00:26` · 26s) — Statutory Hook, Ethics Banner & Architecture
**On-Screen Action:**
- Open the live **First Milestones** Split-Pane Coordinator Workbench (`MS — Mississippi`).
- Highlight the header governance badge (`100% [Synthetic] Providers · Real ACS Tracts`), the `MCP + ISO GQL Ready` runtime badge, and the KPI strip (`44` complete chains, `26` `>45d` breaches, Upper Delta `SYN-PARTC-MS-01` at `52.5%` timely IFSP).

**Narration (60 words):**
> Under federal IDEA Part C, toddlers with developmental delays must receive an evaluation and service plan within forty-five calendar days, before aging out at thirty-six months. Welcome to First Milestones. Every provider `SYN-PROV-*` and referral chain `CHAIN-*` shown here is one hundred percent synthetic, anchored to real US Census tracts. In Mississippi, twenty-six of forty-four referral chains breach forty-five days.

---

## Scene 2 (`00:26 – 01:08` · 42s) — Track 1: 32-Month Triage, Cytoscape Graph & Español Note
**On-Screen Action:**
- Click **`Track 1: 32m Autism Triage (Spanish · Medicaid · No Vehicle)`** (`[data-preset="triage"]`).
- Watch live ADK multi-agent delegation (`first_milestones_coordinator` -> `triage_pathway_router` & `equity_and_caregiver_specialist`).
- Inspect the interactive **Cytoscape.js** topology (and filter toggles if present) comparing historical `CHAIN-MS-023` (`4` hops, `75` days via `paper_fax`, reaching therapy at `34.5` months) against the verified **`34`-day** electronic route (`SYN-PROV-MS-007 -> SYN-PROV-MS-011 -> SYN-PROV-MS-019 -> SYN-PROV-MS-028`) with Medicaid NEMT ride support.
- Toggle the Caregiver Action Note from **English** to **Español** (`[data-lang="spanish"]`).

**Narration (96 words):**
> Let's triage a thirty-two-month-old toddler in Coahoma County needing an autism evaluation, Medicaid, Spanish support, and transportation. Historically, `CHAIN-MS-023` bounced across four paper-fax hops for seventy-five days, reaching therapy at thirty-four-point-five months, weeks from the thirty-six-month cliff. Our ADK coordinator delegates to specialist sub-agents over BigQuery Property Graph, routing an electronic three-hop corridor in thirty-four days—eleven days ahead of the federal deadline—while flagging free Medicaid NEMT rides. With one click, the coordinator switches the plain-language Caregiver Action Note into Spanish so the family knows every step at zero cost.

---

## Scene 3 (`01:08 – 01:50` · 42s) — Track 2: Hidden Bounce Hub Audit & Counterfactual Simulator
**On-Screen Action:**
- Switch to **`Bottleneck Hubs & Sim`** (`#tabHubsBtn`).
- Point to **`SYN-PROV-MS-011`** in `#coordAuditTable` (`5d` flat internal wait vs `7 / 11` `>45d` breaches and `198` excess days).
- Click **`Simulate EHR + Slot Pre-Check`** (`#runSimBtn`) and highlight `#simImpactBox` (`7 -> 2` breaches, `5` breaches eliminated, **`229` delayed child-days saved**, `CHAIN-MS-023` cut from `75d` to `38d`).

**Narration (88 words):**
> Next, in Track Two, why do flat SQL waitlists miss the real bottleneck? Sorting by waitlist blames busy downstream clinics while Indianola intake hub `SYN-PROV-MS-011` looks fast with a five-day internal wait. Yet variable-length ISO GQL correlated on `case_chain_id` and prefix-deduplicated reveals seven of its eleven episodes breach forty-five days due to paper-fax slot mismatches. Running our counterfactual simulator—upgrading just `SYN-PROV-MS-011` to electronic EHR intake with bilingual slot pre-checks—eliminates five breaches and saves two hundred twenty-nine delayed child-days.

---

## Scene 4 (`01:50 – 02:22` · 32s) — Track 3: Hidden EI Deserts, Post-Output Equity & Data Traps
**On-Screen Action:**
- Switch to **`Outreach & Equity`** (`#tabOutreachBtn`).
- Show `#outreachZonesTable` (`21` Hidden EI Deserts, e.g., Bolivar `28011950100` at `2.1 km` from a clinic but `0` reachable `<=45d` pathways), `#equityTable` (`audit_*` shares joined strictly post-output, zero race inputs in routing), `#nschTable` (`6` statewide NSCH rows without 6x tract fan-out), and `#rigorChecklist` (catching all-zero `limited_english_rate`).

**Narration (74 words):**
> In Track Three, we uncover twenty-one Hidden Early Intervention Deserts—like Bolivar tract `28011950100`, just two-point-one kilometers from a clinic yet with zero reachable forty-five-day bilingual pathways. Race and ethnicity `audit_*` shares are excluded from routing and audited strictly post-output. Our guardrails also catch the all-zero ACS `limited_english_rate` column and preserve statewide HRSA NSCH grain without six-times tract fan-out, targeting mobile screening vans where downstream slots exist.

---

## Scene 5 (`02:22 – 02:40` · 18s) — Multi-State California (`'06...'`) Switch & ISO GQL Inspector
**On-Screen Action:**
- Switch `#stateSelect` to **`CA — California (FIPS 06)`**, confirming 11-character leading-zero `'06...'` GEOIDs across `101` tracts (`41,144` under-5 children).
- Click **`Inspect ISO GQL`** (`#toggleGqlBtn`) to display the live `GRAPH_TABLE` query, then close (`#closeGqlBtn`).

**Narration (50 words):**
> Finally, switching live to California preserves leading-zero `'06'` FIPS strings across one hundred one tracts and forty-one thousand children, while the ISO GQL Inspector exposes every correlated BigQuery Property Graph query. Deployed on Cloud Run and Vertex AI Agent Engine, First Milestones protects every child's forty-five-day window.
