import { DataColumn, DataColumnType } from '@/types/workflow';

/**
 * Client-safe table helpers: column-id generation, type inference from raw
 * imported values, and cell coercion. No server imports.
 */

export const MAX_ROWS = 5_000;
export const MAX_COLUMNS = 60;
/** Quality assessment reads at most this many rows (stride-sampled). */
export const MAX_ASSESS_ROWS = 300;

/**
 * Reserved row-identity key. Safe from collisions: toColumnId strips
 * leading underscores, so no imported header can produce this id. Rows
 * carry their id inline so it survives sort/filter/delete for free; all
 * prompt/export paths iterate `columns`, so it never leaks.
 */
export const ROW_ID_KEY = '__rid';

export function getRowId(row: Record<string, unknown>): string | undefined {
  const value = row[ROW_ID_KEY];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Assigns base36 ids (from a monotonic counter) to rows lacking one;
 * rows that already have an id keep it. Returns the advanced counter.
 */
export function withRowIds(
  rows: Record<string, unknown>[],
  nextRowId: number,
): { rows: Record<string, unknown>[]; nextRowId: number } {
  let counter = nextRowId;
  let changed = false;
  const out = rows.map((row) => {
    if (getRowId(row)) return row;
    changed = true;
    return { ...row, [ROW_ID_KEY]: (counter++).toString(36) };
  });
  return { rows: changed ? out : rows, nextRowId: counter };
}

/** Derives a safe counter from existing rids (max parsed base36 + 1). */
export function deriveNextRowId(rows: Record<string, unknown>[]): number {
  let max = 0;
  for (const row of rows) {
    const rid = getRowId(row);
    if (!rid) continue;
    const parsed = parseInt(rid, 36);
    if (Number.isFinite(parsed) && parsed >= max) max = parsed + 1;
  }
  return max;
}

/** Strips the reserved id key (export/prompt hygiene where needed). */
export function stripRowIds(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    if (!(ROW_ID_KEY in row)) return row;
    const { [ROW_ID_KEY]: _rid, ...rest } = row;
    return rest;
  });
}

/**
 * Deterministic stride sample (no RNG — reproducible): the head in full,
 * then evenly-spaced rows from the rest. Returns the input array when it
 * already fits.
 */
export function strideSample<T>(items: T[], max: number, head = 100): T[] {
  if (items.length <= max) return items;
  const headCount = Math.min(head, max);
  const sampled = items.slice(0, headCount);
  const rest = items.length - headCount;
  const take = max - headCount;
  if (take > 0) {
    const stride = rest / take;
    for (let i = 0; i < take; i++) {
      sampled.push(items[headCount + Math.floor(i * stride)]);
    }
  }
  return sampled;
}

/**
 * Canonical cell stringifier — the grid display, LLM prompts, apply-time
 * `before` comparisons, and the rail digest must all agree on it, or
 * quality fixes become unapplicable over formatting mismatches.
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Stable, prompt-friendly column id from a header name. */
export function toColumnId(name: string, index: number): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || `col_${index + 1}`;
}

const DATE_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$|^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/;
const BOOL_VALUES = new Set(['true', 'false', 'yes', 'no', 'y', 'n']);

function inferValueType(value: unknown): DataColumnType | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  const s = String(value).trim();
  if (!s) return null;
  if (BOOL_VALUES.has(s.toLowerCase())) return 'boolean';
  if (DATE_RE.test(s)) return 'date';
  if (!Number.isNaN(Number(s.replace(/,/g, '')))) return 'number';
  return 'text';
}

/** Majority-vote type inference over a sample of column values. */
export function inferColumnType(values: unknown[]): DataColumnType {
  const counts: Record<DataColumnType, number> = {
    text: 0,
    number: 0,
    date: 0,
    boolean: 0,
  };
  let seen = 0;
  for (const value of values.slice(0, 200)) {
    const type = inferValueType(value);
    if (!type) continue;
    counts[type] += 1;
    seen += 1;
  }
  if (seen === 0) return 'text';
  // Text wins whenever present: mixed columns are text.
  if (counts.text > 0) return 'text';
  const best = (Object.keys(counts) as DataColumnType[]).reduce((a, b) =>
    counts[b] > counts[a] ? b : a,
  );
  return best;
}

/** Coerces a raw imported cell to the column's declared type. */
export function coerceCell(value: unknown, type: DataColumnType): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'number': {
      const n =
        typeof value === 'number'
          ? value
          : Number(String(value).replace(/,/g, ''));
      return Number.isNaN(n) ? null : n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (['true', 'yes', 'y'].includes(s)) return true;
      if (['false', 'no', 'n'].includes(s)) return false;
      return null;
    }
    default:
      return String(value);
  }
}

/**
 * Builds columns + rows from parsed tabular data (papaparse output or a
 * JSON array of objects). Applies row/column caps; throws when the row cap
 * is exceeded so the caller can message it.
 */
export function buildTable(
  headers: string[],
  rawRows: Record<string, unknown>[],
): { columns: DataColumn[]; rows: Record<string, unknown>[] } {
  if (rawRows.length > MAX_ROWS) {
    throw new Error(`ROW_CAP_EXCEEDED:${rawRows.length}`);
  }
  const limitedHeaders = headers.slice(0, MAX_COLUMNS);

  const columns: DataColumn[] = limitedHeaders.map((header, index) => {
    const id = toColumnId(header, index);
    const sample = rawRows.map((row) => row[header]);
    return {
      id,
      name: header.trim() || `Column ${index + 1}`,
      type: inferColumnType(sample),
    };
  });

  // Guard against duplicate ids after slugging (e.g. "Date" and "date").
  const seen = new Map<string, number>();
  for (const column of columns) {
    const count = seen.get(column.id) ?? 0;
    if (count > 0) column.id = `${column.id}_${count + 1}`;
    seen.set(column.id, count + 1);
  }

  const rows = rawRows.map((raw) => {
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      row[column.id] = coerceCell(raw[limitedHeaders[index]], column.type);
    });
    return row;
  });

  return { columns, rows };
}

/** Normalizes a parsed JSON payload into array-of-objects form. */
export function jsonToRawRows(parsed: unknown): Record<string, unknown>[] {
  const array = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? // Accept { data: [...] } / single-key wrappers
        Object.values(parsed as Record<string, unknown>).find(Array.isArray)
      : null;
  if (!Array.isArray(array)) {
    throw new Error('JSON must contain an array of objects');
  }
  return array.map((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : { value: item },
  );
}

/** Union of keys across rows, preserving first-seen order. */
export function collectHeaders(rows: Record<string, unknown>[]): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}
