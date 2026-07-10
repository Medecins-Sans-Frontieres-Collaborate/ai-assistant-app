'use client';

import {
  IconCamera,
  IconFileSpreadsheet,
  IconFileTextAi,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { fetchImageBase64FromMessageContent } from '@/lib/services/imageService';

import { DataSourceRecord } from '@/types/workflow';

interface SourcesStripProps {
  sources: DataSourceRecord[];
  activeSourceId?: string;
  onOpenSource: (sourceId: string) => void;
}

/** Lazy thumbnail for a photo source's first image. */
function PhotoThumb({ imageUrl }: { imageUrl: string }) {
  const [base64, setBase64] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchImageBase64FromMessageContent({
      type: 'image_url',
      image_url: { url: imageUrl, detail: 'auto' },
    }).then((data) => {
      if (!cancelled && data) setBase64(data);
    });
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  if (!base64) {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded bg-gray-200 dark:bg-surface-dark-elevated">
        <IconCamera size={13} aria-hidden className="text-gray-500" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={base64}
      alt=""
      className="h-6 w-6 rounded object-cover"
      aria-hidden
    />
  );
}

/**
 * Where the data came from: one chip per source, photo sources with a
 * thumbnail that opens the QC pane (photo beside its rows). Sources
 * were recorded from day one but never surfaced until now.
 */
export function SourcesStrip({
  sources,
  activeSourceId,
  onOpenSource,
}: SourcesStripProps) {
  const t = useTranslations('workflows.data');
  if (sources.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 px-3 py-1.5 dark:border-gray-700">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('sourcesLabel')}
      </span>
      {sources.map((source) => {
        const isPhoto =
          source.kind === 'photo' &&
          !!source.imageFileUrls &&
          source.imageFileUrls.length > 0;
        const chipContent = (
          <>
            {isPhoto ? (
              <PhotoThumb imageUrl={source.imageFileUrls![0]} />
            ) : source.kind === 'extraction' ? (
              <IconFileTextAi size={13} aria-hidden className="text-gray-500" />
            ) : (
              <IconFileSpreadsheet
                size={13}
                aria-hidden
                className="text-gray-500"
              />
            )}
            <span className="max-w-40 truncate">{source.name}</span>
            <span className="tabular-nums text-gray-400">
              {source.rowCount}
            </span>
          </>
        );
        if (!isPhoto) {
          return (
            <span
              key={source.id}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-1.5 py-1 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400"
              title={source.name}
            >
              {chipContent}
            </span>
          );
        }
        return (
          <button
            key={source.id}
            type="button"
            onClick={() => onOpenSource(source.id)}
            aria-pressed={source.id === activeSourceId}
            title={t('openPhotoQc', { name: source.name })}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-1 text-xs ${
              source.id === activeSourceId
                ? 'border-blue-400 bg-blue-50 text-blue-900 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-200'
                : 'border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-surface-dark-elevated'
            }`}
          >
            {chipContent}
          </button>
        );
      })}
    </div>
  );
}
