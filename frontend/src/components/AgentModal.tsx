import React, { useEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'motion/react';
import { PlugZap, X } from 'lucide-react';
import {
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

export const AgentModal: React.FC<AgentModalProps> = ({
  open,
  currentUrl,
  onSave,
  onClose,
}) => {
  const reducedMotion = useReducedMotion();
  const [draft, setDraft] = useState(currentUrl);
  const sheetY = useMotionValue(0);
  const scrimAlpha = useTransform(sheetY, [0, 280], [1, 0.25]);

  const grabOffsetRef = useRef(0);
  const draggingRef = useRef(false);
  const velocityRef = useRef(new PointerVelocityTracker());

  useEffect(() => {
    if (open) {
      setDraft(currentUrl);
      sheetY.set(0);
    }
  }, [open, currentUrl, sheetY]);

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
        duration: 0.22,
        ease: [0.2, 0.8, 0.2, 1],
      }).then(() => {
        onClose();
      });
    } else {
      animate(sheetY, 0, {
        duration: 0.24,
        ease: [0.2, 0.8, 0.2, 1],
      });
    }
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
              reducedMotion ? REDUCED_MOTION_TRANSITION : { duration: 0.18 }
            }
            style={{ opacity: scrimAlpha }}
            onClick={onClose}
            className="fixed inset-0 bg-[#18202A]/45"
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="adk-modal-title"
            initial={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.97, y: 16 }
            }
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.98, y: 12 }
            }
            transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SHEET}
            style={{ y: sheetY }}
            className="relative z-10 bg-white rounded-t-[20px] sm:rounded-[20px] max-w-lg w-full p-6 sm:p-7 border border-[rgba(29,37,48,0.18)] shadow-[0_24px_56px_-16px_rgba(24,32,42,0.28)] space-y-5"
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
              <div className="w-10 h-1 rounded-full bg-[rgba(29,37,48,0.18)] mx-auto mb-3.5 sm:hidden" />
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-[8px] bg-[#1D2530] text-[#F3F1EC] flex items-center justify-center shrink-0">
                    <PlugZap className="w-4 h-4" />
                  </div>
                  <h2 id="adk-modal-title" className="ts-h3 text-[18px]">
                    Connect ADK or Cloud Run endpoint
                  </h2>
                </div>
                <button
                  type="button"
                  aria-label="Close endpoint dialog"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={onClose}
                  className="w-8 h-8 rounded-[7px] bg-[#F8F7F4] hover:bg-[#E6E2D9] border border-[rgba(29,37,48,0.14)] text-[#556070] hover:text-[#1D2530] flex items-center justify-center cursor-pointer transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <p className="text-[14px] text-[#556070] leading-relaxed">
              Enter your Python ADK or Cloud Run POST address to route live queries. When left blank, the workspace runs locally against the pre-staged six-state ReferralGraph datasets.
            </p>

            <div>
              <label
                htmlFor="adk-endpoint-url"
                className="block text-[14px] font-medium text-[#1D2530] mb-1.5"
              >
                Agent POST endpoint URL
              </label>
              <input
                id="adk-endpoint-url"
                type="url"
                placeholder="https://ei-triage-agent.example/api/triage"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="ts-input font-mono-code text-[13px]"
              />
            </div>

            <pre className="ts-stage-dark p-4 text-[12px] font-mono-code overflow-x-auto leading-relaxed m-0">
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
                  onSave('');
                  onClose();
                }}
                className="ts-btn ts-btn-secondary"
              >
                Use local graph
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerCausalHaptic(6);
                  onSave(draft);
                  onClose();
                }}
                className="ts-btn ts-btn-primary"
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
