#!/usr/bin/env python3
"""Automated <=3:00 Narrated Screen-Share Demo Video Generator for First Milestones.

Records a 1440x900 Playwright screen-share walkthrough of the Split-Pane Coordinator
Workbench synchronized with macOS `/usr/bin/say` per-scene narration clips and muxes
an H.264 + AAC `.mp4` (`presentation/first_milestones_demo.mp4`) strictly between
90 and 175 seconds (guaranteed <= 180.0s).

Usage:
    .venv/bin/python scripts/record_demo_video.py
    .venv/bin/python scripts/record_demo_video.py --url http://127.0.0.1:8080
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

from playwright.sync_api import Page, sync_playwright

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "presentation" / "first_milestones_demo.mp4"

# Five tightly scripted narration scenes (~365 spoken words total -> ~145s total runtime)
SCENES: list[dict[str, Any]] = [
    {
        "id": "scene_01_intro",
        "title": "Statutory 45-Day Clock, 100% Synthetic Governance & MS Baseline",
        "narration": (
            "Under federal IDEA Part C, toddlers with developmental delays must receive an evaluation "
            "and family service plan within forty-five calendar days, before aging out at thirty-six months. "
            "Welcome to First Milestones. Every provider S Y N dash P R O V and referral chain shown on screen "
            "is one hundred percent synthetic, anchored to real US Census tracts. "
            "In Mississippi, twenty-six of forty-four referral episodes breach the forty-five-day mandate, "
            "and Upper Delta intake reaches only fifty-two-point-five percent timely plans."
        ),
        "pad_after_sec": 1.5,
    },
    {
        "id": "scene_02_track1_triage",
        "title": "Track 1: 32-Month Autism Triage, Cytoscape Topology & Español Note",
        "narration": (
            "Let's run Track One for a thirty-two-month-old toddler in Coahoma County needing an autism evaluation, "
            "Medicaid, Spanish support, and transportation. Historically, chain M S zero two three bounced across "
            "four paper-fax hops for seventy-five days, reaching therapy at thirty-four-point-five months, "
            "dangerously close to the thirty-six-month cliff. "
            "Our hierarchical ADK coordinator delegates to specialist sub-agents over BigQuery Property Graph "
            "and renders the live Cytoscape referral topology—routing an electronic three-hop corridor in "
            "thirty-four days, eleven days ahead of the federal deadline, with free Medicaid N E M T rides. "
            "With one click, the Caregiver Action Note switches into Spanish."
        ),
        "pad_after_sec": 1.5,
    },
    {
        "id": "scene_03_track2_audit_sim",
        "title": "Track 2: Hidden Bounce Hub Audit & Fax-to-EHR Counterfactual Simulator",
        "narration": (
            "Switching to Track Two: why do flat SQL waitlists miss the real bottleneck? "
            "Sorting by waitlist blames busy downstream clinics, while Indianola intake hub M S zero one one "
            "looks fast with a five-day internal wait. Yet variable-length ISO G Q L correlated on case chain I D "
            "and prefix-deduplicated reveals seven of its eleven episodes breach forty-five days due to paper-fax "
            "slot mismatches. Running our counterfactual simulator—upgrading just M S zero one one to electronic "
            "E H R intake with bilingual slot pre-checks—eliminates five breaches and saves two hundred twenty-nine "
            "delayed child-days."
        ),
        "pad_after_sec": 1.5,
    },
    {
        "id": "scene_04_track3_equity",
        "title": "Track 3: Hidden EI Deserts, Post-Output Equity Audit & Data Rigor",
        "narration": (
            "In Track Three, we uncover twenty-one Hidden Early Intervention Deserts—like Bolivar tract "
            "two eight zero one one nine five zero one zero zero, just two-point-one kilometers from a clinic "
            "yet with zero reachable forty-five-day bilingual pathways. Race and ethnicity audit shares are "
            "strictly excluded from routing and checked post-output. Our guardrails also catch the all-zero "
            "A C S limited-english-rate column and preserve statewide H R S A screening grain without six-times "
            "tract fan-out."
        ),
        "pad_after_sec": 1.5,
    },
    {
        "id": "scene_05_multistate_gql",
        "title": "Live California ('06...') Multi-State Switch & ISO GQL Inspector",
        "narration": (
            "Finally, switching live to California preserves leading-zero zero-six F I P S strings across "
            "one hundred one tracts and forty-one thousand children, while the ISO G Q L Inspector exposes "
            "every correlated BigQuery Property Graph query. Deployed on Cloud Run and Vertex AI Agent Engine, "
            "First Milestones protects every child's forty-five-day window."
        ),
        "pad_after_sec": 1.8,
    },
]


def _resolve_binary(preferred: str, fallback_name: str) -> str:
    if Path(preferred).is_file() and os.access(preferred, os.X_OK):
        return preferred
    found = shutil.which(fallback_name)
    if not found:
        raise RuntimeError(f"Required binary '{fallback_name}' not found (checked {preferred}).")
    return found


def _probe_duration_seconds(ffprobe_bin: str, media_path: Path) -> float:
    out = subprocess.check_output(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(media_path),
        ],
        text=True,
    ).strip()
    return float(out)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_for_server(base_url: str, timeout_sec: float = 35.0) -> None:
    deadline = time.monotonic() + timeout_sec
    health_url = f"{base_url.rstrip('/')}/api/health"
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=3.0) as resp:
                if resp.status == 200:
                    return
        except Exception as exc:  # noqa: BLE001
            last_err = exc
        time.sleep(0.4)
    raise RuntimeError(f"Workbench server did not become healthy at {health_url}: {last_err}")


def _synthesize_scene_clips(
    say_bin: str,
    ffmpeg_bin: str,
    ffprobe_bin: str,
    work_dir: Path,
    voice: str,
    rate_wpm: int,
) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    for idx, scene in enumerate(SCENES):
        raw_aiff = work_dir / f"{idx:02d}_{scene['id']}.aiff"
        wav_path = work_dir / f"{idx:02d}_{scene['id']}.wav"

        say_cmd = [say_bin, "-v", voice, "-r", str(rate_wpm), "-o", str(raw_aiff), scene["narration"]]
        res = subprocess.run(say_cmd, capture_output=True, text=True, check=False)
        if res.returncode != 0:
            # Fallback to system default voice if named voice is not installed
            subprocess.run(
                [say_bin, "-r", str(rate_wpm), "-o", str(raw_aiff), scene["narration"]],
                check=True,
            )

        subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-i",
                str(raw_aiff),
                "-ar",
                "44100",
                "-ac",
                "1",
                str(wav_path),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        speech_dur = _probe_duration_seconds(ffprobe_bin, wav_path)
        target_window = speech_dur + float(scene.get("pad_after_sec", 1.2))
        prepared.append(
            {
                **scene,
                "wav_path": wav_path,
                "speech_duration": speech_dur,
                "target_window": target_window,
            }
        )
    return prepared


def _safe_click(page: Page, selector: str, timeout_ms: int = 3500) -> bool:
    try:
        loc = page.locator(selector).first
        if loc.count() > 0 and loc.is_visible(timeout=timeout_ms):
            loc.scroll_into_view_if_needed(timeout=timeout_ms)
            loc.click(timeout=timeout_ms)
            return True
    except Exception:  # noqa: BLE001
        return False
    return False


def _smooth_scroll_container(page: Page, selector: str, top_px: int) -> None:
    try:
        page.evaluate(
            """([sel, y]) => {
                const el = document.querySelector(sel);
                if (el) el.scrollTo({ top: y, behavior: 'smooth' });
            }""",
            [selector, top_px],
        )
    except Exception:  # noqa: BLE001
        pass


def _sleep_until(deadline_monotonic: float) -> None:
    remaining = deadline_monotonic - time.monotonic()
    if remaining > 0:
        time.sleep(remaining)


def _install_visual_click_cue(page: Page) -> None:
    """Adds a clean Medical Clean (#0F766E) click-ring highlight for recorded clarity."""
    page.add_Init_script = getattr(page, "add_init_script", None)
    try:
        page.evaluate(
            """() => {
                const style = document.createElement('style');
                style.textContent = `
                  .demo-click-ring {
                    position: fixed;
                    width: 28px;
                    height: 28px;
                    margin-left: -14px;
                    margin-top: -14px;
                    border: 2.5px solid #0F766E;
                    border-radius: 50%;
                    pointer-events: none;
                    z-index: 99999;
                    animation: demoPulse 0.55s ease-out forwards;
                  }
                  @keyframes demoPulse {
                    0% { transform: scale(0.5); opacity: 0.95; }
                    100% { transform: scale(1.9); opacity: 0; }
                  }
                `;
                document.head.appendChild(style);
                document.addEventListener('click', (ev) => {
                  const ring = document.createElement('div');
                  ring.className = 'demo-click-ring';
                  ring.style.left = ev.clientX + 'px';
                  ring.style.top = ev.clientY + 'px';
                  document.body.appendChild(ring);
                  setTimeout(() => ring.remove(), 600);
                }, true);
            }"""
        )
    except Exception:  # noqa: BLE001
        pass


def record_walkthrough(
    base_url: str,
    prepared_scenes: list[dict[str, Any]],
    video_dir: Path,
) -> tuple[Path, list[float], float]:
    scene_offsets_sec: list[float] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            record_video_dir=str(video_dir),
            record_video_size={"width": 1440, "height": 900},
            device_scale_factor=1,
        )
        video_start = time.monotonic()
        page = context.new_page()
        page.goto(base_url, wait_until="domcontentloaded", timeout=30000)
        _install_visual_click_cue(page)
        try:
            page.wait_for_selector("#kpiStrip", timeout=12000)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.2)

        # ------------------------------------------------------------------
        # SCENE 1: Header governance, KPIs & Pathway overview
        # ------------------------------------------------------------------
        s0 = prepared_scenes[0]
        t0 = time.monotonic()
        scene_offsets_sec.append(max(0.0, t0 - video_start))
        deadline = t0 + s0["target_window"]

        time.sleep(min(4.0, s0["target_window"] * 0.25))
        _smooth_scroll_container(page, ".triage-workspace", 180)
        time.sleep(min(4.0, s0["target_window"] * 0.25))
        _smooth_scroll_container(page, ".triage-workspace", 0)
        _sleep_until(deadline)

        # ------------------------------------------------------------------
        # SCENE 2: Track 1 32m Triage + Cytoscape filters + Español Caregiver Note
        # ------------------------------------------------------------------
        s1 = prepared_scenes[1]
        t1 = time.monotonic()
        scene_offsets_sec.append(t1 - video_start)
        deadline = t1 + s1["target_window"]

        _safe_click(page, '#tabPathwayBtn')
        _safe_click(page, '[data-preset="triage"]')
        time.sleep(4.5)

        # Interact with Cytoscape filter buttons if present
        if _safe_click(page, '[data-cy-filter="bounce"]'):
            time.sleep(2.4)
        if _safe_click(page, '[data-cy-filter="compliant"]'):
            time.sleep(2.4)
        _safe_click(page, '[data-cy-filter="all"]')
        time.sleep(2.0)

        # Scroll down to 45-day clock meter & Caregiver Action Note and switch to Español
        _smooth_scroll_container(page, ".triage-workspace", 520)
        time.sleep(3.0)
        _smooth_scroll_container(page, ".triage-workspace", 980)
        time.sleep(2.5)
        _safe_click(page, '[data-lang="spanish"]')
        time.sleep(2.0)
        _sleep_until(deadline)

        # ------------------------------------------------------------------
        # SCENE 3: Track 2 Bounce Hub Audit & Fax-to-EHR Counterfactual Simulator
        # ------------------------------------------------------------------
        s2 = prepared_scenes[2]
        t2 = time.monotonic()
        scene_offsets_sec.append(t2 - video_start)
        deadline = t2 + s2["target_window"]

        _safe_click(page, "#tabHubsBtn")
        _smooth_scroll_container(page, ".triage-workspace", 0)
        time.sleep(3.5)
        _smooth_scroll_container(page, ".triage-workspace", 360)
        time.sleep(4.0)
        _smooth_scroll_container(page, ".triage-workspace", 0)
        time.sleep(1.5)
        _safe_click(page, "#runSimBtn")
        time.sleep(4.0)
        _sleep_until(deadline)

        # ------------------------------------------------------------------
        # SCENE 4: Track 3 Hidden EI Deserts, Post-Output Equity & Data Guardrails
        # ------------------------------------------------------------------
        s3 = prepared_scenes[3]
        t3 = time.monotonic()
        scene_offsets_sec.append(t3 - video_start)
        deadline = t3 + s3["target_window"]

        _safe_click(page, "#tabOutreachBtn")
        _smooth_scroll_container(page, ".triage-workspace", 0)
        time.sleep(4.0)
        _smooth_scroll_container(page, ".triage-workspace", 360)
        time.sleep(4.0)
        _smooth_scroll_container(page, ".triage-workspace", 760)
        time.sleep(3.5)
        _sleep_until(deadline)

        # ------------------------------------------------------------------
        # SCENE 5: California ('06...') Multi-State Switch & ISO GQL Inspector
        # ------------------------------------------------------------------
        s4 = prepared_scenes[4]
        t4 = time.monotonic()
        scene_offsets_sec.append(t4 - video_start)
        deadline = t4 + s4["target_window"]

        _smooth_scroll_container(page, ".triage-workspace", 0)
        try:
            state_sel = page.locator("#stateSelect")
            if state_sel.count() > 0:
                state_sel.select_option("CA")
        except Exception:  # noqa: BLE001
            pass
        time.sleep(4.0)

        if _safe_click(page, "#toggleGqlBtn"):
            time.sleep(2.4)
            _safe_click(page, '[data-gql="audit"]')
            time.sleep(2.2)
            _safe_click(page, '[data-gql="outreach"]')
            time.sleep(2.0)
            _safe_click(page, "#closeGqlBtn")

        _sleep_until(deadline)
        total_elapsed = time.monotonic() - video_start

        video_obj = page.video
        context.close()
        browser.close()

        if video_obj is None:
            raise RuntimeError("Playwright did not produce a recorded video object.")
        webm_path = Path(video_obj.path())

    return webm_path, scene_offsets_sec, total_elapsed


def mux_video_and_narration(
    ffmpeg_bin: str,
    ffprobe_bin: str,
    webm_path: Path,
    prepared_scenes: list[dict[str, Any]],
    scene_offsets_sec: list[float],
    output_mp4: Path,
    max_duration_sec: float = 175.0,
) -> dict[str, Any]:
    output_mp4.parent.mkdir(parents=True, exist_ok=True)
    raw_video_dur = _probe_duration_seconds(ffprobe_bin, webm_path)
    final_dur = min(raw_video_dur, max_duration_sec)

    cmd: list[str] = [ffmpeg_bin, "-y", "-i", str(webm_path)]
    filter_parts: list[str] = []
    mix_labels: list[str] = []

    for idx, (scene, offset_s) in enumerate(zip(prepared_scenes, scene_offsets_sec, strict=True)):
        cmd.extend(["-i", str(scene["wav_path"])])
        delay_ms = max(0, int(round(offset_s * 1000)))
        in_idx = idx + 1
        out_label = f"a{idx}"
        filter_parts.append(f"[{in_idx}:a]adelay={delay_ms}|{delay_ms},volume=1.0[{out_label}]")
        mix_labels.append(f"[{out_label}]")

    n_clips = len(prepared_scenes)
    # normalize=0 prevents amix from dividing each voice clip's volume by 1/N!
    filter_parts.append(
        f"{''.join(mix_labels)}amix=inputs={n_clips}:duration=longest:dropout_transition=0:normalize=0,"
        f"apad=whole_dur={final_dur:.2f}[aout]"
    )
    filter_complex = ";".join(filter_parts)

    cmd.extend(
        [
            "-filter_complex",
            filter_complex,
            "-map",
            "0:v:0",
            "-map",
            "[aout]",
            "-t",
            f"{final_dur:.2f}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "high",
            "-preset",
            "fast",
            "-crf",
            "22",
            "-r",
            "24",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ar",
            "44100",
            "-movflags",
            "+faststart",
            str(output_mp4),
        ]
    )
    subprocess.run(cmd, check=True)

    probe_json = json.loads(
        subprocess.check_output(
            [
                ffprobe_bin,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(output_mp4),
            ],
            text=True,
        )
    )
    return probe_json


def main() -> int:
    parser = argparse.ArgumentParser(description="Record <=3:00 narrated First Milestones demo MP4.")
    parser.add_argument("--url", default="", help="Existing Workbench URL (auto-starts local server if omitted).")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Output MP4 path.")
    parser.add_argument("--voice", default="Samantha", help="macOS /usr/bin/say voice name.")
    parser.add_argument("--rate", type=int, default=172, help="Speech rate in words per minute.")
    parser.add_argument(
        "--local-fallback",
        action="store_true",
        default=False,
        help="Set A4I_FORCE_LOCAL_FALLBACK=1 when auto-starting local server.",
    )
    args = parser.parse_args()

    say_bin = _resolve_binary("/usr/bin/say", "say")
    ffmpeg_bin = _resolve_binary("/opt/homebrew/bin/ffmpeg", "ffmpeg")
    ffprobe_bin = _resolve_binary("/opt/homebrew/bin/ffprobe", "ffprobe")
    output_mp4 = Path(args.output).resolve()

    server_proc: subprocess.Popen[str] | None = None
    base_url = args.url.strip()

    try:
        if not base_url:
            port = _find_free_port()
            base_url = f"http://127.0.0.1:{port}"
            env = os.environ.copy()
            env["PORT"] = str(port)
            env.setdefault("A4I_STATE", "MS")
            if args.local_fallback:
                env["A4I_FORCE_LOCAL_FALLBACK"] = "1"
            print(f"[1/4] Launching local First Milestones Workbench at {base_url} ...")
            server_proc = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "main:app",
                    "--app-dir",
                    str(REPO_ROOT / "agent"),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                ],
                cwd=str(REPO_ROOT),
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            _wait_for_server(base_url, timeout_sec=40.0)
        else:
            print(f"[1/4] Connecting to existing First Milestones Workbench at {base_url} ...")
            _wait_for_server(base_url, timeout_sec=20.0)

        with tempfile.TemporaryDirectory(prefix="first_milestones_demo_") as tmp:
            work_dir = Path(tmp)
            video_dir = work_dir / "video"
            video_dir.mkdir(parents=True, exist_ok=True)

            print(f"[2/4] Synthesizing 5 narration clips via {say_bin} (voice={args.voice}, rate={args.rate} WPM)...")
            prepared = _synthesize_scene_clips(
                say_bin=say_bin,
                ffmpeg_bin=ffmpeg_bin,
                ffprobe_bin=ffprobe_bin,
                work_dir=work_dir,
                voice=args.voice,
                rate_wpm=args.rate,
            )
            est_total = sum(s["target_window"] for s in prepared)
            print(f"      Estimated walkthrough duration: {est_total:.1f}s (budget: 90s - 175s)")

            print("[3/4] Recording live 1440x900 Playwright walkthrough across all 3 tracks + CA switch + GQL modal...")
            webm_path, offsets, wall_elapsed = record_walkthrough(
                base_url=base_url,
                prepared_scenes=prepared,
                video_dir=video_dir,
            )
            print(f"      Recorded raw WebM ({wall_elapsed:.1f}s): {webm_path.name}")

            print(f"[4/4] Encoding H.264 + AAC MP4 to {output_mp4} ...")
            probe = mux_video_and_narration(
                ffmpeg_bin=ffmpeg_bin,
                ffprobe_bin=ffprobe_bin,
                webm_path=webm_path,
                prepared_scenes=prepared,
                scene_offsets_sec=offsets,
                output_mp4=output_mp4,
                max_duration_sec=175.0,
            )

        dur = float(probe["format"]["duration"])
        codecs = {s["codec_type"]: s["codec_name"] for s in probe.get("streams", [])}
        size_mb = output_mp4.stat().st_size / (1024 * 1024)
        print(
            f"Done! {output_mp4} ({size_mb:.2f} MB, duration={dur:.2f}s, "
            f"video={codecs.get('video')}, audio={codecs.get('audio')})"
        )
        if not (90.0 <= dur <= 175.5):
            raise RuntimeError(f"Output duration {dur:.2f}s fell outside required [90s, 175s] window!")
        return 0
    finally:
        if server_proc is not None and server_proc.poll() is None:
            server_proc.terminate()
            try:
                server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
