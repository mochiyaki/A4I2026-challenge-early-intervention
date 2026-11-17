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

/**
 * Gesture-Driven Fluid Sheet / Dialog implementing:
 * - 1:1 Pointer capture respecting grab offset (SKILL.md §2)
 * - Interruptible mid-flight drag (SKILL.md §3)
 * - Upward rubber-banding resistance (SKILL.md §9)
 * - Momentum projection & velocity handoff on release (SKILL.md §5 & §6)
 * - Materialize enter/exit & dynamic scrim dimming (SKILL.md §12)
 */
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
    // Interrupt from live presentation value and preserve grab offset (SKILL.md §2 & §3)
    grabOffsetRef.current = e.clientY - sheetY.get();
    velocityRef.current.reset();
    velocityRef.current.record(e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    velocityRef.current.record(e.clientY);
    const rawDy = e.clientY - grabOffsetRef.current;
    if (rawDy < 0) {
      // Progressive upward rubber-banding (SKILL.md §9)
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
    // Apple exponential-decay momentum projection (SKILL.md §6)
    const projectedY = currentY + projectMomentum(releaseVelocity, 0.996);

    if (projectedY > 150) {
      triggerCausalHaptic(7);
      animate(sheetY, 420, {
        type: 'spring',
        bounce: 0,
        duration: 0.28,
        velocity: releaseVelocity,
      }).then(() => {
        onClose();
      });
    } else {
      // Hand off release velocity into spring settle back to 0 (SKILL.md §5)
      animate(sheetY, 0, {
        type: 'spring',
        bounce: Math.abs(releaseVelocity) > 400 ? 0.16 : 0,
        duration: 0.36,
        velocity: releaseVelocity,
      });
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          {/* Dimming Scrim Tied Continuously to Sheet Drag */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={
              reducedMotion ? REDUCED_MOTION_TRANSITION : { duration: 0.22 }
            }
            style={{ opacity: scrimAlpha }}
            onClick={onClose}
            className="fixed inset-0 bg-black/35 backdrop-blur-[4px]"
          />

          {/* Materializing Fluid Sheet */}
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.95, y: 24, filter: 'blur(6px)' }
            }
            animate={
              reducedMotion
                ? { opacity: 1 }
                : { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }
            }
            exit={
              reducedMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.96, y: 20, filter: 'blur(4px)' }
            }
            transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SHEET}
            style={{ y: sheetY }}
            className="relative z-10 bg-white rounded-t-[24px] sm:rounded-[24px] max-w-lg w-full p-6 shadow-[0_24px_60px_rgba(15,23,42,0.22),0_0_0_0.5px_rgba(15,23,42,0.08)] space-y-4"
          >
            {/* Gesture Drag Handle Area */}
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
              <div className="w-10 h-1.5 rounded-full bg-black/15 mx-auto mb-3" />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-[10px] bg-[#0D9488]/12 flex items-center justify-center">
                    <PlugZap className="w-4 h-4 text-[#0F766E]" />
                  </div>
                  <h3 className="apple-title text-[17px] font-semibold text-[#1D1D1F]">
                    Connect ADK / Cloud Run Agent
                  </h3>
                </div>
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={onClose}
                  className="apple-pressable w-7 h-7 rounded-full bg-[#F2F2F7] text-[#515154] hover:text-[#1D1D1F] flex items-center justify-center cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <p className="text-xs text-[#515154] leading-relaxed">
              While the Agent Lane deploys your Python ADK service to{' '}
              <strong className="text-[#1D1D1F]">Cloud Run</strong> or{' '}
              <strong className="text-[#1D1D1F]">Agent Runtime</strong>, this UI traverses the 5
              pre-staged datasets directly. Paste your live POST URL below (or flick downward to
              dismiss).
            </p>

            <div>
              <label className="block text-xs font-semibold text-[#1D1D1F] mb-1.5">
                Agent POST Endpoint URL
              </label>
              <input
                type="url"
                placeholder="https://ei-triage-agent-xxxxx-uc.a.run.app/api/triage"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full rounded-[12px] bg-[#F5F5F8] px-3.5 py-2.5 text-xs font-mono-code text-[#1D1D1F] shadow-[inset_0_0_0_0.5px_rgba(15,23,42,0.12)] focus:outline-none focus:ring-2 focus:ring-[#0D9488]/40"
              />
            </div>

            <div className="apple-dark-surface text-slate-200 p-3.5 text-[11px] font-mono-code overflow-x-auto leading-relaxed">
              <div className="text-slate-400 mb-1">// JSON Request Contract:</div>
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
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setDraft('');
                  onSave('');
                  onClose();
                }}
                className="apple-pressable px-3.5 py-2 rounded-full text-xs font-semibold text-[#515154] hover:bg-[#F2F2F7] cursor-pointer"
              >
                Use Starter Graph Engine
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerCausalHaptic(7);
                  onSave(draft);
                  onClose();
                }}
                className="apple-pressable px-4 py-2 rounded-full text-xs font-semibold bg-[#0D9488] text-white hover:bg-[#0F766E] cursor-pointer shadow-[0_2px_6px_rgba(13,148,136,0.28)]"
              >
                Save Endpoint
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
