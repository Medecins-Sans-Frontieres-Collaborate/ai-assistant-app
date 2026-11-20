import { fireEvent, render, screen } from '@testing-library/react';

import {
  FormattedDownloadMenu,
  downloadFormatsOf,
} from '@/components/Workflows/Translation/Formatted/FormattedDownloadMenu';
import {
  FormattedUnitProvider,
  useUnitWording,
} from '@/components/Workflows/Translation/Formatted/formattedWording';

import { describe, expect, it, vi } from 'vitest';

/**
 * What a formatted run can be downloaded as, and the words its screens use
 * for a presentation.
 */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

describe('downloadFormatsOf', () => {
  it('offers a presentation’s deck first, then its PDF, and no picture export', () => {
    expect(downloadFormatsOf({ documentUrl: '/d', pdfUrl: '/p' })).toEqual([
      'document',
      'pdf',
    ]);
  });

  it('offers only the deck when its slides could not be rendered', () => {
    expect(downloadFormatsOf({ documentUrl: '/d' })).toEqual(['document']);
  });

  it('offers a PDF run its PDF and the editable formats built from it', () => {
    expect(downloadFormatsOf({ pdfUrl: '/p' })).toEqual(['pdf', 'pptx']);
  });
});

describe('FormattedDownloadMenu', () => {
  it('names the deck by its own format and walks the offered formats only', () => {
    const onSelect = vi.fn();
    render(
      <FormattedDownloadMenu
        formats={['document', 'pdf']}
        documentExtension="pptm"
        busy={null}
        behind={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(
      'translation.formatted.downloadDeck pptm',
    );
    // Not experimental: it is the presentation itself.
    expect(items[0]).not.toHaveTextContent(
      'translation.formatted.experimental',
    );
    // Arrow keys wrap within the two formats.
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(items[1]).toHaveFocus();
    fireEvent.click(items[0]);
    expect(onSelect).toHaveBeenCalledWith('document');
  });
});

function Label({ page }: { page: number }) {
  const unitT = useUnitWording();
  return <span>{unitT('pageLabel', { page })}</span>;
}

describe('useUnitWording', () => {
  it('speaks of pages by default and of slides inside a presentation', () => {
    render(
      <>
        <Label page={1} />
        <FormattedUnitProvider unit="slide">
          <Label page={2} />
        </FormattedUnitProvider>
      </>,
    );
    expect(screen.getByText('translation.formatted.pageLabel 1')).toBeTruthy();
    expect(
      screen.getByText('translation.formatted.slides.pageLabel 2'),
    ).toBeTruthy();
  });
});
