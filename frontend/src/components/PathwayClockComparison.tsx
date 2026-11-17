import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  AlertOctagon,
  ArrowRight,
  Bus,
  CheckCircle2,
  Clock,
  FileWarning,
  Laptop,
  MapPin,
  Phone,
  ShieldAlert,
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

function channelBadge(channel?: TransmissionChannel) {
  if (!channel) return null;
  if (channel === 'ehr_electronic_portal') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/12 text-emerald-900 text-[10.5px] font-semibold">
        <Laptop className="w-2.5 h-2.5" />
        e-Portal
      </span>
    );
  }
  if (channel === 'paper_fax') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/12 text-rose-900 text-[10.5px] font-semibold">
        <FileWarning className="w-2.5 h-2.5" />
        Paper Fax
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/14 text-amber-900 text-[10.5px] font-semibold">
      <Phone className="w-2.5 h-2.5" />
      Voicemail
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
  const barSpring = reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_DEFAULT;

  const allOptions = activePathway
    ? [
        activePathway,
        ...alternatives.filter((a) => a.id !== activePathway.id),
      ]
    : alternatives;

  if (!activePathway) {
    return (
      <section className="apple-card p-6">
        <div className="flex items-start gap-3.5">
          <div className="w-10 h-10 rounded-full bg-rose-500/12 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5 text-rose-600" />
          </div>
          <div>
            <h2 className="apple-title text-lg font-semibold text-[#1D1D1F]">
              Escalation Required: No Standard Local Route Clears 45 Days
            </h2>
            <p className="text-sm text-[#515154] mt-1">
              No in-state provider sequence cleared all selected filters under 45 days. Authorize
              regional Part C mobile bilingual evaluation or toggle{' '}
              <strong>Simulate e-Referral Fix</strong>.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const hopColors = ['bg-[#14B8A6]', 'bg-[#0D9488]', 'bg-[#0F766E]'];
  const trapColors = ['bg-[#F59E0B]', 'bg-[#F97316]', 'bg-[#F43F5E]', 'bg-[#E11D48]'];

  return (
    <section className="apple-card overflow-hidden">
      {/* Apple High-Clarity Hero Summary */}
      <div className="p-6 sm:p-7 border-b border-black/[0.06]">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="space-y-2 max-w-3xl">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-[#0F766E]">
              <CheckCircle2 className="w-4 h-4 text-[#0D9488]" />
              <span>
                Recommended Provider Path · {tract.county_name} (Tract{' '}
                <code className="font-mono-code text-[#1D1D1F]">
                  {tract.census_tract_geoid}
                </code>
                )
              </span>
            </div>

            <h2 className="apple-display text-[26px] sm:text-[31px] font-bold text-[#1D1D1F] tabular-nums">
              {activePathway.clears45DayClock ? (
                <>
                  Clears the 45-day clock in{' '}
                  <span className="text-[#0D9488]">
                    {activePathway.totalExpectedDays} days
                  </span>
                </>
              ) : (
                <>
                  Fastest eligible route:{' '}
                  <span className="text-amber-600">
                    {activePathway.totalExpectedDays} days
                  </span>
                </>
              )}
            </h2>

            <p className="text-[14px] text-[#515154] leading-relaxed">
              For today&apos;s <strong className="text-[#1D1D1F]">{intake.childAgeMonths}-month-old</strong>{' '}
              needing{' '}
              <strong className="text-[#1D1D1F]">
                {intake.primaryLanguage !== 'English'
                  ? `${intake.primaryLanguage} bilingual`
                  : 'standard'}{' '}
                developmental evaluation
              </strong>{' '}
              {intake.insuranceMedicaid ? 'under Medicaid' : ''}: routes electronically via{' '}
              <strong className="text-[#1D1D1F]">
                {cleanOrgName(activePathway.steps[1].node.synthetic_organization_name)}
              </strong>{' '}
              into{' '}
              <strong className="text-[#1D1D1F]">
                {cleanOrgName(activePathway.steps[2].node.synthetic_organization_name)}
              </strong>{' '}
              (<span className="tabular-nums">{activePathway.evalHubDistanceKm} km</span> away).
            </p>
          </div>

          {/* Crisp Tabular KPI Readout */}
          <div className="apple-well px-4 py-3 flex items-center gap-4 shrink-0 tabular-nums">
            <div className="text-right">
              <div className="apple-eyebrow text-[10px] font-semibold text-[#86868B]">
                Expected Total
              </div>
              <div className="apple-display text-[26px] font-bold text-[#0F766E] mt-0.5">
                {activePathway.totalExpectedDays}d{' '}
                <span className="text-xs font-medium text-[#86868B]">/ 45d</span>
              </div>
            </div>
            {historicalTrapChain && (
              <div className="border-l border-black/[0.08] pl-4 text-right">
                <div className="apple-eyebrow text-[10px] font-semibold text-[#86868B]">
                  Days Saved
                </div>
                <div className="apple-display text-[26px] font-bold text-[#1D1D1F] mt-0.5">
                  -{Math.max(0, historicalTrapChain.totalWaitDays - activePathway.totalExpectedDays)}d
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Spring-Animated 45-Day Statutory Clock Comparison */}
      <div className="px-6 sm:px-7 py-5 bg-[#FAFAFC] border-b border-black/[0.06] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="apple-eyebrow text-[11px] font-bold text-[#515154] flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-[#0D9488]" />
            45-Day Federal Clock (Day 0 Referral &rarr; Initial IFSP)
          </h3>
          <div className="flex items-center gap-4 text-[11.5px] text-[#515154]">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#0D9488] inline-block" />
              Graph-Verified &le;45d Path
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-[#E11D48] inline-block" />
              Paper-Fax Bounce (&gt;45d Breach)
            </span>
          </div>
        </div>

        <div className="relative pt-3 pb-1 space-y-4">
          {/* Vertical Day 45 Statutory Ceiling */}
          <div
            style={{ left: `${FEDERAL_LIMIT_PCT}%` }}
            className="absolute top-0 bottom-0 border-l-[1.5px] border-dashed border-rose-500 z-10 pointer-events-none"
          >
            <span className="absolute -top-1 -translate-x-1/2 whitespace-nowrap px-2.5 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-semibold shadow-xs tabular-nums">
              Day 45 Limit
            </span>
          </div>

          {/* Row 1: Recommended Pathway */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs tabular-nums">
              <span className="font-semibold text-[#1D1D1F]">
                Recommended 3-Hop Electronic Bilingual Route
              </span>
              <span className="font-mono-code font-semibold text-[#0F766E]">
                {activePathway.totalExpectedDays}d ({activePathway.daysMargin}d buffer)
              </span>
            </div>
            <div className="w-full h-8 rounded-[10px] bg-[#E8E8ED] overflow-hidden flex relative p-[2px] gap-[2px]">
              {activePathway.steps.slice(1).map((step, idx) => {
                const widthPct = Math.min(
                  100,
                  (step.expectedStepWaitDays / MAX_TIMELINE_DAYS) * 100
                );
                return (
                  <motion.div
                    key={`hop-slot-${step.stepNumber}`}
                    animate={{ width: `${widthPct}%` }}
                    transition={barSpring}
                    title={`Hop ${step.stepNumber}: ${cleanOrgName(step.node.synthetic_organization_name)} (+${step.expectedStepWaitDays}d)`}
                    className={`${hopColors[idx % hopColors.length]} h-full rounded-[7px] flex items-center justify-center text-[11px] font-mono-code font-semibold text-white px-1.5 truncate tabular-nums`}
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
              <div className="flex flex-wrap items-center justify-between text-xs gap-1 tabular-nums">
                <span className="font-semibold text-[#1D1D1F] flex items-center gap-1.5">
                  <AlertOctagon className="w-3.5 h-3.5 text-rose-600" />
                  Historical Bounce (<code className="font-mono-code">{historicalTrapChain.caseChainId}</code>
                  ) · {historicalTrapChain.hops.length}-Hop Fax Re-Referral Loop
                </span>
                <span className="font-mono-code font-semibold text-rose-600">
                  {historicalTrapChain.totalWaitDays}d (+{historicalTrapChain.totalWaitDays - 45}d over)
                </span>
              </div>
              <div className="w-full h-8 rounded-[10px] bg-[#E8E8ED] overflow-hidden flex relative p-[2px] gap-[2px]">
                {historicalTrapChain.hops.map((hop, idx) => {
                  const widthPct = Math.min(
                    100,
                    (hop.waitDays / MAX_TIMELINE_DAYS) * 100
                  );
                  return (
                    <motion.div
                      key={`trap-slot-${hop.hopSequence}`}
                      animate={{ width: `${widthPct}%` }}
                      transition={barSpring}
                      title={`Hop ${hop.hopSequence} (${hop.channel}): ${cleanOrgName(hop.target.synthetic_organization_name)} (+${hop.waitDays}d) — ${hop.reason}`}
                      className={`${trapColors[idx % trapColors.length]} h-full rounded-[7px] flex items-center justify-center text-[11px] font-mono-code font-semibold text-white px-1.5 truncate tabular-nums`}
                    >
                      H{hop.hopSequence} · {hop.waitDays}d
                    </motion.div>
                  );
                })}
              </div>
              <p className="text-[11.5px] text-[#515154]">
                Why flat waitlist SQL missed it: coordinator{' '}
                <code className="font-mono-code font-semibold text-[#1D1D1F]">
                  {historicalTrapChain.hops[0]?.target.provider_id}
                </code>{' '}
                shows just{' '}
                <strong className="text-[#1D1D1F]">
                  {historicalTrapChain.hops[0]?.target.median_internal_wait_days}d internal wait
                </strong>
                , yet its <code className="font-mono-code">paper_fax</code> handoffs triggered{' '}
                <em>
                  &ldquo;
                  {historicalTrapChain.hops.find((h) => h.reason.startsWith('Re-Referral'))
                    ?.reason ?? 'multi-hop re-referral delay'}
                  &rdquo;
                </em>
                .
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Zero-Vehicle Travel Guardrail */}
      {activePathway.transportAdvisory && (
        <div className="mx-6 sm:mx-7 mt-5 p-3.5 rounded-[14px] bg-amber-500/10 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.28)] flex items-start gap-2.5 text-xs text-amber-950">
          <Bus className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <span className="font-semibold">Zero-Vehicle Travel Guardrail: </span>
            {activePathway.transportAdvisory}
          </div>
        </div>
      )}

      {/* 4-Step Provider Sequence Cards */}
      <div className="p-6 sm:p-7 space-y-5">
        <div className="apple-eyebrow text-[10.5px] font-bold text-[#86868B]">
          Verified Provider Sequence (100% [Synthetic] CareNodes)
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3.5">
          {activePathway.steps.map((step, index) => {
            const isOrigin = index === 0;
            const roleLabel =
              step.node.node_role === 'Screening_Pediatric_Clinic'
                ? 'Origin Clinic'
                : step.node.node_role === 'Part_C_Intake_Coordinator'
                  ? 'Hop 1 · Coordinator'
                  : step.node.node_role === 'Multidisciplinary_Eval_Hub'
                    ? 'Hop 2 · Bilingual Eval'
                    : 'Hop 3 · EI Therapy';

            return (
              <div
                key={`${step.stepNumber}-${step.node.provider_id}`}
                className="relative rounded-[16px] bg-[#FAFAFC] p-4 flex flex-col justify-between shadow-[inset_0_0_0_0.5px_rgba(15,23,42,0.08)]"
              >
                <div>
                  <div className="flex items-center justify-between gap-1 mb-2 tabular-nums">
                    <span className="apple-eyebrow text-[9.5px] font-bold px-2 py-0.5 rounded-full bg-[#0D9488]/12 text-[#0F766E]">
                      {roleLabel}
                    </span>
                    <span className="font-mono-code text-xs font-semibold text-[#1D1D1F]">
                      Day {step.cumulativeDays}
                    </span>
                  </div>

                  <div className="apple-subhead font-semibold text-[14px] text-[#1D1D1F]">
                    {cleanOrgName(step.node.synthetic_organization_name)}
                  </div>
                  <div className="font-mono-code text-[11px] text-[#86868B] mt-0.5">
                    {step.node.provider_id}
                  </div>

                  <p className="text-[11.5px] text-[#515154] mt-2 leading-snug">
                    {step.handoffNote}
                  </p>
                </div>

                <div className="mt-3.5 pt-3 border-t border-black/[0.06] space-y-2">
                  <div className="flex items-center justify-between text-[11.5px] text-[#515154] tabular-nums">
                    <span className="inline-flex items-center gap-1 truncate">
                      <MapPin className="w-3 h-3 text-[#86868B] shrink-0" />
                      {step.node.city} ({step.distanceFromHomeKm} km)
                    </span>
                    {isOrigin ? (
                      <span className="text-[10.5px] text-[#86868B]">Start</span>
                    ) : (
                      <span className="font-mono-code font-semibold text-[#0F766E]">
                        +{step.expectedStepWaitDays}d
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1">
                    {step.channelIn && channelBadge(step.channelIn)}
                    {step.node.accepts_medicaid && (
                      <span className="px-2 py-0.5 rounded-full bg-sky-500/12 text-sky-900 text-[10px] font-semibold">
                        Medicaid
                      </span>
                    )}
                    {step.node.bilingual_services_listed && (
                      <span className="px-2 py-0.5 rounded-full bg-indigo-500/12 text-indigo-900 text-[10px] font-semibold">
                        Bilingual
                      </span>
                    )}
                    {step.node.part_c_vendor_enrolled && (
                      <span className="px-2 py-0.5 rounded-full bg-black/[0.05] text-[#515154] text-[10px] font-semibold">
                        Part C
                      </span>
                    )}
                  </div>
                </div>

                {index < activePathway.steps.length - 1 && (
                  <div className="hidden xl:flex absolute -right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white text-[#0D9488] shadow-[0_1px_4px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.08)] items-center justify-center z-10">
                    <ArrowRight className="w-3 h-3" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Fluid Candidate Pathway Switcher */}
        {allOptions.length > 1 && (
          <div className="pt-4 border-t border-black/[0.06] no-print space-y-2">
            <div className="text-xs font-semibold text-[#515154]">
              Alternative Compliant Pathways ({allOptions.length} routes)
            </div>
            <div className="flex flex-wrap gap-2">
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
                        triggerCausalHaptic(5);
                        onSelectPathway(opt.id);
                      }
                    }}
                    onClick={() => onSelectPathway(opt.id)}
                    className={`apple-pressable relative px-3.5 py-2 rounded-[12px] text-xs cursor-pointer tabular-nums ${
                      selected
                        ? 'text-[#0F766E] font-semibold'
                        : 'bg-[#F5F5F8] text-[#515154] hover:text-[#1D1D1F]'
                    }`}
                  >
                    {selected && (
                      <motion.span
                        layoutId="candidate-route-pill"
                        transition={barSpring}
                        className="absolute inset-0 rounded-[12px] bg-[#0D9488]/12 shadow-[inset_0_0_0_1.5px_rgba(13,148,136,0.45)]"
                      />
                    )}
                    <span className="relative flex items-center gap-2">
                      <span className="font-mono-code font-bold">
                        {opt.totalExpectedDays}d
                      </span>
                      <span className="text-[#86868B]">·</span>
                      <span className="truncate max-w-[220px]">
                        {cleanOrgName(opt.steps[2].node.synthetic_organization_name)}
                      </span>
                      <span className="text-[11px] text-[#86868B]">
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
