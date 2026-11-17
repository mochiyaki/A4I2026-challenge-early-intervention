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
  ShieldCheck,
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
  EXIT_FAST_TRANSITION,
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
  const exitTransition = reducedMotion
    ? REDUCED_MOTION_TRANSITION
    : EXIT_FAST_TRANSITION;

  return (
    <section className="pm-card p-6 sm:p-7 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--pm-border)] pb-5 no-print">
        <div>
          <div className="pm-kicker">Step 4 · Action &amp; Audit</div>
          <h2 className="pm-h2 text-[20px] mt-0.5">
            Coordinator brief, caregiver letters &amp; graph audit
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
                    <FileText aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>Family notes</span>
                  </>
                ),
              },
              {
                value: 'bounce',
                label: (
                  <>
                    <Network aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>Bounce hubs</span>
                  </>
                ),
              },
              {
                value: 'equity',
                label: (
                  <>
                    <BarChart3 aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>Equity audit</span>
                  </>
                ),
              },
              {
                value: 'gql',
                label: (
                  <>
                    <Code2 aria-hidden="true" className="w-3.5 h-3.5" />
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
        {/* TAB 1: High-Legibility Atkinson Hyperlegible Bilingual Caregiver Letters */}
        {activeTab === 'caregiver' && (
          <motion.div
            key="caregiver"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3, transition: exitTransition }}
            transition={panelTransition}
            className="space-y-5"
          >
            <div className="pm-measure">
              <h3 className="pm-h3 text-[16px]">
                Plain-language bilingual caregiver confirmation
              </h3>
              <p className="text-[14px] text-[var(--pm-muted)] mt-1 leading-relaxed">
                Set in{' '}
                <strong className="font-bold text-[var(--pm-ink)]">
                  Atkinson Hyperlegible
                </strong>{' '}
                for low-vision clarity—confirming $0 Medicaid Part C coverage, bilingual evaluation staffing, and each scheduled step before Day 45.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="pm-panel p-5 space-y-3.5">
                <div className="flex items-center justify-between gap-2 pb-3 border-b border-[var(--pm-border)]">
                  <span className="pm-label">English family note</span>
                  <button
                    type="button"
                    onClick={() => handleCopy('en', finalEn)}
                    className="pm-btn pm-btn-secondary pm-btn-compact no-print"
                  >
                    {copiedKey === 'en' ? (
                      <>
                        <Check
                          aria-hidden="true"
                          className="w-3.5 h-3.5 text-[var(--pm-compliant)]"
                        />
                        <span>Copied note</span>
                      </>
                    ) : (
                      <>
                        <Copy
                          aria-hidden="true"
                          className="w-3.5 h-3.5 text-[var(--pm-muted)]"
                        />
                        <span>Copy English</span>
                      </>
                    )}
                  </button>
                </div>
                <pre
                  className="whitespace-pre-wrap text-[14.5px] text-[var(--pm-text)] leading-relaxed m-0"
                  style={{ fontFamily: 'var(--font-body)' }}
                >
                  {finalEn}
                </pre>
              </div>

              <div className="pm-panel p-5 space-y-3.5">
                <div className="flex items-center justify-between gap-2 pb-3 border-b border-[var(--pm-border)]">
                  <span className="pm-label">Nota familiar en español</span>
                  <button
                    type="button"
                    onClick={() => handleCopy('es', finalEs)}
                    className="pm-btn pm-btn-secondary pm-btn-compact no-print"
                  >
                    {copiedKey === 'es' ? (
                      <>
                        <Check
                          aria-hidden="true"
                          className="w-3.5 h-3.5 text-[var(--pm-compliant)]"
                        />
                        <span>Nota copiada</span>
                      </>
                    ) : (
                      <>
                        <Copy
                          aria-hidden="true"
                          className="w-3.5 h-3.5 text-[var(--pm-muted)]"
                        />
                        <span>Copiar español</span>
                      </>
                    )}
                  </button>
                </div>
                <pre
                  className="whitespace-pre-wrap text-[14.5px] text-[var(--pm-text)] leading-relaxed m-0"
                  style={{ fontFamily: 'var(--font-body)' }}
                >
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
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3, transition: exitTransition }}
            transition={panelTransition}
            className="space-y-6 tabular-nums"
          >
            {topFixHub && (
              <div className="pm-panel p-5 sm:p-6 flex flex-wrap items-center justify-between gap-5">
                <div className="space-y-1.5 max-w-2xl">
                  <div className="pm-badge pm-badge-accent">
                    <span>Priority Network Intervention</span>
                  </div>
                  <h3 className="pm-h3 text-[17px] pt-1">
                    Upgrade{' '}
                    <code className="font-mono-code text-[14.5px] text-[var(--pm-accent)]">
                      {topFixHub.coordinator.provider_id}
                    </code>{' '}
                    ({cleanOrgName(topFixHub.coordinator.synthetic_organization_name)}) from paper fax to e-Portal
                  </h3>
                  <p className="text-[14px] text-[var(--pm-muted)] leading-relaxed">
                    Flat SQL shows only a{' '}
                    <strong className="font-bold text-[var(--pm-ink)]">
                      {topFixHub.coordinator.median_internal_wait_days}-day internal wait
                    </strong>{' '}
                    (waitlist {topFixHub.coordinator.active_waitlist_count}), whereas downstream paper-fax bounces pushed{' '}
                    <strong className="font-bold text-[var(--pm-ink)]">
                      {topFixHub.chainsOver45d}
                    </strong>{' '}
                    of {topFixHub.routedEpisodes} episodes past Day 45.
                  </p>
                </div>

                <dl className="flex items-center gap-5 shrink-0 border-t sm:border-t-0 pt-3 sm:pt-0 border-[var(--pm-border)] w-full sm:w-auto">
                  <div>
                    <dt className="text-[12px] text-[var(--pm-muted)] font-medium">
                      Child-days saved
                    </dt>
                    <dd className="font-mono-code text-[22px] font-semibold text-[var(--pm-compliant)] mt-0.5">
                      +{topFixHub.counterfactualSavedChildDays}d
                    </dd>
                  </div>
                  <div className="border-l border-[var(--pm-border)] pl-5">
                    <dt className="text-[12px] text-[var(--pm-muted)] font-medium">
                      Cases moved &le;45d
                    </dt>
                    <dd className="font-mono-code text-[22px] font-semibold text-[var(--pm-ink)] mt-0.5">
                      {topFixHub.counterfactualSavedChains}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className="space-y-3">
                <div>
                  <div className="pm-kicker">Flat SQL Baseline</div>
                  <h4 className="pm-h3 text-[15.5px] mt-0.5">
                    Sorted by{' '}
                    <code className="font-mono-code text-[13px]">
                      active_waitlist_count DESC
                    </code>
                  </h4>
                  <p className="text-[13.5px] text-[var(--pm-muted)] mt-0.5">
                    Flags busy downstream hubs while missing upstream re-referral loops.
                  </p>
                </div>
                <div className="pm-table-wrap">
                  <table className="pm-table">
                    <thead>
                      <tr>
                        <th scope="col">Provider</th>
                        <th scope="col">Role</th>
                        <th scope="col" className="text-right">
                          Waitlist
                        </th>
                        <th scope="col" className="text-right">
                          Internal
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {naiveTopWaitlist.map((p) => (
                        <tr key={p.provider_id}>
                          <td className="font-mono-code font-semibold text-[var(--pm-ink)]">
                            {p.provider_id}
                          </td>
                          <td className="text-[var(--pm-muted)]">
                            {p.node_role.replace(/_/g, ' ')}
                          </td>
                          <td className="text-right font-mono-code font-semibold text-[var(--pm-warning)]">
                            {p.active_waitlist_count}
                          </td>
                          <td className="text-right font-mono-code text-[var(--pm-ink)]">
                            {p.median_internal_wait_days}d
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <div className="pm-kicker text-[var(--pm-accent)]">
                    Multi-Hop Graph Audit
                  </div>
                  <h4 className="pm-h3 text-[15.5px] mt-0.5">
                    Coordinators ranked by &gt;45-day episode breaches
                  </h4>
                  <p className="text-[13.5px] text-[var(--pm-muted)] mt-0.5">
                    Surfaces 5–6d internal-wait hubs whose fax handoffs trigger 70d+ delays.
                  </p>
                </div>
                <div className="pm-table-wrap">
                  <table className="pm-table">
                    <thead>
                      <tr>
                        <th scope="col">Coordinator</th>
                        <th scope="col" className="text-right">
                          Internal
                        </th>
                        <th scope="col" className="text-right">
                          3+ hops
                        </th>
                        <th scope="col" className="text-right">
                          &gt;45d breach
                        </th>
                        <th scope="col" className="text-right">
                          Mean
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {bounceDiagnostics.map((b) => (
                        <tr key={b.coordinator.provider_id}>
                          <td className="font-mono-code font-semibold text-[var(--pm-ink)]">
                            {b.coordinator.provider_id}
                          </td>
                          <td className="text-right font-mono-code text-[var(--pm-accent)] font-semibold">
                            {b.coordinator.median_internal_wait_days}d
                          </td>
                          <td className="text-right font-mono-code text-[var(--pm-muted)]">
                            {b.chains3PlusHops}/{b.routedEpisodes}
                          </td>
                          <td className="text-right font-mono-code font-semibold text-[var(--pm-danger)]">
                            {b.chainsOver45d}/{b.routedEpisodes} ({b.breachRatePct}%)
                          </td>
                          <td className="text-right font-mono-code font-semibold text-[var(--pm-ink)]">
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
                  <div key={ag.agency_id} className="pm-panel p-4 text-[13px] space-y-1.5">
                    <div className="flex justify-between items-center">
                      <span className="font-mono-code text-[12px] text-[var(--pm-muted)]">
                        {ag.agency_id}
                      </span>
                      <span className="pm-badge pm-badge-compliant font-mono-code">
                        {timelyPct}% timely
                      </span>
                    </div>
                    <div className="pm-h3 text-[14.5px]">
                      {cleanOrgName(ag.synthetic_agency_name)}
                    </div>
                    <div className="text-[var(--pm-muted)]">{ag.served_counties}</div>
                    <div className="text-[12.5px] text-[var(--pm-muted)] pt-1.5 border-t border-[var(--pm-border)]">
                      Capacity delays:{' '}
                      <strong className="font-bold text-[var(--pm-ink)]">
                        {ag.ifsp_delayed_capacity_count}
                      </strong>{' '}
                      · Family delays:{' '}
                      <strong className="font-bold text-[var(--pm-ink)]">
                        {ag.ifsp_delayed_family_count}
                      </strong>
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
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3, transition: exitTransition }}
            transition={panelTransition}
            className="space-y-6 tabular-nums"
          >
            <div className="p-4 rounded-[12px] bg-[var(--pm-compliant-soft)] border border-[var(--pm-compliant-border)] flex items-start gap-3 text-[13.5px] text-[var(--pm-ink)]">
              <ShieldCheck
                aria-hidden="true"
                className="w-4 h-4 text-[var(--pm-compliant)] shrink-0 mt-1"
              />
              <div className="leading-relaxed">
                <strong className="font-bold">Post-output fairness guardrail:</strong>{' '}
                Demographic <code className="font-mono-code text-[12px]">audit_*</code> columns carry zero weight in route ranking or agent prompts. They join strictly after path selection on{' '}
                <code className="font-mono-code text-[12px]">
                  child_home_tract_geoid = census_tract_geoid
                </code>
                .
              </div>
            </div>

            <div className="pm-table-wrap">
              <table className="pm-table">
                <thead>
                  <tr>
                    <th scope="col">Historical outcome</th>
                    <th scope="col" className="text-right">
                      Episodes
                    </th>
                    <th scope="col" className="text-right">
                      Tract poverty
                    </th>
                    <th scope="col" className="text-right">
                      Zero vehicle
                    </th>
                    <th scope="col" className="text-right">
                      audit_black
                    </th>
                    <th scope="col" className="text-right">
                      audit_hispanic
                    </th>
                    <th scope="col" className="text-right">
                      audit_white
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {equityAudit.map((row) => (
                    <tr key={row.label}>
                      <td className="font-semibold text-[var(--pm-ink)]">
                        {row.label}
                      </td>
                      <td className="text-right font-mono-code font-semibold text-[var(--pm-ink)]">
                        {row.episodes}
                      </td>
                      <td className="text-right font-mono-code">
                        {row.avgPovertyPct.toFixed(1)}%
                      </td>
                      <td className="text-right font-mono-code">
                        {row.avgNoVehiclePct.toFixed(1)}%
                      </td>
                      <td className="text-right font-mono-code text-[var(--pm-muted)]">
                        {row.auditBlackPct.toFixed(1)}%
                      </td>
                      <td className="text-right font-mono-code text-[var(--pm-muted)]">
                        {row.auditHispanicPct.toFixed(1)}%
                      </td>
                      <td className="text-right font-mono-code text-[var(--pm-muted)]">
                        {row.auditWhitePct.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3.5">
              <div>
                <h3 className="pm-h3 text-[16px]">
                  Statewide HRSA NSCH developmental screening strata
                </h3>
                <p className="text-[13.5px] text-[var(--pm-muted)] mt-0.5">
                  Replaces the all-zero ACS{' '}
                  <code className="font-mono-code text-[12px]">
                    limited_english_rate
                  </code>{' '}
                  field without joining onto census tract rows.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {nschStrata.map((s) => {
                  const screenNum = Number(
                    (s.standardized_screening_rate_pct * 100).toFixed(1)
                  );
                  const followPct = (s.followup_requested_pct * 100).toFixed(1);
                  const isNonEng = s.primary_home_language.includes('Non-English');
                  return (
                    <div
                      key={s.survey_stratum_id}
                      className="pm-panel p-4 text-[13px] space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono-code text-[12px] text-[var(--pm-muted)]">
                          {s.survey_stratum_id}
                        </span>
                        <span className="pm-badge bg-[var(--pm-card)]">
                          {s.household_income_fpl_band}
                        </span>
                      </div>
                      <div className="pm-label text-[14px]">
                        {s.primary_home_language}
                      </div>
                      <div
                        role="progressbar"
                        aria-label={`${s.primary_home_language} standardized screening rate`}
                        aria-valuenow={screenNum}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        className="w-full bg-[var(--pm-surface-hover)] h-2 rounded-full overflow-hidden"
                      >
                        <div
                          style={{ width: `${Math.min(100, screenNum * 1.8)}%` }}
                          className={`h-full rounded-full ${
                            isNonEng
                              ? 'bg-[var(--pm-cta-bg)]'
                              : 'bg-[var(--pm-compliant)]'
                          }`}
                        />
                      </div>
                      <div className="flex justify-between text-[12.5px] text-[var(--pm-muted)]">
                        <span>
                          Screened:{' '}
                          <strong className="font-bold text-[var(--pm-ink)]">
                            {screenNum.toFixed(1)}%
                          </strong>
                        </span>
                        <span>
                          Follow-up:{' '}
                          <strong className="font-bold text-[var(--pm-ink)]">
                            {followPct}%
                          </strong>
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
            exit={{ opacity: 0, y: -3, transition: exitTransition }}
            transition={panelTransition}
            className="space-y-6"
          >
            <div className="pm-panel p-5 space-y-3.5 no-print">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <label
                    htmlFor="adk-coordinator-prompt"
                    className="pm-h3 text-[15.5px]"
                  >
                    ADK triage prompt
                  </label>
                  <span className="pm-badge bg-[var(--pm-card)] font-mono-code text-[11.5px]">
                    {agentEndpoint || 'Local ReferralGraph engine'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onOpenAgentModal}
                  className="text-[13px] font-semibold text-[var(--pm-accent)] hover:underline cursor-pointer"
                >
                  Configure endpoint
                </button>
              </div>

              <textarea
                id="adk-coordinator-prompt"
                rows={4}
                value={agentPrompt}
                onChange={(e) => onAgentPromptChange(e.target.value)}
                className="pm-input font-mono-code text-[12.5px] leading-relaxed"
              />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-[var(--pm-muted)]">
                  Sends structured referral JSON and coordinator prompt to your Cloud Run or ADK service.
                </p>
                <button
                  type="button"
                  onClick={onRunLiveAgent}
                  disabled={agentLoading}
                  className="pm-btn pm-btn-primary"
                >
                  {agentLoading ? (
                    <>
                      <Play aria-hidden="true" className="w-3.5 h-3.5 animate-spin" />
                      <span>Querying ADK...</span>
                    </>
                  ) : (
                    <>
                      <Send aria-hidden="true" className="w-3.5 h-3.5" />
                      <span>Run ADK agent</span>
                    </>
                  )}
                </button>
              </div>

              {agentError && (
                <div
                  role="alert"
                  className="p-3.5 rounded-[10px] bg-[var(--pm-danger-soft)] border border-[var(--pm-danger-border)] text-[13px] text-[var(--pm-danger)]"
                >
                  {agentError}
                </div>
              )}

              {agentResponse && (
                <div className="p-4 rounded-[10px] bg-[var(--pm-card)] border border-[var(--pm-border)] space-y-1.5">
                  <div className="pm-kicker text-[var(--pm-accent)]">
                    Live ADK Response
                  </div>
                  <pre
                    className="whitespace-pre-wrap text-[14px] text-[var(--pm-text)] leading-relaxed m-0"
                    style={{ fontFamily: 'var(--font-body)' }}
                  >
                    {agentResponse.summaryMarkdown}
                  </pre>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="pm-h3 text-[16px]">
                    BigQuery Property Graph &amp; ISO/IEC 39075 GQL
                  </h3>
                  <p className="text-[13.5px] text-[var(--pm-muted)] mt-0.5">
                    Correlates <code className="font-mono-code text-[12px]">case_chain_id</code> for historical loops and queries <code className="font-mono-code text-[12px]">GRAPH_TABLE(...)</code> for today&apos;s child.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy('gql', isoGqlSnippet)}
                  className="pm-btn pm-btn-secondary pm-btn-compact no-print"
                >
                  {copiedKey === 'gql' ? (
                    <>
                      <Check
                        aria-hidden="true"
                        className="w-3.5 h-3.5 text-[var(--pm-compliant)]"
                      />
                      <span>Copied GQL</span>
                    </>
                  ) : (
                    <>
                      <Copy
                        aria-hidden="true"
                        className="w-3.5 h-3.5 text-[var(--pm-muted)]"
                      />
                      <span>Copy GQL query</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="pm-stage-dark p-5 text-[12.5px] font-mono-code overflow-x-auto leading-relaxed m-0">
                {isoGqlSnippet}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};
