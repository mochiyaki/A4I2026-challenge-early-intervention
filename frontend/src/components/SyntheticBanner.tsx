import React, { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  CheckCircle2,
  ChevronDown,
  Mic,
  PlugZap,
  Printer,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  REDUCED_MOTION_TRANSITION,
  SPRING_SHEET,
  triggerCausalHaptic,
} from '../utils/applePhysics';
import { FluidSegmentedControl } from './FluidControls';

interface SyntheticBannerProps {
  zeroLepRatio: string;
  nschStrataCount: number;
  leadingZeroIntact: boolean;
  agentEndpoint: string;
  viewMode: 'simple' | 'full';
  onViewModeChange: (mode: 'simple' | 'full') => void;
  onTriggerVoiceAsk: () => void;
  onOpenAgentModal: () => void;
}

export const SyntheticBanner: React.FC<SyntheticBannerProps> = ({
  zeroLepRatio,
  nschStrataCount,
  leadingZeroIntact,
  agentEndpoint,
  viewMode,
  onViewModeChange,
  onTriggerVoiceAsk,
  onOpenAgentModal,
}) => {
  const [showGuardrails, setShowGuardrails] = useState(false);
  const reducedMotion = useReducedMotion();

  return (
    <header className="sticky top-0 z-30 apple-chrome-glass">
      <div className="max-w-[1640px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        {/* Brand & Context */}
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="w-9 h-9 rounded-[11px] bg-gradient-to-b from-[#14B8A6] to-[#0F766E] text-white flex items-center justify-center font-semibold text-sm tracking-tight shadow-[0_2px_6px_rgba(13,148,136,0.32),inset_0_1px_0_rgba(255,255,255,0.28)] shrink-0">
            FM
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="apple-title text-[16px] sm:text-[17px] font-semibold text-[#1D1D1F] truncate">
                First Milestones
              </h1>
              <span className="text-[#86868B] hidden md:inline">·</span>
              <span className="text-xs font-medium text-[#515154] hidden md:inline">
                45-Day Pathway Triage
              </span>

              {/* Anchored Provenance Pill + Popover Trigger */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowGuardrails((v) => !v)}
                  className="apple-pressable inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/14 text-amber-950 border border-amber-500/25 cursor-pointer"
                >
                  <ShieldAlert className="w-3 h-3 text-amber-700" />
                  <span>100% [Synthetic] Network</span>
                  <ChevronDown
                    className={`w-3 h-3 text-amber-800 transition-transform duration-200 ${
                      showGuardrails ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                <AnimatePresence>
                  {showGuardrails && (
                    <motion.div
                      initial={
                        reducedMotion
                          ? { opacity: 0 }
                          : { opacity: 0, scale: 0.94, y: -4 }
                      }
                      animate={
                        reducedMotion
                          ? { opacity: 1 }
                          : { opacity: 1, scale: 1, y: 0 }
                      }
                      exit={
                        reducedMotion
                          ? { opacity: 0 }
                          : { opacity: 0, scale: 0.95, y: -4 }
                      }
                      transition={
                        reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SHEET
                      }
                      style={{ transformOrigin: 'top left' }}
                      className="absolute left-0 mt-2 w-[340px] sm:w-[410px] rounded-[18px] bg-white p-4 shadow-[0_18px_44px_rgba(15,23,42,0.16),0_0_0_0.5px_rgba(15,23,42,0.09)] z-50 space-y-2.5 text-xs text-[#1D1D1F]"
                    >
                      <div className="font-semibold text-[13px]">
                        Data Provenance &amp; Validation Guardrails
                      </div>
                      <p className="text-[#515154] leading-relaxed">
                        Every <code className="font-mono-code">SYN-PROV-*</code> provider,{' '}
                        <code className="font-mono-code">SYN-PARTC-*</code> agency, and referral
                        handoff is <strong>100% [Synthetic]</strong> so simulated waitlists or
                        45-day breaches never touch real clinicians. Under-5 demographics are{' '}
                        <strong>real US Census ACS</strong> counts.
                      </p>
                      <div className="space-y-1.5 pt-1 border-t border-slate-100 text-[11.5px]">
                        <div className="flex items-center gap-2 text-[#1D1D1F]">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span>
                            ACS <code className="font-mono-code">limited_english_rate=0.0</code>{' '}
                            trap caught ({zeroLepRatio} rows)
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[#1D1D1F]">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span>
                            HRSA NSCH ({nschStrataCount} Statewide strata) isolated — zero 6× fan-out
                          </span>
                        </div>
                        {leadingZeroIntact && (
                          <div className="flex items-center gap-2 text-[#1D1D1F]">
                            <ShieldCheck className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                            <span>
                              <code className="font-mono-code">audit_*</code> excluded from routing;
                              11-char FIPS intact
                            </span>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
            <p className="text-[11.5px] text-[#515154] truncate">
              <span className="font-medium text-[#1D1D1F]">34 CFR § 303.310</span> · Ask by voice
              or chat on the right, or explore multi-hop{' '}
              <code className="font-mono-code">ReferralGraph</code> paths
            </p>
          </div>
        </div>

        {/* Right Utility Actions */}
        <div className="flex flex-wrap items-center gap-2 no-print">
          {/* Simple View vs Full Analytics Toggle */}
          <FluidSegmentedControl<'simple' | 'full'>
            layoutId="workspace-density-mode"
            size="sm"
            options={[
              { value: 'simple', label: 'Focused View' },
              { value: 'full', label: 'Full Charts & SQL' },
            ]}
            value={viewMode}
            onChange={onViewModeChange}
          />

          {/* Quick Voice Ask Trigger */}
          <button
            type="button"
            onClick={() => {
              triggerCausalHaptic(7);
              onTriggerVoiceAsk();
            }}
            className="apple-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-[#0D9488] text-white hover:bg-[#0F766E] cursor-pointer shadow-[0_2px_6px_rgba(13,148,136,0.28)]"
          >
            <Mic className="w-3.5 h-3.5" />
            <span>Voice Ask</span>
          </button>

          <button
            type="button"
            onClick={onOpenAgentModal}
            className={`apple-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer ${
              agentEndpoint
                ? 'bg-emerald-500/14 text-emerald-900 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.28)]'
                : 'bg-white text-[#1D1D1F] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_0.5px_rgba(15,23,42,0.12)] hover:bg-slate-50'
            }`}
          >
            {agentEndpoint ? (
              <>
                <PlugZap className="w-3.5 h-3.5 text-emerald-600" />
                <span>ADK Live</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5 text-[#0D9488]" />
                <span className="hidden sm:inline">Connect ADK</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="apple-pressable hidden sm:inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-[#1D1D1F] text-white hover:bg-black cursor-pointer shadow-[0_2px_6px_rgba(0,0,0,0.14)]"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Export</span>
          </button>
        </div>
      </div>
    </header>
  );
};
