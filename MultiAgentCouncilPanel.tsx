import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  BookOpenCheck,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Database,
  FileSearch,
  GitBranch,
  Layers,
  Play,
  RefreshCw,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type {
  EvidenceSourceKind,
  MultiAgentReport,
  SpecialistAgentId,
  VerificationStatus,
} from '../types';
import {
  EXIT_FAST_TRANSITION,
  REDUCED_MOTION_TRANSITION,
  SPRING_DEFAULT,
  triggerCausalHaptic,
} from '../utils/applePhysics';
import { FluidSegmentedControl } from './FluidControls';

interface MultiAgentCouncilPanelProps {
  report: MultiAgentReport;
  agentEndpoint: string;
  agentLoading: boolean;
  onRunLiveAgent: () => void;
}

type CouncilTabId = 'summary' | 'verification' | 'evidence' | 'trace';
type EvidenceFilterId = 'all' | EvidenceSourceKind;

function getAgentIcon(agentId: SpecialistAgentId) {
  switch (agentId) {
    case 'intake-researcher':
      return <FileSearch aria-hidden="true" className="w-4 h-4" />;
    case 'graph-router':
      return <GitBranch aria-hidden="true" className="w-4 h-4" />;
    case 'compliance-verifier':
      return <ShieldCheck aria-hidden="true" className="w-4 h-4" />;
    case 'evidence-librarian':
      return <Database aria-hidden="true" className="w-4 h-4" />;
    case 'lead-synthesizer':
      return <Sparkles aria-hidden="true" className="w-4 h-4" />;
  }
}

function renderStatusBadge(status: VerificationStatus) {
  if (status === 'verified') {
    return (
      <span className="pm-badge pm-badge-compliant">
        <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5" />
        <span>Verified</span>
      </span>
    );
  }
  if (status === 'advisory') {
    return (
      <span className="pm-badge pm-badge-warning">
        <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5" />
        <span>Advisory</span>
      </span>
    );
  }
  return (
    <span className="pm-badge pm-badge-danger">
      <ShieldAlert aria-hidden="true" className="w-3.5 h-3.5" />
      <span>Escalation</span>
    </span>
  );
}

function renderProvenanceBadge(
  label: 'Federal Law' | 'Real Public Data' | '100% [Synthetic]' | 'Post-Output Audit'
) {
  if (label === 'Federal Law') {
    return (
      <span className="pm-badge pm-badge-accent">
        <Scale aria-hidden="true" className="w-3 h-3" />
        <span>Federal Law</span>
      </span>
    );
  }
  if (label === 'Real Public Data') {
    return (
      <span className="pm-badge pm-badge-compliant">
        <Database aria-hidden="true" className="w-3 h-3" />
        <span>Real Public Data</span>
      </span>
    );
  }
  if (label === 'Post-Output Audit') {
    return (
      <span className="pm-badge pm-badge-warning">
        <ShieldCheck aria-hidden="true" className="w-3 h-3" />
        <span>Post-Output Audit</span>
      </span>
    );
  }
  return (
    <span className="pm-badge">
      <Layers aria-hidden="true" className="w-3 h-3" />
      <span>100% [Synthetic]</span>
    </span>
  );
}

export const MultiAgentCouncilPanel: React.FC<MultiAgentCouncilPanelProps> = ({
  report,
  agentEndpoint,
  agentLoading,
  onRunLiveAgent,
}) => {
  const reducedMotion = useReducedMotion();
  const [activeTab, setActiveTab] = useState<CouncilTabId>('summary');
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilterId>('all');
  const [focusedAgentId, setFocusedAgentId] = useState<SpecialistAgentId | null>(
    null
  );
  const [runningStepIdx, setRunningStepIdx] = useState<number | null>(null);
  const [copiedDossier, setCopiedDossier] = useState(false);

  /* Sequential 5-agent audit animation when user clicks "Re-run 5-agent audit" */
  useEffect(() => {
    if (runningStepIdx === null) return;
    if (runningStepIdx >= report.agentTraces.length) {
      const doneTimer = window.setTimeout(() => setRunningStepIdx(null), 180);
      return () => window.clearTimeout(doneTimer);
    }
    const stepDelay = reducedMotion ? 20 : 150;
    const timer = window.setTimeout(() => {
      setRunningStepIdx((prev) => (prev === null ? null : prev + 1));
    }, stepDelay);
    return () => window.clearTimeout(timer);
  }, [runningStepIdx, report.agentTraces.length, reducedMotion]);

  const handleRerunAudit = () => {
    triggerCausalHaptic(5);
    setRunningStepIdx(0);
    if (agentEndpoint && !agentLoading) {
      onRunLiveAgent();
    }
  };

  const handleCopyDossier = () => {
    triggerCausalHaptic(6);
    navigator.clipboard.writeText(report.markdownDossier);
    setCopiedDossier(true);
    window.setTimeout(() => setCopiedDossier(false), 1800);
  };

  const filteredEvidence =
    evidenceFilter === 'all'
      ? report.evidenceLedger
      : report.evidenceLedger.filter((item) => item.sourceKind === evidenceFilter);

  const panelTransition = reducedMotion
    ? REDUCED_MOTION_TRANSITION
    : SPRING_DEFAULT;
  const exitTransition = reducedMotion
    ? REDUCED_MOTION_TRANSITION
    : EXIT_FAST_TRANSITION;

  const verdictBannerStyle =
    report.verdictTone === 'compliant'
      ? 'bg-[var(--pm-compliant-soft)] border-[var(--pm-compliant-border)]'
      : report.verdictTone === 'warning'
        ? 'bg-[var(--pm-warning-soft)] border-[var(--pm-warning-border)]'
        : 'bg-[var(--pm-danger-soft)] border-[var(--pm-danger-border)]';

  return (
    <section
      aria-label="Multi-agent research, verification, evidence and clinical conclusion"
      className="pm-card overflow-hidden"
    >
      {/* 1. Header & Action Controls */}
      <div className="p-6 sm:p-7 border-b border-[var(--pm-border)] space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="pm-kicker flex items-center gap-2">
              <span>Multi-Agent Clinical Intelligence Council</span>
              <span className="font-mono-code text-[11px] text-[var(--pm-accent)]">
                5 specialized agents
              </span>
            </div>
            <h2 className="pm-h2 text-[20px] sm:text-[22px]">
              Research, verification, organized evidence &amp; conclusion
            </h2>
            <p className="text-[13.5px] text-[var(--pm-muted)] pm-measure">
              Coordinates neighborhood policy research, ISO GQL graph routing, statutory/fairness verification, source attribution, and executive decision synthesis.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 no-print">
            <button
              type="button"
              onClick={handleRerunAudit}
              disabled={runningStepIdx !== null || agentLoading}
              className="pm-btn pm-btn-secondary pm-btn-compact"
            >
              {runningStepIdx !== null || agentLoading ? (
                <>
                  <RefreshCw
                    aria-hidden="true"
                    className="w-3.5 h-3.5 animate-spin text-[var(--pm-accent)]"
                  />
                  <span>
                    {runningStepIdx !== null &&
                    runningStepIdx < report.agentTraces.length
                      ? `Running Agent ${runningStepIdx + 1}/5...`
                      : 'Verifying...'}
                  </span>
                </>
              ) : (
                <>
                  <Play
                    aria-hidden="true"
                    className="w-3.5 h-3.5 text-[var(--pm-accent)]"
                  />
                  <span>Re-run 5-agent audit</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleCopyDossier}
              className="pm-btn pm-btn-primary pm-btn-compact"
            >
              {copiedDossier ? (
                <>
                  <Check aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Copied dossier</span>
                </>
              ) : (
                <>
                  <Copy aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Copy evidence dossier</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Interactive 5-Agent Pipeline Strip */}
        <div
          role="list"
          aria-label="5-agent execution pipeline"
          className="pm-grid-agents"
        >
          {report.agentTraces.map((agent, idx) => {
            const isRunningThis = runningStepIdx === idx;
            const isCompleted =
              runningStepIdx === null || runningStepIdx > idx;
            const isFocused =
              activeTab === 'trace' && focusedAgentId === agent.agentId;

            return (
              <button
                key={agent.agentId}
                role="listitem"
                type="button"
                onClick={() => {
                  triggerCausalHaptic(3);
                  setFocusedAgentId(agent.agentId);
                  setActiveTab('trace');
                }}
                className={`pm-card-interactive text-left p-3.5 rounded-[10px] border transition-colors ${
                  isRunningThis
                    ? 'bg-[var(--pm-accent-soft)] border-[var(--pm-accent)]'
                    : isFocused
                      ? 'bg-[var(--pm-accent-soft)] border-[var(--pm-accent)]'
                      : 'bg-[var(--pm-surface)] border-[var(--pm-border)]'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] font-mono-code font-semibold text-[var(--pm-accent)]">
                    {getAgentIcon(agent.agentId)}
                    <span>A{idx + 1}</span>
                  </span>
                  <span className="text-[11px] font-mono-code text-[var(--pm-muted)]">
                    {isRunningThis
                      ? 'Active…'
                      : isCompleted
                        ? agent.status === 'advisory'
                          ? 'Advisory'
                          : 'Verified'
                        : 'Queued'}
                  </span>
                </div>
                <div
                  className="text-[13px] font-semibold text-[var(--pm-ink)] mt-1.5 leading-snug"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {agent.roleTitle}
                </div>
                <div className="text-[11.5px] text-[var(--pm-muted)] mt-1 leading-snug">
                  {agent.artifactsProduced[0]}
                </div>
              </button>
            );
          })}
        </div>

        {/* Brief & Precise Clinical Conclusion Callout (Always Visible Anchor) */}
        <div
          className={`p-4 sm:p-5 rounded-[12px] border ${verdictBannerStyle} space-y-2.5`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {report.verdictTone === 'compliant' ? (
                <span className="pm-badge pm-badge-compliant">
                  <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>{report.verdictBadge}</span>
                </span>
              ) : report.verdictTone === 'warning' ? (
                <span className="pm-badge pm-badge-warning">
                  <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>{report.verdictBadge}</span>
                </span>
              ) : (
                <span className="pm-badge pm-badge-danger">
                  <ShieldAlert aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>{report.verdictBadge}</span>
                </span>
              )}
              <span className="text-[12px] font-semibold text-[var(--pm-ink)]" style={{ fontFamily: 'var(--font-display)' }}>
                Brief &amp; Precise Conclusion
              </span>
            </div>

            <span className="font-mono-code text-[12px] font-semibold text-[var(--pm-ink)] tabular-nums">
              {report.verificationScoreLabel}
            </span>
          </div>

          <p
            className="text-[14.5px] sm:text-[15px] text-[var(--pm-ink)] leading-relaxed m-0"
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {report.preciseConclusion}
          </p>
        </div>
      </div>

      {/* 2. Segmented View Switcher */}
      <div className="px-6 sm:px-7 py-3.5 bg-[var(--pm-surface)] border-b border-[var(--pm-border)] flex flex-wrap items-center justify-between gap-3 no-print">
        <div className="w-full sm:w-auto overflow-x-auto">
          <FluidSegmentedControl<CouncilTabId>
            layoutId="multi-agent-council-tabs"
            ariaLabel="Multi-agent report sections"
            size="md"
            options={[
              {
                value: 'summary',
                label: (
                  <>
                    <Sparkles aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>Output summary</span>
                  </>
                ),
              },
              {
                value: 'verification',
                label: (
                  <>
                    <ClipboardCheck aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>
                      Verify ({report.passedChecksCount}/{report.totalChecksCount})
                    </span>
                  </>
                ),
              },
              {
                value: 'evidence',
                label: (
                  <>
                    <BookOpenCheck aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>Evidence &amp; sources ({report.evidenceLedger.length})</span>
                  </>
                ),
              },
              {
                value: 'trace',
                label: (
                  <>
                    <GitBranch aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>Agent trace (5)</span>
                  </>
                ),
              },
            ]}
            value={activeTab}
            onChange={setActiveTab}
          />
        </div>
      </div>

      {/* 3. Active Tab Content */}
      <div className="p-6 sm:p-7">
        <AnimatePresence mode="wait">
          {/* TAB A: Synthesized Output Summary & Coordinator Action Checklist */}
          {activeTab === 'summary' && (
            <motion.div
              key="summary"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3, transition: exitTransition }}
              transition={panelTransition}
              className="space-y-6"
            >
              <div className="space-y-3">
                <div className="pm-kicker">Synthesized Research Digest</div>
                <div className="grid grid-cols-1 gap-3.5">
                  {report.executiveSummaryBullets.map((item) => (
                    <div
                      key={item.heading}
                      className="pm-panel p-4 space-y-1.5"
                    >
                      <h3 className="pm-h3 text-[14.5px] text-[var(--pm-accent)]">
                        {item.heading}
                      </h3>
                      <p className="text-[14px] text-[var(--pm-text)] leading-relaxed m-0">
                        {item.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3 pt-2 border-t border-[var(--pm-border)]">
                <div className="pm-kicker">
                  Recommended Day 0 Coordinator Actions
                </div>
                <ol className="space-y-2 m-0 pl-0 list-none">
                  {report.immediateActions.map((act, idx) => (
                    <li
                      key={act}
                      className="flex items-start gap-3 p-3 rounded-[10px] bg-[var(--pm-surface)] border border-[var(--pm-border)] text-[13.5px] text-[var(--pm-ink)]"
                    >
                      <span className="w-6 h-6 rounded-[6px] bg-[var(--pm-cta-bg)] text-white font-mono-code text-[12px] font-semibold flex items-center justify-center shrink-0 mt-0.5">
                        {idx + 1}
                      </span>
                      <span className="leading-relaxed">{act}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </motion.div>
          )}

          {/* TAB B: Independent Statutory, Clinical & Fairness Verification Matrix */}
          {activeTab === 'verification' && (
            <motion.div
              key="verification"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3, transition: exitTransition }}
              transition={panelTransition}
              className="space-y-4 tabular-nums"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="pm-h3 text-[16px]">
                    Statutory, clinical &amp; schema verification matrix
                  </h3>
                  <p className="text-[13.5px] text-[var(--pm-muted)]">
                    Audited independently by the Compliance &amp; Fairness Verifier Agent prior to conclusion sign-off.
                  </p>
                </div>
              </div>

              <div className="pm-grid-checks">
                {report.verificationChecks.map((chk) => (
                  <div
                    key={chk.id}
                    className="pm-panel p-4 flex flex-col justify-between gap-3"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="pm-h3 text-[14.5px] leading-snug">
                          {chk.title}
                        </div>
                        {renderStatusBadge(chk.status)}
                      </div>

                      <div className="font-mono-code text-[12px] font-semibold text-[var(--pm-accent)]">
                        {chk.measuredValue}
                      </div>

                      <p className="text-[13px] text-[var(--pm-muted)] leading-relaxed m-0">
                        {chk.detail}
                      </p>
                    </div>

                    <div className="pt-2.5 border-t border-[var(--pm-border)] flex items-center justify-between text-[11.5px] text-[var(--pm-muted)]">
                      <span>Authority / Rule</span>
                      <code className="font-mono-code text-[var(--pm-ink)]">
                        {chk.ruleCitation}
                      </code>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* TAB C: Organized Evidence & Verifiable Source Attribution Ledger */}
          {activeTab === 'evidence' && (
            <motion.div
              key="evidence"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3, transition: exitTransition }}
              transition={panelTransition}
              className="space-y-4 tabular-nums"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="pm-h3 text-[16px]">
                    Organized evidence &amp; provenance source ledger
                  </h3>
                  <p className="text-[13.5px] text-[var(--pm-muted)]">
                    Every quantitative claim is linked to its exact federal statute, public survey table, or 100% [Synthetic] graph record.
                  </p>
                </div>

                {/* Source Category Filter Chips */}
                <div className="flex flex-wrap gap-1.5 no-print">
                  {(
                    [
                      { id: 'all', label: 'All sources' },
                      { id: 'federal-statute', label: 'Federal law' },
                      { id: 'public-census-nsch', label: 'Census & NSCH' },
                      { id: 'synthetic-graph', label: 'ReferralGraph' },
                      { id: 'fairness-audit', label: 'Equity audit' },
                    ] as const
                  ).map((f) => {
                    const active = evidenceFilter === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setEvidenceFilter(f.id)}
                        className={`min-h-[34px] px-2.5 py-1 rounded-[7px] text-[12px] font-semibold border cursor-pointer touch-manipulation transition-colors ${
                          active
                            ? 'bg-[var(--pm-accent-soft)] border-[var(--pm-accent)] text-[var(--pm-accent)]'
                            : 'bg-[var(--pm-surface)] border-[var(--pm-border)] text-[var(--pm-muted)] hover:text-[var(--pm-ink)]'
                        }`}
                        style={{ fontFamily: 'var(--font-display)' }}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3">
                {filteredEvidence.map((ev) => (
                  <article
                    key={ev.id}
                    className="pm-panel p-4 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {renderProvenanceBadge(ev.provenanceLabel)}
                        <span className="pm-h3 text-[14px]">
                          {ev.sourceTitle}
                        </span>
                      </div>
                      <code className="font-mono-code text-[11.5px] px-2 py-0.5 rounded-[5px] bg-[var(--pm-card)] border border-[var(--pm-border)] text-[var(--pm-accent)]">
                        {ev.recordLocator}
                      </code>
                    </div>

                    <p className="text-[13.5px] text-[var(--pm-text)] leading-relaxed m-0">
                      {ev.claim}
                    </p>

                    <div className="pt-2 border-t border-[var(--pm-border)] flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                      <span className="text-[var(--pm-muted)]">
                        Verified metric / evidence:
                      </span>
                      <span className="font-mono-code font-semibold text-[var(--pm-ink)]">
                        {ev.supportingMetric}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </motion.div>
          )}

          {/* TAB D: 5-Agent Research & Handoff Execution Trace */}
          {activeTab === 'trace' && (
            <motion.div
              key="trace"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3, transition: exitTransition }}
              transition={panelTransition}
              className="space-y-3.5"
            >
              <div>
                <h3 className="pm-h3 text-[16px]">
                  5-agent execution &amp; tool handoff trace
                </h3>
                <p className="text-[13.5px] text-[var(--pm-muted)]">
                  Sequential pipeline trace showing how each specialist agent researched, verified, and handed off structured artifacts.
                </p>
              </div>

              <div className="space-y-3">
                {report.agentTraces.map((step, idx) => {
                  const highlighted = focusedAgentId === step.agentId;
                  return (
                    <div
                      key={step.agentId}
                      className={`p-4 rounded-[12px] border transition-colors space-y-2.5 ${
                        highlighted
                          ? 'bg-[var(--pm-accent-soft)] border-[var(--pm-accent)]'
                          : 'bg-[var(--pm-surface)] border-[var(--pm-border)]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <span className="w-7 h-7 rounded-[7px] bg-[var(--pm-cta-bg)] text-white flex items-center justify-center shrink-0">
                            {getAgentIcon(step.agentId)}
                          </span>
                          <div>
                            <div className="pm-h3 text-[14.5px]">
                              Agent {idx + 1} · {step.agentName}
                            </div>
                            <div className="font-mono-code text-[11.5px] text-[var(--pm-muted)]">
                              Tool: {step.toolUsed}
                            </div>
                          </div>
                        </div>

                        {step.status === 'completed' ? (
                          <span className="pm-badge pm-badge-compliant">
                            <CheckCircle2 aria-hidden="true" className="w-3 h-3" />
                            <span>Completed</span>
                          </span>
                        ) : (
                          <span className="pm-badge pm-badge-warning">
                            <AlertTriangle aria-hidden="true" className="w-3 h-3" />
                            <span>Flagged advisory</span>
                          </span>
                        )}
                      </div>

                      <p className="text-[13.5px] text-[var(--pm-text)] leading-relaxed m-0">
                        {step.keyFinding}
                      </p>

                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        {step.artifactsProduced.map((art) => (
                          <span
                            key={art}
                            className="pm-badge bg-[var(--pm-card)] text-[11.5px]"
                          >
                            {art}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
};
