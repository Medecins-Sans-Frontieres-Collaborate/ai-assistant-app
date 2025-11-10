import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty, getBlobBase64String } from '@/lib/utils/server/blob';

import { auth } from '@/auth';

const isValidSha256Hash = (id: string | string[] | undefined): boolean => {
  if (typeof id !== 'string' || id.length < 1) {
    console.error(
      `Invalid id type '${typeof id}' for object: ${JSON.stringify(id)}`,
    );
    return false;
  }
  const idParts: string[] = id.split('.');
  if (idParts.length > 2) return false;

  const [idHash, idExtension] = idParts;
  if (idExtension && idExtension.length > 4) return false;

  const SHA256_HASH_LENGTH: number = 64;
  const VALID_HASH_REGEX: RegExp = /^[0-9a-f]{64}$/;

  return idHash.length === SHA256_HASH_LENGTH && VALID_HASH_REGEX.test(idHash);
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const requestedFileType = searchParams.get('filetype');

  if (!isValidSha256Hash(id)) {
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
      return NextResponse.json({ base64Url: base64String });
    } else if (fileType === 'file') {
      const blobStorage = createBlobStorageClient(session);
      const blob: Buffer = await (blobStorage.get(
        `${remoteFilepath}/${id}`,
        BlobProperty.BLOB,
      ) as Promise<Buffer>);
      return new NextResponse(new Uint8Array(blob));
    } else {
      throw new Error(`Invalid fileType requested: ${fileType}`);
    }
  } catch (error) {
    console.error('Error retrieving blob:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve file' },
      {
        status: 500,
        headers: { 'Cache-Control': 's-maxage=43200, stale-while-revalidate' },
      },
    );
  }
}
