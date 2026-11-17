import React from 'react';
import { AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { STATE_META } from '../engine/graphTriageEngine';
import type { ReferralIntakeInput, StateCode, TractDemographic } from '../types';
import {
  FluidAgeScrubber,
  FluidSegmentedControl,
  FluidSwitch,
} from './FluidControls';

interface IntakeSidebarProps {
  intake: ReferralIntakeInput;
  tracts: TractDemographic[];
  selectedTract: TractDemographic;
  activePreset: 'default20m' | 'zeroVehicle' | 'agingOut31m' | null;
  onChange: (next: Partial<ReferralIntakeInput>) => void;
  onSelectPreset: (preset: 'default20m' | 'zeroVehicle' | 'agingOut31m') => void;
}

const STATE_OPTIONS: { value: StateCode; label: string }[] = [
  { value: 'MS', label: 'MS' },
  { value: 'CA', label: 'CA' },
  { value: 'TX', label: 'TX' },
  { value: 'NY', label: 'NY' },
  { value: 'GA', label: 'GA' },
  { value: 'AL', label: 'AL' },
];

const LANGUAGE_OPTIONS: {
  value: ReferralIntakeInput['primaryLanguage'];
  label: string;
}[] = [
  { value: 'Spanish', label: 'Spanish' },
  { value: 'Other Non-English', label: 'Other' },
  { value: 'English', label: 'English' },
];

export const IntakeSidebar: React.FC<IntakeSidebarProps> = ({
  intake,
  tracts,
  selectedTract,
  activePreset,
  onChange,
  onSelectPreset,
}) => {
  const monthsToAgeOut = 36 - intake.childAgeMonths;
  const isNearAgeOut = monthsToAgeOut <= 6;

  return (
    <aside aria-label="Referral intake controls" className="pm-card p-5 sm:p-6 space-y-5">
      {/* Section Header & Quick Clinical Case Presets */}
      <div className="space-y-3">
        <div>
          <div className="pm-kicker">Step 1 · Day 0 Intake</div>
          <h2 className="pm-h3 text-[18px] mt-1">
            Child &amp; household profile
          </h2>
          <p className="text-[13.5px] text-[var(--pm-muted)] mt-1 leading-relaxed">
            Filters in-state CareNodes by language staffing, Medicaid enrollment, and household transit access.
          </p>
        </div>

        {/* Sample referral presets — explicit aria-pressed state */}
        <div className="space-y-1.5 pt-1 no-print">
          <div className="text-[12px] font-semibold text-[var(--pm-muted)]" style={{ fontFamily: 'var(--font-display)' }}>
            Sample triage scenarios
          </div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: 'default20m', label: '20m Spanish Medicaid' },
                { id: 'zeroVehicle', label: 'Zero-vehicle rural' },
                { id: 'agingOut31m', label: '31m age-out cliff' },
              ] as const
            ).map((preset) => {
              const isSelected = activePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelectPreset(preset.id)}
                  className={`min-h-[36px] px-3 py-1.5 rounded-[8px] text-[12.5px] font-semibold border cursor-pointer touch-manipulation transition-colors ${
                    isSelected
                      ? 'bg-[var(--pm-accent-soft)] border-[var(--pm-accent)] text-[var(--pm-accent)]'
                      : 'bg-[var(--pm-surface)] hover:bg-[var(--pm-surface-hover)] border-[var(--pm-border)] text-[var(--pm-ink)]'
                  }`}
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 1. State Network */}
      <div className="space-y-2 pt-4 border-t border-[var(--pm-border)]">
        <div className="flex items-center justify-between">
          <span className="pm-label">State Part C network</span>
          <span className="font-mono-code text-[12px] text-[var(--pm-muted)] tabular-nums">
            FIPS {STATE_META[intake.stateCode].fips}
          </span>
        </div>
        <FluidSegmentedControl
          layoutId="intake-state-segment"
          ariaLabel="State Part C network"
          options={STATE_OPTIONS}
          value={intake.stateCode}
          onChange={(stateCode) => onChange({ stateCode })}
          fullWidth
        />
        <p className="text-[12.5px] text-[var(--pm-muted)] tabular-nums">
          {STATE_META[intake.stateCode].name} · OSEP timely IFSP:{' '}
          <strong className="font-semibold text-[var(--pm-ink)]">
            {STATE_META[intake.stateCode].osepRange}
          </strong>
        </p>
      </div>

      {/* 2. Home Census Tract */}
      <div className="space-y-2.5 pt-4 border-t border-[var(--pm-border)]">
        <label
          htmlFor="tract-select"
          className="flex items-center justify-between pm-label"
        >
          <span>Home census tract</span>
          <span className="text-[12px] font-normal text-[var(--pm-muted)] tabular-nums">
            {tracts.length} tracts
          </span>
        </label>
        <select
          id="tract-select"
          value={selectedTract.census_tract_geoid}
          onChange={(e) => onChange({ tractGeoid: e.target.value })}
          className="pm-input cursor-pointer"
        >
          {tracts.map((t) => (
            <option key={t.census_tract_geoid} value={t.census_tract_geoid}>
              {t.county_name} · {t.census_tract_geoid} (Under-5: {t.children_under_5_count}, Poverty:{' '}
              {Math.round(t.poverty_rate * 100)}%)
            </option>
          ))}
        </select>

        {/* ACS Tract Readout Strip */}
        <dl className="grid grid-cols-3 gap-2.5 p-3 rounded-[10px] bg-[var(--pm-surface)] border border-[var(--pm-border)] tabular-nums">
          <div>
            <dt className="text-[11.5px] text-[var(--pm-muted)] font-medium">Under 5</dt>
            <dd className="font-mono-code text-[15px] font-semibold text-[var(--pm-ink)] mt-0.5">
              {selectedTract.children_under_5_count.toLocaleString()}
            </dd>
          </div>
          <div className="border-x border-[var(--pm-border)] px-2.5">
            <dt className="text-[11.5px] text-[var(--pm-muted)] font-medium">Poverty</dt>
            <dd className="font-mono-code text-[15px] font-semibold text-[var(--pm-ink)] mt-0.5">
              {(selectedTract.poverty_rate * 100).toFixed(1)}%
            </dd>
          </div>
          <div>
            <dt className="text-[11.5px] text-[var(--pm-muted)] font-medium">Zero car</dt>
            <dd
              className={`font-mono-code text-[15px] font-semibold mt-0.5 ${
                selectedTract.no_vehicle_rate >= 0.12
                  ? 'text-[var(--pm-warning)]'
                  : 'text-[var(--pm-ink)]'
              }`}
            >
              {(selectedTract.no_vehicle_rate * 100).toFixed(1)}%
            </dd>
          </div>
        </dl>
      </div>

      {/* 3. Child Age & 36-Month Statutory Cliff (with WCAG 2.2 AA +/- buttons) */}
      <div className="space-y-2.5 pt-4 border-t border-[var(--pm-border)]">
        <div className="flex items-center justify-between">
          <span className="pm-label">Child age at referral</span>
          <span className="font-mono-code text-[14px] font-semibold text-[var(--pm-accent)] tabular-nums">
            {intake.childAgeMonths} months
          </span>
        </div>

        <FluidAgeScrubber
          value={intake.childAgeMonths}
          min={4}
          max={35}
          onChange={(childAgeMonths) => onChange({ childAgeMonths })}
        />

        <div
          className={`flex items-center justify-between text-[12.5px] px-3 py-2 rounded-[8px] tabular-nums border ${
            isNearAgeOut
              ? 'bg-[var(--pm-danger-soft)] border-[var(--pm-danger-border)] text-[var(--pm-danger)] font-semibold'
              : 'bg-[var(--pm-surface)] border-[var(--pm-border)] text-[var(--pm-muted)]'
          }`}
        >
          <span className="inline-flex items-center gap-1.5">
            {isNearAgeOut ? (
              <AlertCircle aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <Clock aria-hidden="true" className="w-3.5 h-3.5 shrink-0" />
            )}
            <span>36m Part C cliff</span>
          </span>
          <span className="font-mono-code font-semibold">
            {monthsToAgeOut} mo buffer
          </span>
        </div>
      </div>

      {/* 4. Home Language */}
      <div className="space-y-2 pt-4 border-t border-[var(--pm-border)]">
        <div className="flex items-center justify-between">
          <span className="pm-label">Primary home language</span>
          <span className="inline-flex items-center gap-1 text-[12px] text-[var(--pm-muted)]">
            <CheckCircle2 aria-hidden="true" className="w-3.5 h-3.5 text-[var(--pm-accent)]" />
            <span>
              {intake.primaryLanguage !== 'English'
                ? 'Bilingual required'
                : 'Standard'}
            </span>
          </span>
        </div>
        <FluidSegmentedControl
          layoutId="intake-lang-segment"
          ariaLabel="Child home language"
          options={LANGUAGE_OPTIONS}
          value={intake.primaryLanguage}
          onChange={(primaryLanguage) => onChange({ primaryLanguage })}
          fullWidth
        />
      </div>

      {/* 5. Developmental Domain */}
      <div className="space-y-2 pt-4 border-t border-[var(--pm-border)]">
        <label htmlFor="concern-select" className="block pm-label">
          Developmental concern domain
        </label>
        <select
          id="concern-select"
          value={intake.concernDomain}
          onChange={(e) =>
            onChange({
              concernDomain: e.target.value as ReferralIntakeInput['concernDomain'],
            })
          }
          className="pm-input cursor-pointer"
        >
          <option value="Speech & Language Delay">
            Speech &amp; language delay
          </option>
          <option value="Autism / Social Communication">
            Autism &amp; social communication
          </option>
          <option value="Motor / Adaptive Delay">
            Motor, feeding &amp; adaptive delay
          </option>
        </select>
      </div>

      {/* 6. Eligibility & Counterfactual Switches */}
      <div className="pt-2 border-t border-[var(--pm-border)]">
        <FluidSwitch
          checked={intake.insuranceMedicaid}
          onChange={(insuranceMedicaid) => onChange({ insuranceMedicaid })}
          label="Medicaid coverage"
          description="Require $0-cost Medicaid acceptance across all hops"
        />

        <FluidSwitch
          checked={intake.hasHouseholdVehicle}
          onChange={(hasHouseholdVehicle) => onChange({ hasHouseholdVehicle })}
          label="Household vehicle available"
          description={
            intake.hasHouseholdVehicle
              ? 'Standard regional travel distance allowed'
              : 'Flags NEMT ride or mobile eval beyond 20 km'
          }
        />

        <FluidSwitch
          checked={intake.simulateEhrUpgrade}
          onChange={(simulateEhrUpgrade) => onChange({ simulateEhrUpgrade })}
          accent="harbour"
          label="Simulate e-Portal upgrade"
          description="Replace paper-fax coordinator links with electronic intake"
        />
      </div>
    </aside>
  );
};
