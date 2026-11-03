'use client';

import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useGroupNames } from '@/client/hooks/useGroupNames';

import type { AdminStoredRule } from './types';

interface AccessSummaryProps {
  /** Absent rules mean no additional app-level restriction. */
  access?: AdminStoredRule['rule']['access'];
}

const PREVIEW_LIMIT = 3;

/**
 * Shows the actual audiences allowed by a rule, not just its access type.
 * Group names use the shared batched cache; unavailable names retain their
 * IDs. Large audiences can be expanded without opening the rule editor.
 * This is presentation only and does not imply Azure or file permissions.
 */
export const AccessSummary: FC<AccessSummaryProps> = ({ access }) => {
  const t = useTranslations('agentAccess');
  const [expanded, setExpanded] = useState(false);
  const restricted = access?.type === 'restricted';
  const groupIds = restricted ? (access.allowGroups ?? []) : [];
  const groupNames = useGroupNames(groupIds);
  const audiences = restricted
    ? [
        { label: t('allowDomainsLabel'), values: access.allowDomains ?? [] },
        { label: t('allowUsersLabel'), values: access.allowUsers ?? [] },
        { label: t('groupsLabel'), values: groupIds, groups: true },
      ].filter((audience) => audience.values.length > 0)
    : [];
  const total = audiences.reduce(
    (count, audience) => count + audience.values.length,
    0,
  );
  const hasMore = audiences.some(
    (audience) => audience.values.length > PREVIEW_LIMIT,
  );

  return (
    <div className="mt-2 min-w-0 text-xs text-gray-700 dark:text-gray-300">
      {!restricted ? (
        <p title={t('everyoneDescription')}>
          <span className="font-medium">{t('accessTypeLabel')}:</span>{' '}
          {t('accessEveryone')}
        </p>
      ) : audiences.length === 0 ? (
        <p className="break-words text-amber-800 dark:text-amber-300">
          {t('restrictedEmptyWarning')}
        </p>
      ) : (
        <dl className="space-y-1">
          {audiences.map((audience) => (
            <div
              key={audience.label}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
            >
              <dt className="font-medium">
                {audience.label} ({audience.values.length}):
              </dt>
              <dd className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
                {(expanded
                  ? audience.values
                  : audience.values.slice(0, PREVIEW_LIMIT)
                ).map((value) => (
                  <span
                    key={value}
                    title={value}
                    dir="auto"
                    className="min-w-0 max-w-full [overflow-wrap:anywhere]"
                  >
                    {audience.groups ? (groupNames[value] ?? value) : value}
                  </span>
                ))}
                {!expanded && audience.values.length > PREVIEW_LIMIT && (
                  <span>+{audience.values.length - PREVIEW_LIMIT}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {hasMore && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 min-h-11 rounded-md px-2 text-xs underline underline-offset-2 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 dark:hover:bg-gray-800"
        >
          {expanded
            ? t('m365PlanHideDetails')
            : `${t('accessTypeLabel')} (${total})`}
        </button>
      )}
    </div>
  );
};
