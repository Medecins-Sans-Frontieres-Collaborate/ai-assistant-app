import { NextRequest } from 'next/server';

import { ensureDocumentSources } from '@/lib/services/documentSources';
import { documentPdf } from '@/lib/services/documents/render/documentPages';
import { renderErrorResponse } from '@/lib/services/documents/render/renderErrorResponse';
import {
  UnknownDocumentSourceError,
  readDocumentSource,
} from '@/lib/services/documents/sources/documentSources';

import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  DOCUMENT_PDF_MAX_BYTES,
  documentSourceFromParams,
  isPagedDocumentType,
} from '@/lib/utils/shared/documents/documentSource';

import { auth } from '@/auth';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** A large document takes a while to lay out, and may wait for a slot. */
export const maxDuration = 300;

/**
 * GET /api/documents/pdf?kind=&id=&type=
 *
 * One of the signed-in person's documents (THE DOCUMENT SOURCE) as a PDF,
 * for showing its pages: a PDF as it is; a presentation with one page per
 * slide, hidden slides included (page n is slide n); a text document as
 * LibreOffice lays it out.
 *
 * Conversion goes through the render service's interactive lane: a full
 * queue answers 503 `RENDER_BUSY` with Retry-After, an unreadable or
 * protected file 422.
 *
 * Responses: 200 `application/pdf`; 400 with `details` saying why: a
 * malformed source (`INVALID_SOURCE`), a type without pages (`NOT_PAGED`),
 * an unknown kind (`UNKNOWN_SOURCE`) or a file too large
 * (`DOCUMENT_TOO_LARGE`); 401; 404 no such document for this person.
 */
export async function GET(request: NextRequest) {
  const source = documentSourceFromParams(request.nextUrl.searchParams);
  if (!source) {
    return badRequestResponse('Invalid document source', 'INVALID_SOURCE');
  }
  if (!isPagedDocumentType(source.type)) {
    return badRequestResponse('This file has no pages to show', 'NOT_PAGED');
  }

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  ensureDocumentSources();
  let file: Buffer | null;
  try {
    file = await readDocumentSource(session, source);
  } catch (error) {
    if (error instanceof UnknownDocumentSourceError) {
      return badRequestResponse('Unknown document source', 'UNKNOWN_SOURCE');
    }
    console.error('[documents pdf] Failed to read the document:', error);
    return errorResponse('Failed to retrieve the document', 500);
  }
  if (!file) return notFoundResponse('Document');
  if (file.byteLength > DOCUMENT_PDF_MAX_BYTES) {
    return badRequestResponse(
      'This document is too large to show',
      'DOCUMENT_TOO_LARGE',
    );
  }

  const headers = {
    'Content-Type': 'application/pdf',
    // A source names one stored file whose content does not change (an
    // upload's id is its hash, a job's output is written once); it is kept
    // in the person's own browser cache only.
    'Cache-Control': 'private, max-age=3600',
  };
  if (source.type === 'pdf') {
    return new Response(new Uint8Array(file), { headers });
  }

  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'document-pdf-'),
  );
  try {
    // A fixed name: nothing from the request reaches a path but the
    // validated type.
    const inputPath = path.join(workDir, `document.${source.type}`);
    await fs.promises.writeFile(inputPath, file);
    const pdfPath = await documentPdf(inputPath, source.type, {
      lane: 'interactive',
      workDir,
      signal: request.signal,
    });
    return new Response(new Uint8Array(await fs.promises.readFile(pdfPath)), {
      headers,
    });
  } catch (error) {
    console.error('[documents pdf] Conversion failed:', error);
    return (
      renderErrorResponse(error) ??
      errorResponse('This document could not be laid out', 500)
    );
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}
