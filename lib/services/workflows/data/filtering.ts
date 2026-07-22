import { DataColumn } from '@/types/workflow';

import { formatCell } from './tableUtils';

/**
 * Client-side row filtering — a pure view concern (never persisted, never
 * sent to the LLM as a filter; scoped operations send the filtered ROWS).
 * Filters AND across columns.
 */

export type ColumnFilter =
  | { columnId: string; kind: 'text'; query: string }
  | { columnId: string; kind: 'range'; min?: number; max?: number }
  | { columnId: string; kind: 'dateRange'; min?: string; max?: string }
  | { columnId: string; kind: 'values'; values: string[] };

export function isFilterActive(filter: ColumnFilter): boolean {
  switch (filter.kind) {
    case 'text':
      return filter.query.trim().length > 0;
    case 'range':
      return filter.min !== undefined || filter.max !== undefined;
    case 'dateRange':
      return !!filter.min || !!filter.max;
    case 'values':
      return filter.values.length > 0;
  }
}

export function rowMatches(
  row: Record<string, unknown>,
  filter: ColumnFilter,
): boolean {
  const value = row[filter.columnId];
  switch (filter.kind) {
    case 'text': {
      const query = filter.query.trim().toLowerCase();
      if (!query) return true;
      return formatCell(value).toLowerCase().includes(query);
    }
    case 'range': {
      if (typeof value !== 'number') return false;
      if (filter.min !== undefined && value < filter.min) return false;
      if (filter.max !== undefined && value > filter.max) return false;
      return true;
    }
    case 'dateRange': {
      // ISO-normalized dates compare chronologically as strings.
      const formatted = formatCell(value);
      if (!formatted) return false;
      if (filter.min && formatted < filter.min) return false;
      if (filter.max && formatted > filter.max) return false;
      return true;
    }
    case 'values':
      return filter.values.includes(formatCell(value));
  }
}

export function applyFilters(
  rows: Record<string, unknown>[],
  filters: ColumnFilter[],
): Record<string, unknown>[] {
  const active = filters.filter(isFilterActive);
  if (active.length === 0) return rows;
  return rows.filter((row) => active.every((f) => rowMatches(row, f)));
}

/** The filter kind a column's type calls for. */
export function defaultFilterKind(
  column: DataColumn,
  distinct: number,
  lowCardinalityMax: number,
): ColumnFilter['kind'] {
  if (column.type === 'number') return 'range';
  if (column.type === 'date') return 'dateRange';
  if (column.type === 'boolean') return 'values';
  return distinct > 0 && distinct <= lowCardinalityMax ? 'values' : 'text';
}
