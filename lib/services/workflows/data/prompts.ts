import { ColumnProfile, DataColumn } from '@/types/workflow';

import { ROW_ID_KEY, formatCell, getRowId } from './tableUtils';

/** Prompt builders for the data-analysis workflow's LLM operations. */

export function describeColumns(columns: DataColumn[]): string {
  return columns
    .map(
      (c) =>
        `- ${c.id} ("${c.name}", ${c.type}${c.required ? ', REQUIRED' : ''})`,
    )
    .join('\n');
}

/** Guidance line listing required fields (extraction can't enforce them). */
export function buildRequiredFieldsGuidance(columns: DataColumn[]): string {
  const required = columns.filter((c) => c.required === true);
  if (required.length === 0) return '';
  return `\nRequired fields: ${required
    .map((c) => `"${c.name}"`)
    .join(
      ', ',
    )} — extract these whenever the material states them; never invent a value to satisfy them.\n`;
}

/**
 * TSV serialization with the stable row id as an explicit first column —
 * the model must echo these ids so fixes anchor to rows. Cell rendering
 * is the canonical formatCell (apply-time comparisons depend on it).
 */
export function serializeTableWithRids(
  columns: DataColumn[],
  rows: Record<string, unknown>[],
): string {
  const header = [ROW_ID_KEY, ...columns.map((c) => c.id)].join('\t');
  const body = rows
    .map((row) =>
      [getRowId(row) ?? '', ...columns.map((c) => formatCell(row[c.id]))].join(
        '\t',
      ),
    )
    .join('\n');
  return `${header}\n${body}`;
}

/**
 * Deterministic column statistics as prompt ground truth: the model
 * reasons FROM these figures rather than re-counting from the sample.
 */
export function buildStatsBlock(
  columns: DataColumn[],
  stats: ColumnProfile[],
): string {
  const byId = new Map(stats.map((s) => [s.columnId, s]));
  return columns
    .map((column) => {
      const s = byId.get(column.id);
      if (!s) return `- ${column.id}: (no stats)`;
      const parts = [
        `missing ${s.missing}/${s.total}`,
        `distinct ${s.distinct}`,
      ];
      if (s.min !== undefined && s.max !== undefined) {
        parts.push(`range ${s.min}–${s.max}`);
        if (s.mean !== undefined) parts.push(`mean ${round2(s.mean)}`);
        if (s.median !== undefined) parts.push(`median ${round2(s.median)}`);
      }
      if (s.minDate && s.maxDate) parts.push(`range ${s.minDate}–${s.maxDate}`);
      if (s.topValues && s.topValues.length > 0) {
        parts.push(
          `values: ${s.topValues
            .map((v) => `"${v.value}"×${v.count}`)
            .join(', ')}`,
        );
      }
      return `- ${column.id}: ${parts.join('; ')}`;
    })
    .join('\n');
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function buildDataAssessmentSystemPrompt(
  criteriaRubrics: string[],
): string {
  return `You assess the quality of a data table against explicit criteria and propose granular, cell-level fixes.

Criteria to rate (1 = unusable … 5 = analysis-ready):
${criteriaRubrics.map((rubric) => `- ${rubric}`).join('\n')}

Rules:
- You receive deterministic column statistics computed over the FULL table — treat them as ground truth; never re-count from the sample rows.
- Each fix targets ONE cell ('cell') or removes ONE redundant row ('deleteRow').
- Echo the row's ${ROW_ID_KEY} EXACTLY as printed in the table data.
- 'before' must reproduce the printed cell value EXACTLY ('' for empty cells).
- Only propose a fix when the correction is defensible from the data itself; rate the criterion without an edit when it isn't.
- Never invent values. Propose at most 40 fixes, most important first.
- Summaries and reasons are short, plain language.`;
}

export function buildDataAssessmentUserPrompt(options: {
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  stats: ColumnProfile[];
  totalRowCount: number;
  sampled: boolean;
}): string {
  const { columns, rows, stats, totalRowCount, sampled } = options;
  return `Table columns:
${describeColumns(columns)}

Column statistics (computed exactly over all ${totalRowCount} rows):
${buildStatsBlock(columns, stats)}

Table data (tab-separated; first column is ${ROW_ID_KEY})${
    sampled
      ? ` — a deterministic sample of ${rows.length} of the ${totalRowCount} rows. Rate using the statistics above; only propose fixes for rows shown here`
      : ''
  }:
${serializeTableWithRids(columns, rows)}`;
}

export function buildExtractionSystemPrompt(): string {
  return `You extract structured rows from unstructured material into a fixed table schema.

Rules:
- Extract every row the material supports; do NOT invent values.
- Leave a field null when the material doesn't state it.
- Normalize numbers to plain numbers and dates to ISO 8601 (YYYY-MM-DD).
- Never summarize or aggregate unless a row in the material is itself an aggregate.`;
}

export function buildExtractionUserPrompt(
  sourceText: string,
  columns: DataColumn[],
  instructions?: string,
): string {
  return `Target table columns:
${describeColumns(columns)}
${buildRequiredFieldsGuidance(columns)}${instructions ? `\nAdditional guidance: ${instructions}\n` : ''}
Material:
"""
${sourceText}
"""`;
}

/* ------------------------------------------------------------------ */
/* Photo extraction (vision)                                           */
/* ------------------------------------------------------------------ */

export function buildPhotoInferSystemPrompt(): string {
  return `You read photographed documents (paper forms, tables, lists, whiteboards) and transcribe them into structured data.

Rules:
- First decide the shape: ONE filled form without repeated groups → kind "record" (each photo is one record); a table or repeated similar entries → kind "table" (each entry is one row).
- Propose one column per form field / table column, with a sensible type; mark a column required only when the form marks it mandatory or it is clearly essential.
- When several photos show the same kind of form, produce ONE unified column set and one record per photo.
- Transcribe EXACTLY what is written — never guess. Illegible or empty fields are "" and worth a mention in notes.
- Normalize: numbers plain (no thousands separators), dates ISO 8601 (YYYY-MM-DD), booleans "true"/"false".
- Cell values are strings in column order.
- notes: short caveats (illegible areas, cropped edges, uncertain readings); "" when none.`;
}

export function buildPhotoInferUserPrompt(instructions?: string): string {
  return `Transcribe the attached photo(s) into structured data.${
    instructions ? `\n\nAdditional guidance: ${instructions}` : ''
  }`;
}

export function buildPhotoExtractSystemPrompt(): string {
  return `You extract structured rows from photographed documents (paper forms, tables, lists) into a FIXED table schema.

Rules:
- Extract every row/record the photo(s) support; do NOT invent values.
- A field the photo doesn't state (or that is illegible) is null — never guess.
- Transcribe exactly what is written; normalize numbers to plain numbers, dates to ISO 8601 (YYYY-MM-DD).
- Never summarize or aggregate unless an entry in the photo is itself an aggregate.`;
}

export function buildPhotoExtractUserPrompt(
  columns: DataColumn[],
  instructions?: string,
): string {
  return `Target table columns:
${describeColumns(columns)}
${buildRequiredFieldsGuidance(columns)}${
    instructions ? `\nAdditional guidance: ${instructions}\n` : ''
  }
Extract the rows from the attached photo(s).`;
}

export function buildTransformSystemPrompt(scoped = false): string {
  return `You transform data tables. You receive a table (columns + rows) and an instruction, and return the FULL output table.

Rules:
- Return every output row, not a sample.
- Keep column ids stable for unchanged columns; new columns get short snake_case ids.
- Cell values are returned as strings in column order ("" for empty); numbers plain (no thousands separators), dates ISO 8601, booleans "true"/"false".
- Do not fabricate data: derived values must follow from the input rows.
- The explanation is one sentence, plain language.${
    scoped
      ? `

SCOPED MODE: the rows you received are a SUBSET of a larger table.
- Return exactly the same number of rows, in the same order.
- You may change cell values and ADD new columns.
- Never add, remove, or reorder rows; never remove or reorder existing columns.
- If the instruction requires adding/removing rows (deduplication, aggregation, …), return the rows unchanged and say in the explanation that this needs the full-table scope.`
      : ''
  }`;
}

export function buildTransformUserPrompt(
  columns: DataColumn[],
  rows: Record<string, unknown>[],
  instruction: string,
): string {
  const header = columns.map((c) => c.id).join('\t');
  const body = rows
    .map((row) =>
      columns
        .map((c) => {
          const v = row[c.id];
          return v === null || v === undefined ? '' : String(v);
        })
        .join('\t'),
    )
    .join('\n');

  return `Table columns:
${describeColumns(columns)}

Table data (tab-separated, first line is column ids):
${header}
${body}

Instruction: ${instruction}`;
}
