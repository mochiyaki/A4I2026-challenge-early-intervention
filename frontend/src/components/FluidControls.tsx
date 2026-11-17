import React, { useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  REDUCED_MOTION_TRANSITION,
  rubberband,
  SPRING_DEFAULT,
  SPRING_SNAPPY,
  triggerCausalHaptic,
} from '../utils/applePhysics';

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

interface FluidSegmentedControlProps<T extends string> {
  layoutId: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
}

export function FluidSegmentedControl<T extends string>({
  layoutId,
  options,
  value,
  onChange,
  size = 'sm',
  fullWidth = false,
}: FluidSegmentedControlProps<T>) {
  const reducedMotion = useReducedMotion();
  const transition = reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_DEFAULT;

  return (
    <div
      role="tablist"
      className={`inline-flex p-1 rounded-[12px] bg-[#ECECEF]/90 shadow-[inset_0_0_0_0.5px_rgba(15,23,42,0.07)] ${
        fullWidth ? 'w-full' : ''
      }`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            type="button"
            onPointerDown={() => {
              // Respond immediately on pointer-down for zero perceived latency (SKILL.md §1)
              if (opt.value !== value) {
                triggerCausalHaptic(5);
                onChange(opt.value);
              }
            }}
            onClick={() => {
              // Keyboard activation fallback
              if (opt.value !== value) onChange(opt.value);
            }}
            className={`relative z-10 flex-1 inline-flex items-center justify-center gap-1.5 rounded-[9px] font-semibold select-none cursor-pointer transition-colors duration-150 ${
              size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-[13px]'
            } ${
              active
                ? 'text-[#1D1D1F]'
                : 'text-[#515154] hover:text-[#1D1D1F] active:opacity-75'
            }`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={transition}
                className="absolute inset-0 -z-10 rounded-[9px] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.05)]"
              />
            )}
            <span className="relative flex items-center gap-1.5 truncate">
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface FluidSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  accent?: 'teal' | 'indigo';
  label: React.ReactNode;
  description?: React.ReactNode;
}

export const FluidSwitch: React.FC<FluidSwitchProps> = ({
  checked,
  onChange,
  accent = 'teal',
  label,
  description,
}) => {
  const reducedMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);

  const activeBg =
    accent === 'indigo' ? 'bg-[#5856D6]' : 'bg-[#0D9488]';

  return (
    <div
      role="switch"
      aria-checked={checked}
      tabIndex={0}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onClick={() => {
        triggerCausalHaptic(6);
        onChange(!checked);
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
      className="group flex items-center justify-between gap-3 p-3 rounded-[14px] bg-[#F5F5F8] hover:bg-[#EFEFF4] shadow-[inset_0_0_0_0.5px_rgba(15,23,42,0.06)] cursor-pointer select-none transition-colors"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-[#1D1D1F] leading-snug">
          {label}
        </div>
        {description && (
          <div className="text-[11.5px] text-[#515154] mt-0.5 leading-snug">
            {description}
          </div>
        )}
      </div>

      {/* iOS Fluid Track + Gesture-Hinting Thumb (SKILL.md §8) */}
      <div
        className={`relative shrink-0 w-[46px] h-[28px] rounded-full p-[2px] transition-colors duration-200 ${
          checked ? activeBg : 'bg-[#D1D1D6]'
        }`}
      >
        <motion.div
          layout
          transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SNAPPY}
          style={{
            width: pressed && !reducedMotion ? 28 : 24,
            marginLeft: checked ? 'auto' : 0,
          }}
          className="h-[24px] rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.18),0_0_0_0.5px_rgba(0,0,0,0.06)]"
        />
      </div>
    </div>
  );
};

interface FluidAgeScrubberProps {
  value: number;
  min?: number;
  max?: number;
  onChange: (months: number) => void;
}

/**
 * Direct-manipulation 1:1 Pointer-Captured Scrubber with Rubber-Banding at Bounds (SKILL.md §2 & §9).
 */
export const FluidAgeScrubber: React.FC<FluidAgeScrubberProps> = ({
  value,
  min = 4,
  max = 35,
  onChange,
}) => {
  const reducedMotion = useReducedMotion();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const grabOffsetPxRef = useRef<number>(0);
  const [dragging, setDragging] = useState(false);
  const [rubberStretchPx, setRubberStretchPx] = useState(0);

  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));

  const updateFromPointer = (clientX: number, respectOffset: boolean) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const rawX = clientX - rect.left - (respectOffset ? grabOffsetPxRef.current : 0);

    if (rawX < 0) {
      setRubberStretchPx(reducedMotion ? 0 : rubberband(rawX, width, 0.35));
    } else if (rawX > width) {
      setRubberStretchPx(reducedMotion ? 0 : rubberband(rawX - width, width, 0.35));
    } else {
      setRubberStretchPx(0);
    }

    const clampedRatio = Math.max(0, Math.min(1, rawX / width));
    const nextVal = Math.round(min + clampedRatio * (max - min));
    if (nextVal !== value) {
      triggerCausalHaptic(3);
      onChange(nextVal);
    }
  };

  return (
    <div className="py-1.5 select-none">
      <motion.div
        ref={trackRef}
        animate={{ x: rubberStretchPx * 0.35 }}
        transition={
          dragging
            ? { duration: 0 }
            : reducedMotion
              ? REDUCED_MOTION_TRANSITION
              : SPRING_DEFAULT
        }
        onPointerDown={(e) => {
          const el = trackRef.current;
          if (!el) return;
          el.setPointerCapture(e.pointerId);
          const rect = el.getBoundingClientRect();
          const thumbCenter = rect.left + ratio * rect.width;
          const distToThumb = e.clientX - thumbCenter;
          // Respect grab offset if user grabbed the thumb itself (SKILL.md §2)
          grabOffsetPxRef.current = Math.abs(distToThumb) <= 18 ? distToThumb : 0;
          setDragging(true);
          updateFromPointer(e.clientX, grabOffsetPxRef.current !== 0);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          updateFromPointer(e.clientX, grabOffsetPxRef.current !== 0);
        }}
        onPointerUp={(e) => {
          if (!dragging) return;
          trackRef.current?.releasePointerCapture(e.pointerId);
          setDragging(false);
          setRubberStretchPx(0);
        }}
        onPointerCancel={() => {
          setDragging(false);
          setRubberStretchPx(0);
        }}
        className="relative h-8 flex items-center cursor-grab active:cursor-grabbing touch-none"
      >
        {/* Recessed Track */}
        <div className="w-full h-[6px] rounded-full bg-[#E2E2E8] overflow-hidden">
          <div
            style={{ width: `${ratio * 100}%` }}
            className={`h-full rounded-full transition-colors duration-150 ${
              36 - value <= 6 ? 'bg-rose-500' : 'bg-[#0D9488]'
            }`}
          />
        </div>

        {/* Physical Thumb */}
        <motion.div
          animate={{
            scale: dragging && !reducedMotion ? 1.14 : 1,
          }}
          transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SNAPPY}
          style={{
            left: `calc(${ratio * 100}% - 12px)`,
          }}
          className="absolute w-6 h-6 rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.20),0_0_0_0.5px_rgba(0,0,0,0.08)] pointer-events-none"
        />
      </motion.div>

      {/* Accessible Keyboard Slider Mirror */}
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-label="Child age in months"
        onChange={(e) => onChange(Number(e.target.value))}
        className="sr-only"
      />
    </div>
  );
};
