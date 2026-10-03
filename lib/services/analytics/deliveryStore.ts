/**
 * The DELIVERY container: where the third-party ETL writes report files.
 * Server-only.
 *
 * The app's relationship to it is narrow on purpose — list, read, and delete
 * at expiry. It never writes a file here, and nothing it does here is driven
 * by a path taken from a request: callers resolve a file by the id derived
 * from a path this module LISTED.
 *
 * The container is created by Terraform (docs/ANALYTICS_ADMIN_ASSESSMENT.md
 * §4.5), not by the app: an app that could create it would mask a missing
 * role assignment as an empty folder tree.
 */
import { Session } from 'next-auth';

import { resolveAdminStorageLocation } from '@/lib/services/adminBlobStorage';
import { downloadBlob } from '@/lib/services/agentAccess/blobCas';
import { isSafeRelativePath } from '@/lib/services/analytics/paths';
import { DeliveredBlob } from '@/lib/services/analytics/types';

import { AzureBlobStorage, BlobStorage } from '@/lib/utils/server/blob/blob';

import { env } from '@/config/environment';
import { createHash } from 'crypto';

const DEFAULT_ANALYTICS_CONTAINER = 'ai-portal-analytics';

/** Account + container are explicit, so per-user region routing never runs. */
const SYSTEM_USER: Session['user'] = {
  id: 'system-analytics-storage',
  displayName: 'analytics-storage',
};

/**
 * The id a file is addressed by in URLs: a hash of its path, so no request
 * parameter is ever joined into a blob name.
 */
export function analyticsFileId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32);
}

/** Same account as the admin container (EU-resident), its own container. */
export function resolveDeliveryLocation(): {
  accountName: string | undefined;
  containerName: string;
} {
  return {
    accountName: resolveAdminStorageLocation().accountName,
    containerName:
      env.AZURE_BLOB_STORAGE_ANALYTICS_CONTAINER ?? DEFAULT_ANALYTICS_CONTAINER,
  };
}

export interface DeliveryStore {
  /** Every delivered file. Throws when the container cannot be listed. */
  list(): Promise<DeliveredBlob[]>;
  /** Null when the file no longer exists. */
  download(path: string): Promise<Buffer | null>;
  /** False when it was already gone. */
  delete(path: string): Promise<boolean>;
}

/**
 * Drops what is not a deliverable file: names the app refuses to treat as a
 * path, and the zero-length "directory" blobs a hierarchical-namespace
 * account lists for each folder.
 */
export function deliverableBlobs(
  listed: readonly { name: string; size: number; lastModified: Date }[],
): DeliveredBlob[] {
  const names = listed.map((blob) => blob.name);
  return listed
    .filter((blob) => isSafeRelativePath(blob.name) && blob.name !== '')
    .filter(
      (blob) =>
        !(
          blob.size === 0 &&
          names.some((other) => other.startsWith(`${blob.name}/`))
        ),
    )
    .map((blob) => ({
      path: blob.name,
      size: blob.size,
      lastModified: blob.lastModified.toISOString(),
    }));
}

class AzureDeliveryStore implements DeliveryStore {
  constructor(private readonly storage: BlobStorage) {}

  async list(): Promise<DeliveredBlob[]> {
    return deliverableBlobs(await this.storage.listBlobsDetailed(''));
  }

  async download(path: string): Promise<Buffer | null> {
    const result = await downloadBlob(
      this.storage,
      path,
      'analytics.downloadDelivery',
    );
    return result?.buffer ?? null;
  }

  delete(path: string): Promise<boolean> {
    return this.storage.deleteIfExists(path);
  }
}

export function createDeliveryStore(): DeliveryStore {
  const { accountName, containerName } = resolveDeliveryLocation();
  if (!accountName) {
    throw new Error(
      'Analytics delivery storage requires a storage account (AZURE_BLOB_STORAGE_ADMIN_NAME, AZURE_BLOB_STORAGE_NAME_EU, or AZURE_BLOB_STORAGE_NAME)',
    );
  }
  return new AzureDeliveryStore(
    new AzureBlobStorage(accountName, containerName, SYSTEM_USER),
  );
}
