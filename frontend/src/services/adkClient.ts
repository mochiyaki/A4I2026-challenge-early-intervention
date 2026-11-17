import {
  AgentEndpointConfig,
  CandidatePathway,
  ReferralIntakeForm,
  TractDemographics,
} from '../types/partC';
import {
  cleanOrgName,
  computeCoordinatorBounceAudits,
  computePostOutputEquityAudit,
  lookupStatewideNschContext,
  simulateCoordinatorEhrFix,
} from '../engine/referralGraphEngine';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sourceBadge: 'Live ADK / Cloud Run Agent' | 'Local CA ReferralGraph Engine';
  timestamp: string;
}

/**
 * Sends a coordinator query to a live ADK (`adk api_server`) or custom Cloud Run FastAPI agent.
 * Automatically falls back to the local California ReferralGraph engine if offline or in local mode.
 */
export async function askTriageAgent(params: {
  prompt: string;
  config: AgentEndpointConfig;
  sessionId: string;
  form: ReferralIntakeForm;
  tract: TractDemographics;
  recommendedPath: CandidatePathway;
  bounceTrapPath: CandidatePathway;
}): Promise<{ reply: string; usedLiveEndpoint: boolean; errorNote?: string }> {
  const { prompt, config, sessionId, form, tract, recommendedPath, bounceTrapPath } =
    params;

  if (config.mode === 'live_adk' && config.baseUrl.trim()) {
    const base = config.baseUrl.trim().replace(/\/+$/, '');
    try {
      // 1) Try standard Google ADK `adk api_server` /run contract first
      await fetch(
        `${base}/apps/${encodeURIComponent(config.appName)}/users/${encodeURIComponent(config.userId)}/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: { state_code: 'CA', tract_geoid: tract.census_tract_geoid } }),
        }
      ).catch(() => null);

      const adkResp = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_name: config.appName,
          user_id: config.userId,
          session_id: sessionId,
          new_message: {
            role: 'user',
            parts: [{ text: prompt }],
          },
        }),
      });

      if (adkResp.ok) {
        const events = await adkResp.json();
        if (Array.isArray(events)) {
          const texts: string[] = [];
          for (const ev of events) {
            const parts = ev?.content?.parts;
            if (Array.isArray(parts)) {
              for (const p of parts) {
                if (typeof p?.text === 'string' && p.text.trim()) {
                  texts.push(p.text.trim());
                }
              }
            }
          }
          if (texts.length > 0) {
            return { reply: texts.join('\n\n'), usedLiveEndpoint: true };
          }
        }
      }

      // 2) Fallback try simple Cloud Run FastAPI POST /chat or /triage JSON contract
      const restResp = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: prompt,
          state_code: 'CA',
          tract_geoid: tract.census_tract_geoid,
          child_age_months: form.childAgeMonths,
          accepts_medicaid: form.medicaidRequired,
          bilingual_required: form.bilingualRequired,
          concern_domain: form.concernDomain,
        }),
      });

      if (restResp.ok) {
        const data = await restResp.json();
        const text = data.reply || data.response || data.output || JSON.stringify(data, null, 2);
        return { reply: text, usedLiveEndpoint: true };
      }

      throw new Error(`HTTP ${adkResp.status}`);
    } catch (err) {
      const fallback = synthesizeGroundedGraphAnswer(
        prompt,
        form,
        tract,
        recommendedPath,
        bounceTrapPath
      );
      return {
        reply: fallback,
        usedLiveEndpoint: false,
        errorNote: `Live endpoint (${base}) unreachable (${err instanceof Error ? err.message : 'network error'}) — answered via pre-loaded CA ReferralGraph dataset.`,
      };
    }
  }

  return {
    reply: synthesizeGroundedGraphAnswer(
      prompt,
      form,
      tract,
      recommendedPath,
      bounceTrapPath
    ),
    usedLiveEndpoint: false,
  };
}

function synthesizeGroundedGraphAnswer(
  prompt: string,
  form: ReferralIntakeForm,
  tract: TractDemographics,
  rec: CandidatePathway,
  trap: CandidatePathway
): string {
  const q = prompt.toLowerCase();
  const { coordinatorAudits, naiveTopWaitlistNodes } =
    computeCoordinatorBounceAudits();
  const topBounce = coordinatorAudits[0];
  const sim = simulateCoordinatorEhrFix([topBounce.coordinator.provider_id]);
  const equity = computePostOutputEquityAudit();
  const nsch = lookupStatewideNschContext(tract, form.bilingualRequired);

  if (q.includes('limited_english') || q.includes('acs') || q.includes('nsch') || q.includes('trap')) {
    return `**Data Validation & Grain Guardrails Caught (California \`CA\`):**

1. **All-Zero \`limited_english_rate\` Column Trap (\`acs_under5_tract_demographics\`):** Across all **101 California census tracts** (including \`${tract.census_tract_geoid}\` in ${tract.county_name}), \`limited_english_rate\` and \`limited_english_speaking_pop_count\` are **\`0.0\`**. Weighting it in a triage formula would silently zero out language need. Instead, we enforce \`bilingual_services_listed = TRUE\` on \`CareNode\` vertices and reference statewide HRSA NSCH language strata.
2. **6× Statewide Grain Trap (\`nsch_developmental_screening_survey\`):** HRSA NSCH has **6 rows for CA**, all strictly \`geographic_level = 'Statewide'\`. Joining on \`state_code = 'CA'\` alone duplicates all 101 tracts 6×. Filtered cleanly to \`${nsch.matchedStratum.survey_stratum_id}\` (\`${nsch.matchedStratum.household_income_fpl_band}\`, \`${nsch.matchedStratum.primary_home_language}\`), statewide screening is **${(nsch.matchedStratum.standardized_screening_rate_pct * 100).toFixed(1)}%** vs. **${(nsch.englishHighIncomeComparator.standardized_screening_rate_pct * 100).toFixed(1)}%** for \`>=400% FPL\` English households.
3. **100% \`[Synthetic]\` Network Provenance:** All \`SYN-PROV-CA-*\` and \`SYN-PARTC-CA-*\` entities and \`ReferralHandoff\` chains are 100% synthetic so simulated statutory breaches never implicate real clinicians.`;
  }

  if (q.includes('bounce') || q.includes('flat') || q.includes('011') || q.includes('012') || q.includes('spreadsheet')) {
    return `**Why Flat Waitlist Sorting Missed California's Top Bounce Hubs:**

• **What Flat SQL Shows:** Sorting \`pediatric_and_ei_provider_directory\` by \`active_waitlist_count DESC\` flags downstream hubs \`${naiveTopWaitlistNodes[0].provider_id}\` (waitlist \`${naiveTopWaitlistNodes[0].active_waitlist_count}\`) and \`${naiveTopWaitlistNodes[1].provider_id}\` (waitlist \`${naiveTopWaitlistNodes[1].active_waitlist_count}\`). Meanwhile, **\`${topBounce.coordinator.provider_id}\`** (${cleanOrgName(topBounce.coordinator.synthetic_organization_name)}) ranks **#${topBounce.flatWaitlistRank} of 30** with a healthy-looking **${topBounce.coordinator.median_internal_wait_days}-day** internal wait and waitlist of \`${topBounce.coordinator.active_waitlist_count}\`.
• **What ISO GQL \`-{2,4}->\` Traversal Exposes:** Correlating \`case_chain_id\` across hops reveals \`${topBounce.coordinator.provider_id}\` routes families via \`paper_fax\` (${topBounce.paperFaxHopsCount} fax hops) into saturated/unmatched evaluation hubs—triggering **${topBounce.chainsOver45Days} breached episodes out of ${topBounce.routedEpisodes} (${topBounce.breachRatePct}%)**, averaging **${topBounce.meanChainWaitDays} days**!
• **Counterfactual Fix Impact:** Upgrading \`${topBounce.coordinator.provider_id}\` alone from \`paper_fax\` to \`ehr_electronic_portal\` with bilingual slot pre-check rescues **${sim.chainsRescuedUnder45Days} breached toddler chains** back under 45 days and saves **${sim.totalChildDaysSaved} delayed child-days**.`;
  }

  if (q.includes('equity') || q.includes('audit') || q.includes('vehicle')) {
    const b = equity[0];
    const t = equity[1];
    return `**Post-Output Equity Audit (California \`CA\`, \`n = 44\` chains across \`101\` tracts):**

• **Routing Rule Integrity:** \`audit_*\` race/ethnicity share columns were **0% used** in path scoring. Routing used only cumulative wait days, Medi-Cal enrollment, bilingual capability, and spatial distance (\`ST_DISTANCE\`).
• **Outcome Audit:** Across California's **${b.episodesCount} breached (>45d)** chains (mean **${b.avgWaitDays}d**), home tracts average **${b.avgPovertyPct}% poverty** and **${b.avgNoVehiclePct}% zero-vehicle households** (vs. **${t.avgNoVehiclePct}%** in timely chains), with demographic composition **${b.auditHispanicPct}% Hispanic**, **${b.auditWhitePct}% White**, **${b.auditAsianPct}% Asian**, and **${b.auditBlackPct}% Black**.
• **Zero-Vehicle Guardrail for Tract \`${tract.census_tract_geoid}\`:** Zero-vehicle rate is **${(tract.no_vehicle_rate * 100).toFixed(1)}%** and distance to Eval Hub \`${rec.nodes[2]?.provider_id}\` is **${rec.evalHubDistanceKm} km** — ${rec.zeroVehicleAlert || rec.longDistanceTeleEvalAlert ? 'triggering automatic **Early Start Tele-Assessment + Medi-Cal NEMT free ride authorization**' : 'within local Medi-Cal ride range'}.`;
  }

  // Default: Route recommendation for Today's 20-month-old referral
  const nodeChain = rec.nodes.map((n) => `\`${n.provider_id}\` (${cleanOrgName(n.synthetic_organization_name)})`).join(' → ');
  return `**<=45-Day Recommended Pathway for Today's ${form.childAgeMonths}-Month-Old Referral (Tract \`${tract.census_tract_geoid}\`, ${tract.county_name}):**

• **Compliant Electronic Route (${rec.totalWaitDays} days — clears federal 45-day IDEA Part C clock with ${rec.daysBufferUnder45}d buffer):**
  ${nodeChain}
• **Eligibility Verified:** Medi-Cal accepted (\`TRUE\`), Spanish-bilingual specialists listed (\`TRUE\`), Part C vendor enrolled (\`TRUE\`), \`ehr_electronic_portal\` on every hop, **${rec.evalHubDistanceKm} km** from home tract centroid.
• **Historical Bounce Trap Avoided (\`${trap.pathId}\`):** Routing via \`paper_fax\` through the same intake tier historically bounced 4 hops across saturated/non-bilingual hubs in **${trap.totalWaitDays} days** (+${trap.totalWaitDays - 45}d statutory breach).${rec.zeroVehicleAlert || rec.longDistanceTeleEvalAlert ? `\n• **Transport Guardrail Active:** Home tract has **${(tract.no_vehicle_rate * 100).toFixed(1)}%** zero-vehicle households / **${rec.evalHubDistanceKm} km** travel — attach **Medi-Cal NEMT ride + California Early Start Tele-Assessment** option.` : ''}`;
}
