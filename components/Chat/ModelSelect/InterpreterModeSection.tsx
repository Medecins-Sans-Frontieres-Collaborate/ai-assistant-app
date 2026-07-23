import { IconCode, IconInfoCircle } from '@tabler/icons-react';
import React, { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

interface InterpreterModeSectionProps {
  interpreterEnabled: boolean;
  handleToggleInterpreterMode: () => void;
}

/**
 * Default-on/off control for the code interpreter (sandboxed Python for
 * data analysis and charts). Mirrors SearchModeSection's toggle: on =
 * InterpreterMode.INTELLIGENT (auto-routed per message), off = never runs.
 * Forcing a run per-message lives in the composer's "+" menu instead.
 */
export const InterpreterModeSection: FC<InterpreterModeSectionProps> = ({
  interpreterEnabled,
  handleToggleInterpreterMode,
}) => {
  const t = useTranslations();
  // The capability description is reference material — hidden behind a
  // small "learn more" link so the section stays a single tidy toggle row.
  const [showInfo, setShowInfo] = useState(false);

  return (
    <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <IconCode size={20} className="text-gray-600 dark:text-gray-400" />
          <div>
            <div className="font-medium text-gray-900 dark:text-white">
              {t('modelSelect.interpreterMode.title')}
            </div>
            <div className="text-xs text-gray-600 dark:text-gray-400">
              {t('modelSelect.interpreterMode.subtitle')}
            </div>
          </div>
        </div>
        <button
          onClick={handleToggleInterpreterMode}
          className="flex items-center"
        >
          <div
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              interpreterEnabled
                ? 'bg-emerald-600'
                : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                interpreterEnabled
                  ? 'translate-x-6 rtl:-translate-x-6'
                  : 'translate-x-1 rtl:-translate-x-1'
              }`}
            />
          </div>
        </button>
      </div>

      {interpreterEnabled && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowInfo((v) => !v)}
            aria-expanded={showInfo}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:underline transition-colors"
          >
            <IconInfoCircle size={12} aria-hidden="true" />
            {t('modelSelect.interpreterMode.learnMore')}
          </button>
          {showInfo && (
            <p className="mt-2 text-xs leading-snug text-gray-600 dark:text-gray-400">
              {t('modelSelect.interpreterMode.description')}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
