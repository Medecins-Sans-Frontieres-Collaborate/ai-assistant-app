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
 * memory with unbounded stdout.
 */
const CONVERTER_EXEC_OPTS = {
  timeout: 60_000,
  killSignal: 'SIGKILL' as const,
  maxBuffer: 100 * 1024 * 1024,
};

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
    } catch (error: any) {
      if (error.code === 'ENOENT') {
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
): Promise<string> {
  const outputPath = `${inputPath}.${outputFormat}`;
  const perfStart = performance.now();

  try {
    await execFileAsync(
      'pandoc',
      [inputPath, '-o', outputPath],
      CONVERTER_EXEC_OPTS,
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
 * Extract text from PDF using pdftotext CLI tool (poppler-utils).
 * Used as fallback when pdfjs-dist fails.
 *
 * @param inputPath - Path to the PDF file
 * @returns Extracted text content
 */
async function extractTextWithPdfToTextCli(inputPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'pdftotext',
    [inputPath, '-'],
    CONVERTER_EXEC_OPTS,
  );
  return stdout;
}

/**
 * Extract text from PDF using pdfjs-dist (primary) with pdftotext CLI fallback.
 * pdfjs-dist is more forgiving of malformed PDFs than the CLI tool.
 *
 * @param inputPath - Path to the PDF file
 * @returns Extracted text content
 * @throws Error if both extraction methods fail
 */
async function pdfToText(inputPath: string): Promise<string> {
  const perfStart = performance.now();
  // Try pdfjs-dist first (more robust for malformed PDFs)
  try {
    const perfPdfjsStart = performance.now();
    const text = await extractTextWithPdfJs(inputPath);
    console.log(
      `[Perf] extractTextWithPdfJs: ${(performance.now() - perfPdfjsStart).toFixed(1)}ms`,
    );
    if (text.trim()) {
      console.log('[pdfToText] Successfully extracted with pdfjs-dist');
      console.log(
        `[Perf] pdfToText (pdfjs-dist): ${(performance.now() - perfStart).toFixed(1)}ms`,
      );
      return truncateToBudget(text);
    }
    console.warn(
      '[pdfToText] pdfjs-dist returned empty text, trying CLI fallback',
    );
  } catch (pdfjsError) {
    console.warn(
      '[pdfToText] pdfjs-dist failed, trying pdftotext CLI:',
      pdfjsError instanceof Error ? pdfjsError.message : pdfjsError,
    );
  }

  // Fallback to pdftotext CLI
  try {
    const perfCliStart = performance.now();
    const stdout = await extractTextWithPdfToTextCli(inputPath);
    console.log(
      `[Perf] extractTextWithPdfToTextCli: ${(performance.now() - perfCliStart).toFixed(1)}ms`,
    );
    if (stdout.trim()) {
      console.log('[pdfToText] Successfully extracted with pdftotext CLI');
      console.log(
        `[Perf] pdfToText (CLI fallback): ${(performance.now() - perfStart).toFixed(1)}ms`,
      );
      return truncateToBudget(stdout);
    }
    console.warn('[pdfToText] pdftotext CLI returned empty text');
  } catch (cliError) {
    console.warn(
      '[pdfToText] pdftotext CLI also failed:',
      cliError instanceof Error ? cliError.message : cliError,
    );
  }

  throw new Error(
    'Failed to extract text from PDF using both pdfjs-dist and pdftotext CLI',
  );
}

/**
 * Reads real sheet names from an XLSX via `ssconvert --list-sheets`.
 * Output is one sheet name per line, preceded by a header line we filter.
 * Sheet order in the output matches workbook order, which is what
 * `--export-file-per-sheet` uses to index its numbered outputs.
 */
async function listXlsxSheets(inputPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'ssconvert',
      ['--list-sheets', inputPath],
      CONVERTER_EXEC_OPTS,
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

async function xlsxToText(inputPath: string): Promise<string> {
  const perfStart = performance.now();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xlsx-'));
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPattern = path.join(tempDir, `${baseName}_.csv`);

  try {
    // Read real sheet names first so we can label the numbered ssconvert
    // outputs with actual workbook sheet names instead of ".0", ".1", ...
    const sheetNames = await listXlsxSheets(inputPath);

    // Convert XLSX to one CSV per sheet. Output files are named
    // `<outputPattern>.0`, `.1`, ... in workbook order.
    await execFileAsync(
      'ssconvert',
      ['--export-file-per-sheet', inputPath, outputPattern],
      CONVERTER_EXEC_OPTS,
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
    let truncatedSheets = 0;
    let hitLimit = false;

    for (let i = 0; i < indexed.length; i++) {
      const { index, file } = indexed[i];
      if (hitLimit) {
        truncatedSheets++;
        continue;
      }
      const sheetName = sheetNames[index] ?? `Sheet ${index + 1}`;
      const content = await fs.promises.readFile(
        path.join(tempDir, file),
        'utf8',
      );

      const block = `\n\n--- START OF SHEET: ${sheetName} ---\n\n${content}\n\n--- END OF SHEET: ${sheetName} ---\n\n`;
      const blockBytes = Buffer.byteLength(block, 'utf8');
      if (totalBytes + blockBytes > MAX_EXTRACTED_TEXT_BYTES) {
        hitLimit = true;
        truncatedSheets = indexed.length - i;
        break;
      }
      result += block;
      totalBytes += blockBytes;
    }

    if (hitLimit && truncatedSheets > 0) {
      const mb = Math.round(MAX_EXTRACTED_TEXT_BYTES / (1024 * 1024));
      result += `\n\n[… truncated at ${mb}MB; ${truncatedSheets} remaining sheet(s) not shown …]\n\n`;
    }

    console.log(
      `[Perf] xlsxToText: ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return result;
  } finally {
    await removeTempDir(tempDir);
  }
}

async function pptToText(inputPath: string): Promise<string> {
  const perfStart = performance.now();
  // TODO: Possibly find a way to do this without converting to PDF first
  const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ppt-'));
  // Per-invocation LibreOffice profile so concurrent calls on the same OS
  // user don't collide on the shared default profile lock.
  const profileDir = path.join(outputDir, 'lo-profile');
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);

  try {
    const { stdout, stderr } = await execFileAsync(
      'libreoffice',
      [
        `-env:UserInstallation=file://${profileDir}`,
        '--headless',
        '--convert-to',
        'pdf',
        '--outdir',
        outputDir,
        inputPath,
      ],
      CONVERTER_EXEC_OPTS,
    );
    console.log('LibreOffice stdout:', stdout);
    if (stderr) {
      console.warn('LibreOffice stderr:', stderr);
    }

    // Check if the PDF file exists
    const files = await fs.promises.readdir(outputDir);
    console.log('Files in output directory:', files);

    if (!files.includes(`${baseName}.pdf`)) {
      throw new Error(`PDF file not found in ${outputDir}`);
    }

    // Extract text from the PDF
    const text = await pdfToText(pdfPath);
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
): Promise<string> {
  const perfStart = performance.now();

  let text: string;
  switch (true) {
    case mimeType.startsWith('application/pdf'):
      text = await pdfToText(filePath);
      break;
    case mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ):
      text = await convertWithPandoc(filePath, 'markdown');
      break;
    case mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ) || originalFilename.endsWith('.xlsx'):
      text = await xlsxToText(filePath);
      break;
    case mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ) || mimeType.startsWith('application/vnd.ms-powerpoint'):
      text = await pptToText(filePath);
      break;
    case mimeType.startsWith('application/epub+zip'):
      text = await convertWithPandoc(filePath, 'markdown');
      break;
    case mimeType.startsWith('text/') ||
      mimeType.startsWith('application/csv') ||
      originalFilename.endsWith('.py') ||
      originalFilename.endsWith('.sql') ||
      mimeType.startsWith('application/json') ||
      mimeType.startsWith('application/xhtml+xml') ||
      originalFilename.endsWith('.tex'):
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

export async function loadDocument(file: File): Promise<string> {
  const mimeType = lookup(file.name) || 'application/octet-stream';
  const perfStart = performance.now();
  const tempFilePath = buildTempFilePath(file.name);

  // Write the file to a temporary location with secure permissions (0o600 = read/write for owner only)
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.promises.writeFile(tempFilePath, new Uint8Array(buffer), {
    mode: 0o600,
  });

  const text = await loadDocumentFromPath(tempFilePath, mimeType, file.name);

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
