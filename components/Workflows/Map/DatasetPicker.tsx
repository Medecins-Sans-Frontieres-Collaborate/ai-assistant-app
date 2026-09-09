'use client';

import { IconX } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { AvailableMapDataset } from '@/client/hooks/settings/useAvailableMapDatasets';

interface DatasetPickerProps {
  datasets: AvailableMapDataset[];
  onLoad: (dataset: AvailableMapDataset) => void;
  onClose: () => void;
  /** Id currently being fetched/loaded — its row shows a busy state. */
  loadingId: string | null;
  disabled?: boolean;
}

/**
 * Popover listing the admin-curated datasets this user may load into the
 * current map. Rendering is caller-gated (the button is hidden when the
 * list is empty), so this component always has rows.
 */
export function DatasetPicker({
  datasets,
  onLoad,
  onClose,
  loadingId,
  disabled,
}: DatasetPickerProps) {
  const t = useTranslations('workflows.map');

  return (
    <div
      role="dialog"
      aria-label={t('datasetPickerTitle')}
      className="absolute bottom-full end-0 z-[1000] mb-2 w-80 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-surface-dark"
    >
      <div className="mb-1 flex items-center justify-between px-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('datasetPickerTitle')}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('datasetPickerClose')}
          className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconX size={13} aria-hidden />
        </button>
      </div>
      <ul className="max-h-64 overflow-y-auto">
        {datasets.map((dataset) => (
          <li key={dataset.id}>
            <button
              type="button"
              onClick={() => onLoad(dataset)}
              disabled={disabled || loadingId !== null}
              className="w-full rounded-md px-2 py-1.5 text-start hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-surface-dark-elevated"
            >
              <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                {loadingId === dataset.id
                  ? t('datasetLoading', { name: dataset.name })
                  : dataset.name}
              </span>
              {dataset.description && (
                <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                  {dataset.description}
                </span>
              )}
              <span className="block text-xs text-gray-400 dark:text-gray-500">
                {t('datasetMeta', {
                  count: String(dataset.featureCount),
                  date: dataset.updatedAt.slice(0, 10),
                })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
