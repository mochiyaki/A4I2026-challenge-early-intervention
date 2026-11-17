import type { Transition } from 'motion/react';

/**
 * Critically damped default UI spring (Apple damping = 1.0, response = 0.35s).
 * Smooth, interruptible, zero overshoot — safe for tabs, layout pills, counters, and bars.
 */
export const SPRING_DEFAULT: Transition = {
  type: 'spring',
  bounce: 0,
  duration: 0.35,
};

/**
 * Snappy control spring for switches and micro-indicators (damping = 1.0, response = 0.28s).
 */
export const SPRING_SNAPPY: Transition = {
  type: 'spring',
  bounce: 0,
  duration: 0.28,
};

/**
 * Sheet / popover materialization spring (damping ~0.88, response = 0.32s).
 */
export const SPRING_SHEET: Transition = {
  type: 'spring',
  bounce: 0.08,
  duration: 0.32,
};

/**
 * Reduced-motion non-vestibular cross-fade fallback (SKILL.md §14).
 */
export const REDUCED_MOTION_TRANSITION: Transition = {
  duration: 0.18,
  ease: 'easeOut',
};

/**
 * Progressive boundary resistance (SKILL.md §9 — Rubber-banding).
 * Never hard-stop a drag at min/max; resist progressively as overshoot grows.
 */
export function rubberband(
  overshoot: number,
  dimension: number,
  constant = 0.55
): number {
  if (dimension <= 0 || overshoot === 0) return 0;
  const sign = overshoot < 0 ? -1 : 1;
  const abs = Math.abs(overshoot);
  return (
    sign *
    ((abs * dimension * constant) / (dimension + constant * abs))
  );
}

/**
 * Apple's exponential-decay momentum projection (SKILL.md §6 — Designing Fluid Interfaces).
 * Projects resting offset from release velocity (px/s).
 */
export function projectMomentum(
  initialVelocityPxPerSec: number,
  decelerationRate = 0.998
): number {
  return (
    ((initialVelocityPxPerSec / 1000) * decelerationRate) /
    (1 - decelerationRate)
  );
}

interface Sample {
  value: number;
  time: number;
}

/**
 * Short rolling pointer history (last ~90ms) to compute smooth release velocity (px/s)
 * for seamless drag -> spring velocity handoff (SKILL.md §2 & §5).
 */
export class PointerVelocityTracker {
  private samples: Sample[] = [];

  record(value: number, time = performance.now()): void {
    this.samples.push({ value, time });
    const cutoff = time - 100;
    while (this.samples.length > 2 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
  }

  getVelocityPxPerSec(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.time - first.time) / 1000;
    if (dt <= 0.001) return 0;
    return (last.value - first.value) / dt;
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * Causal, harmonious tactile pulse where supported (SKILL.md §13).
 * Used sparingly only on meaningful commits/snaps.
 */
export function triggerCausalHaptic(ms = 6): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(ms);
    } catch {
      // Ignore on unsupported desktop browsers
    }
  }
}
