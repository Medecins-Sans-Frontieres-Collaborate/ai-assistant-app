import { analyzeDocument } from '@/lib/services/documentIntelligence/client';
import {
  formatPagedText,
  ocrPdfToPagedText,
} from '@/lib/services/documentIntelligence/ocrText';

import { splitExtractedPages } from '@/lib/utils/shared/translation/pageBatches';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/documentIntelligence/client', () => ({
  analyzeDocument: vi.fn(),
}));

describe('formatPagedText', () => {
  it('writes pages the page splitter reads back unchanged', () => {
    const pages = [
      { pageNumber: 1, text: 'Uno\nlínea dos' },
      { pageNumber: 2, text: '  ' },
      { pageNumber: 3, text: ' Tres ' },
    ];
    expect(splitExtractedPages(formatPagedText(pages))).toEqual([
      { page: 1, text: 'Uno\nlínea dos' },
      { page: 3, text: 'Tres' },
    ]);
  });

  it('is empty when no page has text', () => {
    expect(formatPagedText([{ pageNumber: 1, text: '\n' }])).toBe('');
    expect(formatPagedText([])).toBe('');
  });
});

describe('ocrPdfToPagedText', () => {
  // Braces matter: a function returned from beforeEach is run as teardown,
  // and mockReset() returns the mock itself.
  beforeEach(() => {
    vi.mocked(analyzeDocument).mockReset();
  });

  it('reads the PDF with the read model and counts analysed pages', async () => {
    vi.mocked(analyzeDocument).mockResolvedValue({
      content: 'a b',
      pages: [
        { pageNumber: 1, text: 'a' },
        { pageNumber: 2, text: '' },
      ],
    });
    const signal = new AbortController().signal;
    const pdf = Buffer.from('%PDF');
    await expect(ocrPdfToPagedText(pdf, signal)).resolves.toEqual({
      text: '--- Page 1 ---\na',
      pagesAnalyzed: 2,
    });
    expect(analyzeDocument).toHaveBeenCalledWith(pdf, {
      model: 'prebuilt-read',
      contentType: 'application/pdf',
      signal,
    });
  });

  it('lets service errors through', async () => {
    vi.mocked(analyzeDocument).mockRejectedValue(new Error('boom'));
    await expect(ocrPdfToPagedText(Buffer.from('x'))).rejects.toThrow('boom');
  });
});
