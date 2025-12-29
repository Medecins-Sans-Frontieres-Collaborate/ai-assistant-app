import { getDOMPurify } from './domPurify';

import { decode } from 'he';
import TurndownService from 'turndown';

/**
 * Export utilities for document editor
 */

/**
 * Convert HTML to Markdown
 */
export function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx', // Use # for headings
    codeBlockStyle: 'fenced', // Use ``` for code blocks
    bulletListMarker: '-', // Use - for bullet lists
  });

  // Add custom rules for better conversion
  turndownService.addRule('strikethrough', {
    filter: ['s', 'del'],
    replacement: (content) => `~~${content}~~`,
  });

  return turndownService.turndown(html);
}

/**
 * Convert HTML to plain text
 */
export async function htmlToPlainText(html: string): Promise<string> {
  const DOMPurify = await getDOMPurify();

  // Sanitize HTML first to prevent any injection attacks
  const cleanHtml = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [], // Strip all tags
    KEEP_CONTENT: true, // Keep text content
  });

  if (typeof window === 'undefined') {
    // Server-side: use 'he' library for safe HTML entity decoding
    // This avoids double-unescaping issues that manual replacements can cause
    return decode(cleanHtml).trim();
  }

  // Client-side: use DOM parser for proper entity decoding
  const temp = document.createElement('div');
  temp.innerHTML = cleanHtml;
  return temp.textContent || temp.innerText || '';
}

/**
 * Export HTML as PDF (simple wrapper using html2pdf.js)
 */
export async function exportToPDF(
  html: string,
  fileName: string,
): Promise<void> {
  try {
    // Dynamically import html2pdf only when needed (client-side only)
    const html2pdf = (await import('html2pdf.js')).default;

    const options = {
      margin: 10,
      filename: fileName,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const },
    };

    await html2pdf().set(options).from(html).save();
  } catch (error) {
    console.error('Error exporting to PDF:', error);
    throw new Error('Failed to export PDF. Please try again.');
  }
}

/**
 * Export HTML as DOCX using server-side API
 */
export async function exportToDOCX(
  html: string,
  fileName: string,
): Promise<void> {
  try {
    const response = await fetch('/api/export/docx', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ html }),
    });

    if (!response.ok) {
      throw new Error('Failed to convert to DOCX');
    }

    // Get the DOCX blob from response
    const blob = await response.blob();

    // Download the DOCX file
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Error exporting to DOCX:', error);
    throw new Error('Failed to export DOCX. Please try again.');
  }
}

/**
 * Download content as a file
 */
export function downloadFile(
  content: string,
  fileName: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
