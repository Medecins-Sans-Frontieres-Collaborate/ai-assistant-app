'use client';

import {
  IconChevronDown,
  IconChevronRight,
  IconShieldCheck,
} from '@tabler/icons-react';
import { FC, useId, useState } from 'react';

import { useTranslations } from 'next-intl';

import { ScopedDelegationView } from '@/client/hooks/settings/useLimitsAdmin';

import { OverrideScope } from '@/lib/services/limits/types';

import {
  ADMIN_CARD,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import {
  isMailAnchored,
  summarizeJurisdiction,
} from '@/components/Limits/jurisdiction';
import { LIMITS_CHIP_WARN } from '@/components/Limits/limitsClasses';
import { jurisdictionLine } from '@/components/Limits/summaries';

interface ScopeSummaryProps {
  delegations: ScopedDelegationView[];
  /**
   * Stick to the top of AdminShell's scroll container. Needs the opaque
   * page-plane background or content scrolls visibly beneath it.
   */
  sticky?: boolean;
}

/** The list-valued buckets of a JurisdictionSummary (never its flags). */
type SummaryBucket = 'domains' | 'users' | 'groups' | 'attributes';

const BUCKETS: Array<{ scope: OverrideScope; key: SummaryBucket }> = [
  { scope: 'domain', key: 'domains' },
  { scope: 'user', key: 'users' },
  { scope: 'group', key: 'groups' },
  { scope: 'attribute', key: 'attributes' },
];

/**
 * "Your scope, always visible" (design §6b): the jurisdiction(s) a scoped
 * admin is confined to. Collapsed it is one line per delegation; expanded it
 * lists every target as a chip. Never hidden — the scope of a change must
 * be a glance away, so the collapse only trades detail for height.
 */
export const ScopeSummary: FC<ScopeSummaryProps> = ({
  delegations,
  sticky = false,
}) => {
  const t = useTranslations('limits');
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <section
      aria-labelledby={headingId}
      className={
        sticky
          ? 'sticky top-0 z-10 -mx-6 mb-4 bg-white px-6 pb-2 pt-1 dark:bg-surface-dark-base'
          : 'mb-4'
      }
    >
      <div className={ADMIN_CARD}>
        <div className="flex flex-wrap items-center gap-2">
          <IconShieldCheck
            size={16}
            className="text-gray-500 dark:text-gray-400"
            aria-hidden="true"
          />
          <h2
            id={headingId}
            className="text-sm font-semibold text-black dark:text-white"
          >
            {t('yourScopeTitle')}
          </h2>
          <button
            type="button"
            className="ml-auto flex items-center gap-1 rounded text-xs text-gray-500 hover:text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-white"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <IconChevronDown size={14} aria-hidden="true" />
            ) : (
              <IconChevronRight size={14} aria-hidden="true" />
            )}
            {expanded ? t('yourScopeShowLess') : t('yourScopeShowAll')}
          </button>
        </div>

        {delegations.length === 0 && (
          <p className={`mt-2 ${ADMIN_MUTED}`}>{t('yourScopeNone')}</p>
        )}

        <ul className="mt-2 space-y-2">
          {delegations.map((delegation) => {
            const summary = summarizeJurisdiction(delegation.jurisdiction);
            const anchored = isMailAnchored(delegation.jurisdiction);
            return (
              <li key={delegation.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-black dark:text-white">
                    {delegation.label || t('untitledDelegation')}
                  </span>
                  {!delegation.enabled && (
                    <span className={ADMIN_CHIP_NEUTRAL}>
                      {t('delegationDisabledChip')}
                    </span>
                  )}
                  {!anchored && (
                    <span className={LIMITS_CHIP_WARN}>
                      {t('yourScopeGroupOnlyChip')}
                    </span>
                  )}
                  {!expanded && (
                    <span className={ADMIN_MUTED}>
                      {jurisdictionLine(t, delegation.jurisdiction)}
                    </span>
                  )}
                </div>
                {expanded && (
                  <div className="mt-1 space-y-1">
                    {BUCKETS.map(({ scope, key }) => {
                      const values = summary[key];
                      if (values.length === 0) return null;
                      return (
                        <div
                          key={scope}
                          className="flex flex-wrap items-center gap-1"
                        >
                          <span className={ADMIN_MUTED}>
                            {t(`scope.${scope}` as never)}:
                          </span>
                          {values.map((value) => (
                            <span key={value} className={ADMIN_CHIP_NEUTRAL}>
                              {value}
                            </span>
                          ))}
                        </div>
                      );
                    })}
                    {!anchored && (
                      <p className={ADMIN_MUTED}>
                        {t('yourScopeGroupOnlyNote')}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
};
