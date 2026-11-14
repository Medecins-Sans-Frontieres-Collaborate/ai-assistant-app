import {
  CONVERTER_EXEC_OPTS,
  ExtractionOptions,
  countPdfPages,
  libreOfficeConvert,
  removeTempDir,
} from '@/lib/utils/server/file/fileHandling';

import {
  FilePagePreview,
  PAGE_PREVIEW_DPI,
  PAGE_PREVIEW_EXTENSIONS,
  PAGE_PREVIEW_MAX_PAGES,
} from '@/lib/constants/filePreview';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Thrown when a file's format has no page preview. */
export class UnsupportedPreviewError extends Error {
  constructor(extension: string) {
    super(`No page preview for ".${extension}" files`);
    this.name = 'UnsupportedPreviewError';
  }
}

/**
 * Renders the first pages of a document as PNG images.
 *
 * Office formats are laid out by LibreOffice (to PDF), then `pdftoppm`
 * rasterises the pages; a PDF skips the first step. Both tools are already
 * required for text extraction. Everything happens in a private temp
 * directory under a fixed filename, so nothing from the caller reaches a
 * path or a command line except the validated extension.
 *
 * @param file - The document's bytes.
 * @param extension - Its extension without the dot; must be in
 *   PAGE_PREVIEW_EXTENSIONS.
 * @param options - Optional abort signal, forwarded to both converters.
 * @returns Up to PAGE_PREVIEW_MAX_PAGES pages as data URLs, with the page
 *   count of the whole document.
 * @throws UnsupportedPreviewError for any other extension.
 * @throws Error when a converter fails or produces no pages.
 */
export async function renderFilePagePreview(
  file: Buffer,
  extension: string,
  options?: ExtractionOptions,
): Promise<FilePagePreview> {
  const normalized = extension.toLowerCase();
  if (!PAGE_PREVIEW_EXTENSIONS.has(normalized)) {
    throw new UnsupportedPreviewError(normalized);
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'preview-'));
  try {
    const inputPath = path.join(workDir, `input.${normalized}`);
    await fs.promises.writeFile(inputPath, file);

    const pdfPath =
      normalized === 'pdf'
        ? inputPath
        : await libreOfficeConvert(inputPath, 'pdf', workDir, options);

    const totalPages = await countPdfPages(
      await fs.promises.readFile(pdfPath),
      options,
    );

    const pagePrefix = path.join(workDir, 'page');
    await execFileAsync(
      'pdftoppm',
      [
        '-png',
        '-r',
        String(PAGE_PREVIEW_DPI),
        '-f',
        '1',
        '-l',
        String(PAGE_PREVIEW_MAX_PAGES),
        pdfPath,
        pagePrefix,
      ],
      options?.signal
        ? { ...CONVERTER_EXEC_OPTS, signal: options.signal }
        : CONVERTER_EXEC_OPTS,
    );

    // pdftoppm zero-pads page numbers to the width of the last page, so a
    // plain sort is page order.
    const pageFiles = (await fs.promises.readdir(workDir))
      .filter((name) => name.startsWith('page-') && name.endsWith('.png'))
      .sort();
    if (pageFiles.length === 0) {
      throw new Error('The document produced no pages to preview');
    }

    const pages = await Promise.all(
      pageFiles.map(async (name) => {
        const bytes = await fs.promises.readFile(path.join(workDir, name));
        return `data:image/png;base64,${bytes.toString('base64')}`;
      }),
    );
    return { pages, totalPages: Math.max(totalPages, pages.length) };
  } finally {
    await removeTempDir(workDir);
  }
}
