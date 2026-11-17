"""Pydantic v2 structured contracts for the 45-Day Pathway & Bottleneck Brief and Workbench APIs.

Enforces statutory IDEA Part C (`34 CFR § 303.310`) invariants and Anti-Bias Data
Governance (`audit_*` exclusion from routing models, 6-row `'Statewide'` HRSA NSCH
grain preservation, leading-zero 11-digit Census tract GEOIDs, and bilingual EN/ES
caregiver action notes) at schema validation time.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_AUDIT_DEMOGRAPHIC_KEY_RE = re.compile(r"^audit_[a-z0-9_]*$", re.IGNORECASE)
_TRACT_GEOID_RE = re.compile(r"^\d{11}$")
_STATE_CODE_RE = re.compile(r"^[A-Z]{2}$")


def _find_forbidden_audit_keys(
    value: Any,
    *,
    allowed_container_keys: frozenset[str] = frozenset(),
    path: str = "",
) -> list[str]:
    """Recursively locates any `audit_*` demographic keys inside routing structures."""
    hits: list[str] = []
    if isinstance(value, dict):
        for k, v in value.items():
            key_str = str(k)
            cur_path = f"{path}.{key_str}" if path else key_str
            if key_str in allowed_container_keys:
                continue
            if _AUDIT_DEMOGRAPHIC_KEY_RE.match(key_str):
                hits.append(cur_path)
            hits.extend(
                _find_forbidden_audit_keys(
                    v,
                    allowed_container_keys=allowed_container_keys,
                    path=cur_path,
                )
            )
    elif isinstance(value, (list, tuple)):
        for idx, item in enumerate(value):
            cur_path = f"{path}[{idx}]"
            hits.extend(
                _find_forbidden_audit_keys(
                    item,
                    allowed_container_keys=allowed_container_keys,
                    path=cur_path,
                )
            )
    return hits


def _enforce_no_audit_keys(
    data: Any,
    model_name: str,
    *,
    allowed_container_keys: frozenset[str] = frozenset(),
) -> Any:
    """Raises `ValueError` if any `audit_*` key is present in `data`."""
    hits = _find_forbidden_audit_keys(
        data,
        allowed_container_keys=allowed_container_keys,
    )
    if hits:
        joined = ", ".join(sorted(set(hits)))
        raise ValueError(
            f"Anti-Bias Routing Firewall violation in {model_name}: post-output "
            f"demographic column(s) [{joined}] are strictly prohibited in routing/triage "
            "models and may only appear in post-output equity audit structures."
        )
    return data


class ChildProfile(BaseModel):
    """Non-racial child & home-neighborhood intake profile for Track 1 IDEA Part C routing."""

    model_config = ConfigDict(extra="allow")

    state_code: str
    home_tract_geoid: str = ""
    county_name: str = ""
    tract_children_under_5: int = Field(default=0, ge=0)
    tract_poverty_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    tract_zero_vehicle_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    child_age_months: int | None = Field(default=None, ge=0)
    concern_domain: str = "Expressive Speech/Language"
    needs_medicaid: bool = True
    needs_bilingual: bool = True
    has_household_vehicle: bool = False
    est_age_at_ifsp_recommended_months: float | None = None
    est_age_at_ifsp_if_bounced_months: float | None = None
    statutory_transition_tier: str | dict[str, Any] | None = None

    @model_validator(mode="before")
    @classmethod
    def _reject_audit_keys_before(cls, data: Any) -> Any:
        return _enforce_no_audit_keys(data, "ChildProfile")

    @model_validator(mode="after")
    def _validate_post_invariants(self) -> ChildProfile:
        if self.model_extra:
            _enforce_no_audit_keys(self.model_extra, "ChildProfile")
        if self.home_tract_geoid and not _TRACT_GEOID_RE.fullmatch(self.home_tract_geoid):
            raise ValueError(
                f"home_tract_geoid must be an 11-digit string preserving leading zeros, got {self.home_tract_geoid!r}"
            )
        if not _STATE_CODE_RE.fullmatch(self.state_code.strip().upper()):
            raise ValueError(f"state_code must be a 2-letter uppercase code, got {self.state_code!r}")
        self.state_code = self.state_code.strip().upper()
        return self


class GuardrailAlert(BaseModel):
    """Statutory or operational safeguard callout (e.g., 36m Part C cliff, Zero-Vehicle NEMT)."""

    model_config = ConfigDict(extra="allow")

    code: str = Field(..., min_length=1)
    severity: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1)


class HopStep(BaseModel):
    """Single directed provider-to-provider referral handoff step."""

    model_config = ConfigDict(extra="allow")

    hop_sequence: int = Field(..., ge=1)
    source_provider_id: str = Field(..., min_length=1)
    source_name: str | None = None
    source_role: str | None = None
    target_provider_id: str = Field(..., min_length=1)
    target_name: str = Field(..., min_length=1)
    target_role: str = Field(..., min_length=1)
    target_city: str | None = None
    transmission_channel: str = Field(..., min_length=1)
    relationship_type: str | None = None
    handoff_wait_days: int = Field(..., ge=0)
    cumulative_wait_days: int = Field(..., ge=0)
    handoff_reason: str | None = None
    distance_from_home_km: float | None = Field(default=None, ge=0.0)
    is_bounce_hop: bool | None = None

    @model_validator(mode="before")
    @classmethod
    def _reject_audit_keys_before(cls, data: Any) -> Any:
        return _enforce_no_audit_keys(data, "HopStep")


class RecommendedPathway(BaseModel):
    """Verified `<=45`-day stage-valid IDEA Part C pathway (`34 CFR § 303.310`)."""

    model_config = ConfigDict(extra="allow")

    pathway_type: str
    rank_score: float | None = None
    total_hops: int = Field(..., ge=1)
    expected_cumulative_days: int = Field(..., ge=0)
    statutory_45d_headroom_days: int | None = None
    clears_45_day_clock: bool = True
    domain_matched: bool = True
    observed_corridor_hops: int = Field(default=0, ge=0)
    within_preferred_travel_km: bool = True
    eval_vendor_distance_km: float = Field(default=0.0, ge=0.0)
    max_family_travel_km: float = Field(default=0.0, ge=0.0)
    eval_hub_distance_km: float = Field(default=0.0, ge=0.0)
    therapy_vendor_distance_km: float = Field(default=0.0, ge=0.0)
    all_nodes_medicaid_enrolled: bool | None = None
    all_care_nodes_bilingual: bool | None = None
    nodes: list[str] = Field(default_factory=list)
    hops: list[HopStep] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _reject_audit_keys_before(cls, data: Any) -> Any:
        return _enforce_no_audit_keys(data, "RecommendedPathway")

    @model_validator(mode="after")
    def _validate_45_day_clock_and_firewall(self) -> RecommendedPathway:
        if self.model_extra:
            _enforce_no_audit_keys(self.model_extra, "RecommendedPathway")
        if self.clears_45_day_clock and self.expected_cumulative_days > 45:
            raise ValueError(
                f"Statutory 45-Day Clock violation: RecommendedPathway claims clears_45_day_clock=True "
                f"but expected_cumulative_days={self.expected_cumulative_days} exceeds 45 calendar days "
                "(34 CFR § 303.310)."
            )
        return self


class HistoricalBounceChain(BaseModel):
    """Cautionary historical `>45`-day multi-hop `paper_fax` / slot-mismatch bounce trace."""

    model_config = ConfigDict(extra="allow")

    case_chain_id: str = Field(..., min_length=1)
    historical_child_age_months: int | None = Field(default=None, ge=0)
    concern_domain: str | None = None
    total_hops: int = Field(..., ge=1)
    total_wait_days: int = Field(..., ge=0)
    days_over_45d_limit: int
    paper_fax_hops: int = Field(default=0, ge=0)
    hops: list[HopStep] = Field(default_factory=list)


class RoutingResult(BaseModel):
    """Complete Track 1 child pathway routing output (`find_compliant_45d_pathways`)."""

    model_config = ConfigDict(extra="allow")

    status: str = "ok"
    error_code: str | None = None
    message: str | None = None
    tract_resolution: str | None = None
    execution_engine: str
    synthetic_provenance_notice: str
    bias_firewall_verified: str | None = None
    iso_gql_query: str | None = None
    child_profile: ChildProfile
    recommended_pathway: RecommendedPathway | None = None
    alternative_compliant_pathways: list[dict[str, Any]] = Field(default_factory=list)
    cautionary_historical_bounce_chain: HistoricalBounceChain | None = None
    days_saved_vs_bounce_loop: int | None = None
    guardrail_alerts: list[GuardrailAlert] = Field(default_factory=list)
    packet_readiness: dict[str, Any] | None = None
    before_vs_after_rerouting_cohort: dict[str, Any] | None = None
    statutory_transition_tier: str | dict[str, Any] | None = None

    @model_validator(mode="after")
    def _verify_routing_firewall(self) -> RoutingResult:
        for alt in self.alternative_compliant_pathways:
            _enforce_no_audit_keys(alt, "RoutingResult.alternative_compliant_pathways")
        if self.packet_readiness is not None:
            _enforce_no_audit_keys(self.packet_readiness, "RoutingResult.packet_readiness")
        if self.before_vs_after_rerouting_cohort is not None:
            _enforce_no_audit_keys(
                self.before_vs_after_rerouting_cohort,
                "RoutingResult.before_vs_after_rerouting_cohort",
            )
        if self.statutory_transition_tier is not None:
            _enforce_no_audit_keys(
                self.statutory_transition_tier,
                "RoutingResult.statutory_transition_tier",
            )
        return self


class ViablePathCandidate(BaseModel):
    """Candidate `<=45`-day viable path returned by `find_viable_45d_paths`."""

    model_config = ConfigDict(extra="allow")

    start_provider_id: str
    start_name: str
    eval_provider_id: str
    eval_name: str
    eval_role: str
    hop_count: int = Field(..., ge=1)
    intake_lag_days: int = Field(..., ge=0)
    handoff_days: int = Field(..., ge=0)
    evaluator_backlog_days: int = Field(..., ge=0)
    total_expected_days: int = Field(..., ge=0)
    clears_45d_clock: bool = True
    distance_km: float = Field(default=0.0, ge=0.0)
    within_preferred_travel_km: bool | None = None
    accepts_medicaid: bool = True
    bilingual_services_listed: bool = True
    domain_matched: bool = True
    observed_corridor_hops: int = Field(default=0, ge=0)
    relationship_type: str | None = None
    specialty_requested: str | None = None
    nodes: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _reject_audit_keys_before(cls, data: Any) -> Any:
        return _enforce_no_audit_keys(data, "ViablePathCandidate")

    @model_validator(mode="after")
    def _validate_viable_45d_budget(self) -> ViablePathCandidate:
        if self.clears_45d_clock and self.total_expected_days > 45:
            raise ValueError(
                f"ViablePathCandidate total_expected_days={self.total_expected_days} exceeds 45 days."
            )
        return self


class ViablePathsResult(BaseModel):
    """Complete output of `find_viable_45d_paths` ISO GQL capability + bounce-pruning traversal."""

    model_config = ConfigDict(extra="allow")

    status: str = "ok"
    error_code: str | None = None
    message: str | None = None
    tract_resolution: str | None = None
    engine: str
    synthetic_provenance_notice: str
    iso_gql_query: str | None = None
    query_parameters: dict[str, Any] = Field(default_factory=dict)
    tract_context: dict[str, Any] = Field(default_factory=dict)
    viable_paths: list[ViablePathCandidate] = Field(default_factory=list)
    pruned_high_bounce_edges_count: int = Field(default=0, ge=0)
    pruned_congested_or_bounce_nodes_count: int = Field(default=0, ge=0)
    guardrail_alerts: list[GuardrailAlert] = Field(default_factory=list)

    @model_validator(mode="after")
    def _verify_tract_context_firewall(self) -> ViablePathsResult:
        _enforce_no_audit_keys(self.tract_context, "ViablePathsResult.tract_context")
        geoid = str(self.tract_context.get("census_tract_geoid", ""))
        if geoid and not _TRACT_GEOID_RE.fullmatch(geoid):
            raise ValueError(
                f"tract_context.census_tract_geoid must be an 11-digit GEOID string, got {geoid!r}"
            )
        return self


class NetworkTotals(BaseModel):
    """Prefix-deduplicated multi-hop referral network summary totals."""

    model_config = ConfigDict(extra="allow")

    total_complete_chains: int = Field(..., ge=0)
    chains_3_to_4_hops: int = Field(..., ge=0)
    statutory_breaches_over_45d: int = Field(..., ge=0)
    overall_timely_45d_pct: float = Field(..., ge=0.0, le=100.0)
    toddlers_30m_plus_in_breach: int = Field(..., ge=0)


class CoordinatorAuditRow(BaseModel):
    """Per-Intake-Coordinator multi-hop breach attribution row."""

    model_config = ConfigDict(extra="allow")

    provider_id: str
    city: str
    flat_active_waitlist: int = Field(..., ge=0)
    flat_median_internal_wait_days: int = Field(..., ge=0)
    routed_episodes: int = Field(..., ge=0)
    breached_over_45d: int = Field(..., ge=0)
    total_excess_days_over_45: int = Field(..., ge=0)
    mean_episode_wait_days: float | None = Field(default=None, ge=0.0)
    breach_rate_pct: float = Field(..., ge=0.0, le=100.0)
    synthetic_organization_name: str | None = None


class NetworkAuditResult(BaseModel):
    """Complete Track 2 multi-hop network audit output (`audit_multihop_bounce_hubs`)."""

    model_config = ConfigDict(extra="allow")

    execution_engine: str
    state_code: str
    synthetic_provenance_notice: str
    iso_gql_query: str
    network_totals: NetworkTotals
    hop_depth_breakdown: list[dict[str, Any]] = Field(default_factory=list)
    transmission_channel_impact: list[dict[str, Any]] = Field(default_factory=list)
    naive_flat_waitlist_top5_misleading: list[dict[str, Any]] = Field(default_factory=list)
    intake_coordinator_bounce_hub_ranking: list[CoordinatorAuditRow] = Field(default_factory=list)
    top_hidden_bounce_hub: CoordinatorAuditRow | None = None
    downstream_re_referral_bounce_triggers: list[dict[str, Any]] = Field(default_factory=list)
    sample_traced_episodes: list[dict[str, Any]] = Field(default_factory=list)


class BottleneckHubRow(BaseModel):
    """Intermediate bottleneck hub ranked by breached-chain betweenness flow share."""

    model_config = ConfigDict(extra="allow")

    provider_id: str
    organization_name: str
    node_role: str
    flat_internal_wait_days: int = Field(..., ge=0)
    breached_paths_through_hub: int = Field(..., ge=0)
    betweenness_flow_share_pct: float = Field(..., ge=0.0, le=100.0)
    bounce_rate_pct: float = Field(..., ge=0.0, le=100.0)
    paper_fax_share_pct: float = Field(..., ge=0.0, le=100.0)
    primary_bounce_reason: str | None = None


class BottleneckHubsResult(BaseModel):
    """Regional betweenness bottleneck audit output (`detect_regional_bottleneck_hubs`)."""

    model_config = ConfigDict(extra="allow")

    engine: str
    synthetic_provenance_notice: str
    iso_gql_query: str
    region: str
    max_days_threshold: int = Field(..., ge=1)
    total_breached_multihop_chains: int = Field(..., ge=0)
    bottleneck_hubs: list[BottleneckHubRow] = Field(default_factory=list)
    key_finding: str


class CounterfactualImpactSummary(BaseModel):
    """Quantified statutory impact of upgrading a Bounce Hub (`paper_fax` -> `ehr_electronic_portal`)."""

    model_config = ConfigDict(extra="allow")

    episodes_evaluated: int = Field(..., ge=0)
    baseline_breaches_over_45d: int = Field(..., ge=0)
    simulated_breaches_over_45d: int = Field(..., ge=0)
    breaches_eliminated: int = Field(..., ge=0)
    mean_episode_wait_before_days: float = Field(..., ge=0.0)
    mean_episode_wait_after_days: float = Field(..., ge=0.0)
    total_delayed_child_days_saved: int = Field(..., ge=0)


class CounterfactualSimulationResult(BaseModel):
    """Complete Track 2 counterfactual Bounce Hub simulation output (`simulate_hub_intervention`)."""

    model_config = ConfigDict(extra="allow")

    state_code: str
    target_intervention_scope: str
    target_organization_name: str
    flat_spreadsheet_appearance: dict[str, Any] | None = None
    levers_applied: dict[str, bool] = Field(default_factory=dict)
    impact_summary: CounterfactualImpactSummary
    total_episodes_simulated: int = Field(..., ge=0)
    episode_level_simulation: list[dict[str, Any]] = Field(default_factory=list)


class EquityOutcomeStratum(BaseModel):
    """Post-output neighborhood demographic & mobility profile stratified by IFSP timeliness."""

    model_config = ConfigDict(extra="allow")

    ifsp_status: str
    episodes: int = Field(..., ge=0)
    mean_wait_days: float = Field(..., ge=0.0)
    avg_tract_poverty_pct: float = Field(..., ge=0.0, le=100.0)
    avg_zero_vehicle_pct: float = Field(..., ge=0.0, le=100.0)
    audit_black_pct: float = Field(..., ge=0.0, le=100.0)
    audit_hispanic_pct: float = Field(..., ge=0.0, le=100.0)
    audit_indigenous_pct: float = Field(..., ge=0.0, le=100.0)
    audit_asian_pct: float = Field(..., ge=0.0, le=100.0)
    audit_white_pct: float = Field(..., ge=0.0, le=100.0)


class NschStratum(BaseModel):
    """Statewide-only HRSA NSCH developmental screening survey stratum (prevents 6x tract fan-out)."""

    model_config = ConfigDict(extra="allow")

    survey_stratum_id: str | None = None
    geographic_level: str = "Statewide"
    household_income_fpl_band: str
    primary_home_language: str
    standardized_screening_rate_pct: float = Field(..., ge=0.0, le=100.0)
    followup_requested_pct: float = Field(..., ge=0.0, le=100.0)
    margin_of_error_pct: float | None = None

    @field_validator("geographic_level")
    @classmethod
    def _enforce_statewide_grain(cls, v: str) -> str:
        if v.strip() != "Statewide":
            raise ValueError(
                f"HRSA NSCH grain violation: geographic_level must be 'Statewide' (got {v!r})."
            )
        return "Statewide"


class GovernanceAttestation(BaseModel):
    """Programmatic governance attestation for `audit_*`, ACS LEP `0.0` trap, and NSCH grain."""

    model_config = ConfigDict(extra="allow")

    audit_columns_excluded_from_routing: bool | None = None
    audit_columns_excluded_from_scoring: bool | None = None
    audit_columns_excluded_from_scoring_and_filtering: bool | None = None
    acs_limited_english_rate_trap_caught: str = Field(..., min_length=1)
    nsch_statewide_grain_preserved: str = Field(..., min_length=1)

    @model_validator(mode="after")
    def _verify_attestation_flags(self) -> GovernanceAttestation:
        flags = [
            f
            for f in (
                self.audit_columns_excluded_from_routing,
                self.audit_columns_excluded_from_scoring,
                self.audit_columns_excluded_from_scoring_and_filtering,
            )
            if f is not None
        ]
        if not flags or not all(flags):
            raise ValueError(
                "GovernanceAttestation must affirm that audit_* columns were excluded from routing/scoring."
            )
        return self


class EquityAuditResult(BaseModel):
    """Post-output Equity Audit result (`run_post_output_equity_audit`)."""

    model_config = ConfigDict(extra="allow")

    execution_engine: str
    state_code: str
    governance_attestation: GovernanceAttestation
    breach_vs_timely_neighborhood_equity: list[EquityOutcomeStratum] = Field(default_factory=list)
    furthest_tracts_from_bilingual_eval_hub: list[dict[str, Any]] = Field(default_factory=list)
    statewide_nsch_screening_context: list[NschStratum] = Field(default_factory=list)


class ScreeningPriorityTract(BaseModel):
    """Track 3 priority neighborhood paired with a verified `<=45`-day downstream pathway."""

    model_config = ConfigDict(extra="allow")

    census_tract_geoid: str
    county_name: str
    children_under_5_count: int = Field(..., ge=0)
    poverty_pct: float = Field(..., ge=0.0, le=100.0)
    zero_vehicle_pct: float = Field(..., ge=0.0, le=100.0)
    non_racial_outreach_priority_score: float = Field(..., ge=0.0)
    verified_downstream_45d_pathway: dict[str, Any]

    @model_validator(mode="before")
    @classmethod
    def _reject_audit_keys_before(cls, data: Any) -> Any:
        return _enforce_no_audit_keys(data, "ScreeningPriorityTract")

    @field_validator("census_tract_geoid")
    @classmethod
    def _validate_geoid(cls, v: str) -> str:
        if not _TRACT_GEOID_RE.fullmatch(v):
            raise ValueError(
                f"census_tract_geoid must be an 11-digit string preserving leading zeros, got {v!r}"
            )
        return v


class ScreeningOutreachResult(BaseModel):
    """Track 3 community screening priority tracts output (`prioritize_community_screening_tracts`)."""

    model_config = ConfigDict(extra="allow")

    state_code: str
    formula_note: str
    priority_screening_tracts: list[ScreeningPriorityTract] = Field(default_factory=list)


class OutreachZoneRow(BaseModel):
    """Ranked outreach zone with hidden Early Intervention desert indicator and post-output equity context."""

    model_config = ConfigDict(extra="allow")

    census_tract_geoid: str
    county_name: str
    children_under_5_count: int = Field(..., ge=0)
    poverty_pct: float = Field(..., ge=0.0, le=100.0)
    zero_vehicle_pct: float = Field(..., ge=0.0, le=100.0)
    nearest_any_clinic_km: float = Field(..., ge=0.0)
    reachable_45d_paths_count: int = Field(..., ge=0)
    is_hidden_ei_desert: bool
    mobility_support_recommended: bool
    outreach_priority_score: float = Field(..., ge=0.0)
    post_output_equity_context: dict[str, float] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _reject_top_level_audit_keys(cls, data: Any) -> Any:
        return _enforce_no_audit_keys(
            data,
            "OutreachZoneRow",
            allowed_container_keys=frozenset({"post_output_equity_context"}),
        )

    @field_validator("census_tract_geoid")
    @classmethod
    def _validate_geoid(cls, v: str) -> str:
        if not _TRACT_GEOID_RE.fullmatch(v):
            raise ValueError(
                f"census_tract_geoid must be an 11-digit string preserving leading zeros, got {v!r}"
            )
        return v


class OutreachZonesResult(BaseModel):
    """Track 3 hidden Early Intervention desert & outreach zone ranking (`rank_outreach_zones`)."""

    model_config = ConfigDict(extra="allow")

    engine: str
    synthetic_provenance_notice: str
    iso_gql_query: str
    filters_applied: dict[str, Any] = Field(default_factory=dict)
    hidden_ei_deserts_count: int = Field(..., ge=0)
    statewide_nsch_screening_gap_context: list[NschStratum] = Field(default_factory=list)
    ranked_outreach_zones: list[OutreachZoneRow] = Field(default_factory=list)
    governance_attestation: GovernanceAttestation


class AgencyKpiRow(BaseModel):
    """OSEP Indicator C7 calibrated `[Synthetic]` regional Part C lead agency KPI row."""

    model_config = ConfigDict(extra="allow")

    agency_id: str = Field(..., min_length=1)
    state_code: str
    served_counties: str
    synthetic_agency_name: str = Field(..., min_length=1)
    reporting_fiscal_year: str | int
    annual_referrals_received: int = Field(..., ge=0)
    evaluations_completed_count: int = Field(..., ge=0)
    initial_ifsp_within_45_days_count: int = Field(..., ge=0)
    timely_45d_ifsp_pct: float = Field(..., ge=0.0, le=100.0)
    ifsp_delayed_capacity_count: int = Field(..., ge=0)
    ifsp_delayed_family_count: int = Field(..., ge=0)


class CaregiverNotes(BaseModel):
    """Warm, plain-language English & Spanish caregiver action notes."""

    model_config = ConfigDict(extra="allow")

    english: str
    spanish: str

    @field_validator("english", "spanish")
    @classmethod
    def _validate_non_empty_note(cls, v: str) -> str:
        if not isinstance(v, str) or not v.strip():
            raise ValueError("Caregiver action notes in both English and Spanish must be non-empty.")
        return v


class PathwayBrief(BaseModel):
    """Top-level validated 45-Day Pathway & Bottleneck Brief contract."""

    model_config = ConfigDict(extra="allow")

    state_code: str
    execution_engine: str
    agencies: list[AgencyKpiRow]
    routing: RoutingResult
    viable_45d_paths: ViablePathsResult
    network_audit: NetworkAuditResult
    bottleneck_hubs: BottleneckHubsResult
    counterfactual_simulation: CounterfactualSimulationResult
    equity_audit: EquityAuditResult
    screening_outreach: ScreeningOutreachResult
    outreach_zones: OutreachZonesResult
    caregiver_notes: CaregiverNotes
    runtime: dict[str, Any] | None = None
    packet_readiness: dict[str, Any] | None = None
    slot_holds: list[dict[str, Any]] = Field(default_factory=list)
    bq_telemetry: list[dict[str, Any]] | dict[str, Any] | None = None
    before_vs_after_rerouting_cohort: dict[str, Any] | None = None
    statutory_transition_tier: str | dict[str, Any] | None = None

    @field_validator("state_code")
    @classmethod
    def _validate_state_code(cls, v: str) -> str:
        cleaned = v.strip().upper()
        if not _STATE_CODE_RE.fullmatch(cleaned):
            raise ValueError(f"state_code must be a 2-letter uppercase state code, got {v!r}")
        return cleaned

    @model_validator(mode="after")
    def _verify_brief_routing_firewall(self) -> PathwayBrief:
        for field_label, val in (
            ("PathwayBrief.packet_readiness", self.packet_readiness),
            ("PathwayBrief.slot_holds", self.slot_holds),
            ("PathwayBrief.before_vs_after_rerouting_cohort", self.before_vs_after_rerouting_cohort),
            ("PathwayBrief.statutory_transition_tier", self.statutory_transition_tier),
        ):
            if val:
                _enforce_no_audit_keys(val, field_label)
        return self


class HealthResponseModel(BaseModel):
    """Typed `/api/health` runtime & telemetry response contract."""

    model_config = ConfigDict(extra="allow")

    status: str = "ok"
    agent: str
    gemini_model: str
    fallback_models: list[str] = Field(default_factory=list)
    sub_agents: list[dict[str, Any]] = Field(default_factory=list)
    sse_endpoints: list[str] = Field(default_factory=list)
    vertex_location: str = "global"
    llm_credentials_active: bool = False
    gcloud_adc_bridge_active: bool = False
    mcp_mode: str = ""
    state_code: str = "MS"
    state_name: str = "Mississippi"
    dataset: str = "a4i_early_intervention"
    project: str = ""
    bq_telemetry: list[dict[str, Any]] | dict[str, Any] | None = None


class ChatRequestModel(BaseModel):
    """API request payload for `POST /api/chat`."""

    model_config = ConfigDict(extra="ignore")

    message: str = Field(..., min_length=1, max_length=4000)
    session_id: str | None = None
    state_code: str | None = None

    @field_validator("message")
    @classmethod
    def _validate_non_blank_message(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message must not be blank or whitespace-only.")
        return v


class SimulateRequestModel(BaseModel):
    """API request payload for `POST /api/simulate`."""

    model_config = ConfigDict(extra="ignore")

    state_code: str | None = None
    target_provider_id: str = ""
    upgrade_fax_to_ehr: bool = True
    precheck_bilingual_and_slot_capacity: bool = True


class RunStreamRequestModel(BaseModel):
    """API request payload for SSE streaming multi-agent execution (`POST /api/run_stream`)."""

    model_config = ConfigDict(extra="ignore")

    message: str = Field(..., min_length=1, max_length=4000)
    session_id: str | None = None
    state_code: str | None = None
    child_tract_geoid: str | None = None
    child_age_months: int | None = Field(default=None, ge=0, le=35)

    @field_validator("message")
    @classmethod
    def _validate_non_blank_stream_message(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message must not be blank or whitespace-only.")
        return v


SSEEventType = Literal[
    "agent_start",
    "sub_agent_delegate",
    "tool_call",
    "tool_result",
    "token",
    "brief",
    "error",
    "done",
]


class SSEStreamEvent(BaseModel):
    """Typed Server-Sent Event envelope emitted during live ADK Coordinator & Sub-Agent streaming."""

    model_config = ConfigDict(extra="allow")

    event_type: SSEEventType
    agent_name: str | None = None
    sub_agent_name: str | None = None
    model_used: str | None = None
    tool_name: str | None = None
    content: str | None = None
    data: dict[str, Any] | None = None
    timestamp_ms: int | None = None

    def to_sse_frame(self) -> str:
        """Serializes the event into a standard `event: ...\ndata: ...\n\n` SSE wire frame."""
        payload = self.model_dump(mode="json", exclude_none=True)
        return f"event: {self.event_type}\ndata: {json.dumps(payload)}\n\n"


__all__ = [
    "AgencyKpiRow",
    "BottleneckHubRow",
    "BottleneckHubsResult",
    "CaregiverNotes",
    "ChatRequestModel",
    "ChildProfile",
    "CoordinatorAuditRow",
    "CounterfactualImpactSummary",
    "CounterfactualSimulationResult",
    "EquityAuditResult",
    "EquityOutcomeStratum",
    "GovernanceAttestation",
    "GuardrailAlert",
    "HealthResponseModel",
    "HistoricalBounceChain",
    "HopStep",
    "NetworkAuditResult",
    "NetworkTotals",
    "NschStratum",
    "OutreachZoneRow",
    "OutreachZonesResult",
    "PathwayBrief",
    "RecommendedPathway",
    "RoutingResult",
    "RunStreamRequestModel",
    "SSEEventType",
    "SSEStreamEvent",
    "ScreeningOutreachResult",
    "ScreeningPriorityTract",
    "SimulateRequestModel",
    "ViablePathCandidate",
    "ViablePathsResult",
]
