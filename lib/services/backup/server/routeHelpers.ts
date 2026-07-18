import { NextResponse } from 'next/server';

import { RateLimitResult } from '@/lib/services/shared/RateLimiter';

import { errorResponse } from '@/lib/utils/server/api/apiResponse';

/**
 * Reads a request body while enforcing the byte cap BEFORE the whole body is
 * buffered: an honest Content-Length above the cap is rejected without reading
 * anything, and a chunked/streamed body is cancelled the moment the running
 * total exceeds the cap. Returns null when the cap was exceeded so callers
 * respond 413.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Buffer | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return null;
    }
  }

  const body = request.body;
  if (!body) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

/**
 * 429 with a Retry-After header so the sync client can back off and resume
 * instead of failing a whole enroll/restore run (blob loops easily exceed a
 * fixed window on large corpora).
 */
export function rateLimitedResponse(result: RateLimitResult): NextResponse {
  const response = errorResponse(
    'Too many requests',
    429,
    undefined,
    'RATE_LIMITED',
  );
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((result.retryAfter ?? 1000) / 1000),
  );
  response.headers.set('Retry-After', String(retryAfterSeconds));
  return response;
}
