import { IconVolume } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import { Tone } from '@/types/tone';

interface ToneBadgeProps {
  toneId: string;
  tones: Tone[];
  onRemove: () => void;
}

/**
 * Badge component that displays the selected tone
 * Shows the tone name and allows removal
 */
export const ToneBadge: React.FC<ToneBadgeProps> = ({
  toneId,
  tones,
  onRemove,
}) => {
  const t = useTranslations();
  const toneName = tones.find((t) => t.id === toneId)?.name || 'Tone';

  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full text-sm font-medium border border-gray-300 dark:border-gray-600">
      <IconVolume className="w-5 h-5 text-purple-500" />
      <span>{toneName}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-full p-0.5 transition-colors"
        aria-label={t('chat.removeTone')}
      >
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
};
