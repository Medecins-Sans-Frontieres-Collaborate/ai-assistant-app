import { IconX } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

interface ChatErrorProps {
  error: string | null;
  onClearError: () => void;
}

/**
 * ChatError component
 * Displays error messages with dismiss button
 */
export const ChatError: React.FC<ChatErrorProps> = ({
  error,
  onClearError,
}) => {
  const t = useTranslations();

  if (!error) return null;

  return (
    <div className="absolute bottom-[160px] left-0 right-0 px-4 py-2">
      <div className="mx-auto max-w-3xl rounded-lg bg-red-100 p-4 text-red-800 dark:bg-red-900 dark:text-red-200 flex items-start justify-between">
        <span className="flex-1">{error}</span>
        <button
          onClick={onClearError}
          className="ml-4 text-red-800 dark:text-red-200 hover:text-red-600 dark:hover:text-red-100 transition-colors flex-shrink-0"
          aria-label={t('errors.dismissError')}
        >
          <IconX size={20} />
        </button>
      </div>
    </div>
  );
};
