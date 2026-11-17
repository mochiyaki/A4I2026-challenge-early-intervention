import React, { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  BarChart3,
  Bot,
  Check,
  Code2,
  Copy,
  HeartHandshake,
  Network,
  Play,
  Send,
  Sparkles,
} from 'lucide-react';
import { cleanOrgName } from '../engine/graphTriageEngine';
import type { LiveAgentResponse } from '../services/agentClient';
import type {
  BounceHubSummary,
  CareNode,
  EquityAuditGroup,
  NschStratum,
  PartCAgency,
} from '../types';
import {
  REDUCED_MOTION_TRANSITION,
  SPRING_DEFAULT,
  triggerCausalHaptic,
} from '../utils/applePhysics';
import { FluidSegmentedControl } from './FluidControls';

interface BriefAndCaregiverTabsProps {
  caregiverNotes: { en: string; es: string };
  bounceDiagnostics: BounceHubSummary[];
  providers: CareNode[];
  agencies: PartCAgency[];
  equityAudit: EquityAuditGroup[];
  nschStrata: NschStratum[];
  isoGqlSnippet: string;
  agentPrompt: string;
  onAgentPromptChange: (val: string) => void;
  onRunLiveAgent: () => void;
  agentLoading: boolean;
  agentError: string | null;
  agentResponse: LiveAgentResponse | null;
  agentEndpoint: string;
  onOpenAgentModal: () => void;
}

type BriefTabId = 'caregiver' | 'bounce' | 'equity' | 'gql';

export const BriefAndCaregiverTabs: React.FC<BriefAndCaregiverTabsProps> = ({
  caregiverNotes,
  bounceDiagnostics,
  providers,
  agencies,
  equityAudit,
  nschStrata,
  isoGqlSnippet,
  agentPrompt,
  onAgentPromptChange,
  onRunLiveAgent,
  agentLoading,
  agentError,
  agentResponse,
  agentEndpoint,
  onOpenAgentModal,
}) => {
  const reducedMotion = useReducedMotion();
  const [activeTab, setActiveTab] = useState<BriefTabId>('caregiver');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (key: string, text: string) => {
    triggerCausalHaptic(8);
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const naiveTopWaitlist = [...providers]
    .sort((a, b) => b.active_waitlist_count - a.active_waitlist_count)
    .slice(0, 5);

  const topFixHub = [...bounceDiagnostics].sort(
    (a, b) => b.counterfactualSavedChildDays - a.counterfactualSavedChildDays
  )[0];

  const finalEn = agentResponse?.caregiverNoteEn || caregiverNotes.en;
  const finalEs = agentResponse?.caregiverNoteEs || caregiverNotes.es;

  const panelTransition = reducedMotion
    ? REDUCED_MOTION_TRANSITION
    : SPRING_DEFAULT;

  return (
    <section className="apple-card p-6 sm:p-7 space-y-6">
      {/* Direct, Specific Apple Segmented Navigation (SKILL.md §16) */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] pb-4 no-print">
        <div>
          <span className="apple-eyebrow text-[10.5px] font-bold text-[#86868B]">
            Coordinator Brief
          </span>
          <h3 className="apple-title text-[17px] font-semibold text-[#1D1D1F]">
            Actionable Output &amp; Network Audit
          </h3>
        </div>

        <div className="w-full sm:w-auto overflow-x-auto">
          <FluidSegmentedControl<BriefTabId>
            layoutId="brief-tabs-segment"
            size="md"
            options={[
              {
                value: 'caregiver',
                label: (
                  <>
                    <HeartHandshake className="w-3.5 h-3.5" />
                    <span>Caregiver Letter</span>
                  </>
                ),
              },
              {
                value: 'bounce',
                label: (
                  <>
                    <Network className="w-3.5 h-3.5" />
                    <span>Bounce Hubs</span>
                  </>
                ),
              },
              {
                value: 'equity',
                label: (
                  <>
                    <BarChart3 className="w-3.5 h-3.5" />
                    <span>Equity Audit</span>
                  </>
                ),
              },
              {
                value: 'gql',
                label: (
                  <>
                    <Code2 className="w-3.5 h-3.5" />
                    <span>ISO GQL &amp; Agent</span>
                  </>
                ),
              },
            ]}
            value={activeTab}
            onChange={setActiveTab}
          />
        </div>
      </div>

      <AnimatePresence mode="wait">
        {/* TAB 1: Caregiver Letter */}
        {activeTab === 'caregiver' && (
          <motion.div
            key="caregiver"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={panelTransition}
            className="space-y-4"
          >
            <div>
              <h4 className="apple-subhead text-[15px] font-semibold text-[#1D1D1F]">
                Plain-Language Family Action Note (English &amp; Español)
              </h4>
              <p className="text-xs text-[#515154] mt-0.5">
                Zero bureaucratic jargon · Confirms $0 Medicaid Part C coverage, bilingual
                evaluation, and each milestone before Day 45.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* English */}
              <div className="apple-well p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="apple-eyebrow text-[10.5px] font-bold text-[#0F766E]">
                    English Family Note
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy('en', finalEn)}
                    className="apple-pressable inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-white text-[#1D1D1F] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_0.5px_rgba(0,0,0,0.08)] cursor-pointer no-print"
                  >
                    {copiedKey === 'en' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy English
                      </>
                    )}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-[13px] text-[#1D1D1F] leading-relaxed bg-white rounded-[12px] p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                  {finalEn}
                </pre>
              </div>

              {/* Spanish */}
              <div className="apple-well p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="apple-eyebrow text-[10.5px] font-bold text-[#0F766E]">
                    Confirmación en Español
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy('es', finalEs)}
                    className="apple-pressable inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-white text-[#1D1D1F] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_0.5px_rgba(0,0,0,0.08)] cursor-pointer no-print"
                  >
                    {copiedKey === 'es' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        Copiado
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copiar Español
                      </>
                    )}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-[13px] text-[#1D1D1F] leading-relaxed bg-white rounded-[12px] p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                  {finalEs}
                </pre>
              </div>
            </div>
          </motion.div>
        )}

        {/* TAB 2: Regional Bounce Hub Diagnosis */}
        {activeTab === 'bounce' && (
          <motion.div
            key="bounce"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={panelTransition}
            className="space-y-5 tabular-nums"
          >
            {topFixHub && (
              <div className="rounded-[16px] bg-[#5856D6]/[0.08] shadow-[inset_0_0_0_1px_rgba(88,86,214,0.2)] p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1 max-w-3xl">
                  <div className="apple-eyebrow inline-flex items-center gap-1.5 text-[10.5px] font-bold text-[#5856D6]">
                    <Sparkles className="w-3.5 h-3.5" />
                    Highest-Impact Network Intervention
                  </div>
                  <h4 className="apple-subhead text-[15px] font-semibold text-[#1D1D1F]">
                    Upgrade{' '}
                    <code className="font-mono-code text-[#5856D6]">
                      {topFixHub.coordinator.provider_id}
                    </code>{' '}
                    ({cleanOrgName(topFixHub.coordinator.synthetic_organization_name)}) from{' '}
                    <code className="font-mono-code">paper_fax</code> to e-Portal + Bilingual Check
                  </h4>
                  <p className="text-xs text-[#515154]">
                    Flat SQL reports just{' '}
                    <strong className="text-[#1D1D1F]">
                      {topFixHub.coordinator.median_internal_wait_days}d internal wait
                    </strong>{' '}
                    (waitlist {topFixHub.coordinator.active_waitlist_count}), hiding{' '}
                    <strong className="text-[#1D1D1F]">{topFixHub.chainsOver45d}</strong> breached
                    episodes out of {topFixHub.routedEpisodes}.
                  </p>
                </div>

                <div className="bg-white rounded-[14px] px-4 py-3 flex items-center gap-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                  <div>
                    <div className="apple-eyebrow text-[9.5px] font-semibold text-[#86868B]">
                      Child-Days Saved
                    </div>
                    <div className="apple-display text-[22px] font-bold text-[#5856D6] mt-0.5">
                      +{topFixHub.counterfactualSavedChildDays}d
                    </div>
                  </div>
                  <div className="border-l border-black/[0.08] pl-4">
                    <div className="apple-eyebrow text-[9.5px] font-semibold text-[#86868B]">
                      Flipped &le;45d
                    </div>
                    <div className="apple-display text-[22px] font-bold text-[#0D9488] mt-0.5">
                      {topFixHub.counterfactualSavedChains} cases
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* Naive Flat Sort */}
              <div className="apple-well p-4 space-y-3">
                <div>
                  <span className="apple-eyebrow text-[10px] font-bold text-amber-800">
                    Why Flat SQL Fails
                  </span>
                  <h4 className="apple-subhead text-[14px] font-semibold text-[#1D1D1F] mt-0.5">
                    1) Naive Sort (<code className="font-mono-code">active_waitlist_count DESC</code>)
                  </h4>
                  <p className="text-xs text-[#515154]">
                    Flags saturated downstream Eval Hubs (symptoms at Hop 2 &amp; Hop 3).
                  </p>
                </div>
                <div className="bg-white rounded-[12px] overflow-x-auto shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                  <table className="w-full text-xs text-left">
                    <thead className="text-[#86868B] border-b border-black/[0.06]">
                      <tr>
                        <th className="py-2.5 px-3 font-semibold">Provider</th>
                        <th className="py-2.5 px-3 font-semibold">Role</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Waitlist</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Internal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/[0.05]">
                      {naiveTopWaitlist.map((p) => (
                        <tr key={p.provider_id}>
                          <td className="py-2 px-3 font-mono-code font-semibold text-[#1D1D1F]">
                            {p.provider_id}
                          </td>
                          <td className="py-2 px-3 text-[#515154]">
                            {p.node_role.replace(/_/g, ' ')}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-code font-bold text-amber-700">
                            {p.active_waitlist_count}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-code">
                            {p.median_internal_wait_days}d
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Multi-hop Coordinator Breach Ranking */}
              <div className="apple-well p-4 space-y-3">
                <div>
                  <span className="apple-eyebrow text-[10px] font-bold text-[#0F766E]">
                    Multi-Hop Graph Reality
                  </span>
                  <h4 className="apple-subhead text-[14px] font-semibold text-[#1D1D1F] mt-0.5">
                    2) Coordinators Ranked by &gt;45-Day Breaches
                  </h4>
                  <p className="text-xs text-[#515154]">
                    Exposes 5–6d internal-wait hubs whose fax links trigger 70d+ loops.
                  </p>
                </div>
                <div className="bg-white rounded-[12px] overflow-x-auto shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                  <table className="w-full text-xs text-left">
                    <thead className="text-[#86868B] border-b border-black/[0.06]">
                      <tr>
                        <th className="py-2.5 px-3 font-semibold">Coordinator</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Internal</th>
                        <th className="py-2.5 px-3 font-semibold text-right">3+ Hops</th>
                        <th className="py-2.5 px-3 font-semibold text-right">&gt;45d Breach</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Mean</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/[0.05]">
                      {bounceDiagnostics.map((b) => (
                        <tr key={b.coordinator.provider_id}>
                          <td className="py-2 px-3 font-mono-code font-semibold text-[#1D1D1F]">
                            {b.coordinator.provider_id}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-code text-[#0F766E] font-semibold">
                            {b.coordinator.median_internal_wait_days}d
                          </td>
                          <td className="py-2 px-3 text-right font-mono-code">
                            {b.chains3PlusHops}/{b.routedEpisodes}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-code font-bold text-rose-600">
                            {b.chainsOver45d}/{b.routedEpisodes} ({b.breachRatePct}%)
                          </td>
                          <td className="py-2 px-3 text-right font-mono-code font-semibold">
                            {b.meanEpisodeWaitDays}d
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {agencies.map((ag) => {
                const timelyPct = (
                  (ag.initial_ifsp_within_45_days_count /
                    Math.max(1, ag.evaluations_completed_count)) *
                  100
                ).toFixed(1);
                return (
                  <div key={ag.agency_id} className="apple-well p-3.5 text-xs space-y-1">
                    <div className="flex justify-between items-center">
                      <span className="font-mono-code font-semibold text-[#515154]">
                        {ag.agency_id}
                      </span>
                      <span className="font-mono-code font-bold text-[#0F766E]">
                        {timelyPct}% timely
                      </span>
                    </div>
                    <div className="font-semibold text-[#1D1D1F]">
                      {cleanOrgName(ag.synthetic_agency_name)}
                    </div>
                    <div className="text-[#86868B]">{ag.served_counties}</div>
                    <div className="text-[11px] text-[#515154] pt-1">
                      Capacity delays: <strong className="text-[#1D1D1F]">{ag.ifsp_delayed_capacity_count}</strong>{' '}
                      · Family delays: <strong className="text-[#1D1D1F]">{ag.ifsp_delayed_family_count}</strong>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {/* TAB 3: Post-Output Equity Audit */}
        {activeTab === 'equity' && (
          <motion.div
            key="equity"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={panelTransition}
            className="space-y-5 tabular-nums"
          >
            <div className="apple-well p-4 text-xs text-[#515154] leading-relaxed">
              <strong className="text-[#1D1D1F]">Fairness &amp; Grain Guardrail:</strong>{' '}
              Demographic <code className="font-mono-code">audit_*</code> shares are{' '}
              <strong className="text-[#1D1D1F]">never</strong> used in routing scores or prompts.
              They are joined <em>post-output</em> on{' '}
              <code className="font-mono-code">child_home_tract_geoid = census_tract_geoid</code> to
              audit neighborhood impact.
            </div>

            <div className="apple-well p-1.5 overflow-x-auto">
              <table className="w-full text-xs text-left bg-white rounded-[11px] overflow-hidden">
                <thead className="text-[#86868B] border-b border-black/[0.06]">
                  <tr>
                    <th className="py-2.5 px-3.5 font-semibold">Historical Outcome</th>
                    <th className="py-2.5 px-3.5 font-semibold text-right">Episodes</th>
                    <th className="py-2.5 px-3.5 font-semibold text-right">Tract Poverty</th>
                    <th className="py-2.5 px-3.5 font-semibold text-right">Zero-Vehicle</th>
                    <th className="py-2.5 px-3.5 font-semibold text-right">audit_black</th>
                    <th className="py-2.5 px-3.5 font-semibold text-right">audit_hispanic</th>
                    <th className="py-2.5 px-3.5 font-semibold text-right">audit_white</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05]">
                  {equityAudit.map((row) => (
                    <tr key={row.label}>
                      <td className="py-2.5 px-3.5 font-semibold text-[#1D1D1F]">
                        {row.label}
                      </td>
                      <td className="py-2.5 px-3.5 text-right font-mono-code font-bold">
                        {row.episodes}
                      </td>
                      <td className="py-2.5 px-3.5 text-right font-mono-code">
                        {row.avgPovertyPct.toFixed(1)}%
                      </td>
                      <td className="py-2.5 px-3.5 text-right font-mono-code">
                        {row.avgNoVehiclePct.toFixed(1)}%
                      </td>
                      <td className="py-2.5 px-3.5 text-right font-mono-code">
                        {row.auditBlackPct.toFixed(1)}%
                      </td>
                      <td className="py-2.5 px-3.5 text-right font-mono-code">
                        {row.auditHispanicPct.toFixed(1)}%
                      </td>
                      <td className="py-2.5 px-3.5 text-right font-mono-code">
                        {row.auditWhitePct.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3">
              <div>
                <h4 className="apple-subhead text-[14px] font-semibold text-[#1D1D1F]">
                  Statewide HRSA NSCH Developmental Screening Strata
                </h4>
                <p className="text-xs text-[#515154]">
                  Replaces the all-zero ACS <code className="font-mono-code">limited_english_rate</code>{' '}
                  column and remains isolated from tract joins (no 6× fan-out).
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {nschStrata.map((s) => {
                  const screenPct = (s.standardized_screening_rate_pct * 100).toFixed(1);
                  const followPct = (s.followup_requested_pct * 100).toFixed(1);
                  const isNonEng = s.primary_home_language.includes('Non-English');
                  return (
                    <div
                      key={s.survey_stratum_id}
                      className="apple-well p-3.5 text-xs space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono-code text-[11px] font-semibold text-[#515154]">
                          {s.survey_stratum_id}
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-white text-[10px] font-semibold text-[#1D1D1F]">
                          {s.household_income_fpl_band}
                        </span>
                      </div>
                      <div className="font-semibold text-[#1D1D1F]">
                        {s.primary_home_language}
                      </div>
                      <div className="w-full bg-black/[0.08] h-1.5 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${Math.min(100, Number(screenPct) * 1.8)}%` }}
                          className={`h-full rounded-full ${
                            isNonEng ? 'bg-[#5856D6]' : 'bg-[#0D9488]'
                          }`}
                        />
                      </div>
                      <div className="flex justify-between text-[11px] text-[#515154]">
                        <span>
                          Screened: <strong className="text-[#1D1D1F]">{screenPct}%</strong>
                        </span>
                        <span>
                          Follow-up: <strong className="text-[#1D1D1F]">{followPct}%</strong>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}

        {/* TAB 4: BigQuery ISO GQL & Live ADK Agent */}
        {activeTab === 'gql' && (
          <motion.div
            key="gql"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={panelTransition}
            className="space-y-5"
          >
            <div className="apple-well p-4 sm:p-5 space-y-3 no-print">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-[#0D9488]" />
                  <h4 className="apple-subhead text-[14px] font-semibold text-[#1D1D1F]">
                    Live ADK Triage Agent Console
                  </h4>
                  <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-white text-[#515154] font-mono-code">
                    {agentEndpoint || 'Starter Graph Engine Active'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onOpenAgentModal}
                  className="text-xs font-semibold text-[#0F766E] hover:underline cursor-pointer"
                >
                  Configure Endpoint
                </button>
              </div>

              <textarea
                rows={4}
                value={agentPrompt}
                onChange={(e) => onAgentPromptChange(e.target.value)}
                className="w-full rounded-[12px] bg-white p-3 text-xs font-mono-code text-[#1D1D1F] shadow-[inset_0_0_0_0.5px_rgba(15,23,42,0.12)] focus:outline-none focus:ring-2 focus:ring-[#0D9488]/40"
              />

              <div className="flex items-center justify-between gap-2">
                <p className="text-[11.5px] text-[#515154]">
                  Dispatches structured referral JSON + coordinator prompt to your Cloud Run / ADK
                  endpoint.
                </p>
                <button
                  type="button"
                  onClick={onRunLiveAgent}
                  disabled={agentLoading}
                  className="apple-pressable inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold bg-[#0D9488] text-white hover:bg-[#0F766E] disabled:opacity-50 cursor-pointer shadow-[0_2px_6px_rgba(13,148,136,0.25)]"
                >
                  {agentLoading ? (
                    <>
                      <Play className="w-3.5 h-3.5 animate-spin" />
                      Querying...
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      Send to ADK Agent
                    </>
                  )}
                </button>
              </div>

              {agentError && (
                <div className="p-3 rounded-[11px] bg-rose-500/12 text-xs text-rose-900">
                  {agentError}
                </div>
              )}

              {agentResponse && (
                <div className="p-4 rounded-[12px] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] space-y-1.5">
                  <div className="apple-eyebrow text-[10px] font-bold text-[#0F766E]">
                    Live ADK Response
                  </div>
                  <pre className="whitespace-pre-wrap font-sans text-xs text-[#1D1D1F] leading-relaxed">
                    {agentResponse.summaryMarkdown}
                  </pre>
                </div>
              )}
            </div>

            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="apple-subhead text-[14px] font-semibold text-[#1D1D1F]">
                    BigQuery Property Graph &amp; ISO/IEC 39075 GQL
                  </h4>
                  <p className="text-xs text-[#515154]">
                    Correlates <code className="font-mono-code">case_chain_id</code> for historical
                    audits and wraps <code className="font-mono-code">GRAPH_TABLE(...)</code> for
                    today&apos;s child.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy('gql', isoGqlSnippet)}
                  className="apple-pressable inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-[#1D1D1F] text-white cursor-pointer no-print"
                >
                  {copiedKey === 'gql' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied GQL
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy ISO GQL
                    </>
                  )}
                </button>
              </div>
              <pre className="apple-dark-surface text-slate-100 p-4 sm:p-5 text-xs font-mono-code overflow-x-auto leading-relaxed">
                {isoGqlSnippet}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};
