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
  m365CapImmediateHelp:
    'Apply saves the limit immediately. Other edits still need Save.',
  m365CapDraftHelp: 'The limit is saved when you create the agent.',
  m365CapSaved: 'Document limit saved: {limit}.',
} as const;

const fallbackMessages: Record<string, string> = ADMIN_AGENT_LABELS;
const fallback = createTranslator({
  locale: 'en',
  messages: fallbackMessages,
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
