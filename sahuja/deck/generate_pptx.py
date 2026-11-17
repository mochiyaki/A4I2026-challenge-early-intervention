#!/usr/bin/env python3
"""Generates `First_Milestones_Pitch_Deck.pptx` (16:9 widescreen, Google Slides & PowerPoint ready)."""

from __future__ import annotations

from pathlib import Path
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

OUT_PATH = Path(__file__).resolve().parent / "First_Milestones_Pitch_Deck.pptx"

BG_DARK = RGBColor(11, 16, 32)
CARD_BG = RGBColor(19, 28, 54)
BORDER_BLUE = RGBColor(40, 54, 99)
WHITE = RGBColor(248, 250, 252)
MUTED = RGBColor(159, 176, 217)
CYAN = RGBColor(56, 189, 248)
GREEN = RGBColor(16, 185, 129)
AMBER = RGBColor(245, 158, 11)
ROSE = RGBColor(244, 63, 94)


def set_slide_bg(slide) -> None:
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = BG_DARK


def add_header(slide, kicker: str, title: str, subtitle: str) -> None:
    tb = slide.shapes.add_textbox(Inches(0.65), Inches(0.42), Inches(12.0), Inches(1.45))
    tf = tb.text_frame
    tf.word_wrap = True

    p0 = tf.paragraphs[0]
    p0.text = kicker.upper()
    p0.font.size = Pt(11)
    p0.font.bold = True
    p0.font.color.rgb = CYAN

    p1 = tf.add_paragraph()
    p1.text = title
    p1.space_before = Pt(4)
    p1.font.size = Pt(26)
    p1.font.bold = True
    p1.font.color.rgb = WHITE

    p2 = tf.add_paragraph()
    p2.text = subtitle
    p2.space_before = Pt(4)
    p2.font.size = Pt(13.5)
    p2.font.color.rgb = MUTED


def add_footer(slide, left_text: str, slide_num: int, total: int = 8) -> None:
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.65), Inches(6.82), Inches(12.03), Inches(0.02))
    line.fill.solid()
    line.fill.fore_color.rgb = BORDER_BLUE
    line.line.fill.background()

    tb = slide.shapes.add_textbox(Inches(0.65), Inches(6.9), Inches(10.5), Inches(0.35))
    p = tb.text_frame.paragraphs[0]
    p.text = left_text
    p.font.size = Pt(10.5)
    p.font.color.rgb = MUTED

    tb_r = slide.shapes.add_textbox(Inches(11.3), Inches(6.9), Inches(1.38), Inches(0.35))
    pr = tb_r.text_frame.paragraphs[0]
    pr.alignment = PP_ALIGN.RIGHT
    pr.text = f"Slide {slide_num} / {total}"
    pr.font.size = Pt(10.5)
    pr.font.color.rgb = MUTED


def add_card(
    slide,
    left: float,
    top: float,
    width: float,
    height: float,
    *,
    big_num: str | None = None,
    big_color: RGBColor = CYAN,
    heading: str = "",
    heading_color: RGBColor = WHITE,
    bullets: list[str] | None = None,
    body: str | None = None,
    border_color: RGBColor = BORDER_BLUE,
) -> None:
    rect = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE,
        Inches(left),
        Inches(top),
        Inches(width),
        Inches(height),
    )
    rect.adjustments[0] = 0.04
    rect.fill.solid()
    rect.fill.fore_color.rgb = CARD_BG
    rect.line.color.rgb = border_color
    rect.line.width = Pt(1.25)

    tb = slide.shapes.add_textbox(Inches(left + 0.22), Inches(top + 0.18), Inches(width - 0.44), Inches(height - 0.32))
    tf = tb.text_frame
    tf.word_wrap = True
    first_used = False

    if big_num:
        p = tf.paragraphs[0]
        first_used = True
        p.text = big_num
        p.font.size = Pt(30)
        p.font.bold = True
        p.font.color.rgb = big_color

    if heading:
        p = tf.add_paragraph() if first_used else tf.paragraphs[0]
        first_used = True
        p.text = heading
        p.space_before = Pt(4 if big_num else 0)
        p.font.size = Pt(15)
        p.font.bold = True
        p.font.color.rgb = heading_color

    if body:
        p = tf.add_paragraph() if first_used else tf.paragraphs[0]
        first_used = True
        p.text = body
        p.space_before = Pt(6)
        p.font.size = Pt(12.5)
        p.font.color.rgb = MUTED

    if bullets:
        for b in bullets:
            p = tf.add_paragraph() if first_used else tf.paragraphs[0]
            first_used = True
            p.text = f"•  {b}"
            p.space_before = Pt(6)
            p.font.size = Pt(12.2)
            p.font.color.rgb = MUTED


def set_notes(slide, notes: str) -> None:
    slide.notes_slide.notes_text_frame.text = notes


def build_deck() -> Path:
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]

    # ---------------- SLIDE 1 ----------------
    s1 = prs.slides.add_slide(blank)
    set_slide_bg(s1)
    add_header(
        s1,
        "Agents for Impact 2026 · Early Intervention & Developmental Screening Triage",
        "First Milestones: Clearing the Federal 45-Day Early Intervention Clock",
        "State: California (CA · FIPS 06)  |  Unified Track 1 (Today's Toddler Triage) + Track 2 (Quarterly Network Audit)",
    )
    add_card(
        s1, 0.65, 2.2, 3.85, 3.1,
        big_num="45 Days", big_color=CYAN,
        heading="Federal Statutory Ceiling",
        body="Under IDEA Part C (34 CFR § 303.310), states must deliver a multidisciplinary evaluation and initial Individualized Family Service Plan (IFSP) within 45 calendar days—before aging out at 36 months.",
    )
    add_card(
        s1, 4.74, 2.2, 3.85, 3.1,
        big_num="41,144", big_color=GREEN,
        heading="Real Children Under 5",
        body="Anchored across 101 real public US Census ACS tracts in California (preserving 11-character leading-zero 06... GEOIDs) paired with 6 statewide-only HRSA NSCH screening strata.",
    )
    add_card(
        s1, 8.83, 2.2, 3.85, 3.1,
        big_num="100% [Synthetic]", big_color=AMBER,
        heading="Stage-Safe Provider Network",
        body="All 30 CareNode organizations (SYN-PROV-CA-*), 3 regional lead agencies (SYN-PARTC-*), and 44 referral chains are 100% synthetic so simulated waitlists never implicate real clinicians.",
        border_color=AMBER,
    )
    add_card(
        s1, 0.65, 5.55, 12.03, 1.05,
        heading="Mission: An Interactive Coordinator Workbench, Not a Static Directory",
        body="Give regional DDS Early Start intake coordinators a working ADK agent that routes today's toddler in <=45 days and exposes hidden multi-hop fax bounce hubs.",
    )
    add_footer(s1, "Python ADK · Vertex AI Gemini · Google BigQuery MCP · BigQuery Property Graphs (ISO GQL)", 1)
    set_notes(
        s1,
        "State clearly right up front: California (CA, FIPS 06), combining Track 1 active referral routing and Track 2 network bottleneck auditing. State plainly that all SYN-PROV-CA-* providers and referral logs are 100% synthetic to protect real clinicians.",
    )

    # ---------------- SLIDE 2 ----------------
    s2 = prs.slides.add_slide(blank)
    set_slide_bg(s2)
    add_header(
        s2,
        "The Problem & Human Impact",
        "Why 20 Months vs. 5 Years Changes a Child's Entire Trajectory",
        "Speech, motor, and autism therapy during peak infant neuroplasticity prevents lifelong developmental gaps—if families aren't lost in fax loops.",
    )
    add_card(
        s2, 0.65, 2.15, 5.88, 4.35,
        heading="Where the System Silently Breaks Today",
        heading_color=ROSE,
        border_color=ROSE,
        bullets=[
            "59% Breach Rate (26 of 44 chains): Multi-hop referrals stretch up to 77 calendar days—nearly double federal law.",
            "Paper-Fax Friction: Outbound paper_fax handoffs average 19.5 wait days and ~24.3% family drop-off per hop vs. 13.3d on electronic EHR.",
            "Credential & Bilingual Bounces: Missing Spanish-language or Medi-Cal slots at hop 2 trigger 23-day re-referral bounces at hop 3.",
            "36-Month Aging-Out Cliff: 3 toddlers aged 30–35 months sit inside breached chains, risking aging out of Part C before therapy starts.",
        ],
    )
    add_card(
        s2, 6.80, 2.15, 5.88, 4.35,
        heading="How First Milestones Delivers Measurable Impact",
        heading_color=GREEN,
        border_color=GREEN,
        bullets=[
            "Child-Level Impact: Reroutes a 22-month-old Spanish/Medi-Cal toddler from a 71-day bounce loop onto a verified 32-day compliant pathway.",
            "Family-Level Impact: Protects zero-vehicle households via Medi-Cal NEMT transport / tele-assessment guardrails + plain-language EN/ES caregiver action notes.",
            "System-Level Impact: Proves that upgrading 1 coordinator hub from paper fax to electronic intake rescues 9 breached chains and saves 282 child-days.",
            "Outreach Impact: Places mobile screening vans only where <=45-day downstream bilingual capacity is verified.",
        ],
    )
    add_footer(s2, "Impact Thesis: Convert invisible multi-hop administrative lag into timely <=45-day family service plans", 2)
    set_notes(s2, "Emphasize why IDEA Part C's 45-day clock exists: neuroplasticity before age 3 makes early speech/autism support exponentially more effective than waiting for kindergarten.")

    # ---------------- SLIDE 3 ----------------
    s3 = prs.slides.add_slide(blank)
    set_slide_bg(s3)
    add_header(
        s3,
        "Required Differentiator · BigQuery Property Graphs",
        "Why Flat SQL Blames the Wrong Clinic—and ISO GQL Exposes the Culprit",
        "A single handoff is a SQL JOIN; a 3-to-4-hop re-referral bounce loop requires CREATE PROPERTY GRAPH + variable-length ISO GQL (-{2,4}->).",
    )
    add_card(
        s3, 0.65, 2.15, 5.88, 2.85,
        heading="Naive Flat SQL Sort (Downstream Queue Symptom)",
        heading_color=MUTED,
        bullets=[
            "Sorting pediatric_and_ei_provider_directory by waitlist blames #16 Redding Eval Center (81 waitlist, 39d wait).",
            "Meanwhile, Fresno Intake Desk #11 (SYN-PROV-CA-011) looks like the HEALTHIEST coordinator in California at just 5 days internal wait!",
        ],
    )
    add_card(
        s3, 6.80, 2.15, 5.88, 2.85,
        heading="ISO GQL -{2,4}-> Traversal (True Upstream Root Cause)",
        heading_color=CYAN,
        border_color=CYAN,
        bullets=[
            "Correlating case_chain_id across 2–4 hops exposes SYN-PROV-CA-011 as California's #1 regional bounce bottleneck.",
            "Sits on 9 breached episodes (+214 excess child-days over 45d) due to 64% outbound paper_fax routing into saturated/non-bilingual hubs.",
        ],
    )
    add_card(s3, 0.65, 5.22, 3.85, 1.35, heading="2-Hop Fast-Track: 0% Breach", heading_color=GREEN, body="Direct electronic placement always clears the 45-day federal limit.")
    add_card(s3, 4.74, 5.22, 3.85, 1.35, heading="3-Hop Standard: Threshold Zone", heading_color=AMBER, body="Clears 45 days only when bilingual, Medi-Cal, and EHR align.")
    add_card(s3, 8.83, 5.22, 3.85, 1.35, heading="4-Hop Bounce Loops: 100% Breach", heading_color=ROSE, body="Every evaluator or Medicaid re-referral bounce breaks federal law.")
    add_footer(s3, "DDL excludes GEOGRAPHY (PROPERTIES ALL COLUMNS EXCEPT (provider_geom)) · Uses ISO GQL LET + NEXT + FILTER", 3)
    set_notes(s3, "Highlight why a property graph is essential rather than decorative: variable-length 2-to-4 hop traversal correlated on case_chain_id exposes low-wait intake coordinators causing downstream bounces.")

    # ---------------- SLIDE 4 ----------------
    s4 = prs.slides.add_slide(blank)
    set_slide_bg(s4)
    add_header(
        s4,
        "System Architecture & Deliberate UX Choice",
        "Split-Screen Coordinator Workbench + ADK + Managed BigQuery MCP",
        "Purpose-built for internal DDS Regional Intake & Quality Coordinators deployed on Google Cloud Run",
    )
    add_card(s4, 0.65, 2.15, 2.85, 2.75, heading="1. Split-Screen UI", heading_color=CYAN, body="Multi-turn coordinator chat on the left dynamically updates a visual 45-Day Pathway & Bottleneck Brief on the right.")
    add_card(s4, 3.71, 2.15, 2.85, 2.75, heading="2. Python ADK + Gemini", heading_color=CYAN, body="google-adk orchestrator running Vertex AI gemini-2.5-flash on Cloud Run with statutory & 36m cliff rules.")
    add_card(s4, 6.77, 2.15, 2.85, 2.75, heading="3. Managed BQ MCP", heading_color=CYAN, body="Consumes Google's managed BigQuery MCP server (https://bigquery.googleapis.com/mcp) via ADK McpToolset.")
    add_card(s4, 9.83, 2.15, 2.85, 2.75, heading="4. BigQuery Graph", heading_color=CYAN, body="ReferralGraph on zero-baseline Enterprise reservation (0 idle slots, autoscale 50) + native ST_DISTANCE.")
    add_card(
        s4, 0.65, 5.15, 12.03, 1.42,
        heading="Five Custom ISO GQL & Spatial Function Tools",
        bullets=[
            "route_toddler_referral_45d  ·  audit_regional_bounce_hubs  ·  simulate_bottleneck_fix (+10 Bonus)  ·  run_post_output_equity_audit  ·  rank_screening_outreach_tracts",
        ],
    )
    add_footer(s4, "Runs seamlessly on Cloud Run (--min-instances=1) and locally via `adk web`", 4)
    set_notes(s4, "Defend our UI choice: internal regional coordinators need both conversational re-routing when case constraints change AND a visual hop-by-hop pathway brief they can audit and share.")

    # ---------------- SLIDE 5 ----------------
    s5 = prs.slides.add_slide(blank)
    set_slide_bg(s5)
    add_header(
        s5,
        "Track 1 · Today's Toddler Referral Walkthrough",
        "Turning a 71-Day Paper-Fax Bounce into a 32-Day Bilingual Start",
        "Case: 22-month-old · Fresno Tract 06019003103 · Expressive Speech Delay · Spanish Home Language · Medi-Cal · 10.8% Zero-Vehicle",
    )
    add_card(
        s5, 0.65, 2.15, 5.88, 2.55,
        heading="Avoided Historical Bounce Loop: 71 / 45 Days (+26d Breach)",
        heading_color=ROSE, border_color=ROSE,
        bullets=[
            "CHAIN-CA-009: Clinic #01 -> [Fax 12d] -> Desk #09 -> [Fax 22d] -> Saturated Eval #13 -> [Bounce Fax 23d: Bilingual Slot Unavailable] -> Eval #17 -> [EHR 14d] -> Vendor #29.",
        ],
    )
    add_card(
        s5, 6.80, 2.15, 5.88, 2.55,
        heading="Recommended Compliant Pathway: 32 / 45 Days (13d Buffer)",
        heading_color=GREEN, border_color=GREEN,
        bullets=[
            "Fresno Clinic #05 -> [12d] -> Bilingual Desk #09 -> [EHR 12d] -> Fresno Bilingual Eval #17 (Medi-Cal ✓) -> [EHR 8d] -> Bilingual Therapy Vendor #28 (Part C ✓).",
        ],
    )
    add_card(
        s5, 0.65, 4.95, 12.03, 1.62,
        heading="Operational Guardrails & Plain-Language Bilingual Caregiver Note",
        bullets=[
            "Zero-Vehicle Guardrail: Tract 06019003103 has 10.8% zero-vehicle households—automatically authorizes Medi-Cal NEMT transport or hybrid tele-assessment.",
            "Caregiver Action Note: Generates jargon-free English & Español next-step timelines ready to text or hand to parents.",
        ],
    )
    add_footer(s5, "Every candidate hop verified for accepts_medicaid = TRUE, bilingual_services_listed = TRUE, and part_c_vendor_enrolled = TRUE", 5)
    set_notes(s5, "Walk through the side-by-side path comparison shown in Card 1 of the Workbench: 71-day 4-hop bounce avoided vs 32-day compliant 3-hop path.")

    # ---------------- SLIDE 6 ----------------
    s6 = prs.slides.add_slide(blank)
    set_slide_bg(s6)
    add_header(
        s6,
        "Track 2 + Bonus · Counterfactual Network Simulation",
        "Targeted ROI: What Fixing One Coordinator Hub Achieves",
        "Simulating upgrading SYN-PROV-CA-011 (Fresno Desk #11) from paper_fax to electronic EHR intake + pre-checked bilingual slots",
    )
    add_card(
        s6, 0.65, 2.2, 3.85, 3.0,
        big_num="9 / 9", big_color=GREEN,
        heading="Hub Breaches Rescued",
        body="100% of breached multi-hop episodes passing through Fresno Desk #11 drop into <=45-day statutory compliance.",
        border_color=GREEN,
    )
    add_card(
        s6, 4.74, 2.2, 3.85, 3.0,
        big_num="282 Days", big_color=CYAN,
        heading="Delayed Child-Days Saved",
        body="Eliminates wasted 23-day hop-3 re-referral bounces and reduces per-handoff wait lag by ~32% (from 19.5d fax average to 13.3d EHR).",
        border_color=CYAN,
    )
    add_card(
        s6, 8.83, 2.2, 3.85, 3.0,
        big_num="26 -> 17", big_color=AMBER,
        heading="Statewide Breaches (-35%)",
        body="Cuts statewide >45-day violations by more than a third by modernizing 1 of 30 nodes—before hiring additional clinicians.",
        border_color=AMBER,
    )
    add_card(
        s6, 0.65, 5.45, 12.03, 1.12,
        heading="Why State Part C Quality Leads Use This",
        body="Transforms quarterly compliance auditing from retrospective blame into ranked, surgical infrastructure investments.",
    )
    add_footer(s6, "Counterfactual computed directly over traversed ReferralHandoff chains in BigQuery ReferralGraph", 6)
    set_notes(s6, "This hits the +10 Bonus criteria: counterfactual bottleneck simulation quantifying exact child-days saved from fixing a single bounce hub.")

    # ---------------- SLIDE 7 ----------------
    s7 = prs.slides.add_slide(blank)
    set_slide_bg(s7)
    add_header(
        s7,
        "Rigor, Validation Discipline & Post-Output Equity Audit (25 Pts)",
        "Four Planted Data Traps Caught & Who Bottlenecks Land On",
        "Verified continuously by 14 automated offline & live BigQuery E2E tests (sahuja/tests/)",
    )
    add_card(
        s7, 0.65, 2.15, 5.88, 4.35,
        heading="Validation & Bias Guardrails Enforced",
        heading_color=CYAN, border_color=CYAN,
        bullets=[
            "ACS All-Zero Column Trap: Confirmed limited_english_rate = 0.0 across all 101 CA tracts; routed via bilingual_services_listed + NSCH strata instead.",
            "NSCH 6x Grain Trap: Queried 6 Statewide HRSA NSCH strata without joining on state_code so census tracts never duplicate 6x.",
            "Chain Correlation: Enforced single case_chain_id across historical -{2,4}-> GQL hops.",
            "Zero Race-in-Routing: Unit-tested guarantee that zero audit_* columns appear inside routing rules.",
        ],
    )
    add_card(
        s7, 6.80, 2.15, 5.88, 4.35,
        heading="Post-Output Equity Audit & Screening Outreach (CA)",
        heading_color=AMBER, border_color=AMBER,
        bullets=[
            "Episode Delay Gap: Breached chains (n=26) average 61.8 wait days vs. 35.7 days for timely chains (n=18).",
            "Impacted Neighborhoods: Breaches hit tracts averaging 25.0% poverty, 10.8% zero-vehicle households (vs. 9.6% timely), and 53.3% Hispanic share.",
            "Statewide Screening Disparity: NSCH shows non-English primary households screened at roughly half the rate of English-primary homes.",
            "Responsible Outreach: Ranks mobile screening tracts only where <=45d downstream bilingual Medi-Cal capacity is verified.",
        ],
    )
    add_footer(s7, "audit_* columns joined strictly post-output to measure disparity without introducing demographic routing bias", 7)
    set_notes(s7, "Explicitly walk judges through all 4 rigor checks—this is 25% of the total rubric score.")

    # ---------------- SLIDE 8 ----------------
    s8 = prs.slides.add_slide(blank)
    set_slide_bg(s8)
    add_header(
        s8,
        "Limitations, Operational Judgment & Next Steps",
        "Knowing What a Property Graph Cannot Solve Alone",
        "Honest engineering & clinical boundaries for production Department of Developmental Services rollout",
    )
    add_card(
        s8, 0.65, 2.2, 3.85, 3.3,
        heading="1. Real-Time Slot Locking",
        heading_color=AMBER,
        body="ReferralGraph exposes structural routing lag from historical logs. Production multi-coordinator intake requires transactional slot locks (Cloud SQL or Firestore) so two coordinators never double-book the last bilingual evaluation slot.",
    )
    add_card(
        s8, 4.74, 2.2, 3.85, 3.3,
        heading="2. Public Transit vs. Straight-Line km",
        heading_color=AMBER,
        body="ST_DISTANCE computes spherical distance between tract centroids and clinics. Zero-vehicle caregivers need public GTFS bus travel-time feeds and co-located WIC / Head Start mobile evaluation days.",
    )
    add_card(
        s8, 8.83, 2.2, 3.85, 3.3,
        heading="3. Clinical & Family Readiness",
        heading_color=AMBER,
        body="A graph exposes where packets bounce—it never diagnoses children, replaces clinical multidisciplinary judgment, or overrides family-initiated scheduling pauses (ifsp_delayed_family_count).",
    )
    add_card(
        s8, 0.65, 5.72, 12.03, 0.88,
        heading="First Milestones · Turning 71-Day Paper-Fax Bounces into <=45-Day Early Starts",
        body="Live on Google Cloud Run · Python ADK · Google-Managed BigQuery MCP · BigQuery Property Graphs (ISO GQL)",
    )
    add_footer(s8, "github.com/mochiyaki/A4I2026-challenge-early-intervention (branch: sahuja)", 8)
    set_notes(s8, "Close on honest operational judgment: knowing what graphs reveal vs where transactional state, transit feeds, and human clinicians take over.")

    prs.save(str(OUT_PATH))
    return OUT_PATH


if __name__ == "__main__":
    saved = build_deck()
    print(f"Generated {saved} ({saved.stat().st_size:,} bytes)")
