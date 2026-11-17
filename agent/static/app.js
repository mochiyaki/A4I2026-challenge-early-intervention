/* First Milestones Clinical Workbench Frontend Logic */
"use strict";

// ---------------------------------------------------------------------------
// State & Configuration
// ---------------------------------------------------------------------------
const state = {
  sessionId: null,
  brief: null,
  health: null,
  geo: null,
  bqTelemetry: null,
  selectedDesertTract: null,
  lastHold: null,
  caregiverLang: "english",
  activeTab: "pathway",
  activeGqlKey: "routing",
  cyFilter: "all",
  briefRequestSeq: 0,
  lastModalTrigger: null,
  gatekeeper: {
    hasScreeningTool: true,
    hasParentConsent: true,
    lastResult: null,
  },
  intake: {
    tractGeoid: "",
    ageMonths: 32,
    concernDomain: "Social-Communication / Autism Screen",
    needsMedicaid: true,
    needsBilingual: true,
    hasVehicle: false,
  },
};

const SUBAGENT_LABELS = {
  triage_pathway_router: "TriageSub",
  network_bottleneck_auditor: "BottleneckAuditSub",
  equity_and_caregiver_specialist: "EquityCaregiverSub",
};

const PRESET_TARGET_TAB = {
  triage: "pathway",
  audit: "hubs",
  outreach: "outreach",
};

const TAB_PANELS = {
  pathway: "panelPathway",
  hubs: "panelHubs",
  outreach: "panelOutreach",
};

// Crisp inline SVG icons (zero emojis)
const ICONS = {
  bolt: `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  clockAlert: `<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  mobility: `<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="3" width="15" height="13" rx="2"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
  alertTriangle: `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  checkCircle: `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  shieldCheck: `<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>`,
  subagent: `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
  info: `<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  arrowConnector(isFax) {
    const cls = isFax ? "hop-arrow-svg fax" : "hop-arrow-svg ehr";
    return `<svg class="${cls}" width="44" height="14" viewBox="0 0 44 14" fill="none" aria-hidden="true"><line x1="2" y1="7" x2="36" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><polyline points="32 2 39 7 32 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  },
};

// ---------------------------------------------------------------------------
// DOM Helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineMarkdown(escapedLine) {
  return escapedLine
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMarkdownLite(md) {
  const escaped = escapeHtml(md).replace(/\r\n/g, "\n");
  const lines = escaped.split("\n");
  const out = [];
  let inList = false;
  let paraBuffer = [];

  const flushPara = () => {
    if (paraBuffer.length > 0) {
      out.push(`<p>${paraBuffer.join("<br/>")}</p>`);
      paraBuffer = [];
    }
  };
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushPara();
      closeList();
      continue;
    }
    const h4Match = trimmed.match(/^####\s+(.+)$/);
    if (h4Match) {
      flushPara();
      closeList();
      out.push(`<h4>${formatInlineMarkdown(h4Match[1])}</h4>`);
      continue;
    }
    const h3Match = trimmed.match(/^###\s+(.+)$/);
    if (h3Match) {
      flushPara();
      closeList();
      out.push(`<h3>${formatInlineMarkdown(h3Match[1])}</h3>`);
      continue;
    }
    const liMatch = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (liMatch) {
      flushPara();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${formatInlineMarkdown(liMatch[1])}</li>`);
      continue;
    }
    closeList();
    paraBuffer.push(formatInlineMarkdown(trimmed));
  }

  flushPara();
  closeList();
  return out.join("");
}

function shortRole(role) {
  const map = {
    Screening_Pediatric_Clinic: "Screening Clinic",
    Part_C_Intake_Coordinator: "Part C Coordinator",
    Multidisciplinary_Eval_Hub: "Eval Hub",
    EI_Therapy_Vendor: "EI Therapy Vendor",
  };
  return map[role] || String(role || "Provider").replace(/_/g, " ");
}

function formatChannel(channel) {
  const map = {
    paper_fax: "Paper Fax",
    phone_voicemail: "Voicemail",
    ehr_electronic_portal: "EHR Portal",
  };
  return map[channel] || String(channel || "Portal").replace(/_/g, " ");
}

function cleanOrgTitle(name) {
  return String(name || "").replace(/\s*\[Synthetic\]\s*/g, "").trim();
}

function formatNumber(val, fallback = "--") {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return fallback;
  return Number(val).toLocaleString();
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, options);
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const errBody = await resp.json();
      if (errBody?.detail) detail = String(errBody.detail);
    } catch {
      // Ignore non-JSON error body
    }
    throw new Error(detail);
  }
  return resp.json();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

// ---------------------------------------------------------------------------
// Adaptive Table Renderer (matches any <thead> column set cleanly)
// ---------------------------------------------------------------------------
function renderAdaptiveTable(tableId, rows, colDefs, emptyText) {
  const table = $(tableId);
  if (!table) return;

  let tbody = table.querySelector("tbody");
  if (!tbody) {
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
  }

  let thead = table.querySelector("thead");
  let activeCols = colDefs;

  if (thead) {
    const ths = Array.from(thead.querySelectorAll("th"));
    if (ths.length > 0) {
      activeCols = ths.map((th, idx) => {
        const label = th.textContent.trim();
        return colDefs.find((c) => c.match.test(label)) || colDefs[idx] || {
          header: label,
          render: () => `<span class="muted-small">--</span>`,
        };
      });
    }
  } else {
    thead = document.createElement("thead");
    thead.innerHTML = `<tr>${colDefs.map((c) => `<th>${escapeHtml(c.header)}</th>`).join("")}</tr>`;
    table.insertBefore(thead, tbody);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${Math.max(1, activeCols.length)}" class="muted-small">${escapeHtml(emptyText)}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((row, idx) => {
      const rowCls = row.__rowClass ? ` class="${escapeHtml(row.__rowClass)}"` : "";
      const cells = activeCols.map((col) => `<td>${col.render(row, idx)}</td>`).join("");
      return `<tr${rowCls}>${cells}</tr>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Tab Management (WAI-ARIA Tabs + Keyboard Arrow Navigation)
// ---------------------------------------------------------------------------
function switchTab(tabName, { moveFocus = false } = {}) {
  if (!TAB_PANELS[tabName]) return;
  state.activeTab = tabName;

  const tabs = Array.from(document.querySelectorAll('[role="tab"][data-tab]'));
  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.setAttribute("aria-selected", String(isActive));
    tab.setAttribute("tabindex", isActive ? "0" : "-1");
    tab.classList.toggle("active", isActive);
    if (moveFocus && isActive) {
      tab.focus();
    }
  });

  Object.entries(TAB_PANELS).forEach(([key, panelId]) => {
    const panel = $(panelId);
    if (!panel) return;
    const isActive = key === tabName;
    panel.hidden = !isActive;
    panel.classList.toggle("hidden", !isActive);
  });

  if (tabName === "pathway" && window.__cyInstance) {
    requestAnimationFrame(() => {
      if (window.__cyInstance) {
        window.__cyInstance.resize();
        applyCytoscapeFilter(state.cyFilter, { fit: true });
      }
    });
  }
}

function initTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"][data-tab]'));
  if (tabs.length === 0) return;

  tabs.forEach((tab, idx) => {
    tab.addEventListener("click", () => {
      switchTab(tab.dataset.tab);
    });

    tab.addEventListener("keydown", (e) => {
      let nextIdx = null;
      if (e.key === "ArrowRight") {
        nextIdx = (idx + 1) % tabs.length;
      } else if (e.key === "ArrowLeft") {
        nextIdx = (idx - 1 + tabs.length) % tabs.length;
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = tabs.length - 1;
      }
      if (nextIdx !== null) {
        e.preventDefault();
        switchTab(tabs[nextIdx].dataset.tab, { moveFocus: true });
      }
    });
  });

  switchTab(state.activeTab);
}

// ---------------------------------------------------------------------------
// Runtime & Header Renderers
// ---------------------------------------------------------------------------
function isBigQueryEngineActive(briefOverride) {
  const b = briefOverride || state.brief || {};
  const queries = state.bqTelemetry?.queries || b.bq_telemetry?.queries || [];
  if (Array.isArray(queries) && queries.some((q) => String(q.engine || "").toLowerCase().includes("bigquery"))) {
    return true;
  }
  const engine = b.execution_engine || b.routing?.execution_engine || "";
  return String(engine).toLowerCase().includes("bigquery");
}

function getTelemetryQueries(briefOverride) {
  const b = briefOverride || state.brief || {};
  const q = state.bqTelemetry?.queries || b.bq_telemetry?.queries || [];
  return Array.isArray(q) ? q : [];
}

function renderGqlTelemetryBar() {
  const bar = $("gqlTelemetryBar");
  if (!bar) return;

  const queries = getTelemetryQueries();
  const isBq = isBigQueryEngineActive();

  if (queries.length > 0 && isBq) {
    const jobPills = queries
      .slice(0, 4)
      .map((q) => {
        const lbl = q.label ? `${q.label}: ` : "";
        const jid = q.job_id || "job";
        const ms = q.elapsed_ms !== undefined ? ` · ${q.elapsed_ms}ms` : "";
        const rows = q.row_count !== undefined ? ` · ${q.row_count} rows` : "";
        return `<span class="telemetry-job-pill">${escapeHtml(lbl)}${escapeHtml(jid)}${escapeHtml(ms)}${escapeHtml(rows)}</span>`;
      })
      .join("");
    bar.innerHTML = `<span class="telemetry-engine-pill">BigQuery ISO GQL Telemetry</span>${jobPills}`;
    return;
  }

  if (queries.length > 0) {
    const q = queries[0];
    const ms = q.elapsed_ms !== undefined ? ` (${q.elapsed_ms}ms · ${q.row_count ?? "--"} rows)` : "";
    bar.innerHTML = `<span class="telemetry-engine-pill">Local Deterministic Parquet Graph</span><span>Preview ISO GQL execution${escapeHtml(ms)}</span>`;
    return;
  }

  bar.innerHTML = `<span class="telemetry-engine-pill">Local Deterministic Parquet Graph</span><span>ISO/IEC 39075 GQL parity over local GeoParquet graph (no live BigQuery job ID in offline preview)</span>`;
}

function renderRuntimeMeta(runtime, engineOverride) {
  const rt = runtime || state.health || {};
  const queries = getTelemetryQueries();
  const isBq = isBigQueryEngineActive();
  const totalMs = queries.reduce((acc, q) => acc + (Number(q.elapsed_ms) || 0), 0);

  const badge = $("runtimeBadge");
  if (badge) {
    const mcp = String(rt.mcp_mode || "");
    const model = rt.gemini_model ? ` · ${rt.gemini_model}` : "";
    const live = rt.llm_credentials_active ? "Live ADK" : "Graph Preview";
    let label = `${live}${model}`;
    if (isBq && queries.length > 0) {
      label = `BigQuery ${queries.length} jobs (${totalMs}ms) · ${live}`;
    } else if (mcp.startsWith("mcp_toolbox")) {
      label = `MCP Toolbox · ${live}`;
    } else if (mcp.startsWith("google_bigquery")) {
      label = `BigQuery MCP · ${live}`;
    } else {
      label = `Local Parquet Graph · ${live}`;
    }
    badge.innerHTML = `${ICONS.checkCircle} <span>${escapeHtml(label)}</span>`;
  }

  const engineChip = $("engineChip");
  if (engineChip) {
    const engine = engineOverride || state.brief?.execution_engine || state.brief?.routing?.execution_engine || "";
    const shortEngine = isBq
      ? `BigQuery ISO GQL${totalMs ? ` (${totalMs}ms)` : ""}`
      : engine
      ? "Local Deterministic Parquet Graph"
      : "ISO GQL Ready";
    engineChip.textContent = shortEngine;
    if (engine) engineChip.title = String(engine);
  }

  renderGqlTelemetryBar();
}

function renderHeaderAndKpis(brief) {
  const routing = brief.routing || {};
  const profile = routing.child_profile || {};
  const rec = routing.recommended_pathway;
  const totals = brief.network_audit?.network_totals || {};
  const agencies = Array.isArray(brief.agencies) ? brief.agencies : [];
  const lowestAgency = agencies.reduce((min, item) => {
    if (!min) return item;
    return Number(item.timely_45d_ifsp_pct) < Number(min.timely_45d_ifsp_pct) ? item : min;
  }, null);
  const hiddenDeserts = brief.outreach_zones?.hidden_ei_deserts_count;

  const subtitle = $("contextSubtitle");
  if (subtitle) {
    const parts = [`State: ${brief.state_code || "--"}`];
    if (profile.home_tract_geoid) {
      parts.push(`Tract ${profile.home_tract_geoid}${profile.county_name ? ` (${profile.county_name})` : ""}`);
    }
    if (profile.child_age_months !== undefined) {
      parts.push(`Age ${profile.child_age_months}m`);
    }
    if (profile.concern_domain) {
      parts.push(profile.concern_domain);
    }
    const queries = getTelemetryQueries(brief);
    if (isBigQueryEngineActive(brief) && queries.length > 0) {
      const firstJob = queries[0];
      parts.push(`Engine: BigQuery (${firstJob.job_id || "job"} · ${firstJob.elapsed_ms ?? "--"}ms)`);
    } else {
      parts.push("Engine: Local Deterministic Parquet Graph");
    }
    subtitle.textContent = parts.join(" · ");
  }

  const kpiStrip = $("kpiStrip");
  if (kpiStrip) {
    const breaches = totals.statutory_breaches_over_45d;
    const totalChains = totals.total_complete_chains;
    const timelyPct = totals.overall_timely_45d_pct;
    const recDays = rec?.expected_cumulative_days;
    const headroom = rec?.statutory_45d_headroom_days;
    const lowestPct = lowestAgency?.timely_45d_ifsp_pct;

    kpiStrip.innerHTML = `
      <div class="kpi-card kpi-danger">
        <span class="kpi-label">Breach Chains &gt;45d</span>
        <strong class="kpi-value">${breaches ?? "--"}${totalChains !== undefined ? ` / ${totalChains}` : ""}</strong>
        <span class="kpi-sub">${timelyPct !== undefined ? `${timelyPct}% timely <=45d` : "Multi-hop audit"}</span>
      </div>
      <div class="kpi-card kpi-success">
        <span class="kpi-label">Recommended Route</span>
        <strong class="kpi-value">${recDays !== undefined ? `${recDays}d` : "--"}</strong>
        <span class="kpi-sub">${headroom !== undefined ? `${headroom}d clock headroom` : "Electronic portal"}</span>
      </div>
      <div class="kpi-card kpi-info">
        <span class="kpi-label">Lowest Regional IFSP</span>
        <strong class="kpi-value">${lowestPct !== undefined ? `${lowestPct}%` : "--"}</strong>
        <span class="kpi-sub">${lowestAgency ? escapeHtml(cleanOrgTitle(lowestAgency.synthetic_agency_name)) : "OSEP Indicator C7"}</span>
      </div>
      <div class="kpi-card kpi-warn">
        <span class="kpi-label">Hidden EI Deserts</span>
        <strong class="kpi-value">${hiddenDeserts ?? "--"}</strong>
        <span class="kpi-sub">Tracts w/ 0 reachable &lt;=45d paths</span>
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// Tab 1: Pathway & Triage Renderers
// ---------------------------------------------------------------------------
function renderGuardrails(brief) {
  const container = $("guardrailContainer");
  if (!container) return;

  const routingAlerts = Array.isArray(brief.routing?.guardrail_alerts) ? brief.routing.guardrail_alerts : [];
  const viableAlerts = Array.isArray(brief.viable_45d_paths?.guardrail_alerts) ? brief.viable_45d_paths.guardrail_alerts : [];
  const alerts = routingAlerts.length > 0 ? routingAlerts : viableAlerts;

  if (alerts.length === 0) {
    container.innerHTML = "";
    return;
  }

  const ALERT_TITLES = {
    IDEA_PART_C_LEA_TRANSITION_PLANNING_WINDOW:
      "Part C to Part B Transition Planning Window (34 CFR § 303.209)",
    IDEA_PART_C_36M_AGING_OUT_CLIFF: "36-Month Aging-Out Cliff Guardrail",
    IDEA_PART_C_IFSP_EXCEEDS_AGE_3_CUTOFF:
      "Age-3 Cutoff Statutory Timeline Guardrail",
    IDEA_PART_C_LESS_THAN_45D_EXEMPTION:
      "<45 Days to Age 3 Dual Part C / Part B Exemption",
    IDEA_PART_C_AGE_OUT_PART_B_REDIRECT:
      "IDEA Part B Section 619 Direct LEA Referral",
    ZERO_VEHICLE_MOBILITY_SUPPORT: "Zero-Vehicle Mobility Guardrail",
  };

  container.innerHTML = alerts
    .map((a) => {
      const isHigh = String(a.severity || "").toUpperCase() === "HIGH";
      const icon = isHigh ? ICONS.clockAlert : ICONS.mobility;
      const title =
        ALERT_TITLES[a.code] ||
        (isHigh ? "Statutory Compliance Guardrail" : "Zero-Vehicle Mobility Guardrail");
      return `
        <div class="guardrail-banner ${isHigh ? "high" : "medium"}">
          <span class="guardrail-icon">${icon}</span>
          <div>
            <strong>${escapeHtml(title)}:</strong>
            <span>${escapeHtml(a.message)}</span>
          </div>
        </div>
      `;
    })
    .join("");
}

function normalizeHop(h) {
  if (!h || typeof h !== "object") return null;
  const sourceId = h.source_provider_id ?? h.source_id ?? "";
  const targetId = h.target_provider_id ?? h.target_id ?? "";
  const sourceName = h.source_name ?? h.source_provider_name ?? sourceId;
  const targetName = h.target_name ?? h.provider_name ?? targetId;
  const sourceRole = h.source_role ?? h.source_type ?? "";
  const targetRole = h.target_role ?? h.hop_type ?? h.target_type ?? "";
  const channel = h.transmission_channel ?? "ehr_electronic_portal";
  const waitDays = h.handoff_wait_days ?? h.edge_wait_days ?? h.incremental_wait_days ?? 0;
  const cumDays = h.cumulative_wait_days ?? 0;
  const isBounce = Boolean(h.is_bounce_hop || h.bounce_flag);
  const bounceReason = h.bounce_reason ?? h.handoff_reason ?? "";
  const distanceKm = h.distance_from_home_km ?? h.distance_km;
  const isBilingual = h.target_bilingual ?? h.is_bilingual_target;
  const acceptsMedicaid = h.target_medicaid ?? h.accepts_medicaid_target;

  return {
    sourceId,
    targetId,
    sourceName,
    targetName,
    sourceRole,
    targetRole,
    channel,
    waitDays,
    cumDays,
    isBounce,
    bounceReason,
    distanceKm,
    isBilingual,
    acceptsMedicaid,
  };
}

function extractBounceBadges(reason, channel) {
  const txt = String(reason || "");
  const badges = [];
  if (/medicaid/i.test(txt)) badges.push("Medicaid Hold");
  if (/slot|cap|capacity|waitlist|full/i.test(txt)) badges.push("Slot Cap");
  if (/lang|bilingual|spanish|interpreter/i.test(txt)) badges.push("Language Mismatch");
  if (/fax/i.test(txt) || channel === "paper_fax") badges.push("Fax Bounce");
  return badges;
}

function renderHopChain(container, rawHops, isBreach, pathwayMeta = {}) {
  if (!container) return;
  const hops = (Array.isArray(rawHops) ? rawHops : []).map(normalizeHop).filter(Boolean);
  if (hops.length === 0) {
    container.innerHTML = `<span class="muted-small">No multi-hop trajectory available for current selection.</span>`;
    return;
  }

  const pieces = [];
  const first = hops[0];
  const originName = cleanOrgTitle(first.sourceName) || first.sourceId;

  pieces.push(`
    <div class="hop-card ${isBreach ? "hop-origin" : "hop-good"}">
      <div class="hop-edge-top">
        <span class="hop-edge-pill">Origin (Day 0)</span>
        <span class="hop-edge-day">Day 0</span>
      </div>
      <div class="hop-card-head">
        <span class="hop-type">Origin · ${escapeHtml(shortRole(first.sourceRole || "Screening_Pediatric_Clinic"))}</span>
        <code class="hop-id">${escapeHtml(first.sourceId)}</code>
      </div>
      <div class="hop-name" title="${escapeHtml(originName)}">${escapeHtml(originName)}</div>
      <div class="hop-tags">
        <span class="mini-tag">Origin (Day 0)</span>
        <span class="mini-tag">Synthetic</span>
      </div>
    </div>
  `);

  hops.forEach((h, idx) => {
    const isFax = h.channel === "paper_fax";
    const chLabel = isFax ? "Fax" : h.channel.startsWith("ehr") ? "EHR" : formatChannel(h.channel);
    const hopNum = idx + 1;

    const bounceBadges = isBreach ? extractBounceBadges(h.bounceReason, h.channel) : [];
    const showBounce = h.isBounce || (isBreach && bounceBadges.length > 0 && /bounce|hold|cap|mismatch|fax/i.test(h.bounceReason || (isFax ? "fax" : "")));
    const nodeCls = h.isBounce ? "hop-bounce" : isBreach ? "hop-breach-step" : "hop-good";
    const targetName = cleanOrgTitle(h.targetName) || h.targetId;
    const tags = [];

    if (showBounce) {
      const displayBadges = bounceBadges.length > 0 ? bounceBadges : ["Bounce"];
      displayBadges.forEach((b) => {
        tags.push(
          `<span class="mini-tag warn" title="${escapeHtml(h.bounceReason)}">${ICONS.alertTriangle} ${escapeHtml(b)}</span>`
        );
      });
    } else if (!isBreach) {
      const med = h.acceptsMedicaid ?? pathwayMeta.all_nodes_medicaid_enrolled;
      const bil = h.isBilingual ?? pathwayMeta.all_care_nodes_bilingual;
      if (med && bil) {
        tags.push(`<span class="mini-tag ok">${ICONS.checkCircle} Medicaid/Bilingual</span>`);
      } else if (med) {
        tags.push(`<span class="mini-tag ok">${ICONS.checkCircle} Medicaid</span>`);
      } else if (bil) {
        tags.push(`<span class="mini-tag ok">${ICONS.checkCircle} Bilingual</span>`);
      } else {
        tags.push(`<span class="mini-tag ok">${ICONS.checkCircle} Compliant</span>`);
      }
    } else {
      tags.push(`<span class="mini-tag">Handoff</span>`);
    }

    if (h.distanceKm !== undefined && h.distanceKm !== null) {
      tags.push(`<span class="mini-tag">${escapeHtml(h.distanceKm)} km</span>`);
    }

    const reasonLine =
      isBreach && h.bounceReason
        ? `<div class="hop-reason-note">${escapeHtml(h.bounceReason)}</div>`
        : "";

    pieces.push(`
      <div class="hop-card ${nodeCls}">
        <div class="hop-edge-top">
          <span class="hop-edge-pill ${isFax ? "fax" : "ehr"}">${ICONS.arrowConnector(isFax)} ${escapeHtml(chLabel)} +${escapeHtml(h.waitDays)}d</span>
          <span class="hop-edge-day">Day ${escapeHtml(h.cumDays)}</span>
        </div>
        <div class="hop-card-head">
          <span class="hop-type">Hop ${hopNum} · ${escapeHtml(shortRole(h.targetRole))}</span>
          <code class="hop-id">${escapeHtml(h.targetId)}</code>
        </div>
        <div class="hop-name" title="${escapeHtml(targetName)}">${escapeHtml(targetName)}</div>
        ${reasonLine}
        <div class="hop-tags">${tags.join("")}</div>
      </div>
    `);
  });

  container.innerHTML = `<div class="hop-grid">${pieces.join("")}</div>`;
}

function resolvePathwayIds(rec) {
  const hops = (Array.isArray(rec?.hops) ? rec.hops : []).map(normalizeHop).filter(Boolean);
  let coordinatorId = "";
  let evalHubId = "";
  let vendorId = "";
  hops.forEach((h) => {
    if (h.targetRole === "Part_C_Intake_Coordinator" && !coordinatorId) coordinatorId = h.targetId;
    if (h.targetRole === "Multidisciplinary_Eval_Hub" && !evalHubId) evalHubId = h.targetId;
    if (h.targetRole === "EI_Therapy_Vendor") vendorId = h.targetId;
  });
  if (!coordinatorId && hops[0]) coordinatorId = hops[0].targetId;
  if (!evalHubId && hops[1]) evalHubId = hops[1].targetId;
  if (!vendorId && hops.length > 0) vendorId = hops[hops.length - 1].targetId;
  return { coordinatorId, evalHubId, vendorId };
}

function updateCapacityChip(brief, overrideSnapshot = null) {
  const chip = $("recCapacityChip");
  const btn = $("reserveSlotBtn");
  if (!chip) return;
  const rec = brief?.routing?.recommended_pathway;
  if (!rec) {
    chip.textContent = "Live Slot Capacity: No compliant <=45d route active for hold";
    if (btn) btn.disabled = true;
    return;
  }
  if (btn) btn.disabled = false;
  const { coordinatorId, evalHubId, vendorId } = resolvePathwayIds(rec);
  const snap = overrideSnapshot || rec.capacity_snapshot || state.lastHold?.capacity_snapshot || null;

  if (snap && typeof snap === "object") {
    const parts = [];
    if (snap.eval_hub_open_slots !== undefined) parts.push(`Open Slots: ${snap.eval_hub_open_slots}`);
    if (snap.eval_hub_waitlist_count !== undefined) parts.push(`Waitlist: ${snap.eval_hub_waitlist_count}`);
    if (snap.active_holds_count !== undefined) parts.push(`Active Holds: ${snap.active_holds_count}`);
    if (snap.remaining_capacity !== undefined) parts.push(`Remaining: ${snap.remaining_capacity}`);
    const metricsTxt = parts.length > 0 ? parts.join(" · ") : JSON.stringify(snap);
    chip.innerHTML = `<strong>${escapeHtml(evalHubId || coordinatorId)}</strong> · ${escapeHtml(metricsTxt)}`;
    return;
  }

  chip.innerHTML = `Route Corridor: <code>${escapeHtml(coordinatorId)}</code> &rarr; <code>${escapeHtml(evalHubId)}</code> &rarr; <code>${escapeHtml(vendorId)}</code> · Est. ${escapeHtml(rec.expected_cumulative_days ?? "--")}d wait`;
}

function renderPathwaysAndClock(brief, { preserveHoldBanner = false } = {}) {
  const routing = brief.routing || {};
  const profile = routing.child_profile || {};
  const bounce = routing.cautionary_historical_bounce_chain;
  const rec = routing.recommended_pathway;

  const bounceMeta = $("bounceSummaryMeta");
  const bounceCanvas = $("bouncePathCanvas");
  if (bounce) {
    if (bounceMeta) {
      bounceMeta.innerHTML = `
        <span>${escapeHtml(bounce.case_chain_id)} · ${escapeHtml(bounce.total_hops)} Hops (${escapeHtml(bounce.paper_fax_hops ?? 0)} paper_fax) · <strong>${escapeHtml(bounce.total_wait_days)}d</strong> (+${escapeHtml(bounce.days_over_45d_limit)}d over limit)</span>
      `;
    }
    renderHopChain(bounceCanvas, bounce.hops, true);
  } else {
    if (bounceMeta) bounceMeta.textContent = "No historical >45d bounce chain matched.";
    renderHopChain(bounceCanvas, [], true);
  }

  const recMeta = $("recSummaryMeta");
  const recCanvas = $("recPathCanvas");
  if (rec) {
    const savedTxt = routing.days_saved_vs_bounce_loop
      ? ` · Saves ${routing.days_saved_vs_bounce_loop}d vs. bounce`
      : "";
    if (recMeta) {
      recMeta.innerHTML = `
        <span class="meta-ok">${ICONS.checkCircle} ${escapeHtml(rec.total_hops)} Hops · ${escapeHtml(rec.expected_cumulative_days)}d (${escapeHtml(rec.statutory_45d_headroom_days)}d headroom)${escapeHtml(savedTxt)}</span>
      `;
    }
    renderHopChain(recCanvas, rec.hops, false, rec);

    const pct = Math.min(100, Math.max(0, Math.round((Number(rec.expected_cumulative_days || 0) / 45) * 100)));
    const clockFill = $("clockBarFill");
    if (clockFill) {
      clockFill.style.width = `${pct}%`;
      clockFill.setAttribute("aria-valuenow", String(rec.expected_cumulative_days ?? 0));
    }
    const clockDays = $("clockDaysLabel");
    if (clockDays) {
      clockDays.textContent = `Expected Cumulative Timeline: ${rec.expected_cumulative_days} / 45 Calendar Days`;
    }
    const ageCliff = $("ageCliffLabel");
    if (ageCliff) {
      const recAge = profile.est_age_at_ifsp_recommended_months ?? "--";
      const bounceAge = profile.est_age_at_ifsp_if_bounced_months ?? "--";
      ageCliff.textContent = `Projected Age at IFSP: ${recAge}m (vs. ${bounceAge}m if bounced · 36m Part C Cutoff)`;
    }
  } else {
    if (recMeta) recMeta.textContent = "No compliant <=45-day electronic pathway found.";
    renderHopChain(recCanvas, [], false);
    const clockFill = $("clockBarFill");
    if (clockFill) clockFill.style.width = "0%";
    const clockDays = $("clockDaysLabel");
    if (clockDays) clockDays.textContent = "Expected Cumulative Timeline: -- / 45 Calendar Days";
    const ageCliff = $("ageCliffLabel");
    if (ageCliff) ageCliff.textContent = "Projected Age at IFSP: -- months (36m Part C Cutoff)";
  }

  updateCapacityChip(brief);
  const holdBox = $("slotHoldStatus");
  if (holdBox && !preserveHoldBanner) {
    holdBox.hidden = true;
    holdBox.innerHTML = "";
  }
}

function renderViablePaths(brief) {
  const container = $("viablePathsList");
  if (!container) return;

  const vp = brief.viable_45d_paths || {};
  const paths = Array.isArray(vp.viable_paths) ? vp.viable_paths : [];
  const pruned = vp.pruned_high_bounce_edges_count;

  if (paths.length === 0) {
    container.innerHTML = `<div class="muted-small">No viable &lt;=45-day pruned graph paths returned for the active filters.</div>`;
    return;
  }

  const headerHtml = `
    <div class="viable-summary-bar">
      <span class="viable-count">${ICONS.checkCircle} <strong>${paths.length}</strong> viable &lt;=45-day routes</span>
      ${pruned !== undefined ? `<span class="mini-tag">Pruned ${escapeHtml(pruned)} high-bounce edges</span>` : ""}
    </div>
  `;

  const rowsHtml = paths
    .slice(0, 6)
    .map((p) => {
      const hopsCount =
        p.hop_count ??
        p.hops_count ??
        (Array.isArray(p.nodes) ? Math.max(1, p.nodes.length - 1) : "--");
      const days = p.total_expected_days ?? "--";
      const dist = p.distance_km ?? p.max_travel_km;
      const routeChain = Array.isArray(p.nodes) && p.nodes.length > 0
        ? p.nodes.join(" -> ")
        : p.nodes_summary ||
          (p.start_provider_id && p.eval_provider_id
            ? `${p.start_provider_id} -> ${p.eval_provider_id}`
            : p.path_id || "Viable Path");
      const evalLabel = p.eval_name ? cleanOrgTitle(p.eval_name) : "";
      const channels = Array.isArray(p.channels_used)
        ? p.channels_used.map(formatChannel).join(", ")
        : p.channels_used
        ? formatChannel(p.channels_used)
        : "";

      return `
        <div class="viable-path-row">
          <div class="viable-path-main">
            <code class="viable-nodes">${escapeHtml(routeChain)}</code>
            ${evalLabel ? `<span class="viable-eval-name">${escapeHtml(evalLabel)}</span>` : ""}
          </div>
          <div class="viable-path-meta">
            <span class="mini-tag ok">${escapeHtml(days)}d</span>
            <span class="mini-tag">${escapeHtml(hopsCount)} hops</span>
            ${dist !== undefined && dist !== null ? `<span class="mini-tag">${escapeHtml(dist)} km</span>` : ""}
            ${channels ? `<span class="mini-tag">${escapeHtml(channels)}</span>` : ""}
            ${p.score !== undefined && p.score !== null ? `<span class="mini-tag">Score ${escapeHtml(p.score)}</span>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = `${headerHtml}<div class="viable-list-stack">${rowsHtml}</div>`;
}

function renderCaregiverNote() {
  const noteBox = $("caregiverNoteBox");
  if (!noteBox) return;
  const notes = state.brief?.caregiver_notes;
  if (!notes) {
    noteBox.textContent = "";
    return;
  }
  const raw = notes[state.caregiverLang] || notes.english || "";
  noteBox.innerHTML = renderMarkdownLite(raw);
}

// ---------------------------------------------------------------------------
// Tab 2: Bounce Hubs & Simulator Renderers
// ---------------------------------------------------------------------------
function renderAuditAndBottlenecks(brief) {
  const audit = brief.network_audit || {};
  const totals = audit.network_totals || {};
  const btwn = brief.bottleneck_hubs || {};
  const topHub = audit.top_hidden_bounce_hub;

  const strip = $("auditSummaryStrip");
  if (strip) {
    strip.innerHTML = `
      <div class="audit-stat-pill">
        <span class="audit-stat-lbl">Complete Chains</span>
        <strong>${formatNumber(totals.total_complete_chains)}</strong>
      </div>
      <div class="audit-stat-pill">
        <span class="audit-stat-lbl">3-4 Hop Chains</span>
        <strong>${formatNumber(totals.chains_3_to_4_hops)}</strong>
      </div>
      <div class="audit-stat-pill danger">
        <span class="audit-stat-lbl">&gt;45d Breaches</span>
        <strong>${formatNumber(totals.statutory_breaches_over_45d)}</strong>
      </div>
      <div class="audit-stat-pill warn">
        <span class="audit-stat-lbl">30m+ in Breach</span>
        <strong>${formatNumber(totals.toddlers_30m_plus_in_breach)}</strong>
      </div>
      <div class="audit-stat-pill">
        <span class="audit-stat-lbl">Top Hidden Hub</span>
        <strong>${topHub ? escapeHtml(topHub.provider_id) : "--"}</strong>
      </div>
    `;
  }

  const coordsRaw =
    audit.coordinator_multihop_ranking ||
    audit.intake_coordinator_bounce_hub_ranking ||
    [];
  const coords = coordsRaw.map((c, idx) => ({
    ...c,
    __rowClass: idx === 0 ? "row-highlight-danger" : "",
  }));

  renderAdaptiveTable(
    "coordAuditTable",
    coords,
    [
      {
        header: "Coordinator Hub",
        match: /hub|coordinator|org|provider/i,
        render: (c) => {
          const name = cleanOrgTitle(c.synthetic_org_name || c.synthetic_organization_name);
          const city = c.city ? ` (${escapeHtml(c.city)})` : "";
          return `<div><code>${escapeHtml(c.provider_id)}</code>${city}</div>${name ? `<div class="muted-small">${escapeHtml(name)}</div>` : ""}`;
        },
      },
      {
        header: "Flat Wait",
        match: /flat|internal|waitlist/i,
        render: (c) => {
          const wl = c.active_waitlist_count ?? c.flat_active_waitlist;
          const wlTxt = wl !== undefined ? ` <span class="muted-small">(WL ${escapeHtml(wl)})</span>` : "";
          return `${escapeHtml(c.flat_median_internal_wait_days ?? "--")}d${wlTxt}`;
        },
      },
      {
        header: ">45d Breaches",
        match: /breach|chain/i,
        render: (c) => {
          const total = c.total_multihop_chains_touched ?? c.routed_episodes;
          const share = c.bounce_breach_share_pct ?? c.breach_rate_pct;
          const denom = total !== undefined ? `/${escapeHtml(total)}` : "";
          const pct = share !== undefined ? ` (${escapeHtml(share)}%)` : "";
          return `<strong>${escapeHtml(c.breached_over_45d ?? "--")}${denom}</strong>${pct}`;
        },
      },
      {
        header: "Excess Days",
        match: /excess/i,
        render: (c) => `+${escapeHtml(c.total_excess_days_over_45 ?? 0)}d`,
      },
      {
        header: "Primary Reason",
        match: /reason|cause|bounce/i,
        render: (c) => `<span class="muted-small">${escapeHtml(c.primary_bounce_reason || "paper_fax / slot mismatch")}</span>`,
      },
    ],
    "No coordinator multi-hop ranking data available."
  );

  const hubRows = (Array.isArray(btwn.bottleneck_hubs) ? btwn.bottleneck_hubs : []).map((b, idx) => ({
    ...b,
    __rowClass: idx === 0 ? "row-highlight-warn" : "",
  }));

  renderAdaptiveTable(
    "bottleneckTable",
    hubRows,
    [
      {
        header: "Bottleneck Hub",
        match: /hub|org|provider|node/i,
        render: (b) => {
          const name = cleanOrgTitle(b.synthetic_org_name || b.organization_name);
          const loc = b.city ? b.city : shortRole(b.node_role);
          return `<div><code>${escapeHtml(b.provider_id)}</code> <span class="muted-small">(${escapeHtml(loc)})</span></div><div class="muted-small">${escapeHtml(name)}</div>`;
        },
      },
      {
        header: "Flow Share",
        match: /betweenness|flow|share/i,
        render: (b) => `<strong>${escapeHtml(b.betweenness_flow_share_pct ?? "--")}%</strong>`,
      },
      {
        header: "Breaches",
        match: /breach|chain|path/i,
        render: (b) => {
          const cnt = b.breach_chains_touched ?? b.breached_paths_through_hub ?? "--";
          const tot = btwn.total_breached_multihop_chains;
          return tot !== undefined ? `${escapeHtml(cnt)} / ${escapeHtml(tot)}` : escapeHtml(cnt);
        },
      },
      {
        header: "Paper Fax %",
        match: /fax/i,
        render: (b) => `${escapeHtml(b.paper_fax_share_pct ?? "--")}%`,
      },
      {
        header: "Flat Wait",
        match: /flat|internal|wait/i,
        render: (b) => `${escapeHtml(b.flat_median_internal_wait_days ?? b.flat_internal_wait_days ?? "--")}d`,
      },
      {
        header: "Primary Bounce",
        match: /reason|bounce|cause/i,
        render: (b) => `<span class="muted-small">${escapeHtml(b.primary_bounce_reason || "--")}</span>`,
      },
    ],
    "No intermediate bottleneck hubs returned."
  );

  const simHubSelect = $("simHubSelect");
  if (simHubSelect) {
    const prevHub = simHubSelect.value;
    const optionsHtml = coordsRaw
      .map((c) => {
        const cityTxt = c.city ? `${c.city} · ` : "";
        return `<option value="${escapeHtml(c.provider_id)}">${escapeHtml(c.provider_id)} (${escapeHtml(cityTxt)}${escapeHtml(c.flat_median_internal_wait_days ?? "--")}d flat wait)</option>`;
      })
      .join("");
    simHubSelect.innerHTML =
      optionsHtml +
      `<option value="ALL">ALL Regional Coordinators (${escapeHtml(brief.state_code || "")})</option>`;
    if (prevHub && [...simHubSelect.options].some((o) => o.value === prevHub)) {
      simHubSelect.value = prevHub;
    }
  }
}

function renderSimulationCard(sim) {
  const box = $("simImpactBox");
  const episodeList = $("simEpisodeList");

  if (!sim || !sim.impact_summary) {
    if (box) box.innerHTML = `<div class="muted-small">Run a counterfactual simulation to inspect breach reductions.</div>`;
    if (episodeList) episodeList.innerHTML = "";
    return;
  }

  const s = sim.impact_summary;
  if (box) {
    box.innerHTML = `
      <div>
        <strong>Counterfactual Target: <code>${escapeHtml(sim.target_intervention_scope || sim.target_provider_id || "ALL")}</code></strong>
        <p class="muted-small" style="margin-top:3px">
          ${escapeHtml(cleanOrgTitle(sim.target_organization_name))} · Upgrading <code>paper_fax</code> to <code>ehr_electronic_portal</code> + bilingual/Medicaid slot pre-check
        </p>
        <div class="sim-metric-grid">
          <div class="sim-stat">
            <strong>${escapeHtml(s.baseline_breaches_over_45d)} &rarr; ${escapeHtml(s.simulated_breaches_over_45d)}</strong>
            <span>&gt;45-Day Breaches (${escapeHtml(s.breaches_eliminated)} Eliminated)</span>
          </div>
          <div class="sim-stat">
            <strong>${escapeHtml(s.total_delayed_child_days_saved)} days</strong>
            <span>Delayed Child-Days Saved</span>
          </div>
          <div class="sim-stat">
            <strong>${escapeHtml(s.mean_episode_wait_before_days)}d &rarr; ${escapeHtml(s.mean_episode_wait_after_days)}d</strong>
            <span>Mean Episode Wait (${escapeHtml(s.episodes_evaluated ?? "--")} chains)</span>
          </div>
          <div class="sim-stat">
            <strong>${sim.flat_spreadsheet_appearance ? escapeHtml(sim.flat_spreadsheet_appearance.median_internal_wait_days) + "d" : "5-6d"}</strong>
            <span>Deceptive Flat Internal Wait</span>
          </div>
        </div>
      </div>
    `;
  }

  if (episodeList) {
    const episodes = Array.isArray(sim.episode_level_simulation) ? sim.episode_level_simulation : [];
    if (episodes.length === 0) {
      episodeList.innerHTML = `<div class="muted-small">No affected multi-hop episodes for this hub selection.</div>`;
      return;
    }

    episodeList.innerHTML = episodes
      .slice(0, 12)
      .map((ep) => {
        const flipped = Boolean(ep.flipped_to_compliant_45d);
        const statusBadge = flipped
          ? `<span class="mini-tag ok">${ICONS.checkCircle} Flipped &lt;=45d</span>`
          : ep.simulated_wait_days <= 45
          ? `<span class="mini-tag">Already &lt;=45d</span>`
          : `<span class="mini-tag warn">Still &gt;45d</span>`;
        return `
          <div class="sim-episode-row ${flipped ? "flipped" : ""}">
            <div class="sim-episode-head">
              <code>${escapeHtml(ep.case_chain_id)}</code>
              <span class="muted-small">${escapeHtml(ep.child_age_months)}m · ${escapeHtml(ep.concern_domain)}</span>
              ${statusBadge}
            </div>
            <div class="sim-episode-metrics">
              <span>Hops: ${escapeHtml(ep.baseline_hops)} &rarr; ${escapeHtml(ep.simulated_hops)}</span>
              <span>Wait: ${escapeHtml(ep.baseline_wait_days)}d &rarr; <strong>${escapeHtml(ep.simulated_wait_days)}d</strong></span>
              <span class="saved-days">-${escapeHtml(ep.child_days_saved)}d saved</span>
            </div>
          </div>
        `;
      })
      .join("");
  }
}

// ---------------------------------------------------------------------------
// Tab 3: Outreach Deserts, Equity Audit & Agency KPIs Renderers
// ---------------------------------------------------------------------------
function renderOutreachAndEquity(brief) {
  const outreachZones = brief.outreach_zones || {};
  const screening = brief.screening_outreach || {};
  const equity = brief.equity_audit || {};
  const agencies = Array.isArray(brief.agencies) ? brief.agencies : [];

  const formulaBanner = $("outreachFormulaBanner");
  if (formulaBanner) {
    const note =
      screening.formula_note ||
      "Non-racial outreach priority index (excludes audit_* demographic shares and all-zero ACS limited_english_rate).";
    const deserts = outreachZones.hidden_ei_deserts_count;
    formulaBanner.innerHTML = `
      <span class="banner-icon">${ICONS.info}</span>
      <div>
        <strong>Non-Racial Outreach Scoring &amp; Hidden EI Desert Detection${deserts !== undefined ? ` (${escapeHtml(deserts)} deserts)` : ""}:</strong>
        <span>${escapeHtml(note)}</span>
      </div>
    `;
  }

  const zones = Array.isArray(outreachZones.ranked_outreach_zones)
    ? outreachZones.ranked_outreach_zones
    : [];
  const screeningMap = new Map(
    (Array.isArray(screening.priority_screening_tracts) ? screening.priority_screening_tracts : []).map((t) => [
      t.census_tract_geoid,
      t,
    ])
  );

  const mergedZones =
    zones.length > 0
      ? zones.map((z) => ({
          ...z,
          verified_downstream_45d_pathway: screeningMap.get(z.census_tract_geoid)?.verified_downstream_45d_pathway,
          __rowClass: z.is_hidden_ei_desert ? "row-highlight-danger" : "",
        }))
      : (screening.priority_screening_tracts || []).map((t) => ({
          ...t,
          outreach_priority_score: t.non_racial_outreach_priority_score,
          is_hidden_ei_desert: false,
          mobility_support_recommended: Boolean(t.verified_downstream_45d_pathway?.deploy_mobile_eval_van_with_screening),
          reachable_45d_paths_count: t.verified_downstream_45d_pathway?.clears_45d_mandate ? 1 : 0,
          nearest_any_clinic_km: t.verified_downstream_45d_pathway?.eval_hub_distance_km,
        }));

  renderAdaptiveTable(
    "outreachZonesTable",
    mergedZones,
    [
      {
        header: "Census Tract",
        match: /tract|geoid/i,
        render: (z) => `<code>${escapeHtml(z.census_tract_geoid)}</code><div class="muted-small">${escapeHtml(z.county_name || "")}</div>`,
      },
      {
        header: "County",
        match: /county/i,
        render: (z) => escapeHtml(z.county_name || "--"),
      },
      {
        header: "Under 5",
        match: /under|child|pop/i,
        render: (z) => formatNumber(z.children_under_5_count),
      },
      {
        header: "Poverty %",
        match: /poverty/i,
        render: (z) => `${escapeHtml(z.poverty_pct ?? "--")}%`,
      },
      {
        header: "Zero-Veh %",
        match: /veh/i,
        render: (z) => `${escapeHtml(z.zero_vehicle_pct ?? "--")}%`,
      },
      {
        header: "Nearest Clinic",
        match: /nearest|clinic|km|dist/i,
        render: (z) => {
          const base = z.nearest_any_clinic_km !== undefined ? `${escapeHtml(z.nearest_any_clinic_km)} km` : "--";
          const hasByod = z.byod_fqhc_site_name || z.byod_nearest_fqhc_km !== undefined;
          if (!hasByod) return base;
          const fqhcName = z.byod_fqhc_site_name ? cleanOrgTitle(z.byod_fqhc_site_name) : "HRSA FQHC";
          const fqhcKm = z.byod_nearest_fqhc_km !== undefined ? ` (${escapeHtml(z.byod_nearest_fqhc_km)} km)` : "";
          return `<div>${base}</div><div class="muted-small">FQHC: ${escapeHtml(fqhcName)}${fqhcKm}</div>`;
        },
      },
      {
        header: "<=45d Paths",
        match: /45d|path|reach/i,
        render: (z) => `<strong>${escapeHtml(z.reachable_45d_paths_count ?? "--")}</strong>`,
      },
      {
        header: "Status / Mobility",
        match: /desert|status|mobility|flag/i,
        render: (z) => {
          const desertTag = z.is_hidden_ei_desert
            ? `<span class="mini-tag warn">${ICONS.alertTriangle} Hidden Desert</span>`
            : `<span class="mini-tag ok">${ICONS.checkCircle} Reachable</span>`;
          const mobTag = z.mobility_support_recommended
            ? `<span class="mini-tag">NEMT / Mobile</span>`
            : "";
          const byodTag = z.byod_fqhc_site_name
            ? `<span class="mini-tag">BYOD FQHC</span>`
            : "";
          return `<div class="tag-inline">${desertTag}${mobTag}${byodTag}</div>`;
        },
      },
      {
        header: "Score",
        match: /score|priority/i,
        render: (z) => `<strong>${escapeHtml(z.outreach_priority_score ?? z.non_racial_outreach_priority_score ?? "--")}</strong>`,
      },
    ],
    "No priority outreach tracts returned."
  );

  const eqRows = Array.isArray(equity.breach_vs_timely_neighborhood_equity)
    ? equity.breach_vs_timely_neighborhood_equity
    : [];
  renderAdaptiveTable(
    "equityTable",
    eqRows,
    [
      {
        header: "Episode Outcome",
        match: /outcome|status/i,
        render: (r) => `<strong>${escapeHtml(r.ifsp_status)}</strong>`,
      },
      {
        header: "Cases",
        match: /case|episode/i,
        render: (r) => formatNumber(r.episodes),
      },
      {
        header: "Mean Wait",
        match: /wait/i,
        render: (r) => (r.mean_wait_days !== undefined ? `${escapeHtml(r.mean_wait_days)}d` : "--"),
      },
      {
        header: "Poverty",
        match: /poverty/i,
        render: (r) => `${escapeHtml(r.avg_tract_poverty_pct ?? "--")}%`,
      },
      {
        header: "Zero-Veh",
        match: /veh/i,
        render: (r) => `${escapeHtml(r.avg_zero_vehicle_pct ?? "--")}%`,
      },
      {
        header: "Black / Hisp / White",
        match: /black\s*\/|hisp|race|demograph/i,
        render: (r) =>
          `${escapeHtml(r.audit_black_pct ?? "--")}% / ${escapeHtml(r.audit_hispanic_pct ?? "--")}% / ${escapeHtml(r.audit_white_pct ?? "--")}%`,
      },
      {
        header: "Black %",
        match: /^black/i,
        render: (r) => `${escapeHtml(r.audit_black_pct ?? "--")}%`,
      },
      {
        header: "Hispanic %",
        match: /^hispanic/i,
        render: (r) => `${escapeHtml(r.audit_hispanic_pct ?? "--")}%`,
      },
      {
        header: "Indigenous %",
        match: /indigenous|native/i,
        render: (r) => `${escapeHtml(r.audit_indigenous_pct ?? "--")}%`,
      },
      {
        header: "Asian %",
        match: /asian/i,
        render: (r) => `${escapeHtml(r.audit_asian_pct ?? "--")}%`,
      },
      {
        header: "White %",
        match: /^white/i,
        render: (r) => `${escapeHtml(r.audit_white_pct ?? "--")}%`,
      },
    ],
    "No post-output equity rows available."
  );

  renderAdaptiveTable(
    "agencyKpiTable",
    agencies,
    [
      {
        header: "Agency",
        match: /agency|name|id/i,
        render: (a) => `<code>${escapeHtml(a.agency_id)}</code><div class="muted-small">${escapeHtml(cleanOrgTitle(a.synthetic_agency_name))}</div>`,
      },
      {
        header: "Counties",
        match: /count/i,
        render: (a) => `<span class="muted-small">${escapeHtml(a.served_counties || "--")}</span>`,
      },
      {
        header: "FY",
        match: /fy|year/i,
        render: (a) => escapeHtml(a.reporting_fiscal_year ?? "--"),
      },
      {
        header: "Referrals",
        match: /referral/i,
        render: (a) => formatNumber(a.annual_referrals_received),
      },
      {
        header: "Evals",
        match: /eval/i,
        render: (a) => formatNumber(a.evaluations_completed_count),
      },
      {
        header: "<=45d IFSP",
        match: /timely|ifsp|45/i,
        render: (a) => {
          const pct = Number(a.timely_45d_ifsp_pct);
          const tagCls = pct < 65 ? "warn" : "ok";
          return `<span class="mini-tag ${tagCls}">${escapeHtml(a.timely_45d_ifsp_pct ?? "--")}%</span> <span class="muted-small">(${formatNumber(a.initial_ifsp_within_45_days_count)})</span>`;
        },
      },
      {
        header: "Capacity Delays",
        match: /delay|capacity/i,
        render: (a) => formatNumber(a.ifsp_delayed_capacity_count),
      },
    ],
    "No regional Part C agency KPIs available."
  );

  const nschRows =
    equity.statewide_nsch_screening_context ||
    outreachZones.statewide_nsch_screening_gap_context ||
    [];
  renderAdaptiveTable(
    "nschTable",
    nschRows,
    [
      {
        header: "Stratum",
        match: /stratum|id/i,
        render: (n) => `<code>${escapeHtml(n.survey_stratum_id)}</code>`,
      },
      {
        header: "Level",
        match: /level|geo/i,
        render: (n) => `<span class="mini-tag">${escapeHtml(n.geographic_level || "Statewide")}</span>`,
      },
      {
        header: "Income (FPL)",
        match: /income|fpl/i,
        render: (n) => escapeHtml(n.household_income_fpl_band || "--"),
      },
      {
        header: "Home Language",
        match: /lang/i,
        render: (n) => `<strong>${escapeHtml(n.primary_home_language || "--")}</strong>`,
      },
      {
        header: "Screened %",
        match: /screen/i,
        render: (n) => `${escapeHtml(n.standardized_screening_rate_pct ?? "--")}%`,
      },
      {
        header: "Follow-Up %",
        match: /follow/i,
        render: (n) => `${escapeHtml(n.followup_requested_pct ?? "--")}%`,
      },
    ],
    "No statewide HRSA NSCH strata available."
  );

  const rigorBox = $("rigorChecklist");
  if (rigorBox) {
    const lowestNsch = nschRows[0];
    const highestNsch = nschRows[nschRows.length - 1];
    const nschSummary =
      lowestNsch && highestNsch
        ? `${escapeHtml(lowestNsch.primary_home_language)}: ${escapeHtml(lowestNsch.standardized_screening_rate_pct)}% vs. ${escapeHtml(highestNsch.primary_home_language)}: ${escapeHtml(highestNsch.standardized_screening_rate_pct)}%`
        : "6 statewide strata";
    const totalChains = brief.network_audit?.network_totals?.total_complete_chains ?? "--";

    rigorBox.innerHTML = `
      <ul class="rigor-list">
        <li>${ICONS.checkCircle} <span><strong>ACS Zero-Column Trap Caught:</strong> <code>limited_english_rate = 0.0</code> excluded from routing &amp; outreach formulas.</span></li>
        <li>${ICONS.checkCircle} <span><strong>NSCH 6x Grain Preserved:</strong> Statewide-only screening gap (${nschSummary}) never cross-joined to tracts.</span></li>
        <li>${ICONS.checkCircle} <span><strong>Prefix-Safe ISO GQL:</strong> Correlated <code>case_chain_id</code> + deduplicated 4-hop chains (${escapeHtml(totalChains)} complete chains).</span></li>
        <li>${ICONS.checkCircle} <span><strong>Bias Firewall:</strong> <code>audit_*</code> demographic shares attached strictly post-output.</span></li>
        <li>${ICONS.checkCircle} <span><strong>Stage-Safe Provenance:</strong> <code>SYN-PROV-*</code> &amp; <code>SYN-PARTC-*</code> are 100% <code>[Synthetic]</code>.</span></li>
      </ul>
    `;
  }

  renderBeforeAfterEquity(brief);
}

function renderBeforeAfterEquity(brief) {
  const grid = $("beforeAfterMetricsGrid");
  const cohort = brief?.equity_audit?.before_vs_after_rerouting_cohort;
  const simSum = brief?.counterfactual_simulation?.impact_summary;

  if (grid) {
    if (cohort) {
      grid.innerHTML = `
        <div class="sim-stat">
          <strong>${escapeHtml(cohort.mean_wait_before_days ?? "--")}d &rarr; ${escapeHtml(cohort.mean_wait_after_days ?? "--")}d</strong>
          <span>Mean Cohort Wait</span>
        </div>
        <div class="sim-stat">
          <strong>${escapeHtml(cohort.timely_45d_before_pct ?? "--")}% &rarr; ${escapeHtml(cohort.timely_45d_after_pct ?? "--")}%</strong>
          <span>45-Day Timely IFSP Rate</span>
        </div>
        <div class="sim-stat">
          <strong>${escapeHtml(cohort.mean_dropoff_before_pct ?? "--")}% &rarr; ${escapeHtml(cohort.mean_dropoff_after_pct ?? "--")}%</strong>
          <span>Referral Drop-Off (<code>dropoff_rate_pct</code>)</span>
        </div>
        <div class="sim-stat">
          <strong>-${escapeHtml(cohort.dropoff_reduction_pp ?? "--")} pp</strong>
          <span>Attrition Reduction</span>
        </div>
      `;
    } else if (simSum) {
      grid.innerHTML = `
        <div class="sim-stat">
          <strong>${escapeHtml(simSum.mean_episode_wait_before_days ?? "--")}d &rarr; ${escapeHtml(simSum.mean_episode_wait_after_days ?? "--")}d</strong>
          <span>Mean Episode Wait (Sim Estimate)</span>
        </div>
        <div class="sim-stat">
          <strong>${escapeHtml(simSum.baseline_breaches_over_45d ?? "--")} &rarr; ${escapeHtml(simSum.simulated_breaches_over_45d ?? "--")}</strong>
          <span>&gt;45-Day Breaches Eliminated</span>
        </div>
        <div class="sim-stat">
          <strong>${escapeHtml(simSum.total_delayed_child_days_saved ?? "--")}d</strong>
          <span>Child-Days Saved</span>
        </div>
        <div class="sim-stat">
          <strong>Pending Cohort API</strong>
          <span>Drop-Off Delta (Awaiting Backend)</span>
        </div>
      `;
    } else {
      grid.innerHTML = `<div class="muted-small">Cohort before/after equity delta will render when audit data is available.</div>`;
    }
  }

  const subgroupRows = Array.isArray(cohort?.subgroup_equity_rows)
    ? cohort.subgroup_equity_rows
    : Array.isArray(cohort?.post_output_demographic_parity)
    ? cohort.post_output_demographic_parity
    : [];
  renderAdaptiveTable(
    "beforeAfterSubgroupTable",
    subgroupRows,
    [
      {
        header: "Subgroup Stratum",
        match: /subgroup|stratum|group|label/i,
        render: (r) => `<strong>${escapeHtml(r.subgroup || r.stratum || r.label || "--")}</strong>`,
      },
      {
        header: "Cases",
        match: /case|episode|count/i,
        render: (r) => formatNumber(r.cases ?? r.episodes ?? r.count ?? cohort?.episodes),
      },
      {
        header: "Wait Before -> After",
        match: /wait/i,
        render: (r) =>
          `${escapeHtml(r.mean_wait_before_days ?? r.wait_before_d ?? "--")}d &rarr; <strong>${escapeHtml(r.mean_wait_after_days ?? r.wait_after_d ?? "--")}d</strong>`,
      },
      {
        header: "45d Timely Before -> After",
        match: /timely|45d/i,
        render: (r) =>
          `${escapeHtml(r.timely_45d_before_pct ?? r.timely_before_pct ?? "--")}% &rarr; <strong>${escapeHtml(r.timely_45d_after_pct ?? r.timely_after_pct ?? "--")}%</strong>`,
      },
      {
        header: "Drop-Off Before -> After",
        match: /drop|attrition/i,
        render: (r) =>
          `${escapeHtml(r.mean_dropoff_before_pct ?? r.dropoff_before_pct ?? "--")}% &rarr; <strong>${escapeHtml(r.mean_dropoff_after_pct ?? r.dropoff_after_pct ?? "--")}%</strong>`,
      },
    ],
    "Subgroup before/after re-routing rows populate from equity_audit.before_vs_after_rerouting_cohort."
  );
}

// ---------------------------------------------------------------------------
// ISO GQL Modal & Focus Management
// ---------------------------------------------------------------------------
function getGqlText(key) {
  const brief = state.brief || {};
  if (key === "audit") {
    return [
      brief.network_audit?.iso_gql_query,
      brief.bottleneck_hubs?.iso_gql_query,
    ]
      .filter(Boolean)
      .join("\n\n-- ---------------------------------------------------------------------------\n\n");
  }
  if (key === "outreach") {
    return brief.outreach_zones?.iso_gql_query || "-- No outreach ISO GQL query available.";
  }
  return [
    brief.routing?.iso_gql_query,
    brief.viable_45d_paths?.iso_gql_query,
  ]
    .filter(Boolean)
    .join("\n\n-- ---------------------------------------------------------------------------\n\n");
}

function setGqlTab(key) {
  state.activeGqlKey = key;
  document.querySelectorAll("[data-gql]").forEach((btn) => {
    const isActive = btn.dataset.gql === key;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
    if (btn.getAttribute("role") === "tab") {
      btn.setAttribute("aria-selected", String(isActive));
    }
  });
  const codeBlock = $("gqlCodeBlock");
  if (codeBlock) {
    codeBlock.textContent = getGqlText(key) || "-- ISO GQL query unavailable.";
  }
  renderGqlTelemetryBar();
}

function isGqlModalOpen() {
  const modal = $("gqlModal");
  return Boolean(modal && !modal.hidden && !modal.classList.contains("hidden"));
}

function openGqlModal() {
  const modal = $("gqlModal");
  if (!modal) return;
  state.lastModalTrigger = document.activeElement;

  const defaultKey =
    state.activeTab === "hubs"
      ? "audit"
      : state.activeTab === "outreach"
      ? "outreach"
      : "routing";
  setGqlTab(defaultKey);

  modal.hidden = false;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  const closeBtn = $("closeGqlBtn");
  if (closeBtn) closeBtn.focus();
}

function closeGqlModal() {
  const modal = $("gqlModal");
  if (!modal) return;
  modal.hidden = true;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");

  if (state.lastModalTrigger && typeof state.lastModalTrigger.focus === "function") {
    state.lastModalTrigger.focus();
  }
  state.lastModalTrigger = null;
}

// ---------------------------------------------------------------------------
// Interactive Cytoscape.js Multi-Hop Referral Network Graph
// ---------------------------------------------------------------------------
function roleToStageCol(role) {
  if (role === "Screening_Pediatric_Clinic") return 0;
  if (role === "Part_C_Intake_Coordinator") return 1;
  if (role === "Multidisciplinary_Eval_Hub") return 2;
  if (role === "EI_Therapy_Vendor") return 3;
  return 2;
}

function buildCytoscapeElements(brief) {
  const routing = brief?.routing || {};
  const recMeta = routing.recommended_pathway || {};
  const bounceMeta = routing.cautionary_historical_bounce_chain || {};
  const recHops = (Array.isArray(recMeta.hops) ? recMeta.hops : []).map(normalizeHop).filter(Boolean);
  const bounceHops = (Array.isArray(bounceMeta.hops) ? bounceMeta.hops : []).map(normalizeHop).filter(Boolean);
  const viablePaths = Array.isArray(brief?.viable_45d_paths?.viable_paths)
    ? brief.viable_45d_paths.viable_paths.slice(0, 4)
    : [];

  const nodeMap = new Map();
  const edgeMap = new Map();

  function ensureNode(id, patch = {}) {
    if (!id) return null;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        id,
        orgName: "",
        role: "",
        inCompliant: false,
        inBounce: false,
        inViable: false,
        isOrigin: false,
        waitDays: null,
        cumDays: null,
        bounceCumDays: null,
        channels: new Set(),
        acceptsMedicaid: null,
        isBilingual: null,
        distanceKm: null,
        bounceReason: "",
        stageCol: null,
      });
    }
    const cur = nodeMap.get(id);
    if (patch.orgName && !cur.orgName) cur.orgName = cleanOrgTitle(patch.orgName);
    if (patch.role && !cur.role) cur.role = patch.role;
    if (patch.inCompliant) cur.inCompliant = true;
    if (patch.inBounce) cur.inBounce = true;
    if (patch.inViable) cur.inViable = true;
    if (patch.isOrigin) cur.isOrigin = true;
    if (patch.waitDays !== undefined && patch.waitDays !== null && cur.waitDays === null) {
      cur.waitDays = patch.waitDays;
    }
    if (patch.cumDays !== undefined && patch.cumDays !== null && (cur.cumDays === null || patch.inCompliant)) {
      cur.cumDays = patch.cumDays;
    }
    if (patch.bounceCumDays !== undefined && patch.bounceCumDays !== null) {
      cur.bounceCumDays = patch.bounceCumDays;
    }
    if (patch.channel) cur.channels.add(patch.channel);
    if (patch.acceptsMedicaid !== undefined && patch.acceptsMedicaid !== null) {
      cur.acceptsMedicaid = Boolean(patch.acceptsMedicaid);
    }
    if (patch.isBilingual !== undefined && patch.isBilingual !== null) {
      cur.isBilingual = Boolean(patch.isBilingual);
    }
    if (patch.distanceKm !== undefined && patch.distanceKm !== null && cur.distanceKm === null) {
      cur.distanceKm = patch.distanceKm;
    }
    if (patch.bounceReason && !cur.bounceReason) cur.bounceReason = patch.bounceReason;
    if (patch.stageCol !== undefined && patch.stageCol !== null) cur.stageCol = patch.stageCol;
    return cur;
  }

  // 1. Recommended <=45d Electronic Pathway
  if (recHops.length > 0) {
    const first = recHops[0];
    ensureNode(first.sourceId, {
      orgName: first.sourceName,
      role: first.sourceRole || "Screening_Pediatric_Clinic",
      inCompliant: true,
      isOrigin: true,
      waitDays: 0,
      cumDays: 0,
      channel: "ehr_electronic_portal",
      acceptsMedicaid: recMeta.all_nodes_medicaid_enrolled ?? true,
      isBilingual: recMeta.all_care_nodes_bilingual ?? true,
    });
    recHops.forEach((h, idx) => {
      ensureNode(h.targetId, {
        orgName: h.targetName,
        role: h.targetRole || (idx === 0 ? "Part_C_Intake_Coordinator" : idx === 1 ? "Multidisciplinary_Eval_Hub" : "EI_Therapy_Vendor"),
        inCompliant: true,
        waitDays: h.waitDays,
        cumDays: h.cumDays,
        channel: h.channel || "ehr_electronic_portal",
        acceptsMedicaid: h.acceptsMedicaid ?? recMeta.all_nodes_medicaid_enrolled ?? true,
        isBilingual: h.isBilingual ?? recMeta.all_care_nodes_bilingual ?? true,
        distanceKm: h.distanceKm,
      });
      const edgeKey = `compliant:${h.sourceId}->${h.targetId}`;
      edgeMap.set(edgeKey, {
        id: edgeKey,
        source: h.sourceId,
        target: h.targetId,
        lane: "compliant",
        channel: h.channel || "ehr_electronic_portal",
        waitDays: h.waitDays,
        cumDays: h.cumDays,
        isBounce: false,
        bounceReason: "",
        distanceKm: h.distanceKm,
        acceptsMedicaid: h.acceptsMedicaid ?? recMeta.all_nodes_medicaid_enrolled ?? true,
        isBilingual: h.isBilingual ?? recMeta.all_care_nodes_bilingual ?? true,
        label: `${h.channel === "paper_fax" ? "Fax" : "EHR"} +${h.waitDays}d`,
      });
    });
  }

  // 2. Historical >45d Bounce Chain
  if (bounceHops.length > 0) {
    const firstB = bounceHops[0];
    ensureNode(firstB.sourceId, {
      orgName: firstB.sourceName,
      role: firstB.sourceRole || "Screening_Pediatric_Clinic",
      inBounce: true,
      isOrigin: true,
      waitDays: 0,
      bounceCumDays: 0,
      channel: firstB.channel,
    });
    bounceHops.forEach((h, idx) => {
      const srcNode = nodeMap.get(h.sourceId);
      const tgtRole =
        h.targetRole ||
        (idx === 0 ? "Part_C_Intake_Coordinator" : idx === 1 ? "Multidisciplinary_Eval_Hub" : "EI_Therapy_Vendor");
      const extraStage =
        idx >= 3 && tgtRole === "EI_Therapy_Vendor" && srcNode?.role === "EI_Therapy_Vendor" ? 4 : null;
      ensureNode(h.targetId, {
        orgName: h.targetName,
        role: tgtRole,
        inBounce: true,
        waitDays: h.waitDays,
        bounceCumDays: h.cumDays,
        channel: h.channel || "paper_fax",
        acceptsMedicaid: h.acceptsMedicaid ?? (h.isBounce ? false : null),
        isBilingual: h.isBilingual ?? null,
        distanceKm: h.distanceKm,
        bounceReason: h.bounceReason,
        stageCol: extraStage,
      });
      const edgeKey = `bounce:${h.sourceId}->${h.targetId}:${idx}`;
      const chShort =
        h.channel === "paper_fax"
          ? "paper_fax"
          : h.channel === "phone_voicemail"
          ? "Voicemail"
          : "EHR";
      edgeMap.set(edgeKey, {
        id: edgeKey,
        source: h.sourceId,
        target: h.targetId,
        lane: "bounce",
        channel: h.channel || "paper_fax",
        waitDays: h.waitDays,
        cumDays: h.cumDays,
        isBounce: Boolean(h.isBounce),
        bounceReason: h.bounceReason || "",
        distanceKm: h.distanceKm,
        acceptsMedicaid: h.acceptsMedicaid ?? null,
        isBilingual: h.isBilingual ?? null,
        label: `${chShort === "paper_fax" ? "Fax" : chShort} +${h.waitDays}d`,
      });
    });
  }

  // 3. Viable <=45d Alternative Graph Paths
  viablePaths.forEach((vp, pIdx) => {
    const pNodes =
      Array.isArray(vp.nodes) && vp.nodes.length >= 2
        ? vp.nodes
        : vp.start_provider_id && vp.eval_provider_id
        ? [vp.start_provider_id, vp.eval_provider_id]
        : [];
    if (pNodes.length < 2) return;

    pNodes.forEach((nid, nIdx) => {
      const inferredRole =
        nIdx === 0
          ? "Screening_Pediatric_Clinic"
          : nIdx === pNodes.length - 1
          ? vp.eval_role || "EI_Therapy_Vendor"
          : nIdx === 1
          ? "Part_C_Intake_Coordinator"
          : "Multidisciplinary_Eval_Hub";
      const inferredName =
        nIdx === 0
          ? vp.start_name
          : nIdx === pNodes.length - 1
          ? vp.eval_name
          : "";
      ensureNode(nid, {
        orgName: inferredName,
        role: inferredRole,
        inViable: true,
        cumDays: nIdx === pNodes.length - 1 ? vp.total_expected_days : null,
        channel: "ehr_electronic_portal",
        acceptsMedicaid: vp.accepts_medicaid ?? true,
        isBilingual: vp.bilingual_services_listed ?? true,
        distanceKm: nIdx === pNodes.length - 1 ? vp.distance_km : null,
      });
    });

    for (let i = 0; i < pNodes.length - 1; i += 1) {
      const src = pNodes[i];
      const tgt = pNodes[i + 1];
      const alreadyPrimary = Array.from(edgeMap.values()).some(
        (e) => e.source === src && e.target === tgt && (e.lane === "compliant" || e.lane === "viable")
      );
      if (!alreadyPrimary) {
        const edgeKey = `viable:${src}->${tgt}:${pIdx}:${i}`;
        const stepWait =
          i === 0
            ? vp.intake_lag_days ?? 6
            : i === pNodes.length - 2
            ? vp.evaluator_backlog_days ?? 14
            : vp.handoff_days ?? 12;
        edgeMap.set(edgeKey, {
          id: edgeKey,
          source: src,
          target: tgt,
          lane: "viable",
          channel: "ehr_electronic_portal",
          waitDays: stepWait,
          cumDays: vp.total_expected_days ?? stepWait,
          isBounce: false,
          bounceReason: "",
          distanceKm: vp.distance_km,
          acceptsMedicaid: vp.accepts_medicaid ?? true,
          isBilingual: vp.bilingual_services_listed ?? true,
          label: `Alt +${stepWait}d`,
        });
      }
    }
  });

  // Assign Medical Clean categories & deterministic layered coordinates
  const columns = new Map();
  nodeMap.forEach((n) => {
    const col = n.stageCol !== null ? n.stageCol : roleToStageCol(n.role);
    n.resolvedCol = col;
    if (n.role === "Part_C_Intake_Coordinator" || (n.isOrigin && n.inCompliant)) {
      n.category = "coordinator";
    } else if (n.inCompliant) {
      n.category = "compliant";
    } else if (n.inBounce && !n.inViable) {
      n.category = "bounce";
    } else {
      n.category = "viable";
    }
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(n);
  });

  const categoryRank = { compliant: 0, coordinator: 1, viable: 2, bounce: 3 };
  const stageX = [95, 300, 505, 710, 900];
  const cyNodes = [];

  columns.forEach((nodesInCol, colIdx) => {
    nodesInCol.sort((a, b) => (categoryRank[a.category] ?? 9) - (categoryRank[b.category] ?? 9));
    const count = nodesInCol.length;
    const spacingY = 92;
    const centerY = 150;
    const startY = centerY - ((count - 1) * spacingY) / 2;
    const xPos = stageX[Math.min(colIdx, stageX.length - 1)];

    nodesInCol.forEach((n, idx) => {
      const roleShort = shortRole(n.role);
      const chList = Array.from(n.channels);
      const primaryChannel = chList.includes("paper_fax") && !n.inCompliant
        ? "paper_fax"
        : chList[0] || "ehr_electronic_portal";
      const displayCumDays = n.cumDays !== null ? n.cumDays : n.bounceCumDays;

      cyNodes.push({
        group: "nodes",
        data: {
          id: n.id,
          label: `${n.id}\n${roleShort}`,
          orgName: n.orgName || n.id,
          role: n.role || "CareNode",
          roleLabel: roleShort,
          category: n.category,
          inCompliant: n.inCompliant,
          inBounce: n.inBounce,
          inViable: n.inViable,
          waitDays: n.waitDays ?? 0,
          cumDays: displayCumDays ?? 0,
          bounceCumDays: n.bounceCumDays,
          channel: primaryChannel,
          channelsText: chList.length > 0 ? chList.join(", ") : primaryChannel,
          acceptsMedicaid: n.acceptsMedicaid,
          isBilingual: n.isBilingual,
          distanceKm: n.distanceKm,
          bounceReason: n.bounceReason,
        },
        position: {
          x: xPos,
          y: Math.round(startY + idx * spacingY),
        },
      });
    });
  });

  const cyEdges = Array.from(edgeMap.values()).map((e) => ({
    group: "edges",
    data: e,
  }));

  return [...cyNodes, ...cyEdges];
}

// Strict Medical Clean Cytoscape Stylesheet (Zero Violet / Indigo / Lavender)
const CYTOSCAPE_MEDICAL_STYLE = [
  {
    selector: "node",
    style: {
      shape: "round-rectangle",
      width: 148,
      height: 50,
      "background-color": "#F8FAFC",
      "border-width": 2,
      "border-color": "#0F172A",
      label: "data(label)",
      color: "#0F172A",
      "font-family": "Noto Sans, system-ui, sans-serif",
      "font-size": "11px",
      "font-weight": "600",
      "text-wrap": "wrap",
      "text-max-width": "138px",
      "text-valign": "center",
      "text-halign": "center",
    },
  },
  {
    selector: 'node[category = "coordinator"]',
    style: {
      "background-color": "#CCFBF1",
      "border-color": "#0F766E",
      "border-width": 2.5,
      color: "#0F172A",
    },
  },
  {
    selector: 'node[category = "compliant"]',
    style: {
      "background-color": "#DCFCE7",
      "border-color": "#15803D",
      "border-width": 2.5,
      color: "#0F172A",
    },
  },
  {
    selector: 'node[category = "bounce"]',
    style: {
      "background-color": "#FEE2E2",
      "border-color": "#B91C1C",
      "border-width": 2.5,
      color: "#0F172A",
    },
  },
  {
    selector: 'node[category = "viable"]',
    style: {
      "background-color": "#F8FAFC",
      "border-color": "#0F172A",
      "border-width": 2,
      color: "#0F172A",
    },
  },
  {
    selector: "node:selected",
    style: {
      "border-color": "#0369A1",
      "border-width": 3.5,
    },
  },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      width: 2.5,
      "line-color": "#0F766E",
      "target-arrow-color": "#0F766E",
      "target-arrow-shape": "triangle",
      "arrow-scale": 1.05,
      label: "data(label)",
      "font-family": "JetBrains Mono, monospace",
      "font-size": "10px",
      color: "#0F172A",
      "text-background-color": "#FFFFFF",
      "text-background-opacity": 0.9,
      "text-background-padding": "2px",
      "text-background-shape": "roundrectangle",
    },
  },
  {
    selector: 'edge[lane = "compliant"]',
    style: {
      "line-color": "#15803D",
      "target-arrow-color": "#15803D",
      "line-style": "solid",
      width: 3,
    },
  },
  {
    selector: 'edge[lane = "bounce"]',
    style: {
      "line-color": "#B91C1C",
      "target-arrow-color": "#B91C1C",
      "line-style": "dashed",
      "line-dash-pattern": [7, 4],
      width: 2.5,
    },
  },
  {
    selector: 'edge[lane = "viable"]',
    style: {
      "line-color": "#0F766E",
      "target-arrow-color": "#0F766E",
      "line-style": "dotted",
      width: 2,
    },
  },
  {
    selector: "edge:selected",
    style: {
      "line-color": "#0369A1",
      "target-arrow-color": "#0369A1",
      width: 3.5,
    },
  },
];

function updateCyInspectorForNode(d) {
  const inspector = $("cyNodeInspector");
  if (!inspector || !d) return;

  const medStatus =
    d.acceptsMedicaid === true
      ? "Medicaid Enrolled"
      : d.acceptsMedicaid === false
      ? "Medicaid Hold / Cap"
      : "Medicaid Pending Check";
  const bilStatus =
    d.isBilingual === true
      ? "Spanish-Bilingual Verified"
      : d.isBilingual === false
      ? "English-Only"
      : "Language Check Required";
  const distTxt =
    d.distanceKm !== undefined && d.distanceKm !== null ? ` · Distance: ${escapeHtml(d.distanceKm)} km` : "";
  const waitTxt =
    d.bounceCumDays !== null && d.bounceCumDays !== undefined && !d.inCompliant
      ? `Bounce Cumulative: ${escapeHtml(d.bounceCumDays)}d (+${escapeHtml(d.waitDays)}d hop)`
      : `Cumulative Wait: ${escapeHtml(d.cumDays)}d (+${escapeHtml(d.waitDays)}d hop)`;
  const reasonTxt = d.bounceReason ? ` · Bounce Cause: ${escapeHtml(d.bounceReason)}` : "";

  inspector.innerHTML =
    `<strong>CareNode Vertex:</strong> <code>${escapeHtml(d.id)}</code> — ${escapeHtml(d.orgName)} ` +
    `(${escapeHtml(d.roleLabel)}) · <strong>${waitTxt}</strong> · Channel: <code>${escapeHtml(d.channel)}</code> · ` +
    `${escapeHtml(medStatus)} · ${escapeHtml(bilStatus)}${distTxt}${reasonTxt}`;
}

function updateCyInspectorForEdge(d) {
  const inspector = $("cyNodeInspector");
  if (!inspector || !d) return;

  const laneLabel =
    d.lane === "bounce"
      ? ">45d Historical Bounce Chain"
      : d.lane === "compliant"
      ? "<=45d Recommended Electronic Route"
      : "<=45d Viable Alternative Corridor";
  const distTxt =
    d.distanceKm !== undefined && d.distanceKm !== null ? ` · Distance: ${escapeHtml(d.distanceKm)} km` : "";
  const credTxt =
    d.acceptsMedicaid && d.isBilingual
      ? " · Medicaid + Spanish-Bilingual"
      : d.acceptsMedicaid
      ? " · Medicaid Enrolled"
      : "";
  const reasonTxt = d.bounceReason ? ` · Bounce Cause: ${escapeHtml(d.bounceReason)}` : "";

  inspector.innerHTML =
    `<strong>ReferralHandoff Edge:</strong> <code>${escapeHtml(d.source)}</code> &rarr; <code>${escapeHtml(d.target)}</code> ` +
    `(${escapeHtml(laneLabel)}) · Handoff Wait: <strong>+${escapeHtml(d.waitDays)}d</strong> (Day ${escapeHtml(d.cumDays)}) · ` +
    `Channel: <code>${escapeHtml(d.channel)}</code>${credTxt}${distTxt}${reasonTxt}`;
}

function applyCytoscapeFilter(filterMode = "all", { fit = true } = {}) {
  const mode = ["all", "compliant", "bounce"].includes(filterMode) ? filterMode : "all";
  state.cyFilter = mode;

  document.querySelectorAll(".cy-filter-btn[data-cy-filter]").forEach((btn) => {
    const active = btn.dataset.cyFilter === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });

  const cy = window.__cyInstance;
  if (!cy) return;

  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const d = n.data();
      let show = true;
      if (mode === "compliant") {
        show = Boolean(d.inCompliant || d.inViable);
      } else if (mode === "bounce") {
        show = Boolean(d.inBounce);
      }
      n.style("display", show ? "element" : "none");
    });

    cy.edges().forEach((e) => {
      const lane = e.data("lane");
      let show = true;
      if (mode === "compliant") {
        show = lane === "compliant" || lane === "viable";
      } else if (mode === "bounce") {
        show = lane === "bounce";
      }
      e.style("display", show ? "element" : "none");
    });
  });

  cy.scratch("_activeFilter", mode);
  if (fit) {
    const visible = cy.elements(":visible");
    if (visible.length > 0 && cy.width() > 0 && cy.height() > 0) {
      cy.fit(visible, 28);
    }
  }
}

function renderCytoscapeGraph(brief) {
  const container = $("cyGraphCanvas");
  const inspector = $("cyNodeInspector");
  if (!container) return;

  if (typeof window.cytoscape !== "function") {
    if (inspector) {
      inspector.textContent = "Cytoscape.js bundle unavailable; displaying hop cards below.";
    }
    return;
  }

  const elements = buildCytoscapeElements(brief);

  if (window.__cyInstance && window.__cyInstance.container() === container) {
    const cy = window.__cyInstance;
    cy.elements().remove();
    cy.add(elements);
    cy.layout({ name: "preset", fit: true, padding: 28 }).run();
  } else {
    if (window.__cyInstance) {
      window.__cyInstance.destroy();
    }
    const cy = window.cytoscape({
      container,
      elements,
      style: CYTOSCAPE_MEDICAL_STYLE,
      layout: { name: "preset", fit: true, padding: 28 },
      minZoom: 0.4,
      maxZoom: 2.2,
      wheelSensitivity: 0.25,
      boxSelectionEnabled: false,
    });

    cy.on("tap", "node", (evt) => {
      updateCyInspectorForNode(evt.target.data());
    });

    cy.on("tap", "edge", (evt) => {
      updateCyInspectorForEdge(evt.target.data());
    });

    window.__cyInstance = cy;
  }

  applyCytoscapeFilter(state.cyFilter, { fit: true });

  if (inspector && window.__cyInstance) {
    const nodeCount = window.__cyInstance.nodes().length;
    const edgeCount = window.__cyInstance.edges().length;
    inspector.innerHTML =
      `<strong>${escapeHtml(brief.state_code || "MS")} Property Graph Loaded:</strong> ` +
      `${nodeCount} <code>CareNode</code> vertices &amp; ${edgeCount} directed <code>REFERS_TO</code> handoffs. ` +
      `Click any vertex or edge to inspect wait days, <code>paper_fax</code> vs. <code>ehr_electronic_portal</code> channel, and Medicaid/bilingual credentials.`;
  }
}

// ---------------------------------------------------------------------------
// Counterfactual Intake Controls & 5-Tier Statutory Gate (34 CFR § 303.209)
// ---------------------------------------------------------------------------
function getStatutoryTierInfo(ageMonths) {
  const age = Number(ageMonths);
  if (Number.isNaN(age) || age < 24) {
    return {
      tier: "Tier 1 · Standard Part C (0–23m)",
      badgeClass: "badge-compliant",
    };
  }
  if (age <= 29) {
    return {
      tier: "Tier 2 · Early Transition Watch (24–29m)",
      badgeClass: "badge-compliant",
    };
  }
  if (age <= 32) {
    return {
      tier: "Tier 3 · Concurrent Part B Notice (30–32m · 34 CFR § 303.209)",
      badgeClass: "badge-warn",
    };
  }
  if (age <= 35) {
    return {
      tier: "Tier 4 · Urgent 36m Cliff / Part B LEA Referral (33–35m)",
      badgeClass: "badge-breach",
    };
  }
  return {
    tier: "Tier 5 · Aged Out -> IDEA Part B § 619 via LEA (36m+)",
    badgeClass: "badge-breach",
  };
}

function updateIntakeAgeDisplay(ageMonths) {
  const ageValEl = $("intakeAgeValue");
  const tierBadge = $("intakeStatutoryTierBadge");
  if (ageValEl) ageValEl.textContent = `${ageMonths}m`;
  if (tierBadge) {
    const info = getStatutoryTierInfo(ageMonths);
    tierBadge.textContent = info.tier;
    tierBadge.className = `badge ${info.badgeClass}`;
  }
}

function setToggleChipState(btnId, active) {
  const btn = $(btnId);
  if (!btn) return;
  btn.classList.toggle("active", Boolean(active));
  btn.setAttribute("aria-checked", String(Boolean(active)));
}

function syncIntakeControlsFromBrief(brief) {
  const profile = brief?.routing?.child_profile || {};
  if (profile.home_tract_geoid) state.intake.tractGeoid = String(profile.home_tract_geoid);
  if (profile.child_age_months !== undefined && profile.child_age_months !== null) {
    state.intake.ageMonths = Number(profile.child_age_months);
  }
  if (profile.concern_domain) state.intake.concernDomain = String(profile.concern_domain);
  if (profile.needs_medicaid !== undefined) state.intake.needsMedicaid = Boolean(profile.needs_medicaid);
  if (profile.needs_bilingual !== undefined) state.intake.needsBilingual = Boolean(profile.needs_bilingual);
  if (profile.has_household_vehicle !== undefined) state.intake.hasVehicle = Boolean(profile.has_household_vehicle);

  const slider = $("intakeAgeSlider");
  if (slider) slider.value = String(state.intake.ageMonths);
  updateIntakeAgeDisplay(state.intake.ageMonths);

  const concernSel = $("intakeConcernSelect");
  if (concernSel && state.intake.concernDomain) {
    if (![...concernSel.options].some((o) => o.value === state.intake.concernDomain)) {
      const opt = document.createElement("option");
      opt.value = state.intake.concernDomain;
      opt.textContent = state.intake.concernDomain;
      concernSel.appendChild(opt);
    }
    concernSel.value = state.intake.concernDomain;
  }

  setToggleChipState("intakeMedicaidToggle", state.intake.needsMedicaid);
  setToggleChipState("intakeBilingualToggle", state.intake.needsBilingual);
  setToggleChipState("intakeVehicleToggle", state.intake.hasVehicle);
  populateIntakeTractOptions(brief);
}

function populateIntakeTractOptions(brief) {
  const sel = $("intakeTractSelect");
  if (!sel) return;
  const map = new Map();

  const geoTracts = Array.isArray(state.geo?.tracts) ? state.geo.tracts : [];
  geoTracts.forEach((t) => {
    if (t.tract_geoid) {
      map.set(String(t.tract_geoid), `${t.tract_geoid}${t.county_name ? ` — ${t.county_name}` : ""}`);
    }
  });

  const zones = Array.isArray(brief?.outreach_zones?.ranked_outreach_zones)
    ? brief.outreach_zones.ranked_outreach_zones
    : [];
  zones.forEach((z) => {
    if (z.census_tract_geoid && !map.has(String(z.census_tract_geoid))) {
      map.set(
        String(z.census_tract_geoid),
        `${z.census_tract_geoid}${z.county_name ? ` — ${z.county_name}` : ""}`
      );
    }
  });

  const activeTract = state.intake.tractGeoid || brief?.routing?.child_profile?.home_tract_geoid || "";
  const activeCounty = brief?.routing?.child_profile?.county_name || "";
  if (activeTract && !map.has(activeTract)) {
    map.set(activeTract, `${activeTract}${activeCounty ? ` — ${activeCounty}` : ""}`);
  }

  sel.innerHTML = Array.from(map.entries())
    .map(([geoid, lbl]) => `<option value="${escapeHtml(geoid)}">${escapeHtml(lbl)}</option>`)
    .join("");
  if (activeTract && map.has(activeTract)) {
    sel.value = activeTract;
  }
}

// ---------------------------------------------------------------------------
// Hop-0 Packet Readiness Gatekeeper
// ---------------------------------------------------------------------------
function computeGatekeeperFallback(payload) {
  const missing = [];
  const warnings = [];
  let score = 100;
  if (!payload.has_screening_tool) {
    missing.push("Completed ASQ-3 / M-CHAT-R Screening Tool");
    score -= 30;
  }
  if (!payload.has_parent_consent) {
    missing.push("Signed Parent / Caregiver Referral Consent");
    score -= 35;
  }
  const tierInfo = getStatutoryTierInfo(payload.child_age_months);
  if (Number(payload.child_age_months) >= 30) {
    warnings.push("34 CFR § 303.209 concurrent Part B preschool transition notice required.");
  }
  if (!payload.has_household_vehicle) {
    warnings.push("Flag Medicaid NEMT ride assistance or mobile evaluation team.");
  }
  return {
    readiness_score: Math.max(0, score),
    statutory_transition_tier: tierInfo.tier,
    missing_items: missing,
    warnings,
    status: missing.length === 0 ? "READY_FOR_EHR_DISPATCH" : "HOLD_MISSING_PACKET_ITEMS",
    __localFallback: true,
  };
}

function renderGatekeeperResult(res) {
  const box = $("gatekeeperResult");
  if (!box || !res) return;
  state.gatekeeper.lastResult = res;

  const score = res.readiness_score ?? res.score ?? "--";
  const tier = res.statutory_transition_tier || getStatutoryTierInfo(state.intake.ageMonths).tier;
  const statusTxt = res.status || (Number(score) >= 80 ? "READY" : "INCOMPLETE");
  const missing = Array.isArray(res.missing_items) ? res.missing_items : [];
  const warnings = Array.isArray(res.warnings) ? res.warnings : [];
  const isReady = missing.length === 0 && Number(score) >= 75;

  const missingHtml =
    missing.length > 0
      ? `<div class="gatekeeper-blockers">${missing
          .map((m) => `<span class="mini-tag warn">${ICONS.alertTriangle} ${escapeHtml(m)}</span>`)
          .join("")}</div>`
      : `<span class="mini-tag ok">${ICONS.checkCircle} Zero Missing Hop-0 Packet Items</span>`;

  const warningsHtml =
    warnings.length > 0
      ? `<div class="muted-small">${warnings.map((w) => escapeHtml(w)).join(" · ")}</div>`
      : "";

  box.innerHTML = `
    <div class="gatekeeper-top-row">
      <span class="mini-tag ${isReady ? "ok" : "warn"}">${ICONS.shieldCheck} Readiness: <strong>${escapeHtml(score)}/100</strong> (${escapeHtml(statusTxt)})</span>
      <span class="mini-tag">${escapeHtml(tier)}</span>
      ${res.__localFallback ? `<span class="mini-tag">Local Pre-Flight Check</span>` : ""}
    </div>
    ${missingHtml}
    ${warningsHtml}
  `;
}

async function verifyIntakePacket() {
  const btn = $("verifyPacketBtn");
  const stateCode = $("stateSelect")?.value || state.brief?.state_code || "MS";
  const payload = {
    state_code: stateCode,
    child_age_months: Number(state.intake.ageMonths ?? 32),
    concern_domain: state.intake.concernDomain || "Social-Communication / Autism Screen",
    has_screening_tool: Boolean(state.gatekeeper.hasScreeningTool),
    has_parent_consent: Boolean(state.gatekeeper.hasParentConsent),
    preferred_language: state.intake.needsBilingual ? "Spanish" : "English",
    needs_medicaid: Boolean(state.intake.needsMedicaid),
    has_household_vehicle: Boolean(state.intake.hasVehicle),
    home_tract_geoid: state.intake.tractGeoid || state.brief?.routing?.child_profile?.home_tract_geoid || "",
  };

  if (btn) btn.disabled = true;
  try {
    const res = await fetchJson("/api/gatekeeper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    renderGatekeeperResult(res);
  } catch {
    renderGatekeeperResult(computeGatekeeperFallback(payload));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// US Census TIGER Vector Maps (Tab 1 Corridor + Tab 3 Hidden Desert & BYOD)
// ---------------------------------------------------------------------------
function getProviderCoordsMap(geo) {
  const map = new Map();
  (Array.isArray(geo?.providers) ? geo.providers : []).forEach((p) => {
    if (p.provider_id && p.x !== undefined && p.y !== undefined) {
      map.set(String(p.provider_id), p);
    }
  });
  return map;
}

function buildHopPolylinePoints(rawHops, provMap) {
  const hops = (Array.isArray(rawHops) ? rawHops : []).map(normalizeHop).filter(Boolean);
  if (hops.length === 0) return [];
  const ids = [hops[0].sourceId, ...hops.map((h) => h.targetId)].filter(Boolean);
  const pts = [];
  ids.forEach((id) => {
    const p = provMap.get(String(id));
    if (p) pts.push({ id, x: Number(p.x), y: Number(p.y), org: p.organization_name || p.name || id });
  });
  return pts;
}

function renderTigerCorridorMap(geo, brief) {
  const container = $("tigerCorridorMap");
  const inspector = $("corridorMapInspector");
  if (!container) return;

  const tracts = Array.isArray(geo?.tracts) ? geo.tracts : [];
  if (tracts.length === 0) {
    container.innerHTML = `
      <svg class="tiger-map-svg" viewBox="0 0 1000 220" role="img" aria-label="Census TIGER corridor map placeholder">
        <rect x="0" y="0" width="1000" height="220" fill="#F8FAFC" />
        <text x="500" y="105" text-anchor="middle" fill="#334155" font-size="14" font-family="Noto Sans, sans-serif">
          US Census TIGER/Line vector polygons load from GET /api/geo?state=${escapeHtml(brief?.state_code || "MS")}
        </text>
        <text x="500" y="132" text-anchor="middle" fill="#475569" font-size="12" font-family="Noto Sans, sans-serif">
          Click any tract polygon once geometry loads to re-anchor the multi-hop 45-day corridor.
        </text>
      </svg>
    `;
    return;
  }

  const activeTract =
    state.intake.tractGeoid || brief?.routing?.child_profile?.home_tract_geoid || "";
  const vb = geo.viewbox || "0 0 1000 640";
  const provMap = getProviderCoordsMap(geo);
  const recPts = buildHopPolylinePoints(brief?.routing?.recommended_pathway?.hops, provMap);
  const bouncePts = buildHopPolylinePoints(brief?.routing?.cautionary_historical_bounce_chain?.hops, provMap);

  const tractPaths = tracts
    .map((t) => {
      const geoid = String(t.tract_geoid || "");
      const isActive = geoid === activeTract;
      const pov = Number(t.poverty_pct || 0);
      const fill = isActive ? "#CCFBF1" : pov >= 25 ? "#BAE6FD" : pov >= 15 ? "#CBD5E1" : "#E2E8F0";
      const stroke = isActive ? "#0F766E" : "#64748B";
      const sw = isActive ? "2.5" : "1";
      return `<path class="tiger-tract" data-tract-geoid="${escapeHtml(geoid)}" d="${escapeHtml(t.svg_path || t.path || "")}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"><title>Tract ${escapeHtml(geoid)} (${escapeHtml(t.county_name || "")}) · Under 5: ${escapeHtml(t.children_under_5_count ?? "--")} · Poverty: ${escapeHtml(t.poverty_pct ?? "--")}% · Zero-Veh: ${escapeHtml(t.zero_vehicle_pct ?? "--")}%</title></path>`;
    })
    .join("");

  const bounceLine =
    bouncePts.length >= 2
      ? `<polyline points="${bouncePts.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#B91C1C" stroke-width="2.5" stroke-dasharray="7 4" stroke-linecap="round" stroke-linejoin="round"><title>Historical >45d Bounce Corridor</title></polyline>`
      : "";

  const recLine =
    recPts.length >= 2
      ? `<polyline points="${recPts.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#15803D" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><title>Recommended <=45d Electronic Corridor</title></polyline>`
      : "";

  const providerDots = (Array.isArray(geo.providers) ? geo.providers : [])
    .map((p) => {
      const inRec = recPts.some((pt) => pt.id === p.provider_id);
      const inBounce = bouncePts.some((pt) => pt.id === p.provider_id);
      const fill = inRec ? "#15803D" : inBounce ? "#B91C1C" : "#334155";
      const r = inRec || inBounce ? 6 : 4;
      const orgTitle = cleanOrgTitle(p.organization_name || p.name || p.provider_id);
      const flatWait = p.median_internal_wait_days ?? p.wait_days ?? "--";
      return `<circle cx="${escapeHtml(p.x)}" cy="${escapeHtml(p.y)}" r="${r}" fill="${fill}" stroke="#FFFFFF" stroke-width="1.5"><title>${escapeHtml(p.provider_id)} — ${escapeHtml(orgTitle)} (${escapeHtml(shortRole(p.role))}) · Flat Wait: ${escapeHtml(flatWait)}d</title></circle>`;
    })
    .join("");

  container.innerHTML = `<svg class="tiger-map-svg" viewBox="${escapeHtml(vb)}" preserveAspectRatio="xMidYMid meet">${tractPaths}${bounceLine}${recLine}${providerDots}</svg>`;

  container.querySelectorAll(".tiger-tract[data-tract-geoid]").forEach((el) => {
    el.addEventListener("click", async () => {
      const geoid = el.dataset.tractGeoid;
      if (!geoid) return;
      state.intake.tractGeoid = geoid;
      const sel = $("intakeTractSelect");
      if (sel) sel.value = geoid;
      const tractObj = tracts.find((t) => String(t.tract_geoid) === geoid);
      if (inspector && tractObj) {
        inspector.innerHTML = `<strong>Selected Active Tract:</strong> <code>${escapeHtml(geoid)}</code> (${escapeHtml(tractObj.county_name || "--")}) · Under 5: <strong>${formatNumber(tractObj.children_under_5_count)}</strong> · Poverty: ${escapeHtml(tractObj.poverty_pct ?? "--")}% · Zero-Vehicle: ${escapeHtml(tractObj.zero_vehicle_pct ?? "--")}%`;
      }
      await loadBriefWithIntakeParams();
    });
  });

  if (inspector && activeTract) {
    const activeObj = tracts.find((t) => String(t.tract_geoid) === activeTract);
    if (activeObj) {
      inspector.innerHTML = `<strong>Active Child Tract:</strong> <code>${escapeHtml(activeTract)}</code> (${escapeHtml(activeObj.county_name || "--")}) · Under 5: <strong>${formatNumber(activeObj.children_under_5_count)}</strong> · Poverty: ${escapeHtml(activeObj.poverty_pct ?? "--")}% · Zero-Vehicle: ${escapeHtml(activeObj.zero_vehicle_pct ?? "--")}%`;
    }
  }
}

function renderTigerDesertMap(geo, brief) {
  const container = $("tigerDesertMap");
  const inspector = $("desertMapInspector");
  const routeBtn = $("routeSelectedTractBtn");
  if (!container) return;

  const tracts = Array.isArray(geo?.tracts) ? geo.tracts : [];
  if (tracts.length === 0) {
    container.innerHTML = `
      <svg class="tiger-map-svg" viewBox="0 0 1000 220" role="img" aria-label="Census TIGER desert map placeholder">
        <rect x="0" y="0" width="1000" height="220" fill="#F8FAFC" />
        <text x="500" y="105" text-anchor="middle" fill="#334155" font-size="14" font-family="Noto Sans, sans-serif">
          US Census TIGER tracts &amp; HRSA BYOD FQHC markers load from GET /api/geo?state=${escapeHtml(brief?.state_code || "MS")}
        </text>
        <text x="500" y="132" text-anchor="middle" fill="#475569" font-size="12" font-family="Noto Sans, sans-serif">
          Public-domain HRSA BYOD sites (17 U.S.C. § 105) overlay directly onto Hidden EI Deserts.
        </text>
      </svg>
    `;
    if (routeBtn) routeBtn.disabled = true;
    return;
  }

  const zones = Array.isArray(brief?.outreach_zones?.ranked_outreach_zones)
    ? brief.outreach_zones.ranked_outreach_zones
    : [];
  const zoneMap = new Map(zones.map((z) => [String(z.census_tract_geoid), z]));
  const vb = geo.viewbox || "0 0 1000 640";

  const tractPaths = tracts
    .map((t) => {
      const geoid = String(t.tract_geoid || "");
      const z = zoneMap.get(geoid);
      const isSelected = geoid === state.selectedDesertTract;
      const isDesert = Boolean(z?.is_hidden_ei_desert);
      const isPriority = Boolean(z && !isDesert);
      const fill = isDesert ? "#FEE2E2" : isPriority ? "#CCFBF1" : "#E2E8F0";
      const stroke = isSelected ? "#0369A1" : isDesert ? "#B91C1C" : isPriority ? "#0F766E" : "#94A3B8";
      const sw = isSelected ? "3" : isDesert || isPriority ? "1.8" : "1";
      return `<path class="tiger-tract" data-tract-geoid="${escapeHtml(geoid)}" d="${escapeHtml(t.svg_path || t.path || "")}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"><title>Tract ${escapeHtml(geoid)} (${escapeHtml(t.county_name || "")}) · ${isDesert ? "Hidden EI Desert" : isPriority ? "Outreach Priority" : "Standard Tract"} · Poverty: ${escapeHtml(t.poverty_pct ?? "--")}%</title></path>`;
    })
    .join("");

  const rawByodSites = Array.isArray(geo.byod_sites)
    ? geo.byod_sites
    : Array.isArray(geo.fqhc_sites)
    ? geo.fqhc_sites
    : [];
  const byodMarkers = rawByodSites
    .map((site) => {
      const x = Number(site.x || 0);
      const y = Number(site.y || 0);
      const pts = `${x},${y - 7} ${x + 7},${y} ${x},${y + 7} ${x - 7},${y}`;
      return `<polygon points="${pts}" fill="#0369A1" stroke="#FFFFFF" stroke-width="1.5"><title>HRSA BYOD FQHC: ${escapeHtml(site.site_name || site.name || "FQHC")} (${escapeHtml(site.city || "")})</title></polygon>`;
    })
    .join("");

  container.innerHTML = `<svg class="tiger-map-svg" viewBox="${escapeHtml(vb)}" preserveAspectRatio="xMidYMid meet">${tractPaths}${byodMarkers}</svg>`;

  container.querySelectorAll(".tiger-tract[data-tract-geoid]").forEach((el) => {
    el.addEventListener("click", () => {
      const geoid = el.dataset.tractGeoid;
      if (!geoid) return;
      state.selectedDesertTract = geoid;
      renderTigerDesertMap(geo, brief);
      const tObj = tracts.find((t) => String(t.tract_geoid) === geoid);
      const zObj = zoneMap.get(geoid);
      if (inspector) {
        const fqhcTxt = zObj?.byod_fqhc_site_name
          ? ` · Nearest HRSA FQHC: ${cleanOrgTitle(zObj.byod_fqhc_site_name)} (${zObj.byod_nearest_fqhc_km ?? "--"} km)`
          : "";
        const statusTxt = zObj?.is_hidden_ei_desert ? "Hidden EI Desert (0 <=45d paths)" : "Outreach Tract";
        inspector.innerHTML = `<strong>Tract <code>${escapeHtml(geoid)}</code></strong> (${escapeHtml(tObj?.county_name || zObj?.county_name || "--")}) · ${escapeHtml(statusTxt)} · Under 5: <strong>${formatNumber(tObj?.children_under_5_count ?? zObj?.children_under_5_count)}</strong> · Poverty: ${escapeHtml(tObj?.poverty_pct ?? zObj?.poverty_pct ?? "--")}%${escapeHtml(fqhcTxt)}`;
      }
      if (routeBtn) routeBtn.disabled = false;
    });
  });
}

function renderTigerMaps() {
  renderTigerCorridorMap(state.geo, state.brief);
  renderTigerDesertMap(state.geo, state.brief);
}

async function loadGeoForState(stateCode) {
  if (state.brief?.geo && String(state.brief.geo.state_code || "") === String(stateCode)) {
    state.geo = state.brief.geo;
    populateIntakeTractOptions(state.brief);
    renderTigerMaps();
    return state.geo;
  }
  try {
    const geo = await fetchJson(`/api/geo?state=${encodeURIComponent(stateCode)}`);
    state.geo = geo;
  } catch {
    state.geo = null;
  }
  populateIntakeTractOptions(state.brief);
  renderTigerMaps();
  return state.geo;
}

// ---------------------------------------------------------------------------
// 48h Slot Hold & Print/Markdown Export
// ---------------------------------------------------------------------------
async function reserveRecommendedSlot() {
  const btn = $("reserveSlotBtn");
  const statusBox = $("slotHoldStatus");
  const rec = state.brief?.routing?.recommended_pathway;
  if (!rec) return;

  const { coordinatorId, evalHubId, vendorId } = resolvePathwayIds(rec);
  const stateCode = state.brief?.state_code || $("stateSelect")?.value || "MS";
  const tract = state.intake.tractGeoid || state.brief?.routing?.child_profile?.home_tract_geoid || "DEFAULT";

  if (btn) btn.disabled = true;
  try {
    const res = await fetchJson("/api/slots/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state_code: stateCode,
        coordinator_id: coordinatorId,
        eval_hub_id: evalHubId,
        vendor_id: vendorId,
        case_reference: `${stateCode}-${tract}-${state.intake.ageMonths}m`,
        hold_hours: 48,
      }),
    });
    state.lastHold = res;
    if (res.capacity_snapshot) {
      updateCapacityChip(state.brief, res.capacity_snapshot);
    }
    if (statusBox) {
      statusBox.hidden = false;
      statusBox.innerHTML = `${ICONS.checkCircle} <strong>48-Hour Slot Hold Confirmed:</strong> Hold ID <code>${escapeHtml(res.hold_id || "HOLD-48H")}</code> · Expires <strong>${escapeHtml(res.expires_at || "in 48 hours")}</strong> · Status: <code>${escapeHtml(res.status || "RESERVED")}</code>`;
    }
    await loadBriefWithIntakeParams({ preserveHoldBanner: true });
  } catch (err) {
    if (statusBox) {
      statusBox.hidden = false;
      statusBox.innerHTML = `${ICONS.alertTriangle} <strong>Slot Hold Request Unavailable:</strong> ${escapeHtml(err.message)} (verify backend <code>POST /api/slots/reserve</code> is running).`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function exportBriefMarkdown() {
  const b = state.brief;
  if (!b) return;
  const profile = b.routing?.child_profile || {};
  const rec = b.routing?.recommended_pathway;
  const bounce = b.routing?.cautionary_historical_bounce_chain;
  const totals = b.network_audit?.network_totals || {};
  const lines = [
    `# First Milestones — 45-Day IDEA Part C Triage & Network Brief (${b.state_code || "MS"})`,
    "",
    `- **Tract:** ${profile.home_tract_geoid || "--"} (${profile.county_name || "--"})`,
    `- **Child Age:** ${profile.child_age_months ?? "--"} months`,
    `- **Concern Domain:** ${profile.concern_domain || "--"}`,
    `- **Medicaid / Bilingual / Vehicle:** ${profile.needs_medicaid ? "Medicaid" : "Non-Medicaid"} · ${profile.needs_bilingual ? "Bilingual" : "English"} · ${profile.has_household_vehicle ? "Has Vehicle" : "Zero-Vehicle (NEMT Recommended)"}`,
    `- **Network Audit:** ${totals.statutory_breaches_over_45d ?? "--"} / ${totals.total_complete_chains ?? "--"} chains >45d (${totals.overall_timely_45d_pct ?? "--"}% timely)`,
    "",
    "## Recommended <=45-Day Electronic Pathway",
  ];
  if (rec) {
    lines.push(`- **Timeline:** ${rec.expected_cumulative_days} calendar days (${rec.statutory_45d_headroom_days}d headroom under 45d deadline)`);
    (rec.hops || []).forEach((h, i) => {
      lines.push(`  - Hop ${i + 1}: \`${h.source_provider_id || h.source_id}\` -> \`${h.target_provider_id || h.target_id}\` (+${h.handoff_wait_days ?? h.edge_wait_days ?? 0}d, Day ${h.cumulative_wait_days ?? 0}, ${h.transmission_channel || "ehr_electronic_portal"})`);
    });
  } else {
    lines.push("- No compliant <=45-day pathway returned.");
  }
  if (bounce) {
    lines.push("", "## Cautionary Historical Bounce Chain (>45d)", `- **Chain:** ${bounce.case_chain_id} (${bounce.total_wait_days}d across ${bounce.total_hops} hops)`);
  }
  if (b.caregiver_notes?.english) {
    lines.push("", "## Caregiver Action Note (English)", b.caregiver_notes.english);
  }
  if (b.caregiver_notes?.spanish) {
    lines.push("", "## Caregiver Action Note (Español)", b.caregiver_notes.spanish);
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `first-milestones-brief-${String(b.state_code || "MS").toLowerCase()}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Master Brief Renderer & Data Loaders
// ---------------------------------------------------------------------------
function renderBrief(brief, { preserveHoldBanner = false } = {}) {
  if (!brief || typeof brief !== "object") return;
  state.brief = brief;
  if (brief.bq_telemetry) {
    state.bqTelemetry = brief.bq_telemetry;
  }

  renderRuntimeMeta(brief.runtime, brief.execution_engine || brief.routing?.execution_engine);
  renderHeaderAndKpis(brief);
  syncIntakeControlsFromBrief(brief);
  renderGuardrails(brief);
  renderCytoscapeGraph(brief);
  renderPathwaysAndClock(brief, { preserveHoldBanner });
  renderViablePaths(brief);
  renderCaregiverNote();
  renderAuditAndBottlenecks(brief);
  renderSimulationCard(brief.counterfactual_simulation);
  renderOutreachAndEquity(brief);
  renderTigerMaps();

  if (isGqlModalOpen()) {
    setGqlTab(state.activeGqlKey);
  }
}

async function loadHealth() {
  try {
    state.health = await fetchJson("/api/health");
    renderRuntimeMeta(state.health);
  } catch {
    const badge = $("runtimeBadge");
    if (badge) badge.textContent = "Backend Connecting";
  }
}

async function loadBriefForState(stateCode) {
  const reqId = ++state.briefRequestSeq;
  const subtitle = $("contextSubtitle");
  if (subtitle) subtitle.textContent = `Loading ${stateCode} multi-hop graph diagnostics...`;

  state.selectedDesertTract = null;
  state.lastHold = null;
  const data = await fetchJson(`/api/brief?state=${encodeURIComponent(stateCode)}`);
  if (reqId !== state.briefRequestSeq) return data;

  renderBrief(data);
  await loadGeoForState(data.state_code || stateCode);
  return data;
}

async function loadBriefWithIntakeParams({ preserveHoldBanner = false } = {}) {
  const reqId = ++state.briefRequestSeq;
  const stateCode = $("stateSelect")?.value || state.brief?.state_code || "MS";
  const params = new URLSearchParams({
    state: stateCode,
    tract_geoid: state.intake.tractGeoid || "",
    age_months: String(state.intake.ageMonths ?? 32),
    concern_domain: state.intake.concernDomain || "Social-Communication / Autism Screen",
    needs_medicaid: String(Boolean(state.intake.needsMedicaid)),
    needs_bilingual: String(Boolean(state.intake.needsBilingual)),
    has_vehicle: String(Boolean(state.intake.hasVehicle)),
    has_household_vehicle: String(Boolean(state.intake.hasVehicle)),
  });

  const btn = $("recomputeRouteBtn");
  if (btn) btn.disabled = true;
  try {
    const data = await fetchJson(`/api/brief?${params.toString()}`);
    if (reqId !== state.briefRequestSeq) return data;
    renderBrief(data, { preserveHoldBanner });
    return data;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Chat & Live SSE `/run` Streaming Client
// ---------------------------------------------------------------------------
function formatSubAgentBadge(subInfo) {
  if (!subInfo) return "";
  const rawName = typeof subInfo === "string" ? subInfo : subInfo.agent || "";
  const shortName =
    (typeof subInfo === "object" && subInfo.label) ||
    SUBAGENT_LABELS[rawName] ||
    rawName ||
    "SpecialistSub";
  const model = (typeof subInfo === "object" && subInfo.model) || "gemini-2.5-flash";
  return `<span class="subagent-pill">${ICONS.subagent} ${escapeHtml(shortName)} &middot; ${escapeHtml(model)}</span>`;
}

function renderTraceRowHtml(subAgents = [], tools = []) {
  const subHtml = subAgents.map(formatSubAgentBadge).join("");
  const toolHtml = tools
    .map((t) => `<span class="tool-pill">${ICONS.bolt} ${escapeHtml(t)}</span>`)
    .join("");
  if (!subHtml && !toolHtml) return "";
  return `<div class="tool-trace-row">${subHtml}${toolHtml}</div>`;
}

function appendMessage(role, text, tools = [], subAgents = []) {
  const chatMessages = $("chatMessages");
  if (!chatMessages) return null;

  const div = document.createElement("div");
  div.className = `msg msg-${role}`;

  if (role === "agent") {
    const traceHtml = renderTraceRowHtml(subAgents, Array.isArray(tools) ? tools : []);
    div.innerHTML = `${traceHtml}<div class="msg-agent-body">${renderMarkdownLite(text)}</div>`;
  } else {
    div.textContent = text;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function createStreamingAgentBubble() {
  const chatMessages = $("chatMessages");
  if (!chatMessages) return null;

  const div = document.createElement("div");
  div.className = "msg msg-agent";
  div.innerHTML = `<div class="tool-trace-row" hidden></div><div class="msg-agent-body"><p>Tracing BigQuery Property Graph...</p></div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function buildPresetPrompt(presetKey, stateCode) {
  const tract =
    state.brief?.routing?.child_profile?.home_tract_geoid ||
    (stateCode === "CA" ? "06047000801" : stateCode === "AL" ? "01073000100" : "28049003500");
  const hub =
    state.brief?.network_audit?.top_hidden_bounce_hub?.provider_id ||
    `SYN-PROV-${stateCode}-011`;

  const presets = {
    triage: `Route an incoming 32-month-old toddler in census tract ${tract} (${stateCode}) referred for Social-Communication / Autism Screen. Family speaks Spanish at home, uses Medicaid, and has no household vehicle. Ensure we clear the 45-day IDEA Part C clock and provide an English and Spanish caregiver action note.`,
    audit: `Trace the 3-to-4-hop referral chains in ${stateCode} that breached the 45-day IDEA Part C limit, explain why ${hub} looks healthy in a flat waitlist sort yet drives multi-hop breaches, and simulate upgrading ${hub} from paper fax to electronic e-referral with bilingual slot pre-checks.`,
    outreach: `For this community developmental screening season in ${stateCode}, which high-poverty, zero-vehicle under-5 census tracts should mobile screening days visit first so every screened toddler has a verified <=45-day bilingual downstream evaluation pathway?`,
  };
  return presets[presetKey] || "";
}

function setSendBtnBusy(sendBtn, busy) {
  if (!sendBtn) return;
  sendBtn.disabled = busy;
  const lbl = sendBtn.querySelector("span");
  if (lbl) {
    lbl.textContent = busy ? "Tracing..." : "Run Triage";
  } else {
    sendBtn.textContent = busy ? "Tracing..." : "Run Triage";
  }
}

async function streamRunSse(payload, bubble) {
  const sseUrl = window.A4I_SSE_RUN_URL || "/run?compat=/api/chat/stream";
  const resp = await fetch(sseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
  });

  const contentType = resp.headers.get("content-type") || "";
  if (!resp.ok || !contentType.includes("text/event-stream") || !resp.body?.getReader) {
    throw new Error(`SSE unavailable (${resp.status})`);
  }

  const traceEl = bubble?.querySelector(".tool-trace-row");
  const bodyEl = bubble?.querySelector(".msg-agent-body");
  const chatMessages = $("chatMessages");

  const subAgents = [];
  const subSeen = new Set();
  const tools = [];
  const toolSeen = new Set();
  let accumulatedReply = "";
  let donePayload = null;

  const refreshTrace = () => {
    if (!traceEl) return;
    const subHtml = subAgents.map(formatSubAgentBadge).join("");
    const toolHtml = tools
      .map((t) => `<span class="tool-pill">${ICONS.bolt} ${escapeHtml(t)}</span>`)
      .join("");
    if (subHtml || toolHtml) {
      traceEl.hidden = false;
      traceEl.innerHTML = `${subHtml}${toolHtml}`;
    }
  };

  const handleFrame = (rawFrame) => {
    const lines = rawFrame.split("\n");
    let eventName = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) return;

    let parsed;
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }

    if (eventName === "agent_start") {
      if (parsed.session_id) state.sessionId = parsed.session_id;
    } else if (eventName === "sub_agent") {
      const key = parsed.agent || parsed.label || "";
      if (key && !subSeen.has(key)) {
        subSeen.add(key);
        subAgents.push(parsed);
        refreshTrace();
      }
    } else if (eventName === "tool_call") {
      if (parsed.tool && !toolSeen.has(parsed.tool)) {
        toolSeen.add(parsed.tool);
        tools.push(parsed.tool);
        refreshTrace();
      }
    } else if (eventName === "token") {
      if (typeof parsed.delta === "string" && parsed.delta.length > 0) {
        accumulatedReply += parsed.delta;
        if (bodyEl) {
          bodyEl.innerHTML = renderMarkdownLite(accumulatedReply);
        }
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    } else if (eventName === "brief") {
      if (parsed.brief) {
        renderBrief(parsed.brief);
      }
    } else if (eventName === "done") {
      donePayload = parsed;
      if (parsed.session_id) state.sessionId = parsed.session_id;
      if (parsed.bq_telemetry) {
        state.bqTelemetry = parsed.bq_telemetry;
        renderRuntimeMeta(state.brief?.runtime, state.brief?.execution_engine);
      }
      if (Array.isArray(parsed.tools_invoked)) {
        parsed.tools_invoked.forEach((t) => {
          if (t && !toolSeen.has(t)) {
            toolSeen.add(t);
            tools.push(t);
          }
        });
        refreshTrace();
      }
      const finalText = accumulatedReply || parsed.reply || "";
      if (bodyEl && finalText) {
        bodyEl.innerHTML = renderMarkdownLite(finalText);
      }
      if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  };

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundaryIdx = buffer.indexOf("\n\n");
    while (boundaryIdx !== -1) {
      const frame = buffer.slice(0, boundaryIdx);
      buffer = buffer.slice(boundaryIdx + 2);
      if (frame.trim()) handleFrame(frame);
      boundaryIdx = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode().replace(/\r\n/g, "\n");
  if (buffer.trim()) {
    buffer.split("\n\n").forEach((frame) => {
      if (frame.trim()) handleFrame(frame);
    });
  }

  return donePayload;
}

async function syncStateAfterChat(returnedState) {
  const stateSelect = $("stateSelect");
  if (!returnedState || !stateSelect) return;
  const normalized = String(returnedState).toUpperCase();
  const hasOption = [...stateSelect.options].some((o) => o.value === normalized);
  if (hasOption && stateSelect.value !== normalized) {
    stateSelect.value = normalized;
    await loadGeoForState(normalized);
  } else if (state.geo && String(state.geo.state_code || "").toUpperCase() !== normalized) {
    await loadGeoForState(normalized);
  }
}

async function sendChatMessage(messageText, targetTabOnDone = null) {
  const stateSelect = $("stateSelect");
  const sendBtn = $("sendBtn");
  const stateCode = stateSelect ? stateSelect.value : "MS";
  const payload = {
    message: messageText,
    session_id: state.sessionId,
    state_code: stateCode,
  };

  appendMessage("user", messageText);
  setSendBtnBusy(sendBtn, true);

  const streamingBubble = createStreamingAgentBubble();
  let donePayload = null;
  let chatData = null;

  try {
    try {
      donePayload = await streamRunSse(payload, streamingBubble);
    } catch {
      // Automatic fallback to JSON POST /api/chat if SSE stream is unsupported
      chatData = await fetchJson("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      state.sessionId = chatData.session_id || state.sessionId;
      if (chatData.bq_telemetry) {
        state.bqTelemetry = chatData.bq_telemetry;
      }
      if (chatData.brief) {
        renderBrief(chatData.brief);
      } else {
        renderRuntimeMeta(state.brief?.runtime, state.brief?.execution_engine);
      }
      if (streamingBubble) {
        streamingBubble.remove();
      }
      appendMessage("agent", chatData.reply || "", chatData.tools_invoked || []);
    }

    const returnedState =
      donePayload?.state_code || chatData?.state_code || state.brief?.state_code;
    await syncStateAfterChat(returnedState);

    const resolvedTab =
      targetTabOnDone || donePayload?.recommended_tab || chatData?.recommended_tab;
    if (resolvedTab) {
      switchTab(resolvedTab);
    }
  } catch (err) {
    if (streamingBubble) {
      streamingBubble.remove();
    }
    appendMessage("agent", `Error communicating with triage backend: ${err.message}`);
  } finally {
    setSendBtnBusy(sendBtn, false);
  }
}

// ---------------------------------------------------------------------------
// Event Wiring & Initialization
// ---------------------------------------------------------------------------
function bindEvents() {
  const stateSelect = $("stateSelect");
  if (stateSelect) {
    stateSelect.addEventListener("change", async () => {
      const st = stateSelect.value;
      try {
        await loadBriefForState(st);
        appendMessage(
          "agent",
          `Switched active dataset context to **${st}**. Loaded \`[Synthetic]\` CareNode organizations, multi-hop referral chains, and real US Census ACS under-5 tracts.`,
          ["generate_complete_45d_brief"]
        );
      } catch (err) {
        appendMessage("agent", `Unable to load brief for ${st}: ${err.message}`);
      }
    });
  }

  const chatForm = $("chatForm");
  const chatInput = $("chatInput");
  if (chatForm && chatInput) {
    chatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const txt = chatInput.value.trim();
      if (!txt) return;
      chatInput.value = "";
      await sendChatMessage(txt);
    });

    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        chatForm.requestSubmit();
      }
    });
  }

  document.querySelectorAll(".preset-btn[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const presetKey = btn.dataset.preset;
      const stateCode = $("stateSelect")?.value || "MS";
      const prompt = buildPresetPrompt(presetKey, stateCode);
      if (!prompt) return;

      document.querySelectorAll(".preset-btn[data-preset]").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      });

      sendChatMessage(prompt, PRESET_TARGET_TAB[presetKey] || null);
    });
  });

  // Counterfactual Intake Strip Controls
  const intakeTractSelect = $("intakeTractSelect");
  if (intakeTractSelect) {
    intakeTractSelect.addEventListener("change", () => {
      state.intake.tractGeoid = intakeTractSelect.value;
    });
  }

  const intakeConcernSelect = $("intakeConcernSelect");
  if (intakeConcernSelect) {
    intakeConcernSelect.addEventListener("change", () => {
      state.intake.concernDomain = intakeConcernSelect.value;
    });
  }

  const intakeAgeSlider = $("intakeAgeSlider");
  if (intakeAgeSlider) {
    intakeAgeSlider.addEventListener("input", () => {
      const age = Number(intakeAgeSlider.value);
      state.intake.ageMonths = age;
      updateIntakeAgeDisplay(age);
    });
  }

  const intakeToggleConfigs = [
    ["intakeMedicaidToggle", "needsMedicaid"],
    ["intakeBilingualToggle", "needsBilingual"],
    ["intakeVehicleToggle", "hasVehicle"],
  ];
  intakeToggleConfigs.forEach(([id, key]) => {
    const btn = $(id);
    if (btn) {
      btn.addEventListener("click", () => {
        state.intake[key] = !state.intake[key];
        setToggleChipState(id, state.intake[key]);
      });
    }
  });

  const recomputeRouteBtn = $("recomputeRouteBtn");
  if (recomputeRouteBtn) {
    recomputeRouteBtn.addEventListener("click", async () => {
      try {
        await loadBriefWithIntakeParams();
      } catch (err) {
        appendMessage("agent", `Unable to re-compute 45d route: ${err.message}`);
      }
    });
  }

  // Hop-0 Packet Readiness Gatekeeper Controls
  const gkScreenToggle = $("gkScreenToggle");
  if (gkScreenToggle) {
    gkScreenToggle.addEventListener("click", () => {
      state.gatekeeper.hasScreeningTool = !state.gatekeeper.hasScreeningTool;
      setToggleChipState("gkScreenToggle", state.gatekeeper.hasScreeningTool);
    });
  }

  const gkConsentToggle = $("gkConsentToggle");
  if (gkConsentToggle) {
    gkConsentToggle.addEventListener("click", () => {
      state.gatekeeper.hasParentConsent = !state.gatekeeper.hasParentConsent;
      setToggleChipState("gkConsentToggle", state.gatekeeper.hasParentConsent);
    });
  }

  const verifyPacketBtn = $("verifyPacketBtn");
  if (verifyPacketBtn) {
    verifyPacketBtn.addEventListener("click", () => {
      verifyIntakePacket();
    });
  }

  // 48h Slot Hold Reservation Button
  const reserveSlotBtn = $("reserveSlotBtn");
  if (reserveSlotBtn) {
    reserveSlotBtn.addEventListener("click", () => {
      reserveRecommendedSlot();
    });
  }

  // Tab 3 "Route Toddler Here" from Desert Map
  const routeSelectedTractBtn = $("routeSelectedTractBtn");
  if (routeSelectedTractBtn) {
    routeSelectedTractBtn.addEventListener("click", async () => {
      if (!state.selectedDesertTract) return;
      state.intake.tractGeoid = state.selectedDesertTract;
      const sel = $("intakeTractSelect");
      if (sel) sel.value = state.selectedDesertTract;
      switchTab("pathway");
      try {
        await loadBriefWithIntakeParams();
      } catch (err) {
        appendMessage("agent", `Unable to route tract ${state.selectedDesertTract}: ${err.message}`);
      }
    });
  }

  // Tab 2 Quick Actions
  const routeHubInTab1Btn = $("routeHubInTab1Btn");
  if (routeHubInTab1Btn) {
    routeHubInTab1Btn.addEventListener("click", async () => {
      switchTab("pathway");
      try {
        await loadBriefWithIntakeParams();
      } catch {
        // Ignore if brief already active
      }
    });
  }

  const viewEquityInTab3Btn = $("viewEquityInTab3Btn");
  if (viewEquityInTab3Btn) {
    viewEquityInTab3Btn.addEventListener("click", () => {
      switchTab("outreach");
      const eqCard = $("beforeAfterEquityCard");
      if (eqCard) eqCard.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // Print / PDF & Markdown Export Buttons
  const printBriefBtn = $("printBriefBtn");
  if (printBriefBtn) {
    printBriefBtn.addEventListener("click", () => {
      window.print();
    });
  }

  const exportMdBtn = $("exportMdBtn");
  if (exportMdBtn) {
    exportMdBtn.addEventListener("click", () => {
      exportBriefMarkdown();
    });
  }

  const runSimBtn = $("runSimBtn");
  const simHubSelect = $("simHubSelect");
  if (runSimBtn && simHubSelect) {
    runSimBtn.addEventListener("click", async () => {
      const origLabel = runSimBtn.textContent;
      runSimBtn.disabled = true;
      runSimBtn.textContent = "Simulating...";
      try {
        const simData = await fetchJson("/api/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state_code: $("stateSelect")?.value || "MS",
            target_provider_id: simHubSelect.value,
            upgrade_fax_to_ehr: true,
            precheck_bilingual_and_slot_capacity: true,
          }),
        });
        renderSimulationCard(simData);
      } catch (err) {
        const box = $("simImpactBox");
        if (box) {
          box.innerHTML = `<div class="muted-small">Simulation failed: ${escapeHtml(err.message)}</div>`;
        }
      } finally {
        runSimBtn.disabled = false;
        runSimBtn.textContent = origLabel;
      }
    });
  }

  document.querySelectorAll(".lang-btn[data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lang = btn.dataset.lang === "spanish" ? "spanish" : "english";
      state.caregiverLang = lang;
      document.querySelectorAll(".lang-btn[data-lang]").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      });
      renderCaregiverNote();
    });
  });

  const copyNoteBtn = $("copyNoteBtn");
  if (copyNoteBtn) {
    copyNoteBtn.addEventListener("click", async () => {
      const txt = state.brief?.caregiver_notes?.[state.caregiverLang] || "";
      if (!txt) return;
      const origHtml = copyNoteBtn.innerHTML;
      try {
        await copyTextToClipboard(txt);
        copyNoteBtn.innerHTML = `${ICONS.checkCircle} Copied`;
        setTimeout(() => {
          copyNoteBtn.innerHTML = origHtml;
        }, 1500);
      } catch {
        copyNoteBtn.textContent = "Copy Failed";
        setTimeout(() => {
          copyNoteBtn.innerHTML = origHtml;
        }, 1500);
      }
    });
  }

  const toggleGqlBtn = $("toggleGqlBtn");
  if (toggleGqlBtn) {
    toggleGqlBtn.addEventListener("click", () => {
      if (isGqlModalOpen()) {
        closeGqlModal();
      } else {
        openGqlModal();
      }
    });
  }

  const closeGqlBtn = $("closeGqlBtn");
  if (closeGqlBtn) {
    closeGqlBtn.addEventListener("click", closeGqlModal);
  }

  const gqlModal = $("gqlModal");
  if (gqlModal) {
    gqlModal.addEventListener("click", (e) => {
      if (e.target === gqlModal) {
        closeGqlModal();
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isGqlModalOpen()) {
      e.preventDefault();
      closeGqlModal();
    }
  });

  document.querySelectorAll("[data-gql]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setGqlTab(btn.dataset.gql);
    });
  });

  const copyGqlBtn = $("copyGqlBtn");
  if (copyGqlBtn) {
    copyGqlBtn.addEventListener("click", async () => {
      const codeBlock = $("gqlCodeBlock");
      const txt = codeBlock?.textContent || "";
      if (!txt) return;
      const origHtml = copyGqlBtn.innerHTML;
      try {
        await copyTextToClipboard(txt);
        copyGqlBtn.innerHTML = `${ICONS.checkCircle} Copied SQL/GQL`;
        setTimeout(() => {
          copyGqlBtn.innerHTML = origHtml;
        }, 1500);
      } catch {
        copyGqlBtn.textContent = "Copy Failed";
        setTimeout(() => {
          copyGqlBtn.innerHTML = origHtml;
        }, 1500);
      }
    });
  }

  document.querySelectorAll(".cy-filter-btn[data-cy-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.cyFilter || "all";
      applyCytoscapeFilter(mode, { fit: true });
      const inspector = $("cyNodeInspector");
      const cy = window.__cyInstance;
      if (inspector && cy) {
        const visNodes = cy.nodes(":visible").length;
        const visEdges = cy.edges(":visible").length;
        const modeDesc =
          mode === "compliant"
            ? "<=45-Day Electronic Corridors"
            : mode === "bounce"
            ? ">45-Day Paper Fax Bounce Chains"
            : "All Multi-Hop Referral Paths";
        inspector.innerHTML =
          `<strong>Filter Active — ${escapeHtml(modeDesc)}:</strong> Showing ${visNodes} <code>CareNode</code> vertices &amp; ${visEdges} <code>REFERS_TO</code> edges. Click any node or edge to inspect details.`;
      }
    });
  });

  const cyFitBtn = $("cyFitBtn");
  if (cyFitBtn) {
    cyFitBtn.addEventListener("click", () => {
      const cy = window.__cyInstance;
      if (!cy) return;
      cy.resize();
      const vis = cy.elements(":visible");
      if (vis.length > 0) {
        cy.fit(vis, 28);
      }
    });
  }

  window.addEventListener("resize", () => {
    const cy = window.__cyInstance;
    if (cy && state.activeTab === "pathway") {
      cy.resize();
      const vis = cy.elements(":visible");
      if (vis.length > 0) {
        cy.fit(vis, 28);
      }
    }
  });
}

async function init() {
  initTabs();
  bindEvents();
  await loadHealth();

  const initialState = $("stateSelect")?.value || "MS";
  try {
    const brief = await loadBriefForState(initialState);
    const totals = brief.network_audit?.network_totals || {};
    const topHub = brief.network_audit?.top_hidden_bounce_hub;
    const routedDenom =
      topHub?.total_multihop_chains_touched ?? topHub?.routed_episodes ?? "--";

    appendMessage(
      "agent",
      `### Welcome to First Milestones (${brief.state_code})\n\n` +
        `Loaded **\`[Synthetic]\` CareNode providers** and **${totals.total_complete_chains ?? "--"} multi-hop referral chains** (` +
        `**${totals.statutory_breaches_over_45d ?? "--"}** breaching the 45-day IDEA Part C limit). ` +
        (topHub
          ? `Intake Hub **\`${topHub.provider_id}\`** shows only a **${topHub.flat_median_internal_wait_days}-day** internal wait in a flat table, yet drives **${topHub.breached_over_45d}/${routedDenom}** >45-day bounce chains via \`paper_fax\`.\n\n`
          : "\n\n") +
        `Select a **Quick Demo Scenario** above or enter a custom triage or bottleneck query.`,
      ["generate_complete_45d_brief", "mcp_get_regional_agency_performance"]
    );
  } catch (err) {
    appendMessage(
      "agent",
      `Unable to initialize workbench brief for ${initialState}: ${err.message}`
    );
  }
}

init();
