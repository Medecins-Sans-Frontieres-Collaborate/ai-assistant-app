'use client';

import { IconClipboardText, IconX } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import type { PastedTextChip } from '@/client/hooks/workflows/usePastedTextChips';

interface PastedTextChipsProps {
  chips: PastedTextChip[];
  onRemove: (id: string) => void;
}

/**
 * The held pastes shown above a workflow composer. Renders nothing when
 * empty so composers can mount it unconditionally.
 */
export const PastedTextChips: FC<PastedTextChipsProps> = ({
  chips,
  onRemove,
}) => {
  const t = useTranslations('pastedText');

  if (chips.length === 0) return null;

  return (
    <ul className="mb-2 flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <li
          key={chip.id}
          className="flex max-w-full items-center gap-1.5 rounded-md border border-gray-300 bg-gray-100 py-1 ps-2 pe-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300"
        >
          <IconClipboardText size={14} className="shrink-0" aria-hidden />
          <span className="truncate" title={chip.name}>
            {chip.name}
          </span>
          <span className="shrink-0 text-gray-500 dark:text-gray-400">
            {t('charCount', { count: chip.chars })}
          </span>
          <button
            type="button"
            onClick={() => onRemove(chip.id)}
            aria-label={t('removeChip', { name: chip.name })}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-surface-dark-base dark:hover:text-gray-100"
          >
            <IconX size={12} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
};
