import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { NextIntlClientProvider } from 'next-intl';

import { TranscriptViewer } from '@/components/Chat/TranscriptViewer';

import english from '@/messages/en.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('next-intl');
vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({ ttsSettings: {} }),
}));
vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({ transcriptionEnabled: false }),
}));
vi.mock('@/client/stores/artifactStore', () => ({
  useArtifactStore: () => ({ openDocument: vi.fn() }),
}));
vi.mock('@/client/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ m365Connected: false }),
}));
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  default: () => null,
}));
vi.mock('@/components/Markdown/StreamdownWithCodeButtons', () => ({
  StreamdownWithCodeButtons: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock('@/components/Markdown/CitationStreamdown', () => ({
  CitationStreamdown: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/Chat/ChatMessages/TranslationDropdown', () => ({
  TranslationDropdown: ({
    isOpen,
    onSelectLanguage,
  }: {
    isOpen: boolean;
    onSelectLanguage: (locale: string) => void;
  }) =>
    isOpen ? (
      <button onClick={() => onSelectLanguage('fr')}>Choose French</button>
    ) : null,
}));
vi.mock('@/lib/services/translation/translationService', () => ({
  translateText: vi.fn().mockResolvedValue({
    success: true,
    data: { translatedText: 'translated spoken content' },
  }),
}));

const clipboardWrite = vi.fn().mockResolvedValue(undefined);
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={english}>
      {children}
    </NextIntlClientProvider>
  );
}

describe('completed transcript language caution', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    clipboardWrite.mockClear();
  });

  it('persists while collapsed and translated without contaminating copied speech', async () => {
    render(
      <TranscriptViewer
        filename="audio.wav"
        transcript="spoken content"
        processedContent="summary"
        languageMetadata={{ language: 'ht', officiallySupported: false }}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByRole('status')).toHaveTextContent('Haitian Creole');
    expect(screen.queryByText('spoken content')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy', exact: true }));
    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenLastCalledWith('spoken content'),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Translate', exact: true }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose French' }));
    await screen.findByText(/Translated to/);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Experimental language: review carefully',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand', exact: true }),
    );
    expect(screen.getByText('translated spoken content')).toBeInTheDocument();
  }, 15000);

  it('keeps the caution on a lazy blob reference even if the text has expired', () => {
    render(
      <TranscriptViewer
        filename="audio.wav"
        transcript="[Transcript: audio.wav | blob:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee | expires:2020-01-01T00:00:00.000Z]"
        languageMetadata={{ language: 'so', officiallySupported: false }}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByRole('status')).toHaveTextContent('Somali');
    expect(screen.getByText(/has expired/)).toBeInTheDocument();
  });
});
