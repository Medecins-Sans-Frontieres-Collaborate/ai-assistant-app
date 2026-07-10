import { DataColumn } from '@/types/workflow';

import { formatCell, getRowId } from './tableUtils';

/**
 * Required-field handling — entirely deterministic and client-side:
 * missing values are countable facts, so policy enforcement and flagging
 * never involve the LLM. Pure.
 */

export type MissingFieldPolicy = 'strict' | 'flag' | 'lenient';

export const DEFAULT_MISSING_FIELD_POLICY: MissingFieldPolicy = 'flag';

function requiredColumns(columns: DataColumn[]): DataColumn[] {
  return columns.filter((c) => c.required === true);
}

/**
 * Live whole-table scan: which cells are empty in required columns.
 * Computed on demand (memoize at the call site, like profileTable) —
 * never stored, so it can't go stale.
 */
export function missingRequiredCells(
  columns: DataColumn[],
  rows: Record<string, unknown>[],
): Map<string, Set<string>> {
  const flagged = new Map<string, Set<string>>();
  const required = requiredColumns(columns);
  if (required.length === 0) return flagged;
  for (const row of rows) {
    const rid = getRowId(row);
    if (!rid) continue;
    for (const column of required) {
      if (formatCell(row[column.id]) === '') {
        let set = flagged.get(rid);
        if (!set) {
          set = new Set();
          flagged.set(rid, set);
        }
        set.add(column.id);
      }
    }
  }
  return flagged;
}

export interface PolicyEnforcementResult {
  rows: Record<string, unknown>[];
  /** Rows dropped under 'strict'. */
  dropped: number;
  /** Names of the required fields that caused drops (deduped). */
  droppedFields: string[];
}

/**
 * Applies the missing-field policy to INCOMING rows before they merge
 * into the table. Only 'strict' mutates the set (drops offenders and
 * reports what was missing); 'flag' and 'lenient' pass everything
 * through — flagging is the live scan's job.
 */
export function enforceMissingFieldPolicy(
  columns: DataColumn[],
  newRows: Record<string, unknown>[],
  policy: MissingFieldPolicy,
): PolicyEnforcementResult {
  if (policy !== 'strict') {
    return { rows: newRows, dropped: 0, droppedFields: [] };
  }
  const required = requiredColumns(columns);
  if (required.length === 0) {
    return { rows: newRows, dropped: 0, droppedFields: [] };
  }
  const droppedFields = new Set<string>();
  const kept = newRows.filter((row) => {
    const missing = required.filter((c) => formatCell(row[c.id]) === '');
    for (const column of missing) droppedFields.add(column.name);
    return missing.length === 0;
  });
  return {
    rows: kept,
    dropped: newRows.length - kept.length,
    droppedFields: [...droppedFields],
  };
}
