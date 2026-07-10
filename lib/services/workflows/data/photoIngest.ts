import { DataColumn, DataColumnType } from '@/types/workflow';

import { MAX_COLUMNS, MAX_ROWS, coerceCell, toColumnId } from './tableUtils';

/**
 * Turns a photo-inference response (proposed columns + values-array
 * rows) into table shape: slugged unique column ids, per-type cell
 * coercion, ''→null. Pure and client-safe — the same contract as
 * buildTable, but for a model-proposed structure.
 */

export interface PhotoInferResult {
  kind: 'record' | 'table';
  columns: Array<{ name: string; type: DataColumnType; required: boolean }>;
  rows: Array<{ values: string[] }>;
  notes: string;
}

export function photoInferToTable(result: PhotoInferResult): {
  columns: DataColumn[];
  rows: Record<string, unknown>[];
} {
  const columns: DataColumn[] = result.columns
    .slice(0, MAX_COLUMNS)
    .map((column, index) => ({
      id: toColumnId(column.name, index),
      name: column.name.trim() || `Column ${index + 1}`,
      type: column.type,
      ...(column.required ? { required: true } : {}),
    }));

  // Duplicate-id guard after slugging (same as buildTable).
  const seen = new Map<string, number>();
  for (const column of columns) {
    const count = seen.get(column.id) ?? 0;
    if (count > 0) column.id = `${column.id}_${count + 1}`;
    seen.set(column.id, count + 1);
  }

  const rows = result.rows.slice(0, MAX_ROWS).map((row) => {
    const out: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const raw = row.values[index] ?? '';
      out[column.id] = raw === '' ? null : coerceCell(raw, column.type);
    });
    return out;
  });

  return { columns, rows };
}
