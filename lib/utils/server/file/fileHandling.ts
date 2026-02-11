import {
  perfLog,
  sanitizeForLog,
} from '@/lib/utils/server/log/logSanitization';

import { getPdfPageCount } from './pdfUtils';

import {
  requiresContentValidation,
  validateDocumentContent,
} from '@/lib/constants/fileLimits';
import { exec } from 'child_process';
import fs from 'fs';
import { lookup } from 'mime-types';
import path from 'path';
import { performance } from 'perf_hooks';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
  const command = `pandoc "${inputPath}" -o "${outputPath}"`;
  const perfStart = performance.now();

  try {
    await execAsync(command);
    const { stdout } = await execAsync(`cat "${outputPath}"`);
    console.log(
      `[Perf] convertWithPandoc: ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return stdout;
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
  const { stdout } = await execAsync(`pdftotext "${inputPath}" -`);
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
      return text;
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
      return stdout;
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

async function xlsxToText(inputPath: string): Promise<string> {
  const perfStart = performance.now();
  const tempDir = await fs.promises.mkdtemp('/tmp/xlsx-');
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPattern = path.join(tempDir, `${baseName}_.csv`);

  try {
    // Convert XLSX to multiple CSV files (one per sheet)
    await execAsync(
      `ssconvert --export-file-per-sheet "${inputPath}" "${outputPattern}"`,
    );

    // Read all generated CSV files
    const files = await fs.promises.readdir(tempDir);
    let result = '';

    const filePattern: string | undefined = outputPattern.split('/').pop();

    for (const file of files) {
      if (filePattern && file.indexOf(filePattern) > -1) {
        const sheetName = file.replace(`${baseName}_`, '').replace('.csv', '');
        const content = await fs.promises.readFile(
          path.join(tempDir, file),
          'utf8',
        );

        result += `\n\n--- START OF SHEET: ${sheetName} ---\n\n`;
        result += content;
        result += `\n\n--- END OF SHEET: ${sheetName} ---\n\n`;
      }
    }

    console.log(
      `[Perf] xlsxToText: ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return result;
  } finally {
    // Clean up temporary directory and files
    const files = await fs.promises.readdir(tempDir);
    for (const file of files) {
      await retryRemoveFile(path.join(tempDir, file));
    }
    await fs.promises.rmdir(tempDir);
  }
}

async function pptToText(inputPath: string): Promise<string> {
  const perfStart = performance.now();
  // TODO: Possibly find a way to do this without converting to PDF first
  const outputDir = await fs.promises.mkdtemp('/tmp/ppt-');
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);

  try {
    const { stdout, stderr } = await execAsync(
      `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${inputPath}"`,
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
    // Clean up temporary files
    retryRemoveFile(pdfPath).catch((error) => {
      console.error(`Failed to remove temporary file ${pdfPath}:`, error);
    });
  }
}

export async function loadDocument(file: File): Promise<string> {
  const mimeType = lookup(file.name) || 'application/octet-stream';
  const perfStart = performance.now();
  const tempFilePath = `/tmp/${file.name}`;

  // Write the file to a temporary location with secure permissions (0o600 = read/write for owner only)
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.promises.writeFile(tempFilePath, new Uint8Array(buffer), {
    mode: 0o600,
  });

  let text: string;
  switch (true) {
    case mimeType.startsWith('application/pdf'):
      text = await pdfToText(tempFilePath);
      break;
    case mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ):
      text = await convertWithPandoc(tempFilePath, 'markdown');
      break;
    case mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ) || file.name.endsWith('.xlsx'):
      text = await xlsxToText(tempFilePath);
      break;
    case mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ) || mimeType.startsWith('application/vnd.ms-powerpoint'):
      text = await pptToText(tempFilePath);
      break;
    case mimeType.startsWith('application/epub+zip'):
      text = await convertWithPandoc(tempFilePath, 'markdown');
      break;
    case mimeType.startsWith('text/') ||
      mimeType.startsWith('application/csv') ||
      file.name.endsWith('.py') ||
      file.name.endsWith('.sql') ||
      mimeType.startsWith('application/json') ||
      mimeType.startsWith('application/xhtml+xml') ||
      file.name.endsWith('.tex'):
    default:
      try {
        text = await file.text();
        if (!text) {
          // If file.text() fails or returns empty, read from the temp file
          text = await fs.promises.readFile(tempFilePath, 'utf8');
        }
      } catch (error) {
        console.error(`Could not parse text from ${file.name}`);
        throw error;
      }
  }
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
  const tempFilePath = `/tmp/${file.name}`;

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
