import { Session } from 'next-auth';

import { getEnvVariable } from '@/lib/utils/app/env';
import { AzureBlobStorage, BlobStorage } from '@/lib/utils/server/blob';

import { env } from '@/config/environment';

/**
 * Creates an Azure Blob Storage client with consistent configuration
 * Eliminates duplication of blob storage initialization across API routes
 *
 * @param session The user session
 * @param containerOverride Optional container name override
 * @returns Configured AzureBlobStorage instance
 */
export function createBlobStorageClient(
  session: Session,
  containerOverride?: string,
): BlobStorage {
  const containerName =
    containerOverride ??
    getEnvVariable({
      name: 'AZURE_BLOB_STORAGE_CONTAINER',
      throwErrorOnFail: false,
      defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
      user: session.user,
    });

  // AzureBlobStorage uses DefaultAzureCredential (Entra ID), no key needed
  // The key parameter is optional and unused - included only for backward compatibility
  const storageKey = getEnvVariable({
    name: 'AZURE_BLOB_STORAGE_KEY',
    throwErrorOnFail: false,
    defaultValue: undefined,
    user: session.user,
  });

  return new AzureBlobStorage(
    getEnvVariable({ name: 'AZURE_BLOB_STORAGE_NAME', user: session.user }),
    storageKey,
    containerName,
    session.user,
  );
}
