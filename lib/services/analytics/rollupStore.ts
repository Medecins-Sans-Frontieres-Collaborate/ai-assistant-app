/**
 * Stored rollups, beside the stored previews in the ADMIN container.
 * Server-only. Small (a few kilobytes), so plain JSON; a trend reads one per
 * period, through the shared payload cache.
 */
import {
  OVERWRITE_BLOB,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import { getPayloadCache } from '@/lib/services/agentAccess/payloadCache';
import { FileRollup, ROLLUP_VERSION } from '@/lib/services/analytics/rollup';
import { analyticsRollupPath } from '@/lib/services/analytics/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

const CACHE_PREFIX = 'analytics-rollup:';

/** Last writer wins: a rollup is derived data, rebuilt whole by one run. */
export async function writeRollup(
  storage: BlobStorage,
  fileId: string,
  rollup: FileRollup,
): Promise<void> {
  await uploadJson(
    storage,
    analyticsRollupPath(fileId),
    rollup,
    OVERWRITE_BLOB,
    'analytics.writeRollup',
  );
  getPayloadCache().deleteByPrefix(`${CACHE_PREFIX}${fileId}:`);
}

/**
 * The rollup for exactly this version of the file, or null — never one
 * computed from an older delivery at the same path, or by an older builder.
 */
export async function readRollup(
  storage: BlobStorage,
  fileId: string,
  blobVersion: string,
): Promise<FileRollup | null> {
  const entry = await getPayloadCache().getOrLoadImmutable<FileRollup>(
    `${CACHE_PREFIX}${fileId}:${blobVersion}`,
    async () => {
      const result = await downloadBlob(
        storage,
        analyticsRollupPath(fileId),
        'analytics.readRollup',
      );
      if (result === null) return null;
      const rollup = JSON.parse(
        result.buffer.toString('utf8'),
      ) as Partial<FileRollup>;
      if (
        rollup.version !== ROLLUP_VERSION ||
        rollup.blobVersion !== blobVersion ||
        typeof rollup.datasets !== 'object' ||
        rollup.datasets === null
      ) {
        return null;
      }
      return { value: rollup as FileRollup, bytes: result.buffer.length };
    },
  );
  return entry?.value ?? null;
}

export async function deleteRollup(
  storage: BlobStorage,
  fileId: string,
): Promise<void> {
  await storage.deleteIfExists(analyticsRollupPath(fileId));
  getPayloadCache().deleteByPrefix(`${CACHE_PREFIX}${fileId}:`);
}
