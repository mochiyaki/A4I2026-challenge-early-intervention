import React from 'react';
import { Clock } from 'lucide-react';
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
  onChange,
  onSelectPreset,
}) => {
  const monthsToAgeOut = 36 - intake.childAgeMonths;
  const isNearAgeOut = monthsToAgeOut <= 6;

  return (
    <aside aria-label="Referral intake controls" className="ts-card p-6 space-y-6">
      {/* Section Header — Two-sentence contrast run-on (system.md & copy.md) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="ts-h3 text-[19px]">
            Referral intake.{' '}
            <span className="ts-muted">Day 0 profile.</span>
          </h2>
        </div>

        <p className="text-[14px] text-[#556070] leading-relaxed">
          Filter eligible clinics by home language, Medicaid coverage, and travel distance.
        </p>

        {/* Sample referral presets — uniform system styling, zero rainbow pills */}
        <div className="space-y-1.5 pt-1 no-print">
          <div className="ts-label">Load preset case</div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => onSelectPreset('default20m')}
              className="px-2.5 py-1.5 rounded-[7px] text-[12.5px] font-medium bg-[#F8F7F4] hover:bg-[#E6E2D9] text-[#1D2530] border border-[rgba(29,37,48,0.14)] cursor-pointer transition-colors"
            >
              20m Spanish Medicaid
            </button>
            <button
              type="button"
              onClick={() => onSelectPreset('zeroVehicle')}
              className="px-2.5 py-1.5 rounded-[7px] text-[12.5px] font-medium bg-[#F8F7F4] hover:bg-[#E6E2D9] text-[#1D2530] border border-[rgba(29,37,48,0.14)] cursor-pointer transition-colors"
            >
              Zero-vehicle rural
            </button>
            <button
              type="button"
              onClick={() => onSelectPreset('agingOut31m')}
              className="px-2.5 py-1.5 rounded-[7px] text-[12.5px] font-medium bg-[#F8F7F4] hover:bg-[#E6E2D9] text-[#1D2530] border border-[rgba(29,37,48,0.14)] cursor-pointer transition-colors"
            >
              31m age-out cliff
            </button>
          </div>
        </div>
      </div>

      {/* 1. State Network */}
      <div className="space-y-2 pt-4 border-t border-[rgba(29,37,48,0.1)]">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-medium text-[#1D2530]">State network</span>
          <span className="font-mono-code text-[12.5px] text-[#556070] tabular-nums">
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
        <p className="text-[13px] text-[#556070] tabular-nums">
          {STATE_META[intake.stateCode].name} · OSEP timely IFSP:{' '}
          <span className="font-medium text-[#1D2530]">
            {STATE_META[intake.stateCode].osepRange}
          </span>
        </p>
      </div>

      {/* 2. Home Census Tract — Visible label + open hairline readout (no 3-level nested box) */}
      <div className="space-y-3 pt-4 border-t border-[rgba(29,37,48,0.1)]">
        <label
          htmlFor="tract-select"
          className="flex items-center justify-between text-[14px] font-medium text-[#1D2530]"
        >
          <span>Home census tract</span>
          <span className="text-[12.5px] font-normal text-[#556070] tabular-nums">
            {tracts.length} tracts
          </span>
        </label>
        <select
          id="tract-select"
          value={selectedTract.census_tract_geoid}
          onChange={(e) => onChange({ tractGeoid: e.target.value })}
          className="ts-input cursor-pointer"
        >
          {tracts.map((t) => (
            <option key={t.census_tract_geoid} value={t.census_tract_geoid}>
              {t.county_name} · {t.census_tract_geoid} (Under-5: {t.children_under_5_count}, Poverty:{' '}
              {Math.round(t.poverty_rate * 100)}%)
            </option>
          ))}
        </select>

        <dl className="grid grid-cols-3 gap-3 pt-2 tabular-nums">
          <div>
            <dt className="ts-label">Under 5</dt>
            <dd className="font-mono-code text-[16px] font-medium text-[#1D2530] mt-0.5">
              {selectedTract.children_under_5_count.toLocaleString()}
            </dd>
          </div>
          <div className="border-x border-[rgba(29,37,48,0.1)] px-3">
            <dt className="ts-label">Poverty</dt>
            <dd className="font-mono-code text-[16px] font-medium text-[#1D2530] mt-0.5">
              {(selectedTract.poverty_rate * 100).toFixed(1)}%
            </dd>
          </div>
          <div>
            <dt className="ts-label">No vehicle</dt>
            <dd
              className={`font-mono-code text-[16px] font-medium mt-0.5 ${
                selectedTract.no_vehicle_rate >= 0.12
                  ? 'text-[#8F5B1E]'
                  : 'text-[#1D2530]'
              }`}
            >
              {(selectedTract.no_vehicle_rate * 100).toFixed(1)}%
            </dd>
          </div>
        </dl>
      </div>

      {/* 3. Child Age & 36-Month Statutory Cliff */}
      <div className="space-y-2 pt-4 border-t border-[rgba(29,37,48,0.1)]">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-medium text-[#1D2530]">Child age</span>
          <span className="font-mono-code text-[14px] font-medium text-[#2C5877] tabular-nums">
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
          className={`flex items-center justify-between text-[13px] px-3 py-2 rounded-[8px] tabular-nums border ${
            isNearAgeOut
              ? 'bg-[rgba(180,62,47,0.08)] border-[rgba(180,62,47,0.24)] text-[#B43E2F] font-medium'
              : 'bg-[#F8F7F4] border-[rgba(29,37,48,0.09)] text-[#556070]'
          }`}
        >
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            <span>36-month Part C transition</span>
          </span>
          <span className="font-mono-code font-medium">
            {monthsToAgeOut} mo remaining
          </span>
        </div>
      </div>

      {/* 4. Home Language */}
      <div className="space-y-2 pt-4 border-t border-[rgba(29,37,48,0.1)]">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-medium text-[#1D2530]">Home language</span>
          <span className="text-[12.5px] text-[#556070]">
            {intake.primaryLanguage !== 'English'
              ? 'Bilingual eval required'
              : 'Standard eval'}
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
      <div className="space-y-2 pt-4 border-t border-[rgba(29,37,48,0.1)]">
        <label
          htmlFor="concern-select"
          className="block text-[14px] font-medium text-[#1D2530]"
        >
          Developmental concern
        </label>
        <select
          id="concern-select"
          value={intake.concernDomain}
          onChange={(e) =>
            onChange({
              concernDomain: e.target.value as ReferralIntakeInput['concernDomain'],
            })
          }
          className="ts-input cursor-pointer"
        >
          <option value="Speech & Language Delay">
            Speech and language delay
          </option>
          <option value="Autism / Social Communication">
            Autism and social communication
          </option>
          <option value="Motor / Adaptive Delay">
            Motor, feeding, and adaptive delay
          </option>
        </select>
      </div>

      {/* 6. Eligibility & Counterfactual Switches (ink switches, harbour accent on simulation) */}
      <div className="pt-2 border-t border-[rgba(29,37,48,0.1)]">
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
          label="Simulate e-portal upgrade"
          description="Replace paper-fax coordinator links with electronic intake"
        />
      </div>
    </aside>
  );
};
