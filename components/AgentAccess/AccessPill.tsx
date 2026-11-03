'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

interface AccessPillProps {
  restricted: boolean;
}

/**
 * The one access pill every admin list shows — "Everyone" or "Restricted" —
 * with the same colours and a tooltip saying what it is about, so that next
 * to a validation or indexing pill it still reads as the access state.
 */
export const AccessPill: FC<AccessPillProps> = ({ restricted }) => {
  const t = useTranslations('agentAccess');
  return (
    <span
      title={t('accessTypeLabel')}
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
        restricted
          ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
          : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
      }`}
    >
      {restricted ? t('accessRestricted') : t('accessEveryone')}
    </span>
  );
};
