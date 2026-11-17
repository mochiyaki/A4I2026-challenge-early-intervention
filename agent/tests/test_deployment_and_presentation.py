"""Comprehensive tests for Agent Engine & Cloud Run deployment surfaces, Executive Pitch Deck,
3-minute Demo Narration Script, and Narrated MP4 Demo Video artifact.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_AE_SCRIPT = REPO_ROOT / "scripts" / "deploy_agent_engine.sh"
DEPLOY_CR_SCRIPT = REPO_ROOT / "scripts" / "deploy_cloud_run.sh"
DOCKERFILE_PATH = REPO_ROOT / "Dockerfile"
AGENT_README_PATH = REPO_ROOT / "agent" / "README.md"
PITCH_HTML_PATH = REPO_ROOT / "presentation" / "pitch_deck.html"
PITCH_PDF_PATH = REPO_ROOT / "presentation" / "pitch_deck.pdf"
PITCH_MD_PATH = REPO_ROOT / "presentation" / "PITCH_DECK.md"
DEMO_SCRIPT_MD_PATH = REPO_ROOT / "presentation" / "DEMO_SCRIPT_3MIN.md"
RECORD_VIDEO_SCRIPT = REPO_ROOT / "scripts" / "record_demo_video.py"
DEMO_MP4_PATH = REPO_ROOT / "presentation" / "first_milestones_demo.mp4"


# ---------------------------------------------------------------------------
# 1. Vertex AI Agent Engine & Cloud Run Packaging Tests
# ---------------------------------------------------------------------------


def test_deploy_agent_engine_dry_run_succeeds() -> None:
    assert DEPLOY_AE_SCRIPT.is_file(), f"Missing {DEPLOY_AE_SCRIPT}"
    syntax = subprocess.run(["bash", "-n", str(DEPLOY_AE_SCRIPT)], capture_output=True, text=True, check=False)
    assert syntax.returncode == 0, f"Bash syntax error: {syntax.stderr}"

    env = os.environ.copy()
    py_bin_dir = str(Path(sys.executable).resolve().parent)
    env["PATH"] = f"{py_bin_dir}:{env.get('PATH', '')}"
    res = subprocess.run(
        [
            "bash",
            str(DEPLOY_AE_SCRIPT),
            "--dry-run",
            "--project=test-a4i-project",
            "--region=us-central1",
        ],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert res.returncode == 0, f"--dry-run failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    out = res.stdout
    assert "Dry-run validation succeeded." in out
    assert "deploy agent_engine" in out
    assert "--project=test-a4i-project" in out
    assert "--region=us-central1" in out
    assert "--artifact_service_uri=gs://test-a4i-project-a4i-agent-engine" in out
    assert "--python_version=3.12" in out
    assert "--extra_packages=" in out
    assert "A4I_MULTISTATE_DATASET" in out
    assert "A4I_SUBAGENT_MODEL" in out
    assert "agent/first_milestones" in out


def test_cloud_run_script_and_dockerfile_structure() -> None:
    assert DEPLOY_CR_SCRIPT.is_file(), f"Missing {DEPLOY_CR_SCRIPT}"
    syntax = subprocess.run(["bash", "-n", str(DEPLOY_CR_SCRIPT)], capture_output=True, text=True, check=False)
    assert syntax.returncode == 0, f"Bash syntax error in deploy_cloud_run.sh: {syntax.stderr}"

    cr_text = DEPLOY_CR_SCRIPT.read_text(encoding="utf-8")
    assert "--min-instances=1" in cr_text
    assert "A4I_DATASET=${DATASET}" in cr_text
    assert "a4i_early_intervention" in cr_text
    assert "A4I_MULTISTATE_DATASET=${MULTISTATE_DATASET}" in cr_text
    assert "a4i_early_intervention_multistate" in cr_text
    assert "A4I_SUBAGENT_MODEL=${SUBAGENT_MODEL}" in cr_text
    assert "gemini-2.5-flash" in cr_text

    docker_text = DOCKERFILE_PATH.read_text(encoding="utf-8")
    assert "FROM python:3.12-slim" in docker_text
    assert "A4I_MULTISTATE_DATASET=a4i_early_intervention_multistate" in docker_text
    assert "A4I_SUBAGENT_MODEL=gemini-2.5-flash" in docker_text
    assert "agent/pyproject.toml" in docker_text
    assert "agent/static/vendor" in docker_text
    assert "COPY data /app/data" in docker_text
    assert "COPY agent /app/agent" in docker_text


def test_agent_readme_documents_multiagent_multistate_and_deployments() -> None:
    readme = AGENT_README_PATH.read_text(encoding="utf-8")
    for required_term in [
        "first_milestones_coordinator",
        "triage_pathway_router",
        "network_bottleneck_auditor",
        "equity_and_caregiver_specialist",
        "schemas.py",
        "Cytoscape",
        "/run",
        "a4i_early_intervention_multistate",
        "06",
        "01",
        "setup_local_adc.sh",
        "deploy_cloud_run.sh",
        "deploy_agent_engine.sh",
    ]:
        assert required_term in readme, f"Missing '{required_term}' in agent/README.md"


# ---------------------------------------------------------------------------
# 2. Executive Pitch Deck (HTML + PDF + Markdown) Tests
# ---------------------------------------------------------------------------


FORBIDDEN_VIOLET_HEXES = {
    "#8b5cf6",
    "#7c3aed",
    "#6d28d9",
    "#a855f7",
    "#9333ea",
    "#c084fc",
    "#d8b4fe",
    "#e9d5ff",
    "#f3e8ff",
    "#6366f1",
    "#4f46e5",
}

EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F5FF"
    "\U0001F600-\U0001F64F"
    "\U0001F680-\U0001F6FF"
    "\U0001F700-\U0001F77F"
    "\U0001F900-\U0001F9FF"
    "\U0001FA70-\U0001FAFF"
    "\u2600-\u26FF"
    "\u2700-\u27BF"
    "]+",
    flags=re.UNICODE,
)


def test_pitch_deck_html_ground_truth_and_aesthetic_source() -> None:
    assert PITCH_HTML_PATH.is_file(), f"Missing {PITCH_HTML_PATH}"
    html = PITCH_HTML_PATH.read_text(encoding="utf-8")
    lower_html = html.lower()

    for bad_hex in FORBIDDEN_VIOLET_HEXES:
        assert bad_hex not in lower_html, f"Forbidden violet/lavender color {bad_hex} found in pitch_deck.html"
    for bad_word in ["violet", "lavender", "purple", "indigo"]:
        assert bad_word not in lower_html, f"Forbidden color keyword '{bad_word}' found in pitch_deck.html"

    assert not EMOJI_RE.search(html), "Emoji characters are forbidden in pitch_deck.html (use crisp inline SVGs)"

    # Medical Clean palette tokens
    for expected_hex in ["#0f766e", "#0f172a", "#15803d", "#b91c1c", "#f8fafc"]:
        assert expected_hex in lower_html, f"Expected Medical Clean palette token {expected_hex} in pitch_deck.html"

    # Explicit 100% [Synthetic] provenance & verified ground-truth numbers
    for fact in [
        "100% [Synthetic]",
        "SYN-PROV-",
        "SYN-PARTC-",
        "44",
        "26",
        "CHAIN-MS-023",
        "75",
        "34",
        "SYN-PROV-MS-011",
        "229",
        "52.5%",
        "06",
        "41,144",
        "101",
    ]:
        assert fact in html, f"Missing ground-truth fact '{fact}' in pitch_deck.html"


def test_pitch_deck_renders_all_10_slides_in_playwright_zero_errors_zero_overflow() -> None:
    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))

        page.goto(PITCH_HTML_PATH.resolve().as_uri(), wait_until="domcontentloaded")
        slide_count = page.locator("section.slide").count()
        assert slide_count == 10, f"Expected 10 slides, found {slide_count}"
        assert page.locator("#slideCounter").inner_text().strip() == "01 / 10"

        # Test keyboard navigation
        page.keyboard.press("ArrowRight")
        assert page.locator("#slideCounter").inner_text().strip() == "02 / 10"
        page.keyboard.press("ArrowLeft")
        assert page.locator("#slideCounter").inner_text().strip() == "01 / 10"

        for idx in range(slide_count):
            page.evaluate(f"window.firstMilestonesDeck.goTo({idx})")
            metrics = page.evaluate(
                """() => {
                    const doc = document.documentElement;
                    const body = document.body;
                    const slide = document.querySelector('section.slide.active');
                    return {
                        docOverflowX: doc.scrollWidth > doc.clientWidth,
                        bodyOverflowX: body.scrollWidth > body.clientWidth,
                        slideOverflowX: slide.scrollWidth > slide.clientWidth,
                        slideOverflowY: slide.scrollHeight > slide.clientHeight + 2,
                        counter: document.getElementById('slideCounter').textContent.trim(),
                    };
                }"""
            )
            assert metrics["counter"] == f"{idx + 1:02d} / 10"
            assert not metrics["docOverflowX"], f"Document horizontal overflow on slide {idx + 1}"
            assert not metrics["bodyOverflowX"], f"Body horizontal overflow on slide {idx + 1}"
            assert not metrics["slideOverflowX"], f"Slide horizontal overflow on slide {idx + 1}"
            assert not metrics["slideOverflowY"], f"Slide vertical clipping/overflow on slide {idx + 1}"

        browser.close()

    assert not console_errors, f"Browser console errors: {console_errors}"
    assert not page_errors, f"Browser page errors: {page_errors}"


def test_pitch_deck_pdf_is_valid_10_page_document() -> None:
    assert PITCH_PDF_PATH.is_file(), f"Missing exported {PITCH_PDF_PATH}"
    raw = PITCH_PDF_PATH.read_bytes()
    assert raw.startswith(b"%PDF-"), "pitch_deck.pdf does not have a valid %PDF- header"
    assert len(raw) > 50_000, f"pitch_deck.pdf looks unexpectedly small ({len(raw)} bytes)"
    page_markers = re.findall(rb"/Type\s*/Page\b", raw)
    assert len(page_markers) == 10, f"Expected 10 PDF pages in pitch_deck.pdf, found {len(page_markers)}"


def test_pitch_deck_markdown_exists_and_complete() -> None:
    assert PITCH_MD_PATH.is_file(), f"Missing {PITCH_MD_PATH}"
    md = PITCH_MD_PATH.read_text(encoding="utf-8")
    for slide_num in range(1, 11):
        assert f"## Slide {slide_num} " in md, f"Missing Slide {slide_num} heading in PITCH_DECK.md"
    assert "Presenter Note:" in md
    assert "CHAIN-MS-023" in md
    assert "SYN-PROV-MS-011" in md
    assert "100% [Synthetic]" in md


# ---------------------------------------------------------------------------
# 3. 3-Minute Demo Script & Narrated MP4 Video Generator Tests
# ---------------------------------------------------------------------------


def test_demo_script_3min_covers_all_tracks_ethics_traps_and_word_budget() -> None:
    assert DEMO_SCRIPT_MD_PATH.is_file(), f"Missing {DEMO_SCRIPT_MD_PATH}"
    text = DEMO_SCRIPT_MD_PATH.read_text(encoding="utf-8")

    for required in [
        "Track 1",
        "Track 2",
        "Track 3",
        "synthetic",
        "SYN-PROV-",
        "CHAIN-MS-023",
        "SYN-PROV-MS-011",
        "229",
        "limited_english_rate",
        "NSCH",
        "case_chain_id",
        "California",
        "06",
        "ISO GQL",
    ]:
        assert required.lower() in text.lower(), f"Missing '{required}' in DEMO_SCRIPT_3MIN.md"

    # Extract spoken blockquote lines (`> ...`) and verify word budget <= 450 words (<= 3:00)
    spoken_lines = [
        line.lstrip("> ").strip()
        for line in text.splitlines()
        if line.strip().startswith(">")
    ]
    spoken_text = " ".join(spoken_lines)
    spoken_words = [w for w in re.split(r"\s+", spoken_text) if w]
    assert 220 <= len(spoken_words) <= 450, (
        f"Spoken narration word count ({len(spoken_words)}) must stay between 220 and 450 words for <=3:00 budget"
    )


def test_record_demo_video_script_cli_and_mp4_artifact() -> None:
    assert RECORD_VIDEO_SCRIPT.is_file(), f"Missing {RECORD_VIDEO_SCRIPT}"
    help_res = subprocess.run(
        [sys.executable, str(RECORD_VIDEO_SCRIPT), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert help_res.returncode == 0, f"record_demo_video.py --help failed: {help_res.stderr}"

    if DEMO_MP4_PATH.is_file():
        ffprobe_bin = "/opt/homebrew/bin/ffprobe"
        if not Path(ffprobe_bin).is_file():
            ffprobe_bin = shutil.which("ffprobe") or ""
        assert ffprobe_bin, "ffprobe binary required to inspect first_milestones_demo.mp4"

        probe_raw = subprocess.check_output(
            [
                ffprobe_bin,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(DEMO_MP4_PATH),
            ],
            text=True,
        )
        probe = json.loads(probe_raw)
        streams = {s["codec_type"]: s for s in probe.get("streams", [])}
        assert "video" in streams, "MP4 is missing video stream"
        assert "audio" in streams, "MP4 is missing audio stream"
        assert streams["video"]["codec_name"] == "h264"
        assert streams["audio"]["codec_name"] == "aac"

        duration = float(probe["format"]["duration"])
        assert duration <= 180.0, f"Demo video exceeds 3:00 limit ({duration:.2f}s > 180.0s)"
        assert duration >= 90.0, f"Demo video unexpectedly short ({duration:.2f}s < 90.0s)"
