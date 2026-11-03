import { render, screen } from '@testing-library/react';
import React from 'react';

import { NextIntlClientProvider } from 'next-intl';

import {
  ADMIN_AGENT_LABELS,
  useAdminAgentTranslations,
} from '@/components/AgentAccess/useAdminAgentTranslations';

import ar from '@/messages/ar.json';
import de from '@/messages/de.json';
import en from '@/messages/en.json';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('next-intl');

function Labels() {
  const t = useAdminAgentTranslations();
  return (
    <>
      <p>{t('allEligibleUsers')}</p>
      <p>{t('indexedDocumentSummary', { indexed: 2 })}</p>
    </>
  );
}

describe('new admin-agent label localization', () => {
  it('keeps the small fallback catalog synchronized with English source strings', () => {
    for (const [key, value] of Object.entries(ADMIN_AGENT_LABELS))
      expect(en.agentAccess[key as keyof typeof ADMIN_AGENT_LABELS]).toBe(
        value,
      );
  });

  it.each([
    {
      locale: 'en',
      messages: en,
      label: 'All eligible users',
      count: '2 documents indexed',
    },
    {
      locale: 'de',
      messages: de,
      label: 'Alle berechtigten Nutzer',
      count: '2 Dokumente indiziert',
    },
    {
      locale: 'ar',
      messages: ar,
      label: 'جميع المستخدمين المؤهلين',
      count: 'مستندان مفهرسان',
    },
  ])(
    'formats labels and counts in $locale',
    ({ locale, messages, label, count }) => {
      render(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Labels />
        </NextIntlClientProvider>,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(count)).toBeInTheDocument();
    },
  );

  it('falls back safely when a locale has not yet translated the new keys', () => {
    render(
      <NextIntlClientProvider locale="ja" messages={{ agentAccess: {} }}>
        <Labels />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('All eligible users')).toBeInTheDocument();
    expect(screen.getByText('2 documents indexed')).toBeInTheDocument();
  });
});
