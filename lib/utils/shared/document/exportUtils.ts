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
 * Strip script tags, inline event handlers, and javascript: URLs from HTML
 * before writing it to disk or rendering it into a PDF. Assistant output and
 * document-editor content can contain raw HTML; DOMPurify's defaults remove
 * the executable surface while keeping the visible markup intact.
 */
export async function sanitizeHtmlForExport(html: string): Promise<string> {
  const DOMPurify = await getDOMPurify();
  return DOMPurify.sanitize(html);
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

function pdfOptions(fileName: string) {
  return {
    margin: 10,
    filename: fileName,
    image: { type: 'jpeg' as const, quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const },
    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] as const },
  };
}

// Trailing padding keeps the last line of content off the page-slice
// boundary; without it html2pdf's rasterizer can crop the final glyph row.
function wrapForPdf(html: string): string {
  return `<div style="padding-bottom:24mm">${html}</div>`;
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
    await html2pdf().set(pdfOptions(fileName)).from(wrapForPdf(html)).save();
  } catch (error) {
    console.error('Error exporting to PDF:', error);
    throw new Error('Failed to export PDF. Please try again.');
  }
}

/**
 * Render HTML to a PDF Blob without triggering a download — for callers that
 * send the bytes somewhere (e.g. Save to OneDrive) instead of to disk.
 */
export async function renderPdfBlob(html: string): Promise<Blob> {
  const html2pdf = (await import('html2pdf.js')).default;
  return (await html2pdf()
    .set(pdfOptions('document.pdf'))
    .from(wrapForPdf(html))
    .outputPdf('blob')) as Blob;
}

/**
 * Convert HTML to a DOCX Blob via the server-side converter.
 */
export async function fetchDocxBlob(html: string): Promise<Blob> {
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
  return response.blob();
}

/**
 * Export HTML as DOCX using server-side API
 */
export async function exportToDOCX(
  html: string,
  fileName: string,
): Promise<void> {
  try {
    const blob = await fetchDocxBlob(html);

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
