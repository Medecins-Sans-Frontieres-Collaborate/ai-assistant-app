import { fireEvent, render, screen } from '@testing-library/react';

import { SourceDocumentCard } from '@/components/Workflows/Translation/SourceDocumentCard';
import { SourcePageSheets } from '@/components/Workflows/Translation/SourcePageSheets';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

const PAGES = [1, 2, 4].map((page) => ({ page, text: `Text of page ${page}` }));

describe('SourcePageSheets', () => {
  const scrolledTo: string[] = [];
  beforeEach(() => {
    scrolledTo.length = 0;
    Element.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolledTo.push(this.dataset.sourcePage ?? '');
    };
  });
  afterEach(() => {
    // @ts-expect-error jsdom has no scrollIntoView of its own to restore
    delete Element.prototype.scrollIntoView;
  });

  it('labels each page outside its text', () => {
    render(<SourcePageSheets pages={PAGES} lastPage={4} />);
    const sheets = [...document.querySelectorAll('[data-source-page]')];
    expect(sheets.map((sheet) => sheet.textContent)).toEqual([
      'translation.pageLabel 1Text of page 1',
      'translation.pageLabel 2Text of page 2',
      'translation.pageLabel 4Text of page 4',
    ]);
  });

  it('says which page of how many, and jumps to a typed page', () => {
    render(<SourcePageSheets pages={PAGES} lastPage={4} />);
    const marker = screen.getByRole('button', {
      name: 'translation.pageLabel 1 translation.pageOf 4',
    });
    fireEvent.click(marker);
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: '4' } });
    fireEvent.submit(field.closest('form')!);
    expect(scrolledTo[0]).toBe('4');
    expect(
      screen.getByRole('button', {
        name: 'translation.pageLabel 4 translation.pageOf 4',
      }),
    ).toBeInTheDocument();
  });

  it('jumps to the nearest page with text, and ignores what is not a number', () => {
    render(<SourcePageSheets pages={PAGES} lastPage={4} />);
    const jump = (value: string) => {
      fireEvent.click(screen.getByRole('button'));
      const field = screen.getByRole('textbox');
      fireEvent.change(field, { target: { value } });
      fireEvent.submit(field.closest('form')!);
    };
    jump('abc');
    expect(scrolledTo).toEqual([]);
    jump('3');
    expect(['2', '4']).toContain(scrolledTo[0]);
  });
});

describe('SourceDocumentCard', () => {
  const base = { name: 'guide.pdf', url: '/f', selectedPages: '1-2' };

  it('shows the name, page count and size', () => {
    render(
      <SourceDocumentCard
        document={{ ...base, lastPage: 409, size: 2 * 1024 * 1024 }}
        disabled={false}
        onRemove={vi.fn()}
      />,
    );
    const card = screen.getByTestId('source-document-card');
    expect(card).toHaveTextContent('guide.pdf');
    expect(card).toHaveTextContent('translation.documentPageCount 409');
    expect(card).toHaveTextContent('MB');
  });

  it('leaves out what is not known: a scanned file has no page count', () => {
    render(
      <SourceDocumentCard
        document={{ ...base, lastPage: 0, noText: true }}
        disabled={false}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('source-document-card')).not.toHaveTextContent(
      'documentPageCount',
    );
  });

  it('removes on request, unless blocked', () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <SourceDocumentCard
        document={{ ...base, lastPage: 3 }}
        disabled
        onRemove={onRemove}
      />,
    );
    const remove = () =>
      screen.getByRole('button', { name: 'translation.sourceRemoveDocument' });
    expect(remove()).toBeDisabled();
    rerender(
      <SourceDocumentCard
        document={{ ...base, lastPage: 3 }}
        disabled={false}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(remove());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
