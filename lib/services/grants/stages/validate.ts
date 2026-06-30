/**
 * Stage 5: Validation -- 18 rules.
 */
import {
  COUNTRY_ALIASES,
  REFERENCE_COUNTRIES,
} from '../lookups/countryReference';
import type { OCConfig } from '../ocConfig';
import type { ProgressEmitter } from '../progress';

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

const BRITISH_TO_AMERICAN: Record<string, string> = {
  theatre: 'theater',
  paediatric: 'pediatric',
  organisation: 'organization',
  programme: 'program',
  colour: 'color',
  centre: 'center',
  labour: 'labor',
  behaviour: 'behavior',
  defence: 'defense',
  licence: 'license',
};

const VALID_CLOSING_VALUES = [
  'No',
  'Yes/Full Closure',
  'Handover to Another OC',
  'Partial Handover/Reorientation',
];

const HANDOVER_TERMS = [
  'handover',
  'closure',
  'closing',
  'disengagement',
  'transfer',
  'cease',
  'handed over',
  'wind down',
  'phase out',
  'phase-out',
  'withdrawal',
  'exit',
  'reorientation',
  'transition',
  'relocated',
  'relocat',
  'close',
  'time-bound',
  'time\u2011bound',
  'commissioning',
  'wrap up',
  'wrapped up',
  'wrapping up',
  'integration',
  'managed by the ministry',
  'managed by ministry',
];

const COMMON_ACRONYMS = [
  'PHC',
  'SRH',
  'SGBV',
  'NCD',
  'MHPSS',
  'CMA',
  'CSPS',
  'CSRef',
  'ITFC',
  'ATFC',
  'OPD',
  'IPD',
  'BEmONC',
  'CEmONC',
  'ANC',
  'PNC',
];

const REQUIRED_FIELDS = [
  'Project Name',
  'Mission Country',
  'Project Objective',
  'Key Terms/Activities',
];

const _INTERNAL_TO_DISPLAY: Record<string, string> = {
  project_code: 'Project Number',
  project_name: 'Project Name',
  mission_country: 'Mission Country',
  country: 'Country',
  oc_name: 'OC',
  project_objective: 'Project Objective',
  activities_list: 'Key Terms/Activities',
  activities: 'Key Terms/Activities',
  evidence_summary: 'Evidence Summary',
  start_date: 'Start Date',
  end_date: 'End Date',
  project_active: 'Project Active',
  purpose_code: 'Purpose Code',
  new_project: 'New Project',
  emergency_project: 'Emergency Project',
  closing_project: 'Closing Project',
  remote_management: 'Remote Management',
  remote_management_notes: 'Remote Management Notes',
  sanctions: 'Sanctions',
  sensitive_context: 'Sensitive Context for Screening',
  impact_climate: 'Impact of Climate Change',
  nutrition: 'Nutrition',
  refugees_idps: 'Refugees and IDPs',
  emergency_relief: 'Emergency Relief Fund',
  mental_health: 'Mental Health',
  maternal_health: 'Maternal Health',
  pediatrics: 'Pediatrics',
  community_centered: 'Community/Patient-Centered',
  armed_conflict: 'Armed Conflict',
  context: 'Context',
  event: 'Event',
  population_type: 'Population Type',
  ica_country: 'ICA Country',
  ica_country_code: 'ICA Country Code',
  initial_budget_eur: 'Initial Budget EUR',
  budget: 'Initial Budget EUR',
  source_file: 'Source File',
  _source_file: 'Source File',
  hq_rate: 'HQ Program Support Rate',
  direct_rate: 'Direct Program Funding Rate',
};

const COORDINATION_KEYWORDS = [
  'coordination',
  'coodination',
  'mission',
  'strategy',
];

const LOCATION_CONTEXTS = [
  'south ',
  'north ',
  'east ',
  'west ',
  'central ',
  ' city',
  ' region',
  ' province',
  ' state',
  ' district',
  ' metropolitan',
  ' governorate',
];

function normalizeKeys(rec: AnyRecord): AnyRecord {
  if ('Project Name' in rec || 'Project Number' in rec) return rec;
  const mapped: AnyRecord = {};
  for (const [key, value] of Object.entries(rec)) {
    const displayKey = _INTERNAL_TO_DISPLAY[key] || key;
    let val = value;
    if (
      (key === 'activities_list' || key === 'activities') &&
      Array.isArray(value)
    ) {
      val = value.filter(Boolean).join(', ');
    }
    mapped[displayKey] = val;
  }
  return mapped;
}

function safe(val: unknown): string {
  if (val === null || val === undefined) return '';
  const s = String(val).trim();
  return s.toLowerCase() === 'nan' ? '' : s;
}

interface Flag {
  row: number;
  column: string;
  rule: string;
  severity: string;
  message: string;
}

function flag(
  row: number,
  column: string,
  rule: string,
  severity: string,
  message: string,
): Flag {
  return { row, column, rule, severity, message };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRate(raw: string): string {
  const s = safe(raw).replace('%', '');
  const num = parseFloat(s);
  if (!isNaN(num)) return `${Math.round(num)}%`;
  return safe(raw);
}

// Rules
function r01(rec: AnyRecord, row: number): Flag[] {
  const fields: Record<string, string> = {
    'Project Name': safe(rec['Project Name']),
    'Project Objective': safe(rec['Project Objective']),
    'Key Terms/Activities': safe(rec['Key Terms/Activities']),
  };
  const locations: string[] = [];
  for (const [name, val] of Object.entries(fields)) {
    if (val.toLowerCase().includes('health care')) locations.push(name);
  }
  if (locations.length > 0) {
    return [
      flag(
        row,
        locations.join(', '),
        'R1',
        'error',
        `"health care" (two words) found in: ${locations.join(', ')}. Must be "healthcare" (one word).`,
      ),
    ];
  }
  return [];
}

function r02(rec: AnyRecord, row: number): Flag[] {
  const country = safe(rec['Country']);
  if (!country)
    return [flag(row, 'Country', 'R2', 'warning', 'Country is blank.')];
  if (REFERENCE_COUNTRIES.has(country)) return [];
  const lower = country.toLowerCase();
  for (const ref of REFERENCE_COUNTRIES) {
    if (ref.toLowerCase() === lower) return [];
  }
  if (lower in COUNTRY_ALIASES) return [];
  return [
    flag(
      row,
      'Country',
      'R2',
      'error',
      `"${country}" not found in country reference list.`,
    ),
  ];
}

function r03(rec: AnyRecord, row: number): Flag[] {
  const mc = safe(rec['Mission Country']);
  const obj = safe(rec['Project Objective']);
  if (!mc || mc.length <= 3 || !obj) return [];
  const mcLower = mc.toLowerCase();
  const objLower = obj.toLowerCase();
  const re = new RegExp('\\b' + escapeRegExp(mcLower) + '\\b', 'g');
  const matches = [...objLower.matchAll(re)];
  if (matches.length === 0) return [];
  for (const m of matches) {
    const start = Math.max(0, m.index! - 10);
    const end = Math.min(objLower.length, m.index! + m[0].length + 15);
    const context = objLower.slice(start, end);
    if (!LOCATION_CONTEXTS.some((lc) => context.includes(lc))) {
      return [
        flag(
          row,
          'Project Objective',
          'R3',
          'warning',
          `Country name "${mc}" found in objective (not as part of a location phrase).`,
        ),
      ];
    }
  }
  return [];
}

function r04(rec: AnyRecord, row: number): Flag[] {
  const obj = safe(rec['Project Objective']);
  if (obj.toLowerCase().startsWith('provide')) {
    return [
      flag(
        row,
        'Project Objective',
        'R4',
        'warning',
        'Objective starts with "Provide".',
      ),
    ];
  }
  return [];
}

function r05(rec: AnyRecord, row: number): Flag[] {
  const name = safe(rec['Project Name']);
  const obj = safe(rec['Project Objective']);
  const activities = safe(rec['Key Terms/Activities']);
  let evidence = safe(rec['Evidence Summary']);
  if (evidence) {
    evidence = evidence.replace(/Supporting Text:.*?(?=\n\n- |\n*$)/gs, '');
  }
  const checkText = `${name} ${obj} ${activities} ${evidence}`.toLowerCase();
  const found: string[] = [];
  for (const [brit, amer] of Object.entries(BRITISH_TO_AMERICAN)) {
    if (checkText.includes(brit)) found.push(`"${brit}" -> "${amer}"`);
  }
  if (found.length > 0) {
    return [
      flag(
        row,
        'Multiple',
        'R5',
        'error',
        `British English detected: ${found.join('; ')}.`,
      ),
    ];
  }
  return [];
}

function r06(rec: AnyRecord, row: number): Flag[] {
  const name = safe(rec['Project Name']);
  if (!name) return [];
  const parts = name.split(/\b(?:Healthcare|Care|Support|Response)\b/i);
  const locationPart = parts[0] || name;
  if (
    locationPart.includes(',') &&
    locationPart.toLowerCase().includes(' and ')
  ) {
    return [
      flag(
        row,
        'Project Name',
        'R6',
        'warning',
        `Possible multiple locations in name: "${locationPart.trim()}".`,
      ),
    ];
  }
  if ((locationPart.match(/,/g) || []).length > 1) {
    return [
      flag(
        row,
        'Project Name',
        'R6',
        'warning',
        `Multiple commas suggest multiple locations: "${locationPart.trim()}".`,
      ),
    ];
  }
  return [];
}

function r07(rec: AnyRecord, row: number): Flag[] {
  const closing = safe(rec['Closing Project']);
  if (closing && !VALID_CLOSING_VALUES.includes(closing)) {
    return [
      flag(
        row,
        'Closing Project',
        'R7',
        'error',
        `Invalid Closing Project value: "${closing}". Must be one of: ${VALID_CLOSING_VALUES.join(', ')}.`,
      ),
    ];
  }
  return [];
}

function r08(rec: AnyRecord, row: number): Flag[] {
  const closing = safe(rec['Closing Project']);
  if (!closing || closing === 'No') return [];
  const obj = safe(rec['Project Objective']).toLowerCase();
  if (HANDOVER_TERMS.some((term) => obj.includes(term))) return [];
  return [
    flag(
      row,
      'Project Objective',
      'R8',
      'error',
      `Closing is "${closing}" but objective does not mention handover, closure, or related terms.`,
    ),
  ];
}

function r10(rec: AnyRecord, row: number, expectedOc: string): Flag[] {
  const oc = safe(rec['OC']);
  if (oc !== expectedOc) {
    return [
      flag(
        row,
        'OC',
        'R10',
        'error',
        `Expected OC "${expectedOc}", got "${oc}".`,
      ),
    ];
  }
  return [];
}

function r11(rec: AnyRecord, row: number, ocCfg: OCConfig): Flag[] {
  const expectedHq =
    ocCfg.hq_rate > 0 ? `${Math.round(ocCfg.hq_rate * 100)}%` : '';
  const expectedDirect =
    ocCfg.direct_rate > 0 ? `${Math.round(ocCfg.direct_rate * 100)}%` : '';
  if (!expectedHq && !expectedDirect) return [];

  const hqNorm = normalizeRate(rec['HQ Program Support Rate']);
  const directNorm = normalizeRate(rec['Direct Program Funding Rate']);

  if (expectedHq && hqNorm !== expectedHq) {
    return [
      flag(
        row,
        'HQ Program Support Rate',
        'R11',
        'error',
        `HQ rate expected "${expectedHq}", got "${safe(rec['HQ Program Support Rate'])}".`,
      ),
    ];
  }
  if (expectedDirect && directNorm !== expectedDirect) {
    return [
      flag(
        row,
        'Direct Program Funding Rate',
        'R11',
        'error',
        `Direct rate expected "${expectedDirect}", got "${safe(rec['Direct Program Funding Rate'])}".`,
      ),
    ];
  }
  return [];
}

function r12(rec: AnyRecord, row: number): Flag[] {
  const obj = safe(rec['Project Objective']);
  if (!obj) return [];
  const unexpanded = COMMON_ACRONYMS.filter((acr) =>
    new RegExp('\\b' + acr + '\\b').test(obj),
  );
  if (unexpanded.length > 0) {
    return [
      flag(
        row,
        'Project Objective',
        'R12',
        'warning',
        `Unexpanded acronyms in objective: ${unexpanded.join(', ')}.`,
      ),
    ];
  }
  return [];
}

function r13(rec: AnyRecord, row: number): Flag[] {
  const blank = REQUIRED_FIELDS.filter((f) => !safe(rec[f]));
  if (blank.length > 0) {
    return [
      flag(
        row,
        blank.join(', '),
        'R13',
        'error',
        `Required field(s) blank: ${blank.join(', ')}.`,
      ),
    ];
  }
  return [];
}

function r14(rec: AnyRecord, row: number): Flag[] {
  const obj = safe(rec['Project Objective']);
  if (/\b(including|focusing on)\b.*,.*,/i.test(obj)) {
    return [
      flag(
        row,
        'Project Objective',
        'R14',
        'warning',
        'Possible activity listing in objective (pattern "including/focusing on X, Y, Z" detected).',
      ),
    ];
  }
  return [];
}

function r15(rec: AnyRecord, row: number): Flag[] {
  if (safe(rec['Emergency Project']) !== 'Yes') return [];
  const issues: string[] = [];
  if (safe(rec['New Project']) === 'Yes')
    issues.push('New Project should be No');
  const closing = safe(rec['Closing Project']);
  if (closing && closing !== 'No') issues.push('Closing Project should be No');
  if (issues.length > 0) {
    return [
      flag(
        row,
        'Emergency Project',
        'R15',
        'error',
        `Emergency=Yes override violated: ${issues.join('; ')}.`,
      ),
    ];
  }
  return [];
}

function r16(rec: AnyRecord, row: number, codeRegex: string | null): Flag[] {
  const code = safe(rec['Project Number']);
  if (!code)
    return [
      flag(row, 'Project Number', 'R16', 'error', 'Project code is missing.'),
    ];
  if (code === 'No Project Code') {
    return [
      flag(
        row,
        'Project Number',
        'R16',
        'warning',
        '"No Project Code" placeholder.',
      ),
    ];
  }
  if (codeRegex && !new RegExp(codeRegex).test(code)) {
    return [
      flag(
        row,
        'Project Number',
        'R16',
        'warning',
        `Project code "${code}" does not match expected pattern (${codeRegex}).`,
      ),
    ];
  }
  return [];
}

function r17(rec: AnyRecord, row: number): Flag[] {
  const source = safe(rec['Source File']);
  if (!source) return [];
  const sourceLower = source.toLowerCase();
  for (const kw of COORDINATION_KEYWORDS) {
    if (sourceLower.includes(kw)) {
      return [
        flag(
          row,
          'Source File',
          'R17',
          'error',
          `Source file appears to be a coordination/strategy doc: "${source}".`,
        ),
      ];
    }
  }
  return [];
}

function r18(
  rec: AnyRecord,
  row: number,
  codeCounts: Map<string, number>,
): Flag[] {
  const code = safe(rec['Project Number']);
  if (!code || code === 'No Project Code') return [];
  const count = codeCounts.get(code) || 0;
  if (count > 1) {
    return [
      flag(
        row,
        'Project Number',
        'R18',
        'warning',
        `Duplicate project code "${code}" appears ${count} times in this OC.`,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidationResult {
  total_rows: number;
  summary: { errors: number; warnings: number; info: number };
  flags: Flag[];
}

export function run(params: {
  ocCfg: OCConfig;
  cacheDir: string;
  validationOutput?: string;
  progress: {
    stageStart: (n: string, t: number) => void;
    tick: (c: number, t: number) => void;
    stageDone: (n: string) => void;
  };
}): ValidationResult | undefined {
  const { ocCfg, cacheDir, validationOutput, progress } = params;
  const enrichedPath = join(cacheDir, 'enriched_records.json');

  console.log('\n' + '='.repeat(60));
  console.log('  Stage 5: Validation (18 rules)');
  console.log('='.repeat(60));

  if (!existsSync(enrichedPath)) {
    console.log('  No enriched records found -- skipping validation.');
    progress.stageStart('validate', 0);
    progress.stageDone('validate');
    if (validationOutput) {
      mkdirSync(dirname(validationOutput), { recursive: true });
      writeFileSync(validationOutput, JSON.stringify([], null, 2), 'utf-8');
    }
    return undefined;
  }

  let records: AnyRecord[] = JSON.parse(readFileSync(enrichedPath, 'utf-8'));
  records = records.map(normalizeKeys);

  const total = records.length;
  const ocName = safe(ocCfg.name);
  const codeRegex = ocCfg.code_regex || null;

  // Pre-compute code counts for R18
  const codeCounts = new Map<string, number>();
  for (const rec of records) {
    const code = safe(rec['Project Number']);
    if (code && code !== 'No Project Code') {
      codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
    }
  }

  progress.stageStart('validate', total);
  const allFlags: Flag[] = [];

  for (let idx = 0; idx < records.length; idx++) {
    const rec = records[idx];
    const row = idx + 1;
    const rowFlags: Flag[] = [];

    rowFlags.push(...r01(rec, row));
    rowFlags.push(...r02(rec, row));
    rowFlags.push(...r03(rec, row));
    rowFlags.push(...r04(rec, row));
    rowFlags.push(...r05(rec, row));
    rowFlags.push(...r06(rec, row));
    rowFlags.push(...r07(rec, row));
    rowFlags.push(...r08(rec, row));
    // R9 always passes
    rowFlags.push(...r10(rec, row, ocName));
    rowFlags.push(...r11(rec, row, ocCfg));
    rowFlags.push(...r12(rec, row));
    rowFlags.push(...r13(rec, row));
    rowFlags.push(...r14(rec, row));
    rowFlags.push(...r15(rec, row));
    rowFlags.push(...r16(rec, row, codeRegex));
    rowFlags.push(...r17(rec, row));
    rowFlags.push(...r18(rec, row, codeCounts));

    allFlags.push(...rowFlags);

    const errors = rowFlags.filter((f) => f.severity === 'error').length;
    const warnings = rowFlags.filter((f) => f.severity === 'warning').length;
    const infos = rowFlags.filter((f) => f.severity === 'info').length;
    const source =
      safe(rec['Source File']) ||
      safe(rec['Project Number']) ||
      `record_${row}`;
    console.log(
      `  [${row}/${total}] ${source}: ${errors} error(s), ${warnings} warning(s), ${infos} info(s)`,
    );
    progress.tick(row, total);
  }

  const summary = {
    errors: allFlags.filter((f) => f.severity === 'error').length,
    warnings: allFlags.filter((f) => f.severity === 'warning').length,
    info: allFlags.filter((f) => f.severity === 'info').length,
  };

  const result: ValidationResult = {
    total_rows: total,
    summary,
    flags: allFlags,
  };

  // Write to cache
  const validationPath = join(cacheDir, 'validation.json');
  writeFileSync(validationPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`  Wrote ${validationPath}`);

  // Optionally copy to a second location
  if (validationOutput) {
    mkdirSync(dirname(validationOutput), { recursive: true });
    copyFileSync(validationPath, validationOutput);
    console.log(`  Copied to ${validationOutput}`);
  }

  console.log(
    `\n  Validation complete: ${total} row(s) checked, ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.info} info(s).`,
  );
  return result;
}
