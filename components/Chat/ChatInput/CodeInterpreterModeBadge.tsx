import { IconCode } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import { CodeInterpreterMode } from '@/types/codeInterpreter';

interface CodeInterpreterModeBadgeProps {
  mode: CodeInterpreterMode;
  onRemove: () => void;
}

/**
 * Badge component that displays when Code Interpreter is forced for this message.
 * Only shows when codeInterpreterMode === ALWAYS (per-message override active).
 * Clicking the X removes the badge and reverts to conversation default.
 */
export const CodeInterpreterModeBadge: React.FC<
  CodeInterpreterModeBadgeProps
> = ({ mode, onRemove }) => {
  const t = useTranslations();

  // Only render when ALWAYS mode is active (per-message override)
  // INTELLIGENT mode is the conversation default, so no badge needed
  if (mode !== CodeInterpreterMode.ALWAYS) {
    return null;
  }

  const modeLabel = t('codeInterpreter.modeForced');

  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-full text-sm font-medium border border-green-300 dark:border-green-700">
      <IconCode className="w-5 h-5 text-green-600 dark:text-green-400" />
      <span>{modeLabel}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 hover:bg-green-200 dark:hover:bg-green-800 rounded-full p-0.5 transition-colors"
        aria-label={t('codeInterpreter.disable')}
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
