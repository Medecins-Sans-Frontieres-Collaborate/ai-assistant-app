/**
 * The DELIVERY container: where the third-party ETL writes report files.
 * Server-only.
 *
 * The app's relationship to it is narrow on purpose — list, read, and delete
 * at expiry. It never writes a file here, and nothing it does here is driven
 * by a path taken from a request: callers resolve a file by the id derived
 * from a path this module LISTED.
 *
 * The container's source of truth is Terraform. As a backstop the app creates
 * it at startup when it is missing ({@link ensureDeliveryContainer}), so
 * features reading it work in a fresh environment. A container the app made
 * is stamped with {@link DELIVERY_CREATED_BY_KEY}, and the health view keeps
 * warning about it until the first delivery arrives: an empty container the
 * app made usually means the ETL has not been pointed at it or lacks write
 * access, and that must not read as "no reports yet".
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

/** Metadata key stamped on a delivery container the app had to create. */
export const DELIVERY_CREATED_BY_KEY = 'createdby';
/** Value of {@link DELIVERY_CREATED_BY_KEY} when the app created it. */
export const DELIVERY_CREATED_BY_APP = 'ai-portal-app';

/**
 * Who made the delivery container: the infrastructure (or anything else that
 * did not stamp it), the app's startup backstop, or nobody yet.
 */
export type DeliveryContainerOrigin = 'infrastructure' | 'app' | 'missing';

/** The container-level operations the startup backstop and health need. */
export interface DeliveryContainerAdmin {
  ensureContainerExists(metadata?: Record<string, string>): Promise<boolean>;
  getContainerMetadata(): Promise<Record<string, string> | null>;
}

/**
 * The storage client for the delivery container.
 *
 * @throws Error when no storage account is configured.
 */
function createDeliveryContainerClient(): AzureBlobStorage {
  const { accountName, containerName } = resolveDeliveryLocation();
  if (!accountName) {
    throw new Error(
      'Analytics delivery storage requires a storage account (AZURE_BLOB_STORAGE_ADMIN_NAME, AZURE_BLOB_STORAGE_NAME_EU, or AZURE_BLOB_STORAGE_NAME)',
    );
  }
  return new AzureBlobStorage(accountName, containerName, SYSTEM_USER);
}

/**
 * Creates the delivery container when it does not exist. An existing
 * container is never changed: not emptied, and its metadata is left alone.
 *
 * @param container - Defaults to the configured delivery container.
 * @returns True when this call created it (stamped as made by the app).
 * @throws The storage error when the container can neither be found nor
 *   created (no account configured, no data role, network).
 */
export function ensureDeliveryContainer(
  container: DeliveryContainerAdmin = createDeliveryContainerClient(),
): Promise<boolean> {
  return container.ensureContainerExists({
    [DELIVERY_CREATED_BY_KEY]: DELIVERY_CREATED_BY_APP,
  });
}

/**
 * Reads who made the delivery container from its metadata.
 *
 * @param container - Defaults to the configured delivery container.
 * @throws The storage error for anything but a missing container.
 */
export async function readDeliveryContainerOrigin(
  container: DeliveryContainerAdmin = createDeliveryContainerClient(),
): Promise<DeliveryContainerOrigin> {
  const metadata = await container.getContainerMetadata();
  if (metadata === null) return 'missing';
  return metadata[DELIVERY_CREATED_BY_KEY] === DELIVERY_CREATED_BY_APP
    ? 'app'
    : 'infrastructure';
}

export function createDeliveryStore(): DeliveryStore {
  return new AzureDeliveryStore(createDeliveryContainerClient());
}
