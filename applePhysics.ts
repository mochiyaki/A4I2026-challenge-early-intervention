import type { Transition } from 'motion/react';

/**
 * ui-ux-pro-max Motion Architecture (pro-rules.md §7):
 * - Snappy ease-out entrances (200ms, [0.16, 1, 0.3, 1])
 * - Exit animations ~65% duration of enter (130ms) so UI never feels sluggish
 * - GPU-friendly transform & opacity only
 */
export const SPRING_DEFAULT: Transition = {
  duration: 0.2,
  ease: [0.16, 1, 0.3, 1],
};

/**
 * Crisp micro-control transition for switches, tabs, and state pills (150ms).
 */
export const SPRING_SNAPPY: Transition = {
  duration: 0.15,
  ease: [0.16, 1, 0.3, 1],
};

/**
 * Modal / popover entrance transition (200ms ease-out).
 */
export const SPRING_SHEET: Transition = {
  duration: 0.2,
  ease: [0.16, 1, 0.3, 1],
};

/**
 * Exit transition (~65% of enter duration — pro-rules.md exit-faster-than-enter).
 */
export const EXIT_FAST_TRANSITION: Transition = {
  duration: 0.13,
  ease: [0.4, 0, 1, 1],
};

/**
 * Reduced-motion instant settle fallback.
 */
export const REDUCED_MOTION_TRANSITION: Transition = {
  duration: 0.01,
};

/**
 * Progressive boundary resistance for 1:1 pointer scrubbing.
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
 * Exponential-decay momentum projection from release velocity (px/s).
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
 * Rolling pointer history (~100ms) to compute smooth release velocity (px/s).
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
 * Subtle tactile confirmation where supported.
 */
export function triggerCausalHaptic(ms = 5): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(ms);
    } catch {
      // Ignore on unsupported desktop browsers
    }
  }
}
