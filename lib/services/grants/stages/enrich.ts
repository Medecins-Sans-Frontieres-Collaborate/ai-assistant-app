/**
 * Stage 4: Enrich records with OC-specific supplemental data.
 *
 * Uses xlsx (SheetJS) for reading CSV/Excel files.
 */
import { getIcaCountryInfo } from '../lookups/icaCountries';
import {
  type OCConfig,
  type SupplementalFileSpec,
  directRateStr,
  hqRateStr,
} from '../ocConfig';
import type { ProgressEmitter } from '../progress';

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as XLSX from 'xlsx';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function processClosingProject(rawValue: string, isEmergency: boolean): string {
  if (isEmergency) return 'No';
  if (!rawValue) return 'No';
  const val = rawValue.trim().toLowerCase();
  if (['no', 'false', 'n'].includes(val)) return 'No';
  if (
    val.includes('full') ||
    (['yes', 'true', 'y'].includes(val) && !val.includes('handover'))
  ) {
    return 'Yes/Full Closure';
  }
  if (
    val.includes('handover') &&
    (val.includes('partial') || val.includes('reorientation'))
  ) {
    return 'Partial Handover/Reorientation';
  }
  if (val.includes('handover')) return 'Handover to Another OC';
  if (val.includes('partial') || val.includes('reorientation')) {
    return 'Partial Handover/Reorientation';
  }
  return 'No';
}

/**
 * Extract the 4-digit year from a project start date.
 *
 * xlsx returns date cells as Excel serial numbers (e.g. 42736), not strings,
 * so a naive substring match for the reporting year never hits. This handles
 * serials (days since the 1899-12-30 epoch), ISO/locale date strings, and a
 * bare year. Returns '' when no year can be determined.
 */
function startYear(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!s) return '';
  // Excel serial date — bounded to a plausible range (~1982..2089) so a bare
  // year like "2026" is not mistaken for a serial.
  if (/^\d{4,6}$/.test(s)) {
    const serial = Number(s);
    if (serial > 30000 && serial < 80000) {
      const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
      return String(new Date(ms).getUTCFullYear());
    }
  }
  // Otherwise pull the first 19xx/20xx year out of the string.
  const m = s.match(/\b(?:19|20)\d{2}\b/);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// Supplemental data loaders using xlsx (SheetJS)
// ---------------------------------------------------------------------------

/**
 * Read a CSV/XLSX file into an array of row objects.
 *
 * `skiprows` is the 0-indexed position of the HEADER row (i.e. the number of
 * title/metadata rows sitting above it), matching the `pandas_skiprows` value
 * in the supplemental column map. The header row supplies the object keys, and
 * every header name is trimmed so trailing/embedded spaces (e.g. "Sanctions ",
 * " Amount in EUR ") still match the column names declared in the OC config.
 */
function loadTabular(path: string, skiprows: number = 0): AnyRecord[] | null {
  try {
    // Read the bytes via Node's fs and hand xlsx a buffer. XLSX.readFile()
    // relies on the xlsx module's own bundled fs handle, which Next.js /
    // Turbopack does not wire up — it throws "Cannot access file" in the
    // server bundle even for a local path. Reading the buffer ourselves avoids
    // that entirely.
    const buf = readFileSync(path);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // NB: blank rows are intentionally preserved (default for header:1) so that
    // the configured `skiprows` — which counts physical rows, including blank
    // title/spacer rows — lines up with the true header row.
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
    });
    if (raw.length <= skiprows) return [];
    const header = (raw[skiprows] as unknown[]).map((h) =>
      String(h ?? '').trim(),
    );
    const rows: AnyRecord[] = [];
    for (let i = skiprows + 1; i < raw.length; i++) {
      const arr = raw[i] as unknown[];
      const obj: AnyRecord = {};
      for (let c = 0; c < header.length; c++) {
        if (header[c]) obj[header[c]] = arr[c] ?? '';
      }
      rows.push(obj);
    }
    return rows;
  } catch (e) {
    console.log(`  ! Failed to load ${path}: ${e}`);
    return null;
  }
}

const CATEGORY_KEYWORDS: Record<string, string[][]> = {
  budgets: [['budget']],
  emergency_budgets: [['budget']],
  sanctions: [['sanction']],
  project_list: [['project list'], ['project_list']],
  allocation: [['allocation']],
  code_mapping: [['code', 'mapping']],
  funding_rates: [['funding', 'rate']],
};

function findFile(
  supplementalDir: string,
  filename: string,
  category: string = '',
): [string | null, string] {
  // Exact match
  const candidate = join(supplementalDir, filename);
  if (existsSync(candidate)) {
    console.log(`  + Matched ${category || 'file'}: ${filename} (exact)`);
    return [candidate, 'exact'];
  }

  // Case-insensitive and substring search
  let files: string[];
  try {
    files = readdirSync(supplementalDir);
  } catch {
    return [null, ''];
  }

  for (const f of files) {
    if (f.toLowerCase() === filename.toLowerCase()) {
      console.log(`  + Matched ${category || 'file'}: ${f} (case-insensitive)`);
      return [join(supplementalDir, f), 'case_insensitive'];
    }
  }

  for (const f of files) {
    if (f.toLowerCase().includes(filename.toLowerCase())) {
      console.log(`  + Matched ${category || 'file'}: ${f} (substring)`);
      return [join(supplementalDir, f), 'substring'];
    }
  }

  // Keyword-based fallback
  if (category && category in CATEGORY_KEYWORDS) {
    for (const f of files) {
      const nameLower = f.toLowerCase();
      for (const kwGroup of CATEGORY_KEYWORDS[category]) {
        if (kwGroup.every((kw) => nameLower.includes(kw))) {
          console.log(`  + Matched ${category}: ${f} (keyword fallback)`);
          return [join(supplementalDir, f), 'keyword'];
        }
      }
    }
  }

  return [null, ''];
}

// ---------------------------------------------------------------------------
// Data loading by category
// ---------------------------------------------------------------------------

function loadProjectList(
  supplementalDir: string,
  spec: SupplementalFileSpec,
): [Record<string, AnyRecord>, string | null, string] {
  const [path, matchType] = findFile(
    supplementalDir,
    spec.filename,
    'project_list',
  );
  if (!path) {
    console.log(`  Project list not found: ${spec.filename}`);
    return [{}, null, ''];
  }

  const data = loadTabular(path, spec.skiprows || 0);
  if (!data) return [{}, path, matchType];

  const columns = spec.columns || {};
  const codeCol = String(columns.code || 'code');
  const emerCol = String(columns.reg_emer || columns.emergency || '');
  const startCol = String(columns.start_date || '');
  const typeCol = String(columns.type || '');
  const natureCol = String(columns.nature || '');

  const result: Record<string, AnyRecord> = {};

  for (const row of data) {
    const code = String(row[codeCol] || '')
      .trim()
      .toUpperCase();
    if (!code || code === 'NAN') continue;

    const entry: AnyRecord = {};

    if (emerCol && row[emerCol] !== undefined) {
      const val = String(row[emerCol]).trim();
      const valLower = val.toLowerCase();
      if (['yes', 'true', '1'].includes(valLower)) {
        entry.reg_emer = 'Emergency';
      } else if (['no', 'false', '0'].includes(valLower)) {
        entry.reg_emer = 'Regular';
      } else if (valLower.includes('emergency')) {
        entry.reg_emer = 'Emergency';
      } else if (valLower.includes('regular')) {
        entry.reg_emer = 'Regular';
      } else {
        entry.reg_emer = val;
      }
    }

    if (startCol && row[startCol] !== undefined) {
      entry.start_date = String(row[startCol]);
    }
    if (typeCol && row[typeCol] !== undefined) {
      entry.type = String(row[typeCol]).trim();
    }
    if (natureCol && row[natureCol] !== undefined) {
      entry.nature = String(row[natureCol]).trim();
    }

    result[code] = entry;
  }

  console.log(
    `  Loaded ${Object.keys(result).length} project list entries from ${path.split('/').pop()}`,
  );
  return [result, path, matchType];
}

function loadEmergencyFromBudgets(
  supplementalDir: string,
  spec: SupplementalFileSpec,
  codePrefix: string = '',
): [Record<string, string>, string | null, string] {
  const [path, matchType] = findFile(
    supplementalDir,
    spec.filename,
    'emergency_budgets',
  );
  if (!path) return [{}, null, ''];

  const data = loadTabular(path, spec.skiprows || 0);
  if (!data) return [{}, path, matchType];

  const codeCol = String(spec.columns.code || 'Project code');
  const emerCol = String(spec.columns.emergency || 'Emergency?');
  const prefix = codePrefix.toUpperCase();
  const result: Record<string, string> = {};

  for (const row of data) {
    const code = String(row[codeCol] || '')
      .trim()
      .toUpperCase();
    if (!code || code === 'NAN' || code === 'PROJECT CODE') continue;
    const emergency = String(row[emerCol] || '')
      .trim()
      .toLowerCase();
    const cls = emergency === 'yes' ? 'Emergency' : 'Regular';
    result[code] = cls;
    // Some budget files carry codes without the OC prefix (e.g. OCBA AF110 vs
    // record ESAF110) — store the prefixed variant too so the join still hits.
    if (prefix && !code.startsWith(prefix)) result[prefix + code] = cls;
  }

  console.log(
    `  Loaded ${Object.keys(result).length} emergency classifications from ${path.split('/').pop()}`,
  );
  return [result, path, matchType];
}

function loadSanctions(
  supplementalDir: string,
  spec: SupplementalFileSpec,
  oldToNew?: Record<string, string>,
): [Set<string>, string | null, string] {
  const [path, matchType] = findFile(
    supplementalDir,
    spec.filename,
    'sanctions',
  );
  if (!path) return [new Set(), null, ''];

  const data = loadTabular(path);
  if (!data) return [new Set(), path, matchType];

  const codeCol = String(spec.columns.code || 'HQ/OC Project');
  const sanctionsColName = String(spec.columns.sanctions || '');

  // Find actual sanctions column
  let actualSanctionsCol = '';
  if (
    sanctionsColName &&
    data.length > 0 &&
    data[0][sanctionsColName] !== undefined
  ) {
    actualSanctionsCol = sanctionsColName;
  } else if (data.length > 0) {
    for (const key of Object.keys(data[0])) {
      if (key.toLowerCase().includes('sanction')) {
        actualSanctionsCol = key;
        break;
      }
    }
  }

  const codes = new Set<string>();
  for (const row of data) {
    if (actualSanctionsCol) {
      if (String(row[actualSanctionsCol]).trim() !== 'Yes') continue;
    }
    const code = String(row[codeCol] || '')
      .trim()
      .toUpperCase();
    if (code) {
      codes.add(code);
      if (oldToNew && code in oldToNew) {
        codes.add(oldToNew[code]);
      }
    }
  }

  console.log(
    `  Loaded ${codes.size} sanctions entries from ${path.split('/').pop()}`,
  );
  return [codes, path, matchType];
}

function loadBudgets(
  supplementalDir: string,
  spec: SupplementalFileSpec,
  codePrefix: string = '',
  oldToNew?: Record<string, string>,
): [Record<string, number>, string | null, string] {
  const [path, matchType] = findFile(supplementalDir, spec.filename, 'budgets');
  if (!path) return [{}, null, ''];

  const data = loadTabular(path, spec.skiprows || 0);
  if (!data) return [{}, path, matchType];

  const codeCol = String(spec.columns.code || 'Project code');
  const amountCol = String(spec.columns.amount || 'Amount in EUR');
  const prefix = codePrefix.toUpperCase();
  const result: Record<string, number> = {};

  for (const row of data) {
    const code = String(row[codeCol] || '')
      .trim()
      .toUpperCase();
    // Skips blanks, NAN, the literal header, and section-divider rows (e.g.
    // WaCA's "A. REGULAR PROJECTS") whose code cell has no parseable amount.
    if (!code || code === 'NAN' || code === 'PROJECT CODE') continue;
    const amountStr = String(row[amountCol] || '').trim();
    if (!amountStr) continue;
    const clean = amountStr.replace(/[,\u20ac\s]/g, '');
    const val = parseFloat(clean);
    if (isNaN(val)) continue;

    result[code] = val;
    // OCBA budget codes lack the ES prefix; store the prefixed variant too.
    if (prefix && !code.startsWith(prefix)) result[prefix + code] = val;
    // WaCA: also key the budget by the new code if this is an old code.
    if (oldToNew && code in oldToNew) result[oldToNew[code]] = val;
  }

  console.log(
    `  Loaded ${Object.keys(result).length} budget entries from ${path.split('/').pop()}`,
  );
  return [result, path, matchType];
}

function loadCodeMapping(
  supplementalDir: string,
  spec: SupplementalFileSpec,
): [Record<string, string>, Record<string, string>, string | null, string] {
  const [path, matchType] = findFile(
    supplementalDir,
    spec.filename,
    'code_mapping',
  );
  if (!path) return [{}, {}, null, ''];

  const data = loadTabular(path);
  if (!data) return [{}, {}, path, matchType];

  const oldCol = String(spec.columns.old_code || 'Old CODE');
  const newCol = String(spec.columns.new_code || 'CODE');

  const oldToNew: Record<string, string> = {};
  const newToOld: Record<string, string> = {};

  for (const row of data) {
    const old = String(row[oldCol] || '')
      .trim()
      .toUpperCase();
    const newC = String(row[newCol] || '')
      .trim()
      .toUpperCase();
    if (old && old !== 'NAN' && newC && newC !== 'NAN') {
      oldToNew[old] = newC;
      newToOld[newC] = old;
    }
  }

  console.log(
    `  Loaded ${Object.keys(oldToNew).length} code mappings from ${path.split('/').pop()}`,
  );
  return [oldToNew, newToOld, path, matchType];
}

function loadAllocation(
  supplementalDir: string,
  spec: SupplementalFileSpec,
): [Record<string, AnyRecord>, string | null, string] {
  const [path, matchType] = findFile(
    supplementalDir,
    spec.filename,
    'allocation',
  );
  if (!path) return [{}, null, ''];

  const data = loadTabular(path, spec.skiprows || 0);
  if (!data) return [{}, path, matchType];

  const codeCol = String(spec.columns.code || 'code');
  const countryCol = String(spec.columns.country || 'country');
  const grantNameCol = String(spec.columns.grant_name || 'grant_name');

  const result: Record<string, AnyRecord> = {};
  for (const row of data) {
    const code = String(row[codeCol] || '')
      .trim()
      .toUpperCase();
    if (!code || code === 'NAN') continue;
    const entry: AnyRecord = {};
    const countryVal = String(row[countryCol] || '').trim();
    if (countryVal && countryVal.toUpperCase() !== 'NAN')
      entry.country = countryVal;
    const grantVal = String(row[grantNameCol] || '').trim();
    if (grantVal && grantVal.toUpperCase() !== 'NAN')
      entry.grant_name = grantVal;
    if (Object.keys(entry).length > 0) result[code] = entry;
  }

  console.log(
    `  Loaded ${Object.keys(result).length} allocation entries from ${path.split('/').pop()}`,
  );
  return [result, path, matchType];
}

// ---------------------------------------------------------------------------
// Supplemental report helper
// ---------------------------------------------------------------------------

interface ReportEntry {
  category: string;
  file?: string;
  match_type?: string;
  entries?: number;
  error?: string;
  expected?: string;
}

function buildReportEntry(
  category: string,
  expectedFilename: string,
  path: string | null,
  matchType: string,
  entryCount?: number,
  errorMsg?: string,
): ReportEntry {
  if (path && matchType && !errorMsg) {
    const entry: ReportEntry = {
      category,
      file: path.split('/').pop() || '',
      match_type: matchType,
    };
    if (entryCount !== undefined) entry.entries = entryCount;
    return entry;
  }
  if (path && errorMsg) {
    return { category, file: path.split('/').pop() || '', error: errorMsg };
  }
  return { category, expected: expectedFilename };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function run(params: {
  ocCfg: OCConfig;
  cacheDir: string;
  supplementalDir?: string;
  progress: ProgressEmitter;
  maxWorkers?: number;
  year?: number;
}): Promise<void> {
  const { ocCfg, cacheDir, supplementalDir, progress, year = 2026 } = params;

  console.log('\n' + '='.repeat(60));
  console.log('  Stage 4: Enrich with Supplemental Data');
  console.log('='.repeat(60));

  const inputPath = join(cacheDir, 'normalized_records.json');
  const emptyOutput = join(cacheDir, 'enriched_records.json');

  if (!existsSync(inputPath)) {
    console.log('  No normalized records found.');
    writeFileSync(emptyOutput, '[]', 'utf-8');
    progress.stageStart('enrich', 0);
    progress.stageDone('enrich');
    return;
  }

  const records: AnyRecord[] = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const total = records.length;

  if (total === 0) {
    console.log('  No records to enrich.');
    writeFileSync(emptyOutput, '[]', 'utf-8');
    progress.stageStart('enrich', 0);
    progress.stageDone('enrich');
    return;
  }

  progress.stageStart('enrich', total);

  const yearStr = String(year);

  // Load supplemental data
  let projectList: Record<string, AnyRecord> = {};
  let emergencyClass: Record<string, string> = {};
  let sanctionsSet = new Set<string>();
  let budgets: Record<string, number> = {};
  let allocationData: Record<string, AnyRecord> = {};
  let oldToNew: Record<string, string> = {};

  const suppFiles = ocCfg.supplemental_files || {};
  const loadedEntries: ReportEntry[] = [];
  const missingEntries: ReportEntry[] = [];
  const failedEntries: ReportEntry[] = [];

  if (supplementalDir && existsSync(supplementalDir)) {
    console.log(`  Loading supplemental data from ${supplementalDir}...`);

    // Code mapping (WaCA)
    if ('code_mapping' in suppFiles) {
      const spec = suppFiles.code_mapping;
      const [otn, , cmPath, cmMatch] = loadCodeMapping(supplementalDir, spec);
      oldToNew = otn;
      if (cmPath && cmMatch) {
        loadedEntries.push(
          buildReportEntry(
            'code_mapping',
            spec.filename,
            cmPath,
            cmMatch,
            Object.keys(otn).length,
          ),
        );
      } else if (cmPath) {
        failedEntries.push(
          buildReportEntry(
            'code_mapping',
            spec.filename,
            cmPath,
            '',
            undefined,
            'Failed to parse',
          ),
        );
      } else {
        missingEntries.push(
          buildReportEntry('code_mapping', spec.filename, null, ''),
        );
      }
    }

    // Project list
    if ('project_list' in suppFiles) {
      const spec = suppFiles.project_list;
      const [pl, plPath, plMatch] = loadProjectList(supplementalDir, spec);
      projectList = pl;
      if (plPath && plMatch && Object.keys(pl).length > 0) {
        loadedEntries.push(
          buildReportEntry(
            'project_list',
            spec.filename,
            plPath,
            plMatch,
            Object.keys(pl).length,
          ),
        );
      } else if (plPath) {
        failedEntries.push(
          buildReportEntry(
            'project_list',
            spec.filename,
            plPath,
            '',
            undefined,
            'Failed to parse',
          ),
        );
      } else {
        missingEntries.push(
          buildReportEntry('project_list', spec.filename, null, ''),
        );
      }
    }

    // Emergency from budgets (OCB, OCP)
    if ('emergency_budgets' in suppFiles) {
      const spec = suppFiles.emergency_budgets;
      const [ec, ebPath, ebMatch] = loadEmergencyFromBudgets(
        supplementalDir,
        spec,
        ocCfg.code_prefix,
      );
      emergencyClass = ec;
      if (ebPath && ebMatch && Object.keys(ec).length > 0) {
        loadedEntries.push(
          buildReportEntry(
            'emergency_budgets',
            spec.filename,
            ebPath,
            ebMatch,
            Object.keys(ec).length,
          ),
        );
      } else if (ebPath) {
        failedEntries.push(
          buildReportEntry(
            'emergency_budgets',
            spec.filename,
            ebPath,
            '',
            undefined,
            'Failed to parse',
          ),
        );
      } else {
        missingEntries.push(
          buildReportEntry('emergency_budgets', spec.filename, null, ''),
        );
      }
    }

    // Sanctions
    if ('sanctions' in suppFiles) {
      const spec = suppFiles.sanctions;
      const [ss, saPath, saMatch] = loadSanctions(
        supplementalDir,
        spec,
        Object.keys(oldToNew).length > 0 ? oldToNew : undefined,
      );
      sanctionsSet = ss;
      if (saPath && saMatch) {
        loadedEntries.push(
          buildReportEntry(
            'sanctions',
            spec.filename,
            saPath,
            saMatch,
            ss.size,
          ),
        );
      } else if (saPath) {
        failedEntries.push(
          buildReportEntry(
            'sanctions',
            spec.filename,
            saPath,
            '',
            undefined,
            'Failed to parse',
          ),
        );
      } else {
        missingEntries.push(
          buildReportEntry('sanctions', spec.filename, null, ''),
        );
      }
    }

    // Budgets
    if ('budgets' in suppFiles) {
      const spec = suppFiles.budgets;
      const [bu, buPath, buMatch] = loadBudgets(
        supplementalDir,
        spec,
        ocCfg.code_prefix,
        Object.keys(oldToNew).length > 0 ? oldToNew : undefined,
      );
      budgets = bu;
      if (buPath && buMatch && Object.keys(bu).length > 0) {
        loadedEntries.push(
          buildReportEntry(
            'budgets',
            spec.filename,
            buPath,
            buMatch,
            Object.keys(bu).length,
          ),
        );
      } else if (buPath) {
        failedEntries.push(
          buildReportEntry(
            'budgets',
            spec.filename,
            buPath,
            '',
            undefined,
            'Failed to parse',
          ),
        );
      } else {
        missingEntries.push(
          buildReportEntry('budgets', spec.filename, null, ''),
        );
      }
    }

    // Allocation
    if ('allocation' in suppFiles) {
      const spec = suppFiles.allocation;
      const [al, alPath, alMatch] = loadAllocation(supplementalDir, spec);
      allocationData = al;
      if (alPath && alMatch && Object.keys(al).length > 0) {
        loadedEntries.push(
          buildReportEntry(
            'allocation',
            spec.filename,
            alPath,
            alMatch,
            Object.keys(al).length,
          ),
        );
      } else if (alPath) {
        failedEntries.push(
          buildReportEntry(
            'allocation',
            spec.filename,
            alPath,
            '',
            undefined,
            'Failed to parse',
          ),
        );
      } else {
        missingEntries.push(
          buildReportEntry('allocation', spec.filename, null, ''),
        );
      }
    }
  } else {
    console.log('  No supplemental directory; skipping data joins.');
  }

  // Write supplemental report
  const suppReport = {
    loaded: loadedEntries,
    missing: missingEntries,
    failed: failedEntries,
  };
  writeFileSync(
    join(cacheDir, 'supplemental_report.json'),
    JSON.stringify(suppReport, null, 2),
    'utf-8',
  );
  console.log(
    `  Supplemental report: ${loadedEntries.length} loaded, ${missingEntries.length} missing, ${failedEntries.length} failed`,
  );

  // Enrich each record
  for (let idx = 0; idx < records.length; idx++) {
    const record = records[idx];
    const code = (record.project_code || '').toUpperCase();
    const source = record.source_file || `record_${idx + 1}`;

    // Allocation fallback for mission_country
    if (!record.mission_country && code in allocationData) {
      const allocCountry = allocationData[code]?.country;
      if (allocCountry) {
        record.mission_country = allocCountry;
        console.log(
          `  [${idx + 1}] Filled mission_country from allocation: ${allocCountry}`,
        );
      }
    }

    // Emergency / New / Closing from project list
    const rawClosing = record.closing_project || 'no';
    let projInfo = projectList[code];
    if (!projInfo && Object.keys(emergencyClass).length > 0) {
      const emer = emergencyClass[code];
      if (emer) projInfo = { reg_emer: emer };
    }

    if (projInfo) {
      const regEmer = projInfo.reg_emer || '';
      if (regEmer === 'Emergency') {
        record.emergency_project = 'Yes';
        record.new_project = 'No';
        record.closing_project = 'No';
      } else if (regEmer === 'Regular') {
        record.emergency_project = 'No';
        record.new_project =
          startYear(projInfo.start_date) === yearStr ? 'Yes' : 'No';
        record.closing_project = processClosingProject(rawClosing, false);
      } else {
        record.emergency_project = 'No';
        record.new_project = 'No';
        record.closing_project = processClosingProject(rawClosing, false);
      }
    } else {
      const finalEmergency = record.emergency_project === 'Yes';
      record.closing_project = processClosingProject(
        rawClosing,
        finalEmergency,
      );
    }

    // Final emergency override
    if (record.emergency_project === 'Yes') {
      record.new_project = 'No';
      record.closing_project = 'No';
    }

    // Sanctions
    record.sanctions = sanctionsSet.has(code) ? 'Yes' : 'Not Found';

    // Budget
    if (code in budgets) {
      record.initial_budget_eur = Math.round(budgets[code]).toLocaleString(
        'en-US',
      );
    }

    // ICA Country
    const [icaCountry, icaCode] = getIcaCountryInfo(
      record.mission_country || '',
    );
    record.ica_country = icaCountry;
    record.ica_country_code = icaCode;

    // HQ / Direct funding rates
    if (ocCfg.hq_rate > 0) {
      record.hq_rate = hqRateStr(ocCfg);
      record.direct_rate = directRateStr(ocCfg);
    }

    console.log(
      `  [${idx + 1}/${total}] ${source}: ${code} - ` +
        `E=${record.emergency_project || '?'} ` +
        `S=${record.sanctions || '?'} ` +
        `B=${record.initial_budget_eur || '-'}`,
    );
    progress.tick(idx + 1, total);
  }

  // Write enriched records
  const outputPath = join(cacheDir, 'enriched_records.json');
  writeFileSync(outputPath, JSON.stringify(records, null, 2), 'utf-8');

  progress.stageDone('enrich');
  console.log(`  Enrichment complete: ${total} record(s) -> ${outputPath}`);
}
