'use client';

import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
} from '@tabler/icons-react';

import { useLocale, useTranslations } from 'next-intl';

import {
  TimelineScale,
  msToStep,
  segmentAtStep,
  segmentLabel,
  stepToMs,
} from '@/lib/utils/shared/geo/timelineScale';

interface TimelineControlProps {
  scale: TimelineScale;
  timeMs: number;
  onTimeChange: (ms: number) => void;
  playing: boolean;
  onPlayToggle: () => void;
  showUndated: boolean;
  onShowUndatedChange: (value: boolean) => void;
  /** Features active at the current time (after filters). */
  activeCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The time-lapse bar: play/pause, a scrubbable range input over the
 * piecewise scale's STEP INDICES (uniform slider space per step — dense
 * eras get the track share their data deserves, historical mentions get
 * slim clickable slices), the current date, and the undated toggle.
 * With multiple eras a segment strip renders above the slider: era
 * labels, proportional widths, click to jump. The strip is
 * navigational, not a pixel-accurate ruler (native range thumb geometry
 * makes exact alignment impossible).
 */
export function TimelineControl({
  scale,
  timeMs,
  onTimeChange,
  playing,
  onPlayToggle,
  showUndated,
  onShowUndatedChange,
  activeCount,
}: TimelineControlProps) {
  const t = useTranslations('workflows');
  const locale = useLocale();

  const currentIndex = msToStep(scale, timeMs);
  const currentSegment = segmentAtStep(scale, currentIndex);
  const multiEra = scale.segments.length > 1;

  const formatTick = (ms: number, stepMs: number) => {
    // Label precision follows the ACTIVE segment's step size: daily
    // steps show days, coarser steps show months.
    const options: Intl.DateTimeFormatOptions =
      stepMs <= DAY_MS
        ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
        : { year: 'numeric', month: 'short', timeZone: 'UTC' };
    return new Intl.DateTimeFormat(locale, options).format(ms);
  };

  const currentLabel = formatTick(timeMs, currentSegment.stepMs);

  return (
    <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-700">
      {multiEra && (
        <div
          role="group"
          aria-label={t('map.timeline.eras')}
          className="mb-1.5 flex items-center gap-1 ps-11"
        >
          {scale.segments.map((segment, index) => {
            const label = segmentLabel(segment, locale);
            const active = segment === currentSegment;
            return (
              <span key={segment.firstStepIndex} className="contents">
                {index > 0 && (
                  <span
                    aria-hidden
                    className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500"
                  >
                    ··
                  </span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    onTimeChange(stepToMs(scale, segment.firstStepIndex))
                  }
                  aria-label={t('map.timeline.jumpTo', { label })}
                  aria-current={active ? 'true' : undefined}
                  style={{ flexGrow: segment.stepCount }}
                  className={`min-w-10 truncate rounded px-1 py-0.5 text-center text-[11px] tabular-nums ${
                    active
                      ? 'bg-blue-100 font-medium text-blue-900 dark:bg-blue-900/30 dark:text-blue-200'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-surface-dark-elevated dark:text-gray-400 dark:hover:bg-gray-700'
                  }`}
                >
                  {label}
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={onPlayToggle}
          aria-label={
            playing ? t('map.timeline.pause') : t('map.timeline.play')
          }
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-900 hover:bg-gray-300 dark:bg-surface-dark-elevated dark:text-gray-100 dark:hover:bg-gray-700"
        >
          {playing ? (
            <IconPlayerPauseFilled size={14} aria-hidden />
          ) : (
            <IconPlayerPlayFilled size={14} aria-hidden />
          )}
        </button>

        {!multiEra && (
          <span className="w-20 shrink-0 text-xs text-gray-500 dark:text-gray-400">
            {formatTick(scale.minMs, currentSegment.stepMs)}
          </span>
        )}
        <input
          type="range"
          min={0}
          max={scale.totalSteps - 1}
          step={1}
          value={currentIndex}
          onChange={(e) =>
            onTimeChange(stepToMs(scale, Number(e.target.value)))
          }
          aria-label={t('map.timeline.slider')}
          aria-valuetext={currentLabel}
          className="min-w-[120px] flex-1 accent-blue-600"
        />
        {!multiEra && (
          <span className="w-20 shrink-0 text-xs text-gray-500 dark:text-gray-400">
            {formatTick(scale.maxMs, currentSegment.stepMs)}
          </span>
        )}

        <span className="text-sm font-medium tabular-nums text-gray-900 dark:text-gray-100">
          {currentLabel}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {t('map.timeline.activeCount', { count: String(activeCount) })}
        </span>

        <label className="ms-auto inline-flex min-h-[32px] cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={showUndated}
            onChange={(e) => onShowUndatedChange(e.target.checked)}
          />
          {t('map.timeline.showUndated')}
        </label>
      </div>
    </div>
  );
}
