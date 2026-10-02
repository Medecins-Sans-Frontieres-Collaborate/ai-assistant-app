/**
 * Builds the files the app generates from a delivered report: one table as
 * CSV, or every table a person may see as a workbook. Server-only.
 *
 * These are what a non-admin receives in place of the delivered file when it
 * contains a field the platform hides — the delivered file itself cannot be
 * edited in place. The tables arrive already filtered (previewModel.ts).
 */
import { TableView } from '@/lib/services/analytics/previewModel';
import { Cell, isNumericLike } from '@/lib/services/analytics/tables';

import Papa from 'papaparse';
import * as XLSX from 'xlsx';

/**
 * Largest workbook the app will generate, in cells. Writing 1.1 M cells costs
 * ~700 MB resident; this keeps a generated workbook to roughly half that.
 * Larger tables export as CSV, which has no such cost.
 */
export const MAX_XLSX_EXPORT_CELLS = 600_000;

export class ExportTooLargeError extends Error {
  constructor(readonly cells: number) {
    super('Too large to export as a workbook; export the tables as CSV');
    this.name = 'ExportTooLargeError';
  }
}

/**
 * A CSV cell that a spreadsheet would run as a formula is prefixed with an
 * apostrophe. Departments and job titles are free text typed into a
 * directory; "=cmd|…" is a value someone could put there. A plain negative
 * number is left alone.
 */
export function neutralizeCsvCell(value: Cell): Cell {
  if (typeof value !== 'string' || value === '') return value;
  if (!/^[=+\-@\t\r]/.test(value)) return value;
  if (isNumericLike(value)) return value;
  return `'${value}`;
}

/** UTF-8 with a BOM, so Excel opens accented text correctly. */
export function tableToCsv(table: TableView): Buffer {
  const csv = Papa.unparse(
    {
      fields: table.columns.map((column) =>
        String(neutralizeCsvCell(column.name)),
      ),
      data: table.rows.map((row) => row.map(neutralizeCsvCell)),
    },
    { newline: '\r\n' },
  );
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(csv, 'utf8'),
  ]);
}

/** Excel's limit on a sheet name, and the characters it refuses. */
function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Values only — no formulas, no formatting. Every string is written as a
 * string cell, so nothing in it is evaluated when the workbook is opened.
 */
export function tablesToXlsx(tables: readonly TableView[]): Buffer {
  const cells = tables.reduce(
    (total, table) =>
      total + (table.rows.length + 1) * Math.max(1, table.columns.length),
    0,
  );
  if (cells > MAX_XLSX_EXPORT_CELLS) throw new ExportTooLargeError(cells);

  const workbook = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const table of tables) {
    const grid: Cell[][] =
      table.layout === 'freeform'
        ? table.rows
        : [table.columns.map((column) => column.name), ...table.rows];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(grid, { dense: true }),
      sheetName(table.name, used),
    );
  }
  return XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  }) as Buffer;
}

/** `report.xlsx` + `Users` → `report_Users.csv`; no table → `report_export.xlsx`. */
export function exportFileName(
  originalName: string,
  format: 'csv' | 'xlsx',
  table?: string,
): string {
  const dot = originalName.lastIndexOf('.');
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const part = table
    ? table.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60)
    : 'export';
  return `${stem}_${part}.${format}`;
}
