import { IconX } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

interface ModelSwitchPromptProps {
  originalModelName: string;
  fallbackModelName: string;
  onKeepOriginal: () => void;
  onSwitchModel: () => void;
  onAlwaysSwitch: () => void;
}

/**
 * ModelSwitchPrompt component
 * Shown after a successful retry with fallback model, asking user if they want to switch
 */
export const ModelSwitchPrompt: React.FC<ModelSwitchPromptProps> = ({
  originalModelName,
  fallbackModelName,
  onKeepOriginal,
  onSwitchModel,
  onAlwaysSwitch,
}) => {
  const t = useTranslations();

  return (
    <div
      role="dialog"
      aria-labelledby="model-switch-prompt-message"
      className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-neutral-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-4 max-w-md"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <p
          id="model-switch-prompt-message"
          className="text-sm text-gray-800 dark:text-gray-100"
        >
          {t('chat.modelSwitchPrompt', {
            original: originalModelName,
            fallback: fallbackModelName,
          })}
        </p>
        <button
          onClick={onKeepOriginal}
          className="-m-1 p-1 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors flex-shrink-0"
          aria-label={t('common.close')}
        >
          <IconX size={18} />
        </button>
      </div>
      <div className="flex flex-wrap gap-2 justify-end mb-2">
        <button
          onClick={onKeepOriginal}
          className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
        >
          {t('chat.keepOriginalModel', { model: originalModelName })}
        </button>
        <button
          onClick={onSwitchModel}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          {t('chat.switchToModel', { model: fallbackModelName })}
        </button>
      </div>
      <div className="flex justify-end">
        <button
          onClick={onAlwaysSwitch}
          className="text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 underline underline-offset-2 transition-colors"
        >
          {t('chat.alwaysSwitchToModel', { original: originalModelName })}
        </button>
      </div>
    </div>
  );
};
