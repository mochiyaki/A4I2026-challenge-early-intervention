import type { CandidatePathway, ReferralIntakeInput } from '../types';

export interface LiveAgentResponse {
  mode: 'live-adk';
  summaryMarkdown: string;
  recommendedPathwayIds?: string[];
  caregiverNoteEn?: string;
  caregiverNoteEs?: string;
  rawPayload?: unknown;
}

const STORAGE_KEY = 'a4i_ei_agent_endpoint';

export function getSavedAgentEndpoint(): string {
  if (typeof window === 'undefined') return '';
  return (
    window.localStorage.getItem(STORAGE_KEY) ||
    (import.meta.env.VITE_AGENT_API_URL as string | undefined) ||
    ''
  );
}

export function saveAgentEndpoint(url: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = url.trim();
  if (trimmed) {
    window.localStorage.setItem(STORAGE_KEY, trimmed);
  } else {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

export function buildCoordinatorPrompt(
  intake: ReferralIntakeInput,
  topPathway: CandidatePathway | null
): string {
  const langClause =
    intake.primaryLanguage === 'English'
      ? 'English-speaking household'
      : `${intake.primaryLanguage}-speaking household requiring bilingual developmental evaluation`;
  const medicaidClause = intake.insuranceMedicaid
    ? 'enrolled in Medicaid'
    : 'commercial/private coverage';
  const vehicleClause = intake.hasHouseholdVehicle
    ? 'has household vehicle access'
    : 'zero-vehicle household (check travel distance & transport guardrails)';

  return [
    `Route today's IDEA Part C referral in ${intake.stateCode}:`,
    `- Child age: ${intake.childAgeMonths} months (${36 - intake.childAgeMonths} months before 36m Part C aging-out cliff)`,
    `- Home neighborhood census tract: ${intake.tractGeoid}`,
    `- Developmental concern: ${intake.concernDomain}`,
    `- Eligibility & access: ${medicaidClause}, ${langClause}, ${vehicleClause}`,
    topPathway
      ? `- Local graph candidate check: ${topPathway.steps.map((s) => s.node.provider_id).join(' -> ')} (${topPathway.totalExpectedDays} expected days)`
      : '',
    `Find the optimal <=45-day CareNode pathway using ReferralGraph (-{2,4}-> ISO GQL), diagnose regional paper_fax bounce hubs to avoid, run the post-output audit_* Equity Audit, and draft a bilingual English/Spanish caregiver action note.`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function queryLiveAgent(
  endpointUrl: string,
  intake: ReferralIntakeInput,
  prompt: string
): Promise<LiveAgentResponse> {
  const cleanUrl = endpointUrl.trim().replace(/\/$/, '');
  if (!cleanUrl) {
    throw new Error('No live ADK agent endpoint configured.');
  }

  const res = await fetch(cleanUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      state_code: intake.stateCode,
      child_home_tract_geoid: intake.tractGeoid,
      child_age_months: intake.childAgeMonths,
      accepts_medicaid: intake.insuranceMedicaid,
      bilingual_required: intake.primaryLanguage !== 'English',
      primary_language: intake.primaryLanguage,
      concern_domain: intake.concernDomain,
      has_household_vehicle: intake.hasHouseholdVehicle,
    }),
  });

  if (!res.ok) {
    throw new Error(`Agent endpoint returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const summaryMarkdown =
    typeof data?.response === 'string'
      ? data.response
      : typeof data?.output === 'string'
        ? data.output
        : typeof data?.text === 'string'
          ? data.text
          : JSON.stringify(data, null, 2);

  return {
    mode: 'live-adk',
    summaryMarkdown,
    recommendedPathwayIds: data?.recommended_pathway_ids,
    caregiverNoteEn: data?.caregiver_note_en,
    caregiverNoteEs: data?.caregiver_note_es,
    rawPayload: data,
  };
}
