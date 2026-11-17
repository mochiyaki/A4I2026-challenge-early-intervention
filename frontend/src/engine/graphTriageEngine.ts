import rawBundle from '../data/starterData.json';
import type {
  BounceHubSummary,
  CandidatePathway,
  CareNode,
  EquityAuditGroup,
  HistoricalChainTrace,
  NschStratum,
  PartCAgency,
  PathStep,
  ReferralHandoff,
  ReferralIntakeInput,
  StarterDataBundle,
  StateCode,
  TractDemographic,
  TransmissionChannel,
} from '../types';

const DATA = rawBundle as unknown as StarterDataBundle;

export const STATE_META: Record<
  StateCode,
  { name: string; fips: string; regionNote: string; osepRange: string }
> = {
  MS: {
    name: 'Mississippi',
    fips: '28',
    regionNote: 'Steepest rural Delta 45-day IFSP deficit (52.5%)',
    osepRange: '52.5% – 65.8%',
  },
  AL: {
    name: 'Alabama',
    fips: '01',
    regionNote: 'Leading-zero FIPS (01) · Rural Black Belt access strain',
    osepRange: '54.5% – 71.6%',
  },
  GA: {
    name: 'Georgia',
    fips: '13',
    regionNote: 'South Georgia rural intake vs. metro evaluation capacity',
    osepRange: '56.4% – 70.7%',
  },
  TX: {
    name: 'Texas',
    fips: '48',
    regionNote: 'High Spanish-bilingual demand & long border/rural distances',
    osepRange: '57.6% – 70.9%',
  },
  CA: {
    name: 'California',
    fips: '06',
    regionNote: 'Leading-zero FIPS (06) · 41,144 children under 5 across 101 tracts',
    osepRange: '61.7% – 74.9%',
  },
  NY: {
    name: 'New York',
    fips: '36',
    regionNote: 'Urban Bronx catch-up strain rivals rural northern catchments',
    osepRange: '55.2% – 58.3%',
  },
};

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371.0;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

export function cleanOrgName(name: string): string {
  return name.replace(/\s*\[Synthetic\]\s*/gi, '').trim();
}

export function getStateData(stateCode: StateCode) {
  const tracts = DATA.tracts
    .filter((t) => t.state_code === stateCode)
    .sort((a, b) =>
      a.county_name === b.county_name
        ? b.children_under_5_count - a.children_under_5_count
        : a.county_name.localeCompare(b.county_name)
    );
  const providers = DATA.providers.filter((p) => p.state_code === stateCode);
  const referrals = DATA.referrals.filter((r) => r.state_code === stateCode);
  const agencies = DATA.agencies.filter((a) => a.state_code === stateCode);
  // Strictly Statewide grain (6 strata per state — never join raw on state_code to tracts!)
  const nsch = DATA.nsch.filter(
    (n) => n.state_code === stateCode && n.geographic_level === 'Statewide'
  );

  const zeroLepCount = tracts.filter((t) => t.limited_english_rate === 0).length;

  return {
    tracts,
    providers,
    referrals,
    agencies,
    nsch,
    integrity: {
      tractCount: tracts.length,
      zeroLepTrapDetected: zeroLepCount === tracts.length,
      zeroLepRatio: `${zeroLepCount}/${tracts.length}`,
      nschStatewideStrataCount: nsch.length,
      leadingZeroIntact: tracts.every((t) => t.census_tract_geoid.length === 11),
      syntheticNodesVerified: providers.every((p) =>
        p.provider_id.startsWith('SYN-PROV-')
      ),
    },
  };
}

/**
 * Reconstructs historical referral chains strictly correlated on `case_chain_id`
 * (`COUNT(DISTINCT h.case_chain_id) = 1` across variable-length 2..4 hops).
 */
export function reconstructHistoricalChains(
  providers: CareNode[],
  referrals: ReferralHandoff[]
): HistoricalChainTrace[] {
  const provMap = new Map(providers.map((p) => [p.provider_id, p]));
  const byChain = new Map<string, ReferralHandoff[]>();
  for (const r of referrals) {
    const arr = byChain.get(r.case_chain_id) || [];
    arr.push(r);
    byChain.set(r.case_chain_id, arr);
  }

  const traces: HistoricalChainTrace[] = [];
  for (const [caseChainId, rawHops] of byChain.entries()) {
    const sorted = [...rawHops].sort((a, b) => a.hop_sequence - b.hop_sequence);
    let cum = 0;
    const hops = sorted
      .map((h) => {
        const source = provMap.get(h.source_provider_id);
        const target = provMap.get(h.target_provider_id);
        if (!source || !target) return null;
        cum += h.handoff_wait_days;
        return {
          hopSequence: h.hop_sequence,
          source,
          target,
          channel: h.transmission_channel,
          waitDays: h.handoff_wait_days,
          cumulativeDays: cum,
          reason: h.handoff_reason,
          dropoffPct: Math.round(h.dropoff_rate_pct * 1000) / 10,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (hops.length === 0) continue;
    const first = sorted[0];
    traces.push({
      caseChainId,
      childAgeMonths: first.child_age_months,
      concernDomain: first.concern_domain,
      homeTractGeoid: first.child_home_tract_geoid,
      hops,
      totalWaitDays: cum,
      breached45d: cum > 45,
      faxHopCount: hops.filter((h) => h.channel === 'paper_fax').length,
      hadBounce: hops.some((h) => h.reason.startsWith('Re-Referral Bounce')),
    });
  }

  return traces.sort((a, b) => b.totalWaitDays - a.totalWaitDays);
}

/**
 * Diagnoses `Part_C_Intake_Coordinator` bounce hubs by contrasting flat
 * `median_internal_wait_days` against multi-hop >45d episode breaches,
 * and computes counterfactual savings if upgraded from `paper_fax` to `ehr_electronic_portal`.
 */
export function computeBounceHubDiagnostics(
  providers: CareNode[],
  chains: HistoricalChainTrace[]
): BounceHubSummary[] {
  const coords = providers.filter(
    (p) => p.node_role === 'Part_C_Intake_Coordinator'
  );

  return coords
    .map((coord) => {
      const routed = chains.filter(
        (c) => c.hops[0]?.target.provider_id === coord.provider_id
      );
      const n = routed.length;
      const chains3Plus = routed.filter((c) => c.hops.length >= 3).length;
      const over45 = routed.filter((c) => c.breached45d).length;
      const meanWait =
        n > 0
          ? Math.round(
              (routed.reduce((s, c) => s + c.totalWaitDays, 0) / n) * 10
            ) / 10
          : 0;

      const totalHops = routed.reduce((s, c) => s + c.hops.length, 0);
      const totalFax = routed.reduce((s, c) => s + c.faxHopCount, 0);
      const faxSharePct =
        totalHops > 0 ? Math.round((totalFax / totalHops) * 100) : 0;

      // Counterfactual simulation: switching paper_fax handoffs (~6.2d saved/fax hop)
      // + eliminating preventable bilingual/Medicaid bounce hop (~19-24d saved on 4-hop bounce)
      let savedChains = 0;
      let savedChildDays = 0;
      for (const c of routed) {
        const faxSavings = c.faxHopCount * 6;
        const bounceHop =
          c.hops.length === 4 && c.hadBounce ? c.hops[2]?.waitDays ?? 18 : 0;
        const reduction = faxSavings + bounceHop;
        if (reduction > 0) {
          savedChildDays += reduction;
          const newTotal = c.totalWaitDays - reduction;
          if (c.totalWaitDays > 45 && newTotal <= 45) {
            savedChains += 1;
          }
        }
      }

      return {
        coordinator: coord,
        routedEpisodes: n,
        chains3PlusHops: chains3Plus,
        chainsOver45d: over45,
        breachRatePct: n > 0 ? Math.round((over45 / n) * 100) : 0,
        meanEpisodeWaitDays: meanWait,
        faxSharePct,
        counterfactualSavedChains: savedChains,
        counterfactualSavedChildDays: savedChildDays,
      };
    })
    .sort(
      (a, b) =>
        b.chainsOver45d - a.chainsOver45d ||
        b.meanEpisodeWaitDays - a.meanEpisodeWaitDays
    );
}

interface EdgeStats {
  avgWaitDays: number;
  minEhrWaitDays: number | null;
  dominantChannel: TransmissionChannel;
  hasEhrOption: boolean;
  bounceCount: number;
  count: number;
}

/**
 * Prospective <=45-day CareNode pathway router for Today's Toddler Referral.
 *
 * STRICT FAIRNESS INVARIANT:
 * `audit_*` demographic columns are NEVER read or referenced in routing!
 * Routing uses ONLY clinical eligibility (Medicaid, Part C enrollment, bilingual
 * capability), multi-hop ReferralGraph handoff wait times, and Haversine travel distance.
 */
export function findPathwaysForReferral(
  intake: ReferralIntakeInput,
  tract: TractDemographic,
  providers: CareNode[],
  referrals: ReferralHandoff[],
  chains: HistoricalChainTrace[]
): {
  recommended: CandidatePathway | null;
  alternatives: CandidatePathway[];
  historicalTrapChain: HistoricalChainTrace | null;
  nearestClinic: CareNode | null;
} {
  const bilingualNeeded = intake.primaryLanguage !== 'English';

  // Index observed directed edge statistics across the ReferralGraph
  const edgeMap = new Map<string, EdgeStats>();
  const byPair = new Map<string, ReferralHandoff[]>();
  for (const r of referrals) {
    const key = `${r.source_provider_id}__${r.target_provider_id}`;
    const list = byPair.get(key) || [];
    list.push(r);
    byPair.set(key, list);
  }
  for (const [key, list] of byPair.entries()) {
    const ehrRows = list.filter(
      (x) => x.transmission_channel === 'ehr_electronic_portal'
    );
    const faxRows = list.filter((x) => x.transmission_channel === 'paper_fax');
    const avgAll =
      list.reduce((s, x) => s + x.handoff_wait_days, 0) / list.length;
    const minEhr =
      ehrRows.length > 0
        ? Math.round(
            ehrRows.reduce((s, x) => s + x.handoff_wait_days, 0) / ehrRows.length
          )
        : null;
    const dominantChannel: TransmissionChannel =
      ehrRows.length >= faxRows.length
        ? ehrRows.length > 0
          ? 'ehr_electronic_portal'
          : list[0].transmission_channel
        : 'paper_fax';
    edgeMap.set(key, {
      avgWaitDays: Math.round(avgAll),
      minEhrWaitDays: minEhr,
      dominantChannel,
      hasEhrOption: ehrRows.length > 0,
      bounceCount: list.filter((x) =>
        x.handoff_reason.startsWith('Re-Referral Bounce')
      ).length,
      count: list.length,
    });
  }

  const clinics = providers
    .filter((p) => p.node_role === 'Screening_Pediatric_Clinic')
    .sort(
      (a, b) =>
        haversineKm(tract.latitude, tract.longitude, a.latitude, a.longitude) -
        haversineKm(tract.latitude, tract.longitude, b.latitude, b.longitude)
    );

  const coords = providers.filter(
    (p) => p.node_role === 'Part_C_Intake_Coordinator'
  );
  const evalHubs = providers.filter(
    (p) => p.node_role === 'Multidisciplinary_Eval_Hub'
  );
  const vendors = providers.filter((p) => p.node_role === 'EI_Therapy_Vendor');

  const nearestClinic = clinics[0] ?? null;
  // Consider top 3 nearest pediatric screening clinics as entry points from the child's neighborhood
  const originClinics = clinics.slice(0, 3);

  function estimateHop(
    src: CareNode,
    dst: CareNode,
    simulateEhr: boolean
  ): { waitDays: number; channel: TransmissionChannel; observed: boolean } {
    const key = `${src.provider_id}__${dst.provider_id}`;
    const st = edgeMap.get(key);
    if (st) {
      if (st.minEhrWaitDays !== null) {
        return {
          waitDays: st.minEhrWaitDays,
          channel: 'ehr_electronic_portal',
          observed: true,
        };
      }
      if (simulateEhr && st.dominantChannel === 'paper_fax') {
        return {
          waitDays: Math.max(6, st.avgWaitDays - 6),
          channel: 'ehr_electronic_portal',
          observed: true,
        };
      }
      return {
        waitDays: st.avgWaitDays,
        channel: st.dominantChannel,
        observed: true,
      };
    }

    // Prospective graph edge estimate from destination internal wait + e-referral intake baseline
    const baseWait =
      dst.node_role === 'Part_C_Intake_Coordinator'
        ? Math.max(5, dst.median_internal_wait_days + 3)
        : dst.node_role === 'Multidisciplinary_Eval_Hub'
          ? Math.max(12, Math.round(dst.median_internal_wait_days * 0.85))
          : Math.max(9, Math.round(dst.median_internal_wait_days * 0.8));
    return {
      waitDays: baseWait,
      channel: 'ehr_electronic_portal',
      observed: false,
    };
  }

  const candidates: CandidatePathway[] = [];

  for (const clinic of originClinics) {
    if (intake.insuranceMedicaid && !clinic.accepts_medicaid) continue;

    for (const coord of coords) {
      if (!coord.part_c_vendor_enrolled) continue;
      if (intake.insuranceMedicaid && !coord.accepts_medicaid) continue;
      if (bilingualNeeded && !coord.bilingual_services_listed) continue;

      // Prefer observed clinic->coord links or nearby coordinator
      const hop1 = estimateHop(clinic, coord, intake.simulateEhrUpgrade);

      for (const evalHub of evalHubs) {
        if (!evalHub.part_c_vendor_enrolled) continue;
        if (intake.insuranceMedicaid && !evalHub.accepts_medicaid) continue;
        if (bilingualNeeded && !evalHub.bilingual_services_listed) continue;

        const hop2 = estimateHop(coord, evalHub, intake.simulateEhrUpgrade);

        // Pick top 2 best-matching compliant EI_Therapy_Vendors near the child's home tract
        const eligibleVendors = vendors
          .filter((v) => {
            if (!v.part_c_vendor_enrolled) return false;
            if (intake.insuranceMedicaid && !v.accepts_medicaid) return false;
            if (bilingualNeeded && !v.bilingual_services_listed) return false;
            return true;
          })
          .sort((a, b) => {
            const distA = haversineKm(
              tract.latitude,
              tract.longitude,
              a.latitude,
              a.longitude
            );
            const distB = haversineKm(
              tract.latitude,
              tract.longitude,
              b.latitude,
              b.longitude
            );
            return (
              a.median_internal_wait_days +
              distA * 0.12 -
              (b.median_internal_wait_days + distB * 0.12)
            );
          })
          .slice(0, 2);

        for (const vendor of eligibleVendors) {
          const hop3 = estimateHop(evalHub, vendor, intake.simulateEhrUpgrade);

          // Restrict to realistic connected pathways (at least 2 observed graph edges or top local coordinator)
          const observedCount =
            (hop1.observed ? 1 : 0) +
            (hop2.observed ? 1 : 0) +
            (hop3.observed ? 1 : 0);
          if (observedCount < 2 && candidates.length > 6) continue;

          const dClinic = haversineKm(
            tract.latitude,
            tract.longitude,
            clinic.latitude,
            clinic.longitude
          );
          const dCoord = haversineKm(
            tract.latitude,
            tract.longitude,
            coord.latitude,
            coord.longitude
          );
          const dEval = haversineKm(
            tract.latitude,
            tract.longitude,
            evalHub.latitude,
            evalHub.longitude
          );
          const dVendor = haversineKm(
            tract.latitude,
            tract.longitude,
            vendor.latitude,
            vendor.longitude
          );

          const c1 = hop1.waitDays;
          const c2 = c1 + hop2.waitDays;
          const c3 = c2 + hop3.waitDays;

          const steps: PathStep[] = [
            {
              stepNumber: 0,
              node: clinic,
              distanceFromHomeKm: dClinic,
              legDistanceKm: dClinic,
              expectedStepWaitDays: 0,
              cumulativeDays: 0,
              handoffNote: 'Origin Developmental Screening Referral (Day 0 clock start)',
            },
            {
              stepNumber: 1,
              node: coord,
              distanceFromHomeKm: dCoord,
              legDistanceKm: haversineKm(
                clinic.latitude,
                clinic.longitude,
                coord.latitude,
                coord.longitude
              ),
              channelIn: hop1.channel,
              expectedStepWaitDays: hop1.waitDays,
              cumulativeDays: c1,
              handoffNote: 'Part C Intake & Medicaid/Language Pre-Verification',
            },
            {
              stepNumber: 2,
              node: evalHub,
              distanceFromHomeKm: dEval,
              legDistanceKm: haversineKm(
                coord.latitude,
                coord.longitude,
                evalHub.latitude,
                evalHub.longitude
              ),
              channelIn: hop2.channel,
              expectedStepWaitDays: hop2.waitDays,
              cumulativeDays: c2,
              handoffNote: bilingualNeeded
                ? 'Bilingual Multidisciplinary Developmental Evaluation'
                : 'Multidisciplinary Developmental Evaluation',
            },
            {
              stepNumber: 3,
              node: vendor,
              distanceFromHomeKm: dVendor,
              legDistanceKm: haversineKm(
                evalHub.latitude,
                evalHub.longitude,
                vendor.latitude,
                vendor.longitude
              ),
              channelIn: hop3.channel,
              expectedStepWaitDays: hop3.waitDays,
              cumulativeDays: c3,
              handoffNote: 'Initial IFSP Authorization & Active EI Therapy Launch',
            },
          ];

          const maxDist = Math.max(dClinic, dEval, dVendor);
          const usesFax = [hop1.channel, hop2.channel, hop3.channel].includes(
            'paper_fax'
          );

          let transportAdvisory: string | null = null;
          if ((!intake.hasHouseholdVehicle || tract.no_vehicle_rate >= 0.12) && dEval > 20) {
            transportAdvisory = !intake.hasHouseholdVehicle
              ? `Zero-vehicle household & bilingual Eval Hub is ${dEval} km away: authorize Medicaid Non-Emergency Medical Transportation (NEMT) or state-permitted hybrid mobile/tele-evaluation at intake.`
              : `Neighborhood zero-vehicle rate is ${(tract.no_vehicle_rate * 100).toFixed(1)}% and Eval Hub is ${dEval} km away: confirm caregiver transit or schedule mobile home-based evaluation.`;
          }

          candidates.push({
            id: `${clinic.provider_id}->${coord.provider_id}->${evalHub.provider_id}->${vendor.provider_id}`,
            label: `${cleanOrgName(coord.synthetic_organization_name)} → ${cleanOrgName(evalHub.synthetic_organization_name)}`,
            hopCount: 3,
            steps,
            totalExpectedDays: c3,
            clears45DayClock: c3 <= 45,
            daysMargin: 45 - c3,
            maxDistanceFromHomeKm: maxDist,
            evalHubDistanceKm: dEval,
            allMedicaid:
              clinic.accepts_medicaid &&
              coord.accepts_medicaid &&
              evalHub.accepts_medicaid &&
              vendor.accepts_medicaid,
            allPartCEnrolled:
              coord.part_c_vendor_enrolled &&
              evalHub.part_c_vendor_enrolled &&
              vendor.part_c_vendor_enrolled,
            evalBilingual: evalHub.bilingual_services_listed,
            vendorBilingual: vendor.bilingual_services_listed,
            usesPaperFax: usesFax,
            transportAdvisory,
            rationale: `Clears the 45-day IDEA Part C clock in ~${c3} days (${45 - c3}d buffer) via ${usesFax ? 'mixed fax/portal' : 'end-to-end electronic portal'}, pairing bilingual Medicaid evaluation (${dEval} km) with Part C-enrolled therapy (${dVendor} km) while bypassing paper-fax re-referral bounce loops.`,
          });
        }
      }
    }
  }

  // Sort: compliant (<=45d) first, no paper_fax, then composite of wait days + travel distance (even tighter travel weight if zero-vehicle)
  const distWeight = intake.hasHouseholdVehicle ? 0.18 : 0.35;
  candidates.sort((a, b) => {
    if (a.clears45DayClock !== b.clears45DayClock) {
      return a.clears45DayClock ? -1 : 1;
    }
    if (a.usesPaperFax !== b.usesPaperFax) {
      return a.usesPaperFax ? 1 : -1;
    }
    const scoreA = a.totalExpectedDays + a.evalHubDistanceKm * distWeight;
    const scoreB = b.totalExpectedDays + b.evalHubDistanceKm * distWeight;
    return scoreA - scoreB;
  });

  // Deduplicate by unique (coord, evalHub) pair so alternatives show distinct routing choices
  const seenEvalCoord = new Set<string>();
  const distinctCandidates: CandidatePathway[] = [];
  for (const c of candidates) {
    const sig = `${c.steps[1].node.provider_id}__${c.steps[2].node.provider_id}`;
    if (seenEvalCoord.has(sig)) continue;
    seenEvalCoord.add(sig);
    distinctCandidates.push(c);
  }

  const recommended = distinctCandidates[0] ?? null;
  const alternatives = distinctCandidates.slice(1, 5);

  // Pick a real historical >45-day multi-hop bounce chain from this state (preferring same home tract/county or similar concern)
  const breachedChains = chains.filter((c) => c.breached45d && c.hops.length >= 3);
  const historicalTrapChain =
    breachedChains.find((c) => c.homeTractGeoid === tract.census_tract_geoid) ||
    breachedChains.find(
      (c) => c.homeTractGeoid.slice(0, 5) === tract.county_fips
    ) ||
    breachedChains.find((c) => c.hadBounce && c.faxHopCount >= 2) ||
    breachedChains[0] ||
    null;

  return {
    recommended,
    alternatives,
    historicalTrapChain,
    nearestClinic,
  };
}

/**
 * Post-Output Equity Audit — joins `audit_*` demographic shares ONLY AFTER
 * pathways and episode classifications have been computed.
 */
export function computePostOutputEquityAudit(
  tracts: TractDemographic[],
  chains: HistoricalChainTrace[]
): EquityAuditGroup[] {
  const tractMap = new Map(tracts.map((t) => [t.census_tract_geoid, t]));

  const groups: Record<'Breached (>45 days)' | 'Timely (<=45 days)', TractDemographic[]> = {
    'Breached (>45 days)': [],
    'Timely (<=45 days)': [],
  };

  for (const c of chains) {
    const t = tractMap.get(c.homeTractGeoid);
    if (!t) continue;
    if (c.breached45d) {
      groups['Breached (>45 days)'].push(t);
    } else {
      groups['Timely (<=45 days)'].push(t);
    }
  }

  const avgPct = (arr: TractDemographic[], fn: (t: TractDemographic) => number) =>
    arr.length === 0
      ? 0
      : Math.round((arr.reduce((s, t) => s + fn(t), 0) / arr.length) * 1000) / 10;

  return (['Breached (>45 days)', 'Timely (<=45 days)'] as const).map((label) => {
    const arr = groups[label];
    return {
      label,
      episodes: arr.length,
      avgPovertyPct: avgPct(arr, (t) => t.poverty_rate),
      avgNoVehiclePct: avgPct(arr, (t) => t.no_vehicle_rate),
      auditBlackPct: avgPct(arr, (t) => t.audit_black_share),
      auditHispanicPct: avgPct(arr, (t) => t.audit_hispanic_share),
      auditAsianPct: avgPct(arr, (t) => t.audit_asian_share),
      auditIndigenousPct: avgPct(arr, (t) => t.audit_indigenous_share),
      auditWhitePct: avgPct(arr, (t) => t.audit_white_share),
    };
  });
}

export function buildIsoGqlSnippet(
  intake: ReferralIntakeInput,
  tract: TractDemographic
): string {
  const medicaidFilter = intake.insuranceMedicaid
    ? `\n    AND coord.accepts_medicaid = TRUE\n    AND eval_hub.accepts_medicaid = TRUE\n    AND vendor.accepts_medicaid = TRUE`
    : '';
  const bilingualFilter =
    intake.primaryLanguage !== 'English'
      ? `\n    AND coord.bilingual_services_listed = TRUE\n    AND eval_hub.bilingual_services_listed = TRUE\n    AND vendor.bilingual_services_listed = TRUE`
      : '';

  return `-- 1. Homogeneous CareNode Property Graph DDL (excludes GEOGRAPHY column provider_geom)
CREATE OR REPLACE PROPERTY GRAPH a4i_early_intervention.ReferralGraph
  NODE TABLES (
    a4i_early_intervention.pediatric_and_ei_provider_directory AS CareNode
      KEY (provider_id)
      LABEL CareNode
      PROPERTIES ALL COLUMNS EXCEPT (provider_geom)
  )
  EDGE TABLES (
    a4i_early_intervention.deidentified_part_c_referral_logs AS ReferralHandoff
      KEY (referral_event_id)
      SOURCE KEY (source_provider_id) REFERENCES CareNode (provider_id)
      DESTINATION KEY (target_provider_id) REFERENCES CareNode (provider_id)
      LABEL ReferralHandoff
      PROPERTIES ALL COLUMNS
  );

-- 2A. Historical Breach Diagnosis (-{2,4}-> variable-length ISO GQL correlated on case_chain_id)
GRAPH a4i_early_intervention.ReferralGraph
MATCH (clinic:CareNode {node_role: 'Screening_Pediatric_Clinic'})
      -[hops:ReferralHandoff]->{2,4}
      (vendor:CareNode {node_role: 'EI_Therapy_Vendor'})
WHERE clinic.state_code = '${intake.stateCode}'
  AND ARRAY_LENGTH(hops) >= 3
  AND (SELECT COUNT(DISTINCT h.case_chain_id) FROM UNNEST(hops) AS h) = 1
LET chain_id = hops[OFFSET(0)].case_chain_id,
    total_hops = ARRAY_LENGTH(hops),
    chain_wait_days = (SELECT SUM(h.handoff_wait_days) FROM UNNEST(hops) AS h),
    fax_hops = (SELECT COUNTIF(h.transmission_channel = 'paper_fax') FROM UNNEST(hops) AS h)
FILTER chain_wait_days > 45
RETURN chain_id, hops[OFFSET(0)].target_provider_id AS bounce_coordinator_id,
       total_hops, fax_hops, chain_wait_days
ORDER BY chain_wait_days DESC;

-- 2B. Today's ${intake.childAgeMonths}m Referral Routing near Tract '${tract.census_tract_geoid}' (${tract.county_name})
SELECT
  g.*,
  ROUND(ST_DISTANCE(
    ST_GEOGPOINT(${tract.longitude}, ${tract.latitude}),
    ST_GEOGPOINT(g.eval_lon, g.eval_lat)
  ) / 1000.0, 1) AS km_to_eval_hub
FROM GRAPH_TABLE(
  a4i_early_intervention.ReferralGraph
  MATCH (clinic:CareNode {node_role: 'Screening_Pediatric_Clinic'})
        -[h1:ReferralHandoff]->(coord:CareNode {node_role: 'Part_C_Intake_Coordinator'})
        -[h2:ReferralHandoff]->(eval_hub:CareNode {node_role: 'Multidisciplinary_Eval_Hub'})
        -[h3:ReferralHandoff]->(vendor:CareNode {node_role: 'EI_Therapy_Vendor'})
  WHERE clinic.state_code = '${intake.stateCode}'
    AND coord.part_c_vendor_enrolled = TRUE
    AND eval_hub.part_c_vendor_enrolled = TRUE
    AND vendor.part_c_vendor_enrolled = TRUE${medicaidFilter}${bilingualFilter}
    AND h1.transmission_channel != 'paper_fax'
    AND h2.transmission_channel != 'paper_fax'
  LET expected_days = h1.handoff_wait_days + h2.handoff_wait_days + h3.handoff_wait_days
  FILTER expected_days <= 45
  COLUMNS (
    clinic.provider_id AS clinic_id,
    coord.provider_id AS coordinator_id,
    eval_hub.provider_id AS eval_hub_id,
    eval_hub.synthetic_organization_name AS eval_hub_name,
    eval_hub.latitude AS eval_lat,
    eval_hub.longitude AS eval_lon,
    vendor.provider_id AS vendor_id,
    expected_days
  )
) AS g
ORDER BY g.expected_days ASC, km_to_eval_hub ASC
LIMIT 5;`;
}

export function generateCaregiverNotes(
  intake: ReferralIntakeInput,
  tract: TractDemographic,
  pathway: CandidatePathway | null,
  agency: PartCAgency | undefined
): { en: string; es: string } {
  if (!pathway) {
    return {
      en: 'No single in-network pathway clears 45 days without coordinator override. Escalating immediately to regional Part C lead agency for emergency mobile bilingual evaluation.',
      es: 'Ninguna ruta local cumple los 45 días sin autorización especial. Escalando de inmediato a la agencia regional de Parte C para una evaluación bilingüe móvil prioritaria.',
    };
  }

  const clinic = cleanOrgName(pathway.steps[0].node.synthetic_organization_name);
  const coord = cleanOrgName(pathway.steps[1].node.synthetic_organization_name);
  const evalHub = cleanOrgName(pathway.steps[2].node.synthetic_organization_name);
  const vendor = cleanOrgName(pathway.steps[3].node.synthetic_organization_name);
  const step1Days = pathway.steps[1].cumulativeDays;
  const step2Days = pathway.steps[2].cumulativeDays;
  const totalDays = pathway.totalExpectedDays;
  const evalCity = pathway.steps[2].node.city;
  const evalKm = pathway.evalHubDistanceKm;
  const agencyLabel = agency
    ? cleanOrgName(agency.synthetic_agency_name)
    : `State IDEA Part C Early Intervention (${intake.stateCode})`;

  const transportEn = !intake.hasHouseholdVehicle
    ? `\n• Free Ride / Home-Visit Option: Because getting to ${evalCity} (${evalKm} km) without a car can be hard, your coordinator will arrange no-cost Medicaid transportation or a home/tele-video visit.`
    : '';

  const transportEs = !intake.hasHouseholdVehicle
    ? `\n• Transporte Gratuito o Visita en Casa: Sabemos que viajar a ${evalCity} (${evalKm} km) sin auto es difícil; su coordinador organizará transporte gratuito de Medicaid o una evaluación móvil/por videollamada.`
    : '';

  const en = `Hello! Your ${intake.childAgeMonths}-month-old's developmental referral in ${tract.county_name} has been fast-tracked through ${agencyLabel}. Under federal Early Intervention law (IDEA Part C), your family has the right to a complete evaluation and care plan within 45 calendar days—at $0 out-of-pocket cost with Medicaid.

Here is your confirmed ${totalDays}-day plan (clearing the 45-day deadline with ${pathway.daysMargin} days to spare):
• Step 1 (By Day ${step1Days}): ${coord} receives your child's electronic referral from ${clinic} (no paper fax delays) and calls you in ${intake.primaryLanguage === 'English' ? 'English' : `${intake.primaryLanguage} / bilingual support`} to confirm a time that works for your family.
• Step 2 (By Day ${step2Days}): ${evalHub} (${evalCity}, ${evalKm} km from your neighborhood) completes a play-based, ${intake.primaryLanguage !== 'English' ? 'bilingual ' : ''}developmental check for ${intake.concernDomain.toLowerCase()}.
• Step 3 (By Day ${totalDays}): Together with you, we write your child's Individualized Family Service Plan (IFSP) and begin early support with ${vendor}.${transportEn}

Note: Provider names above are [Synthetic] demonstration organizations; no family action is needed before your coordinator calls within ${step1Days} days.`;

  const es = `¡Hola! La referencia del desarrollo para su pequeño(a) de ${intake.childAgeMonths} meses en ${tract.county_name} fue enviada por vía electrónica rápida a través de ${agencyLabel}. Bajo la ley federal de Intervención Temprana (IDEA Parte C), su familia tiene derecho a una evaluación completa y un plan de apoyo dentro de 45 días calendario, sin ningún costo ($0) con Medicaid.

Este es su plan confirmado de ~${totalDays} días (${pathway.daysMargin} días antes del límite federal de 45 días):
• Paso 1 (Día 1 al ${step1Days}): ${coord} recibe la solicitud electrónica de ${clinic} (sin demoras de fax en papel) y se comunica con usted en español para confirmar su cita.
• Paso 2 (Para el Día ${step2Days}): ${evalHub} (${evalCity}, a ${evalKm} km de su vecindario) realiza una evaluación del desarrollo basada en el juego, completamente bilingüe y cubierta por Medicaid.
• Paso 3 (Para el Día ${totalDays}): Junto con su familia, creamos el Plan Individualizado de Servicios Familiares (IFSP) e iniciamos terapia temprana con ${vendor}.${transportEs}

Nota: Los nombres de clínicas arriba son organizaciones [Synthetic] de demostración; usted no necesita llenar más formularios antes de recibir la llamada de su coordinador(a).`;

  return { en, es };
}

export type { NschStratum };
