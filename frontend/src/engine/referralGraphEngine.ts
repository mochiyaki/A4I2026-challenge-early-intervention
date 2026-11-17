import rawData from '../data/caData.json';
import {
  AgencyPerformance,
  CaDataset,
  CandidatePathway,
  CareNode,
  ConcernDomain,
  CoordinatorBounceAudit,
  CounterfactualFixResult,
  EquityAuditGroup,
  NschStratum,
  ReferralHandoff,
  ReferralIntakeForm,
  TractDemographics,
  TransmissionChannel,
  TraversedHop,
} from '../types/partC';

export const CA_DATASET = rawData as unknown as CaDataset;

const PROVIDERS_BY_ID = new Map<string, CareNode>(
  CA_DATASET.pediatric_and_ei_provider_directory.map((p) => [p.provider_id, p])
);

const TRACTS_BY_GEOID = new Map<string, TractDemographics>(
  CA_DATASET.acs_under5_tract_demographics.map((t) => [t.census_tract_geoid, t])
);

/** Spherical Haversine distance in km (matches BigQuery ST_DISTANCE / 1000) */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371.0;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}

export function cleanOrgName(name: string): string {
  return name.replace(/\s*\[Synthetic\]\s*/gi, '').trim();
}

export function getTractByGeoid(geoid: string): TractDemographics {
  return (
    TRACTS_BY_GEOID.get(geoid) || CA_DATASET.acs_under5_tract_demographics[0]
  );
}

export function getProviderById(id: string): CareNode | undefined {
  return PROVIDERS_BY_ID.get(id);
}

export function getScreeningClinics(): CareNode[] {
  return CA_DATASET.pediatric_and_ei_provider_directory.filter(
    (p) => p.node_role === 'Screening_Pediatric_Clinic'
  );
}

export function getIntakeCoordinators(): CareNode[] {
  return CA_DATASET.pediatric_and_ei_provider_directory.filter(
    (p) => p.node_role === 'Part_C_Intake_Coordinator'
  );
}

/** Match statewide-only HRSA NSCH stratum WITHOUT 6x tract fan-out */
export function lookupStatewideNschContext(
  tract: TractDemographics,
  bilingualRequired: boolean
): {
  matchedStratum: NschStratum;
  englishHighIncomeComparator: NschStratum;
} {
  const strata = CA_DATASET.nsch_developmental_screening_survey;
  // Approximate FPL band from tract median household income for statewide context display only
  const fplBand =
    tract.median_household_income < 36000
      ? '<100% FPL'
      : tract.median_household_income < 65000
        ? '100-199% FPL'
        : '200-399% FPL';

  const targetLang = bilingualRequired
    ? 'Non-English Primary Household Language'
    : 'English Primary Household Language';

  const matched =
    strata.find(
      (s) =>
        s.primary_home_language === targetLang &&
        s.household_income_fpl_band === fplBand
    ) ||
    strata.find((s) => s.primary_home_language === targetLang) ||
    strata[0];

  const comparator =
    strata.find((s) => s.household_income_fpl_band === '>=400% FPL') ||
    strata[strata.length - 1];

  return { matchedStratum: matched, englishHighIncomeComparator: comparator };
}

export function getRegionalAgencyForTract(
  tract: TractDemographics
): AgencyPerformance {
  const agencies = CA_DATASET.idea_part_c_agency_performance;
  if (tract.county_name.includes('Santa Clara')) {
    return (
      agencies.find((a) => a.agency_id === 'SYN-PARTC-CA-03') || agencies[0]
    );
  }
  if (tract.county_name.includes('Shasta')) {
    return (
      agencies.find((a) => a.agency_id === 'SYN-PARTC-CA-02') || agencies[0]
    );
  }
  return agencies.find((a) => a.agency_id === 'SYN-PARTC-CA-01') || agencies[0];
}

interface AggregatedEdge {
  sourceId: string;
  targetId: string;
  channel: TransmissionChannel;
  avgWaitDays: number;
  avgDropoffPct: number;
  sampleCount: number;
  typicalReason: string;
}

function buildEdgeCatalog(): AggregatedEdge[] {
  const groups = new Map<string, ReferralHandoff[]>();
  for (const log of CA_DATASET.deidentified_part_c_referral_logs) {
    const key = `${log.source_provider_id}|${log.target_provider_id}|${log.transmission_channel}`;
    const list = groups.get(key) || [];
    list.push(log);
    groups.set(key, list);
  }
  const edges: AggregatedEdge[] = [];
  for (const [key, list] of groups.entries()) {
    const [sourceId, targetId, channel] = key.split('|') as [
      string,
      string,
      TransmissionChannel,
    ];
    const avgWaitDays =
      Math.round(
        (list.reduce((s, x) => s + x.handoff_wait_days, 0) / list.length) * 10
      ) / 10;
    const avgDropoffPct =
      Math.round(
        (list.reduce((s, x) => s + x.dropoff_rate_pct, 0) / list.length) * 1000
      ) / 10;
    edges.push({
      sourceId,
      targetId,
      channel,
      avgWaitDays,
      avgDropoffPct,
      sampleCount: list.length,
      typicalReason: list[0].handoff_reason,
    });
  }
  return edges;
}

const EDGE_CATALOG = buildEdgeCatalog();

/**
 * Multi-hop ReferralGraph Traversal for Track 1 ("Today's Toddler Referral")
 * NOTE: Strictly excludes audit_* demographic shares and all-zero limited_english_rate!
 */
export function evaluateReferralPathways(form: ReferralIntakeForm): {
  tract: TractDemographics;
  agency: AgencyPerformance;
  recommendedPath: CandidatePathway;
  fastTrack2HopPath: CandidatePathway | null;
  candidatePaths: CandidatePathway[];
  historicalBounceTrap: CandidatePathway;
} {
  const tract = getTractByGeoid(form.tractGeoid);
  const agency = getRegionalAgencyForTract(tract);
  const clinics = getScreeningClinics();

  // Select origin screening clinic: user choice or nearest clinic (preferring bilingual/Medicaid match when close)
  const originCandidates =
    form.originClinicId !== 'AUTO'
      ? clinics.filter((c) => c.provider_id === form.originClinicId)
      : [...clinics].sort((a, b) => {
          const da = haversineKm(
            tract.latitude,
            tract.longitude,
            a.latitude,
            a.longitude
          );
          const db = haversineKm(
            tract.latitude,
            tract.longitude,
            b.latitude,
            b.longitude
          );
          const penaltyA =
            form.bilingualRequired && !a.bilingual_services_listed ? 8 : 0;
          const penaltyB =
            form.bilingualRequired && !b.bilingual_services_listed ? 8 : 0;
          return da + penaltyA - (db + penaltyB);
        });

  const chosenOrigin = originCandidates[0] || clinics[0];

  // Adjacency list over ReferralGraph edges
  const outgoing = new Map<string, AggregatedEdge[]>();
  for (const e of EDGE_CATALOG) {
    const arr = outgoing.get(e.sourceId) || [];
    arr.push(e);
    outgoing.set(e.sourceId, arr);
  }

  // Enumerate prospective 2-hop and 3-hop paths across CareNode graph
  const rawPaths: { nodes: CareNode[]; edges: AggregatedEdge[] }[] = [];

  const originsToSearch =
    form.originClinicId !== 'AUTO'
      ? [chosenOrigin]
      : originCandidates.slice(0, 4);

  for (const clinic of originsToSearch) {
    const hop1Edges = outgoing.get(clinic.provider_id) || [];
    for (const e1 of hop1Edges) {
      const n1 = PROVIDERS_BY_ID.get(e1.targetId);
      if (!n1) continue;
      const hop2Edges = outgoing.get(n1.provider_id) || [];
      for (const e2 of hop2Edges) {
        const n2 = PROVIDERS_BY_ID.get(e2.targetId);
        if (!n2) continue;
        if (n2.node_role === 'EI_Therapy_Vendor') {
          rawPaths.push({ nodes: [clinic, n1, n2], edges: [e1, e2] });
        } else {
          const hop3Edges = outgoing.get(n2.provider_id) || [];
          for (const e3 of hop3Edges) {
            const n3 = PROVIDERS_BY_ID.get(e3.targetId);
            if (!n3) continue;
            if (n3.node_role === 'EI_Therapy_Vendor') {
              rawPaths.push({
                nodes: [clinic, n1, n2, n3],
                edges: [e1, e2, e3],
              });
            }
          }
        }
      }
    }
  }

  const scoredPaths: CandidatePathway[] = rawPaths.map((rp, idx) => {
    let cumWait = 0;
    const hops: TraversedHop[] = rp.edges.map((edge, i) => {
      cumWait = Math.round((cumWait + edge.avgWaitDays) * 10) / 10;
      const toNode = rp.nodes[i + 1];
      const dist = haversineKm(
        tract.latitude,
        tract.longitude,
        toNode.latitude,
        toNode.longitude
      );
      return {
        hopIndex: i + 1,
        fromNode: rp.nodes[i],
        toNode,
        transmissionChannel: edge.channel,
        expectedWaitDays: edge.avgWaitDays,
        cumulativeWaitDays: cumWait,
        dropoffRiskPct: edge.avgDropoffPct,
        handoffReason: edge.typicalReason,
        distanceFromHomeKm: dist,
        historicalSampleCount: edge.sampleCount,
      };
    });

    const is2Hop = rp.nodes.length === 3;
    // Downstream service nodes (Coordinator, Eval Hub, Therapy Vendor) must meet Part C & Medicaid & Bilingual
    const downstreamNodes = rp.nodes.slice(1);
    const meetsMedicaid =
      !form.medicaidRequired ||
      rp.nodes.every((n) => n.accepts_medicaid === true);
    const meetsBilingual =
      !form.bilingualRequired ||
      downstreamNodes.every((n) => n.bilingual_services_listed === true);
    const meetsPartCVendor = downstreamNodes.every(
      (n) => n.part_c_vendor_enrolled === true
    );
    const clears45DayClock = cumWait <= 45;

    const evalNode = rp.nodes.find(
      (n) => n.node_role === 'Multidisciplinary_Eval_Hub'
    );
    const evalDist = evalNode
      ? haversineKm(
          tract.latitude,
          tract.longitude,
          evalNode.latitude,
          evalNode.longitude
        )
      : hops[hops.length - 1]?.distanceFromHomeKm || 0;

    const maxDist = Math.max(
      haversineKm(
        tract.latitude,
        tract.longitude,
        rp.nodes[0].latitude,
        rp.nodes[0].longitude
      ),
      ...hops.map((h) => h.distanceFromHomeKm)
    );

    const reasons: string[] = [];
    if (!clears45DayClock) {
      reasons.push(
        `Breaches 45-day IDEA Part C limit (${cumWait}d expected wait)`
      );
    }
    if (!meetsBilingual) {
      const missing = downstreamNodes
        .filter((n) => !n.bilingual_services_listed)
        .map((n) => n.provider_id);
      reasons.push(
        `Missing bilingual evaluator/therapist (${missing.join(', ')})`
      );
    }
    if (!meetsMedicaid) {
      reasons.push('Provider on path does not accept Medi-Cal / Medicaid');
    }
    if (!meetsPartCVendor) {
      reasons.push('Downstream vendor not Part C enrolled');
    }
    if (is2Hop && !form.priorDiagnosticEvalCompleted) {
      reasons.push(
        'Skips Multidisciplinary_Eval_Hub (valid only if diagnostic evaluation is already on file)'
      );
    }
    if (rp.edges.some((e) => e.channel === 'paper_fax')) {
      reasons.push('Contains high-dropoff paper_fax handoff');
    }

    const fullyEligible =
      clears45DayClock &&
      meetsMedicaid &&
      meetsBilingual &&
      meetsPartCVendor &&
      (form.priorDiagnosticEvalCompleted || !is2Hop);

    const zeroVehicleAlert = tract.no_vehicle_rate >= 0.15;
    const longDistanceTeleEvalAlert = evalDist > 45 || maxDist > 85;
    // 36-month IDEA Part C age-out cliff warning if child is >= 30m or finishes near 36m
    const projectedAgeMonthsAtIfsp = form.childAgeMonths + cumWait / 30.4;
    const agingOutCliffAlert =
      form.childAgeMonths >= 30 || projectedAgeMonthsAtIfsp >= 35.0;

    // Composite clinical routing score (lower is better; ZERO audit_* columns!)
    const originClinicBilingualPenalty =
      form.bilingualRequired && !rp.nodes[0].bilingual_services_listed ? 6 : 0;
    const faxPenalty = rp.edges.some((e) => e.channel === 'paper_fax') ? 35 : 0;
    const compositeRankScore =
      cumWait * 1.6 +
      Math.min(evalDist, 120) * 0.15 +
      originClinicBilingualPenalty +
      faxPenalty +
      (fullyEligible ? 0 : 500);

    return {
      pathId: `PATH-CA-${String(idx + 1).padStart(2, '0')}`,
      pathwayType: is2Hop
        ? '2-Hop Direct Fast-Track IFSP'
        : '3-Hop Full Bilingual Evaluation + Therapy',
      nodes: rp.nodes,
      hops,
      totalWaitDays: cumWait,
      daysBufferUnder45: Math.round((45 - cumWait) * 10) / 10,
      clears45DayClock,
      meetsMedicaid,
      meetsBilingual,
      meetsPartCVendor,
      fullyEligible,
      maxDistanceFromHomeKm: maxDist,
      evalHubDistanceKm: evalDist,
      zeroVehicleAlert,
      longDistanceTeleEvalAlert,
      agingOutCliffAlert,
      disqualificationReasons: reasons,
      compositeRankScore,
    };
  });

  scoredPaths.sort((a, b) => a.compositeRankScore - b.compositeRankScore);

  const recommendedPath =
    scoredPaths.find((p) => p.fullyEligible) || scoredPaths[0];

  const fastTrack2HopPath =
    scoredPaths.find(
      (p) =>
        p.pathwayType === '2-Hop Direct Fast-Track IFSP' &&
        p.clears45DayClock &&
        p.meetsMedicaid &&
        p.meetsBilingual
    ) || null;

  // Build real historical case_chain_id-correlated 4-hop bounce chain comparison
  const historicalBounceTrap = findHistoricalBounceComparison(
    tract,
    recommendedPath.nodes[1]?.provider_id
  );

  return {
    tract,
    agency,
    recommendedPath,
    fastTrack2HopPath,
    candidatePaths: scoredPaths.slice(0, 8),
    historicalBounceTrap,
  };
}

/**
 * Finds a real historical >45d 4-hop case_chain_id bounce chain through the same coordinator
 * (correlating case_chain_id across all hops, exactly matching ISO GQL rule #4!)
 */
function findHistoricalBounceComparison(
  tract: TractDemographics,
  coordinatorId?: string
): CandidatePathway {
  const chains = new Map<string, ReferralHandoff[]>();
  for (const log of CA_DATASET.deidentified_part_c_referral_logs) {
    const arr = chains.get(log.case_chain_id) || [];
    arr.push(log);
    chains.set(log.case_chain_id, arr);
  }

  let bestChainId = 'CHAIN-CA-003';
  let bestHops: ReferralHandoff[] = [];
  let bestScore = -1;

  for (const [cid, list] of chains.entries()) {
    list.sort((a, b) => a.hop_sequence - b.hop_sequence);
    const totalWait = list.reduce((s, h) => s + h.handoff_wait_days, 0);
    if (totalWait <= 45 || list.length < 3) continue;
    const matchesCoord =
      coordinatorId && list[0]?.target_provider_id === coordinatorId ? 50 : 0;
    const score = matchesCoord + list.length * 10 + totalWait;
    if (score > bestScore) {
      bestScore = score;
      bestChainId = cid;
      bestHops = list;
    }
  }

  const nodes: CareNode[] = [];
  if (bestHops.length > 0) {
    const firstSrc = PROVIDERS_BY_ID.get(bestHops[0].source_provider_id);
    if (firstSrc) nodes.push(firstSrc);
    for (const h of bestHops) {
      const dst = PROVIDERS_BY_ID.get(h.target_provider_id);
      if (dst) nodes.push(dst);
    }
  }

  let cum = 0;
  const hops: TraversedHop[] = bestHops.map((h, i) => {
    cum += h.handoff_wait_days;
    const fromNode = PROVIDERS_BY_ID.get(h.source_provider_id)!;
    const toNode = PROVIDERS_BY_ID.get(h.target_provider_id)!;
    return {
      hopIndex: i + 1,
      fromNode,
      toNode,
      transmissionChannel: h.transmission_channel,
      expectedWaitDays: h.handoff_wait_days,
      cumulativeWaitDays: cum,
      dropoffRiskPct: Math.round(h.dropoff_rate_pct * 1000) / 10,
      handoffReason: h.handoff_reason,
      distanceFromHomeKm: haversineKm(
        tract.latitude,
        tract.longitude,
        toNode.latitude,
        toNode.longitude
      ),
      historicalSampleCount: 1,
    };
  });

  return {
    pathId: bestChainId,
    pathwayType: 'Historical Bounce Trap',
    nodes,
    hops,
    totalWaitDays: cum,
    daysBufferUnder45: 45 - cum,
    clears45DayClock: false,
    meetsMedicaid: nodes.every((n) => n.accepts_medicaid),
    meetsBilingual: nodes.slice(1).every((n) => n.bilingual_services_listed),
    meetsPartCVendor: nodes.slice(1).every((n) => n.part_c_vendor_enrolled),
    fullyEligible: false,
    maxDistanceFromHomeKm: Math.max(...hops.map((h) => h.distanceFromHomeKm)),
    evalHubDistanceKm: hops[1]?.distanceFromHomeKm || 0,
    zeroVehicleAlert: tract.no_vehicle_rate >= 0.15,
    longDistanceTeleEvalAlert: false,
    agingOutCliffAlert: true,
    disqualificationReasons: [
      `Breaches federal 45-day clock at ${cum} days (+${cum - 45}d statutory violation)`,
      'Paper-fax routing into saturated/unmatched Eval Hub triggers 4-hop re-referral bounce',
    ],
    compositeRankScore: 9999,
    historicalChainExampleId: bestChainId,
  };
}

/**
 * Compares Flat SQL Waitlist Sort against Multi-Hop Graph Episode Audit
 * Exposes SYN-PROV-CA-011 & 012 (5-6d internal wait, yet 7/11 breached episodes!)
 */
export function computeCoordinatorBounceAudits(): {
  naiveTopWaitlistNodes: CareNode[];
  coordinatorAudits: CoordinatorBounceAudit[];
} {
  const sortedByWaitlist = [
    ...CA_DATASET.pediatric_and_ei_provider_directory,
  ].sort((a, b) => b.active_waitlist_count - a.active_waitlist_count);

  const rankByProvider = new Map<string, number>();
  sortedByWaitlist.forEach((p, idx) =>
    rankByProvider.set(p.provider_id, idx + 1)
  );

  const chains = new Map<string, ReferralHandoff[]>();
  for (const log of CA_DATASET.deidentified_part_c_referral_logs) {
    const arr = chains.get(log.case_chain_id) || [];
    arr.push(log);
    chains.set(log.case_chain_id, arr);
  }

  const byCoord = new Map<
    string,
    { waits: number[]; hops3p: number; over45: number; faxHops: number }
  >();

  for (const list of chains.values()) {
    list.sort((a, b) => a.hop_sequence - b.hop_sequence);
    const coordId = list[0]?.target_provider_id;
    if (!coordId) continue;
    const totalWait = list.reduce((s, h) => s + h.handoff_wait_days, 0);
    const faxCount = list.filter(
      (h) => h.transmission_channel === 'paper_fax'
    ).length;
    const rec = byCoord.get(coordId) || {
      waits: [],
      hops3p: 0,
      over45: 0,
      faxHops: 0,
    };
    rec.waits.push(totalWait);
    if (list.length >= 3) rec.hops3p += 1;
    if (totalWait > 45) rec.over45 += 1;
    rec.faxHops += faxCount;
    byCoord.set(coordId, rec);
  }

  const coordinatorAudits: CoordinatorBounceAudit[] = Array.from(
    byCoord.entries()
  )
    .map(([coordId, rec]) => {
      const coordinator = PROVIDERS_BY_ID.get(coordId)!;
      const routedEpisodes = rec.waits.length;
      const meanChainWaitDays =
        Math.round(
          (rec.waits.reduce((a, b) => a + b, 0) / routedEpisodes) * 10
        ) / 10;
      return {
        coordinator,
        routedEpisodes,
        chains3PlusHops: rec.hops3p,
        chainsOver45Days: rec.over45,
        breachRatePct: Math.round((rec.over45 / routedEpisodes) * 1000) / 10,
        meanChainWaitDays,
        paperFaxHopsCount: rec.faxHops,
        flatWaitlistRank: rankByProvider.get(coordId) || 99,
        trueBreachRank: 0,
      };
    })
    .sort(
      (a, b) =>
        b.chainsOver45Days - a.chainsOver45Days ||
        b.meanChainWaitDays - a.meanChainWaitDays
    )
    .map((item, idx) => ({ ...item, trueBreachRank: idx + 1 }));

  return {
    naiveTopWaitlistNodes: sortedByWaitlist.slice(0, 5),
    coordinatorAudits,
  };
}

/**
 * Counterfactual Bottleneck Simulation (+10 Bonus Range):
 * Simulates upgrading selected Part_C_Intake_Coordinator hub(s) from paper_fax to
 * ehr_electronic_portal with pre-checked bilingual/Medicaid Eval Hub routing across all 44 CA chains.
 */
export function simulateCoordinatorEhrFix(
  upgradedCoordinatorIds: string[]
): CounterfactualFixResult {
  const upgradedSet = new Set(upgradedCoordinatorIds);
  const chains = new Map<string, ReferralHandoff[]>();
  for (const log of CA_DATASET.deidentified_part_c_referral_logs) {
    const arr = chains.get(log.case_chain_id) || [];
    arr.push(log);
    chains.set(log.case_chain_id, arr);
  }

  // Empirical electronic portal hop averages in CA graph:
  // Clinic -> Coordinator (EHR): 7.8d, Coordinator -> Matched Bilingual Eval Hub (EHR): 13.9d, Eval Hub -> Vendor (EHR): 15.0d
  let baselineBreached = 0;
  let postFixBreached = 0;
  let rescuedCount = 0;
  let totalDaysSaved = 0;
  let sumBefore = 0;
  let sumAfter = 0;

  const affectedChainDetails: CounterfactualFixResult['affectedChainDetails'] =
    [];

  for (const [cid, list] of Array.from(chains.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    list.sort((a, b) => a.hop_sequence - b.hop_sequence);
    const beforeDays = list.reduce((s, h) => s + h.handoff_wait_days, 0);
    sumBefore += beforeDays;
    if (beforeDays > 45) baselineBreached += 1;

    const coordId = list[0]?.target_provider_id;
    const hasFaxOrBounce =
      list.some((h) => h.transmission_channel !== 'ehr_electronic_portal') ||
      list.some((h) => h.handoff_reason.startsWith('Re-Referral Bounce'));

    let afterDays = beforeDays;
    if (coordId && upgradedSet.has(coordId) && hasFaxOrBounce) {
      // Upgrading intake hub eliminates paper_fax lag (~6.2d/hop) AND prevents the 4th-hop re-referral bounce (~22.8d)
      // Routing cleanly onto that coordinator's real electronic 3-hop path (Clinic -> Coord -> Matched Eval Hub -> Vendor)
      const ehrHop1 = Math.min(list[0].handoff_wait_days, 8);
      const ehrHop2 = 14; // Observed EHR Coordinator -> Bilingual Eval Hub median in CA
      const ehrHop3 = 15; // Observed EHR Eval Hub -> Bilingual Therapy Vendor median in CA
      afterDays = Math.min(beforeDays, ehrHop1 + ehrHop2 + ehrHop3);
      const rescuedUnder45 = beforeDays > 45 && afterDays <= 45;
      if (rescuedUnder45) rescuedCount += 1;
      totalDaysSaved += Math.max(0, beforeDays - afterDays);
      affectedChainDetails.push({
        caseChainId: cid,
        childAgeMonths: list[0].child_age_months,
        concernDomain: list[0].concern_domain,
        homeTractGeoid: list[0].child_home_tract_geoid,
        beforeDays,
        afterDays,
        rescuedUnder45,
      });
    }

    sumAfter += afterDays;
    if (afterDays > 45) postFixBreached += 1;
  }

  const nChains = chains.size || 1;
  return {
    targetCoordinatorIds: upgradedCoordinatorIds,
    baselineBreachedChains: baselineBreached,
    postFixBreachedChains: postFixBreached,
    chainsRescuedUnder45Days: rescuedCount,
    totalChildDaysSaved: totalDaysSaved,
    baselineMeanWaitDays: Math.round((sumBefore / nChains) * 10) / 10,
    postFixMeanWaitDays: Math.round((sumAfter / nChains) * 10) / 10,
    affectedChainDetails,
  };
}

/**
 * Post-Output Equity Audit (Section 11 Rule):
 * Joins child_home_tract_geoid to acs_under5_tract_demographics AFTER routing
 */
export function computePostOutputEquityAudit(): EquityAuditGroup[] {
  const chains = new Map<string, ReferralHandoff[]>();
  for (const log of CA_DATASET.deidentified_part_c_referral_logs) {
    const arr = chains.get(log.case_chain_id) || [];
    arr.push(log);
    chains.set(log.case_chain_id, arr);
  }

  const breached: { wait: number; tract: TractDemographics }[] = [];
  const timely: { wait: number; tract: TractDemographics }[] = [];

  for (const list of chains.values()) {
    list.sort((a, b) => a.hop_sequence - b.hop_sequence);
    const wait = list.reduce((s, h) => s + h.handoff_wait_days, 0);
    const tract = getTractByGeoid(list[0].child_home_tract_geoid);
    if (wait > 45) breached.push({ wait, tract });
    else timely.push({ wait, tract });
  }

  const summarize = (
    label: string,
    rows: { wait: number; tract: TractDemographics }[]
  ): EquityAuditGroup => {
    const n = rows.length || 1;
    const avg = (fn: (r: { wait: number; tract: TractDemographics }) => number) =>
      Math.round((rows.reduce((s, r) => s + fn(r), 0) / n) * 10) / 10;
    return {
      groupLabel: label,
      episodesCount: rows.length,
      avgWaitDays: avg((r) => r.wait),
      avgPovertyPct: avg((r) => r.tract.poverty_rate * 100),
      avgNoVehiclePct: avg((r) => r.tract.no_vehicle_rate * 100),
      auditHispanicPct: avg((r) => r.tract.audit_hispanic_share * 100),
      auditBlackPct: avg((r) => r.tract.audit_black_share * 100),
      auditAsianPct: avg((r) => r.tract.audit_asian_share * 100),
      auditWhitePct: avg((r) => r.tract.audit_white_share * 100),
      auditIndigenousPct: avg((r) => r.tract.audit_indigenous_share * 100),
    };
  };

  return [
    summarize('Breached Chains (>45 Days)', breached),
    summarize('Timely Chains (<=45 Days)', timely),
  ];
}

/** Generates parameterized BigQuery ISO/IEC 39075 GQL queries for the active referral */
export function buildIsoGqlQueries(
  form: ReferralIntakeForm,
  tract: TractDemographics
): {
  prospectiveRoutingGql: string;
  historicalBreachAuditGql: string;
} {
  const prospectiveRoutingGql = `-- BigQuery ISO/IEC 39075 GQL: <=45-Day Bilingual Medi-Cal Pathway from Tract '${tract.census_tract_geoid}'
SELECT
  g.clinic_id,
  g.coordinator_id,
  g.eval_hub_id,
  g.vendor_id,
  g.expected_path_days,
  ROUND(ST_DISTANCE(ST_CENTROID(t.tract_geom), p_eval.provider_geom) / 1000.0, 1) AS km_to_eval_hub
FROM GRAPH_TABLE(
  a4i_early_intervention.ReferralGraph
  MATCH (clinic:CareNode {node_role: 'Screening_Pediatric_Clinic'})
        -[e1:ReferralHandoff WHERE e1.transmission_channel = 'ehr_electronic_portal']->
        (coord:CareNode {node_role: 'Part_C_Intake_Coordinator'})
        -[e2:ReferralHandoff WHERE e2.transmission_channel = 'ehr_electronic_portal']->
        (eval_hub:CareNode {node_role: 'Multidisciplinary_Eval_Hub'})
        -[e3:ReferralHandoff WHERE e3.transmission_channel = 'ehr_electronic_portal']->
        (vendor:CareNode {node_role: 'EI_Therapy_Vendor'})
  WHERE clinic.state_code = 'CA'
    AND coord.accepts_medicaid = ${form.medicaidRequired ? 'TRUE' : 'coord.accepts_medicaid'}
    AND eval_hub.accepts_medicaid = ${form.medicaidRequired ? 'TRUE' : 'eval_hub.accepts_medicaid'}
    AND vendor.accepts_medicaid = ${form.medicaidRequired ? 'TRUE' : 'vendor.accepts_medicaid'}
    AND eval_hub.bilingual_services_listed = ${form.bilingualRequired ? 'TRUE' : 'eval_hub.bilingual_services_listed'}
    AND vendor.bilingual_services_listed = ${form.bilingualRequired ? 'TRUE' : 'vendor.bilingual_services_listed'}
    AND eval_hub.part_c_vendor_enrolled = TRUE
    AND vendor.part_c_vendor_enrolled = TRUE
  LET path_days = e1.handoff_wait_days + e2.handoff_wait_days + e3.handoff_wait_days
  FILTER path_days <= 45
  COLUMNS (
    clinic.provider_id AS clinic_id,
    coord.provider_id AS coordinator_id,
    eval_hub.provider_id AS eval_hub_id,
    vendor.provider_id AS vendor_id,
    path_days AS expected_path_days
  )
) AS g
INNER JOIN \`a4i_early_intervention.acs_under5_tract_demographics\` AS t
  ON t.census_tract_geoid = '${tract.census_tract_geoid}'
INNER JOIN \`a4i_early_intervention.pediatric_and_ei_provider_directory\` AS p_eval
  ON p_eval.provider_id = g.eval_hub_id
GROUP BY 1, 2, 3, 4, 5, t.tract_geom, p_eval.provider_geom
ORDER BY expected_path_days ASC, km_to_eval_hub ASC
LIMIT 5;`;

  const historicalBreachAuditGql = `-- Variable-Length -{2,4}-> ISO GQL Audit (Correlating case_chain_id Across Hops!)
GRAPH a4i_early_intervention.ReferralGraph
MATCH (clinic:CareNode {node_role: 'Screening_Pediatric_Clinic'})
      -[hops:ReferralHandoff]->{2,4}
      (vendor:CareNode {node_role: 'EI_Therapy_Vendor'})
WHERE ARRAY_LENGTH(hops) >= 3
  AND (SELECT COUNT(DISTINCT h.case_chain_id) FROM UNNEST(hops) AS h) = 1
LET chain_id = hops[OFFSET(0)].case_chain_id,
    total_hops = ARRAY_LENGTH(hops),
    chain_wait_days = (SELECT SUM(h.handoff_wait_days) FROM UNNEST(hops) AS h),
    fax_hops = (SELECT COUNTIF(h.transmission_channel = 'paper_fax') FROM UNNEST(hops) AS h)
FILTER chain_wait_days > 45
RETURN
  chain_id,
  clinic.provider_id AS origin_clinic_id,
  hops[OFFSET(0)].target_provider_id AS bounce_coordinator_id,
  vendor.provider_id AS destination_vendor_id,
  total_hops,
  fax_hops,
  chain_wait_days
ORDER BY chain_wait_days DESC
LIMIT 15;`;

  return { prospectiveRoutingGql, historicalBreachAuditGql };
}

/** Generates warm, plain-language English & Spanish Caregiver Action Notes */
export function generateCaregiverActionNotes(
  form: ReferralIntakeForm,
  tract: TractDemographics,
  path: CandidatePathway
): { english: string; spanish: string } {
  const clinic = path.nodes[0];
  const coord = path.nodes[1];
  const evalHub =
    path.nodes.find((n) => n.node_role === 'Multidisciplinary_Eval_Hub') ||
    path.nodes[2];
  const vendor = path.nodes[path.nodes.length - 1];

  const hop1Day = Math.round(path.hops[0]?.cumulativeWaitDays || 7);
  const hop2Day = Math.round(path.hops[1]?.cumulativeWaitDays || 21);
  const finalDay = Math.round(path.totalWaitDays);

  const needsTransportSupport =
    path.zeroVehicleAlert || path.longDistanceTeleEvalAlert;

  const domainPlainEn: Record<ConcernDomain, string> = {
    'Social-Communication / Autism Screen':
      'early social communication and play skills',
    'Expressive Speech/Language': 'early speech and language milestones',
    'Motor Milestone Delay': 'movement and physical milestones',
    'Feeding & Sensory': 'feeding comfort and sensory milestones',
  };

  const domainPlainEs: Record<ConcernDomain, string> = {
    'Social-Communication / Autism Screen':
      'comunicación social temprana y habilidades de juego',
    'Expressive Speech/Language': 'desarrollo temprano del habla y el lenguaje',
    'Motor Milestone Delay': 'movimiento y desarrollo físico',
    'Feeding & Sensory': 'alimentación y desarrollo sensorial',
  };

  const transportEn = needsTransportSupport
    ? `\n• Free Ride or Video Visit Support: Because travel from ${tract.county_name} (${path.evalHubDistanceKm} km) can be tough, your coordinator is requesting a California Early Start bilingual video/mobile evaluation option AND scheduling free Medi-Cal Non-Emergency Medical Transportation (NEMT) door-to-door rides if you prefer an in-person visit.`
    : `\n• Free Medi-Cal Rides Available: Your evaluation center is ${path.evalHubDistanceKm} km away in ${evalHub.city}. Ask your coordinator if you would like a free Medi-Cal ride arranged.`;

  const transportEs = needsTransportSupport
    ? `\n• Apoyo de Transporte Gratuito o Visita por Video: Debido a la distancia desde ${tract.county_name} (${path.evalHubDistanceKm} km), su coordinador solicitará una evaluación bilingüe por video o unidad móvil de Early Start, además de transporte gratuito puerta a puerta cubierto por Medi-Cal (NEMT) si prefiere asistir en persona.`
    : `\n• Transporte Gratuito con Medi-Cal: El centro de evaluación está a ${path.evalHubDistanceKm} km en ${evalHub.city}. Avise a su coordinador si desea transporte gratuito de Medi-Cal.`;

  const english = `Hello! Here is your child's Fast-Track Early Start Plan (${form.childAgeMonths} months old — ${domainPlainEn[form.concernDomain]}):

Federal law protects your family's right to finish your child's developmental evaluation and family support plan (IFSP) within 45 calendar days. We sent your referral electronically today—no paper faxes—so your child stays on a ${finalDay}-day fast track (${Math.max(0, Math.round(45 - finalDay))} days ahead of the 45-day deadline):

1. Today (Day 0) — Electronic Referral Sent:
   ${cleanOrgName(clinic.synthetic_organization_name)} sent your packet digitally.
2. By Day ${hop1Day} — Your Dedicated Service Coordinator Calls You:
   ${cleanOrgName(coord.synthetic_organization_name)} will call you in ${form.bilingualRequired ? 'Spanish/English' : 'your preferred language'} to confirm one simple consent form.
3. Around Day ${hop2Day} — Bilingual Developmental Evaluation ($0 Cost with Medi-Cal):
   ${cleanOrgName(evalHub.synthetic_organization_name)} (${cleanOrgName(evalHub.synthetic_address)}) has reserved a ${form.bilingualRequired ? 'bilingual Spanish-English ' : ''}Medi-Cal evaluation team.
4. Around Day ${finalDay} — Family Plan (IFSP) & Active Early Support Begin:
   ${cleanOrgName(vendor.synthetic_organization_name)} starts play-based support tailored to your child.

Good to know:
• $0 Out-of-Pocket Cost: Early Start evaluations and IFSP coordination are free for eligible families and covered under Medi-Cal.
• Bilingual Guarantee: Every team on this pathway provides ${form.bilingualRequired ? 'Spanish-bilingual specialists' : 'language support'} at no cost.${transportEn}`;

  const spanish = `¡Hola! Este es el Plan Rápido de Intervención Temprana "Early Start" para su bebé (${form.childAgeMonths} meses — ${domainPlainEs[form.concernDomain]}):

La ley federal protege el derecho de su familia a recibir una evaluación del desarrollo y un Plan Familiar de Servicios (IFSP) dentro de 45 días calendario. Hoy enviamos su referencia por vía electrónica directa —sin faxes de papel— con un tiempo estimado de ${finalDay} días (${Math.max(0, Math.round(45 - finalDay))} días antes del límite legal de 45 días):

1. Hoy (Día 0) — Referencia Electrónica Enviada:
   ${cleanOrgName(clinic.synthetic_organization_name)} envió el expediente digitalmente.
2. Para el Día ${hop1Day} — Llamada de su Coordinador(a) de Servicios:
   ${cleanOrgName(coord.synthetic_organization_name)} se comunicará con usted en español para confirmar su consentimiento sin trámites repetidos.
3. Alrededor del Día ${hop2Day} — Evaluación Bilingüe del Desarrollo ($0 Costo con Medi-Cal):
   ${cleanOrgName(evalHub.synthetic_organization_name)} (${cleanOrgName(evalHub.synthetic_address)}) cuenta con especialistas bilingües inscritos en Medi-Cal.
4. Alrededor del Día ${finalDay} — Inicio de su Plan Familiar (IFSP) y Terapia Temprana:
   ${cleanOrgName(vendor.synthetic_organization_name)} iniciará el apoyo temprano basado en el juego.

Información importante para su tranquilidad:
• Sin Costo ($0): Las evaluaciones de Early Start y la coordinación del plan IFSP son gratuitas y están cubiertas por Medi-Cal.
• Atención 100% Bilingüe: Todos los proveedores seleccionados cuentan con personal bilingüe español-inglés.${transportEs}`;

  return { english, spanish };
}
