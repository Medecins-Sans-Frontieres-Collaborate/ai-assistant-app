import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import {
  foldersBlobPath,
  isValidRev,
  readBlob,
  writeImmutableBlob,
} from '@/lib/services/backup/server/backupBlobStore';
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
 * PUT/GET/DELETE `/api/backup/folders?rev=` — the single immutable ciphertext
 * blob holding the user's folder tree. Same immutable rev-named semantics as
 * the per-conversation blobs (see ./conversations/[id]); only the manifest is
 * compare-and-swapped.
 */

/** Folder list is tiny; same cap as conversations keeps the contract uniform. */
const MAX_BLOB_BYTES = 10 * 1024 * 1024;

const limiter = RateLimiter.createScoped(60, 1);

interface BlobRequestContext {
  session: Session;
  userId: string;
  blobPath: string;
}

async function resolveContext(
  request: NextRequest,
): Promise<BlobRequestContext | NextResponse> {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userId = getUserIdFromSession(session);
  if (userId === 'anonymous') return unauthorizedResponse();

  if (!limiter.checkLimit(userId).allowed) {
    return errorResponse('Too many requests', 429, undefined, 'RATE_LIMITED');
  }

  const rev = new URL(request.url).searchParams.get('rev');
  if (!rev || !isValidRev(rev)) {
    return badRequestResponse('Invalid or missing rev parameter');
  }

  return { session, userId, blobPath: foldersBlobPath(userId, rev) };
}

function storageErrorResponse(scope: string, error: unknown): NextResponse {
  const { errorClass, status, message } = classifyStorageError(error);
  console.error(
    `[BackupFoldersRoute] ${scope} failed (class=${errorClass}, status=${status}):`,
    error,
  );
  return errorResponse(message, status, undefined, errorClass.toUpperCase());
}

export async function PUT(request: NextRequest) {
  const ctx = await resolveContext(request);
  if (ctx instanceof NextResponse) return ctx;

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BLOB_BYTES) {
    return payloadTooLargeResponse('10MB');
  }
  if (body.byteLength === 0) {
    return badRequestResponse('Empty ciphertext body');
  }

  try {
    const storage = createBlobStorageClient(ctx.session);
    await writeImmutableBlob(storage, ctx.blobPath, Buffer.from(body));
    return successResponse({ size: body.byteLength });
  } catch (error) {
    return storageErrorResponse('PUT', error);
  }
}

export async function GET(request: NextRequest) {
  const ctx = await resolveContext(request);
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

export async function DELETE(request: NextRequest) {
  const ctx = await resolveContext(request);
  if (ctx instanceof NextResponse) return ctx;

  try {
    const storage = createBlobStorageClient(ctx.session);
    const deleted = await storage.deleteIfExists(ctx.blobPath);
    return successResponse({ deleted });
  } catch (error) {
    return storageErrorResponse('DELETE', error);
  }
}
