import { IconCode } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

interface InterpreterModeBadgeProps {
  onRemove: () => void;
}

/**
 * Badge shown while code execution is forced (InterpreterMode.ALWAYS).
 * Mirrors SearchModeBadge: visual indicator + one-click removal back to
 * the conversation's default mode.
 */
export const InterpreterModeBadge: React.FC<InterpreterModeBadgeProps> = ({
  onRemove,
}) => {
  const t = useTranslations();

  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full text-sm font-medium border border-gray-300 dark:border-gray-600">
      <IconCode className="w-5 h-5 text-emerald-600" />
      <span>{t('chat.interpreterBadge')}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-full p-1 transition-colors"
        aria-label={t('chat.disableCodeInterpreter')}
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
