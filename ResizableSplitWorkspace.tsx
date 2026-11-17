import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Columns3,
  GripVertical,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
} from 'lucide-react';
import { triggerCausalHaptic } from '../utils/applePhysics';

interface ResizableSplitWorkspaceProps {
  leftPane: React.ReactNode;
  centerPane: React.ReactNode;
  rightPane: React.ReactNode;
  rightPaneRef?: React.RefObject<HTMLDivElement | null>;
  fluidWidth: boolean;
  onToggleFluidWidth: () => void;
}

const STORAGE_KEY = 'pm-workspace-layout-v1';

const DEFAULT_LEFT_W = 305;
const MIN_LEFT_W = 240;
const MAX_LEFT_W = 500;

const DEFAULT_RIGHT_W = 430;
const MIN_RIGHT_W = 320;
const MAX_RIGHT_W = 780;

interface SavedLayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

function loadSavedLayout(): SavedLayoutState {
  if (typeof window === 'undefined') {
    return {
      leftWidth: DEFAULT_LEFT_W,
      rightWidth: DEFAULT_RIGHT_W,
      leftCollapsed: false,
      rightCollapsed: false,
    };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error('empty');
    const parsed = JSON.parse(raw) as Partial<SavedLayoutState>;
    return {
      leftWidth: Math.min(
        MAX_LEFT_W,
        Math.max(MIN_LEFT_W, Number(parsed.leftWidth) || DEFAULT_LEFT_W)
      ),
      rightWidth: Math.min(
        MAX_RIGHT_W,
        Math.max(MIN_RIGHT_W, Number(parsed.rightWidth) || DEFAULT_RIGHT_W)
      ),
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed),
    };
  } catch {
    return {
      leftWidth: DEFAULT_LEFT_W,
      rightWidth: DEFAULT_RIGHT_W,
      leftCollapsed: false,
      rightCollapsed: false,
    };
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export const ResizableSplitWorkspace: React.FC<ResizableSplitWorkspaceProps> = ({
  leftPane,
  centerPane,
  rightPane,
  rightPaneRef,
  fluidWidth,
  onToggleFluidWidth,
}) => {
  const [layout, setLayout] = useState<SavedLayoutState>(loadSavedLayout);
  const [activeDrag, setActiveDrag] = useState<'left' | 'right' | null>(null);
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : true
  );

  const dragStartXRef = useRef<number>(0);
  const dragStartWidthRef = useRef<number>(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  }, [layout]);

  const startLeftDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = layout.leftWidth;
    setActiveDrag('left');
  };

  const moveLeftDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeDrag !== 'left') return;
    const delta = e.clientX - dragStartXRef.current;
    const nextWidth = clamp(
      Math.round(dragStartWidthRef.current + delta),
      MIN_LEFT_W,
      MAX_LEFT_W
    );
    setLayout((prev) => ({ ...prev, leftWidth: nextWidth }));
  };

  const startRightDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = layout.rightWidth;
    setActiveDrag('right');
  };

  const moveRightDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeDrag !== 'right') return;
    // Moving splitter left increases right pane width; moving right shrinks right pane width
    const delta = dragStartXRef.current - e.clientX;
    const maxAllowedByViewport =
      typeof window !== 'undefined'
        ? Math.min(MAX_RIGHT_W, Math.max(MIN_RIGHT_W, window.innerWidth - 520))
        : MAX_RIGHT_W;
    const nextWidth = clamp(
      Math.round(dragStartWidthRef.current + delta),
      MIN_RIGHT_W,
      maxAllowedByViewport
    );
    setLayout((prev) => ({ ...prev, rightWidth: nextWidth }));
  };

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setActiveDrag(null);
  }, []);

  const isCustomized =
    layout.leftWidth !== DEFAULT_LEFT_W ||
    layout.rightWidth !== DEFAULT_RIGHT_W ||
    layout.leftCollapsed ||
    layout.rightCollapsed;

  const applyPreset = (preset: 'balanced' | 'wide-center' | 'wide-chat') => {
    triggerCausalHaptic(4);
    if (preset === 'balanced') {
      setLayout({
        leftWidth: DEFAULT_LEFT_W,
        rightWidth: DEFAULT_RIGHT_W,
        leftCollapsed: false,
        rightCollapsed: false,
      });
    } else if (preset === 'wide-center') {
      setLayout({
        leftWidth: 270,
        rightWidth: 360,
        leftCollapsed: true,
        rightCollapsed: false,
      });
    } else {
      setLayout({
        leftWidth: 275,
        rightWidth: 580,
        leftCollapsed: false,
        rightCollapsed: false,
      });
    }
  };

  /* Mobile & Tablet (<1024px): Clean full-width vertical stack */
  if (!isDesktop) {
    return (
      <div className="space-y-6">
        <div ref={rightPaneRef} className="pm-pane-cq no-print">
          {rightPane}
        </div>
        <div className="pm-pane-cq">{leftPane}</div>
        <div className="pm-pane-cq space-y-6">{centerPane}</div>
      </div>
    );
  }

  /* Desktop (>=1024px): Interactive Drag-Resizable 3-Pane Split Frame */
  return (
    <div className="space-y-3">
      {/* Resizable Frame Controls Strip */}
      <div
        aria-label="Workspace frame layout and sizing controls"
        className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-[10px] bg-[var(--pm-card)] border border-[var(--pm-border)] text-[12px] no-print"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 font-semibold text-[var(--pm-ink)]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            <Columns3 aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-accent)]" />
            <span>Resizable Frames</span>
          </span>
          <span className="text-[var(--pm-muted)] hidden xl:inline">
            Drag dividers between columns or use layout presets:
          </span>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => applyPreset('balanced')}
              className="min-h-[30px] px-2.5 py-0.5 rounded-[6px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border)] font-semibold text-[var(--pm-ink)] cursor-pointer transition-colors"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Balanced
            </button>
            <button
              type="button"
              onClick={() => applyPreset('wide-center')}
              className="min-h-[30px] px-2.5 py-0.5 rounded-[6px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border)] font-semibold text-[var(--pm-ink)] cursor-pointer transition-colors"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Wide center cards
            </button>
            <button
              type="button"
              onClick={() => applyPreset('wide-chat')}
              className="min-h-[30px] px-2.5 py-0.5 rounded-[6px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border)] font-semibold text-[var(--pm-ink)] cursor-pointer transition-colors"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Wide chat &amp; map
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={!layout.leftCollapsed}
            onClick={() => {
              triggerCausalHaptic(3);
              setLayout((prev) => ({
                ...prev,
                leftCollapsed: !prev.leftCollapsed,
              }));
            }}
            className="min-h-[30px] px-2.5 py-0.5 rounded-[6px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border)] font-semibold text-[var(--pm-ink)] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {layout.leftCollapsed ? (
              <>
                <PanelLeftOpen aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-accent)]" />
                <span>Show intake</span>
              </>
            ) : (
              <>
                <PanelLeftClose aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-muted)]" />
                <span>Hide intake</span>
              </>
            )}
          </button>

          <button
            type="button"
            aria-pressed={!layout.rightCollapsed}
            onClick={() => {
              triggerCausalHaptic(3);
              setLayout((prev) => ({
                ...prev,
                rightCollapsed: !prev.rightCollapsed,
              }));
            }}
            className="min-h-[30px] px-2.5 py-0.5 rounded-[6px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border)] font-semibold text-[var(--pm-ink)] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {layout.rightCollapsed ? (
              <>
                <PanelRightOpen aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-accent)]" />
                <span>Show chat</span>
              </>
            ) : (
              <>
                <PanelRightClose aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-muted)]" />
                <span>Hide chat</span>
              </>
            )}
          </button>

          <button
            type="button"
            aria-pressed={fluidWidth}
            onClick={() => {
              triggerCausalHaptic(3);
              onToggleFluidWidth();
            }}
            title="Toggle full browser width"
            className={`min-h-[30px] px-2.5 py-0.5 rounded-[6px] border font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
              fluidWidth
                ? 'bg-[var(--pm-accent-soft)] border-[var(--pm-accent)] text-[var(--pm-accent)]'
                : 'bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border-[var(--pm-border)] text-[var(--pm-ink)]'
            }`}
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {fluidWidth ? (
              <>
                <Minimize2 aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Full width ON</span>
              </>
            ) : (
              <>
                <Maximize2 aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Full width</span>
              </>
            )}
          </button>

          {isCustomized && (
            <button
              type="button"
              onClick={() => applyPreset('balanced')}
              title="Reset frame widths to default"
              className="min-h-[30px] px-2 py-0.5 rounded-[6px] bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border border-[var(--pm-border)] text-[var(--pm-muted)] hover:text-[var(--pm-ink)] inline-flex items-center gap-1 cursor-pointer transition-colors"
            >
              <RotateCcw aria-hidden="true" className="w-3 h-3" />
              <span>Reset</span>
            </button>
          )}
        </div>
      </div>

      {/* 3-Pane Split Container */}
      <div className="flex items-start w-full min-w-0">
        {/* LEFT PANE: Intake Profile */}
        {!layout.leftCollapsed && (
          <>
            <div
              style={{ width: `${layout.leftWidth}px` }}
              className="shrink-0 sticky top-22 pm-pane-cq"
            >
              {leftPane}
            </div>

            <div
              role="separator"
              tabIndex={0}
              aria-label="Resize intake sidebar width (drag or use Left and Right arrow keys, double-click to reset)"
              aria-orientation="vertical"
              aria-valuemin={MIN_LEFT_W}
              aria-valuemax={MAX_LEFT_W}
              aria-valuenow={layout.leftWidth}
              data-dragging={activeDrag === 'left'}
              title="Drag to resize Intake panel · Double-click to reset"
              onPointerDown={startLeftDrag}
              onPointerMove={moveLeftDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={() => {
                triggerCausalHaptic(4);
                setLayout((prev) => ({ ...prev, leftWidth: DEFAULT_LEFT_W }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  setLayout((prev) => ({
                    ...prev,
                    leftWidth: clamp(prev.leftWidth - 20, MIN_LEFT_W, MAX_LEFT_W),
                  }));
                } else if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  setLayout((prev) => ({
                    ...prev,
                    leftWidth: clamp(prev.leftWidth + 20, MIN_LEFT_W, MAX_LEFT_W),
                  }));
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  setLayout((prev) => ({ ...prev, leftWidth: DEFAULT_LEFT_W }));
                }
              }}
              className="pm-splitter-col self-stretch mx-1 no-print"
            >
              <span className="pm-splitter-pill" aria-hidden="true">
                <GripVertical className="w-3.5 h-3.5" />
              </span>
            </div>
          </>
        )}

        {/* CENTER PANE: Clinical Pathway, Multi-Agent Council & Topology */}
        <div className="flex-1 min-w-[360px] space-y-6 pm-pane-cq">
          {centerPane}
        </div>

        {/* RIGHT PANE: Multi-Agent Voice, Chat & Google Map Assistant */}
        {!layout.rightCollapsed && (
          <>
            <div
              role="separator"
              tabIndex={0}
              aria-label="Resize voice and chat assistant width (drag or use Left and Right arrow keys, double-click to reset)"
              aria-orientation="vertical"
              aria-valuemin={MIN_RIGHT_W}
              aria-valuemax={MAX_RIGHT_W}
              aria-valuenow={layout.rightWidth}
              data-dragging={activeDrag === 'right'}
              title="Drag to resize Voice & Chat panel · Double-click to reset"
              onPointerDown={startRightDrag}
              onPointerMove={moveRightDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={() => {
                triggerCausalHaptic(4);
                setLayout((prev) => ({ ...prev, rightWidth: DEFAULT_RIGHT_W }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  setLayout((prev) => ({
                    ...prev,
                    rightWidth: clamp(prev.rightWidth + 24, MIN_RIGHT_W, MAX_RIGHT_W),
                  }));
                } else if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  setLayout((prev) => ({
                    ...prev,
                    rightWidth: clamp(prev.rightWidth - 24, MIN_RIGHT_W, MAX_RIGHT_W),
                  }));
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  setLayout((prev) => ({ ...prev, rightWidth: DEFAULT_RIGHT_W }));
                }
              }}
              className="pm-splitter-col self-stretch mx-1 no-print"
            >
              <span className="pm-splitter-pill" aria-hidden="true">
                <GripVertical className="w-3.5 h-3.5" />
              </span>
            </div>

            <div
              ref={rightPaneRef}
              style={{ width: `${layout.rightWidth}px` }}
              className="shrink-0 sticky top-22 pm-pane-cq no-print"
            >
              {rightPane}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
