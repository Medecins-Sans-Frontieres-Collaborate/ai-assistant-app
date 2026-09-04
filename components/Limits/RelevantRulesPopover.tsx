'use client';

import { IconInfoCircle } from '@tabler/icons-react';
import { FC, useId, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  ADMIN_CHIP_NEUTRAL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { RelevantRule } from '@/components/Limits/jurisdiction';
import { LIMITS_NOTE_CARD } from '@/components/Limits/limitsClasses';

interface RelevantRulesPopoverProps {
  /** Other rules that speak to this card's targets — self already excluded. */
  rules: RelevantRule[];
  /** Resolves a delegation id to its label for scoped overrides' chips. */
  delegationLabel?: (id: string) => string | undefined;
}

/**
 * The hover/click "other rules relevant to the same targets" affordance on a
 * delegation or override card (design §6a, overlap). Hover previews, click
 * pins — click is the accessible path, so the trigger carries
 * aria-expanded/aria-controls and Escape closes a pinned popover.
 *
 * Renders NOTHING when there are no relevant rules: the icon appearing is the
 * signal, and the overlap hint on the Delegations tab is the discoverable
 * entry point.
 */
export const RelevantRulesPopover: FC<RelevantRulesPopoverProps> = ({
  rules,
  delegationLabel,
}) => {
  const t = useTranslations('limits');
  const id = useId();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const open = pinned || hovered;

  if (rules.length === 0) return null;

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setPinned(false);
          setHovered(false);
        }
      }}
    >
      <button
        type="button"
        className="rounded p-1 text-gray-500 transition-colors hover:text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-white"
        onClick={() => setPinned((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={t('relevantRulesFor', { count: rules.length })}
      >
        <IconInfoCircle size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          role="tooltip"
          className={`absolute right-0 top-full z-20 mt-1 w-72 shadow-lg ${LIMITS_NOTE_CARD}`}
        >
          <p className="mb-1.5 text-xs font-semibold text-black dark:text-white">
            {t('relevantRulesTitle')}
          </p>
          <ul className="space-y-1.5">
            {rules.map((rule) => (
              <li key={`${rule.kind}-${rule.id}`} className="text-xs">
                <div className="flex flex-wrap items-center gap-1">
                  <span className={ADMIN_CHIP_NEUTRAL}>
                    {rule.kind === 'delegation'
                      ? t('relevantRulesDelegation')
                      : t('relevantRulesOverride')}
                  </span>
                  <span className="font-medium text-black dark:text-white">
                    {rule.label ||
                      (rule.kind === 'delegation'
                        ? t('untitledDelegation')
                        : t('untitledOverride'))}
                  </span>
                  {rule.kind === 'override' && rule.tier === 'scoped' && (
                    <span className={ADMIN_CHIP_NEUTRAL}>
                      {rule.delegationId && delegationLabel?.(rule.delegationId)
                        ? `${t('tierScoped')} · ${delegationLabel(rule.delegationId)}`
                        : t('tierScoped')}
                    </span>
                  )}
                  {!rule.enabled && (
                    <span className={ADMIN_CHIP_NEUTRAL}>
                      {t('overrideDisabledChip')}
                    </span>
                  )}
                </div>
                <div className={ADMIN_MUTED}>
                  {t('relevantRulesMatched', {
                    scope: t(`scope.${rule.scope}` as never),
                    targets: rule.matched.join(', '),
                  })}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
};
