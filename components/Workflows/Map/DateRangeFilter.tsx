'use client';

import { IconCalendar, IconX } from '@tabler/icons-react';

import { useLocale, useTranslations } from 'next-intl';

import {
  DateRange,
  TimelineSegment,
  isDateRangeActive,
  segmentLabel,
} from '@/lib/utils/shared/geo/timelineScale';

interface DateRangeFilterProps {
  /** Era segments over the category-filtered set (chip options). */
  eras: TimelineSegment[];
  range: DateRange | null;
  onChange: (range: DateRange | null) => void;
  showUndated: boolean;
  onShowUndatedChange: (value: boolean) => void;
  /** Undated features currently in play (toggle only matters then). */
  undatedCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function msToInputValue(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

function inputValueToStartMs(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

function inputValueToEndMs(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms + DAY_MS - 1;
}

const dateInputClasses =
  'min-h-[32px] rounded-lg border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-700 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300';

/**
 * Date-range filter row: one-click era chips (the same adaptive
 * segments the timeline uses), custom from/to bounds, and a prominent
 * clear. A dated feature passes when its coverage intersects the range;
 * undated features follow the shared "show undated" toggle instead of
 * being silently dropped.
 */
export function DateRangeFilter({
  eras,
  range,
  onChange,
  showUndated,
  onShowUndatedChange,
  undatedCount,
}: DateRangeFilterProps) {
  const t = useTranslations('workflows.map');
  const locale = useLocale();
  const active = isDateRangeActive(range);

  const eraActive = (era: TimelineSegment) =>
    !!range && range.fromMs === era.startMs && range.toMs === era.endMs;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-gray-200 px-3 py-1.5 dark:border-gray-700">
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        <IconCalendar size={12} aria-hidden />
        {t('dateFilter.label')}
      </span>

      {eras.length > 1 &&
        eras.map((era) => {
          const label = segmentLabel(era, locale);
          const isActive = eraActive(era);
          return (
            <button
              key={era.firstStepIndex}
              type="button"
              onClick={() =>
                onChange(
                  isActive ? null : { fromMs: era.startMs, toMs: era.endMs },
                )
              }
              aria-pressed={isActive}
              aria-label={t('dateFilter.eraChip', { label })}
              className={`min-h-[28px] rounded-full px-2.5 py-0.5 text-xs tabular-nums ${
                isActive
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-surface-dark-elevated dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
            >
              {label}
            </button>
          );
        })}

      <label className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
        {t('dateFilter.from')}
        <input
          type="date"
          value={msToInputValue(range?.fromMs ?? null)}
          onChange={(e) => {
            const fromMs = inputValueToStartMs(e.target.value);
            const toMs = range?.toMs ?? null;
            onChange(
              fromMs === null && toMs === null ? null : { fromMs, toMs },
            );
          }}
          aria-label={t('dateFilter.fromAria')}
          className={dateInputClasses}
        />
      </label>
      <label className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
        {t('dateFilter.to')}
        <input
          type="date"
          value={msToInputValue(
            // The end bound is stored as end-of-day; render its day.
            range?.toMs != null ? range.toMs - (DAY_MS - 1) : null,
          )}
          onChange={(e) => {
            const toMs = inputValueToEndMs(e.target.value);
            const fromMs = range?.fromMs ?? null;
            onChange(
              fromMs === null && toMs === null ? null : { fromMs, toMs },
            );
          }}
          aria-label={t('dateFilter.toAria')}
          className={dateInputClasses}
        />
      </label>

      {active && (
        <>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="inline-flex min-h-[28px] items-center gap-1 rounded-lg bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-900 hover:bg-gray-300 dark:bg-surface-dark-elevated dark:text-gray-100 dark:hover:bg-gray-700"
          >
            <IconX size={12} aria-hidden />
            {t('dateFilter.clear')}
          </button>
          {undatedCount > 0 && (
            <label className="inline-flex min-h-[28px] cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={showUndated}
                onChange={(e) => onShowUndatedChange(e.target.checked)}
              />
              {t('timeline.showUndated')}
            </label>
          )}
        </>
      )}
    </div>
  );
}
