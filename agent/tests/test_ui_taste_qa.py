#!/usr/bin/env python3
"""Standalone Playwright + Taste-Skill 2.5.1 UI QA Evaluator for First Milestones.

Inspects the live FastAPI / ADK static UI (`agent/main.py`) via headless Chromium
without modifying `index.html`, `styles.css`, or `app.js`.

Runs:
  1. Taste-Skill 2.5.1 Geometric, Visual & Accessibility Evaluators across 4 viewports:
     (1440x900, 1024x768, 768x1024, 390x844)
     - zero_horizontal_overflow (across pathway, hubs, outreach tabs)
     - zero_clipped_path_cards
     - zero_violet_lavender
     - zero_structural_emojis
     - typography_hierarchy_and_readability
     - wcag_contrast_audit
     - touch_target_sizes
     - nesting_and_equal_edges
  2. Interactive Playwright User-Testing Flows at 1440x900 & 390x844:
     - Flow 1: Initial Render + EN/ES Language Toggle + Copy Note
     - Flow 2: State Switcher (MS -> CA -> MS)
     - Flow 3: Sub-Tab Navigation (#tabHubsBtn -> #panelHubs) & Counterfactual Simulation
     - Flow 4: Outreach & Equity Audit Tab (#tabOutreachBtn -> #panelOutreach)
     - Flow 5: Track Scenario Presets & Custom Copilot Chat
     - Flow 6: ISO GQL Modal (#toggleGqlBtn -> #gqlModal -> Escape)
  3. Runtime Health: Zero uncaught pageerrors, console errors, or HTTP >= 400 responses,
     plus desktop/tablet/mobile/tab/modal screenshots.

Usage:
  python agent/tests/test_ui_taste_qa.py
  python agent/tests/test_ui_taste_qa.py --url http://127.0.0.1:8080
  python agent/tests/test_ui_taste_qa.py --port 8766 --out-dir /path/to/screenshots
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright

AGENT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SCREENSHOT_DIR = Path(
    "/Users/sahilfaizal/.gemini/antigravity/brain/b026c1a9-ff8c-4aee-9441-1c35913e204d/scratch/screenshots"
)

VIEWPORTS: list[tuple[str, int, int]] = [
    ("desktop_1440", 1440, 900),
    ("tablet_1024", 1024, 768),
    ("tablet_portrait_768", 768, 1024),
    ("mobile_390", 390, 844),
]

TAB_DEFS: list[tuple[str, str]] = [
    ("pathway", "#tabPathwayBtn"),
    ("hubs", "#tabHubsBtn"),
    ("outreach", "#tabOutreachBtn"),
]


@dataclass
class CheckResult:
    name: str
    passed: bool
    summary: str
    details: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Live Server Lifecycle Helpers
# ---------------------------------------------------------------------------


def wait_for_health(base_url: str, timeout_s: float = 25.0) -> dict[str, Any]:
    """Polls `/api/health` until the uvicorn server is ready."""
    deadline = time.monotonic() + timeout_s
    health_url = f"{base_url.rstrip('/')}/api/health"
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=2.0) as resp:
                if resp.status == 200:
                    return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last_err = exc
        time.sleep(0.25)
    raise RuntimeError(f"Server did not become healthy at {health_url} within {timeout_s}s: {last_err}")


def start_uvicorn_server(port: int) -> subprocess.Popen[bytes]:
    """Boots `uvicorn main:app` on localhost without LLM credentials (deterministic preview)."""
    env = os.environ.copy()
    env.setdefault("A4I_STATE", "MS")
    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "main:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--log-level",
        "warning",
    ]
    return subprocess.Popen(
        cmd,
        cwd=str(AGENT_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def stop_uvicorn_server(proc: subprocess.Popen[bytes] | None) -> None:
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3.0)


# ---------------------------------------------------------------------------
# Browser Page & Network Telemetry Helpers
# ---------------------------------------------------------------------------


class TelemetryCollector:
    def __init__(self) -> None:
        self.page_errors: list[str] = []
        self.console_errors: list[str] = []
        self.http_errors: list[dict[str, Any]] = []

    def attach(self, page: Page) -> None:
        page.on("pageerror", lambda err: self.page_errors.append(str(err)))
        page.on(
            "console",
            lambda msg: self.console_errors.append(msg.text)
            if msg.type == "error"
            else None,
        )
        page.on(
            "response",
            lambda resp: self.http_errors.append(
                {"url": resp.url, "status": resp.status, "method": resp.request.method}
            )
            if resp.status >= 400
            else None,
        )


def open_hydrated_page(
    browser: Browser,
    base_url: str,
    width: int,
    height: int,
    telemetry: TelemetryCollector,
) -> tuple[BrowserContext, Page]:
    """Opens a fresh context/page at (width, height) and waits for `/api/brief` hydration."""
    context = browser.new_context(
        viewport={"width": width, "height": height},
        permissions=["clipboard-read", "clipboard-write"],
    )
    page = context.new_page()
    telemetry.attach(page)

    with page.expect_response(
        lambda r: "/api/brief" in r.url and r.status == 200,
        timeout=15000,
    ):
        page.goto(base_url, wait_until="domcontentloaded", timeout=15000)

    # Wait for initial DOM hydration and Google Fonts
    page.wait_for_selector("#kpiStrip > *", timeout=12000)
    page.wait_for_selector("#bouncePathCanvas .hop-card, #bouncePathCanvas .node-box", timeout=12000)
    page.evaluate("() => document.fonts ? document.fonts.ready : Promise.resolve()")
    page.wait_for_timeout(250)
    return context, page


def _try_switch_tab(page: Page, tab_name: str, selector: str) -> tuple[bool, str | None]:
    """Attempts to switch to a workbench tab if the tab control exists."""
    loc = page.locator(selector)
    if loc.count() == 0:
        if tab_name == "pathway":
            return True, None
        return False, f"Tab selector {selector} missing from DOM"
    btn = loc.first
    if not btn.is_visible():
        return False, f"Tab selector {selector} is not visible"
    btn.click()
    page.wait_for_timeout(150)
    return True, None


# ---------------------------------------------------------------------------
# Taste-Skill 2.5.1 JS Evaluators
# ---------------------------------------------------------------------------

JS_OVERFLOW_CHECK = r"""
() => {
  const vw = window.innerWidth;
  const docSW = document.documentElement.scrollWidth;
  const bodySW = document.body ? document.body.scrollWidth : 0;
  const offenders = [];

  function hasHorizontalScrollAncestor(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      const st = getComputedStyle(cur);
      if (st.overflowX === 'auto' || st.overflowX === 'scroll') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  for (const el of document.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.right > vw + 1 && !hasHorizontalScrollAncestor(el)) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
        right: Math.round(r.right * 10) / 10,
        vw,
      });
      if (offenders.length >= 12) break;
    }
  }
  return {
    innerWidth: vw,
    docScrollWidth: docSW,
    bodyScrollWidth: bodySW,
    passed: docSW <= vw + 1,
    offenders,
  };
}
"""

JS_CLIPPED_PATH_CARDS = r"""
() => {
  const vw = window.innerWidth;
  const canvases = ['#bouncePathCanvas', '#recPathCanvas'];
  const violations = [];
  let totalCards = 0;

  for (const sel of canvases) {
    const canvas = document.querySelector(sel);
    if (!canvas) {
      violations.push({ canvas: sel, issue: 'canvas_missing' });
      continue;
    }
    const cards = canvas.querySelectorAll('.hop-card, .node-box');
    if (cards.length === 0) {
      violations.push({ canvas: sel, issue: 'no_node_cards' });
      continue;
    }
    for (const card of cards) {
      totalCards += 1;
      const r = card.getBoundingClientRect();
      const sw = card.scrollWidth;
      const cw = card.clientWidth;
      const nodeId = (card.querySelector('.hop-id, .node-id')?.textContent || '').trim();
      if (sw > cw + 2) {
        violations.push({
          canvas: sel,
          nodeId,
          issue: 'card_internal_overflow',
          scrollWidth: sw,
          clientWidth: cw,
        });
      }
      if (r.right > vw + 1 || r.left < -1) {
        violations.push({
          canvas: sel,
          nodeId,
          issue: 'card_exceeds_viewport',
          left: Math.round(r.left * 10) / 10,
          right: Math.round(r.right * 10) / 10,
          viewportWidth: vw,
        });
      }
    }
  }
  return { totalCards, passed: violations.length === 0, violations };
}
"""

JS_VIOLET_LAVENDER_SCAN = r"""
() => {
  function parseRgba(str) {
    if (!str || str === 'none' || str === 'transparent') return null;
    const m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i);
    if (!m) return null;
    let a = 1;
    if (m[4] !== undefined) {
      a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    if (a <= 0.01) return null;
    return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a };
  }

  function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    if (clean.length === 3) {
      return {
        r: parseInt(clean[0] + clean[0], 16),
        g: parseInt(clean[1] + clean[1], 16),
        b: parseInt(clean[2] + clean[2], 16),
        a: 1,
      };
    }
    if (clean.length === 6) {
      return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16),
        a: 1,
      };
    }
    return null;
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return { h, s, l };
  }

  function isVioletLavender(c) {
    if (!c) return false;
    const { h, s } = rgbToHsl(c.r, c.g, c.b);
    const rgDiff = c.r - c.g;
    const bgDiff = c.b - c.g;
    if (rgDiff > 12 && bgDiff > 24 && c.b >= c.r * 0.72) return true;
    if (s >= 0.18 && h >= 250 && h <= 310 && rgDiff > 6) return true;
    return false;
  }

  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;

    for (const prop of ['color', 'backgroundColor', 'borderTopColor']) {
      const parsed = parseRgba(st[prop]);
      if (isVioletLavender(parsed)) {
        hits.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
          prop,
          value: st[prop],
        });
      }
    }

    if (st.backgroundImage && st.backgroundImage !== 'none') {
      const rgbMatches = st.backgroundImage.match(/rgba?\([^)]+\)/gi) || [];
      for (const m of rgbMatches) {
        if (isVioletLavender(parseRgba(m))) {
          hits.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
            prop: 'backgroundImage',
            value: m,
          });
        }
      }
      const hexMatches = st.backgroundImage.match(/#[0-9a-f]{3,6}\b/gi) || [];
      for (const h of hexMatches) {
        if (isVioletLavender(hexToRgb(h))) {
          hits.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
            prop: 'backgroundImage',
            value: h,
          });
        }
      }
    }
    if (hits.length >= 25) break;
  }
  return { passed: hits.length === 0, count: hits.length, hits };
}
"""

JS_STRUCTURAL_EMOJI_SCAN = r"""
() => {
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const chromeSelectors = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'button', '[role="tab"]', '.badge', '.pill',
    '.chip', '.tab-btn', '.tool-pill', '.guardrail-banner',
    '.preset-label', '.mini-tag', '.lane-meta',
    '.workspace-tab', '.preset-btn', '.lang-btn',
    '.synthetic-pill', '.runtime-badge', '.engine-chip', '.formula-banner'
  ];
  const seen = new Set();
  const hits = [];

  for (const el of document.querySelectorAll(chromeSelectors.join(','))) {
    if (seen.has(el)) continue;
    seen.add(el);
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;

    const txt = (el.innerText || el.textContent || '').trim();
    const matches = txt.match(emojiRe);
    if (matches && matches.length > 0) {
      hits.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
        emojis: Array.from(new Set(matches)),
        textSnippet: txt.slice(0, 80),
      });
    }
  }
  return { passed: hits.length === 0, count: hits.length, hits };
}
"""

JS_TYPOGRAPHY_AUDIT = r"""
() => {
  const loadedFonts = [];
  if (document.fonts) {
    for (const f of document.fonts) {
      if (f.status === 'loaded') {
        loadedFonts.push(f.family.replace(/['"]/g, ''));
      }
    }
  }
  const uniqueLoaded = Array.from(new Set(loadedFonts));
  const hasRequiredGoogleFont = uniqueLoaded.some((fam) =>
    /figtree|noto\s*sans/i.test(fam)
  );

  function getVisibleSizes(sel) {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push(parseFloat(st.fontSize));
    }
    return out;
  }

  const h1Sizes = getVisibleSizes('h1');
  const h2Sizes = getVisibleSizes('h2');
  const h3Sizes = getVisibleSizes('h3');
  const bodyFontSize = parseFloat(getComputedStyle(document.body).fontSize);

  const h1 = h1Sizes.length ? Math.max(...h1Sizes) : 0;
  const h2 = h2Sizes.length ? Math.max(...h2Sizes) : 0;
  const h3 = h3Sizes.length ? Math.max(...h3Sizes) : 0;

  const hierarchyOk = h1 > h2 && h2 >= h3 && h1 > 0 && h2 > 0;
  const bodySizeOk = bodyFontSize >= 14.0;

  // Scan all visible text-bearing elements for sub-11.5px text
  const tinyTextOffenders = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const checkedEls = new Set();
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const el = node.parentElement;
    if (!el || checkedEls.has(el)) continue;
    checkedEls.add(el);
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const fs = parseFloat(st.fontSize);
    if (fs < 11.5) {
      tinyTextOffenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
        fontSizePx: Math.round(fs * 100) / 100,
        textSnippet: node.nodeValue.trim().slice(0, 50),
      });
      if (tinyTextOffenders.length >= 25) break;
    }
  }

  const passed =
    hasRequiredGoogleFont &&
    hierarchyOk &&
    bodySizeOk &&
    tinyTextOffenders.length === 0;

  return {
    passed,
    loadedFonts: uniqueLoaded,
    hasRequiredGoogleFont,
    h1Px: h1,
    h2Px: h2,
    h3Px: h3,
    hierarchyOk,
    bodyFontSizePx: bodyFontSize,
    bodySizeOk,
    tinyTextCount: tinyTextOffenders.length,
    tinyTextOffenders,
  };
}
"""

JS_WCAG_CONTRAST_AUDIT = r"""
() => {
  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'none') return { r: 0, g: 0, b: 0, a: 0 };
    const m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i);
    if (m) {
      let a = 1;
      if (m[4] !== undefined) {
        a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      }
      return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a };
    }
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  function blendOver(fg, bg) {
    const a = fg.a;
    if (a >= 0.999) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: 1,
    };
  }

  function srgbToLinear(c8) {
    const c = c8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function luminance(c) {
    return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
  }

  function contrastRatio(fg, bg) {
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  function effectiveBackground(el) {
    const chain = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      chain.push(cur);
      cur = cur.parentElement;
    }
    chain.reverse();
    let eff = { r: 255, g: 255, b: 255, a: 1 };
    for (const node of chain) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg.a > 0) {
        eff = blendOver(bg, eff);
      }
    }
    return eff;
  }

  const auditSelector = [
    'h1', 'h2', 'h3', 'h4',
    'p', 'li', 'td', 'th',
    'button', 'a', '[role="tab"]',
    '.pill', '.badge', '.mini-tag', '.tool-pill',
    '.synthetic-banner', '.synthetic-banner *',
    '.synthetic-pill', '.synthetic-pill *',
    '.runtime-badge', '.engine-chip', '.context-subtitle', '.card-subtitle',
    '.kpi-chip .kpi-val', '.kpi-chip .kpi-lbl',
    '.kpi-card .kpi-value', '.kpi-card .kpi-label', '.kpi-card .kpi-sub',
    '.hop-type', '.hop-id', '.hop-name', '.hop-edge-badge', '.hop-cum-day',
    '.edge-channel', '.edge-cum', '.formula-banner', '.modal-hint',
    '.guardrail-banner', '.caregiver-note', '.rigor-box',
    'input', 'textarea', 'select', 'label', '.muted-small'
  ].join(',');

  const seen = new Set();
  const failures = [];
  let checkedCount = 0;

  for (const el of document.querySelectorAll(auditSelector)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;

    // Only check elements that directly carry text or are form inputs
    const isFormCtrl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    const hasDirectText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.nodeValue && n.nodeValue.trim().length > 0
    );
    const txt = (el.innerText || el.value || el.textContent || '').trim();
    if (!isFormCtrl && !hasDirectText && el.children.length > 0) continue;
    if (!isFormCtrl && txt.length === 0) continue;

    checkedCount += 1;
    const bg = effectiveBackground(el);
    const rawFg = parseColor(st.color);
    const fg = rawFg.a < 1 ? blendOver(rawFg, bg) : rawFg;
    const ratio = contrastRatio(fg, bg);

    const fontSize = parseFloat(st.fontSize);
    const fontWeight = parseInt(st.fontWeight, 10) || 400;
    const isLarge = fontSize >= 24.0 || (fontSize >= 18.66 && fontWeight >= 700);
    const threshold = isLarge ? 3.0 : 4.5;

    if (ratio < threshold) {
      failures.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
        textSnippet: txt.slice(0, 50),
        fg: `rgb(${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)})`,
        bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
        fontSizePx: Math.round(fontSize * 10) / 10,
        fontWeight,
        threshold,
        ratio: Math.round(ratio * 100) / 100,
      });
    }
  }
  return {
    passed: failures.length === 0,
    checkedCount,
    failureCount: failures.length,
    failures: failures.slice(0, 30),
  };
}
"""

JS_TOUCH_TARGET_AUDIT = r"""
() => {
  const selector = 'button, select, [role="tab"], #chatInput, a[href], input:not([type="hidden"]), textarea';
  const controls = [];

  for (const el of document.querySelectorAll(selector)) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) continue;
    if (el.offsetParent === null && st.position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    controls.push({ el, rect: r });
  }

  const undersized = [];
  const under44 = [];
  for (const c of controls) {
    const h = Math.round(c.rect.height * 10) / 10;
    const w = Math.round(c.rect.width * 10) / 10;
    const label = (c.el.innerText || c.el.getAttribute('aria-label') || c.el.id || c.el.tagName).trim().slice(0, 50);
    const entry = {
      tag: c.el.tagName.toLowerCase(),
      id: c.el.id || null,
      cls: typeof c.el.className === 'string' ? c.el.className.slice(0, 50) : null,
      label,
      width: w,
      height: h,
    };
    if (h < 40.0) {
      undersized.push(entry);
    } else if (h < 44.0) {
      under44.push(entry);
    }
  }

  const overlaps = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const b = controls[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ix = Math.max(0, Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left));
      const iy = Math.max(0, Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top));
      if (ix > 1.5 && iy > 1.5) {
        overlaps.push({
          a: a.el.id || a.el.className || a.el.tagName,
          b: b.el.id || b.el.className || b.el.tagName,
          overlapPx: { w: Math.round(ix * 10) / 10, h: Math.round(iy * 10) / 10 },
        });
      }
    }
  }

  return {
    passed: undersized.length === 0 && overlaps.length === 0,
    totalControls: controls.length,
    undersizedCount: undersized.length,
    undersized,
    under44IdealCount: under44.length,
    under44Ideal: under44,
    overlapCount: overlaps.length,
    overlaps,
  };
}
"""

JS_NESTING_AND_EDGES_AUDIT = r"""
() => {
  function isBorderedSurface(el) {
    const st = getComputedStyle(el);
    const sides = [
      ['borderTopWidth', 'borderTopStyle', 'borderTopColor'],
      ['borderRightWidth', 'borderRightStyle', 'borderRightColor'],
      ['borderBottomWidth', 'borderBottomStyle', 'borderBottomColor'],
      ['borderLeftWidth', 'borderLeftStyle', 'borderLeftColor'],
    ];
    for (const [wP, sP, cP] of sides) {
      const w = parseFloat(st[wP]) || 0;
      const style = st[sP];
      const col = st[cP] || '';
      const alphaMatch = col.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/i);
      const alpha = alphaMatch ? parseFloat(alphaMatch[1]) : 1;
      if (w >= 1 && style !== 'none' && alpha > 0.05) {
        return true;
      }
    }
    return false;
  }

  const deepNestingViolations = [];
  let maxBorderedDepth = 0;

  for (const el of document.querySelectorAll('*')) {
    if (['HTML', 'HEAD', 'SCRIPT', 'STYLE'].includes(el.tagName)) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;

    let borderedCount = 0;
    let maxConsecutive = 0;
    let curConsecutive = 0;
    const chain = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (isBorderedSurface(cur)) {
        borderedCount += 1;
        curConsecutive += 1;
        maxConsecutive = Math.max(maxConsecutive, curConsecutive);
        chain.push((cur.id ? '#' + cur.id : cur.tagName.toLowerCase()) + (cur.className && typeof cur.className === 'string' ? '.' + cur.className.trim().split(/\s+/).join('.') : ''));
      } else {
        curConsecutive = 0;
      }
      cur = cur.parentElement;
    }

    if (borderedCount > maxBorderedDepth) maxBorderedDepth = borderedCount;
    if (borderedCount > 3) {
      deepNestingViolations.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
        borderedAncestors: borderedCount,
        maxConsecutive,
        chain: chain.reverse(),
      });
      if (deepNestingViolations.length >= 15) break;
    }
  }

  // Outer container alignment & card equal-edges check
  const edgeIssues = [];
  const vw = window.innerWidth;
  const topbar = document.querySelector('.topbar');
  if (topbar) {
    const tr = topbar.getBoundingClientRect();
    if (Math.abs(tr.left) > 2 || Math.abs(tr.right - vw) > 2) {
      edgeIssues.push({
        element: '.topbar',
        left: Math.round(tr.left * 10) / 10,
        right: Math.round(tr.right * 10) / 10,
        viewportWidth: vw,
      });
    }
  }

  const visibleCards = [];
  for (const card of document.querySelectorAll('.card')) {
    const st = getComputedStyle(card);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const r = card.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    visibleCards.push({
      left: Math.round(r.left * 10) / 10,
      right: Math.round(r.right * 10) / 10,
    });
  }
  if (visibleCards.length >= 2) {
    const lefts = visibleCards.map((c) => c.left);
    const rights = visibleCards.map((c) => c.right);
    const leftSpread = Math.max(...lefts) - Math.min(...lefts);
    const rightSpread = Math.max(...rights) - Math.min(...rights);
    if (leftSpread > 2.5 || rightSpread > 2.5) {
      edgeIssues.push({
        element: '.card stack',
        leftSpreadPx: Math.round(leftSpread * 10) / 10,
        rightSpreadPx: Math.round(rightSpread * 10) / 10,
        cards: visibleCards,
      });
    }
  }

  return {
    passed: deepNestingViolations.length === 0 && edgeIssues.length === 0,
    maxBorderedDepth,
    deepNestingCount: deepNestingViolations.length,
    deepNestingViolations,
    edgeIssues,
  };
}
"""


def run_taste_evaluators(
    browser: Browser,
    base_url: str,
    out_dir: Path,
    telemetry: TelemetryCollector,
) -> list[CheckResult]:
    """Runs all 8 Taste-Skill 2.5.1 geometric/visual/accessibility checks across 4 viewports."""
    results: dict[str, dict[str, Any]] = {
        "zero_horizontal_overflow": {"passed": True, "viewports": {}},
        "zero_clipped_path_cards": {"passed": True, "viewports": {}},
        "zero_violet_lavender": {"passed": True, "viewports": {}},
        "zero_structural_emojis": {"passed": True, "viewports": {}},
        "typography_hierarchy_and_readability": {"passed": True, "viewports": {}},
        "wcag_contrast_audit": {"passed": True, "viewports": {}},
        "touch_target_sizes": {"passed": True, "viewports": {}},
        "nesting_and_equal_edges": {"passed": True, "viewports": {}},
    }

    screenshot_vp_map = {
        "desktop_1440": "after_desktop_1440.png",
        "tablet_1024": "after_tablet_1024.png",
        "mobile_390": "after_mobile_390.png",
    }

    for vp_name, w, h in VIEWPORTS:
        context, page = open_hydrated_page(browser, base_url, w, h, telemetry)
        try:
            # Capture initial viewport screenshot before switching tabs
            if vp_name in screenshot_vp_map:
                page.screenshot(path=str(out_dir / screenshot_vp_map[vp_name]), full_page=False)

            # 1. zero_horizontal_overflow across ALL 3 tabs
            tab_overflow: dict[str, Any] = {}
            vp_overflow_ok = True
            for tab_name, tab_sel in TAB_DEFS:
                switched, err_msg = _try_switch_tab(page, tab_name, tab_sel)
                if not switched:
                    tab_overflow[tab_name] = {"passed": False, "error": err_msg}
                    vp_overflow_ok = False
                else:
                    ov = page.evaluate(JS_OVERFLOW_CHECK)
                    tab_overflow[tab_name] = ov
                    if not ov["passed"]:
                        vp_overflow_ok = False
            results["zero_horizontal_overflow"]["viewports"][vp_name] = {
                "passed": vp_overflow_ok,
                "tabs": tab_overflow,
            }
            if not vp_overflow_ok:
                results["zero_horizontal_overflow"]["passed"] = False

            # Return to pathway tab (or initial state) for path-card & primary audits
            _try_switch_tab(page, "pathway", "#tabPathwayBtn")

            # 2. zero_clipped_path_cards
            clipped = page.evaluate(JS_CLIPPED_PATH_CARDS)
            results["zero_clipped_path_cards"]["viewports"][vp_name] = clipped
            if not clipped["passed"]:
                results["zero_clipped_path_cards"]["passed"] = False

            # 3. zero_violet_lavender
            violet = page.evaluate(JS_VIOLET_LAVENDER_SCAN)
            results["zero_violet_lavender"]["viewports"][vp_name] = violet
            if not violet["passed"]:
                results["zero_violet_lavender"]["passed"] = False

            # 4. zero_structural_emojis
            emojis = page.evaluate(JS_STRUCTURAL_EMOJI_SCAN)
            results["zero_structural_emojis"]["viewports"][vp_name] = emojis
            if not emojis["passed"]:
                results["zero_structural_emojis"]["passed"] = False

            # 5. typography_hierarchy_and_readability
            typo = page.evaluate(JS_TYPOGRAPHY_AUDIT)
            results["typography_hierarchy_and_readability"]["viewports"][vp_name] = typo
            if not typo["passed"]:
                results["typography_hierarchy_and_readability"]["passed"] = False

            # 6. wcag_contrast_audit
            contrast = page.evaluate(JS_WCAG_CONTRAST_AUDIT)
            results["wcag_contrast_audit"]["viewports"][vp_name] = contrast
            if not contrast["passed"]:
                results["wcag_contrast_audit"]["passed"] = False

            # 7. touch_target_sizes
            touch = page.evaluate(JS_TOUCH_TARGET_AUDIT)
            results["touch_target_sizes"]["viewports"][vp_name] = touch
            if not touch["passed"]:
                results["touch_target_sizes"]["passed"] = False

            # 8. nesting_and_equal_edges
            nesting = page.evaluate(JS_NESTING_AND_EDGES_AUDIT)
            results["nesting_and_equal_edges"]["viewports"][vp_name] = nesting
            if not nesting["passed"]:
                results["nesting_and_equal_edges"]["passed"] = False
        finally:
            context.close()

    check_list: list[CheckResult] = []
    for name, data in results.items():
        failed_vps = [vp for vp, vdata in data["viewports"].items() if not vdata.get("passed", False)]
        summary = (
            f"PASS across all {len(VIEWPORTS)} viewports"
            if data["passed"]
            else f"FAIL on viewports: {', '.join(failed_vps)}"
        )
        check_list.append(CheckResult(name=name, passed=data["passed"], summary=summary, details=data))
    return check_list


# ---------------------------------------------------------------------------
# Interactive Playwright User-Testing Flows (at 1440x900 & 390x844)
# ---------------------------------------------------------------------------


def _run_flows_at_viewport(
    browser: Browser,
    base_url: str,
    out_dir: Path,
    vp_label: str,
    width: int,
    height: int,
    telemetry: TelemetryCollector,
    capture_desktop_artifacts: bool,
) -> list[CheckResult]:
    results: list[CheckResult] = []
    context, page = open_hydrated_page(browser, base_url, width, height, telemetry)

    try:
        # ------------------------------------------------------------------
        # Flow 1: Initial Render + Language Toggle + Copy
        # ------------------------------------------------------------------
        f1_errors: list[str] = []
        f1_info: dict[str, Any] = {}
        try:
            h1_text = page.locator("h1").first.inner_text(timeout=3000)
            if "First Milestones" not in h1_text:
                f1_errors.append(f"Expected 'First Milestones' in h1, got {h1_text!r}")

            kpi_count = page.locator("#kpiStrip .kpi-card, #kpiStrip .kpi-chip").count()
            f1_info["kpi_count"] = kpi_count
            if kpi_count < 4:
                f1_errors.append(f"Expected >= 4 KPI tiles in #kpiStrip, got {kpi_count}")

            bounce_nodes = page.locator("#bouncePathCanvas .hop-card, #bouncePathCanvas .node-box").count()
            rec_nodes = page.locator("#recPathCanvas .hop-card, #recPathCanvas .node-box").count()
            f1_info["bounce_nodes"] = bounce_nodes
            f1_info["rec_nodes"] = rec_nodes
            if bounce_nodes < 3 or rec_nodes < 3:
                f1_errors.append(
                    f"Expected >= 3 nodes in bounce ({bounce_nodes}) & rec ({rec_nodes}) canvases"
                )

            # Language toggle EN -> ES -> EN
            es_btn = page.locator('[data-lang="spanish"]')
            en_btn = page.locator('[data-lang="english"]')
            if es_btn.count() == 0 or en_btn.count() == 0:
                f1_errors.append("Missing EN/ES caregiver language toggle buttons")
            else:
                es_btn.first.click()
                page.wait_for_timeout(150)
                es_note = page.locator("#caregiverNoteBox").inner_text()
                if "Plan de Primeros Pasos" not in es_note:
                    f1_errors.append("Spanish note did not render 'Plan de Primeros Pasos'")

                en_btn.first.click()
                page.wait_for_timeout(150)
                en_note = page.locator("#caregiverNoteBox").inner_text()
                if "Early Milestones Plan" not in en_note:
                    f1_errors.append("English note did not render 'Early Milestones Plan'")

            # Copy Note button
            copy_btn = page.locator("#copyNoteBtn")
            if copy_btn.count() == 0:
                f1_errors.append("Missing #copyNoteBtn")
            else:
                before_copy = copy_btn.first.inner_text()
                copy_btn.first.click()
                page.wait_for_timeout(150)
                after_copy = copy_btn.first.inner_text()
                f1_info["copy_btn_before"] = before_copy
                f1_info["copy_btn_after"] = after_copy
                if after_copy == before_copy or "Copied" not in after_copy:
                    f1_errors.append(f"#copyNoteBtn state did not update cleanly ({before_copy!r} -> {after_copy!r})")
        except Exception as exc:  # noqa: BLE001
            f1_errors.append(f"Exception: {exc}")

        results.append(
            CheckResult(
                name=f"flow_1_initial_lang_copy ({vp_label})",
                passed=len(f1_errors) == 0,
                summary="PASS" if not f1_errors else "; ".join(f1_errors),
                details=f1_info,
            )
        )

        # ------------------------------------------------------------------
        # Flow 2: State Switcher MS -> CA -> MS
        # ------------------------------------------------------------------
        f2_errors: list[str] = []
        f2_info: dict[str, Any] = {}
        try:
            with page.expect_response(
                lambda r: "/api/brief" in r.url and "state=CA" in r.url and r.status == 200,
                timeout=15000,
            ):
                page.locator("#stateSelect").select_option("CA")
            page.wait_for_timeout(200)

            ctx_sub = page.locator("#contextSubtitle")
            fallback_sub = page.locator("#briefScopeSubtitle")
            if ctx_sub.count() > 0:
                sub_txt = ctx_sub.first.inner_text()
            else:
                sub_txt = fallback_sub.first.inner_text() if fallback_sub.count() > 0 else ""
                f2_errors.append("Missing #contextSubtitle element (fallback #briefScopeSubtitle used)")

            f2_info["ca_subtitle"] = sub_txt
            if "06" not in sub_txt or "CA" not in sub_txt:
                f2_errors.append(f"Subtitle did not update to CA '06...' FIPS: {sub_txt!r}")

            ca_tract_text = page.locator("#bouncePathCanvas").inner_text() + " " + sub_txt
            if "06" not in ca_tract_text:
                f2_errors.append("CA 11-char FIPS '06...' not found in pathway/context")

            # Switch back to MS
            with page.expect_response(
                lambda r: "/api/brief" in r.url and "state=MS" in r.url and r.status == 200,
                timeout=15000,
            ):
                page.locator("#stateSelect").select_option("MS")
            page.wait_for_timeout(200)
        except Exception as exc:  # noqa: BLE001
            f2_errors.append(f"Exception: {exc}")

        results.append(
            CheckResult(
                name=f"flow_2_state_switcher_ms_ca ({vp_label})",
                passed=len(f2_errors) == 0,
                summary="PASS" if not f2_errors else "; ".join(f2_errors),
                details=f2_info,
            )
        )

        # ------------------------------------------------------------------
        # Flow 3: Sub-Tab Navigation & Counterfactual Simulation
        # ------------------------------------------------------------------
        f3_errors: list[str] = []
        f3_info: dict[str, Any] = {}
        try:
            tab_hubs = page.locator("#tabHubsBtn")
            panel_hubs = page.locator("#panelHubs")
            if tab_hubs.count() == 0:
                f3_errors.append("Missing #tabHubsBtn")
            else:
                tab_hubs.first.click()
                page.wait_for_timeout(150)
                if panel_hubs.count() == 0 or not panel_hubs.first.is_visible():
                    f3_errors.append("#panelHubs did not become visible after clicking #tabHubsBtn")

            coord_table_txt = page.locator("#coordAuditTable").inner_text()
            if "SYN-PROV-MS-011" not in coord_table_txt:
                f3_errors.append("Coordinator audit table missing SYN-PROV-MS-011")

            run_sim = page.locator("#runSimBtn")
            if run_sim.count() == 0:
                f3_errors.append("Missing #runSimBtn")
            else:
                run_sim.first.scroll_into_view_if_needed()
                with page.expect_response(
                    lambda r: "/api/simulate" in r.url and r.status == 200,
                    timeout=15000,
                ) as sim_resp_ctx:
                    run_sim.first.click()
                sim_json = sim_resp_ctx.value.json()
                days_saved = sim_json.get("impact_summary", {}).get("total_delayed_child_days_saved", 0)
                f3_info["days_saved"] = days_saved
                page.wait_for_timeout(150)
                sim_box_txt = page.locator("#simImpactBox").inner_text()
                f3_info["sim_box_snippet"] = sim_box_txt[:140]
                if days_saved <= 100 or str(days_saved) not in sim_box_txt:
                    f3_errors.append(
                        f"Expected > 100 child-days saved rendered in #simImpactBox (got {days_saved})"
                    )

            if capture_desktop_artifacts:
                page.screenshot(path=str(out_dir / "after_tab_hubs_1440.png"), full_page=False)
        except Exception as exc:  # noqa: BLE001
            f3_errors.append(f"Exception: {exc}")

        results.append(
            CheckResult(
                name=f"flow_3_hubs_tab_and_sim ({vp_label})",
                passed=len(f3_errors) == 0,
                summary="PASS" if not f3_errors else "; ".join(f3_errors),
                details=f3_info,
            )
        )

        # ------------------------------------------------------------------
        # Flow 4: Outreach & Equity Audit Tab
        # ------------------------------------------------------------------
        f4_errors: list[str] = []
        f4_info: dict[str, Any] = {}
        try:
            tab_outreach = page.locator("#tabOutreachBtn")
            panel_outreach = page.locator("#panelOutreach")
            if tab_outreach.count() == 0:
                f4_errors.append("Missing #tabOutreachBtn")
            else:
                tab_outreach.first.click()
                page.wait_for_timeout(150)
                if panel_outreach.count() == 0 or not panel_outreach.first.is_visible():
                    f4_errors.append("#panelOutreach did not become visible after clicking #tabOutreachBtn")

            for tbl_id, min_rows in [
                ("#outreachZonesTable", 1),
                ("#equityTable", 1),
                ("#nschTable", 6),
                ("#agencyKpiTable", 1),
            ]:
                tbl = page.locator(tbl_id)
                if tbl.count() == 0:
                    f4_errors.append(f"Missing table {tbl_id}")
                else:
                    row_cnt = tbl.locator("tbody tr").count()
                    f4_info[tbl_id] = row_cnt
                    if row_cnt < min_rows:
                        f4_errors.append(f"{tbl_id} expected >= {min_rows} tbody rows, got {row_cnt}")

            rigor = page.locator("#rigorChecklist")
            if rigor.count() == 0:
                f4_errors.append("Missing #rigorChecklist")
            else:
                rigor.first.scroll_into_view_if_needed()
                rigor_txt = rigor.first.inner_text()
                if "limited_english_rate = 0.0" not in rigor_txt:
                    f4_errors.append("#rigorChecklist missing 'limited_english_rate = 0.0'")
                if "[Synthetic]" not in rigor_txt:
                    f4_errors.append("#rigorChecklist missing '[Synthetic]' provenance")

            if capture_desktop_artifacts:
                page.screenshot(path=str(out_dir / "after_tab_outreach_1440.png"), full_page=False)
        except Exception as exc:  # noqa: BLE001
            f4_errors.append(f"Exception: {exc}")

        results.append(
            CheckResult(
                name=f"flow_4_outreach_equity_tab ({vp_label})",
                passed=len(f4_errors) == 0,
                summary="PASS" if not f4_errors else "; ".join(f4_errors),
                details=f4_info,
            )
        )

        # ------------------------------------------------------------------
        # Flow 5: Track Scenario Presets & Copilot Chat
        # ------------------------------------------------------------------
        f5_errors: list[str] = []
        f5_info: dict[str, Any] = {}
        try:
            initial_agent_msgs = page.locator("#chatMessages .msg-agent").count()
            preset_btn = page.locator('[data-preset="outreach"]')
            if preset_btn.count() == 0:
                f5_errors.append("Missing [data-preset='outreach'] button")
            else:
                with page.expect_response(
                    lambda r: "/api/chat" in r.url and r.status == 200,
                    timeout=20000,
                ):
                    preset_btn.first.click()
                page.wait_for_timeout(200)
                after_preset_msgs = page.locator("#chatMessages .msg-agent").count()
                f5_info["agent_msgs_after_preset"] = after_preset_msgs
                if after_preset_msgs <= initial_agent_msgs:
                    f5_errors.append("Preset click did not append an assistant reply bubble")

            # Custom chat prompt via #chatInput -> #sendBtn
            before_custom_msgs = page.locator("#chatMessages .msg-agent").count()
            page.locator("#chatInput").fill(
                "Route a 28-month-old toddler in tract 28049003500 with Medicaid and Spanish support."
            )
            with page.expect_response(
                lambda r: "/api/chat" in r.url and r.status == 200,
                timeout=20000,
            ):
                page.locator("#sendBtn").click()
            page.wait_for_timeout(200)
            after_custom_msgs = page.locator("#chatMessages .msg-agent").count()
            f5_info["agent_msgs_after_custom"] = after_custom_msgs
            if after_custom_msgs <= before_custom_msgs:
                f5_errors.append("Custom chat prompt did not append an assistant reply bubble")
        except Exception as exc:  # noqa: BLE001
            f5_errors.append(f"Exception: {exc}")

        results.append(
            CheckResult(
                name=f"flow_5_presets_and_chat ({vp_label})",
                passed=len(f5_errors) == 0,
                summary="PASS" if not f5_errors else "; ".join(f5_errors),
                details=f5_info,
            )
        )

        # ------------------------------------------------------------------
        # Flow 6: ISO GQL Modal
        # ------------------------------------------------------------------
        f6_errors: list[str] = []
        f6_info: dict[str, Any] = {}
        try:
            _try_switch_tab(page, "pathway", "#tabPathwayBtn")
            toggle_btn = page.locator("#toggleGqlBtn")
            if toggle_btn.count() == 0:
                f6_errors.append("Missing #toggleGqlBtn")
            else:
                toggle_btn.first.scroll_into_view_if_needed()
                toggle_btn.first.click()
                page.wait_for_timeout(150)

            modal = page.locator("#gqlModal")
            if modal.count() == 0 or not modal.first.is_visible():
                f6_errors.append("#gqlModal did not open on #toggleGqlBtn click")
            else:
                modal_txt = modal.first.inner_text()
                if "GRAPH_TABLE" not in modal_txt:
                    f6_errors.append("#gqlModal missing GRAPH_TABLE query content")

                # Try switching GQL modal tab (audit / outreach)
                gql_tab = modal.locator(
                    '[data-gql-tab="audit"], [data-gql="audit"], button:has-text("Audit"), button:has-text("Outreach")'
                )
                if gql_tab.count() > 0:
                    gql_tab.first.click()
                    page.wait_for_timeout(120)
                    f6_info["switched_gql_tab"] = gql_tab.first.inner_text()
                else:
                    f6_errors.append("No audit/outreach GQL tab found inside #gqlModal")

            if capture_desktop_artifacts:
                page.screenshot(path=str(out_dir / "after_gql_modal_1440.png"), full_page=False)

            # Press Escape and assert #gqlModal closes cleanly
            if modal.count() > 0 and modal.first.is_visible():
                page.keyboard.press("Escape")
                page.wait_for_timeout(150)
                if modal.first.is_visible():
                    f6_errors.append("#gqlModal did not close on Escape key")
        except Exception as exc:  # noqa: BLE001
            f6_errors.append(f"Exception: {exc}")

        results.append(
            CheckResult(
                name=f"flow_6_iso_gql_modal ({vp_label})",
                passed=len(f6_errors) == 0,
                summary="PASS" if not f6_errors else "; ".join(f6_errors),
                details=f6_info,
            )
        )
    finally:
        context.close()

    return results


def run_all_qa(
    base_url: str,
    out_dir: Path,
) -> dict[str, Any]:
    """Runs the complete Taste-Skill 2.5.1 + Interactive Flow suite and returns structured JSON."""
    out_dir.mkdir(parents=True, exist_ok=True)
    telemetry = TelemetryCollector()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            taste_results = run_taste_evaluators(browser, base_url, out_dir, telemetry)
            desktop_flows = _run_flows_at_viewport(
                browser, base_url, out_dir, "1440x900", 1440, 900, telemetry, capture_desktop_artifacts=True
            )
            mobile_flows = _run_flows_at_viewport(
                browser, base_url, out_dir, "390x844", 390, 844, telemetry, capture_desktop_artifacts=False
            )
        finally:
            browser.close()

    runtime_ok = (
        len(telemetry.page_errors) == 0
        and len(telemetry.console_errors) == 0
        and len(telemetry.http_errors) == 0
    )
    runtime_check = CheckResult(
        name="zero_runtime_and_http_errors",
        passed=runtime_ok,
        summary=(
            "PASS (0 pageerror, 0 console.error, 0 HTTP>=400)"
            if runtime_ok
            else f"FAIL (page_errors={len(telemetry.page_errors)}, console_errors={len(telemetry.console_errors)}, http_errors={len(telemetry.http_errors)})"
        ),
        details={
            "page_errors": telemetry.page_errors,
            "console_errors": telemetry.console_errors,
            "http_errors": telemetry.http_errors,
        },
    )

    all_checks = taste_results + desktop_flows + mobile_flows + [runtime_check]
    passed_count = sum(1 for c in all_checks if c.passed)
    total_count = len(all_checks)
    overall_passed = passed_count == total_count

    expected_screenshots = [
        "after_desktop_1440.png",
        "after_tablet_1024.png",
        "after_mobile_390.png",
        "after_tab_hubs_1440.png",
        "after_tab_outreach_1440.png",
        "after_gql_modal_1440.png",
    ]
    saved_screenshots = [
        str(out_dir / name) for name in expected_screenshots if (out_dir / name).exists()
    ]

    return {
        "overall_passed": overall_passed,
        "score": f"{passed_count}/{total_count}",
        "base_url": base_url,
        "screenshots_dir": str(out_dir),
        "saved_screenshots": saved_screenshots,
        "checks": [asdict(c) for c in all_checks],
    }


def print_scorecard(report: dict[str, Any]) -> None:
    """Prints a clear human-readable PASS/FAIL scorecard plus compact JSON summary."""
    print("=" * 78)
    print(f"FIRST MILESTONES — TASTE-SKILL 2.5.1 + PLAYWRIGHT QA SCORECARD ({report['score']})")
    print(f"Target URL : {report['base_url']}")
    print(f"Screenshots: {report['screenshots_dir']} ({len(report['saved_screenshots'])}/6 saved)")
    print("=" * 78)
    for chk in report["checks"]:
        badge = "PASS" if chk["passed"] else "FAIL"
        print(f"  [{badge}] {chk['name']:<42} | {chk['summary']}")
    print("=" * 78)
    print(f"OVERALL RESULT: {'PASS' if report['overall_passed'] else 'FAIL'}")
    print("=" * 78)


# Optional pytest entrypoint when invoked via `pytest`
def test_ui_taste_qa_suite(tmp_path: Path | None = None) -> None:
    """Pytest wrapper that boots uvicorn on 8766 and asserts full Taste-Skill + Flow pass."""
    port = 8766
    proc = start_uvicorn_server(port)
    base_url = f"http://127.0.0.1:{port}"
    try:
        wait_for_health(base_url)
        report = run_all_qa(base_url, DEFAULT_SCREENSHOT_DIR)
        print_scorecard(report)
        assert report["overall_passed"], json.dumps(report, indent=2)
    finally:
        stop_uvicorn_server(proc)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run Taste-Skill 2.5.1 + Playwright E2E UI QA against First Milestones."
    )
    parser.add_argument("--url", default="", help="Existing live server URL (if omitted, boots uvicorn)")
    parser.add_argument("--port", type=int, default=8766, help="Local uvicorn port when --url is omitted")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_SCREENSHOT_DIR,
        help="Directory for screenshots and JSON report",
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Optional file path to write full JSON report (defaults to <out-dir>/qa_report.json)",
    )
    args = parser.parse_args()

    proc: subprocess.Popen[bytes] | None = None
    base_url = args.url.strip().rstrip("/")
    try:
        if not base_url:
            base_url = f"http://127.0.0.1:{args.port}"
            proc = start_uvicorn_server(args.port)
        wait_for_health(base_url)

        report = run_all_qa(base_url, args.out_dir)
        json_path = args.json_out or (args.out_dir / "qa_report.json")
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

        print_scorecard(report)
        print(f"Structured JSON report written to: {json_path}")
        return 0 if report["overall_passed"] else 1
    finally:
        stop_uvicorn_server(proc)


if __name__ == "__main__":
    sys.exit(main())
