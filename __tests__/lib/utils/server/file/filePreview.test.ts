import {
  UnsupportedPreviewError,
  renderFilePagePreview,
} from '@/lib/utils/server/file/filePreview';

import {
  PAGE_PREVIEW_MAX_PAGES,
  fileExtension,
  isPagePreviewable,
} from '@/lib/constants/filePreview';
import { execFileSync } from 'child_process';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

/** Whether a command-line tool is installed on this machine. */
function hasTool(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A PDF with the given number of blank pages. */
async function pdfWithPages(count: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < count; page++) pdf.addPage([300, 200]);
  return Buffer.from(await pdf.save());
}

const PNG_DATA_URL = /^data:image\/png;base64,iVBORw0KGgo/;

describe('fileExtension / isPagePreviewable', () => {
  it('reads the extension from names, paths and file URLs', () => {
    expect(fileExtension('Report.DOCX')).toBe('docx');
    expect(fileExtension('/api/file/abc123.pptx?x=1')).toBe('pptx');
    expect(fileExtension('archive.tar.gz')).toBe('gz');
    expect(fileExtension('no-extension')).toBe('');
    expect(fileExtension('.hidden')).toBe('');
  });

  it('offers a preview for documents and not for other files', () => {
    for (const name of ['a.docx', 'a.pptx', 'a.xlsx', 'a.pdf', 'a.odt']) {
      expect(isPagePreviewable(name)).toBe(true);
    }
    for (const name of ['a.png', 'a.csv', 'a.txt', 'a.zip', 'a']) {
      expect(isPagePreviewable(name)).toBe(false);
    }
  });
});

describe('renderFilePagePreview', () => {
  it('refuses a format it cannot lay out, before touching any tool', async () => {
    await expect(
      renderFilePagePreview(Buffer.from('a,b\n1,2\n'), 'csv'),
    ).rejects.toBeInstanceOf(UnsupportedPreviewError);
  });

  // The remaining cases run the real converters; a machine without them
  // (they ship in the container image) skips rather than fails.
  it.skipIf(!hasTool('pdftoppm'))(
    'renders every page of a short PDF as a PNG',
    async () => {
      const preview = await renderFilePagePreview(await pdfWithPages(3), 'pdf');

      expect(preview.totalPages).toBe(3);
      expect(preview.pages).toHaveLength(3);
      for (const page of preview.pages) expect(page).toMatch(PNG_DATA_URL);
    },
    60_000,
  );

  it.skipIf(!hasTool('pdftoppm'))(
    'stops at the page limit and still reports the full page count',
    async () => {
      const overLimit = PAGE_PREVIEW_MAX_PAGES + 2;
      const preview = await renderFilePagePreview(
        await pdfWithPages(overLimit),
        'pdf',
      );

      expect(preview.pages).toHaveLength(PAGE_PREVIEW_MAX_PAGES);
      expect(preview.totalPages).toBe(overLimit);
    },
    60_000,
  );

  it.skipIf(!hasTool('pdftoppm'))(
    'renders exactly the limit without reporting more',
    async () => {
      const preview = await renderFilePagePreview(
        await pdfWithPages(PAGE_PREVIEW_MAX_PAGES),
        'pdf',
      );

      expect(preview.pages).toHaveLength(PAGE_PREVIEW_MAX_PAGES);
      expect(preview.totalPages).toBe(PAGE_PREVIEW_MAX_PAGES);
    },
    60_000,
  );

  it.skipIf(!hasTool('pdftoppm') || !hasTool('libreoffice'))(
    'lays out an office document through LibreOffice',
    async () => {
      // RTF is plain text, so the fixture needs no binary file.
      const rtf = Buffer.from('{\\rtf1\\ansi Preview me.\\par}');
      const preview = await renderFilePagePreview(rtf, 'rtf');

      expect(preview.totalPages).toBe(1);
      expect(preview.pages[0]).toMatch(PNG_DATA_URL);
    },
    120_000,
  );

  it.skipIf(!hasTool('pdftoppm'))(
    'rejects bytes that are not the format they claim to be',
    async () => {
      await expect(
        renderFilePagePreview(Buffer.from('not a pdf'), 'pdf'),
      ).rejects.toThrow();
    },
    60_000,
  );
});
