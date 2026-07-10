'use client';

import { IconMapPin, IconX } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { formatFeatureDates } from '@/lib/utils/shared/geo/eventTime';
import {
  featureGranularity,
  isAreaFeature,
} from '@/lib/utils/shared/geo/granularity';

import { MapFeature } from '@/types/workflow';

const CONFIDENCE_BADGE: Record<MapFeature['confidence'], string> = {
  high: 'bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-200',
  medium:
    'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  low: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
};

interface FeatureListProps {
  features: MapFeature[];
  /** Container areas demoted to outline-only on the map. */
  demotedIds?: Set<string>;
  /** Rows dimmed (undated features during a time-lapse sweep). */
  faintIds?: Set<string>;
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
}

export function FeatureList({
  features,
  demotedIds,
  faintIds,
  onFocus,
  onRemove,
}: FeatureListProps) {
  const t = useTranslations('workflows');
  const tMap = useTranslations('workflows.map');
  const locale = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Virtualized: the list can hold up to the 2000-feature cap; a plain
  // <ul> of complex rows is the largest DOM cost in the whole workspace.
  const virtualizer = useVirtualizer({
    count: features.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 10,
  });

  if (features.length === 0) return null;

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <ul
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const feature = features[virtualRow.index];
          const isMention = feature.prominence === 'mention';
          const isArea = isAreaFeature(feature);
          const isDemoted = demotedIds?.has(feature.id) ?? false;
          const dateLine = formatFeatureDates(feature, locale, tMap);
          const isFaint = faintIds?.has(feature.id) ?? false;
          return (
            <li
              key={feature.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
              className={`absolute left-0 top-0 flex w-full items-start gap-1 border-b border-gray-100 px-2 py-1 dark:border-gray-800 ${isFaint ? 'opacity-40' : ''}`}
            >
              {/* The whole row focuses the map on the point. */}
              <button
                type="button"
                onClick={() => onFocus(feature.id)}
                aria-label={t('map.flyTo', { name: feature.name })}
                className={`flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1 text-start hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:hover:bg-surface-dark-elevated ${
                  isMention ? 'opacity-75' : ''
                }`}
              >
                <IconMapPin
                  size={15}
                  aria-hidden
                  className="mt-0.5 shrink-0 text-gray-500 dark:text-gray-400"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                      {feature.name}
                    </span>
                    {isArea && (
                      <span
                        className="rounded-sm bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-surface-dark-elevated dark:text-gray-400"
                        title={
                          isDemoted
                            ? t('map.containerHint')
                            : t('map.granularityAreaHint')
                        }
                      >
                        {t(`map.granularity.${featureGranularity(feature)}`)}
                      </span>
                    )}
                    {isMention && (
                      <span
                        className="rounded-sm bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-surface-dark-elevated dark:text-gray-400"
                        title={t('map.prominenceMentionHint')}
                      >
                        {t('map.prominence.mention')}
                      </span>
                    )}
                    <span
                      className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${CONFIDENCE_BADGE[feature.confidence]}`}
                      title={
                        feature.confidenceReason ||
                        t(`map.confidence.${feature.confidence}`)
                      }
                    >
                      {t(`map.confidence.${feature.confidence}`)}
                    </span>
                    {feature.category && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {feature.category}
                      </span>
                    )}
                  </span>
                  {feature.description && (
                    <span className="mt-0.5 block truncate text-xs text-gray-600 dark:text-gray-400">
                      {feature.description}
                    </span>
                  )}
                  {dateLine && (
                    <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-500">
                      {dateLine}
                    </span>
                  )}
                  {feature.confidence !== 'high' &&
                    feature.confidenceReason && (
                      <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-400">
                        {feature.confidenceReason}
                      </span>
                    )}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onRemove(feature.id)}
                className="mt-1 shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-surface-dark-elevated dark:hover:text-gray-200"
                aria-label={t('map.removeFeature', { name: feature.name })}
              >
                <IconX size={14} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
