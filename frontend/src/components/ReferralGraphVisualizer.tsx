import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileWarning,
  MapPin,
  Network,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { CandidatePathway, CareNode } from '../types/partC';
import { CA_DATASET, cleanOrgName } from '../engine/referralGraphEngine';

interface Props {
  recommendedPath: CandidatePathway;
  bounceTrapPath: CandidatePathway;
  childAgeMonths: number;
}

const ROLE_LABELS: Record<CareNode['node_role'], { short: string; step: string }> = {
  Screening_Pediatric_Clinic: { short: '1. Screening Clinic', step: 'Origin' },
  Part_C_Intake_Coordinator: { short: '2. Part C Coordinator', step: 'Intake Hub' },
  Multidisciplinary_Eval_Hub: { short: '3. Multidisciplinary Eval Hub', step: 'Bilingual Eval' },
  EI_Therapy_Vendor: { short: '4. EI Therapy Vendor', step: 'IFSP Services' },
};

export const ReferralGraphVisualizer: React.FC<Props> = ({
  recommendedPath,
  bounceTrapPath,
  childAgeMonths,
}) => {
  const [viewMode, setViewMode] = useState<'comparison' | 'topology'>('comparison');
  const [selectedNode, setSelectedNode] = useState<CareNode | null>(
    recommendedPath.nodes[2] || recommendedPath.nodes[1] || null
  );

  const maxTimelineDays = Math.max(80, bounceTrapPath.totalWaitDays + 6);
  const statutoryPct = (45 / maxTimelineDays) * 100;

  const recIds = new Set(recommendedPath.nodes.map((n) => n.provider_id));
  const trapIds = new Set(bounceTrapPath.nodes.map((n) => n.provider_id));

  const rolesOrder: CareNode['node_role'][] = [
    'Screening_Pediatric_Clinic',
    'Part_C_Intake_Coordinator',
    'Multidisciplinary_Eval_Hub',
    'EI_Therapy_Vendor',
  ];

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 text-white">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-emerald-500/20 border border-emerald-400/30">
            <Network className="w-5 h-5 text-emerald-300" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold tracking-tight">
                Multi-Hop ReferralGraph Pathway vs. 45-Day IDEA Part C Statutory Clock
              </h2>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-white/10 text-indigo-200 border border-white/15">
                a4i_early_intervention.ReferralGraph
              </span>
            </div>
            <p className="text-xs text-slate-300 mt-0.5">
              Comparing compliant electronic Medi-Cal + Bilingual trajectory against historical{' '}
              <span className="font-mono text-rose-300">{bounceTrapPath.pathId}</span> paper-fax bounce chain
            </p>
          </div>
        </div>

        <div className="flex items-center bg-white/10 p-1 rounded-lg border border-white/15 text-xs">
          <button
            type="button"
            onClick={() => setViewMode('comparison')}
            className={`px-3 py-1.5 rounded-md font-medium transition ${
              viewMode === 'comparison'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-200 hover:text-white'
            }`}
          >
            Pathway Comparison
          </button>
          <button
            type="button"
            onClick={() => setViewMode('topology')}
            className={`px-3 py-1.5 rounded-md font-medium transition ${
              viewMode === 'topology'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-200 hover:text-white'
            }`}
          >
            30-Node CA Graph
          </button>
        </div>
      </div>

      {/* Dual 45-Day Statutory Clock Bars */}
      <div className="p-5 bg-slate-50/80 border-b border-slate-200 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 font-semibold text-slate-700">
            <Clock className="w-4 h-4 text-indigo-600" />
            <span>Federal Statutory Ceiling (34 CFR § 303.310): Evaluation + Initial IFSP &le; 45 Calendar Days</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5 text-emerald-700 font-semibold">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              Recommended: {recommendedPath.totalWaitDays}d ({recommendedPath.daysBufferUnder45}d buffer)
            </span>
            <span className="inline-flex items-center gap-1.5 text-rose-700 font-semibold">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
              Fax Bounce Trap: {bounceTrapPath.totalWaitDays}d (+{Math.round(bounceTrapPath.totalWaitDays - 45)}d breach)
            </span>
          </div>
        </div>

        <div className="relative pt-2 pb-1 space-y-3">
          {/* Vertical 45-Day Federal Deadline Line */}
          <div
            className="absolute top-0 bottom-0 border-l-2 border-dashed border-slate-900 z-10 pointer-events-none"
            style={{ left: `${statutoryPct}%` }}
          >
            <span className="absolute -top-1 -translate-x-1/2 bg-slate-900 text-white text-[10px] font-mono font-bold px-2 py-0.5 rounded shadow">
              DAY 45 FEDERAL LIMIT
            </span>
          </div>

          {/* Bar 1: Recommended Electronic Route */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="font-semibold text-emerald-800 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                Recommended {recommendedPath.hops.length}-Hop Electronic Portal Route
              </span>
              <span className="font-mono font-bold text-emerald-700">
                {recommendedPath.totalWaitDays} / 45 days
              </span>
            </div>
            <div className="h-7 w-full bg-slate-200/80 rounded-lg overflow-hidden flex p-0.5 gap-0.5">
              {recommendedPath.hops.map((hop, idx) => {
                const widthPct = (hop.expectedWaitDays / maxTimelineDays) * 100;
                const shades = ['bg-emerald-500', 'bg-teal-600', 'bg-emerald-700'];
                return (
                  <div
                    key={hop.hopIndex}
                    style={{ width: `${widthPct}%` }}
                    className={`${shades[idx % shades.length]} h-full rounded text-[10px] font-mono font-semibold text-white flex items-center justify-center px-1.5 truncate shadow-sm`}
                    title={`Hop ${hop.hopIndex}: ${hop.fromNode.provider_id} -> ${hop.toNode.provider_id} (${hop.expectedWaitDays}d via ${hop.transmissionChannel})`}
                  >
                    Hop {hop.hopIndex}: +{hop.expectedWaitDays}d
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bar 2: Historical Paper-Fax Bounce Loop */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="font-semibold text-rose-800 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
                Avoided {bounceTrapPath.hops.length}-Hop Paper-Fax Bounce Loop ({bounceTrapPath.pathId})
              </span>
              <span className="font-mono font-bold text-rose-700">
                {bounceTrapPath.totalWaitDays} days (BREACHES CLOCK
                {childAgeMonths + bounceTrapPath.totalWaitDays / 30.4 >= 36
                  ? ' + AGES OUT AT 36m!'
                  : ')'}
              </span>
            </div>
            <div className="h-7 w-full bg-slate-200/80 rounded-lg overflow-hidden flex p-0.5 gap-0.5">
              {bounceTrapPath.hops.map((hop, idx) => {
                const widthPct = (hop.expectedWaitDays / maxTimelineDays) * 100;
                const isBounce = hop.handoffReason.startsWith('Re-Referral Bounce');
                const shades = isBounce
                  ? 'bg-rose-700 ring-1 ring-rose-300'
                  : idx < 2
                    ? 'bg-amber-600'
                    : 'bg-rose-600';
                return (
                  <div
                    key={hop.hopIndex}
                    style={{ width: `${widthPct}%` }}
                    className={`${shades} h-full rounded text-[10px] font-mono font-semibold text-white flex items-center justify-center px-1.5 truncate`}
                    title={`Hop ${hop.hopIndex}: ${hop.fromNode.provider_id} -> ${hop.toNode.provider_id} (${hop.expectedWaitDays}d via ${hop.transmissionChannel} — ${hop.handoffReason})`}
                  >
                    {isBounce ? `Bounce: +${hop.expectedWaitDays}d` : `Hop ${hop.hopIndex}: +${hop.expectedWaitDays}d`}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Main Visual Area */}
      {viewMode === 'comparison' ? (
        <div className="p-5 space-y-5">
          {/* Recommended Electronic Path Cards */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" />
                Active Triage Route · Clears 45-Day Clock ({recommendedPath.totalWaitDays} Days Expected)
              </span>
              <span className="text-[11px] text-slate-500">
                Click any CareNode vertex to inspect synthetic directory metadata
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
              {recommendedPath.nodes.map((node, idx) => {
                const inboundHop = idx > 0 ? recommendedPath.hops[idx - 1] : null;
                const isSelected = selectedNode?.provider_id === node.provider_id;
                return (
                  <div key={`${node.provider_id}-${idx}`} className="relative flex flex-col">
                    {inboundHop && (
                      <div className="mb-1.5 flex items-center justify-between text-[11px] bg-emerald-50 border border-emerald-200 text-emerald-800 px-2.5 py-1 rounded-md font-mono">
                        <span>
                          Hop {inboundHop.hopIndex} · EHR Portal
                        </span>
                        <span className="font-bold">
                          +{inboundHop.expectedWaitDays}d (Day {inboundHop.cumulativeWaitDays})
                        </span>
                      </div>
                    )}
                    {!inboundHop && (
                      <div className="mb-1.5 flex items-center justify-between text-[11px] bg-slate-100 border border-slate-200 text-slate-700 px-2.5 py-1 rounded-md font-mono">
                        <span>Day 0 · Referral Origin</span>
                        <span className="font-semibold">Screen Complete</span>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => setSelectedNode(node)}
                      className={`text-left flex-1 p-3.5 rounded-xl border-2 transition-all ${
                        isSelected
                          ? 'border-emerald-600 bg-emerald-50/40 shadow-sm'
                          : 'border-emerald-200 hover:border-emerald-400 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                          {ROLE_LABELS[node.node_role].short}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                          {node.provider_id}
                        </span>
                      </div>
                      <p className="text-xs font-bold text-slate-900 leading-snug line-clamp-2">
                        {cleanOrgName(node.synthetic_organization_name)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            node.accepts_medicaid
                              ? 'bg-blue-50 text-blue-700 border border-blue-200'
                              : 'bg-rose-50 text-rose-700'
                          }`}
                        >
                          {node.accepts_medicaid ? 'Medi-Cal ✓' : 'No Medi-Cal'}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            node.bilingual_services_listed
                              ? 'bg-violet-50 text-violet-700 border border-violet-200'
                              : 'bg-amber-50 text-amber-700 border border-amber-200'
                          }`}
                        >
                          {node.bilingual_services_listed ? 'Bilingual ✓' : 'English-Only'}
                        </span>
                        {idx > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                            Part C ✓
                          </span>
                        )}
                      </div>
                      <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-slate-400" />
                          {node.city}
                          {inboundHop ? ` · ${inboundHop.distanceFromHomeKm} km` : ''}
                        </span>
                        <span className="font-mono text-slate-600">
                          WL:{node.active_waitlist_count}
                        </span>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Avoided Bounce Chain Trace */}
          <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="text-xs font-bold text-rose-800 flex items-center gap-1.5">
                <FileWarning className="w-4 h-4 text-rose-600" />
                Why Graph Traversal Was Necessary: Historical 4-Hop Paper-Fax Bounce ({bounceTrapPath.pathId} · {bounceTrapPath.totalWaitDays} Days)
              </span>
              <span className="text-[11px] font-mono text-rose-700 bg-rose-100 px-2 py-0.5 rounded">
                Correlated on case_chain_id across -{`{2,4}`}→ hops
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {bounceTrapPath.nodes.map((n, i) => {
                const hop = i > 0 ? bounceTrapPath.hops[i - 1] : null;
                return (
                  <React.Fragment key={`${n.provider_id}-trap-${i}`}>
                    {hop && (
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[11px] ${
                          hop.transmissionChannel === 'paper_fax'
                            ? 'bg-rose-200/80 text-rose-900 font-semibold'
                            : 'bg-slate-200 text-slate-700'
                        }`}
                      >
                        → {hop.transmissionChannel} (+{hop.expectedWaitDays}d) →
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedNode(n)}
                      className="px-2.5 py-1 rounded-lg bg-white border border-rose-200 hover:border-rose-400 text-slate-800 font-medium shadow-sm"
                    >
                      <span className="font-mono text-[11px] text-rose-700 mr-1">
                        {n.provider_id.replace('SYN-PROV-CA-', '#')}
                      </span>
                      {ROLE_LABELS[n.node_role].step} ({n.city}
                      {!n.bilingual_services_listed ? ' · No Bilingual!' : `, WL:${n.active_waitlist_count}`})
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Full 30-Node Homogeneous CareNode Graph Matrix */
        <div className="p-5">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {rolesOrder.map((role) => {
              const nodes = CA_DATASET.pediatric_and_ei_provider_directory.filter(
                (p) => p.node_role === role
              );
              return (
                <div key={role} className="bg-slate-50 rounded-xl p-3 border border-slate-200">
                  <div className="text-xs font-bold text-slate-800 mb-2 flex items-center justify-between">
                    <span>{ROLE_LABELS[role].short}</span>
                    <span className="font-mono text-[11px] text-slate-500">{nodes.length} nodes</span>
                  </div>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                    {nodes.map((n) => {
                      const onRec = recIds.has(n.provider_id);
                      const onTrap = trapIds.has(n.provider_id);
                      return (
                        <button
                          key={n.provider_id}
                          type="button"
                          onClick={() => setSelectedNode(n)}
                          className={`w-full text-left p-2 rounded-lg border text-xs transition ${
                            onRec
                              ? 'bg-emerald-50 border-emerald-400 ring-1 ring-emerald-300'
                              : onTrap
                                ? 'bg-rose-50 border-rose-300'
                                : 'bg-white border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <div className="flex items-center justify-between font-mono text-[10px]">
                            <span className="font-bold text-slate-700">{n.provider_id}</span>
                            <span>
                              Wait:{n.median_internal_wait_days}d · WL:{n.active_waitlist_count}
                            </span>
                          </div>
                          <div className="font-medium text-slate-900 truncate mt-0.5">
                            {cleanOrgName(n.synthetic_organization_name)}
                          </div>
                          <div className="flex gap-1 mt-1 text-[10px]">
                            {onRec && (
                              <span className="px-1.5 rounded bg-emerald-600 text-white font-semibold">
                                Recommended
                              </span>
                            )}
                            {!onRec && onTrap && (
                              <span className="px-1.5 rounded bg-rose-600 text-white font-semibold">
                                Bounce Path
                              </span>
                            )}
                            {n.bilingual_services_listed && (
                              <span className="px-1 rounded bg-violet-100 text-violet-800">ES/EN</span>
                            )}
                            {n.accepts_medicaid && (
                              <span className="px-1 rounded bg-blue-100 text-blue-800">Medi-Cal</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected CareNode Inspector Footer */}
      {selectedNode && (
        <div className="px-5 py-3 bg-slate-900 text-slate-200 text-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="font-mono text-emerald-300 font-semibold">
              {selectedNode.provider_id}
            </span>
            <span className="font-semibold text-white">
              {selectedNode.synthetic_organization_name}
            </span>
            <span className="text-slate-400 hidden sm:inline">
              · {selectedNode.synthetic_address}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
            <span>Internal Med Wait: {selectedNode.median_internal_wait_days}d</span>
            <span>Active Waitlist: {selectedNode.active_waitlist_count}</span>
            <span>Monthly Cap: {selectedNode.monthly_slot_capacity}</span>
            <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-400/30">
              100% [Synthetic] Vertex
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
