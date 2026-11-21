/**
 * THE DOCUMENT SOURCE: where a file the app holds lives, named the same way
 * in the browser and on the server so any screen can show any document
 * (docs/DOCUMENT_PLATFORM.md).
 *
 *  - `kind` says which store holds it. The documents layer knows `upload`
 *    (a person's uploaded file); features add their own kinds on the
 *    server (lib/services/documentSources.ts), e.g. a document
 *    translation's output.
 *  - `id` is the file's name in that store, opaque to everyone else.
 *  - `type` is its extension (lowercase, no dot), which says how it is
 *    opened and laid out.
 *
 * A source is only a name: the server reads it for the signed-in person
 * alone, so naming someone else's file finds nothing.
 */

/** Where a document lives (see THE DOCUMENT SOURCE). */
export interface DocumentSource {
  kind: string;
  id: string;
  type: string;
}

/** Types that have pages the server can lay out as a PDF. */
export const PAGED_DOCUMENT_TYPES: readonly string[] = [
  'pdf',
  'pptx',
  'pptm',
  'ppsx',
  'potx',
  'ppt',
  'pps',
  'pot',
  'odp',
  'docx',
  'doc',
  'odt',
  'rtf',
];

/** Types whose pages are slides (presentations). */
const PRESENTATION_TYPES: ReadonlySet<string> = new Set([
  'pptx',
  'pptm',
  'ppsx',
  'potx',
  'ppt',
  'pps',
  'pot',
  'odp',
]);

/** Whether a type is a presentation (its pages are slides). */
export function isPresentationType(type: string): boolean {
  return PRESENTATION_TYPES.has(type.toLowerCase());
}

/** What a page of a document of `type` is called on screen. */
export function documentUnitOf(type: string): 'page' | 'slide' {
  return isPresentationType(type) ? 'slide' : 'page';
}

/** Largest document laid out as a PDF for viewing. */
export const DOCUMENT_PDF_MAX_BYTES = 60 * 1024 * 1024;

const KIND = /^[a-z][a-z-]{0,39}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const TYPE = /^[a-z0-9]{1,8}$/;

/** Whether a type has pages the server can lay out. */
export function isPagedDocumentType(type: string): boolean {
  return PAGED_DOCUMENT_TYPES.includes(type.toLowerCase());
}

/**
 * Whether a source is well formed: a known shape of kind, id and type, with
 * nothing that could step outside a store (no slashes, no `..` at the
 * start).
 */
export function isValidDocumentSource(source: DocumentSource): boolean {
  return (
    KIND.test(source.kind) &&
    ID.test(source.id) &&
    !source.id.includes('..') &&
    TYPE.test(source.type)
  );
}

/**
 * Reads a source from query parameters `kind`, `id` and `type`.
 *
 * @returns The source, or null when one is missing or malformed.
 */
export function documentSourceFromParams(
  params: URLSearchParams,
): DocumentSource | null {
  const source = {
    kind: params.get('kind') ?? '',
    id: params.get('id') ?? '',
    type: (params.get('type') ?? '').toLowerCase(),
  };
  return isValidDocumentSource(source) ? source : null;
}

/**
 * Where a document is served as a PDF (GET /api/documents/pdf): a PDF as
 * it is, anything else laid out by the render service.
 *
 * @example documentPdfUrl({ kind: 'upload', id: 'ab12.pptx', type: 'pptx' })
 * // '/api/documents/pdf?kind=upload&id=ab12.pptx&type=pptx'
 */
export function documentPdfUrl(source: DocumentSource): string {
  const params = new URLSearchParams({
    kind: source.kind,
    id: source.id,
    type: source.type,
  });
  return `/api/documents/pdf?${params.toString()}`;
}

/** An uploaded file's address: `/api/file/<id>`. */
const UPLOADED_FILE_URL = /^\/api\/file\/([^/?#]+)$/;

/**
 * The source of an uploaded file, from its address (`/api/file/<id>`); the
 * id is a content hash with the file's extension.
 *
 * @returns The source, or null when `fileUrl` is not an upload or has no
 *   extension.
 */
export function uploadSource(fileUrl: string): DocumentSource | null {
  const id = UPLOADED_FILE_URL.exec(fileUrl)?.[1];
  const type = id?.split('.').pop()?.toLowerCase();
  if (!id || !type || type === id.toLowerCase()) return null;
  const source = { kind: 'upload', id, type };
  return isValidDocumentSource(source) ? source : null;
}
