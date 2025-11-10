import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { MAX_API_FILE_SIZE } from '@/lib/utils/app/const';
import Hasher from '@/lib/utils/app/hash';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  errorResponse,
  payloadTooLargeResponse,
  successResponse,
} from '@/lib/utils/server/apiResponse';
import { BlobStorage } from '@/lib/utils/server/blob';
import {
  getContentType,
  validateFileNotExecutable,
} from '@/lib/utils/server/mimeTypes';

import { auth } from '@/auth';

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const filename: string = searchParams.get('filename') as string;
  const filetype: string = searchParams.get('filetype') ?? 'file';
  const mimeType: string | null = searchParams.get('mime');

  if (!filename) {
    return badRequestResponse('Filename is required');
  }

  // Validate file is not executable
  if (filetype) {
    const validation = validateFileNotExecutable(filename, mimeType);
    if (!validation.isValid) {
      return badRequestResponse(validation.error!);
    }
  }

  const uploadFileToBlobStorage = async (data: string) => {
    const session: Session | null = await auth();
    if (!session) throw new Error('Failed to pull session!');

    const userId = getUserIdFromSession(session);

    const blobStorageClient: BlobStorage = createBlobStorageClient(session);

    const hashedFileContents = Hasher.sha256(data).slice(0, 200);
    const extension: string | undefined = filename.split('.').pop();

    let contentType;
    if (mimeType) {
      contentType = mimeType;
    } else if (extension) {
      contentType = getContentType(extension);
    } else {
      contentType = 'application/octet-stream';
    }

    const uploadLocation = filetype === 'image' ? 'images' : 'files';

    const isImage =
      (mimeType && mimeType.startsWith('image/')) || filetype === 'image';

    let decodedData;
    try {
      decodedData = isImage ? data : Buffer.from(data, 'base64');
    } catch (decodeError) {
      console.error('Error decoding file data:', decodeError);
      throw new Error('Invalid file data format - expected base64 encoding');
    }

    return await blobStorageClient.upload(
      `${userId}/uploads/${uploadLocation}/${hashedFileContents}.${extension}`,
      decodedData,
      {
        blobHTTPHeaders: {
          blobContentType: contentType,
        },
      },
    );
  };

  try {
    const fileData = await request.text();

    // Check file size
    const fileSize = Buffer.byteLength(fileData);
    if (fileSize > MAX_API_FILE_SIZE) {
      return payloadTooLargeResponse(`${MAX_API_FILE_SIZE / (1024 * 1024)}MB`);
    }

    const fileURI: string = await uploadFileToBlobStorage(fileData);
    return successResponse({ uri: fileURI }, 'File uploaded successfully');
  } catch (error) {
    console.error('Error uploading file:', error);
    return errorResponse(
      'Failed to upload file',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
