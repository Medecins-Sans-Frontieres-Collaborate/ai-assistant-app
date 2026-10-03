/**
 * A file's ROLLUP: the small aggregated tables its dashboard is drawn from,
 * computed once when the file is validated. Pure and client-importable.
 *
 * It exists so that nothing a dashboard shows requires a person to hold the
 * rows it was computed from. A director with `view` access sees "interactions
 * by department" without the per-person sheet ever leaving the server; and a
 * trend across twenty-four months reads twenty-four rollups of a few
 * kilobytes each instead of twenty-four workbooks.
 *
 * A rollup holds every breakdown, unfiltered. Which of them a given person
 * sees — and with small groups folded away or not — is decided when it is
 * SERVED (rollupModel.ts), like everything else here.
 */
import { AnalyticsFieldId } from '@/lib/services/analytics/fields';
import { Cell } from '@/lib/services/analytics/tables';
import { AnalyticsReportTypeId } from '@/lib/services/analytics/types';

import { EmissionsFactors } from '@/lib/utils/shared/emissions';

/** Bump when a dataset's shape changes; older rollups are then rebuilt. */
export const ROLLUP_VERSION = 1;

export interface RollupDataset {
  /** Column 0 is the grouping label; the rest are labels or measures. */
  columns: string[];
  rows: Cell[][];
  /**
   * The field the grouping label belongs to. When the field policy hides it,
   * the whole dataset is withheld. Null for breakdowns by something that is
   * not a field (a date, an activity band).
   */
  field: AnalyticsFieldId | null;
  /**
   * Distinct people behind each grouping label. Present only for breakdowns
   * of per-person data; it is what small-group folding reads. Null when the
   * dataset does not describe people (billing by section).
   */
  people: Record<string, number> | null;
}

/**
 * The assumption set an emissions report was produced with, read from its
 * `Assumptions` sheet, plus the equivalences it states.
 */
export interface DeliveredAssumptions extends EmissionsFactors {
  smartphoneChargeGrams: number | null;
}

export interface FileRollup {
  version: number;
  /** The delivered blob this was computed from. */
  blobVersion: string;
  reportType: AnalyticsReportTypeId;
  /** Headline figures. Null = the report did not provide it. */
  kpis: Record<string, number | null>;
  /** Short labels that go with the figures (a currency, the slice name). */
  text: Record<string, string>;
  datasets: Record<string, RollupDataset>;
  /** Emissions only. Null when the sheet could not be read. */
  assumptions?: DeliveredAssumptions | null;
}

/**
 * Datasets a TREND needs from each file, per report type. Everything else
 * stays out of a trend response: thirty-six files times every breakdown would
 * be megabytes nobody looks at.
 */
export const TREND_DATASETS: Record<AnalyticsReportTypeId, readonly string[]> =
  {
    usage: [],
    rebilling: ['bySection'],
    emissions: ['recalc'],
    'raw-telemetry': [],
  };

/** Most files a trend spans, newest first. */
export const MAX_TREND_FILES = 36;

/**
 * A breakdown row standing for every group too small to show on its own. A
 * sentinel rather than display text, so the client can translate it.
 */
export const SMALL_GROUPS_LABEL = '\u0000small-groups';

/** Groups with fewer people than this are folded together at `view` level. */
export const SMALL_GROUP_THRESHOLD = 5;
