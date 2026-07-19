import { DataColumn } from '@/types/workflow';

import {
  MAX_COLUMNS,
  buildTable,
  formatCell,
  inferValueType,
} from './tableUtils';

type Rows = Record<string, unknown>[];

/**
 * Attribute-matrix detection and transposition. Comparison matrices
 * (features as rows, items as columns — "datatypes live on the row")
 * are a common import shape, especially from photos of slides and
 * docs. They defeat per-column typing: every data column mixes
 * numbers, booleans and text, so everything degrades to text.
 * Transposing turns items into rows and each attribute into a column
 * that types cleanly.
 */

const MIN_UNIFORM_ROWS = 3;
const MIN_UNIFORM_ROW_SHARE = 0.3;
const MIN_AXIS_DISTINCT_SHARE = 0.9;

/**
 * True when the table reads as an attribute matrix: a distinct text
 * label column followed by ≥2 text columns whose cells are typed
 * consistently across each ROW (a boolean row, a number row, …) while
 * the columns themselves are mixed. Conservative on purpose — a clean
 * text table (columns type consistently) or an already-typed table
 * (data columns aren't text) never matches.
 */
export function detectAttributeMatrix(
  columns: DataColumn[],
  rows: Rows,
): boolean {
  if (columns.length < 3 || rows.length < MIN_UNIFORM_ROWS) return false;
  // The transposed table must fit the column cap (axis + one per row).
  if (rows.length + 1 > MAX_COLUMNS) return false;
  const [axis, ...data] = columns;
  if (axis.type !== 'text' || data.some((c) => c.type !== 'text')) return false;

  // The first column must work as a header row: non-empty, distinct labels.
  const labels = rows.map((row) => formatCell(row[axis.id]).trim());
  if (labels.some((label) => !label)) return false;
  const distinct = new Set(labels.map((label) => label.toLowerCase()));
  if (distinct.size / rows.length < MIN_AXIS_DISTINCT_SHARE) return false;

  // Rows whose cells agree on one non-text type carry the signal.
  let uniformRows = 0;
  for (const row of rows) {
    const types = data
      .map((column) => inferValueType(row[column.id]))
      .filter((type) => type !== null);
    if (types.length < 2) continue;
    if (types[0] !== 'text' && types.every((type) => type === types[0])) {
      uniformRows += 1;
    }
  }
  if (
    uniformRows < MIN_UNIFORM_ROWS ||
    uniformRows / rows.length < MIN_UNIFORM_ROW_SHARE
  ) {
    return false;
  }

  // Most data columns must be genuinely mixed-type; uniform-text
  // columns mean an ordinary table that happens to hold text.
  const mixedColumns = data.filter((column) => {
    const types = new Set(
      rows.map((row) => inferValueType(row[column.id])).filter(Boolean),
    );
    return types.size >= 2;
  });
  return mixedColumns.length >= Math.ceil(data.length / 2);
}

/**
 * Flips an attribute matrix: first-column labels become headers, data
 * columns become rows under `axisHeader`. Rebuilt via buildTable so the
 * new columns get inferred types and coerced cells. Row ids never leak
 * through (values are read per data column); the caller assigns fresh
 * rids on apply.
 */
export function transposeTable(
  columns: DataColumn[],
  rows: Rows,
  axisHeader: string,
): { columns: DataColumn[]; rows: Rows } {
  const [axis, ...data] = columns;
  // Dedup labels case-insensitively — duplicate keys would silently
  // collapse cells in the raw row records below.
  const seen = new Map<string, number>();
  const headers = [
    axisHeader,
    ...rows.map((row) => formatCell(row[axis.id]).trim()),
  ].map((header) => {
    const key = header.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? header : `${header} (${count + 1})`;
  });
  const rawRows = data.map((column) => {
    const raw: Record<string, unknown> = { [headers[0]]: column.name };
    rows.forEach((row, i) => {
      raw[headers[i + 1]] = row[column.id];
    });
    return raw;
  });
  return buildTable(headers, rawRows);
}
