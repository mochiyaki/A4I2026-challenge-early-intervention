import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Check,
  ChevronDown,
  Mic,
  Moon,
  PlugZap,
  Printer,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import {
  EXIT_FAST_TRANSITION,
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
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
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
  theme,
  onToggleTheme,
  onTriggerVoiceAsk,
  onOpenAgentModal,
}) => {
  const [showGuardrails, setShowGuardrails] = useState(false);
  const popoverWrapRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();

  /* Escape route + outside-click dismissal (ui-ux-pro-max escape-routes) */
  useEffect(() => {
    if (!showGuardrails) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowGuardrails(false);
    };
    const handlePointerDown = (e: MouseEvent) => {
      if (
        popoverWrapRef.current &&
        !popoverWrapRef.current.contains(e.target as Node)
      ) {
        setShowGuardrails(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [showGuardrails]);

  return (
    <header className="pm-nav">
      <div className="pm-wrap min-h-[70px] py-3 flex flex-wrap items-center justify-between gap-3.5">
        <a href="#main-workspace" className="pm-skip-link">
          Skip to main workspace
        </a>

        {/* Left: Clinical Swiss Emblem + Product Identity + Provenance Disclosure */}
        <div className="flex items-center gap-3.5 min-w-0">
          <span
            aria-hidden="true"
            className="w-9 h-9 rounded-[10px] bg-[var(--pm-cta-bg)] text-white flex items-center justify-center shrink-0 shadow-xs"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <circle cx="3.2" cy="8" r="2" fill="currentColor" />
              <circle cx="12.8" cy="3.8" r="2" fill="currentColor" />
              <circle cx="12.8" cy="12.2" r="2" fill="currentColor" />
              <path
                d="M5 7.2L11 4.6M5 8.8L11 11.4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </span>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="pm-h3 text-[18px] tracking-[-0.025em]">
                First Milestones
              </span>
              <span
                className="text-[var(--pm-border-strong)] hidden lg:inline"
                aria-hidden="true"
              >
                |
              </span>
              <span className="text-[13.5px] text-[var(--pm-muted)] hidden lg:inline">
                IDEA Part C 45-Day Clinical Triage
              </span>

              {/* Verified Provenance & Guardrails Disclosure */}
              <div ref={popoverWrapRef} className="relative">
                <button
                  type="button"
                  aria-expanded={showGuardrails}
                  aria-haspopup="dialog"
                  onClick={() => setShowGuardrails((v) => !v)}
                  className="inline-flex items-center gap-1.5 min-h-[34px] px-2.5 py-1 rounded-[7px] text-[12px] font-semibold bg-[var(--pm-compliant-soft)] text-[var(--pm-compliant)] border border-[var(--pm-compliant-border)] hover:opacity-90 cursor-pointer touch-manipulation transition-opacity"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  <ShieldCheck aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>100% [Synthetic] CareNodes</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={`w-3.5 h-3.5 transition-transform duration-150 ${
                      showGuardrails ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                <AnimatePresence>
                  {showGuardrails && (
                    <motion.div
                      role="dialog"
                      aria-label="Dataset provenance and fairness guardrails"
                      initial={
                        reducedMotion
                          ? { opacity: 0 }
                          : { opacity: 0, y: -6 }
                      }
                      animate={{ opacity: 1, y: 0 }}
                      exit={
                        reducedMotion
                          ? { opacity: 0, transition: REDUCED_MOTION_TRANSITION }
                          : { opacity: 0, y: -4, transition: EXIT_FAST_TRANSITION }
                      }
                      transition={
                        reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SHEET
                      }
                      className="absolute left-0 mt-2 w-[320px] sm:w-[420px] rounded-[14px] bg-[var(--pm-card)] p-5 border border-[var(--pm-border-strong)] shadow-[var(--pm-shadow-pop)] z-50 space-y-3 text-[13.5px] text-[var(--pm-text)]"
                    >
                      <div className="pm-h3 text-[15px]">
                        Dataset provenance &amp; integrity guardrails
                      </div>
                      <p className="text-[var(--pm-muted)] leading-relaxed">
                        Every{' '}
                        <code className="font-mono-code text-[12px] text-[var(--pm-ink)]">
                          SYN-PROV-*
                        </code>{' '}
                        clinic,{' '}
                        <code className="font-mono-code text-[12px] text-[var(--pm-ink)]">
                          SYN-PARTC-*
                        </code>{' '}
                        agency, and multi-hop referral edge is 100% synthetic so simulated waitlists never implicate real clinicians. Tract demographics come from US Census ACS.
                      </p>
                      <div className="space-y-2 pt-2.5 border-t border-[var(--pm-border)] text-[13px]">
                        <div className="flex items-start gap-2 text-[var(--pm-ink)]">
                          <Check
                            aria-hidden="true"
                            className="w-4 h-4 text-[var(--pm-compliant)] shrink-0 mt-0.5"
                          />
                          <span>
                            All-zero ACS{' '}
                            <code className="font-mono-code text-[12px]">
                              limited_english_rate
                            </code>{' '}
                            excluded ({zeroLepRatio} rows verified)
                          </span>
                        </div>
                        <div className="flex items-start gap-2 text-[var(--pm-ink)]">
                          <Check
                            aria-hidden="true"
                            className="w-4 h-4 text-[var(--pm-compliant)] shrink-0 mt-0.5"
                          />
                          <span>
                            HRSA NSCH ({nschStrataCount} statewide strata) isolated from census tract joins
                          </span>
                        </div>
                        {leadingZeroIntact && (
                          <div className="flex items-start gap-2 text-[var(--pm-ink)]">
                            <Check
                              aria-hidden="true"
                              className="w-4 h-4 text-[var(--pm-compliant)] shrink-0 mt-0.5"
                            />
                            <span>
                              <code className="font-mono-code text-[12px]">
                                audit_*
                              </code>{' '}
                              shares excluded from ranking; 11-digit FIPS strings preserved
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

        {/* Right: Workspace Density Switch + Light/Dark Theme + Secondary Actions + Primary Voice CTA */}
        <div className="flex flex-wrap items-center gap-2 no-print">
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
            onClick={() => {
              triggerCausalHaptic(4);
              onToggleTheme();
            }}
            aria-label={
              theme === 'dark'
                ? 'Switch to clinical light theme'
                : 'Switch to clinical dark theme'
            }
            aria-pressed={theme === 'dark'}
            title={
              theme === 'dark'
                ? 'Switch to light mode'
                : 'Switch to dark mode'
            }
            className="pm-btn pm-btn-secondary pm-btn-compact px-2.5"
          >
            {theme === 'dark' ? (
              <Sun aria-hidden="true" className="w-4 h-4 text-[var(--pm-warning)]" />
            ) : (
              <Moon aria-hidden="true" className="w-4 h-4 text-[var(--pm-muted)]" />
            )}
            <span className="hidden xl:inline">
              {theme === 'dark' ? 'Light' : 'Dark'}
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenAgentModal}
            className="pm-btn pm-btn-secondary pm-btn-compact"
          >
            <PlugZap
              aria-hidden="true"
              className={`w-3.5 h-3.5 ${
                agentEndpoint
                  ? 'text-[var(--pm-compliant)]'
                  : 'text-[var(--pm-accent)]'
              }`}
            />
            <span>{agentEndpoint ? 'ADK live' : 'Connect ADK'}</span>
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="pm-btn pm-btn-secondary pm-btn-compact hidden md:inline-flex"
          >
            <Printer aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-muted)]" />
            <span>Print brief</span>
          </button>

          <button
            type="button"
            onClick={() => {
              triggerCausalHaptic(6);
              onTriggerVoiceAsk();
            }}
            className="pm-btn pm-btn-primary pm-btn-compact"
          >
            <Mic aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Voice triage</span>
          </button>
        </div>
      </div>
    </header>
  );
};
