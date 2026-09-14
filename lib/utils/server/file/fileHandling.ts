import {
  perfLog,
  sanitizeForLog,
} from '@/lib/utils/server/log/logSanitization';

import { getPdfPageCount } from './pdfUtils';

import {
  requiresContentValidation,
  validateDocumentContent,
} from '@/lib/constants/fileLimits';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { lookup } from 'mime-types';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Converter execution options applied to every external-tool invocation
 * (pandoc, pdftotext, ssconvert, libreoffice). Bounds wall-clock and output
 * buffer so a malformed input cannot pin a worker indefinitely or exhaust
 * memory with unbounded stdout. The timeout matches the outer
 * ChatPipeline.EXECUTION_TIMEOUT_MS so legitimate large conversions don't
 * fail here when they would otherwise succeed at the pipeline level.
 */
const CONVERTER_EXEC_OPTS = {
  timeout: 180_000,
  killSignal: 'SIGKILL' as const,
  maxBuffer: 100 * 1024 * 1024,
};

/**
 * Per-call extraction options. `signal` is forwarded to every external
 * converter spawned for the document, so a caller that gives up on a
 * conversion (the M365 index job's time box, for instance) actually kills
 * the pandoc/LibreOffice/ssconvert child instead of leaving it running
 * until CONVERTER_EXEC_OPTS.timeout.
 */
export interface ExtractionOptions {
  signal?: AbortSignal;
}

function execOpts(options?: ExtractionOptions) {
  return options?.signal
    ? { ...CONVERTER_EXEC_OPTS, signal: options.signal }
    : CONVERTER_EXEC_OPTS;
}

/**
 * Upper bound on extracted text size across every converter path.
 * Decompressed CSV from an XLSX can balloon orders of magnitude past the
 * compressed upload limit; this prevents unbounded string growth.
 */
const MAX_EXTRACTED_TEXT_BYTES = 20 * 1024 * 1024;

/**
 * Configure pdfjs-dist for server-side use.
 * Uses the legacy build which has better Node.js compatibility
 * (avoids DOMMatrix and other browser-only dependencies).
 *
 * Must be done before any PDF operations.
 */
async function configurePdfJs(): Promise<typeof import('pdfjs-dist')> {
  // Use legacy build for better Node.js compatibility
  // The standard build requires DOMMatrix and other browser APIs
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Disable worker for server-side use (runs in main thread)
  // This avoids issues with web workers in Node.js environment
  if (typeof window === 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  }

  return pdfjsLib as unknown as typeof import('pdfjs-dist');
}

async function retryRemoveFile(
  filePath: string,
  maxRetries = 3,
): Promise<void> {
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fs.promises.unlink(filePath);
      console.log(`Successfully removed file: ${filePath}`);
      return;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        console.log(`File not found, considered as removed: ${filePath}`);
        return;
      }
      if (attempt === maxRetries - 1) {
        console.warn(
          `Failed to remove file after ${maxRetries} attempts: ${filePath}`,
        );
        return;
      }
      console.warn(`Attempt ${attempt + 1} to remove file failed. Retrying...`);
      await delay(Math.pow(2, attempt) * 1000); // Exponential backoff: 1s, 2s, 4s
    }
  }
}

async function removeTempDir(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[fileHandling] Failed to remove temp dir ${dir}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function buildTempFilePath(originalFilename: string): string {
  // Derive a safe temp file path. Preserve only the extension from the
  // user-supplied filename so downstream format detection (MIME lookup,
  // `.endsWith('.xlsx')` checks, pandoc output naming) still works. The
  // rest of the filename is replaced with a random UUID to close
  // path-traversal and shell-injection vectors via `file.name`.
  const ext = path.extname(originalFilename || '');
  return path.join(os.tmpdir(), `${randomUUID()}${ext}`);
}

function truncateToBudget(text: string): string {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength <= MAX_EXTRACTED_TEXT_BYTES) return text;
  // Truncate from the end in UTF-8 safe units. `Buffer.from(text).slice()` on
  // byte count may split a codepoint; decode with fatal=false to drop the
  // trailing partial char.
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_EXTRACTED_TEXT_BYTES);
  const truncated = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const mb = Math.round(MAX_EXTRACTED_TEXT_BYTES / (1024 * 1024));
  return `${truncated}\n\n[… truncated at ${mb}MB …]\n`;
}

/**
 * Converts a file using Pandoc.
 *
 * @param {string} inputPath - The path of the input file.
 * @param {string} outputFormat - The desired output format.
 * @returns {Promise<string>} - A promise that resolves to the converted file content.
 * @throws {Error} - If there was an error converting the file.
 */
export async function convertWithPandoc(
  inputPath: string,
  outputFormat: string,
  options?: ExtractionOptions & {
    /** Extra pandoc arguments (e.g. an explicit `-f html`). */
    args?: string[];
  },
): Promise<string> {
  const outputPath = `${inputPath}.${outputFormat}`;
  const perfStart = performance.now();

  try {
    await execFileAsync(
      'pandoc',
      [inputPath, ...(options?.args ?? []), '-o', outputPath],
      execOpts(options),
    );
    const stdout = await fs.promises.readFile(outputPath, 'utf8');
    console.log(
      `[Perf] convertWithPandoc: ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return truncateToBudget(stdout);
  } catch (error) {
    console.error(`Error converting file with Pandoc: ${error}`);
    throw error;
  } finally {
    // Clean up temporary files
    retryRemoveFile(inputPath).catch((error) => {
      console.error(`Failed to remove temporary file ${inputPath}:`, error);
    });
    retryRemoveFile(outputPath).catch((error) => {
      console.error(`Failed to remove temporary file ${outputPath}:`, error);
    });
  }
}

/**
 * Extract text from PDF using pdfjs-dist library.
 * Works server-side without browser dependencies.
 * More forgiving of malformed PDFs than CLI tools.
 *
 * @param filePath - Path to the PDF file
 * @returns Extracted text content
 */
async function extractTextWithPdfJs(filePath: string): Promise<string> {
  const pdfjsLib = await configurePdfJs();

  // Read file as Buffer and convert to ArrayBuffer
  const data = await fs.promises.readFile(filePath);
  const arrayBuffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  );

  // Load PDF document
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const textContents: string[] = [];

  // Extract text from each page
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Join text items with spaces, preserving structure
    // TextItem has 'str', TextMarkedContent does not
    const pageText = textContent.items
      .map((item) => ('str' in item ? (item as { str: string }).str : ''))
      .filter(Boolean)
      .join(' ');

    if (pageText.trim()) {
      textContents.push(`--- Page ${pageNum} ---\n${pageText}`);
    }
  }

  return textContents.join('\n\n');
}

/**
 * Every PDF extractor ran and none produced usable text: the document has
 * no text layer (scanned/image-only) or its fonts carry no Unicode
 * mapping. The structure is fine, so re-running extractors cannot help —
 * only OCR can. Indexers map this to `noText`; uploads still surface it
 * as an error, just a specific one.
 */
export class NoExtractableTextError extends Error {
  constructor(
    message = 'The PDF contains no extractable text (scanned or image-only?)',
  ) {
    super(message);
    this.name = 'NoExtractableTextError';
  }
}

/**
 * Every PDF extractor THREW. The message names each cause so an
 * encrypted or corrupt file is distinguishable from a scan.
 */
export class PdfExtractionError extends Error {
  constructor(readonly causes: string[]) {
    super(`Failed to extract text from PDF (${causes.join('; ')})`);
    this.name = 'PdfExtractionError';
  }
}

const GOOD_TEXT_CHARS =
  /[\p{L}\p{N}\p{M}.,;:!?'"()\[\]{}\-–—/\\%&+*=<>@#$€£§°_|~^`«»‘’“”•·]/u;

/**
 * Text-quality gate for extractor output. PDFs whose fonts lack a
 * ToUnicode map "extract" as glyph-id gibberish that would otherwise be
 * embedded as if it were prose. Conservative on purpose: a mostly numeric
 * table, page markers and punctuation-heavy text all pass; only a
 * majority of unclassifiable symbols or many replacement characters fail.
 */
export function looksLikeGarbledText(text: string): boolean {
  const chars = Array.from(text.replace(/\s+/g, ''));
  if (chars.length < 40) return false;
  let good = 0;
  let replacement = 0;
  for (const ch of chars) {
    if (ch === '\uFFFD') replacement += 1;
    else if (GOOD_TEXT_CHARS.test(ch)) good += 1;
  }
  if (replacement / chars.length > 0.05) return true;
  return good / chars.length < 0.6;
}

function usableText(text: string): boolean {
  return !!text.trim() && !looksLikeGarbledText(text);
}

/**
 * Number of pages in a PDF held in memory — pdfjs first (no temp file),
 * `pdfinfo` as the fallback when pdfjs refuses the structure.
 */
export async function countPdfPages(buffer: Buffer): Promise<number> {
  try {
    const pdfjsLib = await configurePdfJs();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) })
      .promise;
    return pdf.numPages;
  } catch (pdfjsError) {
    console.warn(
      '[countPdfPages] pdfjs failed, trying pdfinfo:',
      pdfjsError instanceof Error ? pdfjsError.message : pdfjsError,
    );
  }
  const tempPath = buildTempFilePath('pages.pdf');
  await fs.promises.writeFile(tempPath, new Uint8Array(buffer), {
    mode: 0o600,
  });
  try {
    const { stdout } = await execFileAsync(
      'pdfinfo',
      [tempPath],
      CONVERTER_EXEC_OPTS,
    );
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    if (!match) throw new Error('pdfinfo reported no page count');
    return Number(match[1]);
  } finally {
    await retryRemoveFile(tempPath, 1);
  }
}

/**
 * Re-distills a structurally damaged PDF (broken xref, odd incremental
 * updates from signing tools) into a clean one with Ghostscript, so
 * pdftotext can read it. Returns the repaired file's path; the caller
 * removes it.
 */
async function repairPdfWithGhostscript(
  inputPath: string,
  options?: ExtractionOptions,
): Promise<string> {
  const outputPath = buildTempFilePath('repaired.pdf');
  await execFileAsync(
    'gs',
    [
      '-o',
      outputPath,
      '-sDEVICE=pdfwrite',
      '-dNOPAUSE',
      '-dBATCH',
      '-dQUIET',
      inputPath,
    ],
    execOpts(options),
  );
  return outputPath;
}

/**
 * Extract text from PDF using pdftotext CLI tool (poppler-utils).
 * Used as fallback when pdfjs-dist fails.
 *
 * @param inputPath - Path to the PDF file
 * @returns Extracted text content
 */
async function extractTextWithPdfToTextCli(
  inputPath: string,
  options?: ExtractionOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'pdftotext',
    [inputPath, '-'],
    execOpts(options),
  );
  return stdout;
}

/**
 * Extract text from a PDF: pdfjs-dist (most tolerant of malformed files),
 * then pdftotext, then — only when an extractor actually THREW, i.e. the
 * structure is suspect — a Ghostscript re-distill followed by pdftotext
 * again. Output passes a quality gate so glyph-id gibberish is not
 * mistaken for text.
 *
 * Outcomes:
 * - usable text → returned (budget-truncated)
 * - every extractor ran but found nothing → {@link NoExtractableTextError}
 *   (a scan; repair is pointless, OCR is the only fix — so Ghostscript is
 *   deliberately NOT run for the empty-but-well-formed case)
 * - every extractor threw → {@link PdfExtractionError} naming each cause
 */
async function pdfToText(
  inputPath: string,
  options?: ExtractionOptions,
): Promise<string> {
  const perfStart = performance.now();
  const causes: string[] = [];
  let sawNoText = false;
  const describe = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  // Try pdfjs-dist first (more robust for malformed PDFs)
  try {
    const perfPdfjsStart = performance.now();
    const text = await extractTextWithPdfJs(inputPath);
    console.log(
      `[Perf] extractTextWithPdfJs: ${(performance.now() - perfPdfjsStart).toFixed(1)}ms`,
    );
    if (usableText(text)) {
      console.log('[pdfToText] Successfully extracted with pdfjs-dist');
      console.log(
        `[Perf] pdfToText (pdfjs-dist): ${(performance.now() - perfStart).toFixed(1)}ms`,
      );
      return truncateToBudget(text);
    }
    sawNoText = true;
    console.warn(
      `[pdfToText] pdfjs-dist returned ${text.trim() ? 'garbled' : 'empty'} text, trying CLI fallback`,
    );
  } catch (pdfjsError) {
    causes.push(`pdfjs: ${describe(pdfjsError)}`);
    console.warn(
      '[pdfToText] pdfjs-dist failed, trying pdftotext CLI:',
      describe(pdfjsError),
    );
  }

  // Fallback to pdftotext CLI
  try {
    const perfCliStart = performance.now();
    const stdout = await extractTextWithPdfToTextCli(inputPath, options);
    console.log(
      `[Perf] extractTextWithPdfToTextCli: ${(performance.now() - perfCliStart).toFixed(1)}ms`,
    );
    if (usableText(stdout)) {
      console.log('[pdfToText] Successfully extracted with pdftotext CLI');
      console.log(
        `[Perf] pdfToText (CLI fallback): ${(performance.now() - perfStart).toFixed(1)}ms`,
      );
      return truncateToBudget(stdout);
    }
    sawNoText = true;
    console.warn(
      `[pdfToText] pdftotext CLI returned ${stdout.trim() ? 'garbled' : 'empty'} text`,
    );
  } catch (cliError) {
    causes.push(`pdftotext: ${describe(cliError)}`);
    console.warn('[pdfToText] pdftotext CLI also failed:', describe(cliError));
  }

  // Structure suspect (something threw): re-distill and read again. A
  // well-formed PDF that simply has no text layer skips this — Ghostscript
  // cannot invent a text layer, and running it on every scan is wasted CPU.
  if (causes.length > 0) {
    let repairedPath: string | undefined;
    try {
      const perfRepairStart = performance.now();
      repairedPath = await repairPdfWithGhostscript(inputPath, options);
      const stdout = await extractTextWithPdfToTextCli(repairedPath, options);
      console.log(
        `[Perf] ghostscript repair + pdftotext: ${(performance.now() - perfRepairStart).toFixed(1)}ms`,
      );
      if (usableText(stdout)) {
        console.log(
          '[pdfToText] Successfully extracted after Ghostscript repair',
        );
        return truncateToBudget(stdout);
      }
      sawNoText = true;
      console.warn('[pdfToText] repaired PDF still has no usable text');
    } catch (repairError) {
      causes.push(
        `${repairedPath ? 'pdftotext (after repair)' : 'ghostscript'}: ${describe(repairError)}`,
      );
      console.warn(
        '[pdfToText] Ghostscript repair path failed:',
        describe(repairError),
      );
    } finally {
      if (repairedPath) await retryRemoveFile(repairedPath, 1);
    }
  }

  if (sawNoText) {
    throw new NoExtractableTextError(
      causes.length > 0
        ? `The PDF contains no extractable text (scanned or image-only?); also: ${causes.join('; ')}`
        : undefined,
    );
  }
  throw new PdfExtractionError(causes);
}

/**
 * Reads real sheet names from an XLSX via `ssconvert --list-sheets`.
 * Output is one sheet name per line, preceded by a header line we filter.
 * Sheet order in the output matches workbook order, which is what
 * `--export-file-per-sheet` uses to index its numbered outputs.
 */
async function listXlsxSheets(
  inputPath: string,
  options?: ExtractionOptions,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'ssconvert',
      ['--list-sheets', inputPath],
      execOpts(options),
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^Sheet names? in /i.test(line));
  } catch (error) {
    console.warn(
      '[xlsxToText] ssconvert --list-sheets failed; falling back to numeric sheet labels:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Workbook → one labelled CSV block per sheet. ssconvert (Gnumeric) reads
 * both OOXML `.xlsx` and legacy binary `.xls`, so the same path serves
 * `application/vnd.ms-excel`.
 */
async function xlsxToText(
  inputPath: string,
  options?: ExtractionOptions,
): Promise<string> {
  const perfStart = performance.now();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xlsx-'));
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPattern = path.join(tempDir, `${baseName}_.csv`);

  try {
    // Read real sheet names first so we can label the numbered ssconvert
    // outputs with actual workbook sheet names instead of ".0", ".1", ...
    const sheetNames = await listXlsxSheets(inputPath, options);

    // Convert XLSX to one CSV per sheet. Output files are named
    // `<outputPattern>.0`, `.1`, ... in workbook order.
    await execFileAsync(
      'ssconvert',
      ['--export-file-per-sheet', inputPath, outputPattern],
      execOpts(options),
    );

    const files = await fs.promises.readdir(tempDir);
    const patternPrefix = path.basename(outputPattern); // "<baseName>_.csv"
    const indexed: Array<{ index: number; file: string }> = [];
    for (const file of files) {
      if (!file.startsWith(`${patternPrefix}.`)) continue;
      const suffix = file.slice(patternPrefix.length + 1);
      const idx = Number.parseInt(suffix, 10);
      if (Number.isInteger(idx) && String(idx) === suffix) {
        indexed.push({ index: idx, file });
      }
    }
    // Numeric sort: `.2` must come before `.10`.
    indexed.sort((a, b) => a.index - b.index);

    let result = '';
    let totalBytes = 0;
    const droppedSheetNames: string[] = [];

    for (let i = 0; i < indexed.length; i++) {
      const { index, file } = indexed[i];
      const sheetName = sheetNames[index] ?? `Sheet ${index + 1}`;
      const content = await fs.promises.readFile(
        path.join(tempDir, file),
        'utf8',
      );

      const block = `\n\n--- START OF SHEET: ${sheetName} ---\n\n${content}\n\n--- END OF SHEET: ${sheetName} ---\n\n`;
      const blockBytes = Buffer.byteLength(block, 'utf8');
      if (totalBytes + blockBytes > MAX_EXTRACTED_TEXT_BYTES) {
        // Record every remaining sheet (the current one and the rest) so
        // the marker names *exactly* what the model can't see, instead of
        // just saying "N sheets truncated".
        for (let j = i; j < indexed.length; j++) {
          const { index: dropIdx } = indexed[j];
          droppedSheetNames.push(sheetNames[dropIdx] ?? `Sheet ${dropIdx + 1}`);
        }
        break;
      }
      result += block;
      totalBytes += blockBytes;
    }

    if (droppedSheetNames.length > 0) {
      const mb = Math.round(MAX_EXTRACTED_TEXT_BYTES / (1024 * 1024));
      // The downstream token estimator (countTokens) runs on this returned
      // string, so appending a clear truncation notice both keeps the
      // estimate honest about what's actually included and tells the
      // model which sheets it cannot see. Cap the listed names so a
      // workbook with hundreds of dropped sheets doesn't produce a
      // multi-kilobyte marker that itself eats into the token budget.
      const SHEET_LIST_CAP = 5;
      const visibleNames = droppedSheetNames
        .slice(0, SHEET_LIST_CAP)
        .map((n) => `"${n}"`)
        .join(', ');
      const overflow = droppedSheetNames.length - SHEET_LIST_CAP;
      const list =
        overflow > 0 ? `${visibleNames}, and ${overflow} more` : visibleNames;
      result += `\n\n[… extraction truncated at ${mb}MB; ${droppedSheetNames.length} sheet(s) not shown to the model: ${list} …]\n\n`;
    }

    console.log(
      `[Perf] xlsxToText: ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return result;
  } finally {
    await removeTempDir(tempDir);
  }
}

/**
 * Converts one document with LibreOffice headless into `format` inside
 * `outputDir` and returns the produced file's path. A per-invocation
 * profile directory keeps concurrent conversions on the same OS user from
 * colliding on the shared default profile lock.
 */
async function libreOfficeConvert(
  inputPath: string,
  format: string,
  outputDir: string,
  options?: ExtractionOptions,
): Promise<string> {
  const profileDir = path.join(outputDir, 'lo-profile');
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const expected = `${baseName}.${format}`;
  const { stdout, stderr } = await execFileAsync(
    'libreoffice',
    [
      `-env:UserInstallation=file://${profileDir}`,
      '--headless',
      '--convert-to',
      format,
      '--outdir',
      outputDir,
      inputPath,
    ],
    execOpts(options),
  );
  console.log('LibreOffice stdout:', stdout);
  if (stderr) {
    console.warn('LibreOffice stderr:', stderr);
  }
  const files = await fs.promises.readdir(outputDir);
  if (!files.includes(expected)) {
    throw new Error(
      `LibreOffice did not produce ${expected} (found: ${files.join(', ') || 'nothing'})`,
    );
  }
  return path.join(outputDir, expected);
}

async function pptToText(
  inputPath: string,
  options?: ExtractionOptions,
): Promise<string> {
  const perfStart = performance.now();
  // TODO: Possibly find a way to do this without converting to PDF first
  const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ppt-'));
  try {
    const pdfPath = await libreOfficeConvert(
      inputPath,
      'pdf',
      outputDir,
      options,
    );
    const text = await pdfToText(pdfPath, options);
    console.log(
      `[Perf] pptToText: ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return text;
  } catch (error) {
    console.error(
      `Error converting PPT/PPTX to PDF and extracting text: ${error}`,
    );
    throw error;
  } finally {
    await removeTempDir(outputDir);
  }
}

/**
 * Legacy binary Word (`.doc`, OLE container). Pandoc cannot read it, so
 * LibreOffice first rewrites it as `.docx`, which then takes the ordinary
 * pandoc path (structure and headings preserved). Reading the OLE bytes as
 * UTF-8 — the old fall-through — produced mojibake that looked like a
 * successful extraction.
 */
async function docToText(
  inputPath: string,
  options?: ExtractionOptions,
): Promise<string> {
  const perfStart = performance.now();
  const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'doc-'));
  try {
    const docxPath = await libreOfficeConvert(
      inputPath,
      'docx',
      outputDir,
      options,
    );
    const text = await convertWithPandoc(docxPath, 'markdown', options);
    console.log(
      `[Perf] docToText: ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return text;
  } catch (error) {
    console.error(`Error converting DOC via LibreOffice: ${error}`);
    throw error;
  } finally {
    await removeTempDir(outputDir);
  }
}

/**
 * Extracts text content from a document file on disk.
 * Handles PDF, DOCX, XLSX, PPTX, EPUB, and plain text files.
 *
 * @param filePath - Path to the file on disk
 * @param mimeType - MIME type of the file
 * @param originalFilename - Original filename (used for extension-based fallback detection)
 * @returns Extracted text content
 * @throws Error if text extraction fails
 */
export async function loadDocumentFromPath(
  filePath: string,
  mimeType: string,
  originalFilename: string,
  options?: ExtractionOptions,
): Promise<string> {
  const perfStart = performance.now();
  const lowerName = originalFilename.toLowerCase();

  let text: string;
  switch (true) {
    case mimeType.startsWith('application/pdf'):
      text = await pdfToText(filePath, options);
      break;
    case mimeType === 'application/msword' || lowerName.endsWith('.doc'):
      text = await docToText(filePath, options);
      break;
    case mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ) ||
      mimeType.startsWith('application/rtf') ||
      mimeType.startsWith('text/rtf') ||
      mimeType.startsWith('application/vnd.oasis.opendocument.text') ||
      lowerName.endsWith('.rtf') ||
      lowerName.endsWith('.odt'):
      // Pandoc infers the input format from the file extension, which
      // buildTempFilePath preserves. Legacy binary `.doc` is handled above
      // (LibreOffice → docx → pandoc); it must never reach the raw UTF-8
      // default, which would hand back mojibake as if it were text.
      text = await convertWithPandoc(filePath, 'markdown', options);
      break;
    case mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ) ||
      mimeType === 'application/vnd.ms-excel' ||
      lowerName.endsWith('.xlsx') ||
      lowerName.endsWith('.xls'):
      text = await xlsxToText(filePath, options);
      break;
    case mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ) || mimeType.startsWith('application/vnd.ms-powerpoint'):
      text = await pptToText(filePath, options);
      break;
    case mimeType.startsWith('application/epub+zip'):
      text = await convertWithPandoc(filePath, 'markdown', options);
      break;
    case mimeType.startsWith('text/html') ||
      mimeType.startsWith('application/xhtml+xml') ||
      lowerName.endsWith('.html') ||
      lowerName.endsWith('.htm') ||
      lowerName.endsWith('.xhtml'):
      // Markup → markdown: pandoc's HTML reader drops <script>/<style>
      // bodies and tags, so the model (and the search index) sees prose
      // rather than a wall of attributes. `-raw_html` keeps unknown tags
      // from being passed through verbatim.
      text = await convertWithPandoc(filePath, 'markdown', {
        ...options,
        args: ['-f', 'html', '-t', 'markdown-raw_html'],
      });
      break;
    case mimeType.startsWith('text/') ||
      mimeType.startsWith('application/csv') ||
      lowerName.endsWith('.py') ||
      lowerName.endsWith('.sql') ||
      mimeType.startsWith('application/json') ||
      lowerName.endsWith('.tex'):
    default:
      text = truncateToBudget(await fs.promises.readFile(filePath, 'utf8'));
  }

  perfLog(
    'loadDocumentFromPath total',
    perfStart,
    `${sanitizeForLog(originalFilename)} (${mimeType})`,
  );
  return text;
}

export async function loadDocument(
  file: File,
  options?: ExtractionOptions,
): Promise<string> {
  const mimeType = lookup(file.name) || 'application/octet-stream';
  const perfStart = performance.now();
  const tempFilePath = buildTempFilePath(file.name);

  // Write the file to a temporary location with secure permissions (0o600 = read/write for owner only)
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.promises.writeFile(tempFilePath, new Uint8Array(buffer), {
    mode: 0o600,
  });

  const text = await loadDocumentFromPath(
    tempFilePath,
    mimeType,
    file.name,
    options,
  );

  perfLog(
    'loadDocument total',
    perfStart,
    `${sanitizeForLog(file.name)} (${mimeType})`,
  );
  return text;
}

/**
 * Result of loading and validating a document.
 */
export interface LoadDocumentResult {
  text: string;
  pageCount?: number;
}

/**
 * Loads a document and validates its content length against configured limits.
 * Throws an error if the document exceeds content limits (page count for PDFs,
 * character count for text files).
 *
 * @param file - The file to load and validate
 * @returns Promise resolving to the extracted text and optional page count
 * @throws Error if content validation fails or document cannot be loaded
 */
export async function loadDocumentWithValidation(
  file: File,
): Promise<LoadDocumentResult> {
  const mimeType = lookup(file.name) || 'application/octet-stream';
  const tempFilePath = buildTempFilePath(file.name);

  // Write the file to a temporary location with secure permissions
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.promises.writeFile(tempFilePath, new Uint8Array(buffer), {
    mode: 0o600,
  });

  let text: string;
  let pageCount: number | undefined;

  // Handle PDF separately to get page count for validation
  if (mimeType.startsWith('application/pdf')) {
    // Get page count first for validation
    try {
      pageCount = await getPdfPageCount(tempFilePath);
    } catch (error) {
      console.warn(
        '[loadDocumentWithValidation] Failed to get PDF page count:',
        error,
      );
      // Continue without page count - will fall back to character validation
    }

    // Validate page count if we got it
    if (pageCount !== undefined && requiresContentValidation(file.name)) {
      const validation = validateDocumentContent(file.name, '', pageCount);
      if (!validation.valid) {
        // Clean up temp file before throwing
        retryRemoveFile(tempFilePath).catch(() => {});
        throw new Error(validation.error);
      }
    }

    // Extract text
    text = await pdfToText(tempFilePath);
  } else {
    // For non-PDF files, load the document first
    text = await loadDocument(file);
  }

  // Validate content length for text-based files
  if (requiresContentValidation(file.name)) {
    const validation = validateDocumentContent(file.name, text, pageCount);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
  }

  return { text, pageCount };
}
