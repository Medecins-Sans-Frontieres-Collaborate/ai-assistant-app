/**
 * What of a file's rollup a given person may see. Pure.
 *
 *  - A breakdown by a field the policy hides is withheld.
 *  - At `view` level, groups of fewer than SMALL_GROUP_THRESHOLD people are
 *    FOLDED into one unnamed row. Folded, not dropped: the totals still add
 *    up, and the reader can see that something was folded.
 *  - `download` and admin access see every group — those readers can open
 *    the per-person rows anyway, so folding would only make the chart
 *    disagree with the table beside it.
 */
import { FolderAccess } from '@/lib/services/analytics/access';
import { AnalyticsFieldId } from '@/lib/services/analytics/fields';
import {
  DeliveredAssumptions,
  FileRollup,
  RollupDataset,
  SMALL_GROUPS_LABEL,
  SMALL_GROUP_THRESHOLD,
} from '@/lib/services/analytics/rollup';
import { Cell } from '@/lib/services/analytics/tables';
import { AnalyticsReportTypeId } from '@/lib/services/analytics/types';

export interface RollupContext {
  access: FolderAccess;
  hidden: ReadonlySet<AnalyticsFieldId>;
}

export interface DatasetView {
  columns: string[];
  rows: Cell[][];
  /** Small groups were folded into one row. */
  folded: boolean;
}

export interface RollupView {
  reportType: AnalyticsReportTypeId;
  kpis: Record<string, number | null>;
  text: Record<string, string>;
  datasets: Record<string, DatasetView>;
  /** Datasets left out because their field is hidden. */
  withheld: string[];
  assumptions: DeliveredAssumptions | null;
}

/**
 * Relabels every small group, then merges the rows that have become
 * indistinguishable: cells that are not numbers form the key, numbers add.
 */
function foldSmallGroups(dataset: RollupDataset): DatasetView {
  const people = dataset.people ?? {};
  let folded = false;
  const merged = new Map<string, Cell[]>();
  for (const row of dataset.rows) {
    const group = String(row[0] ?? '');
    const small = (people[group] ?? 0) < SMALL_GROUP_THRESHOLD;
    if (small) folded = true;
    const relabelled: Cell[] = small
      ? [SMALL_GROUPS_LABEL, ...row.slice(1)]
      : row;
    const key = JSON.stringify(
      relabelled.map((cell) => (typeof cell === 'number' ? null : cell)),
    );
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, [...relabelled]);
      continue;
    }
    relabelled.forEach((cell, index) => {
      if (typeof cell === 'number') {
        existing[index] = ((existing[index] as number | null) ?? 0) + cell;
      }
    });
  }
  return { columns: dataset.columns, rows: [...merged.values()], folded };
}

export function viewDataset(
  dataset: RollupDataset,
  context: RollupContext,
): DatasetView | null {
  if (context.access === 'admin') {
    return { columns: dataset.columns, rows: dataset.rows, folded: false };
  }
  if (dataset.field !== null && context.hidden.has(dataset.field)) return null;
  if (dataset.people !== null && context.access !== 'download') {
    return foldSmallGroups(dataset);
  }
  return { columns: dataset.columns, rows: dataset.rows, folded: false };
}

/**
 * @param only when given, every other dataset is left out (a trend needs one
 *   or two per file, not all of them).
 */
export function viewRollup(
  rollup: FileRollup,
  context: RollupContext,
  only?: readonly string[],
): RollupView {
  const datasets: Record<string, DatasetView> = {};
  const withheld: string[] = [];
  for (const [name, dataset] of Object.entries(rollup.datasets)) {
    if (only && !only.includes(name)) continue;
    const view = viewDataset(dataset, context);
    if (view) datasets[name] = view;
    else withheld.push(name);
  }
  return {
    reportType: rollup.reportType,
    kpis: rollup.kpis,
    text: rollup.text,
    datasets,
    withheld,
    assumptions: rollup.assumptions ?? null,
  };
}
