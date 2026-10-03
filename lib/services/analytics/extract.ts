/**
 * Reads a delivered file into tables (see tables.ts). Server-only.
 *
 * One reader for three jobs, differing only in how many rows they ask for:
 *  - validation and the stored preview read the first PREVIEW_ROWS rows of
 *    each sheet — ~0.6 s and ~40 MB for the largest example workbook;
 *  - an export reads everything, one sheet at a time when it can — ~2 s and
 *    ~500 MB resident for that same workbook, which is why exports run one
 *    at a time (heavyWork.ts).
 */
import {
  Cell,
  DerivedTable,
  HEADER_SEARCH_ROWS,
  gridToTable,
  isNumericLike,
} from '@/lib/services/analytics/tables';

import { parquetMetadata, parquetReadObjects, parquetSchema } from 'hyparquet';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

/** Formats the app can open. */
export const READABLE_EXTENSIONS = ['xlsx', 'csv', 'parquet'] as const;
export type ReadableExtension = (typeof READABLE_EXTENSIONS)[number];

export function isReadableExtension(
  extension: string,
): extension is ReadableExtension {
  return (READABLE_EXTENSIONS as readonly string[]).includes(extension);
}

export interface ExtractOptions {
  /** Body rows kept per table. `Infinity` reads everything. */
  maxRows: number;
  /** Sheets the report type declares as laid-out pages → their fields. */
  freeformSheets?: Readonly<Record<string, readonly string[]>>;
  /** Read only these sheets (xlsx). Others are not parsed at all. */
  onlySheets?: readonly string[];
}

function isMidnightUtc(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

/** Anything a reader hands back → a plain, JSON-safe cell. */
export function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString();
    return isMidnightUtc(value) ? iso.slice(0, 10) : iso;
  }
  if (value instanceof Uint8Array) return '[binary]';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractXlsx(buffer: Buffer, options: ExtractOptions): DerivedTable[] {
  const limited = Number.isFinite(options.maxRows);
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    dense: true,
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    cellText: false,
    ...(limited ? { sheetRows: options.maxRows + HEADER_SEARCH_ROWS } : {}),
    ...(options.onlySheets ? { sheets: [...options.onlySheets] } : {}),
  });
  const wanted = options.onlySheets ? new Set(options.onlySheets) : null;
  const tables: DerivedTable[] = [];
  for (const name of workbook.SheetNames) {
    if (wanted && !wanted.has(name)) continue;
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: true,
      // Without this, date cells are shifted by the SERVER's UTC offset: a
      // report dated 1 July reads as 30 June on a replica east of Greenwich.
      UTC: true,
    });
    const grid = raw.map((row) => row.map(toCell));
    // `!fullref` is the sheet's real extent when the read was row-limited.
    const reference = (sheet['!fullref'] ?? sheet['!ref']) as
      | string
      | undefined;
    const sourceRows = reference
      ? XLSX.utils.decode_range(reference).e.r + 1
      : grid.length;
    const declared = options.freeformSheets?.[name];
    tables.push(
      gridToTable({
        name,
        grid,
        sourceRows,
        freeform: declared !== undefined,
        declaredFields: declared ?? [],
        maxRows: options.maxRows,
      }),
    );
  }
  return tables;
}

/** CSV cells arrive as text; give numbers and flags their type back. */
function csvCell(value: string): Cell {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (isNumericLike(trimmed) && !trimmed.endsWith('%')) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (/^(?:true|false)$/i.test(trimmed))
    return trimmed.toLowerCase() === 'true';
  return value;
}

function extractCsv(buffer: Buffer, options: ExtractOptions): DerivedTable[] {
  const parsed = Papa.parse<string[]>(buffer.toString('utf8'), {
    header: false,
    skipEmptyLines: true,
  });
  // A CSV's first row IS its header — no detection, so a label that happens
  // to look like a number ("2026") is still a column name.
  const [header = [], ...body] = parsed.data;
  const kept = Number.isFinite(options.maxRows)
    ? body.slice(0, options.maxRows)
    : body;
  return [
    gridToTable({
      name: 'data',
      grid: kept.map((row) => row.map(csvCell)),
      sourceRows: body.length,
      freeform: false,
      declaredFields: [],
      maxRows: options.maxRows,
      header,
    }),
  ];
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

export interface ParquetShape {
  rowCount: number;
  columns: string[];
  /** Columns whose physical type can hold text. */
  stringColumns: string[];
}

export function parquetShape(buffer: Buffer): ParquetShape {
  const metadata = parquetMetadata(toArrayBuffer(buffer));
  const children = parquetSchema(metadata).children;
  return {
    rowCount: Number(metadata.num_rows),
    columns: children.map((child) => child.element.name),
    stringColumns: children
      .filter((child) => child.element.type === 'BYTE_ARRAY')
      .map((child) => child.element.name),
  };
}

/** Reads the named columns of every row, or of rows [0, rowEnd). */
export async function readParquetColumns(
  buffer: Buffer,
  columns: readonly string[],
  rowEnd?: number,
): Promise<Record<string, unknown>[]> {
  if (columns.length === 0) return [];
  return parquetReadObjects({
    file: toArrayBuffer(buffer),
    columns: [...columns],
    ...(rowEnd !== undefined ? { rowStart: 0, rowEnd } : {}),
  });
}

async function extractParquet(
  buffer: Buffer,
  options: ExtractOptions,
): Promise<DerivedTable[]> {
  const shape = parquetShape(buffer);
  const rowEnd = Number.isFinite(options.maxRows)
    ? Math.min(shape.rowCount, options.maxRows)
    : shape.rowCount;
  const objects =
    rowEnd > 0 ? await readParquetColumns(buffer, shape.columns, rowEnd) : [];
  return [
    gridToTable({
      name: 'data',
      grid: objects.map((row) =>
        shape.columns.map((name) => toCell(row[name])),
      ),
      sourceRows: shape.rowCount,
      freeform: false,
      declaredFields: [],
      maxRows: options.maxRows,
      header: shape.columns,
    }),
  ];
}

/**
 * @throws when the bytes are not a readable file of that format.
 */
export async function extractTables(
  buffer: Buffer,
  extension: ReadableExtension,
  options: ExtractOptions,
): Promise<DerivedTable[]> {
  switch (extension) {
    case 'xlsx':
      return extractXlsx(buffer, options);
    case 'csv':
      return extractCsv(buffer, options);
    case 'parquet':
      return extractParquet(buffer, options);
  }
}
