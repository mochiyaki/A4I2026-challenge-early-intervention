import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock,
  MapPin,
  TrendingDown,
} from 'lucide-react';
import { AgentChatSidebar } from './components/AgentChatSidebar';
import { AgentModal } from './components/AgentModal';
import { BriefAndCaregiverTabs } from './components/BriefAndCaregiverTabs';
import { IntakeSidebar } from './components/IntakeSidebar';
import { NetworkGraphCanvas } from './components/NetworkGraphCanvas';
import { PathwayClockComparison } from './components/PathwayClockComparison';
import { SyntheticBanner } from './components/SyntheticBanner';
import {
  buildIsoGqlSnippet,
  cleanOrgName,
  computeBounceHubDiagnostics,
  computePostOutputEquityAudit,
  findPathwaysForReferral,
  generateCaregiverNotes,
  getStateData,
  reconstructHistoricalChains,
} from './engine/graphTriageEngine';
import {
  buildCoordinatorPrompt,
  getSavedAgentEndpoint,
  queryLiveAgent,
  saveAgentEndpoint,
  type LiveAgentResponse,
} from './services/agentClient';
import type { ReferralIntakeInput, StateCode } from './types';

function pickDefaultTract(stateCode: StateCode): string {
  const { tracts } = getStateData(stateCode);
  const sorted = [...tracts].sort(
    (a, b) =>
      b.poverty_rate * 0.6 +
      (b.children_under_5_count / 500) * 0.4 -
      (a.poverty_rate * 0.6 + (a.children_under_5_count / 500) * 0.4)
  );
  return sorted[0]?.census_tract_geoid ?? tracts[0]?.census_tract_geoid ?? '';
}

function getInitialTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  const saved = window.localStorage.getItem('pm-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return 'light';
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);
  const [activePreset, setActivePreset] = useState<
    'default20m' | 'zeroVehicle' | 'agingOut31m' | null
  >('default20m');

  const [intake, setIntake] = useState<ReferralIntakeInput>(() => ({
    stateCode: 'MS',
    tractGeoid: pickDefaultTract('MS'),
    childAgeMonths: 20,
    insuranceMedicaid: true,
    primaryLanguage: 'Spanish',
    concernDomain: 'Speech & Language Delay',
    hasHouseholdVehicle: true,
    simulateEhrUpgrade: false,
  }));

  const [viewMode, setViewMode] = useState<'simple' | 'full'>('simple');
  const [micTriggerCount, setMicTriggerCount] = useState<number>(0);
  const chatSectionRef = useRef<HTMLDivElement | null>(null);

  const [selectedPathwayId, setSelectedPathwayId] = useState<string | null>(null);
  const [agentEndpoint, setAgentEndpoint] = useState<string>(() =>
    getSavedAgentEndpoint()
  );
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentResponse, setAgentResponse] = useState<LiveAgentResponse | null>(
    null
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem('pm-theme', theme);
  }, [theme]);

  const stateBundle = useMemo(
    () => getStateData(intake.stateCode),
    [intake.stateCode]
  );

  const selectedTract = useMemo(() => {
    return (
      stateBundle.tracts.find((t) => t.census_tract_geoid === intake.tractGeoid) ??
      stateBundle.tracts[0]
    );
  }, [stateBundle.tracts, intake.tractGeoid]);

  const historicalChains = useMemo(
    () =>
      reconstructHistoricalChains(stateBundle.providers, stateBundle.referrals),
    [stateBundle.providers, stateBundle.referrals]
  );

  const bounceDiagnostics = useMemo(
    () =>
      computeBounceHubDiagnostics(stateBundle.providers, historicalChains),
    [stateBundle.providers, historicalChains]
  );

  const routingResult = useMemo(
    () =>
      findPathwaysForReferral(
        intake,
        selectedTract,
        stateBundle.providers,
        stateBundle.referrals,
        historicalChains
      ),
    [
      intake,
      selectedTract,
      stateBundle.providers,
      stateBundle.referrals,
      historicalChains,
    ]
  );

  const allCandidatePaths = useMemo(() => {
    if (!routingResult.recommended) return routingResult.alternatives;
    return [routingResult.recommended, ...routingResult.alternatives];
  }, [routingResult]);

  const activePathway = useMemo(() => {
    if (selectedPathwayId) {
      const found = allCandidatePaths.find((p) => p.id === selectedPathwayId);
      if (found) return found;
    }
    return routingResult.recommended;
  }, [selectedPathwayId, allCandidatePaths, routingResult.recommended]);

  const equityAudit = useMemo(
    () => computePostOutputEquityAudit(stateBundle.tracts, historicalChains),
    [stateBundle.tracts, historicalChains]
  );

  const isoGqlSnippet = useMemo(
    () => buildIsoGqlSnippet(intake, selectedTract),
    [intake, selectedTract]
  );

  const caregiverNotes = useMemo(
    () =>
      generateCaregiverNotes(
        intake,
        selectedTract,
        activePathway,
        stateBundle.agencies[0]
      ),
    [intake, selectedTract, activePathway, stateBundle.agencies]
  );

  useEffect(() => {
    setAgentPrompt(buildCoordinatorPrompt(intake, activePathway));
  }, [intake, activePathway]);

  const handleUpdateIntake = (patch: Partial<ReferralIntakeInput>) => {
    setActivePreset(null);
    setSelectedPathwayId(null);
    setAgentResponse(null);
    setAgentError(null);
    setIntake((prev) => {
      const next = { ...prev, ...patch };
      if (
        patch.stateCode &&
        patch.stateCode !== prev.stateCode &&
        !patch.tractGeoid
      ) {
        next.tractGeoid = pickDefaultTract(patch.stateCode);
      }
      return next;
    });
  };

  const handleSelectPreset = (
    preset: 'default20m' | 'zeroVehicle' | 'agingOut31m'
  ) => {
    setActivePreset(preset);
    setSelectedPathwayId(null);
    setAgentResponse(null);
    setAgentError(null);

    if (preset === 'default20m') {
      setIntake((prev) => ({
        ...prev,
        tractGeoid: pickDefaultTract(prev.stateCode),
        childAgeMonths: 20,
        insuranceMedicaid: true,
        primaryLanguage: 'Spanish',
        concernDomain: 'Speech & Language Delay',
        hasHouseholdVehicle: true,
        simulateEhrUpgrade: false,
      }));
      return;
    }

    if (preset === 'zeroVehicle') {
      const highestZeroVeh = [...stateBundle.tracts].sort(
        (a, b) => b.no_vehicle_rate - a.no_vehicle_rate
      )[0];
      setIntake((prev) => ({
        ...prev,
        tractGeoid: highestZeroVeh?.census_tract_geoid ?? prev.tractGeoid,
        childAgeMonths: 20,
        insuranceMedicaid: true,
        primaryLanguage: 'Spanish',
        concernDomain: 'Autism / Social Communication',
        hasHouseholdVehicle: false,
        simulateEhrUpgrade: false,
      }));
      return;
    }

    setIntake((prev) => ({
      ...prev,
      childAgeMonths: 31,
      insuranceMedicaid: true,
      primaryLanguage: 'Spanish',
      concernDomain: 'Speech & Language Delay',
      hasHouseholdVehicle: false,
      simulateEhrUpgrade: true,
    }));
  };

  const handleRunLiveAgent = async () => {
    if (!agentEndpoint) {
      setAgentModalOpen(true);
      return;
    }
    setAgentLoading(true);
    setAgentError(null);
    try {
      const res = await queryLiveAgent(agentEndpoint, intake, agentPrompt);
      setAgentResponse(res);
    } catch (err) {
      setAgentError(
        err instanceof Error ? err.message : 'Failed to reach ADK endpoint.'
      );
    } finally {
      setAgentLoading(false);
    }
  };

  const handleTriggerVoiceAsk = () => {
    chatSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setMicTriggerCount((c) => c + 1);
  };

  const monthsRemaining = 36 - intake.childAgeMonths;
  const nearCliff = monthsRemaining <= 6;
  const daysSavedVsFax =
    activePathway && routingResult.historicalTrapChain
      ? Math.max(
          0,
          routingResult.historicalTrapChain.totalWaitDays -
            activePathway.totalExpectedDays
        )
      : null;

  /* Polite Live Announcement for Screen Readers (contextual-live-badge-updates) */
  const liveRouteSummary = activePathway
    ? `${selectedTract.county_name}, ${intake.stateCode}: ${
        activePathway.clears45DayClock ? 'Compliant route' : 'Over-45-day route'
      } in ${activePathway.totalExpectedDays} days via ${cleanOrgName(
        activePathway.steps[2].node.synthetic_organization_name
      )}.`
    : `${selectedTract.county_name}, ${intake.stateCode}: No standard route clears 45 days; mobile override needed.`;

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--pm-bg)] text-[var(--pm-ink)]">
      <div role="status" aria-live="polite" className="sr-only">
        {liveRouteSummary}
      </div>

      <SyntheticBanner
        zeroLepRatio={stateBundle.integrity.zeroLepRatio}
        nschStrataCount={stateBundle.integrity.nschStatewideStrataCount}
        leadingZeroIntact={stateBundle.integrity.leadingZeroIntact}
        agentEndpoint={agentEndpoint}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        onTriggerVoiceAsk={handleTriggerVoiceAsk}
        onOpenAgentModal={() => setAgentModalOpen(true)}
      />

      <main id="main-workspace" className="flex-1 pm-wrap py-6 sm:py-7 space-y-6">
        {/* Executive 4-Card Clinical Bento KPI Strip (ui-ux-pro-max Data-Dense Bento Hierarchy) */}
        <section
          aria-label="Statutory referral triage summary metrics"
          className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5 tabular-nums"
        >
          {/* KPI 1: Statutory 45-Day IFSP Clock */}
          <div className="pm-kpi flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="pm-kicker">45-Day IFSP Clock</span>
              {activePathway?.clears45DayClock ? (
                <span className="pm-badge pm-badge-compliant">
                  <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Compliant</span>
                </span>
              ) : (
                <span className="pm-badge pm-badge-danger">
                  <AlertTriangle aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Override req.</span>
                </span>
              )}
            </div>
            <div className="flex items-baseline justify-between gap-2 pt-0.5">
              <div className="font-mono-code text-[26px] font-semibold text-[var(--pm-ink)] leading-none">
                {activePathway ? `${activePathway.totalExpectedDays}d` : '—'}
                <span className="text-[13.5px] font-normal text-[var(--pm-muted)]">
                  {' '}
                  / 45d
                </span>
              </div>
              <span className="text-[12.5px] text-[var(--pm-muted)]">
                {activePathway
                  ? activePathway.clears45DayClock
                    ? `${activePathway.daysMargin}d safety margin`
                    : `+${activePathway.totalExpectedDays - 45}d over limit`
                  : 'No 3-hop match'}
              </span>
            </div>
          </div>

          {/* KPI 2: Time Saved vs. Historical Paper-Fax Loop */}
          <div className="pm-kpi flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="pm-kicker">Saved vs. Fax Loop</span>
              <span className="pm-badge pm-badge-accent">
                <TrendingDown aria-hidden="true" className="w-3.5 h-3.5" />
                <span>e-Portal gain</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2 pt-0.5">
              <div className="font-mono-code text-[26px] font-semibold text-[var(--pm-accent)] leading-none">
                {daysSavedVsFax !== null ? `-${daysSavedVsFax}d` : '—'}
              </div>
              <span className="text-[12.5px] text-[var(--pm-muted)] truncate">
                {routingResult.historicalTrapChain
                  ? `vs. ${routingResult.historicalTrapChain.totalWaitDays}d paper-fax chain`
                  : 'Baseline comparison'}
              </span>
            </div>
          </div>

          {/* KPI 3: 36-Month Part C Transition Cliff */}
          <div className="pm-kpi flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="pm-kicker">Part C Eligibility Window</span>
              {nearCliff ? (
                <span className="pm-badge pm-badge-danger">
                  <CalendarClock aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Urgent &le;6m</span>
                </span>
              ) : (
                <span className="pm-badge">
                  <Clock aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-muted)]" />
                  <span>Age {intake.childAgeMonths}m</span>
                </span>
              )}
            </div>
            <div className="flex items-baseline justify-between gap-2 pt-0.5">
              <div
                className={`font-mono-code text-[26px] font-semibold leading-none ${
                  nearCliff ? 'text-[var(--pm-danger)]' : 'text-[var(--pm-ink)]'
                }`}
              >
                {monthsRemaining} mo
              </div>
              <span className="text-[12.5px] text-[var(--pm-muted)]">
                until 36m Part B transition
              </span>
            </div>
          </div>

          {/* KPI 4: Eval Hub Distance & Transit Guardrail */}
          <div className="pm-kpi flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="pm-kicker">Eval Hub Distance</span>
              {!intake.hasHouseholdVehicle ? (
                <span className="pm-badge pm-badge-warning">
                  <MapPin aria-hidden="true" className="w-3.5 h-3.5" />
                  <span>Zero-car guard</span>
                </span>
              ) : (
                <span className="pm-badge">
                  <MapPin aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-muted)]" />
                  <span>{selectedTract.county_name}</span>
                </span>
              )}
            </div>
            <div className="flex items-baseline justify-between gap-2 pt-0.5">
              <div className="font-mono-code text-[26px] font-semibold text-[var(--pm-ink)] leading-none">
                {activePathway ? `${activePathway.evalHubDistanceKm} km` : '—'}
              </div>
              <span className="text-[12.5px] text-[var(--pm-muted)] truncate">
                {activePathway?.transportAdvisory
                  ? 'NEMT / mobile eval flagged'
                  : 'Direct regional access'}
              </span>
            </div>
          </div>
        </section>

        {/* Main 12-Column Clinical Triage Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Intake Rail */}
          <div className="lg:col-span-4 xl:col-span-3 lg:sticky lg:top-22 order-2 lg:order-1">
            <IntakeSidebar
              intake={intake}
              tracts={stateBundle.tracts}
              selectedTract={selectedTract}
              activePreset={activePreset}
              onChange={handleUpdateIntake}
              onSelectPreset={handleSelectPreset}
            />
          </div>

          {/* Center Primary Triage Frame & Optional Graph/Audit Sections */}
          <div className="lg:col-span-8 xl:col-span-5 space-y-6 order-3 lg:order-2 min-w-0">
            <PathwayClockComparison
              intake={intake}
              tract={selectedTract}
              activePathway={activePathway}
              alternatives={routingResult.alternatives}
              selectedPathwayId={selectedPathwayId}
              onSelectPathway={setSelectedPathwayId}
              historicalTrapChain={routingResult.historicalTrapChain}
            />

            {viewMode === 'full' ? (
              <>
                <NetworkGraphCanvas
                  stateCode={intake.stateCode}
                  providers={stateBundle.providers}
                  referrals={stateBundle.referrals}
                  activePathway={activePathway}
                  historicalTrapChain={routingResult.historicalTrapChain}
                  bounceDiagnostics={bounceDiagnostics}
                />

                <BriefAndCaregiverTabs
                  caregiverNotes={caregiverNotes}
                  bounceDiagnostics={bounceDiagnostics}
                  providers={stateBundle.providers}
                  agencies={stateBundle.agencies}
                  equityAudit={equityAudit}
                  nschStrata={stateBundle.nsch}
                  isoGqlSnippet={isoGqlSnippet}
                  agentPrompt={agentPrompt}
                  onAgentPromptChange={setAgentPrompt}
                  onRunLiveAgent={handleRunLiveAgent}
                  agentLoading={agentLoading}
                  agentError={agentError}
                  agentResponse={agentResponse}
                  agentEndpoint={agentEndpoint}
                  onOpenAgentModal={() => setAgentModalOpen(true)}
                />
              </>
            ) : (
              <div className="pm-card p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1 max-w-lg">
                  <h2 className="pm-h3 text-[16px]">
                    Focused clinical triage active
                  </h2>
                  <p className="text-[14px] text-[var(--pm-muted)] leading-relaxed">
                    Expand the 30-node CareNode referral graph (plus accessible edge table), bilingual caregiver notes, bounce-hub audit, and BigQuery ISO GQL queries.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setViewMode('full')}
                  className="pm-btn pm-btn-secondary shrink-0"
                >
                  <span>Open graph &amp; audit</span>
                  <ArrowRight aria-hidden="true" className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Right Voice & Chat Triage Agent */}
          <div
            ref={chatSectionRef}
            className="lg:col-span-12 xl:col-span-4 xl:sticky xl:top-22 order-1 lg:order-3 no-print"
          >
            <AgentChatSidebar
              intake={intake}
              tract={selectedTract}
              activePathway={activePathway}
              agentEndpoint={agentEndpoint}
              onApplyIntakePatch={handleUpdateIntake}
              onOpenAgentModal={() => setAgentModalOpen(true)}
              autoFocusMicSignal={micTriggerCount}
            />
          </div>
        </div>
      </main>

      {/* Clinical Compliance & Provenance Footer */}
      <footer className="border-t border-[var(--pm-border)] bg-[var(--pm-card)] mt-8 no-print">
        <div className="pm-wrap py-5 flex flex-wrap items-center justify-between gap-4 text-[13px] text-[var(--pm-muted)]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold text-[var(--pm-ink)]" style={{ fontFamily: 'var(--font-display)' }}>
              First Milestones · 2026
            </span>
            <span>34 CFR § 303.310 statutory 45-day IFSP clinical routing</span>
          </div>

          <details className="credits">
            <summary className="cursor-pointer hover:text-[var(--pm-ink)] font-medium transition-colors">
              Data sources: Synthetic CareNodes, US Census ACS, HRSA NSCH, OSEP Part C
            </summary>
            <p className="mt-2 max-w-xl text-[12.5px] text-[var(--pm-muted)] leading-relaxed">
              Provider directories (<code className="font-mono-code text-[11.5px]">SYN-PROV-*</code>), Part C agencies (<code className="font-mono-code text-[11.5px]">SYN-PARTC-*</code>), and multi-hop referral logs are 100% synthetic. Tract under-5 counts and vehicle access come from US Census ACS 5-Year estimates; statewide developmental screening strata come from HRSA NSCH.
            </p>
          </details>
        </div>
      </footer>

      <AgentModal
        open={agentModalOpen}
        currentUrl={agentEndpoint}
        onSave={(url) => {
          saveAgentEndpoint(url);
          setAgentEndpoint(url);
        }}
        onClose={() => setAgentModalOpen(false)}
      />
    </div>
  );
}
