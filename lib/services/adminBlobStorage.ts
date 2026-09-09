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

/**
 * Resolved admin storage location (exported for health checks/diagnostics).
 * Reflects the EFFECTIVE location: when the dev fallback (below) is active,
 * this is the legacy account actually being served, with the denied
 * configured account reported in `devFallbackFrom`.
 */
export function resolveAdminStorageLocation(): {
  accountName: string | undefined;
  containerName: string;
  devFallbackFrom?: string;
} {
  const configured =
    env.AZURE_BLOB_STORAGE_ADMIN_NAME ??
    env.AZURE_BLOB_STORAGE_NAME_EU ??
    env.AZURE_BLOB_STORAGE_NAME;
  return {
    accountName: devLegacyFallbackAccount ?? configured,
    containerName:
      env.AZURE_BLOB_STORAGE_ADMIN_CONTAINER ?? DEFAULT_ADMIN_CONTAINER,
    ...(devLegacyFallbackAccount && configured !== devLegacyFallbackAccount
      ? { devFallbackFrom: configured }
      : {}),
  };
}

/**
 * Data-plane authorization failure (the caller's identity lacks an RBAC
 * role on the account) — distinct from transient/network errors, which
 * should NOT trigger the dev fallback below.
 */
function isAuthorizationError(err: unknown): boolean {
  if ((err as { statusCode?: number })?.statusCode === 403) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('not authorized to perform this operation');
}

/**
 * Non-production resilience: when the resolved admin account denies access
 * (typical mid-migration state — the RBAC grant hasn't been applied yet)
 * and a DIFFERENT legacy primary account is configured, subsequent factory
 * calls serve the admin container on the legacy account instead of leaving
 * every admin surface broken. Never engages in production: silently writing
 * admin data outside the EU account would violate residency and mask a
 * misconfiguration that must be fixed in infra.
 */
let devLegacyFallbackAccount: string | null = null;

function maybeActivateDevFallback(deniedAccount: string): void {
  if (process.env.NODE_ENV === 'production') return;
  if (devLegacyFallbackAccount) return;
  const legacy = env.AZURE_BLOB_STORAGE_NAME;
  if (!legacy || legacy === deniedAccount) return;
  devLegacyFallbackAccount = legacy;
  console.warn(
    `[adminBlobStorage] DEV FALLBACK ACTIVE: '${sanitizeForLog(deniedAccount)}' denied access — serving admin data from legacy account '${sanitizeForLog(legacy)}' instead. ` +
      `Requests made before this point may have failed; reload. To use '${sanitizeForLog(deniedAccount)}', grant your identity 'Storage Blob Data Contributor' on it, ` +
      `or pin AZURE_BLOB_STORAGE_ADMIN_NAME explicitly.`,
  );
}

/**
 * One ensure per account/container per process. The container's source of
 * truth is Terraform; this backstop lets a fresh environment (or a local
 * setup pointing at a new account) self-heal without an infra apply. A
 * failed ensure is logged and retried on the next factory call — the
 * subsequent blob operation surfaces the real error to the caller.
 */
const ensuredContainers = new Map<string, Promise<boolean>>();

function ensureOnce(
  storage: AzureBlobStorage,
  accountName: string,
  containerName: string,
): void {
  const key = `${accountName}/${containerName}`;
  if (ensuredContainers.has(key)) return;
  const attempt = storage
    .ensureContainerExists()
    .then(() => true)
    .catch((err) => {
      const authFailure = isAuthorizationError(err);
      console.warn(
        `[adminBlobStorage] Failed to ensure admin container ${sanitizeForLog(key)}:`,
        err instanceof Error ? err.message : err,
        authFailure
          ? `— the running identity lacks a data-plane role (needs 'Storage Blob Data Contributor' on '${sanitizeForLog(accountName)}'). ` +
              'Override the account with AZURE_BLOB_STORAGE_ADMIN_NAME if this environment should use a different one.'
          : '',
      );
      if (authFailure) maybeActivateDevFallback(accountName);
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
  ensureOnce(storage, accountName, containerName);
  return storage;
}

/** Test hook. */
export function __resetAdminStorageStateForTests(): void {
  devLegacyFallbackAccount = null;
  ensuredContainers.clear();
}
