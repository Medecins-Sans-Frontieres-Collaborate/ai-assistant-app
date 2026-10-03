'use client';

import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { FC } from 'react';
import toast from 'react-hot-toast';

import { useLocale, useTranslations } from 'next-intl';

import { useAnalyticsHealthAdmin } from '@/client/hooks/settings/useAnalyticsAdmin';

import {
  AnalyticsHealthResponse,
  AnalyticsProblemDto,
} from '@/lib/services/analytics/dto';
import {
  ANALYTICS_ISSUE_CODES,
  AnalyticsIssue,
  AnalyticsIssueCode,
} from '@/lib/services/analytics/types';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHIP_DANGER,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_CHIP_WARN,
  ADMIN_HEADING,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';
import { formatDay } from '@/components/Analytics/format';

function isKnownIssue(code: string): code is AnalyticsIssueCode {
  return (ANALYTICS_ISSUE_CODES as readonly string[]).includes(code);
}

const STATUS_CHIP: Record<AnalyticsProblemDto['validation'], string> = {
  error: ADMIN_CHIP_DANGER,
  warning: ADMIN_CHIP_WARN,
  pending: ADMIN_CHIP_NEUTRAL,
  ok: ADMIN_CHIP_NEUTRAL,
};

interface HealthTabProps {
  onOpenFields: () => void;
}

/**
 * What arrived and what is wrong with it. Every problem is phrased so it can
 * be acted on here or forwarded as-is to whoever runs the ETL: which file,
 * which check, what was expected.
 */
export const HealthTab: FC<HealthTabProps> = ({ onOpenFields }) => {
  const t = useTranslations('analyticsAdmin');
  const { query, recheck } = useAnalyticsHealthAdmin();

  const runRecheck = async (fileId?: string) => {
    try {
      const result = await recheck.mutateAsync(fileId);
      toast.success(t('health.recheckQueued', { count: result.queued }));
    } catch {
      toast.error(t('health.recheckFailed'));
    }
  };

  if (query.isLoading) return <p className={ADMIN_MUTED}>{t('loading')}</p>;
  if (query.isError || !query.data) {
    return (
      <div className={`${ADMIN_BANNER_ERROR} flex items-center gap-3`}>
        <span className="flex-1">{t('loadError')}</span>
        <button
          type="button"
          className={ADMIN_BTN_RETRY}
          onClick={() => query.refetch()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }
  const health = query.data;
  const nothingWrong =
    !health.deliveryUnavailable &&
    health.problems.length === 0 &&
    health.unconfiguredFolders.length === 0 &&
    health.staleFolders.length === 0;

  return (
    <div className="space-y-6">
      {health.deliveryUnavailable && (
        <div className={ADMIN_BANNER_ERROR} role="alert">
          <p className="font-medium">{t('health.deliveryUnavailableTitle')}</p>
          <p className="mt-1">
            {t('health.deliveryUnavailableBody', {
              container: health.container,
            })}
          </p>
        </div>
      )}
      {health.foldersUnavailable && (
        <div className={ADMIN_BANNER_WARN} role="alert">
          {t('health.foldersUnavailable')}
        </div>
      )}
      {health.policyUnavailable && (
        <div className={ADMIN_BANNER_WARN} role="alert">
          {t('health.policyUnavailable')}
        </div>
      )}

      <section className={`${ADMIN_CARD} space-y-3`}>
        <div className="flex flex-wrap items-center gap-3">
          <Totals totals={health.totals} />
          <button
            type="button"
            className={`${ADMIN_BTN_SECONDARY} ml-auto`}
            disabled={recheck.isPending || health.totals.files === 0}
            onClick={() => runRecheck()}
          >
            <IconRefresh size={16} aria-hidden="true" />
            {t('health.recheckAll')}
          </button>
        </div>
        <p className={ADMIN_MUTED}>
          {t(`health.retention.${health.retentionDeletion}`, {
            days: health.graceDays,
          })}
        </p>
      </section>

      {nothingWrong && (
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {health.totals.files === 0
            ? t('health.noFiles')
            : t('health.allGood')}
        </p>
      )}

      {health.problems.length > 0 && (
        <section>
          <h3 className={ADMIN_HEADING}>{t('health.problemsHeading')}</h3>
          <ul className="space-y-2">
            {health.problems.map((problem) => (
              <ProblemRow
                key={problem.id}
                problem={problem}
                busy={recheck.isPending}
                onRecheck={() => runRecheck(problem.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {health.unclassifiedColumns.length > 0 && (
        <section>
          <h3 className={ADMIN_HEADING}>{t('health.unclassifiedHeading')}</h3>
          <div className={`${ADMIN_ROW} space-y-2`}>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t('health.unclassifiedBody')}
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {health.unclassifiedColumns.map((entry) => (
                <li key={entry.column} className={ADMIN_CHIP_WARN}>
                  {t('health.unclassifiedChip', {
                    column: entry.column,
                    count: entry.files,
                  })}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={onOpenFields}
            >
              {t('health.openFields')}
            </button>
          </div>
        </section>
      )}

      {health.unconfiguredFolders.length > 0 && (
        <PathList
          heading={t('health.unconfiguredHeading')}
          body={t('health.unconfiguredBody')}
          rows={health.unconfiguredFolders.map((path) => ({
            key: path,
            label: path || t('rootFolder'),
          }))}
        />
      )}

      {health.staleFolders.length > 0 && (
        <StaleList folders={health.staleFolders} />
      )}

      {health.expiring.length > 0 && <ExpiringList files={health.expiring} />}
    </div>
  );
};

const Totals: FC<{ totals: AnalyticsHealthResponse['totals'] }> = ({
  totals,
}) => {
  const t = useTranslations('analyticsAdmin');
  const cells: [string, number][] = [
    [t('health.total.files'), totals.files],
    [t('health.total.ok'), totals.ok],
    [t('health.total.warning'), totals.warning],
    [t('health.total.error'), totals.error],
    [t('health.total.pending'), totals.pending],
  ];
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      {cells.map(([label, value]) => (
        <div key={label}>
          <dt className={ADMIN_MUTED}>{label}</dt>
          <dd className="text-lg font-semibold tabular-nums text-black dark:text-white">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
};

export function useIssueText(): (issue: AnalyticsIssue) => string {
  const t = useTranslations('analyticsAdmin');
  return (issue) =>
    isKnownIssue(issue.code)
      ? t(`issue.${issue.code}`, issue.params)
      : // A code written by a newer replica than this one.
        t('issue.unknown', { code: issue.code });
}

const ProblemRow: FC<{
  problem: AnalyticsProblemDto;
  busy: boolean;
  onRecheck: () => void;
}> = ({ problem, busy, onRecheck }) => {
  const t = useTranslations('analyticsAdmin');
  const locale = useLocale();
  const issueText = useIssueText();
  return (
    <li className={`${ADMIN_ROW} space-y-2`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={STATUS_CHIP[problem.validation]}>
          {t(`health.status.${problem.validation}`)}
        </span>
        <span className="min-w-0 flex-1 break-all font-mono text-xs text-black dark:text-white">
          {problem.path}
        </span>
        <button
          type="button"
          className={ADMIN_BTN_RETRY}
          disabled={busy}
          onClick={onRecheck}
        >
          {t('health.recheckOne')}
        </button>
      </div>
      {problem.validation === 'pending' ? (
        <p className={ADMIN_MUTED}>{t('health.pendingBody')}</p>
      ) : (
        <ul className="space-y-1">
          {problem.issues.map((issue, index) => (
            <li
              key={`${issue.code}-${index}`}
              className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
            >
              {issue.severity !== 'info' && (
                <IconAlertTriangle
                  size={16}
                  aria-hidden="true"
                  className={
                    issue.severity === 'error'
                      ? 'mt-0.5 shrink-0 text-red-600 dark:text-red-400'
                      : 'mt-0.5 shrink-0 text-amber-600 dark:text-amber-400'
                  }
                />
              )}
              <span>{issueText(issue)}</span>
            </li>
          ))}
        </ul>
      )}
      {problem.firstSeenAt && problem.validation !== 'pending' && (
        <p className={ADMIN_MUTED}>
          {t('health.firstSeen', {
            date: formatDay(problem.firstSeenAt, locale),
          })}
        </p>
      )}
    </li>
  );
};

const PathList: FC<{
  heading: string;
  body: string;
  rows: { key: string; label: string; detail?: string }[];
}> = ({ heading, body, rows }) => (
  <section>
    <h3 className={ADMIN_HEADING}>{heading}</h3>
    <div className={`${ADMIN_ROW} space-y-2`}>
      <p className="text-sm text-gray-700 dark:text-gray-300">{body}</p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex flex-wrap items-baseline gap-x-3 text-sm"
          >
            <span className="break-all font-mono text-xs text-black dark:text-white">
              {row.label}
            </span>
            {row.detail && <span className={ADMIN_MUTED}>{row.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  </section>
);

const StaleList: FC<{ folders: AnalyticsHealthResponse['staleFolders'] }> = ({
  folders,
}) => {
  const t = useTranslations('analyticsAdmin');
  const locale = useLocale();
  return (
    <PathList
      heading={t('health.staleHeading')}
      body={t('health.staleBody')}
      rows={folders.map((folder) => ({
        key: folder.path,
        label: folder.path || t('rootFolder'),
        detail: folder.lastPeriodEnd
          ? t(`health.staleDetail.${folder.cadence}`, {
              date: formatDay(`${folder.lastPeriodEnd}T00:00:00.000Z`, locale),
            })
          : t('health.staleNever'),
      }))}
    />
  );
};

const ExpiringList: FC<{ files: AnalyticsHealthResponse['expiring'] }> = ({
  files,
}) => {
  const t = useTranslations('analyticsAdmin');
  const locale = useLocale();
  return (
    <PathList
      heading={t('health.expiringHeading')}
      body={t('health.expiringBody')}
      rows={files.map((file) => ({
        key: file.id,
        label: file.path,
        detail: file.expired
          ? t('health.expiredOn', { date: formatDay(file.expiresAt, locale) })
          : t('health.expiresOn', { date: formatDay(file.expiresAt, locale) }),
      }))}
    />
  );
};
