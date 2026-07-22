import { DataColumn, DataColumnType } from '@/types/workflow';

import { rewriteFormulaRefs } from './derived';
import { detectColumnNumberFormat } from './numberFormat';
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
  /**
   * Derived-column formula in DISPLAY (name-ref) form, e.g.
   * "[Cases] / [Population]". Non-empty ⇒ the column is derived: type
   * is forced to number, required is ignored, and applySchemaChanges
   * converts refs to canonical column ids for storage.
   */
  formula?: string;
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
  /** Formula conversion is deferred until every draft id is assigned. */
  const pendingFormulas: Array<{ column: DataColumn; display: string }> = [];
  /** Existing raw columns that gained a formula → their cells go away. */
  const becameDerivedIds: string[] = [];

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
    const existing = byId.get(id);
    const display = entry.formula?.trim() ?? '';
    // Derived columns are always plain numbers: no required, no format.
    const type: DataColumnType = display ? 'number' : entry.type;
    const column: DataColumn = {
      id,
      name,
      type,
      ...(entry.required && !display ? { required: true } : {}),
      // Numeric display format survives renames; a type change drops it
      // (retype-to-number re-detects below).
      ...(!display && existing?.format && existing.type === type
        ? { format: existing.format }
        : {}),
    };
    nextColumns.push(column);
    if (display) {
      pendingFormulas.push({ column, display });
      if (existing && !existing.formula) becameDerivedIds.push(id);
    } else if (existing && !existing.formula && existing.type !== type) {
      // Removing a formula leaves an empty number column (rows never
      // carried its cells), so ex-derived columns skip re-coercion too.
      retyped.push(column);
    }
  }

  // Refs resolve case-insensitively against draft names, plus the
  // open-time names of kept columns so a rename in the same draft does
  // not break formulas that still use the old name. First match wins.
  const refIds = new Map<string, string>();
  const addRef = (name: string, id: string) => {
    const key = name.trim().toLowerCase();
    if (key && !refIds.has(key)) refIds.set(key, id);
  };
  for (const column of nextColumns) addRef(column.name, column.id);
  for (const column of columns) {
    if (usedIds.has(column.id)) addRef(column.name, column.id);
  }
  for (const { column, display } of pendingFormulas) {
    const stored = rewriteFormulaRefs(
      display,
      (ref) => refIds.get(ref.trim().toLowerCase()) ?? null,
    );
    // Defensive: the editor validates before Apply; an unresolvable ref
    // here degrades to a plain (empty) number column.
    if (stored.ok) column.formula = stored.formula;
  }

  const deletedIds = columns.map((c) => c.id).filter((id) => !usedIds.has(id));

  // Converting to number: detect the column's currency/separator style
  // from the current values so "$25" or "1.234,56" convert instead of
  // nulling out.
  for (const column of retyped) {
    if (column.type !== 'number') continue;
    const detected = detectColumnNumberFormat(
      rows.map((row) => formatCell(row[column.id])),
    );
    if (detected && Object.keys(detected).length > 0) column.format = detected;
  }

  let converted = 0;
  const removedCellIds = [...deletedIds, ...becameDerivedIds];
  const needsRowPass = retyped.length > 0 || removedCellIds.length > 0;
  const nextRows = needsRowPass
    ? rows.map((row) => {
        const out = { ...row };
        for (const id of removedCellIds) delete out[id];
        for (const column of retyped) {
          const current = out[column.id];
          if (current === null || current === undefined) continue;
          const coerced = coerceCell(
            formatCell(current),
            column.type,
            column.format,
          );
          if (coerced === null) converted += 1;
          out[column.id] = coerced;
        }
        return out;
      })
    : rows;

  return { columns: nextColumns, rows: nextRows, converted };
}
