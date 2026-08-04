import { Session } from 'next-auth';

import { AzureBlobStorage, BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';

/**
 * Centralized blob storage for admin/system data: agent-access config and
 * rules, prompt agents, admin connectors, admin guides, map datasets,
 * org-agent overrides, usage-limit policy and counters.
 *
 * Three properties every admin store must share (docs/ADMIN_BLOB_STORAGE.md):
 *
 * 1. CENTRALIZED — one account + container for every user and replica. The
 *    account is resolved explicitly (never through `getEnvVariable`'s
 *    per-user EU remap), so an admin edit is one write that all regions see.
 * 2. EU-RESIDENT — this data references principals (user ids, emails,
 *    group ids) and per-user usage from BOTH regions; only EU placement
 *    satisfies "EU data never leaves the EU". Hence the default account is
 *    the EU one, overridable via AZURE_BLOB_STORAGE_ADMIN_NAME.
 * 3. LIFECYCLE-FREE — the shared `ai-portal-images` container is subject to
 *    a delete-after-5-days lifecycle rule (scoped to that container's
 *    prefix on BOTH accounts). Admin data is written only on admin edits,
 *    so it MUST live in a container no lifecycle rule matches — the
 *    dedicated `ai-portal-admin` container.
 */

const DEFAULT_ADMIN_CONTAINER = 'ai-portal-admin';

/**
 * Placeholder user for AzureBlobStorage's constructor — account + container
 * are passed explicitly, so per-user region routing never consults it.
 */
const SYSTEM_USER: Session['user'] = {
  id: 'system-admin-storage',
  displayName: 'admin-storage',
};

/** Resolved admin storage location (exported for health checks/diagnostics). */
export function resolveAdminStorageLocation(): {
  accountName: string | undefined;
  containerName: string;
} {
  return {
    accountName:
      env.AZURE_BLOB_STORAGE_ADMIN_NAME ??
      env.AZURE_BLOB_STORAGE_NAME_EU ??
      env.AZURE_BLOB_STORAGE_NAME,
    containerName:
      env.AZURE_BLOB_STORAGE_ADMIN_CONTAINER ?? DEFAULT_ADMIN_CONTAINER,
  };
}

/**
 * One ensure per account/container per process. The container's source of
 * truth is Terraform; this backstop lets a fresh environment (or a local
 * setup pointing at a new account) self-heal without an infra apply. A
 * failed ensure is logged and retried on the next factory call — the
 * subsequent blob operation surfaces the real error to the caller.
 */
const ensuredContainers = new Map<string, Promise<boolean>>();

function ensureOnce(storage: AzureBlobStorage, key: string): void {
  if (ensuredContainers.has(key)) return;
  const attempt = storage
    .ensureContainerExists()
    .then(() => true)
    .catch((err) => {
      console.warn(
        `[adminBlobStorage] Failed to ensure admin container ${sanitizeForLog(key)}:`,
        err instanceof Error ? err.message : err,
      );
      ensuredContainers.delete(key);
      return false;
    });
  ensuredContainers.set(key, attempt);
}

/**
 * Creates the blob client every admin/system store must use. Throws when no
 * storage account is configured at all (single-account dev setups fall back
 * to the primary account, still in the dedicated admin container).
 */
export function createAdminBlobStorage(): BlobStorage {
  const { accountName, containerName } = resolveAdminStorageLocation();
  if (!accountName) {
    throw new Error(
      'Admin storage requires a storage account (AZURE_BLOB_STORAGE_ADMIN_NAME, AZURE_BLOB_STORAGE_NAME_EU, or AZURE_BLOB_STORAGE_NAME)',
    );
  }
  const storage = new AzureBlobStorage(accountName, containerName, SYSTEM_USER);
  ensureOnce(storage, `${accountName}/${containerName}`);
  return storage;
}
