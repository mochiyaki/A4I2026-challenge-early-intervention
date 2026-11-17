import React, { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Pause, Play, Table2 } from 'lucide-react';
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
  EXIT_FAST_TRANSITION,
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

type GraphViewMode = 'compare' | 'breaches' | 'all' | 'table';

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
  const [filterMode, setFilterMode] = useState<GraphViewMode>('compare');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pulsePaused, setPulsePaused] = useState(false);
  const [pulseCycleKey, setPulseCycleKey] = useState(0);
  const lastRestartRef = useRef(0);

  const providerMap = useMemo(() => {
    const m = new Map<string, CareNode>();
    for (const p of providers) m.set(p.provider_id, p);
    return m;
  }, [providers]);

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

  /* Accessible Flow & Adjacency Rows (ui-ux-pro-max charts.csv A11y Fallback) */
  const accessibleFlowRows = useMemo(() => {
    return [...uniqueEdges]
      .sort((a, b) => {
        const aRec = activeEdgeKeys.has(a.key) ? 1 : 0;
        const bRec = activeEdgeKeys.has(b.key) ? 1 : 0;
        if (aRec !== bRec) return bRec - aRec;
        const aTrap = trapEdgeKeys.has(a.key) ? 1 : 0;
        const bTrap = trapEdgeKeys.has(b.key) ? 1 : 0;
        if (aTrap !== bTrap) return bTrap - aTrap;
        return b.avgWait - a.avgWait;
      })
      .slice(0, 14);
  }, [uniqueEdges, activeEdgeKeys, trapEdgeKeys]);

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

  const handleStagePointerEnter = () => {
    if (pulsePaused || reducedMotion || filterMode === 'table') return;
    const now = performance.now();
    if (now - lastRestartRef.current > 800) {
      lastRestartRef.current = now;
      setPulseCycleKey((k) => k + 1);
    }
  };

  return (
    <section
      onPointerEnter={handleStagePointerEnter}
      className="pm-card p-6 sm:p-7 space-y-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="pm-kicker">Step 3 · Network Topology</div>
          <h2 className="pm-h2 text-[20px] mt-0.5">
            {stateCode} ReferralGraph topology (30 synthetic CareNodes)
          </h2>
        </div>

        <div className="no-print overflow-x-auto max-w-full">
          <FluidSegmentedControl<GraphViewMode>
            layoutId="graph-view-segment"
            ariaLabel="Referral graph view and accessible table toggle"
            options={[
              { value: 'compare', label: 'Route vs. loop' },
              { value: 'breaches', label: 'Fax breaches' },
              { value: 'all', label: 'All 149 edges' },
              {
                value: 'table',
                label: (
                  <>
                    <Table2 aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>Accessible table</span>
                  </>
                ),
              },
            ]}
            value={filterMode}
            onChange={setFilterMode}
          />
        </div>
      </div>

      {/* Non-Color-Only Visual Legend */}
      {filterMode !== 'table' && (
        <div className="flex flex-wrap items-center gap-4 text-[12.5px] text-[var(--pm-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="w-5 h-0.5 bg-[#38BDF8] inline-block"
            />
            <span>Solid sky line: Recommended electronic route</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="w-5 border-t-2 border-dashed border-[#F87171] inline-block"
            />
            <span>Dashed red line: Paper-fax bounce chain</span>
          </span>
          <span className="text-[12px]">
            Tip: Tab or click any CareNode circle to inspect waitlists.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-5 items-start">
        {filterMode === 'table' ? (
          /* Accessible Adjacency & Hop Flow Table Fallback (charts.csv Priority Rule) */
          <div className="xl:col-span-3 pm-table-wrap">
            <table className="pm-table tabular-nums">
              <caption className="sr-only">
                {stateCode} ReferralGraph prioritized handoff edges showing recommended electronic hops and highest-delay paper-fax bounce edges
              </caption>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Source CareNode</th>
                  <th scope="col">Target CareNode</th>
                  <th scope="col">Channel</th>
                  <th scope="col" className="text-right">
                    Mean Wait
                  </th>
                </tr>
              </thead>
              <tbody>
                {accessibleFlowRows.map((edge) => {
                  const isRec = activeEdgeKeys.has(edge.key);
                  const isTrap = trapEdgeKeys.has(edge.key);
                  const srcNode = providerMap.get(edge.src);
                  const dstNode = providerMap.get(edge.dst);
                  return (
                    <tr
                      key={edge.key}
                      onClick={() => setSelectedNodeId(edge.dst)}
                      className="cursor-pointer"
                    >
                      <td>
                        {isRec ? (
                          <span className="pm-badge pm-badge-compliant">
                            <CheckCircle2 aria-hidden="true" className="w-3 h-3" />
                            <span>Active route</span>
                          </span>
                        ) : isTrap || edge.hasBounce ? (
                          <span className="pm-badge pm-badge-danger">
                            <AlertTriangle aria-hidden="true" className="w-3 h-3" />
                            <span>Fax bounce</span>
                          </span>
                        ) : (
                          <span className="pm-badge">Historical</span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedNodeId(edge.src);
                          }}
                          className="text-left hover:text-[var(--pm-accent)] cursor-pointer"
                        >
                          <div className="font-mono-code text-[12px] font-semibold text-[var(--pm-ink)]">
                            {edge.src}
                          </div>
                          <div className="text-[12px] text-[var(--pm-muted)] truncate max-w-[180px]">
                            {srcNode
                              ? cleanOrgName(srcNode.synthetic_organization_name)
                              : edge.src}
                          </div>
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedNodeId(edge.dst);
                          }}
                          className="text-left hover:text-[var(--pm-accent)] cursor-pointer"
                        >
                          <div className="font-mono-code text-[12px] font-semibold text-[var(--pm-ink)]">
                            {edge.dst}
                          </div>
                          <div className="text-[12px] text-[var(--pm-muted)] truncate max-w-[180px]">
                            {dstNode
                              ? cleanOrgName(dstNode.synthetic_organization_name)
                              : edge.dst}
                          </div>
                        </button>
                      </td>
                      <td>
                        <span className="font-mono-code text-[12px]">
                          {edge.hasFax ? 'paper_fax' : 'e-Portal / phone'}
                        </span>
                      </td>
                      <td className="text-right font-mono-code font-semibold text-[var(--pm-ink)]">
                        {edge.avgWait}d
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          /* High-Contrast Clinical Navy Topology Stage with Keyboard-Focusable CareNodes */
          <div
            className={`xl:col-span-3 pm-stage-dark relative p-3 overflow-x-auto ${
              pulsePaused ? 'pm-diagram-paused' : ''
            }`}
          >
            <svg
              viewBox="0 0 960 440"
              className="w-full min-w-[680px] h-auto select-none"
              role="group"
              aria-label={`${stateCode} multi-hop Part C referral graph showing 30 keyboard-selectable CareNodes`}
            >
              <defs>
                <marker
                  id="arrow-sky"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#38BDF8" />
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
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#F87171" />
                </marker>
              </defs>

              {ROLE_COLUMNS.map((col) => (
                <g key={col.role}>
                  <line
                    x1={col.x}
                    y1={38}
                    x2={col.x}
                    y2={418}
                    stroke="rgba(248,250,252,0.1)"
                    strokeDasharray="3 5"
                  />
                  <text
                    x={col.x}
                    y={24}
                    textAnchor="middle"
                    fill="#94A3B8"
                    fontSize="11.5"
                    fontWeight="600"
                    fontFamily="Plus Jakarta Sans, system-ui, sans-serif"
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
                      strokeOpacity={0.25}
                      strokeWidth={1}
                    />
                  );
                }

                if (
                  filterMode === 'breaches' &&
                  !edge.hasFax &&
                  !edge.hasBounce &&
                  !isRec
                ) {
                  return null;
                }

                const sameCol = Math.abs(p1.x - p2.x) < 20;
                const pathD = sameCol
                  ? `M ${p1.x} ${p1.y} C ${p1.x + 65} ${(p1.y + p2.y) / 2}, ${p2.x + 65} ${(p1.y + p2.y) / 2}, ${p2.x} ${p2.y}`
                  : `M ${p1.x} ${p1.y} C ${(p1.x + p2.x) / 2} ${p1.y}, ${(p1.x + p2.x) / 2} ${p2.y}, ${p2.x} ${p2.y}`;

                const stroke = isRec
                  ? '#38BDF8'
                  : isTrap || edge.hasBounce
                    ? '#F87171'
                    : edge.hasFax
                      ? '#FBBF24'
                      : '#64748B';

                const width = isRec ? 2.8 : isTrap ? 2.2 : edge.hasBounce ? 1.7 : 1;
                const opacity =
                  isRec || isTrap ? 0.96 : filterMode === 'all' ? 0.4 : 0.72;

                return (
                  <path
                    key={edge.key}
                    d={pathD}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={width}
                    strokeOpacity={opacity}
                    strokeDasharray={
                      !isRec && (isTrap || edge.hasFax) ? '6 4' : undefined
                    }
                    markerEnd={
                      isRec
                        ? 'url(#arrow-sky)'
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
                      stroke="#38BDF8"
                      strokeWidth={2.8}
                      markerEnd="url(#arrow-sky)"
                    />
                  );
                })}

              {!reducedMotion &&
                activeOrderedCurves.map((curve) => (
                  <path
                    key={`comet-${pulseCycleKey}-${curve.key}`}
                    d={curve.d}
                    fill="none"
                    stroke="#F8FAFC"
                    strokeWidth={3}
                    strokeLinecap="round"
                    style={{ animationDelay: `${curve.delaySec}s` }}
                    className="pm-diagram-comet pointer-events-none"
                  />
                ))}

              {Array.from(layout.values()).map(({ x, y, node }) => {
                const isRec = activeNodeIds.has(node.provider_id);
                const isBounceHub = topBounceHubIds.has(node.provider_id);
                const isSelected = inspectedNode?.provider_id === node.provider_id;
                const shortNum = node.provider_id.slice(-3);

                const fill = isRec
                  ? '#0284C7'
                  : isBounceHub
                    ? '#DC2626'
                    : node.bilingual_services_listed && node.accepts_medicaid
                      ? '#334155'
                      : '#1E293B';

                return (
                  <g
                    key={node.provider_id}
                    transform={`translate(${x}, ${y})`}
                    tabIndex={0}
                    role="button"
                    aria-label={`${cleanOrgName(node.synthetic_organization_name)} (${node.provider_id}), ${node.city}, internal wait ${node.median_internal_wait_days} days${isRec ? ', active recommended node' : ''}${isBounceHub ? ', high-breach fax hub' : ''}`}
                    onClick={() => {
                      triggerCausalHaptic(4);
                      setSelectedNodeId(node.provider_id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedNodeId(node.provider_id);
                      }
                    }}
                    className="cursor-pointer focus:outline-none"
                  >
                    <circle r={18} fill="transparent" />
                    {isBounceHub && !isRec && (
                      <circle
                        r={13}
                        fill="none"
                        stroke="#FCA5A5"
                        strokeDasharray="3 2"
                        strokeWidth={1.3}
                      />
                    )}
                    {isSelected && (
                      <circle
                        r={15.5}
                        fill="none"
                        stroke="#38BDF8"
                        strokeWidth={2}
                      />
                    )}
                    <circle
                      r={isRec ? 11.5 : 8.5}
                      fill={fill}
                      stroke={isRec ? '#F8FAFC' : '#0F172A'}
                      strokeWidth={1.8}
                    />
                    <text
                      x={0}
                      y={3}
                      textAnchor="middle"
                      fill="#F8FAFC"
                      fontSize="8.5"
                      fontWeight="600"
                      fontFamily="Fira Code, ui-monospace, monospace"
                    >
                      {shortNum}
                    </text>
                    {(isRec || isBounceHub) && (
                      <text
                        x={0}
                        y={-15}
                        textAnchor="middle"
                        fill={isRec ? '#BAE6FD' : '#FECACA'}
                        fontSize="10"
                        fontWeight="600"
                        fontFamily="Plus Jakarta Sans, system-ui, sans-serif"
                      >
                        {node.city}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>

            {!reducedMotion && (
              <button
                type="button"
                aria-label={pulsePaused ? 'Play route pulse' : 'Pause route pulse'}
                aria-pressed={pulsePaused}
                title={pulsePaused ? 'Play route pulse' : 'Pause route pulse'}
                onClick={() => setPulsePaused((p) => !p)}
                className="no-print absolute bottom-3 right-3 w-9 h-9 rounded-full bg-[#1E293B] hover:bg-[#334155] text-[#F8FAFC] border border-[rgba(248,250,252,0.24)] flex items-center justify-center cursor-pointer touch-manipulation transition-colors"
              >
                {pulsePaused ? (
                  <Play aria-hidden="true" className="w-3.5 h-3.5 translate-x-[0.5px]" />
                ) : (
                  <Pause aria-hidden="true" className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>
        )}

        {/* CareNode Inspector Panel */}
        {inspectedNode && (
          <AnimatePresence mode="wait">
            <motion.div
              key={inspectedNode.provider_id}
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={
                reducedMotion
                  ? { opacity: 0, transition: REDUCED_MOTION_TRANSITION }
                  : { opacity: 0, y: -4, transition: EXIT_FAST_TRANSITION }
              }
              transition={reducedMotion ? REDUCED_MOTION_TRANSITION : SPRING_DEFAULT}
              className="pm-panel p-5 space-y-4 tabular-nums"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="pm-kicker">CareNode Inspector</span>
                <span className="font-mono-code text-[12px] font-semibold text-[var(--pm-accent)]">
                  {inspectedNode.provider_id}
                </span>
              </div>

              <div>
                <h3 className="pm-h3 text-[15px] leading-snug">
                  {cleanOrgName(inspectedNode.synthetic_organization_name)}
                </h3>
                <p className="text-[13px] text-[var(--pm-muted)] mt-0.5">
                  {inspectedNode.city}, {inspectedNode.county_name}
                </p>
              </div>

              <dl className="grid grid-cols-2 gap-3 py-3 border-y border-[var(--pm-border)]">
                <div>
                  <dt className="text-[11.5px] text-[var(--pm-muted)] font-medium">
                    Internal wait
                  </dt>
                  <dd className="font-mono-code text-[18px] font-semibold text-[var(--pm-ink)] mt-0.5">
                    {inspectedNode.median_internal_wait_days}d
                  </dd>
                </div>
                <div className="border-l border-[var(--pm-border)] pl-3">
                  <dt className="text-[11.5px] text-[var(--pm-muted)] font-medium">
                    Active waitlist
                  </dt>
                  <dd className="font-mono-code text-[18px] font-semibold text-[var(--pm-ink)] mt-0.5">
                    {inspectedNode.active_waitlist_count} kids
                  </dd>
                </div>
              </dl>

              <dl className="space-y-2 text-[13px]">
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--pm-muted)]">Role</dt>
                  <dd className="font-semibold text-[var(--pm-ink)] text-right">
                    {inspectedNode.node_role.replace(/_/g, ' ')}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--pm-muted)]">Medicaid</dt>
                  <dd className="font-semibold text-[var(--pm-ink)]">
                    {inspectedNode.accepts_medicaid ? 'Accepted' : 'Not listed'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--pm-muted)]">Bilingual eval</dt>
                  <dd className="font-semibold text-[var(--pm-ink)]">
                    {inspectedNode.bilingual_services_listed
                      ? 'Available'
                      : 'English only'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[var(--pm-muted)]">Part C status</dt>
                  <dd className="font-semibold text-[var(--pm-ink)]">
                    {inspectedNode.part_c_vendor_enrolled
                      ? 'Enrolled vendor'
                      : 'Screening clinic'}
                  </dd>
                </div>
              </dl>

              {inspectedCoordDiag && (
                <div className="p-3 rounded-[9px] bg-[var(--pm-danger-soft)] border border-[var(--pm-danger-border)] text-[12.5px] text-[var(--pm-ink)] space-y-1">
                  <div className="font-semibold text-[var(--pm-danger)] flex items-center gap-1.5">
                    <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5" />
                    <span>
                      Downstream breach rate: {inspectedCoordDiag.breachRatePct}%
                    </span>
                  </div>
                  <p className="text-[var(--pm-muted)] leading-relaxed">
                    {inspectedCoordDiag.chainsOver45d} of{' '}
                    {inspectedCoordDiag.routedEpisodes} episodes exceeded 45 days (mean{' '}
                    {inspectedCoordDiag.meanEpisodeWaitDays}d;{' '}
                    {inspectedCoordDiag.faxSharePct}% paper fax).
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
