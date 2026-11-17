# First Milestones · IDEA Part C 45-Day Pathway Triage UI (`frontend/`)

Custom coordinator frontend for **Track 1: Today's Toddler Referral** — *"A twenty-month-old needs a bilingual developmental evaluation under Medicaid. Which provider path clears the 45-day clock from their neighborhood?"*

## Key Capabilities

- **Pre-loaded Real Starter Data across all 6 States (`MS`, `AL`, `GA`, `TX`, `CA`, `NY`)**: Extracted directly from `../data/*.parquet` (`npm run extract-data`) with 11-character `census_tract_geoid` leading zeros preserved.
- **Visual 45-Day Statutory Clock Comparison (`34 CFR § 303.310`)**: Contrasts the recommended `<=45`-day electronic bilingual Medicaid provider path against historical `3–4`-hop `paper_fax` bounce chains.
- **Interactive 30-Node `CareNode` ReferralGraph Visualizer**: Highlights `Clinic -> Coordinator -> Bilingual Eval Hub -> Therapy Vendor` paths and inspects why flat SQL waitlist sorting (`active_waitlist_count DESC`) misses `5–6` day internal-wait fax bounce hubs.
- **Rigor & Equity Guardrails Built In**:
  - Prominent stage-safe **`100% [Synthetic]`** (`SYN-PROV-*`, `SYN-PARTC-*`) provenance banner.
  - Catches the all-zero `limited_english_rate = 0.0` column in ACS and isolates the `6` Statewide HRSA NSCH strata (preventing `6x` tract duplication).
  - Strictly excludes `audit_*` demographic shares from routing logic, joining them *post-output* for the Equity Audit tab.
  - Includes Zero-Vehicle Travel Guardrails and side-by-side **English & Spanish** plain-language caregiver action notes.
- **5-Agent Clinical Research, Verification & Evidence Council (`multiAgentPipeline.ts`, `MultiAgentCouncilPanel.tsx`)**:
  - Coordinates **Policy & Data Researcher**, **ISO GQL Graph Router**, **Statutory & Fairness Verifier** (`6/6` automated checks), **Evidence & Provenance Librarian**, and **Executive Lead Synthesizer** to produce verified executive summaries, indexed citations (`34 CFR § 303.310`, OSEP, US Census ACS, HRSA NSCH, `100% [Synthetic]` ReferralGraph), and a brief, precise clinical conclusion.
- **Google Maps Clinic & Pathway Integration (`googleMapsService.ts`, `ClinicLocationMapCard.tsx`)**:
  - Asking for clinic locations, addresses, or directions in chat/voice (English or Spanish) or toggling **Show Google Map** in the pathway panel renders an interactive Google Map layout (`VITE_GOOGLE_MAPS_API_KEY` vector polyline/markers with automatic zero-key Google Maps coordinate embed + multi-stop Directions fallback).
- **Right-Hand Voice & Chat Copilot (`AgentChatSidebar`)**:
  - Ask questions directly in plain English or Spanish without digging through charts or SQL tables, with a **Focused View / Full Charts & SQL** toggle in the top bar.
  - **Voice Agent Input & Spoken Replies (`useVoiceAgent`)**: Live `SpeechRecognition` (`EN Mic` / `ES Mic`) with a 60fps Web Audio level-reactive orb, live interim transcription, natural `speechSynthesis` voice replies (`Auto-Speak` + per-message Read Aloud), and instant barge-in interruption.
  - **Live Dashboard Synchronization (`conversationalAgent.ts`)**: Speaking or typing *"20-month-old in Texas, Spanish, no car"* automatically updates the state, neighborhood tract, child age, and zero-vehicle guardrails on screen while answering.
- **Apple Fluid Interface Polish (`apple-design`)**:
  - Interruptible critically-damped springs (`bounce: 0, duration: 0.35`) across segmented controls, route cards, and 45-day clock bars.
  - Direct-manipulation 1:1 pointer-captured age scrubber with progressive rubber-banding (`rubberband`) and gesture-hinting tactile iOS switches.
  - Gesture-driven `AgentModal` sheet with grab-offset tracking, exponential momentum projection (`projectMomentum`), velocity handoff, and dynamic scrim dimming.
  - Translucent floating chrome (`backdrop-filter: blur(22px) saturate(180%)`), optical size-specific tracking & inverse leading, `tabular-nums`, and full `@media (prefers-reduced-motion)`, `(prefers-reduced-transparency)`, and `(prefers-contrast: more)` support.
- **Ready for Live ADK / Cloud Run Integration**: Click **Connect ADK Agent** in the top bar (or set `VITE_AGENT_API_URL`) once the Agent Lane deploys.

## Quick Start

```bash
cd frontend
npm install
npm run extract-data   # Refreshes src/data/starterData.json from ../data/*.parquet
npm run dev            # Starts dev server on http://localhost:5173
```
