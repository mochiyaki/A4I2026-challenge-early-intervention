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
  ariaLabel?: string;
}

/**
 * Software tab / segmented switcher following taste-skill motion.md:
 * - Zero-overshoot 240ms indicator slide
 * - Clean 1px hairline track in --p-surface, active pill in --p-ink or --p-card
 */
export function FluidSegmentedControl<T extends string>({
  layoutId,
  options,
  value,
  onChange,
  size = 'sm',
  fullWidth = false,
  ariaLabel,
}: FluidSegmentedControlProps<T>) {
  const reducedMotion = useReducedMotion();
  const transition = reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_DEFAULT;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex p-[3px] rounded-[10px] bg-[#E6E2D9] border border-[rgba(29,37,48,0.1)] ${
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
              if (opt.value !== value) {
                triggerCausalHaptic(4);
                onChange(opt.value);
              }
            }}
            onClick={() => {
              if (opt.value !== value) onChange(opt.value);
            }}
            className={`relative z-10 flex-1 inline-flex items-center justify-center gap-1.5 rounded-[7px] font-medium select-none cursor-pointer transition-colors duration-150 ${
              size === 'sm'
                ? 'min-h-[34px] px-2.5 py-1 text-[13px]'
                : 'min-h-[38px] px-3.5 py-1.5 text-[13.5px]'
            } ${
              active
                ? 'text-[#1D2530]'
                : 'text-[#556070] hover:text-[#1D2530]'
            }`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={transition}
                className="absolute inset-0 -z-10 rounded-[7px] bg-white border border-[rgba(29,37,48,0.12)]"
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
  accent?: 'ink' | 'harbour';
  label: React.ReactNode;
  description?: React.ReactNode;
}

/**
 * Tactile toggle row (taste-skill cards.md & motion.md: switches that are on use ink;
 * knob slides 16px and stretches 4px while pressed, zero bounce, zero violet).
 */
export const FluidSwitch: React.FC<FluidSwitchProps> = ({
  checked,
  onChange,
  accent = 'ink',
  label,
  description,
}) => {
  const reducedMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);

  const activeBg =
    accent === 'harbour' ? 'bg-[#2C5877]' : 'bg-[#1D2530]';

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
        triggerCausalHaptic(5);
        onChange(!checked);
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
      className="group flex items-center justify-between gap-3 py-3 border-t border-[rgba(29,37,48,0.09)] first:border-t-0 cursor-pointer select-none"
    >
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-[#1D2530] leading-snug group-hover:text-[#2C5877] transition-colors">
          {label}
        </div>
        {description && (
          <div className="text-[13px] text-[#556070] mt-0.5 leading-snug">
            {description}
          </div>
        )}
      </div>

      <div
        className={`relative shrink-0 w-[44px] h-[26px] rounded-full p-[2px] transition-colors duration-150 ${
          checked ? activeBg : 'bg-[#D5D0C5]'
        }`}
      >
        <motion.div
          layout
          transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SNAPPY}
          style={{
            width: pressed && !reducedMotion ? 26 : 22,
            marginLeft: checked ? 'auto' : 0,
          }}
          className="h-[22px] rounded-full bg-white border border-[rgba(29,37,48,0.12)]"
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
 * Direct-manipulation 1:1 pointer-captured age scrubber in Harbour Blue (#2C5877),
 * shifting to terracotta (#B43E2F) only within 6 months of the 36-month Part C cliff.
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
  const nearCliff = 36 - value <= 6;

  const updateFromPointer = (clientX: number, respectOffset: boolean) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const rawX =
      clientX - rect.left - (respectOffset ? grabOffsetPxRef.current : 0);

    if (rawX < 0) {
      setRubberStretchPx(reducedMotion ? 0 : rubberband(rawX, width, 0.35));
    } else if (rawX > width) {
      setRubberStretchPx(
        reducedMotion ? 0 : rubberband(rawX - width, width, 0.35)
      );
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
    <div className="py-1 select-none">
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
          grabOffsetPxRef.current =
            Math.abs(distToThumb) <= 18 ? distToThumb : 0;
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
        className="relative h-9 flex items-center cursor-grab active:cursor-grabbing touch-none"
      >
        <div className="w-full h-[6px] rounded-full bg-[#E6E2D9] overflow-hidden">
          <div
            style={{ width: `${ratio * 100}%` }}
            className={`h-full rounded-full transition-colors duration-150 ${
              nearCliff ? 'bg-[#B43E2F]' : 'bg-[#2C5877]'
            }`}
          />
        </div>

        <motion.div
          animate={{
            scale: dragging && !reducedMotion ? 1.12 : 1,
          }}
          transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_SNAPPY}
          style={{
            left: `calc(${ratio * 100}% - 11px)`,
          }}
          className={`absolute w-[22px] h-[22px] rounded-full bg-white border-2 pointer-events-none ${
            nearCliff ? 'border-[#B43E2F]' : 'border-[#2C5877]'
          }`}
        />
      </motion.div>

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
