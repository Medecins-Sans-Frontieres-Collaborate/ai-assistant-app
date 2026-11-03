'use client';

import { useCallback } from 'react';

import { createTranslator, useTranslations } from 'next-intl';
import type { TranslationValues } from 'next-intl';

/** Small fallback catalog, kept in sync with the English agentAccess keys. */
export const ADMIN_AGENT_LABELS = {
  nativeLabel: 'Native',
  allEligibleUsers: 'All eligible users',
  noAllowedAudience: 'No allowed audience',
  accessScopeHint: 'App access rules only. Source permissions still apply.',
  detailsLabel: 'Details',
  indexedDocumentSummary:
    '{indexed, plural, one {# document} other {# documents}} indexed',
} as const;

const fallback = createTranslator({
  locale: 'en',
  messages: ADMIN_AGENT_LABELS,
});

/**
 * Uses localized admin strings, with a small English fallback for new labels
 * during rollout. Existing translations are unchanged; ICU plurals remain
 * formatted through next-intl, and no full English catalog enters the bundle.
 */
export function useAdminAgentTranslations() {
  const t = useTranslations('agentAccess');
  return useCallback(
    (key: string, values?: TranslationValues): string => {
      if (key in ADMIN_AGENT_LABELS && !t.has(key)) {
        return fallback(key as keyof typeof ADMIN_AGENT_LABELS, values);
      }
      return t(key, values);
    },
    [t],
  );
}
