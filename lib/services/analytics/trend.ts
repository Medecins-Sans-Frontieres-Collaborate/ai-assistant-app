/**
 * Which files under a folder form ONE run of reports that can be plotted over
 * time. Pure.
 */
import {
  AnalyticsActor,
  FolderAccess,
  FolderIndex,
  resolveFolderAccess,
} from '@/lib/services/analytics/access';
import { isRawPath } from '@/lib/services/analytics/paths';
import { MAX_TREND_FILES } from '@/lib/services/analytics/rollup';
import {
  ANALYTICS_REPORT_TYPE_IDS,
  AnalyticsReportTypeId,
} from '@/lib/services/analytics/types';
import { FileView, canViewDashboard } from '@/lib/services/analytics/viewModel';

export type TrendStatus = 'ok' | 'none' | 'mixed-types' | 'several-per-period';

export interface TrendSelection {
  status: TrendStatus;
  reportType: AnalyticsReportTypeId | null;
  /** In period order, oldest first; empty unless status is 'ok'. */
  files: { file: FileView; access: FolderAccess }[];
}

function isReportType(value: string | null): value is AnalyticsReportTypeId {
  return (
    value !== null &&
    (ANALYTICS_REPORT_TYPE_IDS as readonly string[]).includes(value)
  );
}

/**
 * The reports under `folder` (itself and every folder inside it) that the
 * actor may open as dashboards.
 *
 * A trend is only drawn for a single run: one report type, one report per
 * period. A folder holding a report per section for the same month is not a
 * run — summing or overlaying sections would invent a series nobody
 * delivered — so it answers 'several-per-period' and the reader opens the
 * section's own folder instead.
 *
 * Access is checked per FILE, on its own folder: a restricted sub-folder
 * does not leak into its parent's trend.
 */
export function selectTrendFiles(
  folder: string,
  files: readonly FileView[],
  folders: FolderIndex,
  actor: AnalyticsActor,
): TrendSelection {
  const prefix = folder === '' ? '' : `${folder}/`;
  const candidates = files
    .filter(
      (file) =>
        (file.folder === folder || file.folder.startsWith(prefix)) &&
        // Raw telemetry is aggregated on demand, one file at a time; a trend
        // across it would mean reading every day's file in one request.
        !isRawPath(file.path) &&
        file.period !== null &&
        isReportType(file.reportType),
    )
    .map((file) => ({
      file,
      access: resolveFolderAccess(file.folder, folders, actor),
    }))
    .filter(({ file, access }) => canViewDashboard(file, access));

  const types = new Set(candidates.map(({ file }) => file.reportType));
  if (types.size > 1) {
    return { status: 'mixed-types', reportType: null, files: [] };
  }
  const reportType = candidates[0]?.file.reportType ?? null;
  if (candidates.length < 2 || !isReportType(reportType)) {
    return { status: 'none', reportType: null, files: [] };
  }

  const periods = new Set(
    candidates.map(({ file }) => `${file.period!.from}/${file.period!.to}`),
  );
  if (periods.size < candidates.length) {
    return { status: 'several-per-period', reportType, files: [] };
  }

  const ordered = [...candidates].sort((a, b) =>
    a.file.period!.to.localeCompare(b.file.period!.to),
  );
  return {
    status: 'ok',
    reportType,
    files: ordered.slice(-MAX_TREND_FILES),
  };
}
