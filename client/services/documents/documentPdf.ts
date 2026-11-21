import {
  DocumentSource,
  documentPdfUrl,
} from '@/lib/utils/shared/documents/documentSource';

/** Why a document could not be laid out, from the route's error code. */
export class DocumentPdfError extends Error {
  constructor(
    message: string,
    /** The route's code, e.g. RENDER_BUSY, DOCUMENT_PROTECTED; null when none. */
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DocumentPdfError';
  }
}

/**
 * A document as a PDF (GET /api/documents/pdf), for showing its pages.
 *
 * @param source - The document (THE DOCUMENT SOURCE).
 * @param signal - Stops the request.
 * @returns The PDF.
 * @throws DocumentPdfError with the route's code when it answers an error.
 */
export async function fetchDocumentPdf(
  source: DocumentSource,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(documentPdfUrl(source), { signal });
  if (response.ok) return response.blob();
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  throw new DocumentPdfError(
    body?.error ?? `The document could not be shown (${response.status})`,
    body?.code ?? null,
    response.status,
  );
}
