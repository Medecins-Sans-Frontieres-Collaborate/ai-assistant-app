'use client';

import { useTranslations } from 'next-intl';

import { ColumnProfile, DataColumn } from '@/types/workflow';

interface ColumnProfilePopoverProps {
  column: DataColumn;
  profile: ColumnProfile;
  onClose: () => void;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toLocaleString();
}

/**
 * Per-column deterministic stats, opened from the grid header. All
 * figures are computed exactly over the full (unfiltered) table.
 */
export function ColumnProfilePopover({
  column,
  profile,
  onClose,
}: ColumnProfilePopoverProps) {
  const t = useTranslations('workflows.data');
  const missingPct = profile.total
    ? Math.round((profile.missing / profile.total) * 100)
    : 0;

  return (
    <>
      {/* Click-away layer */}
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={t('columnProfileFor', { column: column.name })}
        className="absolute start-0 top-full z-30 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-3 text-start shadow-lg dark:border-gray-700 dark:bg-surface-dark-elevated"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {column.name}
          <span className="ms-1.5 text-[10px] font-normal uppercase text-gray-400">
            {column.type}
          </span>
        </p>
        <dl className="mt-2 space-y-1 text-xs text-gray-700 dark:text-gray-300">
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500 dark:text-gray-400">
              {t('profileMissing')}
            </dt>
            <dd className="tabular-nums">
              {profile.missing.toLocaleString()} ({missingPct}%)
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500 dark:text-gray-400">
              {t('profileDistinct')}
            </dt>
            <dd className="tabular-nums">
              {profile.distinct.toLocaleString()}
            </dd>
          </div>
          {profile.min !== undefined && profile.max !== undefined && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('profileRange')}
              </dt>
              <dd className="tabular-nums">
                {formatNumber(profile.min)} – {formatNumber(profile.max)}
              </dd>
            </div>
          )}
          {profile.mean !== undefined && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('profileMean')}
              </dt>
              <dd className="tabular-nums">{formatNumber(profile.mean)}</dd>
            </div>
          )}
          {profile.median !== undefined && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('profileMedian')}
              </dt>
              <dd className="tabular-nums">{formatNumber(profile.median)}</dd>
            </div>
          )}
          {profile.minDate && profile.maxDate && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500 dark:text-gray-400">
                {t('profileRange')}
              </dt>
              <dd className="tabular-nums">
                {profile.minDate} – {profile.maxDate}
              </dd>
            </div>
          )}
        </dl>
        {profile.topValues && profile.topValues.length > 0 && (
          <div className="mt-2 border-t border-gray-100 pt-2 dark:border-gray-700">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t('profileTopValues')}
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-gray-700 dark:text-gray-300">
              {profile.topValues.slice(0, 5).map((entry) => (
                <li key={entry.value} className="flex justify-between gap-2">
                  <span className="truncate" title={entry.value}>
                    {entry.value}
                  </span>
                  <span className="tabular-nums text-gray-500 dark:text-gray-400">
                    {entry.count.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
