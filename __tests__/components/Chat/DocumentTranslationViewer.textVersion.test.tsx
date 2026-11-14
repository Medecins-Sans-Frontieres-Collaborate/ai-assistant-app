// @vitest-environment jsdom

/**
 * The text-version (DOCX) download: offered only for formats with a
 * page-level text view, and fetched from the export route under the
 * translated file's name with a .docx extension.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  DocumentTranslationViewer,
  formatTranslationReference,
} from '@/components/Chat/DocumentTranslationViewer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const textVersionButton = () =>
  screen.queryByRole('button', { name: 'documentTranslation.textVersion' });

const fetchMock = vi.fn();
let downloadedAs: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  downloadedAs = undefined;
  fetchMock.mockResolvedValue(new Response(new Blob(['docx'])));
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:text-version');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloadedAs = this.download;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DocumentTranslationViewer text version', () => {
  it('downloads the DOCX from the export route for a translated PDF', async () => {
    render(
      <DocumentTranslationViewer content={marker('guide_es.pdf', 'pdf', 5)} />,
    );

    fireEvent.click(textVersionButton()!);

    await waitFor(() => expect(downloadedAs).toBe('guide_es.docx'));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/document-translation/export/${JOB_ID}?format=docx`,
    );
  });

  it('is not offered for a format without a page-level text view', () => {
    render(
      <DocumentTranslationViewer
        content={marker('guide_es.docx', 'docx', 5)}
      />,
    );
    expect(textVersionButton()).not.toBeInTheDocument();
  });

  it('is not offered once the translation has expired', () => {
    render(
      <DocumentTranslationViewer content={marker('guide_es.pdf', 'pdf', -1)} />,
    );
    expect(textVersionButton()).not.toBeInTheDocument();
  });
});
