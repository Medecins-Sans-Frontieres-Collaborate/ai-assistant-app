// @vitest-environment jsdom

/**
 * The preview of a Text only translation: offered for a document with
 * pages while it is kept, it opens the translation and its original as
 * document sources (THE DOCUMENT SOURCE) in the documents layer's viewer.
 */
import { fireEvent, render, screen } from '@testing-library/react';

import {
  DocumentTranslationViewer,
  formatTranslationReference,
} from '@/components/Chat/DocumentTranslationViewer';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({ translationEnabled: false }),
}));
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  default: () => null,
}));
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
/** The dialog, reduced to what it was asked to show. */
const shown = vi.hoisted(() => ({ versions: null as unknown }));
vi.mock('@/components/Documents/DocumentPreviewDialog', () => ({
  DocumentPreviewDialog: (props: { isOpen: boolean; versions: unknown }) => {
    if (props.isOpen) shown.versions = props.versions;
    return props.isOpen ? <div role="dialog" /> : null;
  },
}));

const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DAY_MS = 24 * 60 * 60 * 1000;
const marker = (filename: string, ext: string, expiresInDays: number) =>
  formatTranslationReference(
    filename,
    'es',
    JOB_ID,
    ext,
    new Date(Date.now() + expiresInDays * DAY_MS).toISOString(),
  );
const previewButton = () =>
  screen.queryByRole('button', { name: 'documentTranslation.preview' });

beforeEach(() => {
  shown.versions = null;
});

describe('DocumentTranslationViewer preview', () => {
  it('opens the translation and its original as document sources', () => {
    render(
      <DocumentTranslationViewer content={marker('deck_es.pptx', 'pptx', 5)} />,
    );
    fireEvent.click(previewButton()!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(shown.versions).toEqual([
      {
        source: { kind: 'translation', id: JOB_ID, type: 'pptx' },
        label: 'documentTranslation.previewTranslated',
      },
      {
        source: { kind: 'translation-original', id: JOB_ID, type: 'pptx' },
        label: 'documentTranslation.previewOriginal',
      },
    ]);
  });

  it.each(['docx', 'pdf', 'odt'])('is offered for a .%s', (ext) => {
    render(<DocumentTranslationViewer content={marker(`a.${ext}`, ext, 5)} />);
    expect(previewButton()).toBeTruthy();
  });

  it('is not offered for a document without pages', () => {
    render(<DocumentTranslationViewer content={marker('a.txt', 'txt', 5)} />);
    expect(previewButton()).toBeNull();
  });

  it('is not offered once the translation has expired', () => {
    render(
      <DocumentTranslationViewer content={marker('a.pptx', 'pptx', -1)} />,
    );
    expect(previewButton()).toBeNull();
  });
});
