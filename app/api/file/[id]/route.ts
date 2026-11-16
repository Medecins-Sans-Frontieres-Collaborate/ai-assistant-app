import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { getAzureMonitorLogger } from '@/lib/services/observability';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  errorResponse,
  notFoundResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  BlobProperty,
  getBlobBase64String,
} from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';
import { isValidFileId } from '@/lib/utils/server/file/fileId';

import { auth } from '@/auth';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const logger = getAzureMonitorLogger();
  const startTime = Date.now();

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const requestedFileType = searchParams.get('filetype');

  if (!isValidFileId(id)) {
    return NextResponse.json(
      { error: 'Invalid file identifier' },
      { status: 400 },
    );
  }

  let fileType: 'image' | 'file' = 'file';
  if (requestedFileType === 'image' || requestedFileType === 'file') {
    fileType = requestedFileType;
  }

  const session: Session | null = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = getUserIdFromSession(session);
  const remoteFilepath = `${userId}/uploads/${fileType}s`;

  try {
    if (fileType === 'image') {
      const base64String: string = await getBlobBase64String(
        userId,
        id as string,
        undefined,
        session.user,
      );

      // Log success
      const duration = Date.now() - startTime;
      void logger.logFileRetrievalSuccess({
        user: session.user,
        fileId: id,
        fileType,
        duration,
      });

      return NextResponse.json({ base64Url: base64String });
    } else if (fileType === 'file') {
      const blobStorage = createBlobStorageClient(session);
      const blob: Buffer = await (blobStorage.get(
        `${remoteFilepath}/${id}`,
        BlobProperty.BLOB,
      ) as Promise<Buffer>);

      // Log success
      const duration = Date.now() - startTime;
      void logger.logFileRetrievalSuccess({
        user: session.user,
        fileId: id,
        fileType,
        duration,
      });

      return new NextResponse(new Uint8Array(blob));
    } else {
      throw new Error(`Invalid fileType requested: ${fileType}`);
    }
  } catch (error) {
    // A missing blob is the caller's 404 (expired upload, wrong region, a
    // link to a file that never persisted) — not a server fault.
    const missing = isBlobNotFoundError(error);
    if (!missing) console.error('Error retrieving blob:', error);

    void logger.logFileRetrievalError({
      user: session.user,
      fileId: id,
      fileType,
      errorCode: missing ? 'FILE_NOT_FOUND' : 'FILE_RETRIEVAL_ERROR',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });

    const response = missing
      ? notFoundResponse('File')
      : errorResponse('Failed to retrieve file', 500);
    // Never let a cache keep an error: this response used to carry
    // `s-maxage=43200`, so one transient storage failure (or a request
    // made a moment before the file persisted) left the download link
    // broken for 12 hours after storage had recovered.
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
