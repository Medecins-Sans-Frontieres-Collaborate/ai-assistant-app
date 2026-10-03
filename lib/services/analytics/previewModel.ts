/**
 * What of a file's tables a given person may see. Pure.
 *
 * The stored preview and a full export are both run through here, so the grid
 * a person looks at and the file they export can never disagree about which
 * columns exist.
 *
 *  - Admins see everything, with each column that users do NOT see marked.
 *  - A ROW-LEVEL table (one row per person) needs `download` access. At
 *    `view` level it is withheld whole; aggregates over it arrive with the
 *    dashboards, which suppress small groups.
 *  - A TEXT column whose field is hidden, or that nobody has classified, is
 *    removed. Numbers, dates and flags are measures and always stay.
 *  - A FREEFORM page cannot be filtered cell by cell: if any field it holds
 *    is hidden, the page is withheld.
 */
import { FolderAccess } from '@/lib/services/analytics/access';
import {
  AnalyticsFieldId,
  classifyColumn,
  isAnalyticsFieldId,
} from '@/lib/services/analytics/fields';
import {
  Cell,
  ColumnKind,
  DerivedTable,
} from '@/lib/services/analytics/tables';
import { AnalyticsFieldPolicyDocument } from '@/lib/services/analytics/types';

export type TableWithheld = 'row-level' | 'hidden-fields';

export interface PreviewContext {
  access: FolderAccess;
  hidden: ReadonlySet<AnalyticsFieldId>;
  policy: Pick<AnalyticsFieldPolicyDocument, 'columns'> | null;
}

export interface ColumnView {
  name: string;
  kind: ColumnKind;
  /** The field a text column is filed under; null for measures. */
  field: AnalyticsFieldId | null;
  /** Admins only: users do not get this column. */
  hiddenFromUsers: boolean;
}

export interface TableSummary {
  name: string;
  layout: 'table' | 'freeform';
  rowCount: number;
  /** Rows actually present in this response's source. */
  shownRows: number;
  truncated: boolean;
  rowLevel: boolean;
  /** Why this person cannot open the table; null when they can. */
  withheld: TableWithheld | null;
}

export interface TableView extends TableSummary {
  columns: ColumnView[];
  rows: Cell[][];
}

function columnHiddenFromUsers(
  column: { name: string; kind: ColumnKind },
  context: PreviewContext,
): boolean {
  if (column.kind !== 'text') return false;
  const field = classifyColumn(column.name, context.policy);
  return field === null || context.hidden.has(field);
}

function freeformHiddenFromUsers(
  table: DerivedTable,
  context: PreviewContext,
): boolean {
  return table.declaredFields.some(
    (field) => isAnalyticsFieldId(field) && context.hidden.has(field),
  );
}

export function tableWithheld(
  table: DerivedTable,
  context: PreviewContext,
): TableWithheld | null {
  if (context.access === 'admin') return null;
  if (table.rowLevel && context.access !== 'download') return 'row-level';
  if (table.layout === 'freeform' && freeformHiddenFromUsers(table, context)) {
    return 'hidden-fields';
  }
  return null;
}

export function summarizeTable(
  table: DerivedTable,
  context: PreviewContext,
): TableSummary {
  return {
    name: table.name,
    layout: table.layout,
    rowCount: table.rowCount,
    shownRows: table.rows.length,
    truncated: table.truncated,
    rowLevel: table.rowLevel,
    withheld: tableWithheld(table, context),
  };
}

/** The table as this person may see it, or null when it is withheld. */
export function viewTable(
  table: DerivedTable,
  context: PreviewContext,
): TableView | null {
  const summary = summarizeTable(table, context);
  if (summary.withheld !== null) return null;
  const isAdmin = context.access === 'admin';

  if (table.layout === 'freeform') {
    const hiddenPage = freeformHiddenFromUsers(table, context);
    return {
      ...summary,
      columns: table.columns.map((column) => ({
        name: column.name,
        kind: column.kind,
        field: null,
        hiddenFromUsers: hiddenPage,
      })),
      rows: table.rows,
    };
  }

  const columns = table.columns.map((column) => ({
    name: column.name,
    kind: column.kind,
    field:
      column.kind === 'text'
        ? classifyColumn(column.name, context.policy)
        : null,
    hiddenFromUsers: columnHiddenFromUsers(column, context),
  }));
  if (isAdmin) return { ...summary, columns, rows: table.rows };

  const kept = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !column.hiddenFromUsers);
  return {
    ...summary,
    columns: kept.map(({ column }) => column),
    rows:
      kept.length === columns.length
        ? table.rows
        : table.rows.map((row) => kept.map(({ index }) => row[index] ?? null)),
  };
}
