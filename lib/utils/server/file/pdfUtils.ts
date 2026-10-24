/**
 * PDF utilities for server-side processing.
 * Provides page counting without full text extraction for early validation.
 */
import fs from 'fs';

/**
 * Gets the page count of a PDF file without extracting text.
 * Uses pdfjs-dist for fast page counting.
 *
 * @param filePath - Path to the PDF file
 * @returns Promise resolving to the number of pages
 * @throws Error if the PDF cannot be read or is invalid
 */
export async function getPdfPageCount(filePath: string): Promise<number> {
  // Use legacy build for better Node.js compatibility
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Read file as ArrayBuffer
  const data = await fs.promises.readFile(filePath);
  // Create a new Uint8Array to ensure we get a proper ArrayBuffer (not SharedArrayBuffer)
  const uint8Array = new Uint8Array(data);

  // Load PDF and get page count
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  try {
    const pdf = await loadingTask.promise;
    return pdf.numPages;
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Gets the page count of a PDF from a Buffer.
 * Useful when the file is already in memory.
 *
 * @param buffer - PDF file as a Buffer
 * @returns Promise resolving to the number of pages
 * @throws Error if the PDF cannot be read or is invalid
 */
export async function getPdfPageCountFromBuffer(
  buffer: Buffer,
): Promise<number> {
  // Use legacy build for better Node.js compatibility
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Create a new Uint8Array to ensure we get a proper ArrayBuffer (not SharedArrayBuffer)
  const uint8Array = new Uint8Array(buffer);

  // Load PDF and get page count
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  try {
    const pdf = await loadingTask.promise;
    return pdf.numPages;
  } finally {
    await loadingTask.destroy();
  }
}
