/**
 * How a route answers when the render service refuses or fails a job, so
 * every route says the same thing for the same cause.
 */
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/utils/server/api/apiResponse';

import { DocumentSignatureError } from './libreOfficeInputs';
import {
  LibreOfficeMemoryError,
  LibreOfficeTimeoutError,
} from './libreOfficeProcess';
import { RenderBusyError } from './renderQueue';

/** Seconds a client is asked to wait before trying a refused job again. */
export const RENDER_RETRY_AFTER_SECONDS = 30;

/**
 * The response for a render-service error; null for any other error, which
 * the route handles as it already does.
 *
 * | Error                  | Status | Code                  |
 * | ---------------------- | ------ | --------------------- |
 * | RenderBusyError        | 503    | RENDER_BUSY (+ Retry-After) |
 * | DocumentSignatureError | 422    | DOCUMENT_PROTECTED / DOCUMENT_UNREADABLE |
 * | LibreOfficeMemoryError | 422    | RENDER_MEMORY         |
 * | LibreOfficeTimeoutError| 504    | RENDER_TIMEOUT        |
 */
export function renderErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof RenderBusyError) {
    const response = errorResponse(error, 503, undefined, error.code);
    response.headers.set('Retry-After', String(RENDER_RETRY_AFTER_SECONDS));
    return response;
  }
  if (error instanceof DocumentSignatureError) {
    return errorResponse(error, 422, undefined, error.code);
  }
  if (error instanceof LibreOfficeMemoryError) {
    return errorResponse(error, 422, undefined, error.code);
  }
  if (error instanceof LibreOfficeTimeoutError) {
    return errorResponse(error, 504, undefined, error.code);
  }
  return null;
}
