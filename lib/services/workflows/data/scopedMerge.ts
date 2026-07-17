import { DataColumn } from '@/types/workflow';

import { ROW_ID_KEY, getRowId } from './tableUtils';

/**
 * Merges a scoped-transform result back into the full table. The server
 * enforced the shape (same row count/order as sent, no existing column
 * dropped), so the merge is positional: the i-th scoped row in table
 * order is rebuilt from the i-th result row and keeps its rid; rows
 * outside the scope get an explicit null for any new columns. Pure.
 */
export function mergeScopedResult(options: {
  /** The full table rows (scoped rows were sent in this relative order). */
  rows: Record<string, unknown>[];
  /** Rids of the rows that were sent. */
  scopedRids: Set<string>;
  /** Existing table columns (before the transform). */
  columns: DataColumn[];
  /** Result columns (superset of existing, server-validated). */
  resultColumns: DataColumn[];
  /** Result rows, keyed by result column ids, in sent order. */
  resultRows: Record<string, unknown>[];
}): Record<string, unknown>[] {
  const { rows, scopedRids, columns, resultColumns, resultRows } = options;
  const newColumns = resultColumns.filter(
    (c) => !columns.some((existing) => existing.id === c.id),
  );
  let cursor = 0;
  return rows.map((row) => {
    const rid = getRowId(row);
    if (rid && scopedRids.has(rid)) {
      return { ...resultRows[cursor++], [ROW_ID_KEY]: rid };
    }
    if (newColumns.length === 0) return row;
    const filled = { ...row };
    for (const column of newColumns) filled[column.id] = null;
    return filled;
  });
}
