/**
 * Stage 6: CSV assembly.
 *
 * Writes the final 34-column CSV from validated records.
 */
import type { OCConfig } from '../ocConfig';
import type { ProgressEmitter } from '../progress';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export const CSV_COLUMNS: string[] = [
  'Project Number',
  'Project Name',
  'Mission Country',
  'OC',
  'Project Objective',
  'Key Terms/Activities',
  'Evidence Summary',
  'Start Date',
  'End Date',
  'Project Active',
  'Purpose Code',
  'New Project',
  'Emergency Project',
  'Closing Project',
  'Remote Management',
  'Remote Management Notes',
  'Sanctions',
  'Sensitive Context for Screening',
  'Impact of Climate Change',
  'Nutrition',
  'Refugees and IDPs',
  'Emergency Relief Fund',
  'Mental Health',
  'Maternal Health',
  'Pediatrics',
  'Community/Patient-Centered',
  'Armed Conflict',
  'Context',
  'Event',
  'Population Type',
  'ICA Country',
  'ICA Country Code',
  'Initial Budget EUR',
  'Source File',
];

function yesNo(value: unknown): string {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['yes', 'true', '1'].includes(lowered)) return 'Yes';
    if (['no', 'false', '0'].includes(lowered)) return 'No';
  }
  return '';
}

function sanctionsValue(value: unknown): string {
  if (value === true) return 'Yes';
  if (
    typeof value === 'string' &&
    ['yes', 'true', '1'].includes(value.trim().toLowerCase())
  ) {
    return 'Yes';
  }
  return 'Not Found';
}

function safeStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function formatBudget(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return safeStr(value);
}

function joinList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((v) => safeStr(v))
      .filter(Boolean)
      .join('; ');
  }
  return safeStr(value);
}

function loadRecords(cacheDir: string): AnyRecord[] {
  for (const name of [
    'enriched_records.json',
    'normalized_records.json',
    'records.json',
  ]) {
    const path = join(cacheDir, name);
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      return Array.isArray(data) ? data : [data];
    }
  }
  return [];
}

function recordToRow(
  record: AnyRecord,
  ocName: string,
): Record<string, string> {
  return {
    'Project Number': safeStr(record.project_code),
    'Project Name': safeStr(record.project_name),
    'Mission Country': safeStr(record.mission_country || record.country),
    OC: safeStr(record.oc_name || ocName),
    'Project Objective': safeStr(record.project_objective),
    'Key Terms/Activities': joinList(
      record.activities_list || record.activities,
    ),
    'Evidence Summary': safeStr(record.evidence_summary),
    'Start Date': safeStr(record.start_date),
    'End Date': safeStr(record.end_date),
    'Project Active': yesNo(record.project_active),
    'Purpose Code': safeStr(record.purpose_code),
    'New Project': yesNo(record.new_project),
    'Emergency Project': yesNo(record.emergency_project),
    'Closing Project': safeStr(record.closing_project),
    'Remote Management': yesNo(record.remote_management),
    'Remote Management Notes': safeStr(record.remote_management_notes),
    Sanctions: sanctionsValue(record.sanctions),
    'Sensitive Context for Screening': yesNo(record.sensitive_context),
    'Impact of Climate Change': yesNo(record.impact_climate),
    Nutrition: yesNo(record.nutrition),
    'Refugees and IDPs': yesNo(record.refugees_idps),
    'Emergency Relief Fund': yesNo(record.emergency_relief),
    'Mental Health': yesNo(record.mental_health),
    'Maternal Health': yesNo(record.maternal_health),
    Pediatrics: yesNo(record.pediatrics),
    'Community/Patient-Centered': yesNo(record.community_centered),
    'Armed Conflict': yesNo(record.armed_conflict),
    Context: safeStr(record.context),
    Event: safeStr(record.event),
    'Population Type': safeStr(record.population_type),
    'ICA Country': safeStr(record.ica_country),
    'ICA Country Code': safeStr(record.ica_country_code),
    'Initial Budget EUR': formatBudget(
      record.initial_budget_eur || record.budget,
    ),
    'Source File': safeStr(record.source_file || record._source_file),
  };
}

function escapeCSVField(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function run(params: {
  ocCfg: OCConfig;
  cacheDir: string;
  outputPath: string;
  progress: ProgressEmitter;
}): string {
  const { ocCfg, cacheDir, outputPath, progress } = params;

  console.log('\n' + '='.repeat(60));
  console.log('  Stage 6: CSV Assembly');
  console.log('='.repeat(60));

  const records = loadRecords(cacheDir);
  const total = records.length;

  if (total === 0) {
    console.log(
      '  WARNING: No records found in cache; writing header-only CSV.',
    );
  }

  const ocName = safeStr(ocCfg.name);

  progress.stageStart('build_output', total);

  // Build CSV manually
  mkdirSync(dirname(outputPath), { recursive: true });
  const headerLine = CSV_COLUMNS.map(escapeCSVField).join(',');
  const dataLines: string[] = [];

  for (let idx = 0; idx < records.length; idx++) {
    const row = recordToRow(records[idx], ocName);
    const line = CSV_COLUMNS.map((col) => escapeCSVField(row[col] || '')).join(
      ',',
    );
    dataLines.push(line);
    progress.tick(idx + 1, total);
  }

  const csvContent = [headerLine, ...dataLines].join('\n');
  writeFileSync(outputPath, csvContent, 'utf-8');

  console.log(
    `  Wrote ${total} row(s) x ${CSV_COLUMNS.length} columns -> ${outputPath}`,
  );

  // Write validation JSON (if present in cache)
  const validationPath = join(cacheDir, 'validation.json');
  if (existsSync(validationPath)) {
    const validation = JSON.parse(readFileSync(validationPath, 'utf-8'));
    const validationOutputPath = outputPath.replace(
      /\.csv$/,
      '.validation.json',
    );
    mkdirSync(dirname(validationOutputPath), { recursive: true });
    writeFileSync(
      validationOutputPath,
      JSON.stringify(validation, null, 2),
      'utf-8',
    );
    const summary = validation.summary || {};
    console.log(
      `  Wrote validation report -> ${validationOutputPath} ` +
        `(${summary.errors || 0} errors, ${summary.warnings || 0} warnings, ${summary.info || 0} info)`,
    );
  }

  progress.stageDone('build_output');
  console.log('  Export complete.');
  return outputPath;
}
