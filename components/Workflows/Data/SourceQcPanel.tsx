'use client';

import {
  IconChevronLeft,
  IconChevronRight,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { fetchImageBase64FromMessageContent } from '@/lib/services/imageService';

import { DataSourceRecord } from '@/types/workflow';

interface SourceQcPanelProps {
  source: DataSourceRecord;
  onClose: () => void;
}

const ZOOM_LEVELS = [1, 1.5, 2, 3, 4];

/**
 * Manual data-quality checking for photo ingests: the source photo,
 * zoomable, beside the grid — which the workspace filters to this
 * source's rows while the pane is open. Multi-photo batches navigate
 * between their photos.
 */
export function SourceQcPanel({ source, onClose }: SourceQcPanelProps) {
  const t = useTranslations('workflows.data');
  const imageUrls = source.imageFileUrls ?? [];
  const [index, setIndex] = useState(0);
  const [zoomIndex, setZoomIndex] = useState(0);
  // One state slot keyed by url: a stale entry (url mismatch) IS the
  // loading state, so the effect never sets state synchronously.
  const [loaded, setLoaded] = useState<{
    url: string;
    data: string | null;
  } | null>(null);

  const currentUrl = imageUrls[Math.min(index, imageUrls.length - 1)];

  useEffect(() => {
    if (!currentUrl) return;
    let cancelled = false;
    void fetchImageBase64FromMessageContent({
      type: 'image_url',
      image_url: { url: currentUrl, detail: 'auto' },
    }).then((data) => {
      if (!cancelled) setLoaded({ url: currentUrl, data: data || null });
    });
    return () => {
      cancelled = true;
    };
  }, [currentUrl]);

  const current = loaded?.url === currentUrl ? loaded : null;
  const base64 = current?.data ?? null;
  const failed = current !== null && current.data === null;
  const zoom = ZOOM_LEVELS[zoomIndex];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h3
          className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-gray-100"
          title={source.name}
        >
          {source.name}
        </h3>
        <span className="shrink-0 rounded-sm bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-900 dark:bg-blue-900/30 dark:text-blue-200">
          {t('qcRowsFromPhoto', { count: String(source.rowIds?.length ?? 0) })}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('qcClose')}
          className="ms-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconX size={15} aria-hidden />
        </button>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 border-b border-gray-200 px-3 py-1.5 dark:border-gray-700">
        <button
          type="button"
          onClick={() => setZoomIndex((z) => Math.max(0, z - 1))}
          disabled={zoomIndex === 0}
          aria-label={t('qcZoomOut')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconZoomOut size={15} aria-hidden />
        </button>
        <span className="w-10 text-center text-xs tabular-nums text-gray-500 dark:text-gray-400">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() =>
            setZoomIndex((z) => Math.min(ZOOM_LEVELS.length - 1, z + 1))
          }
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          aria-label={t('qcZoomIn')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconZoomIn size={15} aria-hidden />
        </button>
        {imageUrls.length > 1 && (
          <div className="ms-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              aria-label={t('qcPrevPhoto')}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
            >
              <IconChevronLeft size={15} aria-hidden />
            </button>
            <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
              {index + 1}/{imageUrls.length}
            </span>
            <button
              type="button"
              onClick={() =>
                setIndex((i) => Math.min(imageUrls.length - 1, i + 1))
              }
              disabled={index === imageUrls.length - 1}
              aria-label={t('qcNextPhoto')}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
            >
              <IconChevronRight size={15} aria-hidden />
            </button>
          </div>
        )}
      </div>

      {/* Photo (scrollable when zoomed) */}
      <div className="min-h-0 flex-1 overflow-auto bg-gray-100 dark:bg-surface-dark-recessed">
        {failed ? (
          <p className="p-4 text-sm text-red-700 dark:text-red-400">
            {t('qcImageFailed')}
          </p>
        ) : !base64 ? (
          <p className="p-4 text-sm text-gray-500 dark:text-gray-400">
            {t('qcImageLoading')}
          </p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={base64}
            alt={t('qcImageAlt', { name: source.name })}
            style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
            className="block"
          />
        )}
      </div>

      <p className="border-t border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {t('qcHint')}
      </p>
    </div>
  );
}
