import { DataColumn, DataColumnType } from '@/types/workflow';

import { MAX_COLUMNS, coerceCell, formatCell, toColumnId } from './tableUtils';

/**
 * Pure application of a schema-editor draft to the table. Semantics:
 * kept columns are matched by id (rename = name only, id stable);
 * retyped columns re-coerce every cell (non-conforming → null, counted);
 * new columns are null-filled; deleted columns drop their cells. Rows
 * keep their rids untouched.
 */

export interface SchemaDraftColumn {
  /** Existing column id, or undefined for a newly added column. */
  id?: string;
  name: string;
  type: DataColumnType;
  required: boolean;
}

export interface SchemaChangeResult {
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  /** Cells with a value that could not be converted to the new type. */
  converted: number;
}

export function applySchemaChanges(
  columns: DataColumn[],
  rows: Record<string, unknown>[],
  draft: SchemaDraftColumn[],
): SchemaChangeResult {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const usedIds = new Set<string>();
  const nextColumns: DataColumn[] = [];
  /** Existing columns whose type changed → re-coerce. */
  const retyped: DataColumn[] = [];

  for (const [index, entry] of draft.slice(0, MAX_COLUMNS).entries()) {
    const name = entry.name.trim() || `Column ${index + 1}`;
    let id = entry.id;
    if (!id || !byId.has(id)) {
      // New column: slug from the name, avoiding every id in play.
      const base = toColumnId(name, index);
      id = base;
      let suffix = 2;
      while (usedIds.has(id) || byId.has(id)) id = `${base}_${suffix++}`;
    }
    usedIds.add(id);
    const column: DataColumn = {
      id,
      name,
      type: entry.type,
      ...(entry.required ? { required: true } : {}),
    };
    nextColumns.push(column);
    const existing = byId.get(id);
    if (existing && existing.type !== entry.type) retyped.push(column);
  }

  const deletedIds = columns.map((c) => c.id).filter((id) => !usedIds.has(id));

  let converted = 0;
  const needsRowPass = retyped.length > 0 || deletedIds.length > 0;
  const nextRows = needsRowPass
    ? rows.map((row) => {
        const out = { ...row };
        for (const id of deletedIds) delete out[id];
        for (const column of retyped) {
          const current = out[column.id];
          if (current === null || current === undefined) continue;
          const coerced = coerceCell(formatCell(current), column.type);
          if (coerced === null) converted += 1;
          out[column.id] = coerced;
        }
        return out;
      })
    : rows;

  return { columns: nextColumns, rows: nextRows, converted };
}
