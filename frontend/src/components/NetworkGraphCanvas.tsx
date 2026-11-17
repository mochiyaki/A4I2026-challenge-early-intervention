import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { GitBranch, Info } from 'lucide-react';
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
  { role: 'Screening_Pediatric_Clinic', title: '1. Screening Clinics (8)', x: 110 },
  { role: 'Part_C_Intake_Coordinator', title: '2. Intake Coordinators (4)', x: 340 },
  { role: 'Multidisciplinary_Eval_Hub', title: '3. Eval Hubs (8)', x: 590 },
  { role: 'EI_Therapy_Vendor', title: '4. Therapy Vendors (10)', x: 840 },
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

  const layout = useMemo(() => {
    const pos = new Map<string, { x: number; y: number; node: CareNode }>();
    const height = 430;
    const topPad = 56;
    const bottomPad = 26;

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

  return (
    <section className="apple-card p-6 sm:p-7 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-[#0D9488]" />
            <h3 className="apple-title text-[17px] font-semibold text-[#1D1D1F]">
              {stateCode} ReferralGraph Topology (30 CareNodes)
            </h3>
          </div>
          <p className="text-xs text-[#515154] mt-0.5">
            Tap any vertex (#001–#030) to inspect internal wait vs. downstream multi-hop breaches.
          </p>
        </div>

        <div className="no-print">
          <FluidSegmentedControl
            layoutId="graph-view-segment"
            options={[
              { value: 'compare', label: 'Route vs. Trap' },
              { value: 'breaches', label: 'Fax & Bounces' },
              { value: 'all', label: 'All 149 Edges' },
            ]}
            value={filterMode}
            onChange={setFilterMode}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4 items-start">
        {/* Obsidian Graph Surface */}
        <div className="xl:col-span-3 apple-dark-surface p-2.5 overflow-x-auto">
          <svg
            viewBox="0 0 960 440"
            className="w-full min-w-[680px] h-auto select-none"
            role="img"
            aria-label="Multi-hop ReferralGraph visualization"
          >
            <defs>
              <marker
                id="arrow-emerald"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#2dd4bf" />
              </marker>
              <marker
                id="arrow-rose"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#fb7185" />
              </marker>
            </defs>

            {ROLE_COLUMNS.map((col) => (
              <g key={col.role}>
                <line
                  x1={col.x}
                  y1={38}
                  x2={col.x}
                  y2={420}
                  stroke="rgba(255,255,255,0.06)"
                  strokeDasharray="3 4"
                />
                <text
                  x={col.x}
                  y={24}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize="11"
                  fontWeight="600"
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
                    stroke="#475569"
                    strokeOpacity={0.18}
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
                ? '#2dd4bf'
                : isTrap || edge.hasBounce
                  ? '#fb7185'
                  : edge.hasFax
                    ? '#fbbf24'
                    : '#64748b';

              const width = isRec ? 3 : isTrap ? 2.4 : edge.hasBounce ? 1.8 : 1.1;
              const opacity = isRec || isTrap ? 0.96 : filterMode === 'all' ? 0.42 : 0.72;

              return (
                <path
                  key={edge.key}
                  d={pathD}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={width}
                  strokeOpacity={opacity}
                  strokeDasharray={!isRec && (isTrap || edge.hasFax) ? '5 3' : undefined}
                  markerEnd={
                    isRec
                      ? 'url(#arrow-emerald)'
                      : isTrap
                        ? 'url(#arrow-rose)'
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
                    stroke="#2dd4bf"
                    strokeWidth={3}
                    markerEnd="url(#arrow-emerald)"
                  />
                );
              })}

            {Array.from(layout.values()).map(({ x, y, node }) => {
              const isRec = activeNodeIds.has(node.provider_id);
              const isBounceHub = topBounceHubIds.has(node.provider_id);
              const isSelected = inspectedNode?.provider_id === node.provider_id;
              const shortNum = node.provider_id.slice(-3);

              const fill = isRec
                ? '#14b8a6'
                : isBounceHub
                  ? '#f43f5e'
                  : node.bilingual_services_listed && node.accepts_medicaid
                    ? '#38bdf8'
                    : '#475569';

              return (
                <g
                  key={node.provider_id}
                  transform={`translate(${x}, ${y})`}
                  onPointerDown={() => {
                    triggerCausalHaptic(5);
                    setSelectedNodeId(node.provider_id);
                  }}
                  className="cursor-pointer"
                >
                  {/* Generous 16px touch hit target (SKILL.md §10) */}
                  <circle r={16} fill="transparent" />
                  {isSelected && (
                    <circle
                      r={14.5}
                      fill="none"
                      stroke="#ffffff"
                      strokeOpacity={0.85}
                      strokeWidth={1.5}
                    />
                  )}
                  <circle
                    r={isRec ? 11 : 8.5}
                    fill={fill}
                    stroke={isRec ? '#f0fdfa' : '#090d14'}
                    strokeWidth={2}
                  />
                  <text
                    x={0}
                    y={3}
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize="8.5"
                    fontWeight="700"
                    fontFamily="SF Mono, ui-monospace, monospace"
                  >
                    {shortNum}
                  </text>
                  {(isRec || isBounceHub) && (
                    <text
                      x={0}
                      y={-14}
                      textAnchor="middle"
                      fill={isRec ? '#5eead4' : '#fda4af'}
                      fontSize="9.5"
                      fontWeight="600"
                    >
                      {node.city}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px] text-slate-300 border-t border-white/[0.07]">
            <div className="flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#14b8a6] inline-block" />
                Recommended &le;45d Route
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#f43f5e] inline-block" />
                Bounce Coordinator / Loop
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#38bdf8] inline-block" />
                Bilingual + Medicaid Eligible
              </span>
            </div>
            <span className="font-mono-code text-slate-400">
              Tap #001–#030 to inspect
            </span>
          </div>
        </div>

        {/* Animated CareNode Inspector */}
        {inspectedNode && (
          <AnimatePresence mode="wait">
            <motion.div
              key={inspectedNode.provider_id}
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_DEFAULT}
              className="apple-well p-4 space-y-3.5 tabular-nums"
            >
              <div className="flex items-center justify-between">
                <span className="apple-eyebrow text-[9.5px] font-bold text-[#86868B]">
                  CareNode Inspector
                </span>
                <span className="font-mono-code text-xs font-semibold text-[#0F766E]">
                  {inspectedNode.provider_id}
                </span>
              </div>

              <div>
                <h4 className="apple-subhead text-[14px] font-semibold text-[#1D1D1F]">
                  {cleanOrgName(inspectedNode.synthetic_organization_name)}
                </h4>
                <p className="text-xs text-[#515154] mt-0.5">
                  {inspectedNode.city}, {inspectedNode.county_name} · [Synthetic]
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-white rounded-[11px] p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                  <div className="apple-eyebrow text-[9.5px] text-[#86868B] font-semibold">
                    Internal Wait
                  </div>
                  <div className="font-mono-code text-[15px] font-bold text-[#1D1D1F] mt-0.5">
                    {inspectedNode.median_internal_wait_days}d
                  </div>
                </div>
                <div className="bg-white rounded-[11px] p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                  <div className="apple-eyebrow text-[9.5px] text-[#86868B] font-semibold">
                    Waitlist
                  </div>
                  <div className="font-mono-code text-[15px] font-bold text-[#1D1D1F] mt-0.5">
                    {inspectedNode.active_waitlist_count} kids
                  </div>
                </div>
              </div>

              <div className="space-y-1.5 text-xs pt-1 border-t border-black/[0.06]">
                <div className="flex justify-between">
                  <span className="text-[#515154]">Role</span>
                  <span className="font-medium text-[#1D1D1F]">
                    {inspectedNode.node_role.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#515154]">Medicaid</span>
                  <span className="font-semibold text-[#1D1D1F]">
                    {inspectedNode.accepts_medicaid ? 'Accepted' : 'No'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#515154]">Bilingual</span>
                  <span className="font-semibold text-[#1D1D1F]">
                    {inspectedNode.bilingual_services_listed ? 'Listed' : 'No'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#515154]">Part C Vendor</span>
                  <span className="font-semibold text-[#1D1D1F]">
                    {inspectedNode.part_c_vendor_enrolled ? 'Enrolled' : 'Origin Clinic'}
                  </span>
                </div>
              </div>

              {inspectedCoordDiag && (
                <div className="rounded-[12px] bg-rose-500/10 p-3 text-xs text-rose-950 space-y-1 shadow-[inset_0_0_0_1px_rgba(244,63,94,0.22)]">
                  <div className="font-semibold flex items-center gap-1">
                    <Info className="w-3.5 h-3.5 text-rose-600" />
                    Multi-Hop Breach Reality
                  </div>
                  <p className="text-[11.5px] leading-snug">
                    Internal wait is just{' '}
                    <strong>{inspectedNode.median_internal_wait_days}d</strong>, yet{' '}
                    <strong>
                      {inspectedCoordDiag.chainsOver45d}/{inspectedCoordDiag.routedEpisodes}
                    </strong>{' '}
                    episodes ({inspectedCoordDiag.breachRatePct}%) breach 45 days (mean{' '}
                    {inspectedCoordDiag.meanEpisodeWaitDays}d, {inspectedCoordDiag.faxSharePct}%
                    fax).
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
