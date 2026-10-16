import { fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';

import { NextIntlClientProvider } from 'next-intl';

import { FilePreview } from '@/types/chat';

import { TranscriptionOptions } from '@/components/Chat/ChatInput/ChatFileUploadPreviews';
import { TranscriptContent } from '@/components/Chat/ChatMessages/TranscriptContent';
import { TranscriptionLanguageWarning } from '@/components/Chat/TranscriptionLanguageWarning';

import english from '@/messages/en.json';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('next-intl');
vi.mock('@/client/stores/artifactStore', () => ({
  useArtifactStore: () => ({ openArtifact: vi.fn() }),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={english}>
      {children}
    </NextIntlClientProvider>
  );
}

function OptionsHarness() {
  const [files, setFiles] = useState<FilePreview[]>([
    {
      name: 'one.wav',
      previewUrl: 'blob:one',
      type: 'audio/wav',
      status: 'completed',
    } as FilePreview,
    {
      name: 'two.wav',
      previewUrl: 'blob:two',
      type: 'audio/wav',
      status: 'completed',
    } as FilePreview,
  ]);
  return (
    <>
      {files.map((file) => (
        <TranscriptionOptions
          key={file.name}
          filePreview={file}
          setFilePreviews={setFiles}
        />
      ))}
    </>
  );
}

describe('experimental transcription language UX', () => {
  it('opens the compact caution with the keyboard and dismisses it with Escape', async () => {
    const user = userEvent.setup();
    render(
      <TranscriptionLanguageWarning
        metadata={{ language: 'so', officiallySupported: false }}
        compact
        result
      />,
      { wrapper: Wrapper },
    );
    const trigger = screen.getByRole('button', {
      name: 'Experimental language: review carefully',
    });
    const description = document.getElementById(
      trigger.getAttribute('aria-controls')!,
    )!;
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(description).not.toBeVisible();
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(description).toBeVisible();
    expect(description).toHaveTextContent('Somali is not officially supported');
    await user.keyboard('{Escape}');
    expect(description).not.toBeVisible();
    expect(trigger).toHaveFocus();
    await user.keyboard(' ');
    expect(description).toBeVisible();
  });

  it('toggles the compact caution by touch with wrapping content in the file panel', async () => {
    const user = userEvent.setup();
    render(
      <div style={{ width: 200 }}>
        <TranscriptionLanguageWarning
          metadata={{ language: 'ht', officiallySupported: false }}
          compact
          result
        />
      </div>,
      { wrapper: Wrapper },
    );
    const trigger = screen.getByRole('button', {
      name: 'Experimental language: review carefully',
    });
    const description = document.getElementById(
      trigger.getAttribute('aria-controls')!,
    )!;
    await user.pointer([
      { keys: '[TouchA>]', target: trigger },
      { keys: '[/TouchA]' },
    ]);
    expect(description).toBeVisible();
    expect(description).toHaveClass(
      'max-w-full',
      'whitespace-normal',
      'break-words',
    );
    expect(description).toHaveTextContent('Haitian Creole');
    await user.click(trigger);
    expect(description).not.toBeVisible();
  });
  it('groups selectable options, warns for only the changed file, and clears on auto-detect', () => {
    render(<OptionsHarness />, { wrapper: Wrapper });
    const selectors = screen.getAllByRole('combobox', {
      name: 'Recording language',
    });
    expect(selectors[0]).toHaveValue('');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(
      selectors[0].querySelector(
        'optgroup[label="Experimental: not officially supported"]',
      ),
    ).not.toBeNull();
    const options = Array.from((selectors[0] as HTMLSelectElement).options);
    expect(options.find((option) => option.value === 'ht')).toHaveTextContent(
      'Haitian Creole (experimental)',
    );
    expect(options.find((option) => option.value === 'ht')).toBeEnabled();
    expect(options.find((option) => option.value === 'en')).toHaveTextContent(
      'English',
    );

    fireEvent.change(selectors[0], { target: { value: 'ht' } });
    expect(selectors[0]).toHaveValue('ht');
    expect(selectors[1]).toHaveValue('');
    const warning = screen.getByRole('status');
    expect(warning).toHaveTextContent(
      'Haitian Creole is not officially supported',
    );
    expect(warning).toHaveTextContent('fluent speaker');
    expect(selectors[0]).toHaveAttribute('aria-describedby', warning.id);

    fireEvent.change(selectors[0], { target: { value: 'so' } });
    expect(screen.getByRole('status')).toHaveTextContent('Somali');
    fireEvent.change(selectors[0], { target: { value: 'en' } });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.change(selectors[0], { target: { value: '' } });
    expect(selectors[0]).not.toHaveAttribute('aria-describedby');
  });

  it('keeps the caution outside completed inline transcript text', () => {
    render(
      <TranscriptContent
        content="spoken content"
        languageMetadata={{ language: 'so', officiallySupported: false }}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Experimental language: review carefully',
    );
    expect(screen.getByText('spoken content')).toHaveTextContent(
      /^spoken content$/,
    );
  });

  it('does not warn for official, auto-detected, or old metadata-free results', () => {
    render(
      <>
        <TranscriptionLanguageWarning
          metadata={{ language: 'en', officiallySupported: true }}
          result
        />
        <TranscriptionLanguageWarning result />
      </>,
      { wrapper: Wrapper },
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
