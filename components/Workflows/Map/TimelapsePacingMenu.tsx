'use client';

import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
import { useCallback, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import useEnhancedOutsideClick from '@/client/hooks/ui/useEnhancedOutsideClick';

import {
  CARD_DURATION_MAX_MS,
  CARD_DURATION_MIN_MS,
  CARD_DURATION_STEP_MS,
  MAX_CARDS_MAX,
  MAX_CARDS_MIN,
  MapTimelapseSettings,
} from '@/lib/utils/shared/geo/timelapsePacing';

interface TimelapsePacingMenuProps {
  pacing: MapTimelapseSettings;
  onChange: (settings: Partial<MapTimelapseSettings>) => void;
}

/**
 * Pacing controls for the time-lapse, tucked behind a button in the timeline
 * bar rather than in global settings: how long is long enough depends on the
 * map in front of you, so the knobs belong where you can watch the effect
 * while you turn them. The values themselves persist (settings store) —
 * they describe the viewer, not the map.
 */
export function TimelapsePacingMenu({
  pacing,
  onChange,
}: TimelapsePacingMenuProps) {
  const t = useTranslations('workflows.map.timeline.pacing');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useEnhancedOutsideClick(containerRef, close, open);

  const seconds = (pacing.cardDurationMs / 1000).toFixed(1);

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={t('toggle')}
        title={t('toggle')}
        className={`flex h-8 w-8 items-center justify-center rounded-full ${
          open
            ? 'bg-blue-600 text-white'
            : 'text-gray-600 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700'
        }`}
      >
        <IconAdjustmentsHorizontal size={15} aria-hidden />
      </button>

      {open && (
        <div
          role="group"
          aria-label={t('toggle')}
          className="absolute bottom-full start-0 z-[1000] mb-2 w-64 rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-surface-dark"
        >
          <label className="block text-xs text-gray-600 dark:text-gray-400">
            <span className="flex items-center justify-between gap-2">
              {t('cardDuration')}
              <span className="tabular-nums text-gray-900 dark:text-gray-100">
                {t('seconds', { seconds })}
              </span>
            </span>
            <input
              type="range"
              min={CARD_DURATION_MIN_MS}
              max={CARD_DURATION_MAX_MS}
              step={CARD_DURATION_STEP_MS}
              value={pacing.cardDurationMs}
              onChange={(e) =>
                onChange({ cardDurationMs: Number(e.target.value) })
              }
              className="mt-1 w-full accent-blue-600"
            />
          </label>

          <label className="mt-3 block text-xs text-gray-600 dark:text-gray-400">
            <span className="flex items-center justify-between gap-2">
              {t('maxCards')}
              <span className="tabular-nums text-gray-900 dark:text-gray-100">
                {pacing.maxCardsPerDate}
              </span>
            </span>
            <input
              type="range"
              min={MAX_CARDS_MIN}
              max={MAX_CARDS_MAX}
              step={1}
              value={pacing.maxCardsPerDate}
              onChange={(e) =>
                onChange({ maxCardsPerDate: Number(e.target.value) })
              }
              className="mt-1 w-full accent-blue-600"
            />
          </label>

          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
            {t('hint')}
          </p>
        </div>
      )}
    </div>
  );
}
