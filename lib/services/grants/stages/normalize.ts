/**
 * Stage 3: Post-processing normalization.
 *
 * Applies deterministic normalization rules to raw records from Stage 2.
 * No LLM calls.
 */
import { normalizeCountry } from '../lookups/countryReference';
import { getPurposeCodes } from '../lookups/purposeCodes';
import { isSensitive } from '../lookups/sensitiveCountries';
import {
  formatActivitiesList,
  formatEvidenceSummary,
  normalizeActivity,
} from '../lookups/termHierarchy';
import type { OCConfig } from '../ocConfig';
import type { ProgressEmitter } from '../progress';

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

const BRITISH_TO_AMERICAN: Record<string, string> = {
  theatre: 'theater',
  paediatric: 'pediatric',
  paediatrics: 'pediatrics',
  organisation: 'organization',
  organisations: 'organizations',
  programme: 'program',
  programmes: 'programs',
  colour: 'color',
  colours: 'colors',
  centre: 'center',
  centres: 'centers',
  labour: 'labor',
  behaviour: 'behavior',
  behaviours: 'behaviors',
  defence: 'defense',
  licence: 'license',
  licences: 'licenses',
  analyse: 'analyze',
  analysed: 'analyzed',
  analysing: 'analyzing',
  catalyse: 'catalyze',
  optimise: 'optimize',
  optimised: 'optimized',
  recognised: 'recognized',
  recognise: 'recognize',
  specialised: 'specialized',
  specialise: 'specialize',
  mobilisation: 'mobilization',
  utilisation: 'utilization',
  hospitalisation: 'hospitalization',
  immunisation: 'immunization',
  prioritise: 'prioritize',
  prioritised: 'prioritized',
  stabilise: 'stabilize',
  stabilised: 'stabilized',
  harmonise: 'harmonize',
  harmonised: 'harmonized',
};

const _LLM_CODE_PREFIX_FIXES: Record<string, string> = {
  PS: 'PI',
};

const ACRONYM_EXPANSIONS: Record<string, string> = {
  PHC: 'primary healthcare',
  SRH: 'sexual and reproductive health',
  SGBV: 'sexual and gender-based violence',
  NCD: 'non-communicable diseases',
  NCDs: 'non-communicable diseases',
  MHPSS: 'mental health and psychosocial support',
  CMA: 'centre médical avec antenne chirurgicale',
  CSPS: 'centre de santé et de promotion sociale',
  CSRef: 'centre de santé de référence',
  ITFC: 'inpatient therapeutic feeding center',
  ATFC: 'ambulatory therapeutic feeding center',
  OPD: 'outpatient department',
  IPD: 'inpatient department',
  BEmONC: 'basic emergency obstetric and newborn care',
  CEmONC: 'comprehensive emergency obstetric and newborn care',
  ANC: 'antenatal care',
  PNC: 'postnatal care',
  ARV: 'antiretroviral',
  ART: 'antiretroviral therapy',
  PMTCT: 'prevention of mother-to-child transmission',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyAmericanEnglish(text: string): string {
  if (!text) return text;
  let result = text;
  for (const [british, american] of Object.entries(BRITISH_TO_AMERICAN)) {
    const pattern = new RegExp(escapeRegExp(british), 'gi');
    result = result.replace(pattern, (match) => {
      if (match === match.toLowerCase()) return american;
      if (match[0] === match[0].toUpperCase()) {
        return american.charAt(0).toUpperCase() + american.slice(1);
      }
      return american;
    });
  }
  return result;
}

function fixHealthcareSpelling(text: string): string {
  if (!text) return text;
  return text.replace(/\bhealth\s+care\b/gi, 'healthcare');
}

function parseDateFlexible(dateStr: string): Date | null {
  const s = dateStr.trim();
  if (!s) return null;

  const formats: [RegExp, (m: RegExpMatchArray) => Date][] = [
    [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (m) => new Date(+m[1], +m[2] - 1, +m[3])],
    [
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
      (m) => new Date(+m[3], +m[1] - 1, +m[2]),
    ],
    [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, (m) => new Date(+m[3], +m[2] - 1, +m[1])],
    [
      /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
      (m) => new Date(+m[3], +m[2] - 1, +m[1]),
    ],
  ];

  for (const [re, fn] of formats) {
    const match = s.match(re);
    if (match) {
      const d = fn(match);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // Month-name formats
  const monthNameDate = new Date(s);
  if (!isNaN(monthNameDate.getTime()) && s.length > 4) return monthNameDate;

  // Bare year
  if (/^\d{4}$/.test(s)) {
    return new Date(+s, 11, 31);
  }

  return null;
}

function validateProjectActive(
  endDate: string,
  llmActive: string,
  year: number = 2026,
): string {
  if (llmActive && llmActive.toLowerCase() === 'no') return 'No';
  if (!endDate || ['ongoing', 'tbd', 'n/a', ''].includes(endDate.toLowerCase()))
    return 'Yes';
  try {
    const cutoff = new Date(year, 11, 31);
    const parsed = parseDateFlexible(endDate);
    if (parsed) return parsed < cutoff ? 'No' : 'Yes';
    return 'Yes';
  } catch {
    return 'Yes';
  }
}

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

function toYesNo(value: unknown): string {
  if (
    value &&
    ['yes', 'true', '1', 'y'].includes(String(value).toLowerCase().trim())
  )
    return 'Yes';
  return 'No';
}

function buildClosingSuffix(closingType: string, endDate: string): string {
  const val = closingType.trim().toLowerCase();
  let datePhrase = '';
  if (
    endDate &&
    !['ongoing', 'tbd', 'n/a', ''].includes(endDate.toLowerCase())
  ) {
    const parsed = parseDateFlexible(endDate);
    if (parsed) {
      const months = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ];
      datePhrase = `${months[parsed.getMonth()]} ${parsed.getFullYear()}`;
    }
  }

  if (val.includes('full') || ['yes', 'true', 'y'].includes(val)) {
    return datePhrase
      ? `; intervention planned to end in ${datePhrase}.`
      : '; project planned for full closure.';
  }
  if (
    val.includes('handover') &&
    (val.includes('partial') || val.includes('reorientation'))
  ) {
    return datePhrase
      ? `; partial handover/reorientation planned by ${datePhrase}.`
      : '; partial handover/reorientation planned.';
  }
  if (val.includes('handover')) {
    return datePhrase
      ? `; handover to another OC planned by ${datePhrase}.`
      : '; handover to another OC planned.';
  }
  if (datePhrase) return `; intervention planned to end in ${datePhrase}.`;
  return '';
}

function normalizeRecord(
  record: AnyRecord,
  ocCfg: OCConfig,
  year: number = 2026,
  codeOverrides?: Record<string, string>,
): AnyRecord {
  const activities = record.activities_2026 || [];

  // --- Project code ---
  const source = record._source_file || '';

  // Highest priority: a code the user confirmed during the pre-processing
  // coverage check (name-match accepted for a narrative that had no code).
  // Matched by filename stem; only for single-project OCs.
  let overrideCode = '';
  if (codeOverrides && source && !ocCfg.multi_project) {
    const stem = String(source)
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
    for (const [k, v] of Object.entries(codeOverrides)) {
      if (
        String(k)
          .replace(/\.[^.]+$/, '')
          .toLowerCase() === stem
      ) {
        overrideCode = String(v).trim().toUpperCase();
        break;
      }
    }
  }

  let filenameCode = '';
  if (source && !ocCfg.multi_project) {
    const match = source.match(/([A-Z]{2,3}W?\d{2,4})/i);
    if (match) {
      filenameCode = match[1].toUpperCase();
      if (ocCfg.old_to_new_codes && filenameCode in ocCfg.old_to_new_codes) {
        filenameCode = ocCfg.old_to_new_codes[filenameCode];
      }
    }
  }

  let projectCode: string;
  if (overrideCode) {
    projectCode = overrideCode;
  } else if (filenameCode) {
    projectCode = filenameCode;
  } else {
    projectCode = record.project_code || '';
    if (projectCode) {
      projectCode = projectCode.split(/[,&;]/)[0].trim().toUpperCase();
      if (ocCfg.old_to_new_codes && projectCode in ocCfg.old_to_new_codes) {
        projectCode = ocCfg.old_to_new_codes[projectCode];
      }
      if (
        ocCfg.code_prefix &&
        !projectCode.startsWith(ocCfg.code_prefix.toUpperCase())
      ) {
        projectCode = ocCfg.code_prefix.toUpperCase() + projectCode;
      }
    }
  }

  if (projectCode.length >= 3) {
    const prefix = projectCode.slice(0, 2);
    if (prefix in _LLM_CODE_PREFIX_FIXES) {
      projectCode = _LLM_CODE_PREFIX_FIXES[prefix] + projectCode.slice(2);
    }
  }

  if (!projectCode) projectCode = 'No Project Code';

  // --- Country ---
  let missionCountry = record.mission_country || '';
  const normalizedCountry = normalizeCountry(missionCountry);
  if (normalizedCountry) missionCountry = normalizedCountry;

  // --- Activities ---
  const activitiesList = formatActivitiesList(activities);
  const evidenceSummary = formatEvidenceSummary(activities);

  // --- Project name ---
  let projectName = record.project_name || '';
  projectName = fixHealthcareSpelling(projectName);
  projectName = applyAmericanEnglish(projectName);

  // --- Dates ---
  const startDate = record.start_date || '';
  const endDate = record.end_date || '';
  const projectActive = validateProjectActive(
    endDate,
    record.project_active || 'yes',
    year,
  );

  // --- Project objective ---
  let projectObjective = record.project_objective || '';
  projectObjective = fixHealthcareSpelling(projectObjective);
  projectObjective = applyAmericanEnglish(projectObjective);

  // Append closing/handover info
  const rawClosing = record.is_closing_project || 'no';
  const closingLower = rawClosing.trim().toLowerCase();
  if (!['no', 'false', 'n', ''].includes(closingLower)) {
    const objLower = projectObjective.toLowerCase();
    const closingKeywords = [
      'closing',
      'closure',
      'handover',
      'handed over',
      'end in',
      'ending',
      'planned to end',
      'will close',
      'will end',
    ];
    if (!closingKeywords.some((kw) => objLower.includes(kw))) {
      const suffix = buildClosingSuffix(rawClosing, endDate);
      if (suffix) {
        projectObjective = projectObjective.replace(/[.\s]+$/, '') + suffix;
      }
    }
  }

  // --- Purpose codes ---
  const purposeCodes = getPurposeCodes(missionCountry, projectName);

  // --- Emergency ---
  const emergencyLlm = toYesNo(record.is_emergency_project || 'no');

  // --- Remote management ---
  let remoteMgmt = toYesNo(record.has_remote_management || 'no');
  let remoteNotes = record.remote_management_notes || '';
  if (
    !remoteNotes ||
    ['null', 'none', ''].includes(String(remoteNotes).toLowerCase())
  ) {
    remoteNotes = 'N/A';
  }

  // Remote management backstop
  const rawText = record._raw_text || '';
  if (remoteMgmt === 'Yes' && rawText) {
    const textLower = rawText.toLowerCase();
    if (
      !textLower.includes('remote management') &&
      !textLower.includes('remotely managed')
    ) {
      remoteMgmt = 'No';
    }
  }

  if (remoteMgmt === 'Yes' && remoteNotes && remoteNotes !== 'N/A') {
    const notesLower = remoteNotes.toLowerCase();
    const partialIndicators = [
      'parts of',
      'partial',
      'hybrid',
      'flash visit',
      'some ',
      'specific',
      'component',
      'cannot supervise',
      'cannot ',
      'restricted',
      'outsourced',
      'semi-remote',
      'semi-remotely',
      'clinic managed',
      'site managed',
      'certain ',
      'during periods',
      'procedures in place',
      'planned for',
      'remote technical support',
      'remote support',
    ];
    if (partialIndicators.some((ind) => notesLower.includes(ind))) {
      remoteMgmt = 'No';
    }
  }

  // --- Thematic flags ---
  function llmFlag(field: string): string {
    const v = record[field];
    return v && ['yes', 'true', '1'].includes(String(v).toLowerCase().trim())
      ? 'Yes'
      : 'No';
  }

  const sensitive = isSensitive(missionCountry);
  const communityCentered = llmFlag('is_community_centered');
  const context = record.context || '';
  const event = record.event || '';
  const populationType = record.population_type || '';
  const armedConflict = context.trim() === 'Armed Conflict' ? 'Yes' : 'No';

  return {
    project_code: projectCode,
    project_name: projectName,
    mission_country: missionCountry,
    oc_name: ocCfg.name,
    project_objective: projectObjective,
    activities_list: activitiesList,
    evidence_summary: evidenceSummary,
    start_date: startDate,
    end_date: endDate,
    project_active: projectActive,
    purpose_code: purposeCodes,
    new_project: 'No', // Finalized in enrich
    emergency_project: emergencyLlm,
    closing_project: rawClosing, // Raw LLM value; finalized in enrich
    remote_management: remoteMgmt,
    remote_management_notes: remoteNotes,
    sanctions: 'Not Found',
    sensitive_context: sensitive ? 'Yes' : 'No',
    impact_climate: llmFlag('focuses_on_climate_impact'),
    nutrition: llmFlag('focuses_on_nutrition'),
    refugees_idps: llmFlag('focuses_on_refugees_idps'),
    emergency_relief: llmFlag('focuses_on_emergency_response'),
    mental_health: llmFlag('focuses_on_mental_health'),
    maternal_health: llmFlag('focuses_on_maternal_health'),
    pediatrics: llmFlag('focuses_on_pediatrics'),
    community_centered: communityCentered,
    armed_conflict: armedConflict,
    context,
    event,
    population_type: populationType,
    ica_country: '',
    ica_country_code: '',
    initial_budget_eur: '',
    source_file: record._source_file || '',
  };
}

export async function run(params: {
  ocCfg: OCConfig;
  fieldsDir: string;
  cacheDir: string;
  progress: ProgressEmitter;
  year?: number;
  textDir?: string;
  codeOverrides?: Record<string, string>;
}): Promise<void> {
  const {
    ocCfg,
    fieldsDir,
    cacheDir,
    progress,
    year = 2026,
    textDir,
    codeOverrides,
  } = params;

  console.log('\n' + '='.repeat(60));
  console.log('  Stage 3: Post-Processing Normalization');
  console.log('='.repeat(60));

  // Pre-load raw text files (for remote-management backstop)
  const rawTexts: Record<string, string> = {};
  if (textDir) {
    try {
      const txtFiles = readdirSync(textDir).filter((f) => f.endsWith('.txt'));
      for (const f of txtFiles) {
        try {
          rawTexts[f] = readFileSync(join(textDir, f), 'utf-8');
        } catch {}
      }
    } catch {}
  }

  // Load all extracted records
  const records: AnyRecord[] = [];
  const jsonFiles = readdirSync(fieldsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const f of jsonFiles) {
    try {
      const data = JSON.parse(readFileSync(join(fieldsDir, f), 'utf-8'));
      if (Array.isArray(data)) {
        records.push(...data);
      } else {
        records.push(data);
      }
    } catch (e) {
      console.log(`  ! Error loading ${f}: ${e}`);
    }
  }

  const total = records.length;
  if (total === 0) {
    console.log('  No records to normalize.');
    progress.stageStart('normalize', 0);
    progress.stageDone('normalize');
    return;
  }

  progress.stageStart('normalize', total);
  console.log(`  Normalizing ${total} records for OC=${ocCfg.name}...`);

  const normalized: AnyRecord[] = [];

  for (let idx = 0; idx < records.length; idx++) {
    const record = records[idx];
    const source = record._source_file || `record_${idx + 1}`;

    // Inject raw text for remote-management backstop
    if (source) {
      const txtName = basename(source).replace(/\.[^.]+$/, '') + '.txt';
      if (txtName in rawTexts) {
        record._raw_text = rawTexts[txtName];
      } else if (source in rawTexts) {
        record._raw_text = rawTexts[source];
      }
    }

    try {
      const norm = normalizeRecord(record, ocCfg, year, codeOverrides);
      normalized.push(norm);
      console.log(
        `  [${idx + 1}/${total}] ${source}: ${norm.project_code} - ${norm.mission_country}`,
      );
    } catch (e) {
      console.log(`  [${idx + 1}/${total}] ${source}: ERROR - ${e}`);
    }

    progress.tick(idx + 1, total);
  }

  // Write normalized records to cache
  const outputPath = join(cacheDir, 'normalized_records.json');
  writeFileSync(outputPath, JSON.stringify(normalized, null, 2), 'utf-8');

  progress.stageDone('normalize');
  console.log(
    `  Normalization complete: ${normalized.length} record(s) -> ${outputPath}`,
  );
}
