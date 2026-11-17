import React, { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Pause, Play } from 'lucide-react';
import { cleanOrgName } from '../engine/graphTriageEngine';
import type {
  BounceHubSummary,
  CandidatePathway,
  CareNode,
  HistoricalChainTrace,
  NodeRole,
  ReferralHandoff,
} from '../types';
import {
  REDUCED_MOTION_TRANSITION,
  SPRING_DEFAULT,
  triggerCausalHaptic,
} from '../utils/applePhysics';
import { FluidSegmentedControl } from './FluidControls';

interface NetworkGraphCanvasProps {
  stateCode: string;
  providers: CareNode[];
  referrals: ReferralHandoff[];
  activePathway: CandidatePathway | null;
  historicalTrapChain: HistoricalChainTrace | null;
  bounceDiagnostics: BounceHubSummary[];
}

const ROLE_COLUMNS: { role: NodeRole; title: string; x: number }[] = [
  { role: 'Screening_Pediatric_Clinic', title: '1. Screening clinics (8)', x: 115 },
  { role: 'Part_C_Intake_Coordinator', title: '2. Intake coordinators (4)', x: 345 },
  { role: 'Multidisciplinary_Eval_Hub', title: '3. Eval hubs (8)', x: 595 },
  { role: 'EI_Therapy_Vendor', title: '4. Therapy vendors (10)', x: 845 },
];

export const NetworkGraphCanvas: React.FC<NetworkGraphCanvasProps> = ({
  stateCode,
  providers,
  referrals,
  activePathway,
  historicalTrapChain,
  bounceDiagnostics,
}) => {
  const reducedMotion = useReducedMotion();
  const [filterMode, setFilterMode] = useState<'compare' | 'breaches' | 'all'>('compare');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pulsePaused, setPulsePaused] = useState(false);
  const [pulseCycleKey, setPulseCycleKey] = useState(0);
  const lastRestartRef = useRef(0);

  const layout = useMemo(() => {
    const pos = new Map<string, { x: number; y: number; node: CareNode }>();
    const height = 430;
    const topPad = 58;
    const bottomPad = 28;

    for (const col of ROLE_COLUMNS) {
      const group = providers
        .filter((p) => p.node_role === col.role)
        .sort((a, b) => a.provider_id.localeCompare(b.provider_id));
      const usable = height - topPad - bottomPad;
      group.forEach((node, idx) => {
        const step = group.length > 1 ? usable / (group.length - 1) : 0;
        const y = group.length > 1 ? topPad + idx * step : height / 2;
        pos.set(node.provider_id, { x: col.x, y, node });
      });
    }
    return pos;
  }, [providers]);

  const activeNodeIds = useMemo(() => {
    const s = new Set<string>();
    activePathway?.steps.forEach((st) => s.add(st.node.provider_id));
    return s;
  }, [activePathway]);

  const activeEdgeKeys = useMemo(() => {
    const s = new Set<string>();
    if (activePathway) {
      for (let i = 0; i < activePathway.steps.length - 1; i++) {
        s.add(
          `${activePathway.steps[i].node.provider_id}__${activePathway.steps[i + 1].node.provider_id}`
        );
      }
    }
    return s;
  }, [activePathway]);

  const activeOrderedCurves = useMemo(() => {
    if (!activePathway) return [];
    const curves: { key: string; d: string; delaySec: number }[] = [];
    for (let i = 0; i < activePathway.steps.length - 1; i++) {
      const src = activePathway.steps[i].node.provider_id;
      const dst = activePathway.steps[i + 1].node.provider_id;
      const p1 = layout.get(src);
      const p2 = layout.get(dst);
      if (!p1 || !p2) continue;
      curves.push({
        key: `${src}__${dst}`,
        d: `M ${p1.x} ${p1.y} C ${(p1.x + p2.x) / 2} ${p1.y}, ${(p1.x + p2.x) / 2} ${p2.y}, ${p2.x} ${p2.y}`,
        delaySec: i * 0.34,
      });
    }
    return curves;
  }, [activePathway, layout]);

  const trapEdgeKeys = useMemo(() => {
    const s = new Set<string>();
    historicalTrapChain?.hops.forEach((h) => {
      s.add(`${h.source.provider_id}__${h.target.provider_id}`);
    });
    return s;
  }, [historicalTrapChain]);

  const uniqueEdges = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        src: string;
        dst: string;
        hasFax: boolean;
        hasBounce: boolean;
        avgWait: number;
        count: number;
      }
    >();
    for (const r of referrals) {
      const key = `${r.source_provider_id}__${r.target_provider_id}`;
      const cur = map.get(key) || {
        key,
        src: r.source_provider_id,
        dst: r.target_provider_id,
        hasFax: false,
        hasBounce: false,
        avgWait: 0,
        count: 0,
      };
      cur.hasFax = cur.hasFax || r.transmission_channel === 'paper_fax';
      cur.hasBounce = cur.hasBounce || r.handoff_reason.startsWith('Re-Referral Bounce');
      cur.avgWait += r.handoff_wait_days;
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.values()).map((e) => ({
      ...e,
      avgWait: Math.round(e.avgWait / e.count),
    }));
  }, [referrals]);

  const topBounceHubIds = useMemo(() => {
    return new Set(
      bounceDiagnostics
        .filter((b) => b.chainsOver45d >= 6)
        .map((b) => b.coordinator.provider_id)
    );
  }, [bounceDiagnostics]);

  const inspectedNode =
    providers.find((p) => p.provider_id === selectedNodeId) ||
    activePathway?.steps[2]?.node ||
    providers[0];

  const inspectedCoordDiag = bounceDiagnostics.find(
    (b) => b.coordinator.provider_id === inspectedNode?.provider_id
  );

  /* Restart 3.2s diagram pulse from first beat when pointer enters (diagrams.md §Motion) */
  const handleStagePointerEnter = () => {
    if (pulsePaused || reducedMotion) return;
    const now = performance.now();
    if (now - lastRestartRef.current > 800) {
      lastRestartRef.current = now;
      setPulseCycleKey((k) => k + 1);
    }
  };

  return (
    <section
      onPointerEnter={handleStagePointerEnter}
      className="ts-card p-6 sm:p-8 space-y-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="ts-h2 text-[20px]">
            {stateCode} referral graph.{' '}
            <span className="ts-muted">30 synthetic CareNodes across four roles.</span>
          </h2>
        </div>

        <div className="no-print">
          <FluidSegmentedControl
            layoutId="graph-view-segment"
            ariaLabel="Referral graph edge filter"
            options={[
              { value: 'compare', label: 'Route vs. loop' },
              { value: 'breaches', label: 'Fax breaches' },
              { value: 'all', label: 'All 149 edges' },
            ]}
            value={filterMode}
            onChange={setFilterMode}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-5 items-start">
        {/* Harbour Slate Diagram Stage with 3.2s Comet Pulse & 32px Pause Disc (House Rule 1: no caption below) */}
        <div
          className={`xl:col-span-3 ts-stage-dark relative p-3 overflow-x-auto ${
            pulsePaused ? 'ts-diagram-paused' : ''
          }`}
        >
          <svg
            viewBox="0 0 960 440"
            className="w-full min-w-[680px] h-auto select-none"
            role="img"
            aria-label={`${stateCode} multi-hop Part C referral graph showing 30 CareNodes`}
          >
            <defs>
              <marker
                id="arrow-harbour"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#7FB3D5" />
              </marker>
              <marker
                id="arrow-breach"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#D97768" />
              </marker>
            </defs>

            {ROLE_COLUMNS.map((col) => (
              <g key={col.role}>
                <line
                  x1={col.x}
                  y1={38}
                  x2={col.x}
                  y2={418}
                  stroke="rgba(243,241,236,0.08)"
                  strokeDasharray="3 5"
                />
                <text
                  x={col.x}
                  y={24}
                  textAnchor="middle"
                  fill="#9AA5B4"
                  fontSize="11.5"
                  fontWeight="500"
                  fontFamily="Geist, system-ui, sans-serif"
                >
                  {col.title}
                </text>
              </g>
            ))}

            {uniqueEdges.map((edge) => {
              const p1 = layout.get(edge.src);
              const p2 = layout.get(edge.dst);
              if (!p1 || !p2) return null;

              const isRec = activeEdgeKeys.has(edge.key);
              const isTrap = trapEdgeKeys.has(edge.key);

              if (filterMode === 'compare' && !isRec && !isTrap) {
                return (
                  <path
                    key={edge.key}
                    d={`M ${p1.x} ${p1.y} C ${(p1.x + p2.x) / 2} ${p1.y}, ${(p1.x + p2.x) / 2} ${p2.y}, ${p2.x} ${p2.y}`}
                    fill="none"
                    stroke="#526071"
                    strokeOpacity={0.2}
                    strokeWidth={1}
                  />
                );
              }

              if (filterMode === 'breaches' && !edge.hasFax && !edge.hasBounce && !isRec) {
                return null;
              }

              const sameCol = Math.abs(p1.x - p2.x) < 20;
              const pathD = sameCol
                ? `M ${p1.x} ${p1.y} C ${p1.x + 65} ${(p1.y + p2.y) / 2}, ${p2.x + 65} ${(p1.y + p2.y) / 2}, ${p2.x} ${p2.y}`
                : `M ${p1.x} ${p1.y} C ${(p1.x + p2.x) / 2} ${p1.y}, ${(p1.x + p2.x) / 2} ${p2.y}, ${p2.x} ${p2.y}`;

              const stroke = isRec
                ? '#7FB3D5'
                : isTrap || edge.hasBounce
                  ? '#D97768'
                  : edge.hasFax
                    ? '#C89B5B'
                    : '#64748B';

              const width = isRec ? 2.6 : isTrap ? 2.1 : edge.hasBounce ? 1.6 : 1;
              const opacity = isRec || isTrap ? 0.94 : filterMode === 'all' ? 0.38 : 0.68;

              return (
                <path
                  key={edge.key}
                  d={pathD}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={width}
                  strokeOpacity={opacity}
                  strokeDasharray={!isRec && (isTrap || edge.hasFax) ? '5 4' : undefined}
                  markerEnd={
                    isRec
                      ? 'url(#arrow-harbour)'
                      : isTrap
                        ? 'url(#arrow-breach)'
                        : undefined
                  }
                />
              );
            })}

            {activePathway &&
              activePathway.steps.slice(0, -1).map((st, idx) => {
                const nxt = activePathway.steps[idx + 1];
                const key = `${st.node.provider_id}__${nxt.node.provider_id}`;
                if (uniqueEdges.some((e) => e.key === key)) return null;
                const p1 = layout.get(st.node.provider_id);
                const p2 = layout.get(nxt.node.provider_id);
                if (!p1 || !p2) return null;
                return (
                  <path
                    key={`prospective-${key}`}
                    d={`M ${p1.x} ${p1.y} C ${(p1.x + p2.x) / 2} ${p1.y}, ${(p1.x + p2.x) / 2} ${p2.y}, ${p2.x} ${p2.y}`}
                    fill="none"
                    stroke="#7FB3D5"
                    strokeWidth={2.6}
                    markerEnd="url(#arrow-harbour)"
                  />
                );
              })}

            {/* 3.2s Staggered Ripple Comet Pulses along Recommended Route (diagrams.md) */}
            {!reducedMotion &&
              activeOrderedCurves.map((curve) => (
                <path
                  key={`comet-${pulseCycleKey}-${curve.key}`}
                  d={curve.d}
                  fill="none"
                  stroke="#F3F1EC"
                  strokeWidth={3}
                  strokeLinecap="round"
                  style={{ animationDelay: `${curve.delaySec}s` }}
                  className="ts-diagram-comet pointer-events-none"
                />
              ))}

            {Array.from(layout.values()).map(({ x, y, node }) => {
              const isRec = activeNodeIds.has(node.provider_id);
              const isBounceHub = topBounceHubIds.has(node.provider_id);
              const isSelected = inspectedNode?.provider_id === node.provider_id;
              const shortNum = node.provider_id.slice(-3);

              const fill = isRec
                ? '#3B6D90'
                : isBounceHub
                  ? '#B43E2F'
                  : node.bilingual_services_listed && node.accepts_medicaid
                    ? '#43556A'
                    : '#2B3645';

              return (
                <g
                  key={node.provider_id}
                  transform={`translate(${x}, ${y})`}
                  onPointerDown={() => {
                    triggerCausalHaptic(4);
                    setSelectedNodeId(node.provider_id);
                  }}
                  className="cursor-pointer"
                >
                  <circle r={17} fill="transparent" />
                  {isSelected && (
                    <circle
                      r={14.5}
                      fill="none"
                      stroke="#F3F1EC"
                      strokeOpacity={0.9}
                      strokeWidth={1.5}
                    />
                  )}
                  <circle
                    r={isRec ? 11 : 8.5}
                    fill={fill}
                    stroke={isRec ? '#F3F1EC' : '#18202A'}
                    strokeWidth={1.8}
                  />
                  <text
                    x={0}
                    y={3}
                    textAnchor="middle"
                    fill="#F3F1EC"
                    fontSize="8.5"
                    fontWeight="500"
                    fontFamily="Geist Mono, ui-monospace, monospace"
                  >
                    {shortNum}
                  </text>
                  {(isRec || isBounceHub) && (
                    <text
                      x={0}
                      y={-14}
                      textAnchor="middle"
                      fill={isRec ? '#BDD9EC' : '#E9A297'}
                      fontSize="10"
                      fontWeight="500"
                      fontFamily="Geist, system-ui, sans-serif"
                    >
                      {node.city}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Signature 32px Round Pause Disc at Bottom-Right (motion.md §Pause) */}
          {!reducedMotion && (
            <button
              type="button"
              aria-label={pulsePaused ? 'Play route pulse' : 'Pause route pulse'}
              title={pulsePaused ? 'Play route pulse' : 'Pause route pulse'}
              onClick={() => setPulsePaused((p) => !p)}
              className="no-print absolute bottom-3 right-3 w-8 h-8 rounded-full bg-[#222C39] hover:bg-[#2E3B4C] text-[#F3F1EC] border border-[rgba(243,241,236,0.2)] flex items-center justify-center cursor-pointer transition-colors"
            >
              {pulsePaused ? (
                <Play className="w-3.5 h-3.5 translate-x-[0.5px]" />
              ) : (
                <Pause className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>

        {/* 2-Level CareNode Inspector — Open hairline rows, zero nested white-in-grey-in-white boxes */}
        {inspectedNode && (
          <AnimatePresence mode="wait">
            <motion.div
              key={inspectedNode.provider_id}
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_DEFAULT}
              className="ts-panel p-5 space-y-4 tabular-nums"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="ts-label">Selected CareNode</span>
                <span className="font-mono-code text-[12.5px] font-medium text-[#2C5877]">
                  {inspectedNode.provider_id}
                </span>
              </div>

              <div>
                <h3 className="font-medium text-[15px] text-[#1D2530] leading-snug">
                  {cleanOrgName(inspectedNode.synthetic_organization_name)}
                </h3>
                <p className="text-[13px] text-[#556070] mt-0.5">
                  {inspectedNode.city}, {inspectedNode.county_name}
                </p>
              </div>

              <dl className="grid grid-cols-2 gap-3 py-3 border-y border-[rgba(29,37,48,0.1)]">
                <div>
                  <dt className="ts-label">Internal wait</dt>
                  <dd className="font-mono-code text-[18px] font-medium text-[#1D2530] mt-0.5">
                    {inspectedNode.median_internal_wait_days}d
                  </dd>
                </div>
                <div className="border-l border-[rgba(29,37,48,0.1)] pl-3">
                  <dt className="ts-label">Active waitlist</dt>
                  <dd className="font-mono-code text-[18px] font-medium text-[#1D2530] mt-0.5">
                    {inspectedNode.active_waitlist_count} children
                  </dd>
                </div>
              </dl>

              <dl className="space-y-2 text-[13px]">
                <div className="flex justify-between gap-2">
                  <dt className="text-[#556070]">Role</dt>
                  <dd className="font-medium text-[#1D2530] text-right">
                    {inspectedNode.node_role.replace(/_/g, ' ')}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[#556070]">Medicaid</dt>
                  <dd className="font-medium text-[#1D2530]">
                    {inspectedNode.accepts_medicaid ? 'Accepted' : 'Not listed'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[#556070]">Bilingual eval</dt>
                  <dd className="font-medium text-[#1D2530]">
                    {inspectedNode.bilingual_services_listed ? 'Available' : 'English only'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[#556070]">Part C status</dt>
                  <dd className="font-medium text-[#1D2530]">
                    {inspectedNode.part_c_vendor_enrolled ? 'Enrolled vendor' : 'Screening clinic'}
                  </dd>
                </div>
              </dl>

              {inspectedCoordDiag && (
                <div className="pt-3 border-t border-[rgba(180,62,47,0.24)] text-[13px] text-[#1D2530] space-y-1">
                  <div className="font-medium text-[#B43E2F]">
                    Downstream 45-day breach rate: {inspectedCoordDiag.breachRatePct}%
                  </div>
                  <p className="text-[12.5px] text-[#556070] leading-relaxed">
                    {inspectedCoordDiag.chainsOver45d} of {inspectedCoordDiag.routedEpisodes} episodes exceeded 45 days (mean{' '}
                    {inspectedCoordDiag.meanEpisodeWaitDays}d; {inspectedCoordDiag.faxSharePct}% paper fax).
                  </p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </section>
  );
};
