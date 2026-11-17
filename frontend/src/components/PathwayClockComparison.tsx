import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  Bus,
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
      <span className="ts-chip ts-chip-accent">
        <Laptop className="w-3 h-3" />
        <span>e-Portal</span>
      </span>
    );
  }
  if (channel === 'paper_fax') {
    return (
      <span className="ts-chip ts-chip-breach">
        <FileWarning className="w-3 h-3" />
        <span>Paper fax</span>
      </span>
    );
  }
  return (
    <span className="ts-chip">
      <Phone className="w-3 h-3" />
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
      <section data-enter className="ts-card p-6 sm:p-8 ts-hero-enter">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-[10px] bg-[rgba(180,62,47,0.1)] border border-[rgba(180,62,47,0.25)] flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-[#B43E2F]" />
          </div>
          <div className="space-y-1.5">
            <h1 className="ts-h2 text-[22px]">
              No standard route clears 45 days.{' '}
              <span className="ts-muted">Regional mobile override needed.</span>
            </h1>
            <p className="text-[15px] text-[#27303D] ts-measure leading-relaxed">
              No in-state clinic sequence met all active filters within 45 days. Authorize a Part C mobile bilingual evaluation or enable{' '}
              <strong className="font-medium text-[#1D2530]">Simulate e-portal upgrade</strong>{' '}
              on the intake panel.
            </p>
          </div>
        </div>
      </section>
    );
  }

  /* Monochrome stepped Harbour Blue shades vs. desaturated Terracotta breach shades */
  const hopColors = ['bg-[#3B6D90]', 'bg-[#2C5877]', 'bg-[#1F425B]'];
  const trapColors = ['bg-[#C65B4B]', 'bg-[#B43E2F]', 'bg-[#983326]', 'bg-[#7D281D]'];

  return (
    <section data-enter className="ts-card overflow-hidden ts-hero-enter">
      {/* 1. Primary Triage Hero Header — Plain copy, one hard fact, contrast two-sentence h1 */}
      <div className="p-6 sm:p-8 border-b border-[rgba(29,37,48,0.1)]">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="space-y-3 max-w-2xl">
            <div className="ts-label flex flex-wrap items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-[#2C5877]" />
              <span>
                Recommended referral path · {tract.county_name} (tract{' '}
                <code className="font-mono-code text-[#1D2530]">
                  {tract.census_tract_geoid}
                </code>
                )
              </span>
            </div>

            <h1 className="ts-h1 text-[28px] sm:text-[34px] tabular-nums">
              {activePathway.clears45DayClock ? (
                <>
                  {activePathway.totalExpectedDays} days to initial IFSP.{' '}
                  <span className="ts-muted">
                    {activePathway.daysMargin} days inside the 45-day federal limit.
                  </span>
                </>
              ) : (
                <>
                  {activePathway.totalExpectedDays} days on fastest eligible route.{' '}
                  <span className="ts-muted">
                    Exceeds the 45-day statutory window.
                  </span>
                </>
              )}
            </h1>

            <p className="text-[15.5px] text-[#27303D] ts-measure leading-relaxed">
              Routes a{' '}
              <strong className="font-medium text-[#1D2530]">
                {intake.childAgeMonths}-month-old
              </strong>{' '}
              needing{' '}
              <strong className="font-medium text-[#1D2530]">
                {intake.primaryLanguage !== 'English'
                  ? `${intake.primaryLanguage} bilingual`
                  : 'standard'}{' '}
                evaluation
              </strong>{' '}
              {intake.insuranceMedicaid ? 'on Medicaid ' : ''}
              electronically through{' '}
              <strong className="font-medium text-[#1D2530]">
                {cleanOrgName(activePathway.steps[1].node.synthetic_organization_name)}
              </strong>{' '}
              to{' '}
              <strong className="font-medium text-[#1D2530]">
                {cleanOrgName(activePathway.steps[2].node.synthetic_organization_name)}
              </strong>{' '}
              (<span className="tabular-nums">{activePathway.evalHubDistanceKm} km</span> from home).
            </p>
          </div>

          {/* Calibrated Tabular Figures (system.md: figures never outgrow the h1) */}
          <dl className="flex items-center gap-5 pt-1 shrink-0 tabular-nums border-t sm:border-t-0 border-[rgba(29,37,48,0.1)] w-full sm:w-auto">
            <div>
              <dt className="ts-label">Expected wait</dt>
              <dd className="font-mono-code text-[24px] font-medium text-[#1D2530] mt-0.5">
                {activePathway.totalExpectedDays}d{' '}
                <span className="text-[13px] font-normal text-[#556070]">/ 45d</span>
              </dd>
            </div>
            {historicalTrapChain && (
              <div className="border-l border-[rgba(29,37,48,0.12)] pl-5">
                <dt className="ts-label">Saved vs. fax loop</dt>
                <dd className="font-mono-code text-[24px] font-medium text-[#2C5877] mt-0.5">
                  -{Math.max(0, historicalTrapChain.totalWaitDays - activePathway.totalExpectedDays)}d
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* 2. 45-Day Statutory Clock Comparison — Warm linen panel, single accent vs. breach */}
      <div className="px-6 sm:px-8 py-6 bg-[#F8F7F4] border-b border-[rgba(29,37,48,0.1)] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="ts-h3 text-[16px]">
            45-day statutory clock.{' '}
            <span className="ts-muted">Day 0 referral to initial IFSP.</span>
          </h2>
          <div className="flex flex-wrap items-center gap-4 text-[13px] text-[#556070]">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-[3px] bg-[#2C5877] inline-block" />
              <span>Electronic path (&le;45d)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-[3px] bg-[#B43E2F] inline-block" />
              <span>Paper-fax bounce (&gt;45d)</span>
            </span>
          </div>
        </div>

        <div className="relative pt-5 pb-1 space-y-5">
          {/* Vertical Day 45 Statutory Ceiling */}
          <div
            style={{ left: `${FEDERAL_LIMIT_PCT}%` }}
            className="absolute top-0 bottom-0 border-l border-dashed border-[#B43E2F] z-10 pointer-events-none"
          >
            <span className="absolute -top-0.5 -translate-x-1/2 whitespace-nowrap px-2 py-0.5 rounded-[5px] bg-[#1D2530] text-[#F3F1EC] text-[11.5px] font-mono-code font-medium tabular-nums">
              Day 45 limit
            </span>
          </div>

          {/* Row 1: Recommended Pathway */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[13.5px] tabular-nums">
              <span className="font-medium text-[#1D2530]">
                Recommended 3-hop electronic route
              </span>
              <span className="font-mono-code font-medium text-[#2C5877]">
                {activePathway.totalExpectedDays}d ({activePathway.daysMargin}d buffer)
              </span>
            </div>
            <div className="w-full h-8 rounded-[8px] bg-[#E6E2D9] overflow-hidden flex relative p-[2px] gap-[2px]">
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
                    className={`${hopColors[idx % hopColors.length]} h-full rounded-[5px] flex items-center justify-center text-[11.5px] font-mono-code font-medium text-white px-1.5 truncate tabular-nums`}
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
                <span className="font-medium text-[#1D2530]">
                  Historical fax loop (
                  <code className="font-mono-code text-[12.5px]">
                    {historicalTrapChain.caseChainId}
                  </code>
                  ) · {historicalTrapChain.hops.length} hops
                </span>
                <span className="font-mono-code font-medium text-[#B43E2F]">
                  {historicalTrapChain.totalWaitDays}d (+{historicalTrapChain.totalWaitDays - 45}d over)
                </span>
              </div>
              <div className="w-full h-8 rounded-[8px] bg-[#E6E2D9] overflow-hidden flex relative p-[2px] gap-[2px]">
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
                      className={`${trapColors[idx % trapColors.length]} h-full rounded-[5px] flex items-center justify-center text-[11.5px] font-mono-code font-medium text-white px-1.5 truncate tabular-nums`}
                    >
                      H{hop.hopSequence} · {hop.waitDays}d
                    </motion.div>
                  );
                })}
              </div>
              <p className="text-[13px] text-[#556070] leading-relaxed pt-0.5">
                Coordinator{' '}
                <code className="font-mono-code text-[12.5px] text-[#1D2530]">
                  {historicalTrapChain.hops[0]?.target.provider_id}
                </code>{' '}
                reports a{' '}
                <strong className="font-medium text-[#1D2530]">
                  {historicalTrapChain.hops[0]?.target.median_internal_wait_days}-day internal wait
                </strong>{' '}
                in flat tables, while downstream <code className="font-mono-code text-[12.5px]">paper_fax</code>{' '}
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
        <div className="mx-6 sm:mx-8 mt-6 p-4 rounded-[12px] bg-[rgba(143,91,30,0.08)] border border-[rgba(143,91,30,0.24)] flex items-start gap-3 text-[13.5px] text-[#1D2530]">
          <Bus className="w-4 h-4 text-[#8F5B1E] shrink-0 mt-1" />
          <div className="leading-relaxed">
            <strong className="font-medium">Zero-vehicle transport guardrail: </strong>
            {activePathway.transportAdvisory}
          </div>
        </div>
      )}

      {/* 3. Verified 4-Step CareNode Sequence — Equal height row, 2 levels max, ink chips */}
      <div className="p-6 sm:p-8 space-y-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="ts-h3 text-[16px]">
            Provider sequence.{' '}
            <span className="ts-muted">Four CareNodes from screening to therapy.</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {activePathway.steps.map((step, index) => {
            const isOrigin = index === 0;
            const roleLabel =
              step.node.node_role === 'Screening_Pediatric_Clinic'
                ? 'Origin clinic'
                : step.node.node_role === 'Part_C_Intake_Coordinator'
                  ? 'Hop 1 · Coordinator'
                  : step.node.node_role === 'Multidisciplinary_Eval_Hub'
                    ? 'Hop 2 · Eval hub'
                    : 'Hop 3 · EI therapy';

            return (
              <div
                key={`${step.stepNumber}-${step.node.provider_id}`}
                className="relative rounded-[12px] bg-[#F8F7F4] border border-[rgba(29,37,48,0.1)] p-4 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2.5 tabular-nums">
                    <span className="text-[12.5px] font-medium text-[#2C5877]">
                      {roleLabel}
                    </span>
                    <span className="font-mono-code text-[12.5px] font-medium text-[#1D2530]">
                      Day {step.cumulativeDays}
                    </span>
                  </div>

                  <div className="font-medium text-[15px] leading-snug text-[#1D2530]">
                    {cleanOrgName(step.node.synthetic_organization_name)}
                  </div>
                  <div className="font-mono-code text-[12px] text-[#556070] mt-0.5">
                    {step.node.provider_id}
                  </div>

                  <p className="text-[13px] text-[#556070] mt-2.5 leading-relaxed">
                    {step.handoffNote}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-[rgba(29,37,48,0.09)] space-y-2.5">
                  <div className="flex items-center justify-between text-[12.5px] text-[#556070] tabular-nums">
                    <span className="inline-flex items-center gap-1 truncate">
                      <MapPin className="w-3.5 h-3.5 text-[#556070] shrink-0" />
                      <span>
                        {step.node.city} ({step.distanceFromHomeKm} km)
                      </span>
                    </span>
                    {isOrigin ? (
                      <span className="font-mono-code text-[12px]">Day 0</span>
                    ) : (
                      <span className="font-mono-code font-medium text-[#2C5877]">
                        +{step.expectedStepWaitDays}d
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {step.channelIn && channelChip(step.channelIn)}
                    {step.node.accepts_medicaid && (
                      <span className="ts-chip">Medicaid</span>
                    )}
                    {step.node.bilingual_services_listed && (
                      <span className="ts-chip">Bilingual</span>
                    )}
                    {step.node.part_c_vendor_enrolled && (
                      <span className="ts-chip">Part C</span>
                    )}
                  </div>
                </div>

                {index < activePathway.steps.length - 1 && (
                  <div
                    aria-hidden="true"
                    className="hidden xl:flex absolute -right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white text-[#1D2530] border border-[rgba(29,37,48,0.18)] items-center justify-center z-10"
                  >
                    <ArrowRight className="w-3 h-3" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Alternative Compliant Pathways — Linked card lift (-2px on hover, motion.md) */}
        {allOptions.length > 1 && (
          <div className="pt-5 border-t border-[rgba(29,37,48,0.1)] no-print space-y-2.5">
            <div className="ts-label">
              Compare compliant routes ({allOptions.length})
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
                    onPointerDown={() => {
                      if (!selected) {
                        triggerCausalHaptic(4);
                        onSelectPathway(opt.id);
                      }
                    }}
                    onClick={() => onSelectPathway(opt.id)}
                    className={`ts-card-lift px-3.5 py-2.5 rounded-[10px] text-[13px] cursor-pointer tabular-nums border text-left ${
                      selected
                        ? 'bg-[rgba(44,88,119,0.08)] border-[#2C5877] text-[#1D2530] font-medium'
                        : 'bg-white border-[rgba(29,37,48,0.14)] text-[#556070] hover:text-[#1D2530]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono-code font-medium text-[#2C5877]">
                        {opt.totalExpectedDays}d
                      </span>
                      <span aria-hidden="true" className="text-[#556070]">
                        ·
                      </span>
                      <span className="truncate max-w-[220px] text-[#1D2530]">
                        {cleanOrgName(opt.steps[2].node.synthetic_organization_name)}
                      </span>
                      <span className="font-mono-code text-[12px] text-[#556070]">
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
