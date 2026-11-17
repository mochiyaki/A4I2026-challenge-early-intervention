import {
  cleanOrgName,
  computeBounceHubDiagnostics,
  computePostOutputEquityAudit,
  findPathwaysForReferral,
  generateCaregiverNotes,
  getStateData,
  reconstructHistoricalChains,
  STATE_META,
} from './graphTriageEngine';
import type {
  CandidatePathway,
  ReferralIntakeInput,
  StateCode,
} from '../types';

export interface ChatActionBadge {
  label: string;
}

export interface LocalAgentReply {
  markdown: string;
  spokenText: string;
  spokenLang: 'en-US' | 'es-US';
  intakePatch?: Partial<ReferralIntakeInput>;
  appliedBadges: ChatActionBadge[];
  suggestedFollowUps: string[];
}

const STATE_NAME_MAP: { pattern: RegExp; code: StateCode }[] = [
  { pattern: /\b(mississippi|ms)\b/i, code: 'MS' },
  { pattern: /\b(california|ca)\b/i, code: 'CA' },
  { pattern: /\b(texas|tx)\b/i, code: 'TX' },
  { pattern: /\b(new york|ny|bronx)\b/i, code: 'NY' },
  { pattern: /\b(georgia|ga)\b/i, code: 'GA' },
  { pattern: /\b(alabama|al|selma)\b/i, code: 'AL' },
];

/**
 * Parses natural-language voice or text input for state/age/language/vehicle/concern changes,
 * re-runs the ReferralGraph engine on the updated profile, and produces both a clean visual
 * answer and a concise, jargon-free spoken response for the Voice Agent.
 */
export function runConversationalGraphAgent(
  rawQuery: string,
  currentIntake: ReferralIntakeInput
): LocalAgentReply {
  const q = rawQuery.trim();
  const lower = q.toLowerCase();
  const patch: Partial<ReferralIntakeInput> = {};
  const appliedBadges: ChatActionBadge[] = [];

  // 1. Detect State switch in natural language
  for (const entry of STATE_NAME_MAP) {
    if (entry.pattern.test(q) && entry.code !== currentIntake.stateCode) {
      patch.stateCode = entry.code;
      appliedBadges.push({ label: `Switched state → ${entry.code}` });
      break;
    }
  }

  // 2. Detect Child Age in months (e.g. "20-month-old", "28 months", "31m", "20 meses")
  const ageMatch =
    q.match(/\b(\d{1,2})\s*(?:-|\s)?(?:month|months|mo|mos|meses)\b/i) ||
    q.match(/\b(\d{1,2})m\b/i);
  if (ageMatch) {
    const parsedAge = Number(ageMatch[1]);
    if (parsedAge >= 1 && parsedAge <= 35 && parsedAge !== currentIntake.childAgeMonths) {
      patch.childAgeMonths = parsedAge;
      appliedBadges.push({ label: `Child age → ${parsedAge}m` });
    }
  }

  // 3. Detect Language / Bilingual preferences
  const asksInSpanish =
    /[¿¡]|(\b(español|espanol|familia|evaluación|niño|meses|ruta|días)\b)/i.test(q);
  if (/\b(spanish|bilingual|español|espanol|hispanohablante)\b/i.test(q)) {
    if (currentIntake.primaryLanguage !== 'Spanish') {
      patch.primaryLanguage = 'Spanish';
      appliedBadges.push({ label: 'Language → Spanish Bilingual' });
    }
  } else if (/\b(english only|english-speaking|monolingual english)\b/i.test(q)) {
    if (currentIntake.primaryLanguage !== 'English') {
      patch.primaryLanguage = 'English';
      appliedBadges.push({ label: 'Language → English' });
    }
  }

  // 4. Detect Vehicle / Transport constraints
  if (
    /\b(no car|no vehicle|zero[- ]vehicle|without a car|bus|transit|sin auto|sin carro|transporte)\b/i.test(
      q
    )
  ) {
    if (currentIntake.hasHouseholdVehicle) {
      patch.hasHouseholdVehicle = false;
      appliedBadges.push({ label: 'Zero-Vehicle Guardrail ON' });
    }
  } else if (/\b(has a car|have a car|with vehicle|can drive)\b/i.test(q)) {
    if (!currentIntake.hasHouseholdVehicle) {
      patch.hasHouseholdVehicle = true;
      appliedBadges.push({ label: 'Household Vehicle ON' });
    }
  }

  // 5. Detect Developmental Concern
  if (/\b(autism|autismo|social)\b/i.test(q)) {
    if (currentIntake.concernDomain !== 'Autism / Social Communication') {
      patch.concernDomain = 'Autism / Social Communication';
      appliedBadges.push({ label: 'Concern → Autism / Social' });
    }
  } else if (/\b(motor|walking|crawling|feeding|sensory|motriz)\b/i.test(q)) {
    if (currentIntake.concernDomain !== 'Motor / Adaptive Delay') {
      patch.concernDomain = 'Motor / Adaptive Delay';
      appliedBadges.push({ label: 'Concern → Motor / Adaptive' });
    }
  } else if (/\b(speech|language|talking|habla|lenguaje)\b/i.test(q)) {
    if (currentIntake.concernDomain !== 'Speech & Language Delay') {
      patch.concernDomain = 'Speech & Language Delay';
      appliedBadges.push({ label: 'Concern → Speech & Language' });
    }
  }

  // 6. Detect Counterfactual Simulation trigger
  if (/\b(upgrade|simulate|counterfactual|replace fax|switch to electronic|e-referral fix)\b/i.test(q)) {
    if (!currentIntake.simulateEhrUpgrade) {
      patch.simulateEhrUpgrade = true;
      appliedBadges.push({ label: 'Simulated e-Portal Fix ON' });
    }
  }

  // Recompute state & routing against effective intake
  const effectiveIntake: ReferralIntakeInput = {
    ...currentIntake,
    ...patch,
  };

  const bundle = getStateData(effectiveIntake.stateCode);
  let tract =
    bundle.tracts.find(
      (t) => t.census_tract_geoid === effectiveIntake.tractGeoid
    ) ?? bundle.tracts[0];

  // If state changed, pick high-need default tract in that state (or zero-vehicle tract if requested)
  if (patch.stateCode) {
    const sorted = !effectiveIntake.hasHouseholdVehicle
      ? [...bundle.tracts].sort((a, b) => b.no_vehicle_rate - a.no_vehicle_rate)
      : [...bundle.tracts].sort(
          (a, b) =>
            b.poverty_rate * 0.6 +
            (b.children_under_5_count / 500) * 0.4 -
            (a.poverty_rate * 0.6 + (a.children_under_5_count / 500) * 0.4)
        );
    if (sorted[0]) {
      tract = sorted[0];
      patch.tractGeoid = tract.census_tract_geoid;
    }
  }

  // Also check if user mentioned a specific county name in that state!
  const matchedCountyTract = bundle.tracts.find((t) =>
    lower.includes(t.county_name.toLowerCase().replace(' county', ''))
  );
  if (
    matchedCountyTract &&
    matchedCountyTract.census_tract_geoid !== tract.census_tract_geoid
  ) {
    tract = matchedCountyTract;
    patch.tractGeoid = tract.census_tract_geoid;
    appliedBadges.push({ label: `Neighborhood → ${tract.county_name}` });
  }

  const chains = reconstructHistoricalChains(bundle.providers, bundle.referrals);
  const bounceHubs = computeBounceHubDiagnostics(bundle.providers, chains);
  const equity = computePostOutputEquityAudit(bundle.tracts, chains);
  const routing = findPathwaysForReferral(
    effectiveIntake,
    tract,
    bundle.providers,
    bundle.referrals,
    chains
  );
  const rec: CandidatePathway | null = routing.recommended;
  const notes = generateCaregiverNotes(
    effectiveIntake,
    tract,
    rec,
    bundle.agencies[0]
  );

  // Intent Classification
  const wantsParentNote =
    /\b(parent|parents|caregiver|family note|action note|letter|spanish note|en español|confirmación|familia)\b/i.test(
      q
    );
  const wantsBounceAudit =
    /\b(bounce|bottleneck|fax|flat sql|spreadsheet|waitlist|why did|breach|hub|fix saves)\b/i.test(
      q
    ) && !/\b(which provider path|which path|route today)\b/i.test(q);
  const wantsEquity =
    /\b(equity|disparity|neighborhoods bear|poverty|audit|nsch|limited_english_rate|demographic)\b/i.test(
      q
    );

  // INTENT A: Parent / Caregiver Note (Spanish or English)
  if (wantsParentNote) {
    const wantsSpanish =
      asksInSpanish ||
      /\b(spanish|español|espanol|bilingual)\b/i.test(q) ||
      effectiveIntake.primaryLanguage === 'Spanish';

    if (wantsSpanish) {
      return {
        markdown: `Here is the plain-language **Spanish confirmation** for the family (${tract.county_name}):\n\n${notes.es}`,
        spokenText: rec
          ? `Hola. La evaluación bilingüe para su bebé de ${effectiveIntake.childAgeMonths} meses está confirmada sin costo con Medicaid. Completaremos todo el proceso en aproximadamente ${rec.totalExpectedDays} días, bien dentro del límite federal de 45 días, a través de ${cleanOrgName(rec.steps[2].node.synthetic_organization_name)} en ${rec.steps[2].node.city}.`
          : notes.es,
        spokenLang: 'es-US',
        intakePatch: Object.keys(patch).length ? patch : undefined,
        appliedBadges,
        suggestedFollowUps: [
          'Read the English caregiver version',
          'What if the family has no car?',
          'Which fax hub did we avoid?',
        ],
      };
    }

    return {
      markdown: `Here is the plain-language **Caregiver Action Note** (${tract.county_name}):\n\n${notes.en}`,
      spokenText: rec
        ? `Here is the family summary: Your ${effectiveIntake.childAgeMonths}-month-old's developmental evaluation is fast-tracked at zero cost under Medicaid. Your coordinator calls within ${rec.steps[1].cumulativeDays} days, evaluation happens at ${cleanOrgName(rec.steps[2].node.synthetic_organization_name)} by day ${rec.steps[2].cumulativeDays}, and therapy begins around day ${rec.totalExpectedDays}, clearing the 45-day deadline.`
        : notes.en,
      spokenLang: 'en-US',
      intakePatch: Object.keys(patch).length ? patch : undefined,
      appliedBadges,
      suggestedFollowUps: [
        'Translate caregiver note to Spanish',
        'Show backup provider route',
        'Why do paper-fax hubs breach 45 days?',
      ],
    };
  }

  // INTENT B: Regional Bounce Hub / Bottleneck Explanation
  if (wantsBounceAudit) {
    const worst = bounceHubs[0];
    const bestFix = [...bounceHubs].sort(
      (a, b) => b.counterfactualSavedChildDays - a.counterfactualSavedChildDays
    )[0];

    const md = worst
      ? [
          `In **${STATE_META[effectiveIntake.stateCode].name}**, flat waitlist spreadsheets mislead coordinators:`,
          `• **Hidden Bounce Hub:** \`${worst.coordinator.provider_id}\` (*${cleanOrgName(worst.coordinator.synthetic_organization_name)}* — \`[Synthetic]\`) shows only a **${worst.coordinator.median_internal_wait_days}-day internal wait**, so flat SQL ranks it as healthy.`,
          `• **Multi-Hop Graph Reality:** Traversing 2-to-4-hop \`case_chain_id\` chains shows **${worst.chainsOver45d} of its ${worst.routedEpisodes} episodes (${worst.breachRatePct}%) breach 45 days**, averaging **${worst.meanEpisodeWaitDays} days** because \`paper_fax\` handoffs (${worst.faxSharePct}% of hops) hit saturated or non-bilingual evaluation hubs.`,
          bestFix
            ? `• **Highest-Impact Fix:** Switching \`${bestFix.coordinator.provider_id}\` to electronic portal intake with bilingual slot pre-checks saves **${bestFix.counterfactualSavedChildDays} delayed child-days** and brings **${bestFix.counterfactualSavedChains} breached chains** back under 45 days.`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : 'No bounce hubs found for the selected state.';

    return {
      markdown: md,
      spokenText: worst
        ? `In ${STATE_META[effectiveIntake.stateCode].name}, flat spreadsheets miss ${cleanOrgName(worst.coordinator.synthetic_organization_name)}. Its internal wait is only ${worst.coordinator.median_internal_wait_days} days, yet ${worst.chainsOver45d} of its ${worst.routedEpisodes} referrals breach 45 days due to paper fax bounces. Upgrading it to electronic intake saves ${bestFix?.counterfactualSavedChildDays ?? 0} child-days.`
        : 'No bounce hubs detected.',
      spokenLang: 'en-US',
      intakePatch: Object.keys(patch).length ? patch : undefined,
      appliedBadges,
      suggestedFollowUps: [
        'Simulate upgrading paper fax to e-Portal',
        'Which path clears 45 days for today’s toddler?',
        'Which neighborhoods suffer >45d breaches?',
      ],
    };
  }

  // INTENT C: Equity Audit & Data Traps
  if (wantsEquity) {
    const breached = equity.find((e) => e.label.startsWith('Breached'));
    const timely = equity.find((e) => e.label.startsWith('Timely'));
    const nonEngNsch = bundle.nsch.find((s) =>
      s.primary_home_language.includes('Non-English')
    );
    const engNsch = bundle.nsch.find(
      (s) => !s.primary_home_language.includes('Non-English')
    );

    const md = [
      `**Post-Output Equity Audit (${STATE_META[effectiveIntake.stateCode].name}):**`,
      `• **Fairness Rule:** Demographic \`audit_*\` shares are **strictly excluded** from routing decisions and joined only afterward.`,
      breached && timely
        ? `• **Neighborhood Burden:** Families stuck in \`>45-day\` bounce chains live in tracts averaging **${breached.avgPovertyPct.toFixed(1)}% poverty** and **${breached.avgNoVehiclePct.toFixed(1)}% zero-vehicle households** (vs. ${timely.avgPovertyPct.toFixed(1)}% poverty and ${timely.avgNoVehiclePct.toFixed(1)}% zero-vehicle for timely chains).`
        : '',
      nonEngNsch && engNsch
        ? `• **Statewide Screening Context (HRSA NSCH):** Non-English households have a **${(nonEngNsch.standardized_screening_rate_pct * 100).toFixed(1)}%** screening rate vs. **${(engNsch.standardized_screening_rate_pct * 100).toFixed(1)}%** in English-primary households. *(Note: ACS \`limited_english_rate\` is \`0.0\` across this extract, so we never weight on it.)*`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      markdown: md,
      spokenText:
        breached && timely
          ? `Our post-output equity audit in ${STATE_META[effectiveIntake.stateCode].name} shows that breached chains hit neighborhoods with ${breached.avgPovertyPct.toFixed(0)} percent poverty and ${breached.avgNoVehiclePct.toFixed(0)} percent zero-vehicle households. Demographic audit columns are never used inside routing rules.`
          : 'Equity audit completed.',
      spokenLang: 'en-US',
      intakePatch: Object.keys(patch).length ? patch : undefined,
      appliedBadges,
      suggestedFollowUps: [
        'Route a zero-vehicle family in this state',
        'Which path clears 45 days today?',
        'Generate bilingual caregiver note',
      ],
    };
  }

  // DEFAULT / PRIMARY INTENT: Route Today's Referral under the 45-Day Clock!
  if (!rec) {
    return {
      markdown: `No standard local pathway in **${STATE_META[effectiveIntake.stateCode].name}** cleared all constraints under 45 days. Recommend immediate **regional Part C mobile bilingual evaluation** or toggling the **e-Referral Fix**.`,
      spokenText: `No standard local route cleared all constraints under 45 days in ${STATE_META[effectiveIntake.stateCode].name}. Please authorize a mobile bilingual evaluation or simulate the electronic portal upgrade.`,
      spokenLang: asksInSpanish ? 'es-US' : 'en-US',
      intakePatch: Object.keys(patch).length ? patch : undefined,
      appliedBadges,
      suggestedFollowUps: [
        'Simulate upgrading paper fax to e-Portal',
        'Why are routes delayed in this state?',
      ],
    };
  }

  const clinicName = cleanOrgName(rec.steps[0].node.synthetic_organization_name);
  const coordName = cleanOrgName(rec.steps[1].node.synthetic_organization_name);
  const evalName = cleanOrgName(rec.steps[2].node.synthetic_organization_name);
  const vendorName = cleanOrgName(rec.steps[3].node.synthetic_organization_name);
  const trapDays = routing.historicalTrapChain?.totalWaitDays;
  const ageCliffMonths = 36 - effectiveIntake.childAgeMonths;

  if (asksInSpanish) {
    const mdEs = [
      `✅ **Ruta recomendada en ${tract.county_name} (${rec.totalExpectedDays} días — ${rec.daysMargin} días antes del límite federal de 45 días):**`,
      `1. **Clínica de origen:** ${clinicName} (\`Día 0\`)`,
      `2. **Coordinación Parte C:** ${coordName} (\`+${rec.steps[1].expectedStepWaitDays}d\` por portal electrónico)`,
      `3. **Evaluación Bilingüe Medicaid:** ${evalName} en ${rec.steps[2].node.city} (\`+${rec.steps[2].expectedStepWaitDays}d\`, a **${rec.evalHubDistanceKm} km**)`,
      `4. **Terapia Temprana (IFSP):** ${vendorName} (\`+${rec.steps[3].expectedStepWaitDays}d\` · Total **${rec.totalExpectedDays} días**)`,
      rec.transportAdvisory
        ? `🚐 **Apoyo de transporte:** Se recomienda transporte gratuito de Medicaid (NEMT) o evaluación móvil.`
        : '',
      `*(Organizaciones 100% \`[Synthetic]\`)*`,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      markdown: mdEs,
      spokenText: `La ruta más rápida desde ${tract.county_name} completa la evaluación bilingüe con Medicaid y el plan IFSP en ${rec.totalExpectedDays} días, con ${rec.daysMargin} días de margen antes del límite de 45 días. Pasa electrónicamente por ${coordName} hacia ${evalName}, a ${rec.evalHubDistanceKm} kilómetros de su vecindario.`,
      spokenLang: 'es-US',
      intakePatch: Object.keys(patch).length ? patch : undefined,
      appliedBadges,
      suggestedFollowUps: [
        'Escribe la carta para los padres en español',
        '¿Qué pasa si la familia no tiene auto?',
        '¿Dónde están los cuellos de botella por fax?',
      ],
    };
  }

  const mdEn = [
    `✅ **Clears the 45-day clock in ${rec.totalExpectedDays} days** (${rec.daysMargin}-day buffer${trapDays ? `, saving **${trapDays - rec.totalExpectedDays} days** vs. the ${trapDays}d paper-fax bounce loop` : ''}) from **${tract.county_name}** (\`${tract.census_tract_geoid}\`):`,
    `1. **Origin Screen:** ${clinicName} (\`${rec.steps[0].distanceFromHomeKm} km\`)`,
    `2. **Part C Intake (\`Day ${rec.steps[1].cumulativeDays}\`):** ${coordName} via electronic portal`,
    `3. **Bilingual Medicaid Eval (\`Day ${rec.steps[2].cumulativeDays}\`):** ${evalName} in ${rec.steps[2].node.city} (**${rec.evalHubDistanceKm} km** away)`,
    `4. **IFSP Therapy Start (\`Day ${rec.totalExpectedDays}\`):** ${vendorName} (Medicaid + Part C + Bilingual verified)`,
    ageCliffMonths <= 6
      ? `⚠️ **36-Month Cliff Alert:** At ${effectiveIntake.childAgeMonths}m, only **${ageCliffMonths} months** remain in Part C—initiate Part B preschool co-notification alongside intake.`
      : '',
    rec.transportAdvisory ? `🚐 **Transport Guardrail:** ${rec.transportAdvisory}` : '',
    `*(All \`SYN-PROV-*\` nodes are 100% \`[Synthetic]\`)*`,
  ]
    .filter(Boolean)
    .join('\n');

  const spokenEn = [
    `From ${tract.county_name}, the recommended Medicaid bilingual route clears the 45-day clock in ${rec.totalExpectedDays} calendar days, with ${rec.daysMargin} days to spare.`,
    `Send an electronic referral from ${clinicName} to ${coordName}, which schedules a bilingual evaluation at ${evalName}, ${rec.evalHubDistanceKm} kilometers away, followed by therapy with ${vendorName}.`,
    !effectiveIntake.hasHouseholdVehicle && rec.evalHubDistanceKm > 20
      ? `Because the family has no vehicle and the hub is ${rec.evalHubDistanceKm} kilometers away, authorize free Medicaid transport or mobile evaluation at intake.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    markdown: mdEn,
    spokenText: spokenEn,
    spokenLang: 'en-US',
    intakePatch: Object.keys(patch).length ? patch : undefined,
    appliedBadges,
    suggestedFollowUps: [
      'Draft Spanish note for the parents',
      'What if the family has no car?',
      'Why did flat spreadsheets miss the fax hub?',
    ],
  };
}
