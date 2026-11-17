import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  Bus,
  CheckCircle2,
  FileWarning,
  Laptop,
  MapPin,
  Phone,
} from 'lucide-react';
import { cleanOrgName } from '../engine/graphTriageEngine';
import type {
  CandidatePathway,
  HistoricalChainTrace,
  ReferralIntakeInput,
  TractDemographic,
  TransmissionChannel,
} from '../types';
import {
  REDUCED_MOTION_TRANSITION,
  SPRING_DEFAULT,
  triggerCausalHaptic,
} from '../utils/applePhysics';

interface PathwayClockComparisonProps {
  intake: ReferralIntakeInput;
  tract: TractDemographic;
  activePathway: CandidatePathway | null;
  alternatives: CandidatePathway[];
  selectedPathwayId: string | null;
  onSelectPathway: (id: string) => void;
  historicalTrapChain: HistoricalChainTrace | null;
}

const MAX_TIMELINE_DAYS = 85;
const FEDERAL_LIMIT_PCT = (45 / MAX_TIMELINE_DAYS) * 100;

function channelChip(channel?: TransmissionChannel) {
  if (!channel) return null;
  if (channel === 'ehr_electronic_portal') {
    return (
      <span className="pm-badge pm-badge-accent">
        <Laptop aria-hidden="true" className="w-3 h-3" />
        <span>e-Portal</span>
      </span>
    );
  }
  if (channel === 'paper_fax') {
    return (
      <span className="pm-badge pm-badge-danger">
        <FileWarning aria-hidden="true" className="w-3 h-3" />
        <span>Paper fax</span>
      </span>
    );
  }
  return (
    <span className="pm-badge">
      <Phone aria-hidden="true" className="w-3 h-3" />
      <span>Voicemail</span>
    </span>
  );
}

export const PathwayClockComparison: React.FC<PathwayClockComparisonProps> = ({
  intake,
  tract,
  activePathway,
  alternatives,
  selectedPathwayId,
  onSelectPathway,
  historicalTrapChain,
}) => {
  const reducedMotion = useReducedMotion();
  const barTransition = reducedMotion
    ? REDUCED_MOTION_TRANSITION
    : SPRING_DEFAULT;

  const allOptions = activePathway
    ? [
        activePathway,
        ...alternatives.filter((a) => a.id !== activePathway.id),
      ]
    : alternatives;

  if (!activePathway) {
    return (
      <section className="pm-card p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-[12px] bg-[var(--pm-danger-soft)] border border-[var(--pm-danger-border)] flex items-center justify-center shrink-0">
            <AlertTriangle
              aria-hidden="true"
              className="w-5 h-5 text-[var(--pm-danger)]"
            />
          </div>
          <div className="space-y-2">
            <div className="pm-badge pm-badge-danger">
              <span>Statutory 45-Day Override Required</span>
            </div>
            <h1 className="pm-h2 text-[22px]">
              No standard 3-hop clinic sequence clears 45 days
            </h1>
            <p className="text-[15px] text-[var(--pm-text)] pm-measure leading-relaxed">
              No in-state clinic pathway met all active filters within the federal 45-day window. Authorize a Part C mobile bilingual evaluation team or enable{' '}
              <strong className="font-bold text-[var(--pm-ink)]">
                Simulate e-Portal upgrade
              </strong>{' '}
              on the intake panel to model electronic coordinator handoffs.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const hopShades = ['bg-[#0284C7]', 'bg-[#0369A1]', 'bg-[#075985]'];
  const trapShades = [
    'bg-[#DC2626] pm-pattern-breach',
    'bg-[#B91C1C] pm-pattern-breach',
    'bg-[#991B1B] pm-pattern-breach',
    'bg-[#7F1D1D] pm-pattern-breach',
  ];

  return (
    <section className="pm-card overflow-hidden">
      {/* 1. Primary Clinical Decision Header */}
      <div className="p-6 sm:p-7 border-b border-[var(--pm-border)]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {activePathway.clears45DayClock ? (
              <span className="pm-badge pm-badge-compliant">
                <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Clears 45-Day Mandate</span>
              </span>
            ) : (
              <span className="pm-badge pm-badge-danger">
                <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Exceeds 45-Day Window</span>
              </span>
            )}
            <span className="text-[13px] text-[var(--pm-muted)]">
              {tract.county_name} · Tract{' '}
              <code className="font-mono-code text-[12.5px] text-[var(--pm-ink)]">
                {tract.census_tract_geoid}
              </code>
            </span>
          </div>

          <h1 className="pm-h1 text-[26px] sm:text-[32px] tabular-nums">
            {activePathway.clears45DayClock ? (
              <>
                {activePathway.totalExpectedDays} days to initial IFSP{' '}
                <span className="text-[var(--pm-muted)] font-medium">
                  ({activePathway.daysMargin}d inside limit)
                </span>
              </>
            ) : (
              <>
                {activePathway.totalExpectedDays} days on fastest eligible route{' '}
                <span className="text-[var(--pm-danger)] font-semibold">
                  (+{activePathway.totalExpectedDays - 45}d over limit)
                </span>
              </>
            )}
          </h1>

          <p className="text-[15.5px] text-[var(--pm-text)] pm-measure leading-relaxed">
            Routes a{' '}
            <strong className="font-bold text-[var(--pm-ink)]">
              {intake.childAgeMonths}-month-old
            </strong>{' '}
            needing{' '}
            <strong className="font-bold text-[var(--pm-ink)]">
              {intake.primaryLanguage !== 'English'
                ? `${intake.primaryLanguage} bilingual`
                : 'standard'}{' '}
              evaluation
            </strong>{' '}
            {intake.insuranceMedicaid ? 'on Medicaid ' : ''}
            electronically through{' '}
            <strong className="font-bold text-[var(--pm-ink)]">
              {cleanOrgName(activePathway.steps[1].node.synthetic_organization_name)}
            </strong>{' '}
            to{' '}
            <strong className="font-bold text-[var(--pm-ink)]">
              {cleanOrgName(activePathway.steps[2].node.synthetic_organization_name)}
            </strong>{' '}
            (<span className="font-mono-code">{activePathway.evalHubDistanceKm} km</span> from home).
          </p>
        </div>
      </div>

      {/* 2. Accessible 45-Day Statutory Timeline Comparison (Solid Fill vs. Striped Pattern + Icons) */}
      <div className="px-6 sm:px-7 py-6 bg-[var(--pm-surface)] border-b border-[var(--pm-border)] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="pm-h3 text-[16px]">
              45-day statutory timeline comparison
            </h2>
            <p className="text-[13px] text-[var(--pm-muted)]">
              Day 0 screening referral through multidisciplinary evaluation &amp; initial IFSP
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-[var(--pm-muted)]">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="w-3.5 h-3.5 rounded-[4px] bg-[#0369A1] inline-block"
              />
              <span>Solid: Electronic route (&le;45d)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="w-3.5 h-3.5 rounded-[4px] bg-[#B91C1C] pm-pattern-breach inline-block"
              />
              <span>Striped: Paper-fax bounce (&gt;45d)</span>
            </span>
          </div>
        </div>

        <div className="relative pt-6 pb-1 space-y-5">
          {/* Vertical Day 45 Statutory Ceiling */}
          <div
            style={{ left: `${FEDERAL_LIMIT_PCT}%` }}
            className="absolute top-0 bottom-0 border-l-2 border-dashed border-[var(--pm-danger)] z-10 pointer-events-none"
          >
            <span className="absolute -top-0.5 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 rounded-[6px] bg-[var(--pm-ink)] text-[var(--pm-bg)] text-[11px] font-mono-code font-semibold tabular-nums">
              Day 45 statutory cap
            </span>
          </div>

          {/* Row 1: Recommended Pathway */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between text-[13.5px] gap-1 tabular-nums">
              <span
                className="inline-flex items-center gap-1.5 font-semibold text-[var(--pm-ink)]"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                <CheckCircle2
                  aria-hidden="true"
                  className="w-4 h-4 text-[var(--pm-compliant)]"
                />
                <span>Recommended 3-hop electronic route</span>
              </span>
              <span className="font-mono-code font-semibold text-[var(--pm-compliant)]">
                {activePathway.totalExpectedDays}d ({activePathway.daysMargin}d buffer)
              </span>
            </div>
            <div
              role="img"
              aria-label={`Recommended 3-hop electronic route totaling ${activePathway.totalExpectedDays} days`}
              className="w-full h-9 rounded-[8px] bg-[var(--pm-card)] border border-[var(--pm-border)] overflow-hidden flex relative p-[2px] gap-[2px]"
            >
              {activePathway.steps.slice(1).map((step, idx) => {
                const widthPct = Math.min(
                  100,
                  (step.expectedStepWaitDays / MAX_TIMELINE_DAYS) * 100
                );
                return (
                  <motion.div
                    key={`hop-slot-${step.stepNumber}`}
                    animate={{ width: `${widthPct}%` }}
                    transition={barTransition}
                    title={`Hop ${step.stepNumber}: ${cleanOrgName(step.node.synthetic_organization_name)} (+${step.expectedStepWaitDays}d)`}
                    className={`${hopShades[idx % hopShades.length]} h-full rounded-[5px] flex items-center justify-center text-[11.5px] font-mono-code font-medium text-white px-1.5 truncate tabular-nums`}
                  >
                    H{step.stepNumber} · {step.expectedStepWaitDays}d
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Row 2: Historical Paper-Fax Bounce Chain */}
          {historicalTrapChain && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between text-[13.5px] gap-1 tabular-nums">
                <span
                  className="inline-flex items-center gap-1.5 font-semibold text-[var(--pm-ink)]"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  <FileWarning
                    aria-hidden="true"
                    className="w-4 h-4 text-[var(--pm-danger)]"
                  />
                  <span>
                    Historical paper-fax loop (
                    <code className="font-mono-code text-[12px]">
                      {historicalTrapChain.caseChainId}
                    </code>
                    ) · {historicalTrapChain.hops.length} hops
                  </span>
                </span>
                <span className="font-mono-code font-semibold text-[var(--pm-danger)]">
                  {historicalTrapChain.totalWaitDays}d (+
                  {historicalTrapChain.totalWaitDays - 45}d breach)
                </span>
              </div>
              <div
                role="img"
                aria-label={`Historical paper-fax bounce loop totaling ${historicalTrapChain.totalWaitDays} days, exceeding the 45-day limit by ${historicalTrapChain.totalWaitDays - 45} days`}
                className="w-full h-9 rounded-[8px] bg-[var(--pm-card)] border border-[var(--pm-border)] overflow-hidden flex relative p-[2px] gap-[2px]"
              >
                {historicalTrapChain.hops.map((hop, idx) => {
                  const widthPct = Math.min(
                    100,
                    (hop.waitDays / MAX_TIMELINE_DAYS) * 100
                  );
                  return (
                    <motion.div
                      key={`trap-slot-${hop.hopSequence}`}
                      animate={{ width: `${widthPct}%` }}
                      transition={barTransition}
                      title={`Hop ${hop.hopSequence} (${hop.channel}): ${cleanOrgName(hop.target.synthetic_organization_name)} (+${hop.waitDays}d) — ${hop.reason}`}
                      className={`${trapShades[idx % trapShades.length]} h-full rounded-[5px] flex items-center justify-center text-[11.5px] font-mono-code font-medium text-white px-1.5 truncate tabular-nums`}
                    >
                      H{hop.hopSequence} · {hop.waitDays}d
                    </motion.div>
                  );
                })}
              </div>
              <p className="text-[13px] text-[var(--pm-muted)] leading-relaxed pt-0.5">
                Coordinator{' '}
                <code className="font-mono-code text-[12px] text-[var(--pm-ink)]">
                  {historicalTrapChain.hops[0]?.target.provider_id}
                </code>{' '}
                reports only a{' '}
                <strong className="font-bold text-[var(--pm-ink)]">
                  {historicalTrapChain.hops[0]?.target.median_internal_wait_days}-day internal wait
                </strong>{' '}
                in flat SQL tables, while downstream{' '}
                <code className="font-mono-code text-[12px]">paper_fax</code>{' '}
                handoffs added{' '}
                {historicalTrapChain.hops.find((h) => h.reason.startsWith('Re-Referral'))
                  ?.reason ?? 'multi-hop re-referral delays'}
                .
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Zero-Vehicle Travel Guardrail */}
      {activePathway.transportAdvisory && (
        <div
          role="note"
          className="mx-6 sm:mx-7 mt-6 p-4 rounded-[12px] bg-[var(--pm-warning-soft)] border border-[var(--pm-warning-border)] flex items-start gap-3 text-[13.5px] text-[var(--pm-ink)]"
        >
          <Bus
            aria-hidden="true"
            className="w-4 h-4 text-[var(--pm-warning)] shrink-0 mt-1"
          />
          <div className="leading-relaxed">
            <strong className="font-bold">Zero-vehicle transport guardrail: </strong>
            {activePathway.transportAdvisory}
          </div>
        </div>
      )}

      {/* 3. Verified 4-Step CareNode Sequence */}
      <div className="p-6 sm:p-7 space-y-5">
        <div>
          <div className="pm-kicker">Step 2 · CareNode Chain</div>
          <h2 className="pm-h3 text-[16.5px] mt-0.5">
            Verified 4-node clinical routing sequence
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3.5">
          {activePathway.steps.map((step, index) => {
            const isOrigin = index === 0;
            const roleLabel =
              step.node.node_role === 'Screening_Pediatric_Clinic'
                ? '0 · Origin clinic'
                : step.node.node_role === 'Part_C_Intake_Coordinator'
                  ? '1 · Coordinator'
                  : step.node.node_role === 'Multidisciplinary_Eval_Hub'
                    ? '2 · Eval hub'
                    : '3 · EI therapy';

            return (
              <div
                key={`${step.stepNumber}-${step.node.provider_id}`}
                className="relative rounded-[12px] bg-[var(--pm-surface)] border border-[var(--pm-border)] p-4 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2.5 tabular-nums">
                    <span
                      className="text-[12px] font-semibold text-[var(--pm-accent)]"
                      style={{ fontFamily: 'var(--font-display)' }}
                    >
                      {roleLabel}
                    </span>
                    <span className="font-mono-code text-[12px] font-semibold text-[var(--pm-ink)] px-2 py-0.5 rounded-[5px] bg-[var(--pm-card)] border border-[var(--pm-border)]">
                      Day {step.cumulativeDays}
                    </span>
                  </div>

                  <div className="pm-h3 text-[14.5px] leading-snug">
                    {cleanOrgName(step.node.synthetic_organization_name)}
                  </div>
                  <div className="font-mono-code text-[11.5px] text-[var(--pm-muted)] mt-0.5">
                    {step.node.provider_id}
                  </div>

                  <p className="text-[13px] text-[var(--pm-muted)] mt-2.5 leading-relaxed">
                    {step.handoffNote}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-[var(--pm-border)] space-y-2.5">
                  <div className="flex items-center justify-between text-[12.5px] text-[var(--pm-muted)] tabular-nums">
                    <span className="inline-flex items-center gap-1 truncate">
                      <MapPin aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {step.node.city} ({step.distanceFromHomeKm} km)
                      </span>
                    </span>
                    {isOrigin ? (
                      <span className="font-mono-code text-[12px]">Day 0</span>
                    ) : (
                      <span className="font-mono-code font-semibold text-[var(--pm-compliant)]">
                        +{step.expectedStepWaitDays}d
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {step.channelIn && channelChip(step.channelIn)}
                    {step.node.accepts_medicaid && (
                      <span className="pm-badge">Medicaid</span>
                    )}
                    {step.node.bilingual_services_listed && (
                      <span className="pm-badge">Bilingual</span>
                    )}
                    {step.node.part_c_vendor_enrolled && (
                      <span className="pm-badge">Part C</span>
                    )}
                  </div>
                </div>

                {index < activePathway.steps.length - 1 && (
                  <div
                    aria-hidden="true"
                    className="hidden xl:flex absolute -right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-[var(--pm-card)] text-[var(--pm-ink)] border border-[var(--pm-border-strong)] items-center justify-center z-10 shadow-xs"
                  >
                    <ArrowRight className="w-3 h-3" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Alternative Compliant Pathways */}
        {allOptions.length > 1 && (
          <div className="pt-5 border-t border-[var(--pm-border)] no-print space-y-2.5">
            <div className="pm-label">
              Compare alternate eligible routes ({allOptions.length})
            </div>
            <div className="flex flex-wrap gap-2.5">
              {allOptions.map((opt, idx) => {
                const selected = selectedPathwayId
                  ? opt.id === selectedPathwayId
                  : idx === 0;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      if (!selected) triggerCausalHaptic(4);
                      onSelectPathway(opt.id);
                    }}
                    className={`pm-card-interactive min-h-[42px] px-3.5 py-2 rounded-[10px] text-[13px] tabular-nums border text-left ${
                      selected
                        ? 'bg-[var(--pm-accent-soft)] border-[var(--pm-accent)] text-[var(--pm-ink)] font-semibold'
                        : 'bg-[var(--pm-card)] border-[var(--pm-border-strong)] text-[var(--pm-muted)] hover:text-[var(--pm-ink)]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono-code font-semibold text-[var(--pm-accent)]">
                        {opt.totalExpectedDays}d
                      </span>
                      <span aria-hidden="true" className="text-[var(--pm-muted)]">
                        ·
                      </span>
                      <span className="truncate max-w-[210px] text-[var(--pm-ink)]">
                        {cleanOrgName(opt.steps[2].node.synthetic_organization_name)}
                      </span>
                      <span className="font-mono-code text-[12px] text-[var(--pm-muted)]">
                        {opt.evalHubDistanceKm} km
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
