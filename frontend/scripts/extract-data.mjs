import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../../data');
const outDir = path.resolve(__dirname, '../src/data');

fs.mkdirSync(outDir, { recursive: true });

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function padStr(val, len) {
  if (val === null || val === undefined) return '';
  return String(val).trim().padStart(len, '0');
}

function sanitizeValue(val) {
  if (typeof val === 'bigint') return Number(val);
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (val instanceof Uint8Array || ArrayBuffer.isView(val)) return undefined;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? Math.round(val * 100000) / 100000 : 0;
  }
  return val;
}

async function readTable(filename, dropCols = []) {
  const filePath = path.join(dataDir, filename);
  const buf = fs.readFileSync(filePath);
  const rows = await parquetReadObjects({
    file: toArrayBuffer(buf),
    compressors,
  });
  const dropSet = new Set(dropCols);
  return rows.map((row) => {
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      if (dropSet.has(k)) continue;
      const sv = sanitizeValue(v);
      if (sv !== undefined) clean[k] = sv;
    }
    if ('census_tract_geoid' in clean) {
      clean.census_tract_geoid = padStr(clean.census_tract_geoid, 11);
    }
    if ('child_home_tract_geoid' in clean) {
      clean.child_home_tract_geoid = padStr(clean.child_home_tract_geoid, 11);
    }
    if ('county_fips' in clean) {
      clean.county_fips = padStr(clean.county_fips, 5);
    }
    return clean;
  });
}

async function main() {
  const tracts = await readTable('acs_under5_tract_demographics.parquet', ['tract_geom']);
  const nsch = await readTable('nsch_developmental_screening_survey.parquet', []);
  const agencies = await readTable('idea_part_c_agency_performance.parquet', ['intake_geom']);
  const providers = await readTable('pediatric_and_ei_provider_directory.parquet', ['provider_geom']);
  const referrals = await readTable('deidentified_part_c_referral_logs.parquet', []);

  const bundle = {
    generatedAt: new Date().toISOString(),
    tracts,
    nsch,
    agencies,
    providers,
    referrals,
  };

  const outPath = path.join(outDir, 'starterData.json');
  fs.writeFileSync(outPath, JSON.stringify(bundle), 'utf8');
  console.log(
    `Extracted starterData.json (${Math.round(fs.statSync(outPath).size / 1024)} KB):`,
    {
      tracts: tracts.length,
      nsch: nsch.length,
      agencies: agencies.length,
      providers: providers.length,
      referrals: referrals.length,
    }
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
