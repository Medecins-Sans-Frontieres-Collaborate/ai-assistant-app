/**
 * Turns an analytics snapshot into what a given person may see. Pure.
 *
 * ONE place decides visibility, so the tree, the file list, the download
 * route and the health panel cannot disagree:
 *
 *  - a non-admin sees a file only when it has been validated for its current
 *    bytes, has no `error`, and has not expired;
 *  - a non-admin may download the delivered file only at `download` level and
 *    only when it contains no hidden or unclassified field;
 *  - admins see everything their folder access covers, with the reasons.
 */
import {
  AnalyticsActor,
  FolderAccess,
  indexFolders,
  resolveFolderAccess,
} from '@/lib/services/analytics/access';
import {
  AnalyticsFieldId,
  effectiveHiddenFields,
  originalRestriction,
  summarizeFileFields,
} from '@/lib/services/analytics/fields';
import { isStateCurrent } from '@/lib/services/analytics/fileState';
import {
  baseName,
  extensionOf,
  folderChain,
  folderOfFile,
  isRawPath,
} from '@/lib/services/analytics/paths';
import {
  DeliveryCadence,
  STALE_AFTER_DAYS,
  effectiveReportType,
} from '@/lib/services/analytics/reportTypes';
import {
  ReportPeriod,
  daysBetween,
  effectiveRetentionMonths,
  expiryOf,
  isExpired,
  periodOfFileName,
} from '@/lib/services/analytics/retention';
import { ROLLUP_VERSION } from '@/lib/services/analytics/rollup';
import {
  ANALYTICS_PREVIEW_VERSION,
  AnalyticsFieldPolicyDocument,
  AnalyticsFileStatus,
  AnalyticsFoldersDocument,
  AnalyticsIssue,
  AnalyticsStateDocument,
  DeliveredBlob,
  blobVersionOf,
} from '@/lib/services/analytics/types';

/** The slice of the service snapshot the view model needs. */
export interface AnalyticsData {
  folders: AnalyticsFoldersDocument | null;
  policy: AnalyticsFieldPolicyDocument | null;
  policyUnavailable: boolean;
  state: AnalyticsStateDocument | null;
  blobs: readonly DeliveredBlob[];
}

export type OriginalBlock =
  | 'hidden-fields'
  | 'unclassified-fields'
  | 'not-inspected'
  | 'policy-unavailable';

export interface FileView {
  id: string;
  path: string;
  folder: string;
  name: string;
  size: number;
  lastModified: string;
  period: ReportPeriod | null;
  expiresAt: string;
  expired: boolean;
  /** 'pending' until the validator has seen these exact bytes. */
  validation: 'pending' | AnalyticsFileStatus;
  /** Stored issues plus the ones that depend on the clock or the policy. */
  issues: AnalyticsIssue[];
  firstSeenAt: string | null;
  fields: AnalyticsFieldId[];
  unclassified: string[];
  /** Why a non-admin cannot have the delivered file as-is; null when they can. */
  originalBlock: OriginalBlock | null;
  /** `${size}:${lastModified}` — keys the stored preview to these bytes. */
  blobVersion: string;
  /** The file can be opened in the app (a stored preview, or raw parquet). */
  hasPreview: boolean;
  /** It has a dashboard (a stored rollup, or raw parquet read on demand). */
  hasDashboard: boolean;
  /** The report type it was validated as; null when its folder names none. */
  reportType: string | null;
}

export function buildFileViews(
  data: AnalyticsData,
  /** Injected: the id is a hash, and this module stays free of node builtins. */
  fileIdOf: (path: string) => string,
  now: Date,
): FileView[] {
  const folders = indexFolders(data.folders?.folders);
  return data.blobs.map((blob) => {
    const id = fileIdOf(blob.path);
    const folder = folderOfFile(blob.path);
    const stored = data.state?.files[id];
    const state = isStateCurrent(stored, blob, folders) ? stored : undefined;
    const expiresAt = expiryOf(blob, effectiveRetentionMonths(folder, folders));
    const expired = isExpired(expiresAt, now);

    const summary = state
      ? summarizeFileFields(state, data.policy)
      : { fields: [], unclassified: [] };
    const issues: AnalyticsIssue[] = [...(state?.issues ?? [])];
    for (const column of summary.unclassified) {
      issues.push({
        code: 'unclassified-field',
        severity: 'warning',
        params: { column },
      });
    }
    if (expired) {
      issues.push({
        code: 'past-retention',
        severity: 'info',
        params: {
          months: effectiveRetentionMonths(folder, folders),
        },
      });
    }

    let originalBlock: OriginalBlock | null = null;
    if (!isRawPath(blob.path)) {
      if (data.policyUnavailable) originalBlock = 'policy-unavailable';
      else if (state) {
        originalBlock = originalRestriction(
          state,
          effectiveHiddenFields(folder, folders, data.policy),
          data.policy,
        );
      } else originalBlock = 'not-inspected';
    }

    let validation: FileView['validation'] = 'pending';
    if (state) {
      validation =
        state.status === 'ok' && summary.unclassified.length > 0
          ? 'warning'
          : state.status;
    }

    return {
      id,
      path: blob.path,
      folder,
      name: baseName(blob.path),
      size: blob.size,
      lastModified: blob.lastModified,
      period: periodOfFileName(blob.path),
      expiresAt: expiresAt.toISOString(),
      expired,
      validation,
      issues,
      firstSeenAt: state?.firstSeenAt ?? null,
      fields: summary.fields,
      unclassified: summary.unclassified,
      originalBlock,
      blobVersion: blobVersionOf(blob),
      hasPreview: isRawPath(blob.path)
        ? extensionOf(blob.path) === 'parquet' && blob.size > 0
        : state?.previewVersion === ANALYTICS_PREVIEW_VERSION,
      hasDashboard: isRawPath(blob.path)
        ? extensionOf(blob.path) === 'parquet' && blob.size > 0
        : state?.rollupVersion === ROLLUP_VERSION,
      reportType: isRawPath(blob.path)
        ? 'raw-telemetry'
        : (state?.reportType ?? null),
    };
  });
}

/** Whether a person with `access` to the file's folder sees it listed. */
export function isFileVisible(file: FileView, access: FolderAccess): boolean {
  if (access === 'admin') return true;
  if (access === 'none') return false;
  return (
    !file.expired && (file.validation === 'ok' || file.validation === 'warning')
  );
}

/**
 * Whether they may open the file in the app. Which of its tables they then
 * see is decided per table (previewModel.ts).
 */
export function canPreview(file: FileView, access: FolderAccess): boolean {
  return file.hasPreview && isFileVisible(file, access);
}

/** Whether they may open its dashboard. Suppression is applied per dataset. */
export function canViewDashboard(
  file: FileView,
  access: FolderAccess,
): boolean {
  return file.hasDashboard && isFileVisible(file, access);
}

/**
 * Whether they may export it as CSV or a workbook. Needs the same access as
 * a download — an export IS row-level data — but not an unrestricted
 * original: the export is what they get when the original is withheld.
 */
export function canExport(file: FileView, access: FolderAccess): boolean {
  return (
    file.hasPreview &&
    isFileVisible(file, access) &&
    (access === 'admin' ||
      (access === 'download' && file.originalBlock !== 'policy-unavailable'))
  );
}

/** Whether they may download the delivered file itself. */
export function canDownloadOriginal(
  file: FileView,
  access: FolderAccess,
): boolean {
  if (access === 'admin') return true;
  return (
    access === 'download' &&
    isFileVisible(file, access) &&
    file.originalBlock === null
  );
}

export interface FolderView {
  path: string;
  name: string;
  description: string;
  access: FolderAccess;
  /** Shown only because a descendant is visible; has no contents of its own. */
  pathOnly: boolean;
  /** Files directly in this folder that the person sees. */
  fileCount: number;
  /** An admin has saved an overlay entry for exactly this path. */
  configured: boolean;
}

/** Every folder path that exists: holding a file, configured, or an ancestor. */
export function allFolderPaths(data: AnalyticsData): string[] {
  const paths = new Set<string>(['']);
  for (const blob of data.blobs) {
    for (const path of folderChain(folderOfFile(blob.path))) paths.add(path);
  }
  for (const folder of data.folders?.folders ?? []) {
    for (const path of folderChain(folder.path)) paths.add(path);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export function buildFolderViews(
  data: AnalyticsData,
  files: readonly FileView[],
  actor: AnalyticsActor,
): FolderView[] {
  const folders = indexFolders(data.folders?.folders);
  const paths = allFolderPaths(data);
  const access = new Map<string, FolderAccess>(
    paths.map((path) => [path, resolveFolderAccess(path, folders, actor)]),
  );

  const shown = new Set<string>();
  for (const path of paths) {
    if (access.get(path) === 'none') continue;
    for (const ancestor of folderChain(path)) shown.add(ancestor);
  }

  const counts = new Map<string, number>();
  for (const file of files) {
    if (!isFileVisible(file, access.get(file.folder) ?? 'none')) continue;
    counts.set(file.folder, (counts.get(file.folder) ?? 0) + 1);
  }

  return paths
    .filter((path) => shown.has(path))
    .map((path) => {
      const config = folders.get(path);
      const folderAccess = access.get(path) ?? 'none';
      const pathOnly = folderAccess === 'none';
      return {
        path,
        // A path-only ancestor shows its storage name, never the overlay's
        // name or description: those belong to people who may open it.
        name: (!pathOnly && config?.name) || baseName(path),
        description: pathOnly ? '' : (config?.description ?? ''),
        access: folderAccess,
        pathOnly,
        fileCount: counts.get(path) ?? 0,
        configured: config !== undefined,
      };
    });
}

export interface StaleFolder {
  path: string;
  cadence: DeliveryCadence;
  /** End of the newest delivered period under the folder; null when none. */
  lastPeriodEnd: string | null;
}

/**
 * Folders that NAME a report type and have had no delivery for too long.
 * Judged on the folder that sets the type, across its whole subtree, so a
 * `usage/ocba/2026/…` layout is one stream, not one per year folder.
 */
export function findStaleFolders(
  data: AnalyticsData,
  files: readonly FileView[],
  now: Date,
): StaleFolder[] {
  const folders = indexFolders(data.folders?.folders);
  const stale: StaleFolder[] = [];
  for (const folder of data.folders?.folders ?? []) {
    if (!folder.reportType) continue;
    const type = effectiveReportType(folder.path, folders);
    if (!type) continue;
    const prefix = folder.path === '' ? '' : `${folder.path}/`;
    let newest: string | null = null;
    for (const file of files) {
      if (!file.path.startsWith(prefix) || !file.period) continue;
      if (newest === null || file.period.to > newest) newest = file.period.to;
    }
    const overdue =
      newest === null ||
      daysBetween(new Date(`${newest}T00:00:00.000Z`), now) >
        STALE_AFTER_DAYS[type.cadence];
    if (overdue) {
      stale.push({
        path: folder.path,
        cadence: type.cadence,
        lastPeriodEnd: newest,
      });
    }
  }
  return stale;
}

/**
 * Folders holding files that no overlay entry covers — neither the folder nor
 * any ancestor below the root is configured. Admin-only until someone does.
 */
export function findUnconfiguredFolders(data: AnalyticsData): string[] {
  const folders = indexFolders(data.folders?.folders);
  const unconfigured = new Set<string>();
  for (const blob of data.blobs) {
    const folder = folderOfFile(blob.path);
    const covered = folderChain(folder).some(
      (path) => path !== '' && folders.has(path),
    );
    if (!covered) unconfigured.add(folder);
  }
  return [...unconfigured].sort((a, b) => a.localeCompare(b));
}
