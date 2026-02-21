import { IconCode, IconInfoCircle } from '@tabler/icons-react';
import React, { FC } from 'react';

import { useTranslations } from 'next-intl';

interface CodeInterpreterSectionProps {
  codeInterpreterEnabled: boolean;
  handleToggleCodeInterpreterMode: () => void;
}

/**
 * Code Interpreter section for the Model Select modal.
 * Provides a simple toggle to enable/disable Code Interpreter Smart mode.
 * When enabled, AI decides when to use Python code execution based on the query.
 */
export const CodeInterpreterSection: FC<CodeInterpreterSectionProps> = ({
  codeInterpreterEnabled,
  handleToggleCodeInterpreterMode,
}) => {
  const t = useTranslations();

  return (
    <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <IconCode size={20} className="text-gray-600 dark:text-gray-400" />
          <div>
            <div className="font-medium text-gray-900 dark:text-white">
              {t('modelSelect.codeInterpreter.title')}
            </div>
            <div className="text-xs text-gray-600 dark:text-gray-400">
              {t('modelSelect.codeInterpreter.subtitle')}
            </div>
          </div>
        </div>
        <button
          onClick={handleToggleCodeInterpreterMode}
          className="flex items-center"
        >
          <div
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              codeInterpreterEnabled
                ? 'bg-green-600'
                : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                codeInterpreterEnabled
                  ? 'translate-x-6 rtl:-translate-x-6'
                  : 'translate-x-1 rtl:-translate-x-1'
              }`}
            />
          </div>
        </button>
      </div>

      {codeInterpreterEnabled && (
        <div className="space-y-3 pt-3 border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <IconInfoCircle
              size={20}
              className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5"
            />
            <div className="flex-1">
              <div className="text-sm text-green-800 dark:text-green-200">
                {t('modelSelect.codeInterpreter.smartModeDescription')}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
