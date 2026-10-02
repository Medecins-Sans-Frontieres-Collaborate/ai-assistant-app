/**
 * The admin health view: what is wrong with the deliveries, in terms an admin
 * can act on or pass to whoever runs the ETL. Pure.
 */
import {
  AnalyticsActor,
  indexFolders,
  resolveFolderAccess,
} from '@/lib/services/analytics/access';
import {
  AnalyticsHealthResponse,
  AnalyticsProblemDto,
} from '@/lib/services/analytics/dto';
import {
  DELETE_GRACE_DAYS,
  daysBetween,
} from '@/lib/services/analytics/retention';
import {
  AnalyticsData,
  FileView,
  findStaleFolders,
  findUnconfiguredFolders,
} from '@/lib/services/analytics/viewModel';

const MAX_PROBLEMS = 300;
const MAX_EXPIRING = 200;
/** How far ahead "about to expire" looks. */
const EXPIRING_WITHIN_DAYS = 30;

export interface HealthInput {
  data: AnalyticsData;
  files: readonly FileView[];
  actor: AnalyticsActor;
  deliveryUnavailable: boolean;
  foldersUnavailable: boolean;
  container: string;
  deleteEnabled: boolean;
  now: Date;
}

export function buildHealth(input: HealthInput): AnalyticsHealthResponse {
  const { data, actor, now } = input;
  const folders = indexFolders(data.folders?.folders);
  // An admin's health view covers exactly the folders they administer — a
  // delegated admin never sees raw paths, problems or counts.
  const administers = (folder: string) =>
    resolveFolderAccess(folder, folders, actor) === 'admin';
  const files = input.files.filter((file) => administers(file.folder));

  const totals = {
    files: files.length,
    ok: 0,
    warning: 0,
    error: 0,
    pending: 0,
  };
  const problems: AnalyticsProblemDto[] = [];
  const unclassified = new Map<string, number>();
  const expiring: AnalyticsHealthResponse['expiring'] = [];

  for (const file of files) {
    totals[file.validation] += 1;
    const actionable = file.issues.filter((issue) => issue.severity !== 'info');
    if (file.validation === 'pending' || actionable.length > 0) {
      problems.push({
        id: file.id,
        path: file.path,
        validation: file.validation,
        issues: file.issues,
        firstSeenAt: file.firstSeenAt,
      });
    }
    for (const column of file.unclassified) {
      unclassified.set(column, (unclassified.get(column) ?? 0) + 1);
    }
    if (
      file.expired ||
      daysBetween(now, new Date(file.expiresAt)) <= EXPIRING_WITHIN_DAYS
    ) {
      expiring.push({
        id: file.id,
        path: file.path,
        expiresAt: file.expiresAt,
        expired: file.expired,
      });
    }
  }

  const severityRank = { error: 0, pending: 1, warning: 2, ok: 3 } as const;
  problems.sort(
    (a, b) =>
      severityRank[a.validation] - severityRank[b.validation] ||
      a.path.localeCompare(b.path),
  );
  expiring.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

  return {
    deliveryUnavailable: input.deliveryUnavailable,
    foldersUnavailable: input.foldersUnavailable,
    policyUnavailable: data.policyUnavailable,
    container: input.container,
    retentionDeletion: !input.deleteEnabled
      ? 'disabled'
      : data.folders === null
        ? 'waiting-for-config'
        : 'active',
    graceDays: DELETE_GRACE_DAYS,
    totals,
    problems: problems.slice(0, MAX_PROBLEMS),
    unconfiguredFolders: findUnconfiguredFolders(data).filter(administers),
    staleFolders: findStaleFolders(data, input.files, now).filter((folder) =>
      administers(folder.path),
    ),
    unclassifiedColumns: [...unclassified]
      .map(([column, count]) => ({ column, files: count }))
      .sort((a, b) => b.files - a.files || a.column.localeCompare(b.column)),
    expiring: expiring.slice(0, MAX_EXPIRING),
  };
}
