import {
  SavedStructure,
  StructureField,
  isTabularFieldType,
} from '@/types/structure';
import { DataColumn } from '@/types/workflow';

import { MAX_COLUMNS, toColumnId } from './tableUtils';

/**
 * Converts between the shared saved-structure library (`types/structure.ts`)
 * and the data workflow's table columns.
 *
 * Both directions are lossy in known ways, so both report what they dropped —
 * the caller surfaces it rather than letting the user discover it later:
 *
 *  - structure → columns: `enum` and flat lists have no cell representation
 *    and degrade to `text`.
 *  - columns → structure: derived (formula) columns reference sibling column
 *    ids and cannot survive outside their table; display `format` is a
 *    rendering concern and is not part of the shape.
 *
 * Client-safe (no server imports).
 */

export interface StructureToColumnsResult {
  columns: DataColumn[];
  /** Names of fields whose type degraded to `text`. */
  downgraded: string[];
  /** Names of fields dropped because the table hit MAX_COLUMNS. */
  truncated: string[];
}

export function structureToColumns(
  structure: SavedStructure,
): StructureToColumnsResult {
  const fields = structure.fields ?? [];
  const kept = fields.slice(0, MAX_COLUMNS);
  const truncated = fields.slice(MAX_COLUMNS).map((field) => field.name);

  const usedIds = new Set<string>();
  const downgraded: string[] = [];

  const columns = kept.map((field, index) => {
    const base = toColumnId(field.name, index);
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}_${suffix++}`;
    usedIds.add(id);

    const tabular = isTabularFieldType(field.type);
    if (!tabular) downgraded.push(field.name);

    const column: DataColumn = {
      id,
      // The label is what the user reads; `name` is the wire identifier.
      name: field.label?.trim() || field.name,
      type: isTabularFieldType(field.type) ? field.type : 'text',
      ...(field.required ? { required: true } : {}),
    };
    return column;
  });

  return { columns, downgraded, truncated };
}

export interface ColumnsToStructureResult {
  structure: SavedStructure;
  /** Names of derived columns omitted from the structure. */
  skipped: string[];
}

export interface ColumnsToStructureMeta {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  now: string;
}

export function columnsToStructure(
  columns: DataColumn[],
  meta: ColumnsToStructureMeta,
): ColumnsToStructureResult {
  const skipped: string[] = [];
  const fields: StructureField[] = [];

  for (const column of columns) {
    // A formula is written in terms of *this* table's column ids, so a
    // derived column is meaningless in a library entry. Drop it and say so.
    if (column.formula) {
      skipped.push(column.name);
      continue;
    }
    fields.push({
      id: column.id,
      name: column.id,
      // Column names are free-text ("Total (USD)"); the id is the slug that
      // survives as a JSON key, so it becomes `name` and the display string
      // becomes `label` — matching how extraction fields are built.
      ...(column.name !== column.id ? { label: column.name } : {}),
      type: column.type,
      ...(column.required ? { required: true } : {}),
    });
  }

  return {
    structure: {
      id: meta.id,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.instructions ? { instructions: meta.instructions } : {}),
      fields,
      createdAt: meta.now,
      updatedAt: meta.now,
      sourceHint: 'spreadsheet',
    },
    skipped,
  };
}
