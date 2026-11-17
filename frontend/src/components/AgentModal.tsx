import React, { useEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'motion/react';
import { AlertCircle, PlugZap, X } from 'lucide-react';
import {
  EXIT_FAST_TRANSITION,
  PointerVelocityTracker,
  projectMomentum,
  REDUCED_MOTION_TRANSITION,
  rubberband,
  SPRING_SHEET,
  triggerCausalHaptic,
} from '../utils/applePhysics';

interface AgentModalProps {
  open: boolean;
  currentUrl: string;
  onSave: (url: string) => void;
  onClose: () => void;
}

function validateEndpointUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null; // Blank is valid (uses local ReferralGraph engine)
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Endpoint URL must start with https:// or http://.';
    }
    return null;
  } catch {
    return 'Enter a valid full URL (e.g., https://ei-triage-agent.example/api/triage) or leave blank for local mode.';
  }
}

export const AgentModal: React.FC<AgentModalProps> = ({
  open,
  currentUrl,
  onSave,
  onClose,
}) => {
  const reducedMotion = useReducedMotion();
  const [draft, setDraft] = useState(currentUrl);
  const [validationError, setValidationError] = useState<string | null>(null);
  const sheetY = useMotionValue(0);
  const scrimAlpha = useTransform(sheetY, [0, 280], [1, 0.25]);

  const grabOffsetRef = useRef(0);
  const draggingRef = useRef(false);
  const velocityRef = useRef(new PointerVelocityTracker());

  useEffect(() => {
    if (open) {
      setDraft(currentUrl);
      setValidationError(null);
      sheetY.set(0);
    }
  }, [open, currentUrl, sheetY]);

  /* Escape route dismissal (ui-ux-pro-max escape-routes) */
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reducedMotion) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    grabOffsetRef.current = e.clientY - sheetY.get();
    velocityRef.current.reset();
    velocityRef.current.record(e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    velocityRef.current.record(e.clientY);
    const rawDy = e.clientY - grabOffsetRef.current;
    if (rawDy < 0) {
      sheetY.set(rubberband(rawDy, 420, 0.4));
    } else {
      sheetY.set(rawDy);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);

    const currentY = sheetY.get();
    const releaseVelocity = velocityRef.current.getVelocityPxPerSec();
    const projectedY = currentY + projectMomentum(releaseVelocity, 0.996);

    if (projectedY > 150) {
      triggerCausalHaptic(6);
      animate(sheetY, 420, {
        duration: 0.16,
        ease: [0.4, 0, 1, 1],
      }).then(() => {
        onClose();
      });
    } else {
      animate(sheetY, 0, {
        duration: 0.2,
        ease: [0.16, 1, 0.3, 1],
      });
    }
  };

  const handleCommitSave = () => {
    const err = validateEndpointUrl(draft);
    if (err) {
      setValidationError(err);
      return;
    }
    triggerCausalHaptic(6);
    onSave(draft.trim());
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={
              reducedMotion ? REDUCED_MOTION_TRANSITION : { duration: 0.14 }
            }
            style={{ opacity: scrimAlpha }}
            onClick={onClose}
            className="fixed inset-0 bg-[#0B1120]/60"
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="adk-modal-title"
            initial={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.97, y: 14 }
            }
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={
              reducedMotion
                ? { opacity: 0, transition: REDUCED_MOTION_TRANSITION }
                : { opacity: 0, scale: 0.98, y: 10, transition: EXIT_FAST_TRANSITION }
            }
            transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SHEET}
            style={{ y: sheetY }}
            className="relative z-10 bg-[var(--pm-card)] text-[var(--pm-ink)] rounded-t-[18px] sm:rounded-[18px] max-w-lg w-full p-6 sm:p-7 border border-[var(--pm-border-strong)] shadow-[var(--pm-shadow-pop)] space-y-5"
          >
            <div
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => {
                draggingRef.current = false;
                animate(sheetY, 0, SPRING_SHEET);
              }}
              className="pt-0.5 pb-1 cursor-grab active:cursor-grabbing touch-none select-none"
            >
              <div className="w-10 h-1 rounded-full bg-[var(--pm-border-strong)] mx-auto mb-3.5 sm:hidden" />
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-[9px] bg-[var(--pm-cta-bg)] text-white flex items-center justify-center shrink-0">
                    <PlugZap aria-hidden="true" className="w-4 h-4" />
                  </div>
                  <h2 id="adk-modal-title" className="pm-h3 text-[18px]">
                    Connect ADK or Cloud Run endpoint
                  </h2>
                </div>
                <button
                  type="button"
                  aria-label="Close endpoint dialog"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={onClose}
                  className="w-9 h-9 rounded-[8px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border)] text-[var(--pm-muted)] hover:text-[var(--pm-ink)] flex items-center justify-center cursor-pointer touch-manipulation transition-colors"
                >
                  <X aria-hidden="true" className="w-4 h-4" />
                </button>
              </div>
            </div>

            <p className="text-[14px] text-[var(--pm-muted)] leading-relaxed">
              Enter your Python ADK or Cloud Run POST address to route live queries. When left blank, the workspace runs locally against the pre-staged six-state ReferralGraph datasets.
            </p>

            <div className="space-y-1.5">
              <label htmlFor="adk-endpoint-url" className="block pm-label">
                Agent POST endpoint URL
              </label>
              <input
                id="adk-endpoint-url"
                type="url"
                placeholder="https://ei-triage-agent.example/api/triage"
                value={draft}
                aria-invalid={Boolean(validationError)}
                aria-describedby={
                  validationError ? 'adk-endpoint-error' : 'adk-endpoint-help'
                }
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (validationError) {
                    setValidationError(validateEndpointUrl(e.target.value));
                  }
                }}
                onBlur={() => setValidationError(validateEndpointUrl(draft))}
                className="pm-input font-mono-code text-[13px]"
              />
              {validationError ? (
                <div
                  id="adk-endpoint-error"
                  role="alert"
                  className="flex items-start gap-1.5 text-[12.5px] text-[var(--pm-danger)] pt-0.5"
                >
                  <AlertCircle aria-hidden="true" className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{validationError}</span>
                </div>
              ) : (
                <p id="adk-endpoint-help" className="text-[12px] text-[var(--pm-muted)]">
                  Accepts HTTPS Cloud Run or localhost ADK endpoints. Press Esc to close without saving.
                </p>
              )}
            </div>

            <pre className="pm-stage-dark p-4 text-[12px] font-mono-code overflow-x-auto leading-relaxed m-0">
              {`{
  "prompt": "Route today's IDEA Part C referral...",
  "state_code": "MS",
  "child_home_tract_geoid": "28011950200",
  "child_age_months": 20,
  "accepts_medicaid": true,
  "bilingual_required": true,
  "primary_language": "Spanish",
  "concern_domain": "Speech & Language Delay",
  "has_household_vehicle": true
}`}
            </pre>

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setDraft('');
                  setValidationError(null);
                  onSave('');
                  onClose();
                }}
                className="pm-btn pm-btn-secondary"
              >
                Use local graph
              </button>
              <button
                type="button"
                onClick={handleCommitSave}
                className="pm-btn pm-btn-primary"
              >
                Save endpoint
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
