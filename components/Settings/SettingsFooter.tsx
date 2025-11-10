import { IconExternalLink } from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import React, { FC } from 'react';

import { useTranslations } from 'next-intl';

import { FEEDBACK_EMAIL, US_FEEDBACK_EMAIL } from '@/types/contact';

interface SettingsFooterProps {
  version: string;
  build: string;
  env: string;
  userEmail?: string;
  handleReset?: () => void;
  onClose?: () => void;
}

export const SettingsFooter: FC<SettingsFooterProps> = ({
  version,
  build,
  env,
  userEmail,
  handleReset,
  onClose,
}) => {
  const t = useTranslations();
  const { data: session } = useSession();

  return (
    <div className="flex flex-col px-4 py-3 border-t border-gray-300 dark:border-neutral-700 rounded-b-lg">
      {/* Reset settings button - only visible on mobile */}
      {handleReset && onClose && (
        <button
          className="md:hidden w-full mb-3 p-2 border rounded-lg shadow border-neutral-500 text-neutral-900 hover:bg-neutral-100 focus:outline-none dark:border-neutral-800 dark:border-opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-300"
          onClick={() => {
            handleReset();
            onClose();
          }}
        >
          {t('Reset Settings')}
        </button>
      )}

      {/* Footer content */}
      <div className="flex flex-row justify-between items-center w-full">
        <div className="text-gray-500 text-sm">
          v{version}.{build}.{env}
        </div>
        <a
          href={`mailto:${
            session?.user?.region === 'US' ? US_FEEDBACK_EMAIL : FEEDBACK_EMAIL
          }`}
          className="flex items-center text-black dark:text-white text-sm hover:underline"
        >
          <IconExternalLink
            size={16}
            className={'inline mr-1 text-black dark:text-white'}
          />
          {t('sendFeedback')}
        </a>
      </div>
    </div>
  );
};
