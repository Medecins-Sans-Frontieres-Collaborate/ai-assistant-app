import { NextRequest, NextResponse } from 'next/server';

import { DriveRateLimitError } from '@/lib/services/backup/server/backupDriveStore';
import { M365Error, m365ErrorResponse } from '@/lib/services/m365/graphApi';
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

/** Storage backend for the encrypted backup. Absent param = app storage. */
export type BackupBackendId = 'app' | 'onedrive';

/**
 * Resolves the `backend` query param. Returns null for unknown values so
 * callers 400 instead of silently writing to the wrong store. No feature
 * gate here beyond auth — LD is client-side in this app, and the OneDrive
 * path is inherently gated by the user's Graph session (token minting
 * rejects unconnected users and unconsented tenants).
 */
export function resolveBackupBackend(
  request: NextRequest,
): BackupBackendId | null {
  const value = new URL(request.url).searchParams.get('backend');
  if (value === null || value === 'app') return 'app';
  if (value === 'onedrive') return 'onedrive';
  return null;
}

/**
 * Maps OneDrive-backend failures to the backup error envelope: Graph 429s
 * keep their Retry-After so the client's existing rate-limit backoff
 * resumes the run; M365Errors keep their typed status/code (not_connected →
 * 401 → UNAUTHORIZED client-side). Returns null for errors the caller's
 * generic handling should classify (BackupConflictError stays with the
 * routes — its 409 mapping is backend-agnostic).
 */
export function driveErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof DriveRateLimitError) {
    const response = errorResponse(
      'Too many requests',
      429,
      undefined,
      'RATE_LIMITED',
    );
    response.headers.set(
      'Retry-After',
      String(Math.max(1, Math.ceil(error.retryAfterSeconds))),
    );
    return response;
  }
  if (error instanceof M365Error) {
    return m365ErrorResponse(error);
  }
  return null;
}
