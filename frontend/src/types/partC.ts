export type NodeRole =
  | 'Screening_Pediatric_Clinic'
  | 'Part_C_Intake_Coordinator'
  | 'Multidisciplinary_Eval_Hub'
  | 'EI_Therapy_Vendor';

export type TransmissionChannel =
  | 'ehr_electronic_portal'
  | 'paper_fax'
  | 'phone_voicemail';

export type ConcernDomain =
  | 'Social-Communication / Autism Screen'
  | 'Expressive Speech/Language'
  | 'Motor Milestone Delay'
  | 'Feeding & Sensory';

export interface TractDemographics {
  census_tract_geoid: string; // 11-char string with leading '06' preserved
  state_code: string;
  county_fips: string; // 5-char string with leading '06' preserved
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
  limited_english_rate: number; // All-zero trap in ACS extract (0.0)
  no_vehicle_rate: number;
  assistance_rate: number;
  // Post-output Equity Audit ONLY — NEVER used in routing priority rules!
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
  state_code: string;
  state_name: string;
  geographic_level: string; // Strictly 'Statewide' (6x fan-out trap if joined blindly)
  survey_cycle: string;
  household_income_fpl_band: string;
  primary_home_language: string;
  sampled_children_9_35m: number;
  standardized_screening_rate_pct: number;
  followup_requested_pct: number;
  margin_of_error_pct: number;
  data_provenance: string;
}

export interface AgencyPerformance {
  agency_id: string;
  state_code: string;
  served_counties: string;
  synthetic_agency_name: string;
  synthetic_office_address: string;
  reporting_fiscal_year: string;
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
  state_code: string;
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
  state_code: string;
  child_home_tract_geoid: string;
  child_age_months: number;
  concern_domain: ConcernDomain;
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

export interface CaDataset {
  acs_under5_tract_demographics: TractDemographics[];
  nsch_developmental_screening_survey: NschStratum[];
  idea_part_c_agency_performance: AgencyPerformance[];
  pediatric_and_ei_provider_directory: CareNode[];
  deidentified_part_c_referral_logs: ReferralHandoff[];
}

export interface ReferralIntakeForm {
  tractGeoid: string;
  childAgeMonths: number;
  medicaidRequired: boolean;
  bilingualRequired: boolean;
  concernDomain: ConcernDomain;
  priorDiagnosticEvalCompleted: boolean;
  originClinicId: string; // 'AUTO' or specific SYN-PROV-CA-001..008
}

export interface TraversedHop {
  hopIndex: number;
  fromNode: CareNode;
  toNode: CareNode;
  transmissionChannel: TransmissionChannel;
  expectedWaitDays: number;
  cumulativeWaitDays: number;
  dropoffRiskPct: number;
  handoffReason: string;
  distanceFromHomeKm: number;
  historicalSampleCount: number;
}

export interface CandidatePathway {
  pathId: string;
  pathwayType: '3-Hop Full Bilingual Evaluation + Therapy' | '2-Hop Direct Fast-Track IFSP' | 'Historical Bounce Trap';
  nodes: CareNode[];
  hops: TraversedHop[];
  totalWaitDays: number;
  daysBufferUnder45: number; // 45 - totalWaitDays (negative if breached)
  clears45DayClock: boolean;
  meetsMedicaid: boolean;
  meetsBilingual: boolean;
  meetsPartCVendor: boolean;
  fullyEligible: boolean;
  maxDistanceFromHomeKm: number;
  evalHubDistanceKm: number;
  zeroVehicleAlert: boolean;
  longDistanceTeleEvalAlert: boolean;
  agingOutCliffAlert: boolean;
  disqualificationReasons: string[];
  compositeRankScore: number;
  historicalChainExampleId?: string;
}

export interface CoordinatorBounceAudit {
  coordinator: CareNode;
  routedEpisodes: number;
  chains3PlusHops: number;
  chainsOver45Days: number;
  breachRatePct: number;
  meanChainWaitDays: number;
  paperFaxHopsCount: number;
  flatWaitlistRank: number; // Rank out of 30 when sorting naively by active_waitlist_count DESC
  trueBreachRank: number; // Rank when traversing multi-hop ReferralGraph
}

export interface CounterfactualFixResult {
  targetCoordinatorIds: string[];
  baselineBreachedChains: number;
  postFixBreachedChains: number;
  chainsRescuedUnder45Days: number;
  totalChildDaysSaved: number;
  baselineMeanWaitDays: number;
  postFixMeanWaitDays: number;
  affectedChainDetails: {
    caseChainId: string;
    childAgeMonths: number;
    concernDomain: string;
    homeTractGeoid: string;
    beforeDays: number;
    afterDays: number;
    rescuedUnder45: boolean;
  }[];
}

export interface EquityAuditGroup {
  groupLabel: string;
  episodesCount: number;
  avgWaitDays: number;
  avgPovertyPct: number;
  avgNoVehiclePct: number;
  auditHispanicPct: number;
  auditBlackPct: number;
  auditAsianPct: number;
  auditWhitePct: number;
  auditIndigenousPct: number;
}

export interface AgentEndpointConfig {
  mode: 'local_graph' | 'live_adk';
  baseUrl: string;
  appName: string;
  userId: string;
}
