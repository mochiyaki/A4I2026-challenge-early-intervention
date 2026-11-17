import React, { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  BarChart3,
  Check,
  Code2,
  Copy,
  FileText,
  Network,
  Play,
  Send,
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
    triggerCausalHaptic(6);
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
    <section className="ts-card p-6 sm:p-8 space-y-6">
      {/* Header + Software Tab Bar (zero overshoot, 240ms) */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[rgba(29,37,48,0.1)] pb-5 no-print">
        <div>
          <h2 className="ts-h2 text-[20px]">
            Coordinator brief.{' '}
            <span className="ts-muted">Family letters and network audit.</span>
          </h2>
        </div>

        <div className="w-full sm:w-auto overflow-x-auto">
          <FluidSegmentedControl<BriefTabId>
            layoutId="brief-tabs-segment"
            ariaLabel="Coordinator brief sections"
            size="md"
            options={[
              {
                value: 'caregiver',
                label: (
                  <>
                    <FileText className="w-3.5 h-3.5" />
                    <span>Family notes</span>
                  </>
                ),
              },
              {
                value: 'bounce',
                label: (
                  <>
                    <Network className="w-3.5 h-3.5" />
                    <span>Bounce hubs</span>
                  </>
                ),
              },
              {
                value: 'equity',
                label: (
                  <>
                    <BarChart3 className="w-3.5 h-3.5" />
                    <span>Equity audit</span>
                  </>
                ),
              },
              {
                value: 'gql',
                label: (
                  <>
                    <Code2 className="w-3.5 h-3.5" />
                    <span>ISO GQL &amp; ADK</span>
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
        {/* TAB 1: Caregiver Letters — Clean 2-level panels (no box-in-box-in-box) */}
        {activeTab === 'caregiver' && (
          <motion.div
            key="caregiver"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={panelTransition}
            className="space-y-5"
          >
            <div className="ts-measure">
              <h3 className="ts-h3 text-[16px]">
                Plain-language caregiver confirmation
              </h3>
              <p className="text-[14px] text-[#556070] mt-1 leading-relaxed">
                Confirms $0 Medicaid Part C coverage, bilingual evaluation staffing, and each scheduled step before Day 45.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* English Note */}
              <div className="ts-panel p-5 space-y-3.5">
                <div className="flex items-center justify-between gap-2 pb-3 border-b border-[rgba(29,37,48,0.1)]">
                  <span className="text-[14px] font-medium text-[#1D2530]">
                    English family note
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy('en', finalEn)}
                    className="ts-btn ts-btn-secondary min-h-[34px] py-1 px-3 text-[12.5px] no-print"
                  >
                    {copiedKey === 'en' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-[#2C5877]" />
                        <span>Copied note</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-[#556070]" />
                        <span>Copy English note</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-[14px] text-[#1D2530] leading-relaxed m-0">
                  {finalEn}
                </pre>
              </div>

              {/* Spanish Note */}
              <div className="ts-panel p-5 space-y-3.5">
                <div className="flex items-center justify-between gap-2 pb-3 border-b border-[rgba(29,37,48,0.1)]">
                  <span className="text-[14px] font-medium text-[#1D2530]">
                    Nota familiar en español
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy('es', finalEs)}
                    className="ts-btn ts-btn-secondary min-h-[34px] py-1 px-3 text-[12.5px] no-print"
                  >
                    {copiedKey === 'es' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-[#2C5877]" />
                        <span>Nota copiada</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-[#556070]" />
                        <span>Copiar nota en español</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-[14px] text-[#1D2530] leading-relaxed m-0">
                  {finalEs}
                </pre>
              </div>
            </div>
          </motion.div>
        )}

        {/* TAB 2: Regional Bounce Hub Diagnosis — Zero violet, clean hairline tables */}
        {activeTab === 'bounce' && (
          <motion.div
            key="bounce"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={panelTransition}
            className="space-y-6 tabular-nums"
          >
            {topFixHub && (
              <div className="ts-panel p-5 sm:p-6 flex flex-wrap items-center justify-between gap-5">
                <div className="space-y-1.5 max-w-2xl">
                  <div className="ts-label text-[#2C5877]">
                    Priority network intervention
                  </div>
                  <h3 className="ts-h3 text-[17px]">
                    Move{' '}
                    <code className="font-mono-code text-[15px] text-[#2C5877]">
                      {topFixHub.coordinator.provider_id}
                    </code>{' '}
                    ({cleanOrgName(topFixHub.coordinator.synthetic_organization_name)}) from paper fax to e-Portal
                  </h3>
                  <p className="text-[14px] text-[#556070] leading-relaxed">
                    Flat SQL shows a{' '}
                    <strong className="font-medium text-[#1D2530]">
                      {topFixHub.coordinator.median_internal_wait_days}-day internal wait
                    </strong>{' '}
                    (waitlist {topFixHub.coordinator.active_waitlist_count}), while downstream fax bounces pushed{' '}
                    <strong className="font-medium text-[#1D2530]">{topFixHub.chainsOver45d}</strong>{' '}
                    of {topFixHub.routedEpisodes} episodes past Day 45.
                  </p>
                </div>

                <dl className="flex items-center gap-5 shrink-0 border-t sm:border-t-0 pt-3 sm:pt-0 border-[rgba(29,37,48,0.1)] w-full sm:w-auto">
                  <div>
                    <dt className="ts-label">Child-days saved</dt>
                    <dd className="font-mono-code text-[22px] font-medium text-[#2C5877] mt-0.5">
                      +{topFixHub.counterfactualSavedChildDays}d
                    </dd>
                  </div>
                  <div className="border-l border-[rgba(29,37,48,0.12)] pl-5">
                    <dt className="ts-label">Cases moved &le;45d</dt>
                    <dd className="font-mono-code text-[22px] font-medium text-[#1D2530] mt-0.5">
                      {topFixHub.counterfactualSavedChains}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {/* Naive Flat Sort */}
              <div className="space-y-3">
                <div>
                  <div className="ts-label">Flat SQL baseline</div>
                  <h4 className="ts-h3 text-[15.5px] mt-0.5">
                    Sorted by <code className="font-mono-code text-[13.5px]">active_waitlist_count DESC</code>
                  </h4>
                  <p className="text-[13.5px] text-[#556070] mt-0.5">
                    Flags busy downstream hubs instead of upstream re-referral loops.
                  </p>
                </div>
                <div className="rounded-[12px] border border-[rgba(29,37,48,0.12)] overflow-x-auto">
                  <table className="w-full text-[13px] text-left">
                    <thead className="bg-[#F8F7F4] text-[#556070] border-b border-[rgba(29,37,48,0.1)]">
                      <tr>
                        <th className="py-2.5 px-3.5 font-medium">Provider</th>
                        <th className="py-2.5 px-3.5 font-medium">Role</th>
                        <th className="py-2.5 px-3.5 font-medium text-right">Waitlist</th>
                        <th className="py-2.5 px-3.5 font-medium text-right">Internal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(29,37,48,0.08)]">
                      {naiveTopWaitlist.map((p) => (
                        <tr key={p.provider_id}>
                          <td className="py-2.5 px-3.5 font-mono-code font-medium text-[#1D2530]">
                            {p.provider_id}
                          </td>
                          <td className="py-2.5 px-3.5 text-[#556070]">
                            {p.node_role.replace(/_/g, ' ')}
                          </td>
                          <td className="py-2.5 px-3.5 text-right font-mono-code font-medium text-[#8F5B1E]">
                            {p.active_waitlist_count}
                          </td>
                          <td className="py-2.5 px-3.5 text-right font-mono-code text-[#1D2530]">
                            {p.median_internal_wait_days}d
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Multi-hop Coordinator Breach Ranking */}
              <div className="space-y-3">
                <div>
                  <div className="ts-label text-[#2C5877]">Multi-hop graph audit</div>
                  <h4 className="ts-h3 text-[15.5px] mt-0.5">
                    Coordinators ranked by &gt;45-day episode breaches
                  </h4>
                  <p className="text-[13.5px] text-[#556070] mt-0.5">
                    Surfaces 5–6d internal-wait hubs whose fax handoffs trigger 70d+ delays.
                  </p>
                </div>
                <div className="rounded-[12px] border border-[rgba(29,37,48,0.12)] overflow-x-auto">
                  <table className="w-full text-[13px] text-left">
                    <thead className="bg-[#F8F7F4] text-[#556070] border-b border-[rgba(29,37,48,0.1)]">
                      <tr>
                        <th className="py-2.5 px-3.5 font-medium">Coordinator</th>
                        <th className="py-2.5 px-3.5 font-medium text-right">Internal</th>
                        <th className="py-2.5 px-3.5 font-medium text-right">3+ hops</th>
                        <th className="py-2.5 px-3.5 font-medium text-right">&gt;45d breach</th>
                        <th className="py-2.5 px-3.5 font-medium text-right">Mean</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(29,37,48,0.08)]">
                      {bounceDiagnostics.map((b) => (
                        <tr key={b.coordinator.provider_id}>
                          <td className="py-2.5 px-3.5 font-mono-code font-medium text-[#1D2530]">
                            {b.coordinator.provider_id}
                          </td>
                          <td className="py-2.5 px-3.5 text-right font-mono-code text-[#2C5877] font-medium">
                            {b.coordinator.median_internal_wait_days}d
                          </td>
                          <td className="py-2.5 px-3.5 text-right font-mono-code text-[#556070]">
                            {b.chains3PlusHops}/{b.routedEpisodes}
                          </td>
                          <td className="py-2.5 px-3.5 text-right font-mono-code font-medium text-[#B43E2F]">
                            {b.chainsOver45d}/{b.routedEpisodes} ({b.breachRatePct}%)
                          </td>
                          <td className="py-2.5 px-3.5 text-right font-mono-code font-medium text-[#1D2530]">
                            {b.meanEpisodeWaitDays}d
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
              {agencies.map((ag) => {
                const timelyPct = (
                  (ag.initial_ifsp_within_45_days_count /
                    Math.max(1, ag.evaluations_completed_count)) *
                  100
                ).toFixed(1);
                return (
                  <div key={ag.agency_id} className="ts-panel p-4 text-[13px] space-y-1.5">
                    <div className="flex justify-between items-center">
                      <span className="font-mono-code text-[12px] text-[#556070]">
                        {ag.agency_id}
                      </span>
                      <span className="font-mono-code font-medium text-[#2C5877]">
                        {timelyPct}% timely
                      </span>
                    </div>
                    <div className="font-medium text-[14.5px] text-[#1D2530]">
                      {cleanOrgName(ag.synthetic_agency_name)}
                    </div>
                    <div className="text-[#556070]">{ag.served_counties}</div>
                    <div className="text-[12.5px] text-[#556070] pt-1.5 border-t border-[rgba(29,37,48,0.08)]">
                      Capacity delays: <strong className="font-medium text-[#1D2530]">{ag.ifsp_delayed_capacity_count}</strong>{' '}
                      · Family delays: <strong className="font-medium text-[#1D2530]">{ag.ifsp_delayed_family_count}</strong>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {/* TAB 3: Post-Output Equity Audit — Zero violet, clean 2-level layout */}
        {activeTab === 'equity' && (
          <motion.div
            key="equity"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={panelTransition}
            className="space-y-6 tabular-nums"
          >
            <div className="ts-panel p-4 text-[13.5px] text-[#27303D] leading-relaxed">
              <strong className="font-medium text-[#1D2530]">Post-output fairness guardrail:</strong>{' '}
              Demographic <code className="font-mono-code text-[12.5px]">audit_*</code> columns carry zero weight in route ranking or agent prompts. They join strictly after path selection on{' '}
              <code className="font-mono-code text-[12.5px]">child_home_tract_geoid = census_tract_geoid</code>.
            </div>

            <div className="rounded-[12px] border border-[rgba(29,37,48,0.12)] overflow-x-auto">
              <table className="w-full text-[13px] text-left">
                <thead className="bg-[#F8F7F4] text-[#556070] border-b border-[rgba(29,37,48,0.1)]">
                  <tr>
                    <th className="py-3 px-4 font-medium">Historical outcome</th>
                    <th className="py-3 px-4 font-medium text-right">Episodes</th>
                    <th className="py-3 px-4 font-medium text-right">Tract poverty</th>
                    <th className="py-3 px-4 font-medium text-right">Zero vehicle</th>
                    <th className="py-3 px-4 font-medium text-right">audit_black</th>
                    <th className="py-3 px-4 font-medium text-right">audit_hispanic</th>
                    <th className="py-3 px-4 font-medium text-right">audit_white</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(29,37,48,0.08)]">
                  {equityAudit.map((row) => (
                    <tr key={row.label}>
                      <td className="py-3 px-4 font-medium text-[#1D2530]">
                        {row.label}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-code font-medium text-[#1D2530]">
                        {row.episodes}
                      </td>
                      <td className="py-3 px-4 text-right font-mono-code text-[#27303D]">
                        {row.avgPovertyPct.toFixed(1)}%
                      </td>
                      <td className="py-3 px-4 text-right font-mono-code text-[#27303D]">
                        {row.avgNoVehiclePct.toFixed(1)}%
                      </td>
                      <td className="py-3 px-4 text-right font-mono-code text-[#556070]">
                        {row.auditBlackPct.toFixed(1)}%
                      </td>
                      <td className="py-3 px-4 text-right font-mono-code text-[#556070]">
                        {row.auditHispanicPct.toFixed(1)}%
                      </td>
                      <td className="py-3 px-4 text-right font-mono-code text-[#556070]">
                        {row.auditWhitePct.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3.5">
              <div>
                <h3 className="ts-h3 text-[16px]">
                  Statewide HRSA NSCH developmental screening strata
                </h3>
                <p className="text-[13.5px] text-[#556070] mt-0.5">
                  Replaces the all-zero ACS <code className="font-mono-code text-[12.5px]">limited_english_rate</code>{' '}
                  field without joining onto tract rows.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {nschStrata.map((s) => {
                  const screenPct = (s.standardized_screening_rate_pct * 100).toFixed(1);
                  const followPct = (s.followup_requested_pct * 100).toFixed(1);
                  const isNonEng = s.primary_home_language.includes('Non-English');
                  return (
                    <div
                      key={s.survey_stratum_id}
                      className="ts-panel p-4 text-[13px] space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono-code text-[12px] text-[#556070]">
                          {s.survey_stratum_id}
                        </span>
                        <span className="ts-chip bg-white">
                          {s.household_income_fpl_band}
                        </span>
                      </div>
                      <div className="font-medium text-[14px] text-[#1D2530]">
                        {s.primary_home_language}
                      </div>
                      <div className="w-full bg-[#E6E2D9] h-1.5 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${Math.min(100, Number(screenPct) * 1.8)}%` }}
                          className={`h-full rounded-full ${
                            isNonEng ? 'bg-[#2C5877]' : 'bg-[#1D2530]'
                          }`}
                        />
                      </div>
                      <div className="flex justify-between text-[12.5px] text-[#556070]">
                        <span>
                          Screened: <strong className="font-medium text-[#1D2530]">{screenPct}%</strong>
                        </span>
                        <span>
                          Follow-up: <strong className="font-medium text-[#1D2530]">{followPct}%</strong>
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
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={panelTransition}
            className="space-y-6"
          >
            <div className="ts-panel p-5 space-y-3.5 no-print">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <label
                    htmlFor="adk-coordinator-prompt"
                    className="ts-h3 text-[15.5px]"
                  >
                    ADK triage prompt
                  </label>
                  <span className="ts-chip bg-white font-mono-code text-[11.5px]">
                    {agentEndpoint || 'Local ReferralGraph engine'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onOpenAgentModal}
                  className="ts-link text-[13px]"
                >
                  Configure endpoint
                </button>
              </div>

              <textarea
                id="adk-coordinator-prompt"
                rows={4}
                value={agentPrompt}
                onChange={(e) => onAgentPromptChange(e.target.value)}
                className="ts-input font-mono-code text-[12.5px] leading-relaxed"
              />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-[#556070]">
                  Sends structured referral JSON and prompt to your Cloud Run or ADK service.
                </p>
                <button
                  type="button"
                  onClick={onRunLiveAgent}
                  disabled={agentLoading}
                  className="ts-btn ts-btn-primary"
                >
                  {agentLoading ? (
                    <>
                      <Play className="w-3.5 h-3.5 animate-spin" />
                      <span>Querying ADK...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      <span>Run ADK agent</span>
                    </>
                  )}
                </button>
              </div>

              {agentError && (
                <div className="p-3.5 rounded-[10px] bg-[rgba(180,62,47,0.08)] border border-[rgba(180,62,47,0.24)] text-[13px] text-[#B43E2F]">
                  {agentError}
                </div>
              )}

              {agentResponse && (
                <div className="p-4 rounded-[10px] bg-white border border-[rgba(29,37,48,0.12)] space-y-1.5">
                  <div className="ts-label text-[#2C5877]">
                    Live ADK response
                  </div>
                  <pre className="whitespace-pre-wrap font-sans text-[13.5px] text-[#1D2530] leading-relaxed m-0">
                    {agentResponse.summaryMarkdown}
                  </pre>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="ts-h3 text-[16px]">
                    BigQuery Property Graph &amp; ISO/IEC 39075 GQL
                  </h3>
                  <p className="text-[13.5px] text-[#556070] mt-0.5">
                    Correlates <code className="font-mono-code text-[12.5px]">case_chain_id</code> for historical loops and queries <code className="font-mono-code text-[12.5px]">GRAPH_TABLE(...)</code> for today&apos;s child.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy('gql', isoGqlSnippet)}
                  className="ts-btn ts-btn-secondary no-print"
                >
                  {copiedKey === 'gql' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-[#2C5877]" />
                      <span>Copied GQL</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-[#556070]" />
                      <span>Copy GQL query</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="ts-stage-dark p-5 text-[12.5px] font-mono-code overflow-x-auto leading-relaxed m-0">
                {isoGqlSnippet}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};
