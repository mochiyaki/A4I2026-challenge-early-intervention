import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentChatSidebar } from './components/AgentChatSidebar';
import { AgentModal } from './components/AgentModal';
import { BriefAndCaregiverTabs } from './components/BriefAndCaregiverTabs';
import { IntakeSidebar } from './components/IntakeSidebar';
import { NetworkGraphCanvas } from './components/NetworkGraphCanvas';
import { PathwayClockComparison } from './components/PathwayClockComparison';
import { SyntheticBanner } from './components/SyntheticBanner';
import {
  buildIsoGqlSnippet,
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

export default function App() {
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

  return (
    <div className="min-h-screen flex flex-col bg-[#F5F5F7] text-[#1D1D1F]">
      <SyntheticBanner
        zeroLepRatio={stateBundle.integrity.zeroLepRatio}
        nschStrataCount={stateBundle.integrity.nschStatewideStrataCount}
        leadingZeroIntact={stateBundle.integrity.leadingZeroIntact}
        agentEndpoint={agentEndpoint}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onTriggerVoiceAsk={handleTriggerVoiceAsk}
        onOpenAgentModal={() => setAgentModalOpen(true)}
      />

      <main className="flex-1 max-w-[1640px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Intake Control Rail */}
          <div className="lg:col-span-4 xl:col-span-3 lg:sticky lg:top-20 order-2 lg:order-1">
            <IntakeSidebar
              intake={intake}
              tracts={stateBundle.tracts}
              selectedTract={selectedTract}
              onChange={handleUpdateIntake}
              onSelectPreset={handleSelectPreset}
            />
          </div>

          {/* Center Pathway Summary (+ Optional Deep-Dive Charts & Tables) */}
          <div className="lg:col-span-8 xl:col-span-5 space-y-6 order-3 lg:order-2">
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
              <div className="apple-card p-5 flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-[#1D1D1F]">
                    Focused Coordinator View Active
                  </div>
                  <p className="text-xs text-[#515154]">
                    Complex network topology, SQL tables, and equity audit matrices are hidden so
                    you can triage straight with the Voice &amp; Chat Agent.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setViewMode('full')}
                  className="apple-pressable shrink-0 px-3.5 py-2 rounded-full text-xs font-semibold bg-[#F2F2F7] hover:bg-[#E5E5EA] text-[#1D1D1F] cursor-pointer"
                >
                  Show Full Charts
                </button>
              </div>
            )}
          </div>

          {/* Right-Hand Persistent Voice & Chat Copilot (Top on Mobile, Sticky Right on Desktop) */}
          <div
            ref={chatSectionRef}
            className="lg:col-span-12 xl:col-span-4 xl:sticky xl:top-20 order-1 lg:order-3 no-print"
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
