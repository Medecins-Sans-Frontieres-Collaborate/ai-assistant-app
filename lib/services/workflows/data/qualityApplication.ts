import { DataColumn, DataQualityEdit } from '@/types/workflow';

import { coerceCell, formatCell, getRowId } from './tableUtils';

/**
 * Applying data-quality fixes — the cell counterpart to the text
 * workflows' substring machinery. An edit anchors by stable row id and
 * applies only while the cell still holds the value it was proposed
 * against (the canonical formatCell rendering); anything else degrades
 * to 'unapplicable' instead of corrupting data. Pure and client-safe.
 */

export interface ApplyEditResult {
  rows: Record<string, unknown>[];
  applied: boolean;
}

export function applyCellEdit(
  rows: Record<string, unknown>[],
  columns: DataColumn[],
  edit: DataQualityEdit,
): ApplyEditResult {
  const column = columns.find((c) => c.id === edit.columnId);
  const index = rows.findIndex((row) => getRowId(row) === edit.rid);
  if (!column || index === -1) return { rows, applied: false };

  const current = rows[index][column.id];
  if (formatCell(current) !== edit.before) {
    // The cell changed since assessment — the fix no longer applies.
    return { rows, applied: false };
  }

  const nextValue =
    edit.after === '' ? null : coerceCell(edit.after, column.type);
  const next = [...rows];
  next[index] = { ...next[index], [column.id]: nextValue };
  return { rows: next, applied: true };
}

export function applyDeleteRow(
  rows: Record<string, unknown>[],
  edit: DataQualityEdit,
): ApplyEditResult {
  const index = rows.findIndex((row) => getRowId(row) === edit.rid);
  if (index === -1) return { rows, applied: false };
  return { rows: rows.filter((_, i) => i !== index), applied: true };
}

/** Routes an accepted edit to its apply function. */
export function applyQualityEdit(
  rows: Record<string, unknown>[],
  columns: DataColumn[],
  edit: DataQualityEdit,
): ApplyEditResult {
  return edit.kind === 'deleteRow'
    ? applyDeleteRow(rows, edit)
    : applyCellEdit(rows, columns, edit);
}
