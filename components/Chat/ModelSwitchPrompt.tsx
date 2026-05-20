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
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-blue-50 dark:bg-blue-900 border border-blue-200 dark:border-blue-700 rounded-lg shadow-lg p-4 max-w-md">
      <div className="flex items-start justify-between mb-3">
        <p className="text-sm text-blue-800 dark:text-blue-200 pr-2">
          {t('chat.modelSwitchPrompt', {
            original: originalModelName,
            fallback: fallbackModelName,
          })}
        </p>
        <button
          onClick={onKeepOriginal}
          className="text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-100 transition-colors flex-shrink-0"
          aria-label={t('common.close')}
        >
          <IconX size={18} />
        </button>
      </div>
      <div className="flex flex-wrap gap-2 justify-end">
        <button
          onClick={onKeepOriginal}
          className="px-3 py-1.5 text-sm text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800 rounded transition-colors"
        >
          {t('chat.keepOriginalModel', { model: originalModelName })}
        </button>
        <button
          onClick={onSwitchModel}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
        >
          {t('chat.switchToModel', { model: fallbackModelName })}
        </button>
        <button
          onClick={onAlwaysSwitch}
          className="px-3 py-1.5 text-sm bg-blue-800 text-white rounded hover:bg-blue-900 transition-colors"
        >
          {t('chat.alwaysSwitchToModel', { model: fallbackModelName })}
        </button>
      </div>
    </div>
  );
};
