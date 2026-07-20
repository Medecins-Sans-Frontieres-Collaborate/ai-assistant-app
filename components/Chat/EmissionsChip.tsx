import { IconLeaf } from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversationEmissions } from '@/client/hooks/chat/useConversationEmissions';

import {
  ASSUMPTIONS_VERSION,
  activityDurationParts,
  estimateActivityEquivalents,
} from '@/lib/utils/shared/emissions';

import { Conversation } from '@/types/chat';

/** <1 g shows decimals ("0.42"); larger values round to whole grams. */
const formatGrams = (grams: number): string =>
  grams < 1
    ? grams.toFixed(2)
    : grams < 10
      ? grams.toFixed(1)
      : `${Math.round(grams)}`;

interface EmissionsChipProps {
  conversation: Conversation | null | undefined;
}

/**
 * Floating chip anchored bottom-right of the chat column showing the current
 * conversation's cumulative estimated CO2e. Hover/tap opens a breakdown
 * popover whose disclaimer states these are request-based estimates from
 * averages and assumptions — never measurements. Icon-only on mobile.
 */
export const EmissionsChip: FC<EmissionsChipProps> = ({ conversation }) => {
  const t = useTranslations();
  const { showUsageImpact } = useFlags();
  const summary = useConversationEmissions(conversation);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on tap/click outside (mobile has no hover-leave).
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Same fail-open gate as the Usage & Impact settings section.
  // if (showUsageImpact === false) return null;
  if (!summary || summary.totalG <= 0) return null;

  // Adaptive collapsed label: once there's activity today, show today's
  // figure (the actionable number for long-lived conversations, where the
  // lifetime total is a big static value); otherwise the conversation total.
  const showsToday = summary.todayRequests > 0;
  const collapsedLabel = formatGrams(
    showsToday ? summary.todayG : summary.totalG,
  );

  const row = (label: string, grams: number) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-gray-600 dark:text-gray-400">{label}</span>
      <span className="text-gray-900 dark:text-gray-100 shrink-0">
        {t('emissions.chip.label', { grams: formatGrams(grams) })}
      </span>
    </div>
  );

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
      className="relative"
    >
      {isOpen && (
        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-lg border border-gray-200 bg-white p-3 text-xs shadow-lg dark:border-gray-700 dark:bg-surface-dark z-[10000]">
          <p className="mb-2 font-semibold text-gray-900 dark:text-gray-100">
            {t('emissions.chip.title')}
          </p>
          <div className="space-y-1">
            {showsToday && row(t('emissions.chip.today'), summary.todayG)}
            {row(t('emissions.chip.total'), summary.totalG)}
            {summary.hasEstimated &&
              summary.measuredG > 0 &&
              row(t('emissions.chip.measured'), summary.measuredG)}
            {summary.hasEstimated &&
              row(t('emissions.chip.estimated'), summary.estimatedG)}
            {summary.lastRequestG != null &&
              row(t('emissions.chip.lastRequest'), summary.lastRequestG)}
          </div>
          <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">
            <p className="mb-1 font-medium text-gray-700 dark:text-gray-300">
              {t('emissions.equivalents.title')}
            </p>
            <div className="space-y-0.5">
              {estimateActivityEquivalents(summary.totalG).map((equivalent) => {
                const { unit, value } = activityDurationParts(
                  equivalent.seconds,
                );
                return (
                  <div
                    key={equivalent.key}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-gray-600 dark:text-gray-400">
                      {t(`emissions.activities.${equivalent.key}`)}
                    </span>
                    <span className="text-gray-900 dark:text-gray-100 shrink-0">
                      {t(`emissions.duration.${unit}`, { value })}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <p className="mt-2 border-t border-gray-200 pt-2 text-[10px] leading-snug text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {t('emissions.chip.disclaimer', { version: ASSUMPTIONS_VERSION })}
          </p>
        </div>
      )}
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-label={t(
          showsToday
            ? 'emissions.chip.ariaLabelToday'
            : 'emissions.chip.ariaLabel',
          { grams: collapsedLabel },
        )}
        className="flex h-9 items-center gap-1.5 rounded-full bg-gray-300 px-2.5 text-xs font-medium text-gray-800 shadow-md transition-shadow hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:bg-gray-700 dark:text-gray-200 dark:focus:ring-offset-gray-900"
      >
        <IconLeaf size={16} aria-hidden="true" />
        <span className="hidden md:inline">
          {t('emissions.chip.label', { grams: collapsedLabel })}
        </span>
      </button>
    </div>
  );
};
