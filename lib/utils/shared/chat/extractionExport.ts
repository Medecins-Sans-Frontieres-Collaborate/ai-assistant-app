import { ExtractionDataset } from '@/types/chat';

/**
 * Pure functions that turn an `ExtractionDataset` into a downloadable
 * payload (JSON / CSV / TSV). No DOM. Used by `ExtractionResultRenderer`
 * via the existing `downloadFile()` helper.
 */

export type ExtractionFormat = 'json' | 'csv' | 'tsv';

export interface ExtractionExport {
  content: string;
  mimeType: string;
  filename: string;
}

const EXTENSIONS: Record<ExtractionFormat, string> = {
  json: 'json',
  csv: 'csv',
  tsv: 'tsv',
};

const MIME_TYPES: Record<ExtractionFormat, string> = {
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  tsv: 'text/tab-separated-values;charset=utf-8',
};

export function extensionFor(format: ExtractionFormat): string {
  return EXTENSIONS[format];
}

export function mimeTypeFor(format: ExtractionFormat): string {
  return MIME_TYPES[format];
}

/**
 * Slugifies a recipe name into a filesystem-safe filename stem.
 * Falls back to "extraction" for empty/whitespace names.
 */
export function filenameStemFor(dataset: ExtractionDataset): string {
  const slug = dataset.recipeName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'extraction';
}

/**
 * Renders the dataset as a JSON array of row objects. Pretty-printed
 * (2-space indent) so the file is human-readable when opened in a text
 * editor.
 */
export function datasetToJson(dataset: ExtractionDataset): string {
  return JSON.stringify(dataset.rows, null, 2);
}

/**
 * Renders the dataset as CSV (comma-separated). Header row uses field
 * labels when present, otherwise field names. List fields are joined
 * with `; ` so single-line cells stay parseable.
 */
export function datasetToCsv(dataset: ExtractionDataset): string {
  return renderDelimited(dataset, ',');
}

/**
 * Renders the dataset as TSV (tab-separated). Same rules as CSV but
 * delimiter is a literal tab. Tabs inside cell values are replaced
 * with a single space — TSV has no canonical quoting story, so
 * removing the delimiter from cell content is the safest answer.
 */
export function datasetToTsv(dataset: ExtractionDataset): string {
  return renderDelimited(dataset, '\t');
}

/**
 * One-shot helper used by the renderer: maps a format to the full
 * export (content + mime + filename).
 */
export function exportDataset(
  dataset: ExtractionDataset,
  format: ExtractionFormat,
): ExtractionExport {
  const stem = filenameStemFor(dataset);
  const filename = `${stem}.${extensionFor(format)}`;
  const mimeType = mimeTypeFor(format);
  const content =
    format === 'json'
      ? datasetToJson(dataset)
      : format === 'csv'
        ? datasetToCsv(dataset)
        : datasetToTsv(dataset);
  return { content, mimeType, filename };
}

function renderDelimited(
  dataset: ExtractionDataset,
  delimiter: ',' | '\t',
): string {
  const fields = dataset.fields;
  const headerCells = fields.map((f) =>
    escapeCell(f.label ?? f.name, delimiter),
  );
  const lines: string[] = [headerCells.join(delimiter)];
  for (const row of dataset.rows) {
    const cells = fields.map((f) =>
      escapeCell(formatCellValue(row[f.name]), delimiter),
    );
    lines.push(cells.join(delimiter));
  }
  return lines.join('\n');
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        v === null || v === undefined
          ? ''
          : typeof v === 'object'
            ? JSON.stringify(v)
            : String(v),
      )
      .join('; ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function escapeCell(raw: string, delimiter: ',' | '\t'): string {
  if (delimiter === '\t') {
    // TSV has no canonical quoting — strip tabs and newlines from cell
    // content. Carriage returns get folded to spaces too.
    return raw.replace(/[\t\r\n]+/g, ' ');
  }
  // CSV: RFC 4180 quoting. Quote whenever the cell contains a comma,
  // a double-quote, or a line break; doubled-quotes inside become "".
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}
