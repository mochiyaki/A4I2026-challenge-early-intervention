export type StateCode = 'MS' | 'AL' | 'GA' | 'TX' | 'CA' | 'NY';

export type NodeRole =
  | 'Screening_Pediatric_Clinic'
  | 'Part_C_Intake_Coordinator'
  | 'Multidisciplinary_Eval_Hub'
  | 'EI_Therapy_Vendor';

export type TransmissionChannel =
  | 'paper_fax'
  | 'ehr_electronic_portal'
  | 'phone_voicemail';

export interface TractDemographic {
  census_tract_geoid: string;
  state_code: StateCode;
  county_fips: string;
  county_name: string;
  total_population: number;
  children_under_5_count: number;
  total_households: number;
  poverty_population_count: number;
  poverty_denom_count: number;
  limited_english_speaking_pop_count: number;
  zero_vehicle_households_count: number;
  median_household_income: number;
  poverty_rate: number;
  limited_english_rate: number; // Known all-0.0 trap in ACS extract!
  no_vehicle_rate: number;
  assistance_rate: number;
  // Post-output Equity Audit shares ONLY — strictly excluded from routing logic!
  audit_black_share: number;
  audit_hispanic_share: number;
  audit_asian_share: number;
  audit_indigenous_share: number;
  audit_white_share: number;
  latitude: number;
  longitude: number;
  data_provenance: string;
}

export interface NschStratum {
  survey_stratum_id: string;
  state_code: StateCode;
  state_name: string;
  geographic_level: string;
  survey_cycle: string;
  household_income_fpl_band: string;
  primary_home_language: string;
  sampled_children_9_35m: number;
  standardized_screening_rate_pct: number;
  followup_requested_pct: number;
  margin_of_error_pct: number;
  data_provenance: string;
}

export interface PartCAgency {
  agency_id: string;
  state_code: StateCode;
  served_counties: string;
  synthetic_agency_name: string;
  synthetic_office_address: string;
  reporting_fiscal_year: string | number;
  annual_referrals_received: number;
  evaluations_completed_count: number;
  initial_ifsp_within_45_days_count: number;
  ifsp_delayed_capacity_count: number;
  ifsp_delayed_family_count: number;
  intake_office_lat: number;
  intake_office_lon: number;
  data_provenance: string;
}

export interface CareNode {
  provider_id: string;
  state_code: StateCode;
  county_fips: string;
  county_name: string;
  city: string;
  synthetic_address: string;
  census_tract_geoid: string;
  synthetic_organization_name: string;
  node_role: NodeRole;
  specialty_description: string;
  part_c_vendor_enrolled: boolean;
  accepts_medicaid: boolean;
  bilingual_services_listed: boolean;
  monthly_slot_capacity: number;
  active_waitlist_count: number;
  median_internal_wait_days: number;
  latitude: number;
  longitude: number;
  data_provenance: string;
}

export interface ReferralHandoff {
  referral_event_id: string;
  case_chain_id: string;
  hop_sequence: number;
  state_code: StateCode;
  child_home_tract_geoid: string;
  child_age_months: number;
  concern_domain: string;
  source_provider_id: string;
  target_provider_id: string;
  receiving_agency_id: string;
  handoff_reason: string;
  transmission_channel: TransmissionChannel;
  handoff_wait_days: number;
  quarterly_referral_volume: number;
  dropoff_rate_pct: number;
  data_provenance: string;
  referral_date: string;
}

export interface StarterDataBundle {
  generatedAt: string;
  tracts: TractDemographic[];
  nsch: NschStratum[];
  agencies: PartCAgency[];
  providers: CareNode[];
  referrals: ReferralHandoff[];
}

export interface ReferralIntakeInput {
  stateCode: StateCode;
  tractGeoid: string;
  childAgeMonths: number;
  insuranceMedicaid: boolean;
  primaryLanguage: 'Spanish' | 'English' | 'Other Non-English';
  concernDomain: 'Speech & Language Delay' | 'Autism / Social Communication' | 'Motor / Adaptive Delay';
  hasHouseholdVehicle: boolean;
  simulateEhrUpgrade: boolean;
}

export interface PathStep {
  stepNumber: number;
  node: CareNode;
  distanceFromHomeKm: number;
  legDistanceKm: number;
  channelIn?: TransmissionChannel;
  expectedStepWaitDays: number;
  cumulativeDays: number;
  handoffNote: string;
}

export interface CandidatePathway {
  id: string;
  label: string;
  hopCount: number;
  steps: PathStep[];
  totalExpectedDays: number;
  clears45DayClock: boolean;
  daysMargin: number;
  maxDistanceFromHomeKm: number;
  evalHubDistanceKm: number;
  allMedicaid: boolean;
  allPartCEnrolled: boolean;
  evalBilingual: boolean;
  vendorBilingual: boolean;
  usesPaperFax: boolean;
  transportAdvisory: string | null;
  rationale: string;
}

export interface HistoricalChainTrace {
  caseChainId: string;
  childAgeMonths: number;
  concernDomain: string;
  homeTractGeoid: string;
  hops: {
    hopSequence: number;
    source: CareNode;
    target: CareNode;
    channel: TransmissionChannel;
    waitDays: number;
    cumulativeDays: number;
    reason: string;
    dropoffPct: number;
  }[];
  totalWaitDays: number;
  breached45d: boolean;
  faxHopCount: number;
  hadBounce: boolean;
}

export interface BounceHubSummary {
  coordinator: CareNode;
  routedEpisodes: number;
  chains3PlusHops: number;
  chainsOver45d: number;
  breachRatePct: number;
  meanEpisodeWaitDays: number;
  faxSharePct: number;
  counterfactualSavedChains: number;
  counterfactualSavedChildDays: number;
}

export interface EquityAuditGroup {
  label: 'Breached (>45 days)' | 'Timely (<=45 days)';
  episodes: number;
  avgPovertyPct: number;
  avgNoVehiclePct: number;
  auditBlackPct: number;
  auditHispanicPct: number;
  auditAsianPct: number;
  auditIndigenousPct: number;
  auditWhitePct: number;
}
