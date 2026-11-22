/**
 * Startup backstop for analytics storage. Server-only.
 *
 * Analytics reads two containers on the admin storage account: the admin
 * container (folder settings, policy, file state) and the delivery container
 * the external ETL writes reports to. Both are Terraform's to create; this
 * makes sure they exist when the server starts, so a fresh environment does
 * not fail every analytics request until the next infra apply.
 *
 * Creation is `createIfNotExists`: an existing container, its blobs and its
 * metadata are never touched.
 */
import {
  ensureAdminContainer,
  isAuthorizationError,
  resolveAdminStorageLocation,
} from '@/lib/services/adminBlobStorage';
import {
  ensureDeliveryContainer,
  resolveDeliveryLocation,
} from '@/lib/services/analytics/deliveryStore';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

/** What happened to each container, for logging and tests. */
export interface AnalyticsStorageStartup {
  /** 'skipped' when no storage account is configured. */
  admin: 'ready' | 'failed' | 'skipped';
  delivery: 'created' | 'existed' | 'failed' | 'skipped';
}

/** The operations the startup step needs; replaced in tests. */
export interface AnalyticsStorageStartupDeps {
  accountConfigured: () => boolean;
  ensureAdmin: () => Promise<boolean>;
  ensureDelivery: () => Promise<boolean>;
  deliveryContainerName: () => string;
}

const defaultDeps: AnalyticsStorageStartupDeps = {
  accountConfigured: () => Boolean(resolveAdminStorageLocation().accountName),
  ensureAdmin: ensureAdminContainer,
  ensureDelivery: () => ensureDeliveryContainer(),
  deliveryContainerName: () => resolveDeliveryLocation().containerName,
};

/**
 * Creates the admin and delivery containers when they are missing. Never
 * throws: every failure is logged with what to fix, and the analytics pages
 * report the same problem to admins.
 *
 * @param deps - Storage operations; the real ones by default.
 * @returns The outcome per container.
 */
export async function ensureAnalyticsStorage(
  deps: AnalyticsStorageStartupDeps = defaultDeps,
): Promise<AnalyticsStorageStartup> {
  if (!deps.accountConfigured()) {
    return { admin: 'skipped', delivery: 'skipped' };
  }

  // The admin ensure logs its own failures (adminBlobStorage.ensureOnce).
  const [admin, delivery] = await Promise.all([
    deps.ensureAdmin().then(
      (ready): AnalyticsStorageStartup['admin'] => (ready ? 'ready' : 'failed'),
      (): AnalyticsStorageStartup['admin'] => 'failed',
    ),
    ensureDeliveryLogged(deps),
  ]);
  return { admin, delivery };
}

async function ensureDeliveryLogged(
  deps: AnalyticsStorageStartupDeps,
): Promise<AnalyticsStorageStartup['delivery']> {
  const container = sanitizeForLog(deps.deliveryContainerName());
  try {
    const created = await deps.ensureDelivery();
    if (created) {
      console.warn(
        `[analytics] Created the missing delivery container '${container}'. ` +
          'It is normally made by Terraform; check that the reporting ETL writes to it and has a data role on it. ' +
          'Admins see a warning under Analytics > Deliveries until the first report arrives.',
      );
    }
    return created ? 'created' : 'existed';
  } catch (error) {
    console.warn(
      `[analytics] Could not ensure the delivery container '${container}':`,
      error instanceof Error ? sanitizeForLog(error.message) : error,
      isAuthorizationError(error)
        ? "The app's identity needs 'Storage Blob Data Contributor' on the admin storage account."
        : '',
    );
    return 'failed';
  }
}
