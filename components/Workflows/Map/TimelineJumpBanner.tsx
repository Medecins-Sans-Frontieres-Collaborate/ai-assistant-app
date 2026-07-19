'use client';

import { IconChevronsRight } from '@tabler/icons-react';

import { useLocale, useTranslations } from 'next-intl';

import { formatEventInstantLabel } from '@/lib/utils/shared/date/eventRange';
import { jumpDelta } from '@/lib/utils/shared/geo/timelineKeyframes';

import { EventPrecision } from '@/types/workflow';

import type { TimelineCue } from './useTimelinePlayback';

const DELTA_KEY = {
  years: 'jump.yearsLater',
  months: 'jump.monthsLater',
  days: 'jump.daysLater',
} as const;

/**
 * Dot count = how tightly the moment is pinned down. Filled dots read as
 * "we know this much", so an exactly-timed event shows a full row and a
 * bare year shows one — the same ranking the map's uncertainty halos use.
 */
const PRECISION_DOTS: Record<EventPrecision, number> = {
  minute: 5,
  hour: 4,
  day: 3,
  month: 2,
  year: 1,
};
const TOTAL_DOTS = 5;

/**
 * The date card shown over the map during a time-lapse sweep: where the
 * playhead just landed, how much time it skipped to get there, what changed,
 * and how precisely the material actually dated it. Without it a jump from
 * 1812 to 2026 is indistinguishable from a one-day step — the markers change
 * and nothing says why.
 *
 * The date renders at the keyframe's own precision, so a bare "1812" never
 * implies a January morning.
 */
export function TimelineJumpBanner({ cue }: { cue: TimelineCue }) {
  const t = useTranslations('workflows.map.timeline');
  const locale = useLocale();

  const { keyframe, index, total } = cue;
  const delta = jumpDelta(keyframe.deltaMs);
  const entering = keyframe.enteringIds.length;
  const exiting = keyframe.exitingIds.length;
  const dots = PRECISION_DOTS[keyframe.precision];
  // A moment that mixes an exact time with a bare year is worth flagging:
  // the label can only show one of them.
  const mixed = keyframe.precision !== keyframe.coarsestPrecision;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-2 z-[1000] flex justify-center px-2"
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        // Keyed by keyframe so every jump replays the entrance.
        key={index}
        className="motion-safe:animate-slide-down-reverse min-w-[9rem] max-w-[85%] rounded-lg border border-gray-200 bg-white/95 px-3 py-1.5 text-center shadow-lg backdrop-blur-sm dark:border-gray-700 dark:bg-surface-dark/95"
      >
        <p className="flex items-center justify-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
          {delta ? (
            <>
              <IconChevronsRight size={12} aria-hidden />
              {t(DELTA_KEY[delta.unit], { count: delta.count })}
            </>
          ) : (
            t('jump.start')
          )}
        </p>
        <p className="text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {formatEventInstantLabel(
            keyframe.labelMs,
            keyframe.precision,
            locale,
          )}
        </p>

        <p
          className="flex items-center justify-center gap-1 text-[11px] text-gray-500 dark:text-gray-400"
          title={t(`precision.${keyframe.precision}`)}
        >
          <span className="flex items-center gap-0.5" aria-hidden>
            {Array.from({ length: TOTAL_DOTS }, (_, i) => (
              <span
                key={i}
                className={`h-1 w-1 rounded-full ${
                  i < dots
                    ? 'bg-gray-500 dark:bg-gray-300'
                    : 'bg-gray-200 dark:bg-gray-600'
                }`}
              />
            ))}
          </span>
          {t(`precision.${keyframe.precision}`)}
          {mixed && ` ${t('precision.mixed')}`}
        </p>

        {(entering > 0 || exiting > 0) && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            {[
              entering > 0 ? t('jump.appears', { count: entering }) : null,
              exiting > 0 ? t('jump.ends', { count: exiting }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}

        {/* Sweep progress; a flex track so it fills from the start edge in
            both writing directions. */}
        <span className="mt-1 flex h-0.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <span
            className="h-full rounded-full bg-blue-600 transition-[width] duration-300 dark:bg-blue-500"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </span>
        <span className="sr-only">
          {t('jump.progress', { index: index + 1, total })}
        </span>
      </div>
    </div>
  );
}
