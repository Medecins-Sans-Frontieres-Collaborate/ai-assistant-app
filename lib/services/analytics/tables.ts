/**
 * The tabular form every delivered file is read into — for validation, for
 * the stored preview, and for exports. Pure and client-importable.
 *
 * A sheet is either a TABLE (one header row, then records) or a FREEFORM page
 * (title blocks, stacked sub-tables) that is kept as the grid of cells it is.
 */
import { classifyColumn } from '@/lib/services/analytics/fields';

export type Cell = string | number | boolean | null;

/** What a column holds, judged from its values. Only `text` is classified. */
export type ColumnKind = 'text' | 'number' | 'date' | 'boolean' | 'empty';

export interface TableColumn {
  name: string;
  kind: ColumnKind;
}

export interface DerivedTable {
  /** Sheet name; `data` for a CSV or parquet file. */
  name: string;
  layout: 'table' | 'freeform';
  columns: TableColumn[];
  /** At most the row cap the table was read with. */
  rows: Cell[][];
  /** Rows in the delivered file (header excluded), which may exceed `rows`. */
  rowCount: number;
  truncated: boolean;
  /**
   * Holds one row per person (it has a user-code column). Row-level tables
   * need `download` access; everything else is an aggregate and is shown at
   * `view` level. Judged on the table AS DELIVERED, so hiding the user-code
   * field does not turn a per-person table into an aggregate.
   */
  rowLevel: boolean;
  /** Field ids a report type declares for a freeform page. */
  declaredFields: string[];
}

/** Rows kept per table in the stored preview. */
export const PREVIEW_ROWS = 5000;
/** Rows searched for a header before a sheet is given up as freeform. */
export const HEADER_SEARCH_ROWS = 30;

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+\-Z]*)?$/;
const BOOLEAN_LIKE = /^(?:true|false|yes|no)$/i;

export function isNumericLike(value: string): boolean {
  return NUMERIC.test(value.trim());
}

export function isDateLike(value: string): boolean {
  return DATE_LIKE.test(value.trim());
}

function readsAsText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return (
    !NUMERIC.test(trimmed) &&
    !DATE_LIKE.test(trimmed) &&
    !BOOLEAN_LIKE.test(trimmed)
  );
}

/** A cell that reads as words rather than as a number, date or flag. */
export function isTextValue(value: unknown): value is string {
  return readsAsText(value);
}

export function columnLetter(index: number): string {
  let letters = '';
  let n = index;
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

/**
 * The header row of a table sheet: the first row with at least two cells, all
 * of them labels. Title and description rows above a table have one cell, so
 * they are skipped. A one-column sheet takes its first non-empty cell.
 */
export function findHeaderRow(rows: readonly unknown[][]): number {
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].filter((cell) => !isBlank(cell));
    if (cells.length >= 2 && cells.every(isTextValue)) return i;
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width <= 1) {
    for (let i = 0; i < limit; i++) {
      if (isTextValue(rows[i][0])) return i;
    }
  }
  return -1;
}

export function kindOfColumn(values: readonly Cell[]): ColumnKind {
  let seen = false;
  let allDates = true;
  let allBooleans = true;
  for (const value of values) {
    if (isBlank(value)) continue;
    seen = true;
    // Not the type guard: a string that is NOT text (a date, a number) must
    // stay a string for the checks below.
    if (readsAsText(value)) return 'text';
    if (!(typeof value === 'string' && isDateLike(value))) allDates = false;
    if (
      !(
        typeof value === 'boolean' ||
        (typeof value === 'string' && BOOLEAN_LIKE.test(value.trim()))
      )
    ) {
      allBooleans = false;
    }
  }
  if (!seen) return 'empty';
  if (allDates) return 'date';
  if (allBooleans) return 'boolean';
  return 'number';
}

/** Header names made unique and non-empty, in order. */
function columnNames(header: readonly Cell[], width: number): string[] {
  const used = new Map<string, number>();
  const names: string[] = [];
  for (let column = 0; column < width; column++) {
    const raw = header[column];
    const base =
      typeof raw === 'string' && raw.trim() !== ''
        ? raw.trim().slice(0, 200)
        : isBlank(raw)
          ? `Column ${columnLetter(column)}`
          : String(raw).slice(0, 200);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    names.push(count === 1 ? base : `${base} (${count})`);
  }
  return names;
}

function padRow(row: readonly Cell[], width: number): Cell[] {
  const padded: Cell[] = new Array<Cell>(width).fill(null);
  for (let i = 0; i < Math.min(row.length, width); i++) {
    padded[i] = row[i] ?? null;
  }
  return padded;
}

export interface GridInput {
  name: string;
  /** Every row read from the source, header and title rows included. */
  grid: Cell[][];
  /** Rows the source holds in all (the grid may be a capped read). */
  sourceRows: number;
  /** Declared a laid-out page by the report type. */
  freeform: boolean;
  declaredFields: readonly string[];
  /** Cap on body rows kept. */
  maxRows: number;
  /**
   * Column names known from the file's schema (parquet). The grid is then
   * body rows only and no header is searched for.
   */
  header?: readonly string[];
}

/** Turns one sheet's grid into a table, or keeps it as a freeform page. */
export function gridToTable(input: GridInput): DerivedTable {
  const { name, grid, sourceRows, maxRows } = input;
  const headerIndex = input.header || input.freeform ? -1 : findHeaderRow(grid);

  if (headerIndex < 0 && !input.header) {
    const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
    const rows = grid.slice(0, maxRows).map((row) => padRow(row, width));
    return {
      name,
      layout: 'freeform',
      columns: Array.from({ length: width }, (_, column) => ({
        name: columnLetter(column),
        kind: kindOfColumn(rows.map((row) => row[column])),
      })),
      rows,
      rowCount: Math.max(sourceRows, rows.length),
      truncated: sourceRows > rows.length,
      rowLevel: false,
      // A page nobody declared could hold anything: it is filed under the
      // catch-all field, so hiding `other` hides it and nothing else does.
      declaredFields: input.freeform ? [...input.declaredFields] : ['other'],
    };
  }

  const header: readonly Cell[] = input.header ?? grid[headerIndex];
  const body = grid.slice(headerIndex + 1, headerIndex + 1 + maxRows);
  // reduce, not Math.max(...spread): an export reads every row of a sheet.
  const width = body.reduce(
    (max, row) => Math.max(max, row.length),
    header.length,
  );
  const names = columnNames(header, width);
  const rows = body.map((row) => padRow(row, width));
  const columns = names.map((columnName, column) => ({
    name: columnName,
    kind: kindOfColumn(rows.map((row) => row[column])),
  }));
  const rowCount = Math.max(sourceRows - (headerIndex + 1), rows.length);
  return {
    name,
    layout: 'table',
    columns,
    rows,
    rowCount,
    truncated: rowCount > rows.length,
    rowLevel: columns.some(
      (column) =>
        column.kind === 'text' &&
        classifyColumn(column.name, null) === 'userCode',
    ),
    declaredFields: [],
  };
}
