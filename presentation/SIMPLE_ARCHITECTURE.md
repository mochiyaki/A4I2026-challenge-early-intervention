# First Milestones — Simple System Architecture & Workflow Blueprint

## 1. Simple System Architecture

```mermaid
flowchart TD
    subgraph UI["1. COORDINATOR WORKBENCH (Cloud Run)"]
        A["<b>Dual User Interfaces</b><br/>• React 19 Copilot with Voice & Google Maps<br/>• Cytoscape.js Multi-Hop Network Explorer"]
    end

    subgraph AGENTS["2. MULTI-AGENT BRAIN (Google ADK)"]
        B["<b>Gemini 2.5 Pro Root Coordinator</b><br/>Statutory Gatekeeper & Session Orchestrator"]
        C1["<b>Triage Router</b><br/>(Gemini Flash)<br/>Finds &le;45d Paths"]
        C2["<b>Network Auditor</b><br/>(Gemini Flash)<br/>Detects Fax Bottlenecks"]
        C3["<b>Equity Specialist</b><br/>(Gemini Flash)<br/>Bilingual Plans & Audits"]
        
        B --> C1
        B --> C2
        B --> C3
    end

    subgraph GOV["3. SAFETY & GOVERNANCE LAYER"]
        D["<b>4-Layer Guardrails & Ledgers</b><br/>• Hop-0 Packet Gatekeeper (Readiness Score 0–100)<br/>• Pre-Tool SQL Firewall (Blocks DDL & Bias Sorting)<br/>• 48-Hour Atomic Capacity Hold (Firestore / SQLite WAL)"]
    end

    subgraph DATA["4. MANAGED DATA PLANE (Google Cloud)"]
        E1["<b>Google MCP Toolbox</b><br/>Governed Tool APIs"]
        E2["<b>BigQuery Property Graph</b><br/>ISO GQL Multi-Hop Engine (6 States)"]
    end

    UI <--> B
    B <--> D
    C1 & C2 & C3 <--> E1 & E2
```

### The 4 Simple Layers
1. **Coordinator Workbench (Cloud Run):** Unified web container serving a modern React 19 triage copilot with live voice interaction and Google Maps, alongside a classic Cytoscape.js network explorer.
2. **Multi-Agent Brain (Google ADK):** Gemini 2.5 Pro orchestrator managing three dedicated Gemini 2.5 Flash specialist agents for pathway routing, bottleneck audits, and bilingual caregiver communications.
3. **Safety & Governance Layer:** Programmatic firewall scoring intake packet readiness, preventing race conditions with a 48-hour atomic slot hold, and blocking ungrounded demographic bias in routing.
4. **Governed Data Plane (BigQuery & MCP):** Live BigQuery ISO/IEC 39075 Property Graph (`ReferralGraph`) running multi-hop traversals across 6 states, integrated via the Google Model Context Protocol (MCP) Toolbox.

---

## 2. Simple End-to-End Workflow Diagram

```mermaid
flowchart LR
    A["<b>1. Child Referral</b><br/>• Age (0–35m)<br/>• Tract & Medicaid<br/>• Home Language"]
    --> B["<b>2. Hop-0 Gatekeeper</b><br/>• Validate Consent<br/>• Check ASQ-3/M-CHAT<br/>• Verify 36m Clock"]
    --> C["<b>3. ADK Agent & ISO GQL</b><br/>• BigQuery Property Graph<br/>• Bypass Bounce Hubs<br/>• Find &le;45d Corridors"]
    --> D["<b>4. Atomic Slot Lock</b><br/>• 48-Hour Capacity Hold<br/>• Prevent Double-Booking<br/>• Firestore / SQLite WAL"]
    --> E["<b>5. Family Action Plan</b><br/>• Bilingual EN/ES Notes<br/>• Medicaid NEMT Transit<br/>• Post-Route Equity Check"]
```

### 5 Workflow Steps
1. **Intake & Referral Arrival:** Coordinator enters child details (e.g., 32-month toddler in Sunflower County needing Medicaid Spanish autism evaluation).
2. **Hop-0 Packet Gatekeeper:** Automatically verifies required consents, screening attachments (ASQ-3/M-CHAT), and age tier before transmission to prevent Day-0 bounce loops.
3. **Property Graph Routing (ISO GQL):** Traverses live BigQuery `ReferralGraph` to bypass known paper-fax bottleneck hubs and identify verified $\le$45-day multidisciplinary evaluation corridors.
4. **48-Hour Atomic Slot Reservation:** Atomically locks capacity across the coordinator, eval hub, and therapy vendor so scarce bilingual slots aren't double-booked.
5. **Caregiver Note & Transit Support:** Delivers plain-language bilingual (English/Español) family action notes and automatically pre-authorizes Medicaid non-emergency medical transportation (NEMT) for zero-vehicle households.
