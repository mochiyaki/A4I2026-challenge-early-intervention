import React, { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Check,
  ChevronDown,
  Mic,
  PlugZap,
  Printer,
  ShieldCheck,
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
    <header className="ts-nav">
      <div className="ts-wrap min-h-[68px] py-3 flex flex-wrap items-center justify-between gap-4">
        <a href="#main-workspace" className="ts-skip-link">
          Skip to content
        </a>

        {/* Left: Architectural Mark + Plain Category Title (system.md §Nav & copy.md §1) */}
        <div className="flex items-center gap-3.5 min-w-0">
          <span
            aria-hidden="true"
            className="w-8 h-8 rounded-[8px] bg-[#1D2530] text-[#F3F1EC] flex items-center justify-center shrink-0"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="3.5" cy="8" r="2" fill="currentColor" />
              <circle cx="12.5" cy="4" r="2" fill="currentColor" />
              <circle cx="12.5" cy="12" r="2" fill="currentColor" />
              <path
                d="M5.2 7.2L10.8 4.8M5.2 8.8L10.8 11.2"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </span>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-medium text-[18px] tracking-[-0.025em] text-[#1D2530]">
                First Milestones
              </span>
              <span className="text-[#556070] hidden md:inline" aria-hidden="true">
                /
              </span>
              <span className="text-[14px] text-[#556070] hidden md:inline">
                Part C 45-day referral triage
              </span>

              {/* Calm Neutral Provenance Trigger */}
              <div className="relative">
                <button
                  type="button"
                  aria-expanded={showGuardrails}
                  onClick={() => setShowGuardrails((v) => !v)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12.5px] font-medium bg-[#E6E2D9] text-[#1D2530] border border-[rgba(29,37,48,0.14)] hover:border-[rgba(29,37,48,0.3)] cursor-pointer transition-colors"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-[#2C5877]" />
                  <span>100% [Synthetic] providers</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-[#556070] transition-transform duration-150 ${
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
                          : { opacity: 0, y: -6 }
                      }
                      animate={{ opacity: 1, y: 0 }}
                      exit={
                        reducedMotion
                          ? { opacity: 0 }
                          : { opacity: 0, y: -4 }
                      }
                      transition={
                        reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SHEET
                      }
                      className="absolute left-0 mt-2 w-[340px] sm:w-[420px] rounded-[14px] bg-white p-5 border border-[rgba(29,37,48,0.18)] shadow-[0_18px_40px_-14px_rgba(29,37,48,0.18)] z-50 space-y-3 text-[13.5px] text-[#1D2530]"
                    >
                      <div className="font-medium text-[15px] text-[#1D2530]">
                        Dataset provenance and integrity checks
                      </div>
                      <p className="text-[#556070] leading-relaxed">
                        Every <code className="font-mono-code text-[12.5px] text-[#1D2530]">SYN-PROV-*</code>{' '}
                        clinic, <code className="font-mono-code text-[12.5px] text-[#1D2530]">SYN-PARTC-*</code>{' '}
                        agency, and referral edge is 100% synthetic so simulated waitlists never implicate real clinicians. Neighborhood under-5 counts come from US Census ACS.
                      </p>
                      <div className="space-y-2 pt-2.5 border-t border-[rgba(29,37,48,0.1)] text-[13px]">
                        <div className="flex items-start gap-2 text-[#1D2530]">
                          <Check className="w-4 h-4 text-[#2C5877] shrink-0 mt-0.5" />
                          <span>
                            All-zero ACS <code className="font-mono-code text-[12px]">limited_english_rate</code>{' '}
                            excluded ({zeroLepRatio} rows verified)
                          </span>
                        </div>
                        <div className="flex items-start gap-2 text-[#1D2530]">
                          <Check className="w-4 h-4 text-[#2C5877] shrink-0 mt-0.5" />
                          <span>
                            HRSA NSCH ({nschStrataCount} statewide strata) isolated from tract joins
                          </span>
                        </div>
                        {leadingZeroIntact && (
                          <div className="flex items-start gap-2 text-[#1D2530]">
                            <Check className="w-4 h-4 text-[#2C5877] shrink-0 mt-0.5" />
                            <span>
                              <code className="font-mono-code text-[12px]">audit_*</code> shares excluded from ranking; 11-digit FIPS strings preserved
                            </span>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Single-System Controls — One Primary Button, Clean Secondary Pair */}
        <div className="flex flex-wrap items-center gap-2.5 no-print">
          <FluidSegmentedControl<'simple' | 'full'>
            layoutId="workspace-density-mode"
            ariaLabel="Workspace detail level"
            size="sm"
            options={[
              { value: 'simple', label: 'Focused triage' },
              { value: 'full', label: 'Graph & audit' },
            ]}
            value={viewMode}
            onChange={onViewModeChange}
          />

          <button
            type="button"
            onClick={onOpenAgentModal}
            className="ts-btn ts-btn-secondary"
          >
            <PlugZap className="w-3.5 h-3.5 text-[#2C5877]" />
            <span>{agentEndpoint ? 'ADK connected' : 'Connect ADK'}</span>
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="ts-btn ts-btn-secondary hidden sm:inline-flex"
          >
            <Printer className="w-3.5 h-3.5 text-[#556070]" />
            <span>Print brief</span>
          </button>

          <button
            type="button"
            onClick={() => {
              triggerCausalHaptic(6);
              onTriggerVoiceAsk();
            }}
            className="ts-btn ts-btn-primary"
          >
            <Mic className="w-3.5 h-3.5" />
            <span>Ask by voice</span>
          </button>
        </div>
      </div>
    </header>
  );
};
