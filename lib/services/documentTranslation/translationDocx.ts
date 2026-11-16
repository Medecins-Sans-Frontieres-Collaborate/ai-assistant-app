/**
 * Builds the text version (DOCX) of a translated document.
 *
 * The layout-preserving translation cannot absorb edits, so corrected text is
 * delivered as a separate, text-first Word file: one DOCX page per source
 * page, so "page 48" means the same thing in both files.
 *
 * Pandoc renders the file (it is already required for text extraction, and
 * unlike `html-to-docx` it writes right-to-left paragraphs correctly). Page
 * text is HTML-escaped into paragraphs first, so nothing in a page can be
 * interpreted as markup.
 */
import {
  CONVERTER_EXEC_OPTS,
  ExtractionOptions,
  removeTempDir,
} from '@/lib/utils/server/file/fileHandling';

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** MIME type of a Word document. */
export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Class of the empty block the Lua filter turns into a Word page break. */
const PAGE_BREAK_CLASS = 'page-break';

/**
 * Pandoc's HTML reader has no page-break element; this filter replaces the
 * marker block with the OpenXML for one.
 */
const PAGE_BREAK_LUA_FILTER = `
function Div(el)
  if el.classes:includes('${PAGE_BREAK_CLASS}') then
    return pandoc.RawBlock('openxml', '<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
  end
end
`;

/** Text of one page of the export. */
export interface DocxPage {
  /** 1-based page number in the source document. */
  page: number;
  text: string;
}

/** Document-level settings of the export. */
export interface TranslationDocxOptions {
  /** Document title, written to the file's metadata. */
  title: string;
  /** BCP 47 language code of the text (e.g. `es`, `ar`). */
  language: string;
  /** Reading direction of the text. */
  direction: 'ltr' | 'rtl';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Converts one page of extracted text to HTML paragraphs.
 *
 * Blank lines separate paragraphs. Line breaks inside a paragraph come from
 * the source page's line wrapping, so they are joined to let the text reflow.
 */
function pageToHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('\n');
}

/**
 * Builds the HTML that pandoc converts into the text version.
 *
 * @param pages - Pages in document order. A page without text still takes a
 *   page, so page numbers keep matching the source document.
 * @param options - Title, language and reading direction.
 * @returns A complete HTML document.
 */
export function buildTranslationHtml(
  pages: DocxPage[],
  options: TranslationDocxOptions,
): string {
  const body = pages
    .map((page) => pageToHtml(page.text))
    .join(`\n<div class="${PAGE_BREAK_CLASS}"></div>\n`);
  return [
    '<!DOCTYPE html>',
    `<html lang="${escapeHtml(options.language)}" dir="${options.direction}">`,
    `<head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title></head>`,
    `<body>\n${body}\n</body>`,
    '</html>',
  ].join('\n');
}

/**
 * Renders the text version of a translation as a Word document.
 *
 * @param pages - Pages in document order, corrections already applied.
 * @param options - Title, language and reading direction, plus an optional
 *   abort signal for the converter process.
 * @returns The DOCX file's bytes.
 * @throws Error when pandoc is missing, times out, or fails.
 */
export async function renderTranslationDocx(
  pages: DocxPage[],
  options: TranslationDocxOptions & ExtractionOptions,
): Promise<Buffer> {
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'translation-docx-'),
  );
  try {
    const htmlPath = path.join(workDir, 'translation.html');
    const filterPath = path.join(workDir, 'page-break.lua');
    const docxPath = path.join(workDir, 'translation.docx');
    await Promise.all([
      fs.promises.writeFile(htmlPath, buildTranslationHtml(pages, options)),
      fs.promises.writeFile(filterPath, PAGE_BREAK_LUA_FILTER),
    ]);
    await execFileAsync(
      'pandoc',
      [
        htmlPath,
        '--from=html',
        '--to=docx',
        `--lua-filter=${filterPath}`,
        `--metadata=lang:${options.language}`,
        `--metadata=dir:${options.direction}`,
        `--output=${docxPath}`,
      ],
      options.signal
        ? { ...CONVERTER_EXEC_OPTS, signal: options.signal }
        : CONVERTER_EXEC_OPTS,
    );
    return await fs.promises.readFile(docxPath);
  } finally {
    await removeTempDir(workDir);
  }
}
