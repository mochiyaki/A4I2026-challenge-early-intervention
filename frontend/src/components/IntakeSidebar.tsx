import React from 'react';
import { Clock, MapPin, Sparkles } from 'lucide-react';
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
    <aside className="apple-card p-5 space-y-5">
      {/* Header & Quick Scenario Pills */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="apple-eyebrow text-[10.5px] font-bold text-[#0D9488]">
            Today&apos;s Referral
          </span>
          <span className="font-mono-code text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#F2F2F7] text-[#515154]">
            Day 0 Clock
          </span>
        </div>
        <div>
          <h2 className="apple-title text-[19px] font-semibold text-[#1D1D1F]">
            Child &amp; Neighborhood
          </h2>
          <p className="text-xs text-[#515154] mt-0.5">
            Match eligibility, home language, and travel distance under 45 days.
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5 pt-1 no-print">
          <button
            type="button"
            onClick={() => onSelectPreset('default20m')}
            className="apple-pressable inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-[#0D9488]/12 text-[#0F766E] cursor-pointer"
          >
            <Sparkles className="w-3 h-3" />
            20m Bilingual Medicaid
          </button>
          <button
            type="button"
            onClick={() => onSelectPreset('zeroVehicle')}
            className="apple-pressable inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-[#F2F2F7] text-[#1D1D1F] cursor-pointer"
          >
            Zero-Vehicle Rural
          </button>
          <button
            type="button"
            onClick={() => onSelectPreset('agingOut31m')}
            className="apple-pressable inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-amber-500/14 text-amber-900 cursor-pointer"
          >
            31m Age-Out Cliff
          </button>
        </div>
      </div>

      {/* 1. Fluid State Segmented Control */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-[#1D1D1F]">State Network</span>
          <span className="text-[11px] text-[#86868B] tabular-nums">
            FIPS {STATE_META[intake.stateCode].fips}
          </span>
        </div>
        <FluidSegmentedControl
          layoutId="intake-state-segment"
          options={STATE_OPTIONS}
          value={intake.stateCode}
          onChange={(stateCode) => onChange({ stateCode })}
          fullWidth
        />
        <p className="text-[11px] text-[#515154] tabular-nums">
          {STATE_META[intake.stateCode].name} · Regional 45d IFSP:{' '}
          <span className="font-semibold text-[#1D1D1F]">
            {STATE_META[intake.stateCode].osepRange}
          </span>
        </p>
      </div>

      {/* 2. Census Tract Selector + Recessed Readout */}
      <div className="space-y-2">
        <label
          htmlFor="tract-select"
          className="flex items-center justify-between text-xs font-semibold text-[#1D1D1F]"
        >
          <span className="inline-flex items-center gap-1">
            <MapPin className="w-3.5 h-3.5 text-[#0D9488]" />
            Home Census Tract
          </span>
          <span className="text-[11px] font-normal text-[#86868B] tabular-nums">
            {tracts.length} neighborhoods
          </span>
        </label>
        <select
          id="tract-select"
          value={selectedTract.census_tract_geoid}
          onChange={(e) => onChange({ tractGeoid: e.target.value })}
          className="w-full rounded-[12px] bg-[#F5F5F8] px-3 py-2 text-xs font-medium text-[#1D1D1F] shadow-[inset_0_0_0_0.5px_rgba(15,23,42,0.1)] focus:outline-none focus:ring-2 focus:ring-[#0D9488]/40 cursor-pointer"
        >
          {tracts.map((t) => (
            <option key={t.census_tract_geoid} value={t.census_tract_geoid}>
              {t.county_name} · {t.census_tract_geoid} (U5: {t.children_under_5_count}, Pov:{' '}
              {Math.round(t.poverty_rate * 100)}%)
            </option>
          ))}
        </select>

        <div className="apple-well p-3 grid grid-cols-3 gap-2 text-center tabular-nums">
          <div>
            <div className="apple-eyebrow text-[9.5px] font-semibold text-[#86868B]">
              Under-5
            </div>
            <div className="text-[15px] font-semibold text-[#1D1D1F] mt-0.5">
              {selectedTract.children_under_5_count.toLocaleString()}
            </div>
          </div>
          <div className="border-x border-black/[0.06]">
            <div className="apple-eyebrow text-[9.5px] font-semibold text-[#86868B]">
              Poverty
            </div>
            <div className="text-[15px] font-semibold text-[#1D1D1F] mt-0.5">
              {(selectedTract.poverty_rate * 100).toFixed(1)}%
            </div>
          </div>
          <div>
            <div className="apple-eyebrow text-[9.5px] font-semibold text-[#86868B]">
              No Vehicle
            </div>
            <div
              className={`text-[15px] font-semibold mt-0.5 ${
                selectedTract.no_vehicle_rate >= 0.12
                  ? 'text-amber-700'
                  : 'text-[#1D1D1F]'
              }`}
            >
              {(selectedTract.no_vehicle_rate * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      </div>

      {/* 3. Direct-Manipulation Rubber-Banded Age Scrubber */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-[#1D1D1F]">Child Age</span>
          <span className="font-mono-code text-[13px] font-semibold text-[#0F766E] tabular-nums">
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
          className={`flex items-center justify-between text-[11px] px-2.5 py-1.5 rounded-[10px] tabular-nums transition-colors ${
            isNearAgeOut
              ? 'bg-rose-500/12 text-rose-900 font-semibold'
              : 'bg-[#F5F5F8] text-[#515154]'
          }`}
        >
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            36m Part C Age-Out Cliff
          </span>
          <span className="font-mono-code font-semibold">
            {monthsToAgeOut} mo left
          </span>
        </div>
      </div>

      {/* 4. Fluid Language Segmented Control */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-[#1D1D1F]">Home Language</span>
          <span className="text-[11px] text-[#86868B]">
            {intake.primaryLanguage !== 'English'
              ? 'Bilingual Eval Required'
              : 'English Standard'}
          </span>
        </div>
        <FluidSegmentedControl
          layoutId="intake-lang-segment"
          options={LANGUAGE_OPTIONS}
          value={intake.primaryLanguage}
          onChange={(primaryLanguage) => onChange({ primaryLanguage })}
          fullWidth
        />
      </div>

      {/* 5. Developmental Domain */}
      <div className="space-y-1.5">
        <label
          htmlFor="concern-select"
          className="block text-xs font-semibold text-[#1D1D1F]"
        >
          Screening Concern
        </label>
        <select
          id="concern-select"
          value={intake.concernDomain}
          onChange={(e) =>
            onChange({
              concernDomain: e.target.value as ReferralIntakeInput['concernDomain'],
            })
          }
          className="w-full rounded-[12px] bg-[#F5F5F8] px-3 py-2 text-xs font-medium text-[#1D1D1F] shadow-[inset_0_0_0_0.5px_rgba(15,23,42,0.1)] focus:outline-none focus:ring-2 focus:ring-[#0D9488]/40 cursor-pointer"
        >
          <option value="Speech & Language Delay">
            Speech &amp; Language Delay
          </option>
          <option value="Autism / Social Communication">
            Autism / Social-Communication
          </option>
          <option value="Motor / Adaptive Delay">
            Motor / Feeding &amp; Sensory
          </option>
        </select>
      </div>

      {/* 6. Fluid Tactile iOS Switches */}
      <div className="space-y-2 pt-1">
        <FluidSwitch
          checked={intake.insuranceMedicaid}
          onChange={(insuranceMedicaid) => onChange({ insuranceMedicaid })}
          label="Medicaid Enrolled"
          description="Verify $0-cost Medicaid acceptance at every hop"
        />

        <FluidSwitch
          checked={intake.hasHouseholdVehicle}
          onChange={(hasHouseholdVehicle) => onChange({ hasHouseholdVehicle })}
          label="Household Vehicle Access"
          description={
            intake.hasHouseholdVehicle
              ? 'Family can drive to regional evaluation hub'
              : 'Zero-vehicle guardrail active (>20 km flags NEMT/mobile)'
          }
        />

        <FluidSwitch
          checked={intake.simulateEhrUpgrade}
          onChange={(simulateEhrUpgrade) => onChange({ simulateEhrUpgrade })}
          accent="indigo"
          label="Simulate e-Referral Fix"
          description="Upgrade paper_fax intake links to electronic portal"
        />
      </div>
    </aside>
  );
};
