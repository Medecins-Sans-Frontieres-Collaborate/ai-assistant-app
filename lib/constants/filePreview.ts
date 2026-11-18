/**
 * Which files can be previewed as page images, and how much of them.
 *
 * Shared by the server route that renders the pages and the client that
 * decides whether to offer a Preview button, so the two never disagree.
 */

/** Formats LibreOffice can lay out as pages (plus PDF, which already is). */
export const PAGE_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'docx',
  'doc',
  'odt',
  'rtf',
  'pptx',
  'ppt',
  'odp',
  'xlsx',
  'xls',
  'ods',
]);

/**
 * Most pages rendered for one preview. A preview is for checking a file
 * before downloading it, not for reading a long report; the viewer says
 * when pages were left out.
 */
export const PAGE_PREVIEW_MAX_PAGES = 30;

/** Render resolution. 96 dpi keeps a slide legible at about 100 KB a page. */
export const PAGE_PREVIEW_DPI = 96;

/** Largest file the preview will convert; conversion cost grows with size. */
export const PAGE_PREVIEW_MAX_BYTES = 30 * 1024 * 1024;

/** One file's preview, as returned by `GET /api/file/[id]/preview`. */
export interface FilePagePreview {
  /** Rendered pages in order, each a `data:image/png;base64,…` URL. */
  pages: string[];
  /** Pages in the whole file, including any not rendered. */
  totalPages: number;
}

/**
 * Lower-cased extension of a filename or file id, without the dot.
 *
 * @param name - A filename, path or `/api/file/<id>.<ext>` URL.
 * @returns The extension, or an empty string when there is none.
 */
export function fileExtension(name: string): string {
  const base = name.split(/[?#]/)[0].split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Whether a file can be previewed as page images.
 *
 * @param name - A filename, path or file URL; only its extension is read.
 */
export function isPagePreviewable(name: string): boolean {
  return PAGE_PREVIEW_EXTENSIONS.has(fileExtension(name));
}
