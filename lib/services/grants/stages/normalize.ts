/**
 * Stage 3: Post-processing normalization.
 *
 * Applies deterministic normalization rules to raw records from Stage 2.
 * No LLM calls.
 */
import { aliasMentions, deriveDocAliases } from '../aliasMap';
import { normalizeCountry } from '../lookups/countryReference';
import { matchGreenInitiatives } from '../lookups/greenInitiatives';
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

// These helpers use the model's quote only as a pointer to locate the real document
// text, then surface an actual verbatim slice of the document (findable in the PDF).
// If no good anchor is found, the model's original text is kept
// unchanged.

const DASH_PUNCT = /\p{Pd}/u;
const DROP_CHARS = new Set(['­', '​', '‌', '‍', '﻿']);
const SINGLE_QUOTES = new Set(['’', '‘', '‛', 'ʼ', '´', '`']);
const DOUBLE_QUOTES = new Set(['“', '”']);

/** Normalize for fuzzy matching, keeping a map from each normalized-char index
 *  back to its index in the original text (so a match recovers the verbatim span).
 *  Absorbs whitespace runs, non-breaking/soft/zero-width chars, curly quotes and
 *  every Unicode dash, and case — the ways a model copy drifts without being wrong. */
function normalizeForMatch(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    if (DROP_CHARS.has(c)) continue;
    if (SINGLE_QUOTES.has(c)) c = "'";
    else if (DOUBLE_QUOTES.has(c)) c = '"';
    else if (DASH_PUNCT.test(c)) c = '-';
    if (/\s/.test(c)) {
      if (lastSpace) continue;
      norm += ' ';
      map.push(i);
      lastSpace = true;
    } else {
      const lc = c.toLowerCase();
      for (const ch of lc) {
        norm += ch;
        map.push(i);
      }
      lastSpace = false;
    }
  }
  return { norm, map };
}

/** Recover the verbatim original substring for a normalized [start,end) range. */
function recoverVerbatim(
  raw: string,
  map: number[],
  ns: number,
  ne: number,
): string {
  const start = map[ns];
  const end = ne < map.length ? map[ne] : raw.length;
  return raw.slice(start, end);
}

/** Expand an original [start,end) to nearby sentence/cell boundaries, capped, so
 *  the surfaced quote reads naturally — still a contiguous, findable slice. */
function expandToBoundary(raw: string, start: number, end: number): string {
  const STOP = /[.!?;\n\r\t•|]/;
  let s = start;
  for (let k = start - 1; k >= 0 && start - k < 200; k--) {
    if (STOP.test(raw[k])) {
      s = k + 1;
      break;
    }
    s = k;
  }
  let e = end;
  for (let k = end; k < raw.length && k - end < 300; k++) {
    if (STOP.test(raw[k])) {
      e = k + 1;
      break;
    }
    e = k + 1;
  }
  return raw.slice(s, e);
}

/** The longest run of consecutive words from `nq` that appears as one contiguous
 *  substring of `nSrc`. Returns normalized [start,end) or null. */
function longestWordRun(
  nq: string,
  nSrc: string,
): { at: number; end: number } | null {
  const words = nq.split(' ').filter(Boolean);
  let best: { at: number; end: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    let phrase = words[i];
    if (nSrc.indexOf(phrase) < 0) continue;
    let at = nSrc.indexOf(phrase);
    let end = at + phrase.length;
    for (let j = i + 1; j < words.length; j++) {
      const ext = phrase + ' ' + words[j];
      const eat = nSrc.indexOf(ext);
      if (eat < 0) break;
      phrase = ext;
      at = eat;
      end = eat + ext.length;
    }
    if (!best || end - at > best.end - best.at) best = { at, end };
  }
  return best;
}

/**
 * Return the VERBATIM supporting text from `raw` for a model quote, so it can be
 * found with Ctrl+F. Never blanks: if nothing meaningful anchors, returns the
 * model's original quote unchanged.
 */
function resolveVerbatimQuote(raw: string, modelQuote: string): string {
  const q = String(modelQuote || '');
  if (!raw || q.trim().length < 12) return q;
  const { norm: nSrc, map } = normalizeForMatch(raw);
  const nq = normalizeForMatch(q).norm.trim();
  if (!nq) return q;
  // Fast path: the whole quote is already a (drift-tolerant) substring.
  const whole = nSrc.indexOf(nq);
  if (whole >= 0) {
    return recoverVerbatim(raw, map, whole, whole + nq.length).trim() || q;
  }
  // Otherwise anchor on the longest matching word-run and surface the real span.
  const run = longestWordRun(nq, nSrc);
  if (!run || run.end - run.at < 15) return q; // no real anchor — keep model's
  const start = map[run.at];
  const end = run.end < map.length ? map[run.end] : raw.length;
  const span = expandToBoundary(raw, start, end).trim();
  return span || q;
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
    const match = source.match(/([A-Z]{1,3}W?\d{2,4})/i);
    if (match) {
      filenameCode = match[1].toUpperCase();
      if (ocCfg.old_to_new_codes && filenameCode in ocCfg.old_to_new_codes) {
        filenameCode = ocCfg.old_to_new_codes[filenameCode];
      }
      // Apply the OC's required code prefix to filename-derived codes too — the
      // model-code path does this, but the filename path did not, so OCBA Yemen
      // filenames like "..._YE113_..." produced "YE113" instead of "ESYE113"
      // (which also broke dedup).
      if (
        ocCfg.code_prefix &&
        !filenameCode.startsWith(ocCfg.code_prefix.toUpperCase())
      ) {
        filenameCode = ocCfg.code_prefix.toUpperCase() + filenameCode;
      }
      // A filename-derived code must satisfy the OC's code pattern.
      try {
        if (!new RegExp(ocCfg.code_regex, 'i').test(filenameCode)) {
          console.log(
            `  ! ${source}: filename fragment "${filenameCode}" does not match ${ocCfg.name} pattern ${ocCfg.code_regex} — ignoring it`,
          );
          filenameCode = '';
        }
      } catch {
        // keep legacy behavior
      }
    }
  }

  // The model's own per-project code, normalized (single code, mapped, prefixed).
  let modelCode = String(record.project_code || '')
    .split(/[,&;]/)[0]
    .trim()
    .toUpperCase();
  if (modelCode) {
    if (ocCfg.old_to_new_codes && modelCode in ocCfg.old_to_new_codes) {
      modelCode = ocCfg.old_to_new_codes[modelCode];
    }
    if (
      ocCfg.code_prefix &&
      !modelCode.startsWith(ocCfg.code_prefix.toUpperCase())
    ) {
      modelCode = ocCfg.code_prefix.toUpperCase() + modelCode;
    }
  }
  let modelCodeValid = false;
  try {
    modelCodeValid =
      !!modelCode && new RegExp(ocCfg.code_regex, 'i').test(modelCode);
  } catch {
    modelCodeValid = !!modelCode;
  }
  if (modelCodeValid) {
    const yearDigits = modelCode.match(/\d{4}/)?.[0];
    const digitRun = modelCode.match(/\d+/)?.[0];
    if (
      (yearDigits && yearDigits === String(year)) ||
      digitRun === '001' ||
      digitRun === '000'
    ) {
      console.log(
        `  ! ${source}: model code "${modelCode}" looks fabricated (year/placeholder digits) — ignoring it in favor of filename/blank`,
      );
      modelCodeValid = false;
    }
  }

  let projectCode: string;
  if (overrideCode) {
    projectCode = overrideCode;
  } else if (record._multi_code_doc && modelCodeValid) {
    projectCode = modelCode;
  } else if (filenameCode) {
    projectCode = filenameCode;
  } else if (modelCodeValid) {
    projectCode = modelCode;
  } else {
    if (modelCode) {
      console.log(
        `  ! ${source}: model code "${modelCode}" does not match ${ocCfg.name} pattern ${ocCfg.code_regex} — leaving code blank for review`,
      );
    }
    projectCode = '';
  }

  if (projectCode.length >= 3) {
    const prefix = projectCode.slice(0, 2);
    if (prefix in _LLM_CODE_PREFIX_FIXES) {
      projectCode = _LLM_CODE_PREFIX_FIXES[prefix] + projectCode.slice(2);
    }
  }

  // Reject a fabricated "year code": when a document has no real project code,
  // the model sometimes emits the planning year as the number (e.g. ESML2026,
  // ESNG2026, ESSD2026).
  const codeDigits = projectCode.match(/\d{4}/)?.[0];
  if (codeDigits && codeDigits === String(year)) {
    projectCode = '';
  }

  // Reject fabricated placeholder codes (same issue as above).
  const digitRun = projectCode.match(/\d+/)?.[0];
  if (digitRun === '001' || digitRun === '000') {
    console.log(
      `  ! ${source}: placeholder code "${projectCode}" (digits ${digitRun}) — not a real project number, leaving blank for review`,
    );
    projectCode = '';
  }

  if (!projectCode) projectCode = 'No Project Code';

  // --- Country ---
  let missionCountry = record.country || record.mission_country || '';
  const normalizedCountry = normalizeCountry(missionCountry);
  if (normalizedCountry) missionCountry = normalizedCountry;

  // --- Activities ---
  let activitiesList = formatActivitiesList(activities);
  let evidenceSummary = formatEvidenceSummary(activities);

  //Green initiatives
  const aliasCtx = record._alias_context as
    | { mine: string[]; foreign: string[] }
    | undefined;
  const recordLocalText = [
    record.project_objective,
    evidenceSummary,
    ...activities.map((a: AnyRecord) =>
      typeof a === 'object' && a !== null
        ? `${a.activity || ''} ${a.quote_english || ''} ${a.quote_original || ''}`
        : String(a),
    ),
  ]
    .filter(Boolean)
    .join('\n');
  const aliasScopedText =
    record._multi_code_doc &&
    aliasCtx &&
    (aliasCtx.mine.length > 0 || aliasCtx.foreign.length > 0)
      ? String(record._raw_text || '')
          .split('\n')
          .filter((line) => {
            const hitsMine =
              aliasCtx.mine.some((al) => aliasMentions(line, al)) ||
              line
                .toUpperCase()
                .includes(String(record.project_code || '').toUpperCase());
            if (hitsMine) return true;
            return false;
          })
          .join('\n') +
        '\n' +
        recordLocalText
      : null;
  const greenSource =
    aliasScopedText !== null
      ? aliasScopedText
      : ocCfg.multi_project
        ? [
            record.project_objective,
            evidenceSummary,
            ...activities.map((a: AnyRecord) =>
              typeof a === 'object' && a !== null
                ? `${a.activity || ''} ${a.quote_english || ''} ${a.quote_original || ''}`
                : String(a),
            ),
          ]
            .filter(Boolean)
            .join('\n')
        : record._raw_text || record.project_objective || '';
  const green = matchGreenInitiatives(String(greenSource));
  if (green.subcategories.length > 0) {
    const existing = activitiesList ? activitiesList.split(', ') : [];
    for (const sub of green.subcategories) {
      if (!existing.includes(sub)) existing.push(sub);
    }
    activitiesList = existing.join(', ');
    // Audit trail: show which column-A phrases produced each green key term,
    // in the same Evidence Summary format the model's activities use.
    const greenEvidence = green.subcategories
      .map((sub) => {
        const phrases = (green.phrasesBySubcategory[sub] || []).slice(0, 3);
        return `- ${sub} (Green Initiative)\n  Matched phrase${phrases.length > 1 ? 's' : ''}: ${phrases.map((ph) => `"${ph}"`).join('; ')}`;
      })
      .join('\n\n');
    evidenceSummary = evidenceSummary
      ? `${evidenceSummary}\n\n${greenEvidence}`
      : greenEvidence;
  }

  if (!activitiesList.trim()) {
    activitiesList = `No ${year} or current year activities found`;
  }

  // --- Project name ---
  let projectName = record.project_name || '';
  if (!String(projectName).trim() && record._raw_text) {
    const m = String(record._raw_text).match(
      /Initiative\s+Name\s*[:\u2013\u2014-]\s*([^\n\r]+)/i,
    );
    if (m)
      projectName = m[1]
        .trim()
        .replace(/\s{2,}.*$/, '')
        .slice(0, 160);
  }
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

  if (
    green.subcategories.length > 0 &&
    !/Green initiative/i.test(projectObjective)
  ) {
    const sentence = `Green initiative — ${green.actions.join(', ')}: ${green.subcategories.join(', ')}.`;
    projectObjective = projectObjective
      ? `${projectObjective.replace(/\s+$/, '')}${/[.!?]$/.test(projectObjective.trim()) ? '' : '.'} ${sentence}`
      : sentence;
  }

  // Closing/handover is tracked separately (from a supplemental source), NOT
  // inferred from the narrative. Keep the raw model value for the (non-focus)
  // closing_project column, but do NOT append any closure text to the project
  // objective.
  // Closing status is derived from supplemental files in enrich (classifications
  // + dates), not the narrative.
  const rawClosing = 'no';

  // --- Purpose codes ---
  const purposeCodes = getPurposeCodes(missionCountry, projectName);

  // --- Emergency ---
  // Emergency status comes from supplemental files only (classifications file
  // or project list); the model's narrative reading is not used.
  // Default value is No.
  const emergencyLlm = 'No';

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
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
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

  const aliasesBySource = new Map<string, Map<string, string[]>>();
  const aliasOwners = new Map<string, Map<string, string>>(); // src -> alias -> code
  const derivedFlag = new Map<string, Set<string>>(); // src -> codes with doc-derived aliases
  {
    const codesBySource = new Map<string, string[]>();
    for (const rec of records) {
      const src = String(rec._source_file || '');
      const code = String(rec.project_code || '').toUpperCase();
      if (!codesBySource.has(src)) codesBySource.set(src, []);
      if (code && !codesBySource.get(src)!.includes(code))
        codesBySource.get(src)!.push(code);
    }
    const derivedBySource = new Map<string, Map<string, string[]>>();
    // Codes whose aliases came from the document itself — exempt from the
    // ownership strip below (the document may share one alias across codes).

    for (const [src, codes] of codesBySource) {
      const txtName = basename(src).replace(/\.[^.]+$/, '') + '.txt';
      const raw = rawTexts[txtName] ?? rawTexts[src] ?? '';
      derivedBySource.set(
        src,
        raw ? deriveDocAliases(raw, codes) : new Map<string, string[]>(),
      );
    }
    for (const rec of records) {
      const src = String(rec._source_file || '');
      const code = String(rec.project_code || '').toUpperCase();
      const derived = derivedBySource.get(src)?.get(code) || [];
      let aliases = derived;
      if (derived.length > 0) {
        if (!derivedFlag.has(src)) derivedFlag.set(src, new Set());
        derivedFlag.get(src)!.add(code);
      }
      if (aliases.length === 0) {
        // Fallback: model-reported aliases, sanity-gated.
        aliases = (
          Array.isArray(rec.project_aliases) ? rec.project_aliases : []
        )
          .map((a: unknown) => String(a).trim())
          .filter(
            (a: string) =>
              a.length >= 2 && a.length <= 12 && /[A-Za-z].*[A-Za-z]/.test(a),
          );
      } else {
        if (!aliasOwners.has(src)) aliasOwners.set(src, new Map());
        const owners = aliasOwners.get(src)!;
        for (const d of derived)
          if (!owners.has(d.toUpperCase())) owners.set(d.toUpperCase(), code);
      }
      if (!aliasesBySource.has(src)) aliasesBySource.set(src, new Map());
      aliasesBySource.get(src)!.set(code, aliases);
    }
  }
  // Ownership rule: a model-reported alias that the document
  // assigns to a different code is a misclaim — strip it, so a record
  // claiming a sibling's alias cannot siphon away that sibling's content.
  for (const [src, byCode] of aliasesBySource) {
    const owners = aliasOwners.get(src);
    if (!owners) continue;
    for (const [code, as] of byCode) {
      if (derivedFlag.get(src)?.has(code)) continue; // doc-derived: trusted
      byCode.set(
        code,
        as.filter((a) => {
          const owner = owners.get(a.toUpperCase());
          if (owner && owner !== code) {
            console.log(
              `  ! alias "${a}" claimed by ${code} belongs to ${owner} (per the document) — ignoring the claim`,
            );
            return false;
          }
          return true;
        }),
      );
    }
  }

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

    // Replace each activity's reconstructed quote with the real verbatim text
    // from the source, so supporting text is searchable with Ctrl+F.
    // When no anchor is found, the models original quote is kept.
    const acts = record.activities_2026 || record[`activities_${year}`];
    if (record._raw_text && Array.isArray(acts)) {
      for (const a of acts) {
        if (a && typeof a === 'object' && a.quote_original) {
          a.quote_original = resolveVerbatimQuote(
            record._raw_text,
            a.quote_original,
          );
        }
      }
    }

    const srcAliasMap = aliasesBySource.get(String(record._source_file || ''));
    if (srcAliasMap && srcAliasMap.size > 1 && Array.isArray(acts)) {
      const myCode = String(record.project_code || '').toUpperCase();
      const mine = (srcAliasMap.get(myCode) || []).map((a) => a.toUpperCase());
      const foreign: string[] = [];
      for (const [c, as] of srcAliasMap) {
        if (c !== myCode)
          foreign.push(
            ...as.map((a) => a.toUpperCase()).filter((a) => !mine.includes(a)),
          );
      }
      if (foreign.length > 0) {
        const rawText = String(record._raw_text || '');
        const contextLine = (quote: string): string => {
          const q = quote.trim();
          if (q.length < 12 || !rawText) return '';
          const i = rawText.indexOf(q.slice(0, 80));
          if (i < 0) return '';
          const start = rawText.lastIndexOf('\n', i) + 1;
          const endN = rawText.indexOf('\n', i);
          return rawText.slice(start, endN < 0 ? rawText.length : endN);
        };
        const kept = acts.filter((a: AnyRecord) => {
          if (!a || typeof a !== 'object') return true;
          const verbatim = String(a.quote_original || '').trim();
          const quotes = verbatim || String(a.quote_english || '');
          if (!quotes.trim()) return true;
          let hitsMine = mine.some((al) => aliasMentions(quotes, al));
          let hitsForeign = foreign.some((al) => aliasMentions(quotes, al));
          if (verbatim) {
            const en = String(a.quote_english || '');
            if (en && !hitsMine && mine.some((al) => aliasMentions(en, al))) {
              console.log(
                `  ! ${source}: translated quote for "${a.activity || '?'}" on ${myCode} claims this project's alias but the verbatim text does not — treating as fabricated`,
              );
            }
          }
          if (!hitsMine && !hitsForeign) {
            const ctx =
              contextLine(String(a.quote_original || '')) ||
              contextLine(String(a.quote_english || ''));
            if (ctx) {
              hitsMine = mine.some((al) => aliasMentions(ctx, al));
              hitsForeign = foreign.some((al) => aliasMentions(ctx, al));
              if (hitsMine && !mine.some((al) => aliasMentions(quotes, al))) {
                const sentences = ctx.split(/(?<=[.!?])\s+/);
                const q = String(a.quote_original || a.quote_english || '')
                  .trim()
                  .slice(0, 60);
                let expanded =
                  sentences.find(
                    (sent) =>
                      sent.includes(q) &&
                      mine.some((al) => aliasMentions(sent, al)),
                  ) || '';
                if (!expanded && ctx.length <= 400) expanded = ctx;
                if (!expanded) {
                  const i = ctx.indexOf(q);
                  if (i >= 0) {
                    const start = Math.max(0, i - 150);
                    const end = Math.min(ctx.length, i + q.length + 150);
                    expanded = ctx.slice(start, end);
                  }
                }
                if (
                  expanded &&
                  mine.some((al) => aliasMentions(expanded, al))
                ) {
                  a.quote_original = expanded.trim();
                }
              }
            }
          }
          if (hitsForeign && !hitsMine) {
            console.log(
              `  ! ${source}: dropped activity "${a.activity || '?'}" from ${myCode} — its evidence belongs to a sibling project's context`,
            );
            return false;
          }
          return true;
        });
        if (kept.length !== acts.length) {
          record.activities_2026 = kept;
          if (record[`activities_${year}`]) record[`activities_${year}`] = kept;
        }
      }
      record._alias_context = { mine, foreign };
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

  // Final authoritative dedup on the canonical code. extractFields dedups on the
  // raw model code, so records that converge only after prefix / old->new
  // canonicalization (e.g. "BF103" + "ESBF103") still collide here — collapse to
  // one row per code so duplicates never reach output. "No Project Code" is never
  // collapsed (those are distinct projects that genuinely lack a code).
  const coordKw = (ocCfg.coord_keywords || [])
    .map((k) => (k || '').toLowerCase())
    .filter(Boolean);
  const isCoordSrc = (rec: AnyRecord): boolean => {
    const s = String(rec.source_file || '').toLowerCase();
    return coordKw.some((k) => s.includes(k));
  };
  // How many projects each source produced — a dedicated single-project narrative
  // (1) should beat a multi-project overview/coordination doc (many) on collision.
  const sourceCounts = new Map<string, number>();
  for (const rec of normalized) {
    const s = String(rec.source_file || '');
    sourceCounts.set(s, (sourceCounts.get(s) || 0) + 1);
  }
  const activityCount = (rec: AnyRecord): number =>
    String(rec.activities_list || '')
      .split(',')
      .filter((x) => x.trim()).length;
  const prefer = (a: AnyRecord, b: AnyRecord): AnyRecord => {
    const ac = isCoordSrc(a);
    const bc = isCoordSrc(b);
    if (ac !== bc) return ac ? b : a; // non-coordination narrative wins
    const asib = sourceCounts.get(String(a.source_file || '')) || 1;
    const bsib = sourceCounts.get(String(b.source_file || '')) || 1;
    if (asib !== bsib) return asib < bsib ? a : b; // dedicated doc wins
    const aa = activityCount(a);
    const ba = activityCount(b);
    if (aa !== ba) return aa > ba ? a : b; // richer activities
    return String(a.project_objective || '').length >=
      String(b.project_objective || '').length
      ? a
      : b;
  };
  const byCode = new Map<string, AnyRecord>();
  const deduped: AnyRecord[] = [];
  for (const rec of normalized) {
    const code = rec.project_code;
    if (!code || code === 'No Project Code') {
      deduped.push(rec);
      continue;
    }
    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, rec);
    } else {
      const winner = prefer(existing, rec);
      if (winner !== existing) {
        console.log(
          `  dedup ${code}: kept "${winner.source_file}" over "${(winner === existing ? rec : existing).source_file}"`,
        );
      }
      byCode.set(code, winner);
    }
  }
  deduped.push(...byCode.values());

  // Drop entirely-empty records: a coordination / overview document can yield a
  // record with no real code, no name, no objective, and no activities — that
  // shows up as a blank, checkable row with nothing in any cell. If a record has
  // NONE of {a real code, name, objective, activities}, it carries no information
  // and is removed. (Records with any of those are kept; blank activities alone
  // are kept and explained by validation rule R19.)
  const meaningful = (r: AnyRecord): boolean => {
    const code = String(r.project_code || '').trim();
    const realCode = !!code && code !== 'No Project Code';
    return (
      realCode ||
      !!String(r.project_name || '').trim() ||
      !!String(r.project_objective || '').trim() ||
      !!String(r.activities_list || '').trim()
    );
  };
  const finalRecords = deduped.filter(meaningful);
  const removed = normalized.length - finalRecords.length;

  // Write normalized records to cache
  const outputPath = join(cacheDir, 'normalized_records.json');
  writeFileSync(outputPath, JSON.stringify(finalRecords, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  // Persist the model's per-document type classification (project narrative vs
  // coordination / strategy / overview / compilation) for the results UI to flag
  // non-narrative source documents. Keyed by source-file (matches the CSV's
  // "Source File" column). Best-effort — if absent, the data endpoint falls back
  // to keyword-based classification.
  try {
    const docTypes: Record<string, string> = {};
    for (const r of records) {
      const sf = String(r._source_file || '');
      const dt = String(r._document_type || '');
      if (sf && dt && !docTypes[sf]) docTypes[sf] = dt;
    }
    writeFileSync(
      join(cacheDir, 'document_types.json'),
      JSON.stringify(docTypes, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch {
    /* non-fatal — UI falls back to keyword classification */
  }

  progress.stageDone('normalize');
  console.log(
    `  Normalization complete: ${finalRecords.length} record(s) -> ${outputPath}` +
      (removed > 0 ? ` (${removed} duplicate/empty record(s) removed)` : ''),
  );
}
