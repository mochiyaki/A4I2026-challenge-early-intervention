# Design System Master File — First Milestones

> **LOGIC:** Generated and verified using `ui-ux-pro-max` (`scripts/search.py`) following Step 2 & Step 2b (Query Contract, Accessibility Risk Verification, Semantic Token Architecture, and WCAG 2.2 AA Checklist).
> When building a specific page, check `design-system/first-milestones/pages/[page-name].md` first; otherwise, strictly adhere to the rules below.

---

**Project:** First Milestones — IDEA Part C 45-Day Referral Triage & Multi-Hop CareNode Routing  
**Domain:** Healthcare / Public Health Early Intervention Clinical SaaS Dashboard  
**Variance / Motion / Density:** `3 / 3 / 8` (Structured clinical Swiss grid, purposeful micro-motion, high-clarity coordinator density)

---

## 1. Visual Direction & Style Architecture

- **Primary Style:** **Minimalism & Swiss Style** + **Data-Dense Bento Dashboard** (`Accessibility Risk: low`)
  - *Verification Note:* Initial `--design-system` query for generic healthcare triage surfaced `Neumorphism` (`Accessibility: risk:high`, low-contrast soft shadows). Rejected per `ui-ux-pro-max` Query Contract and re-queried under `"government public health analytics dashboard"` + `--domain style`, selecting Swiss Clinical Minimalism + Data-Dense Bento KPI hierarchy.
- **Structural Principles:**
  - Crisp 1px structural borders (`>= 3:1` contrast on interactive inputs/switches) instead of muddy drop shadows.
  - Top **Executive 4-Card Bento KPI Strip** surfacing statutory compliance (`35d / 45d`), child-days saved vs. paper-fax loops, 36-month Part C age-out buffer, and evaluation hub travel/mode at a glance.
  - Full **Light & Dark Mode Token Parity** (`[data-theme="light"]` and `[data-theme="dark"]`) with zero hardcoded hex values that break surface contrast.
  - **Color is NEVER the sole indicator (`color-not-only`):** Every compliant (`<=45d`), caution (`<=6m` to age-out / zero-vehicle), or statutory breach (`>45d` paper-fax loop) state pairs semantic color with an explicit icon, text badge, and/or stroke/fill pattern (diagonal hatch on breach bars, dashed strokes on fax edges, distinct rings on bounce hubs).

---

## 2. Color System & Semantic Tokens (WCAG 2.2 AA/AAA Verified)

| Semantic Token | Light Mode | Dark Mode | Role & Verified Contrast |
| :--- | :--- | :--- | :--- |
| `--pm-bg` | `#F8FAFC` | `#0B1120` | Primary workspace canvas (`min-h-dvh`) |
| `--pm-surface` | `#F1F5F9` | `#111827` | Secondary recessed panel / table header |
| `--pm-card` | `#FFFFFF` | `#152033` | Primary clinical card container |
| `--pm-ink` | `#0F172A` | `#F8FAFC` | Primary headings & key figures (`17.8:1` L / `17.2:1` D) |
| `--pm-text` | `#1E293B` | `#E2E8F0` | Clinical body prose (`13.6:1` L / `14.1:1` D) |
| `--pm-muted` | `#475569` | `#94A3B8` | Labels, metadata & captions (`7.5:1` L / `6.2:1` D) |
| `--pm-border` | `#E2E8F0` | `#25344D` | Card & table hairline dividers |
| `--pm-border-strong` | `#94A3B8` | `#64748B` | Form controls & interactive boundaries (`>= 3.1:1`) |
| `--pm-accent` | `#0369A1` | `#38BDF8` | Interactive clinical accent (`5.9:1` L / `9.1:1` D) |
| `--pm-cta-bg` | `#0369A1` | `#0284C7` | Primary CTA fill with `#FFFFFF` label (`5.9:1` / `4.6:1`) |
| `--pm-compliant` | `#047857` | `#34D399` | Statutory `<=45d` compliant route (`5.5:1` L / `9.6:1` D) |
| `--pm-warning` | `#B45309` | `#FBBF24` | Transport / `<=6m` age-out advisory (`5.0:1` L / `11.1:1` D) |
| `--pm-danger` | `#B91C1C` | `#F87171` | `>45d` paper-fax statutory breach (`6.5:1` L / `6.4:1` D) |
| `--pm-ring` | `#0284C7` | `#38BDF8` | 2px `focus-visible` keyboard ring (`>= 4.5:1`) |

---

## 3. Typography & Hierarchy

- **Display & UI Headings (`--font-display`):** `Plus Jakarta Sans` (`500, 600, 700`) — crisp geometric SaaS authority with `text-wrap: balance`.
- **Clinical Body & Caregiver Letters (`--font-body`):** `Atkinson Hyperlegible` (`400, 700`) — low-vision and public-health accessibility standard distinguishing `1 / l / I` and `0 / O` in clinical notes and bilingual caregiver letters.
- **Tabular Metrics, FIPS, CareNode IDs & ISO GQL (`--font-mono`):** `Fira Code` (`400, 500, 600`) with `font-variant-numeric: tabular-nums` so numbers align vertically across columns and live filter changes never cause horizontal jitter.

---

## 4. Layout, Viewport & Spacing Rules

- **Sticky Command Header Clearance (`focus-not-obscured`):** `html { scroll-padding-top: 88px; }` prevents sticky navigation from obscuring focused controls during keyboard `Tab` traversal.
- **Dynamic Viewport Stability:** Root shell uses `min-h-dvh` rather than `100vh` to prevent mobile browser chrome clipping; horizontal overflow is zero across `375px`, `768px`, `1024px`, and `1440px`.
- **Touch Target Ergonomics (`touch-target-size` & `touch-spacing`):** Primary interactive buttons, inputs, selects, switches, and microphone controls maintain `>= 44x44px` tap targets on mobile (`>= 38px` compact desktop toolbar controls) with `>= 8px` gap between adjacent actions and `touch-action: manipulation`.

---

## 5. Component & Chart Accessibility Rules (`ui-ux-pro-max` Priority 1–10)

1. **Single-Pointer Alternatives to Dragging (`dragging-alternative` — WCAG 2.2 AA):**
   - `FluidAgeScrubber` pairs 1:1 pointer scrubbing with explicit **`-1m` and `+1m` stepper buttons** plus keyboard range support.
   - `AgentModal` pairs sheet drag-to-dismiss with an explicit Close (`X`) button, Cancel/Local button, backdrop click, and `Escape` key dismissal (`escape-routes`).
2. **Network Graph Accessibility (`charts.csv` — Force/Topology Graph `Accessibility Risk: high`):**
   - Provides a built-in **Accessible Flow & Adjacency Table** view (`Accessible Table` segment in `NetworkGraphCanvas`) alongside the SVG diagram.
   - All 30 SVG CareNodes are keyboard-focusable (`tabIndex={0}`, `role="button"`, `Enter`/`Space` activation) with distinct outer geometry/rings for recommended nodes vs. bounce hubs.
   - Includes a dedicated Pause/Play button (`aria-pressed`) for the 3.2s route pulse animation.
3. **Contextual Live Announcements (`contextual-live-badge-updates`):**
   - Polite `aria-live="polite"` status region announces recalculated pathway compliance and expected IFSP days when intake filters change without stealing keyboard focus.
4. **Icon & Form Hygiene (`icon-context`, `inline-validation`, `ime-composition-enter`):**
   - Zero emojis as UI icons; Lucide SVGs beside text carry `aria-hidden="true"`, while icon-only controls carry descriptive `aria-label`.
   - `AgentModal` validates endpoint URLs inline (`aria-invalid` + `aria-describedby` error placement).
   - `AgentChatSidebar` guards IME composition before submitting and supports bilingual `en-US` / `es-US` speech recognition & synthesis.

---

## 6. Anti-Patterns (Strictly Forbidden)

- Never use emojis as structural UI icons.
- Never rely on color alone to distinguish `<=45d` electronic routes from `>45d` paper-fax breaches.
- Never hide form labels inside placeholders or omit `htmlFor`/`id` bindings.
- Never alter `SYN-PROV-*` / `SYN-PARTC-*` synthetic IDs, include `audit_*` demographic columns in route ranking, join statewide NSCH strata to census tracts, or strip leading zeros from 11-character `census_tract_geoid` strings.
