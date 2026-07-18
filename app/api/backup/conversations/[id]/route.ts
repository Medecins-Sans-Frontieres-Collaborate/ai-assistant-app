import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import {
  conversationBlobPath,
  isValidConversationId,
  isValidRev,
  readBlob,
  writeImmutableBlob,
} from '@/lib/services/backup/server/backupBlobStore';
import {
  rateLimitedResponse,
  readBoundedBody,
} from '@/lib/services/backup/server/routeHelpers';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  errorResponse,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { classifyStorageError } from '@/lib/utils/server/blob/storageErrors';

import { auth } from '@/auth';

/**
 * PUT/GET/DELETE `/api/backup/conversations/[id]?rev=` — immutable per-
 * conversation ciphertext blobs. Bodies are opaque `application/octet-stream`
 * envelopes encrypted client-side; the server never inspects them. Blobs are
 * rev-named and never overwritten — only the manifest (see ../manifest) is
 * compare-and-swapped, so a 412 on PUT here means the exact same blob already
 * landed and is treated as success.
 */

/** Single-conversation ciphertext cap — corpus is bounded by ~5MB localStorage. */
const MAX_BLOB_BYTES = 10 * 1024 * 1024;

/** Generous: a full sync re-pushes many conversation blobs back-to-back. */
const limiter = RateLimiter.createScoped(240, 1);

interface BlobRequestContext {
  session: Session;
  userId: string;
  blobPath: string;
}

/**
 * Shared guard chain: auth → rate limit → id/rev validation → path build.
 * Returns a NextResponse on failure so handlers can early-return it.
 */
async function resolveContext(
  request: NextRequest,
  params: Promise<{ id: string }>,
): Promise<BlobRequestContext | NextResponse> {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userId = getUserIdFromSession(session);
  if (userId === 'anonymous') return unauthorizedResponse();

  const limit = limiter.checkLimit(userId);
  if (!limit.allowed) {
    return rateLimitedResponse(limit);
  }

  const { id } = await params;
  if (!isValidConversationId(id)) {
    return badRequestResponse('Invalid conversation id');
  }
  const rev = new URL(request.url).searchParams.get('rev');
  if (!rev || !isValidRev(rev)) {
    return badRequestResponse('Invalid or missing rev parameter');
  }

  return { session, userId, blobPath: conversationBlobPath(userId, id, rev) };
}

function storageErrorResponse(scope: string, error: unknown): NextResponse {
  const { errorClass, status, message } = classifyStorageError(error);
  console.error(
    `[BackupConversationRoute] ${scope} failed (class=${errorClass}, status=${status}):`,
    error,
  );
  return errorResponse(message, status, undefined, errorClass.toUpperCase());
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolveContext(request, params);
  if (ctx instanceof NextResponse) return ctx;

  const body = await readBoundedBody(request, MAX_BLOB_BYTES);
  if (body === null) {
    return payloadTooLargeResponse('10MB');
  }
  if (body.byteLength === 0) {
    return badRequestResponse('Empty ciphertext body');
  }

  try {
    const storage = createBlobStorageClient(ctx.session);
    await writeImmutableBlob(storage, ctx.blobPath, body);
    return successResponse({ size: body.byteLength });
  } catch (error) {
    return storageErrorResponse('PUT', error);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolveContext(request, params);
  if (ctx instanceof NextResponse) return ctx;

  try {
    const storage = createBlobStorageClient(ctx.session);
    const buffer = await readBlob(storage, ctx.blobPath);
    if (buffer === null) {
      return errorResponse(
        'Backup blob not found',
        404,
        undefined,
        'BACKUP_NOT_FOUND',
      );
    }
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return storageErrorResponse('GET', error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolveContext(request, params);
  if (ctx instanceof NextResponse) return ctx;

  try {
    const storage = createBlobStorageClient(ctx.session);
    // Orphan cleanup after a successful CAS — idempotent by design.
    const deleted = await storage.deleteIfExists(ctx.blobPath);
    return successResponse({ deleted });
  } catch (error) {
    return storageErrorResponse('DELETE', error);
  }
}
